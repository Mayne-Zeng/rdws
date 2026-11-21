import { isRecord, type Grant } from '@rdws/dsh/access';
import { sessionPage, type NativeEvent } from '@rdws/dsh/sessions';
import type { NativeWebHost } from '@rdws/dsh/web';

type Input = {
  requestId: string;
  messageId: string;
  nonce: string;
  insertedAt: number;
};
export type UsedForkModel = Input & {
  turn: number;
  step: number;
  stepSeq: number;
  noteSeq: number;
  provider: string;
  model: string;
};

function original(data: Record<string, unknown>, owner: string) {
  const src = data.source;
  if (
    data.role !== 'user' ||
    typeof data.id !== 'string' ||
    !isRecord(src) ||
    src.kind !== 'user' ||
    typeof src.rpcId !== 'string' ||
    !isRecord(src.principal) ||
    src.principal.kind !== 'rdws' ||
    src.principal.userId !== owner ||
    typeof src.principal.nonce !== 'string'
  )
    return;
  return {
    messageId: data.id,
    requestId: src.rpcId,
    nonce: src.principal.nonce,
  };
}

export function usedForkModels(
  events: NativeEvent[],
  owner: string,
  requirement: string,
) {
  const models: UsedForkModel[] = [];
  const seen = new Set<string>();
  const seenMessages = new Set<string>();
  let pending: Input | undefined;
  let target: string | undefined;
  let turn: number | undefined;
  let claimed = false;
  let selected: Record<string, unknown> | undefined;
  let step: { seq: number; number: number } | undefined;
  let inputSeen = false;
  let noteSeq: number | undefined;
  let header: { provider: string; model: string } | undefined;
  let replied = false;
  let ended = false;
  for (const { type, data, seq, surfaceOp } of events) {
    switch (type) {
      case 'agent/inbox/spliced': {
        if (
          !['next-step', 'next-turn'].includes(String(data.target)) ||
          data.outcome !== undefined ||
          data.start !== 0 ||
          !Array.isArray(data.inserted)
        )
          return;
        if (
          data.inserted.length === 1 &&
          !data.removedCount &&
          !pending &&
          turn === undefined
        ) {
          const msg =
            isRecord(data.inserted[0]) && original(data.inserted[0], owner);
          if (
            !msg ||
            seen.has(msg.requestId) ||
            seenMessages.has(msg.messageId)
          )
            return;
          seenMessages.add(msg.messageId);
          seen.add(msg.requestId);
          pending = { ...msg, insertedAt: seq };
          target = String(data.target);
        } else if (
          pending &&
          turn !== undefined &&
          !step &&
          !claimed &&
          data.inserted.length === 0 &&
          data.removedCount === 1 &&
          data.target === target
        ) {
          claimed = true;
        } else return;
        break;
      }
      case 'turn/start':
        if (
          !pending ||
          turn !== undefined ||
          !Number.isSafeInteger(data.turn) ||
          Number(data.turn) < 1
        )
          return;
        turn = Number(data.turn);
        break;
      case 'model/selection':
        if (
          !claimed ||
          step ||
          selected ||
          typeof data.provider !== 'string' ||
          typeof data.model !== 'string'
        )
          return;
        selected = data;
        break;
      case 'step/start':
        if (
          !claimed ||
          step ||
          ended ||
          data.turn !== turn ||
          !Number.isSafeInteger(data.step) ||
          Number(data.step) < 1
        )
          return;
        step = { seq, number: Number(data.step) };
        break;
      case 'user/message': {
        if (!step || !isRecord(data.source) || ended || surfaceOp !== 'append')
          return;
        if (data.source.kind === 'user') {
          const msg = original(data, owner);
          if (
            !msg ||
            inputSeen ||
            !pending ||
            msg.messageId !== pending.messageId ||
            msg.requestId !== pending.requestId ||
            msg.nonce !== pending.nonce
          )
            return;
          inputSeen = true;
        } else if (data.source.kind === 'rdws-context') {
          if (
            !inputSeen ||
            noteSeq !== undefined ||
            data.source.requirementId !== requirement ||
            data.source.turn !== turn ||
            data.source.step !== step.number
          )
            return;
          noteSeq = seq;
        } else if (
          !['runtime-context', 'model-selection'].includes(
            String(data.source.kind),
          )
        )
          return;
        break;
      }
      case 'request/header': {
        const config = isRecord(data.header) && data.header.config;
        if (
          !step ||
          ended ||
          header ||
          noteSeq === undefined ||
          !isRecord(config) ||
          typeof config.provider !== 'string' ||
          typeof config.model !== 'string'
        )
          return;
        if (
          selected &&
          (selected.provider !== config.provider ||
            selected.model !== config.model)
        )
          return;
        header = { provider: config.provider, model: config.model };
        break;
      }
      case 'assistant/message': {
        const source = isRecord(data.message) && data.message.source;
        if (
          !step ||
          noteSeq === undefined ||
          replied ||
          ended ||
          data.turn !== turn ||
          data.step !== step.number ||
          surfaceOp !== 'append' ||
          data.interrupted === true ||
          !isRecord(source) ||
          typeof source.provider !== 'string' ||
          typeof source.model !== 'string' ||
          (header &&
            (source.provider !== header.provider ||
              source.model !== header.model)) ||
          (selected &&
            (source.provider !== selected.provider ||
              source.model !== selected.model))
        )
          return;
        header = { provider: source.provider, model: source.model };
        replied = true;
        break;
      }
      case 'step/end':
        if (
          !step ||
          !replied ||
          ended ||
          data.turn !== turn ||
          data.step !== step.number
        )
          return;
        ended = true;
        break;
      case 'turn/end':
        if (
          turn === undefined ||
          data.turn !== turn ||
          !isRecord(data.reason) ||
          data.reason.kind !== 'completed' ||
          !pending ||
          !step ||
          !ended ||
          !header ||
          noteSeq === undefined
        )
          return;
        models.push({
          ...pending,
          turn,
          step: step.number,
          stepSeq: step.seq,
          noteSeq,
          ...header,
        });
        pending = undefined;
        turn = undefined;
        step = undefined;
        selected = undefined;
        header = undefined;
        noteSeq = undefined;
        claimed = inputSeen = replied = ended = false;
        break;
      case 'session/end-seed':
        if (data.inherited === true) return;
        break;
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'system/message':
      case 'request/context':
      case 'session/title':
        break;
      default:
        return;
    }
  }
  if (!pending && turn === undefined) return models;
}

export async function readForkModelPrefix(
  native: NativeWebHost,
  grant: Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>,
  source: string,
  cut: number,
) {
  if (
    !grant.userId ||
    !grant.requirementId ||
    !grant.ownSessionIds?.includes(source) ||
    cut < 0 ||
    cut >= 1024
  )
    return;
  const signal = AbortSignal.any([native.signal, AbortSignal.timeout(2000)]);
  const events: NativeEvent[] = [];
  const budget = { remainingBytes: 2 * 1024 * 1024 };
  let before = cut + 1;
  try {
    for (let pages = 0; before > 0 && pages < 32; pages++) {
      const page = await sessionPage(
        native,
        grant,
        source,
        cut,
        before,
        50,
        signal,
        budget,
      );
      signal.throwIfAborted();
      for (const { event } of page.records.toReversed()) {
        if (event.seq !== --before) return;
        events.push(event);
      }
      if (!page.hasMore) break;
    }
    if (before !== 0) return;
    events.reverse();
    const marker = events.findLast(
      (e) => e.type === 'session/end-seed' && e.data.inherited === true,
    );
    const local = events.slice(marker ? marker.seq + 1 : 0);
    const uses = usedForkModels(local, grant.userId, grant.requirementId);
    if (uses && uses.length <= 32)
      return { inheritedThrough: marker ? marker.seq - 1 : null, uses };
  } catch {
    // Fork and replay remain available when a fixed prefix cannot be proven.
  }
}
