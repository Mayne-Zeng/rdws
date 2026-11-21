import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, join, sep } from 'node:path';
import { constants as zstdConstants, zstdDecompressSync } from 'node:zlib';
import { isRecord } from '@rdws/dsh/access';

const maxPhysicalBytes = 8 * 1024 * 1024;
const maxDecodedBytes = 32 * 1024 * 1024;
const maxLines = 8192;
const sessionIdPattern = /^session-[a-zA-Z0-9-]+$/;

type Event = {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
};
type Snapshot = { sessionId: string; inheritedLength: number; events: Event[] };
type Dispatch = {
  native_session_id: string;
  project_id: string;
  requirement_id: string;
  request_id: string;
  actor_id: string;
  peer_nonce: string;
  host_generation: string;
  selection_revision: string;
  provider: string;
  model: string;
  accepted_seq: number | null;
  accepted_message_id: string | null;
};
type FirstWrite = Pick<
  Dispatch,
  | 'native_session_id'
  | 'project_id'
  | 'requirement_id'
  | 'host_generation'
  | 'selection_revision'
  | 'provider'
  | 'model'
> & {
  state: 'prepared' | 'submitted';
  selection_request_id: string;
  turn: number;
  step: number;
  step_seq: number;
  note_seq: number;
};
type Action = 'queued' | 'claimed' | 'cancelled' | 'replaced' | 'removed';
const invalid = () => new Error('Invalid physical fork evidence');
const position = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export async function readFixedForkJournal(root: string, sessionId: string) {
  if (!sessionIdPattern.test(sessionId)) throw invalid();
  const base = join(await realpath(root), 'runtime/dsh/project-poc/sessions');
  const files = (await readdir(base, { recursive: true })).filter(
    (name) =>
      name.split(sep).at(-2) === sessionId &&
      /^session\.v4\.jsonl(?:\.zstd)?$/.test(basename(name)),
  );
  if (files.length !== 1) throw invalid();
  const path = join(base, files[0]!);
  if ((await realpath(path)) !== path) throw invalid();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > maxPhysicalBytes
    )
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length)
      throw invalid();
    const current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      (await realpath(path)) !== path
    )
      throw invalid();
    return { bytes, compressed: path.endsWith('.zstd') };
  } finally {
    await file.close();
  }
}

export function decodeFixedForkJournal(
  bytes: Buffer,
  compressed: boolean,
  expected: {
    sessionId: string;
    cwd: string;
    source?: { sessionId: string; parent: Snapshot; throughSeq: number };
  },
): Snapshot {
  if (!bytes.length || bytes.length > maxPhysicalBytes) throw invalid();
  let header: unknown;
  let events: Event[];
  try {
    let textBytes = bytes;
    if (compressed) {
      const frames: Buffer[] = [];
      let offset = 0;
      let decoded = 0;
      while (offset < bytes.length) {
        if (
          frames.length >= maxLines ||
          decoded >= maxDecodedBytes ||
          bytes.readUInt32LE(offset) !== 0xfd2fb528
        )
          throw invalid();
        const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), {
          info: true,
          maxOutputLength: maxDecodedBytes - decoded,
          params: { [zstdConstants.ZSTD_d_windowLogMax]: 25 },
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (
          engine.bytesWritten <= 0 ||
          offset + engine.bytesWritten > bytes.length ||
          !buffer.length ||
          buffer.at(-1) !== 10 ||
          (offset === 0 && buffer.indexOf(10) !== buffer.length - 1)
        )
          throw invalid();
        offset += engine.bytesWritten;
        decoded += buffer.length;
        frames.push(buffer);
      }
      textBytes = Buffer.concat(frames, decoded);
    }
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(textBytes);
    if (!text.endsWith('\n')) throw invalid();
    const rows = text.slice(0, -1).split('\n');
    if (rows.length > maxLines) throw invalid();
    header = JSON.parse(rows.shift()!);
    events = rows.map((line, seq) => {
      const event: unknown = JSON.parse(line);
      if (
        !isRecord(event) ||
        event.seq !== seq ||
        !position(event.time) ||
        typeof event.type !== 'string' ||
        !isRecord(event.data)
      )
        throw invalid();
      return event as Event;
    });
  } catch {
    throw invalid();
  }
  if (
    !isRecord(header) ||
    header.type !== 'session' ||
    header.version !== 4 ||
    !sessionIdPattern.test(expected.sessionId) ||
    header.id !== expected.sessionId ||
    header.cwd !== expected.cwd ||
    !position(header.createdAt) ||
    header.delegationDepth !== 0 ||
    typeof header.isSeeded !== 'boolean'
  )
    throw invalid();
  const markers = events.filter(
    ({ type, data }) => type === 'session/end-seed' && data.inherited === true,
  );
  const source = expected.source;
  if (source) {
    if (
      !header.isSeeded ||
      source.sessionId === expected.sessionId ||
      source.parent.sessionId !== source.sessionId ||
      !position(source.throughSeq) ||
      source.throughSeq >= source.parent.events.length ||
      markers.at(-1)?.seq !== source.throughSeq + 1 ||
      !isDeepStrictEqual(
        events.slice(0, source.throughSeq + 1),
        source.parent.events.slice(0, source.throughSeq + 1),
      )
    )
      throw invalid();
  } else if (markers.length !== Number(header.isSeeded)) throw invalid();
  return {
    sessionId: expected.sessionId,
    inheritedLength: markers.at(-1)?.seq ?? 0,
    events,
  };
}

function prefix(snapshot: Snapshot, throughSeq: number) {
  if (!position(throughSeq) || throughSeq >= snapshot.events.length)
    throw invalid();
  return snapshot.events.slice(0, throughSeq + 1);
}

export function fixedForkEvidence(
  snapshot: Snapshot,
  throughSeq: number,
  dispatch: Dispatch,
) {
  const queues = { 'next-step': [] as string[], 'next-turn': [] as string[] };
  const first = new Set<string>();
  const inserted = new Set<string>();
  const repeated = new Set<string>();
  const matching = new Set<string>();
  const actions = new Map<string, { action: Action; seq: number }>();
  const models: { seq: number; provider: string; model: string }[] = [];
  let offer: { messageId: string; seq: number } | undefined;
  let turn: number | undefined;
  let step: number | undefined;
  let firstStep = false;
  let claimedNextTurn = false;
  const sameSession = snapshot.sessionId === dispatch.native_session_id;
  function message(value: unknown, seq: number, fromInbox: boolean) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id)
      throw invalid();
    const id = value.id;
    const { source } = value;
    if (
      sameSession &&
      isRecord(source) &&
      source.kind === 'user' &&
      source.rpcId === dispatch.request_id &&
      isRecord(source.principal) &&
      source.principal.kind === 'rdws' &&
      source.principal.userId === dispatch.actor_id &&
      source.principal.nonce === dispatch.peer_nonce
    ) {
      matching.add(id);
      if (fromInbox && !first.has(id) && seq >= snapshot.inheritedLength)
        offer = { messageId: id, seq };
    }
    first.add(id);
    if (fromInbox) {
      if (inserted.has(id)) repeated.add(id);
      inserted.add(id);
    }
    return id;
  }

  for (const { seq, type, data } of prefix(snapshot, throughSeq)) {
    if (type === 'turn/start') {
      if (turn !== undefined || !position(data.turn) || !data.turn)
        throw invalid();
      turn = data.turn;
      firstStep = false;
      claimedNextTurn = false;
    } else if (type === 'turn/end') {
      if (turn === undefined || data.turn !== turn || step !== undefined)
        throw invalid();
      turn = undefined;
    } else if (type === 'step/start') {
      if (
        turn === undefined ||
        data.turn !== turn ||
        step !== undefined ||
        !position(data.step) ||
        !data.step
      )
        throw invalid();
      step = data.step;
      firstStep = true;
    } else if (type === 'step/end') {
      if (
        turn === undefined ||
        data.turn !== turn ||
        step === undefined ||
        data.step !== step
      )
        throw invalid();
      step = undefined;
    } else if (type === 'user/message') message(data, seq, false);
    else if (type === 'model/selection' && seq >= snapshot.inheritedLength) {
      if (typeof data.provider !== 'string' || typeof data.model !== 'string')
        throw invalid();
      models.push({ seq, provider: data.provider, model: data.model });
    } else if (type === 'agent/inbox/spliced') {
      const { target, start, inserted: incoming, outcome } = data;
      const count = data.removedCount ?? 0;
      if (
        (target !== 'next-step' && target !== 'next-turn') ||
        !position(start) ||
        !position(count) ||
        !Array.isArray(incoming)
      )
        throw invalid();
      const queue = queues[target];
      if (start + count > queue.length) throw invalid();
      const claim =
        turn !== undefined &&
        step === undefined &&
        outcome === undefined &&
        !incoming.length &&
        start === 0 &&
        (target === 'next-step'
          ? count > 0 && count === queue.length
          : count === 1 &&
            !firstStep &&
            !claimedNextTurn &&
            queues['next-step'].length === 0);
      if (claim && target === 'next-turn') claimedNextTurn = true;
      const additions = incoming.map((value) => message(value, seq, true));
      const removed = queue.splice(start, count, ...additions);
      if (seq < snapshot.inheritedLength) continue;
      for (const id of removed) {
        const action =
          outcome === 'canceled'
            ? 'cancelled'
            : claim
              ? 'claimed'
              : additions.length
                ? 'replaced'
                : 'removed';
        actions.set(id, { action, seq });
      }
      for (const id of additions) actions.set(id, { action: 'queued', seq });
    }
  }

  const requestId = dispatch.request_id;
  let evidence: {
    action: Action | 'unknown' | 'ambiguous';
    insertedAt?: number;
    actionAt?: number;
  };
  if (matching.size > 1 || (offer && repeated.has(offer.messageId))) {
    evidence = { action: 'ambiguous' };
  } else if (
    !offer ||
    ((dispatch.accepted_seq !== null ||
      dispatch.accepted_message_id !== null) &&
      (offer.seq !== dispatch.accepted_seq ||
        offer.messageId !== dispatch.accepted_message_id))
  ) {
    evidence = { action: 'unknown' };
  } else {
    const action = actions.get(offer.messageId)!;
    evidence = {
      action: action.action,
      insertedAt: offer.seq,
      actionAt: action.seq,
    };
  }
  return {
    requestId,
    inheritedLength: snapshot.inheritedLength,
    ...evidence,
    models,
  };
}

export function fixedForkFirstWrites(
  snapshot: Snapshot,
  throughSeq: number,
  dispatch: Dispatch,
  rows: FirstWrite[],
) {
  const events = prefix(snapshot, throughSeq);
  if (snapshot.sessionId !== dispatch.native_session_id) return [];
  return rows.flatMap((row) => {
    if (
      row.native_session_id !== dispatch.native_session_id ||
      row.project_id !== dispatch.project_id ||
      row.requirement_id !== dispatch.requirement_id ||
      row.host_generation !== dispatch.host_generation ||
      row.selection_revision !== dispatch.selection_revision ||
      row.selection_request_id !== dispatch.request_id ||
      row.provider !== dispatch.provider ||
      row.model !== dispatch.model ||
      !position(row.step_seq) ||
      !position(row.note_seq) ||
      row.step_seq < snapshot.inheritedLength ||
      row.note_seq <= row.step_seq
    )
      return [];
    const step = events[row.step_seq];
    const note = events[row.note_seq];
    if (
      step?.type !== 'step/start' ||
      note?.type !== 'user/message' ||
      note.surfaceOp !== 'append' ||
      step.data.turn !== row.turn ||
      step.data.step !== row.step ||
      !isRecord(note.data.source) ||
      note.data.source.kind !== 'rdws-context' ||
      note.data.source.requirementId !== dispatch.requirement_id ||
      note.data.source.turn !== step.data.turn ||
      note.data.source.step !== step.data.step
    )
      return [];
    return [{ state: row.state, stepSeq: step.seq, noteSeq: note.seq }];
  });
}
