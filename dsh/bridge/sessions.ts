import { randomUUID } from 'node:crypto';
import type { NativeWebHost } from '../host/web.ts';
import type { SessionExecutionEvent } from '@rdws/contracts';
import { isRecord, RDWS_TOOL_GUARD_DENIAL, type Grant } from './access.ts';
export interface NativeEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
}
export interface NativePage {
  cursor: number;
  hasMore: boolean;
  records: { type: 'event'; event: NativeEvent }[];
}

function position(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function toolResultStatus(
  message: Record<string, unknown>,
  error: unknown,
): SessionExecutionEvent['status'] {
  if (message.isError === false)
    return isRecord(error) &&
      (typeof error.name === 'string' || typeof error.code === 'string')
      ? 'outcome-unknown'
      : 'result-returned';
  if (message.isError !== true) return 'outcome-unknown';
  if (isRecord(error)) {
    const { name, code } = error;
    if (
      name === RDWS_TOOL_GUARD_DENIAL.name &&
      code === RDWS_TOOL_GUARD_DENIAL.code
    )
      return 'blocked';
    if (
      (name === 'ToolNotStartedError' && code === 'TOOL_NOT_STARTED') ||
      (name === 'AbortError' && code === 'ABORTED_BEFORE_DISPATCH')
    )
      return 'not-started';
    if (name === 'ToolOutcomeUnknownError' && code === 'TOOL_OUTCOME_UNKNOWN')
      return 'outcome-unknown';
  }
  return 'result-error';
}

export function projectSessionExecution(
  records: NativePage['records'],
  session: { sourceSessionId: string | null; sourceThroughSeq: number | null },
): SessionExecutionEvent[] {
  const bySeq = new Map(records.map(({ event }) => [event.seq, event]));
  return records.flatMap(({ event }) => {
    const { seq, type, data, sourceEventSeqs, surfaceOp } = event;
    const { turn, step } = data;
    if (!position(turn) || !position(step)) return [];
    const origin =
      session.sourceSessionId === null && session.sourceThroughSeq === null
        ? 'session'
        : session.sourceSessionId &&
            (session.sourceThroughSeq === -1 ||
              position(session.sourceThroughSeq))
          ? seq <= session.sourceThroughSeq
            ? 'inherited'
            : 'session'
          : 'unknown';
    const eventFields = { seq, turn, step, origin } as const;
    if (type === 'tool/call')
      return typeof data.callId === 'string' && data.callId.length > 0
        ? [{ ...eventFields, status: 'requested' }]
        : [];
    const { message } = data;
    if (
      type !== 'tool/result' ||
      surfaceOp !== 'append' ||
      !isRecord(message) ||
      message.role !== 'tool' ||
      typeof message.toolCallId !== 'string' ||
      !message.toolCallId ||
      !isRecord(message.source) ||
      message.source.kind !== 'tool' ||
      message.source.callId !== message.toolCallId
    )
      return [];
    let sourceSeq: number | undefined;
    if (Array.isArray(sourceEventSeqs) && sourceEventSeqs.length === 1) {
      const [ref] = sourceEventSeqs;
      if (position(ref) && ref < seq) {
        const candidate = bySeq.get(ref);
        if (
          !candidate ||
          (candidate.type === 'tool/call' &&
            candidate.data.callId === message.toolCallId &&
            candidate.data.turn === turn &&
            candidate.data.step === step)
        )
          sourceSeq = ref;
      }
    }
    return [
      {
        ...eventFields,
        status: toolResultStatus(message, data.error),
        ...(sourceSeq === undefined ? {} : { sourceSeq }),
      },
    ];
  });
}
export async function sessionRpc(
  host: NativeWebHost,
  grant: string | Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>,
  action: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const rpcId = randomUUID();
  const response = await host.fetch('/api/' + action, grant, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: action,
      payload: { args: { request } },
    }),
  });
  const value: unknown = await response.json();
  if (
    !response.ok ||
    !isRecord(value) ||
    value.rpcId !== rpcId ||
    !isRecord(value.result) ||
    value.result.ok !== true
  ) {
    const failure = new Error('Native session operation failed');
    if (
      isRecord(value) &&
      isRecord(value.result) &&
      isRecord(value.result.error) &&
      value.result.error.code === 'session/workspace-attach-failed' &&
      isRecord(value.result.error.details) &&
      typeof value.result.error.details.sessionId === 'string' &&
      /^session-[a-zA-Z0-9-]+$/.test(value.result.error.details.sessionId)
    )
      Object.assign(failure, {
        nativeSessionId: value.result.error.details.sessionId,
      });
    throw failure;
  }
  return value.result.value;
}
export async function sessionPage(
  host: NativeWebHost,
  grant: Parameters<typeof sessionRpc>[1],
  sessionId: string,
  throughSeq?: number,
  beforeSeq?: number,
  maxMessages = 20,
): Promise<NativePage> {
  const value = await sessionRpc(host, grant, 'session/events', {
    address: { kind: 'session', sessionId },
    maxMessages,
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
  });
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < -1 ||
    typeof value.hasMore !== 'boolean' ||
    !Array.isArray(value.records)
  )
    throw new Error('Invalid Native history');
  let previous = -1;
  for (const row of value.records) {
    if (
      !isRecord(row) ||
      row.type !== 'event' ||
      !isRecord(row.event) ||
      !Number.isSafeInteger(row.event.seq) ||
      Number(row.event.seq) <= previous ||
      Number(row.event.seq) > Number(value.cursor) ||
      typeof row.event.type !== 'string' ||
      !isRecord(row.event.data)
    )
      throw new Error('Invalid Native event');
    previous = Number(row.event.seq);
  }
  if (throughSeq !== undefined && value.cursor !== throughSeq)
    throw new Error('Native history cut changed');
  if (
    value.hasMore &&
    (!value.records.length ||
      Number((value.records[0] as { event: NativeEvent }).event.seq) <= 0)
  )
    throw new Error('Native history made no progress');
  return value as unknown as NativePage;
}
export async function forkBoundary(
  host: NativeWebHost,
  grant: Parameters<typeof sessionRpc>[1],
  sessionId: string,
) {
  let page = await sessionPage(host, grant, sessionId);
  const cursor = page.cursor;
  let events = page.records.map((r) => r.event);
  while (!events.some((e) => e.type === 'turn/end') && page.hasMore) {
    const before = events[0]!.seq;
    page = await sessionPage(host, grant, sessionId, cursor, before);
    if (page.records.some((r) => r.event.seq >= before))
      throw new Error('Native history made no progress');
    events = [...page.records.map((r) => r.event), ...events];
  }
  const end = events.findLastIndex((e) => e.type === 'turn/end');
  if (end < 0) return undefined;
  let boundary = events[end]!.seq;
  for (const event of events.slice(end + 1)) {
    if (
      event.type === 'turn/start' ||
      event.type === 'agent/inbox/spliced' ||
      (event.type === 'user/message' && event.surfaceOp === 'append')
    )
      break;
    boundary = event.seq;
  }
  return boundary;
}
