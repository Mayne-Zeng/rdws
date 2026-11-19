import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { actionAllowed, isRecord, type Grant } from './access.ts';
import {
  publicControlProjection,
  publicProjectionBaseline,
  publicSessionState,
  publicSessionSummary,
  publicFields,
} from './session-view.ts';
import {
  modelFailure,
  publicAssistantFrame,
  publicAssistantRecords,
  publicHistory,
  publicHistoryEntry,
} from './history-view.ts';
export { parseRemoteStreamClientMessage, parseRemoteStreamServerMessage };
export { publicModelCatalogValue } from './model-catalog-view.ts';

export function createNativeStreamState() {
  return { active: new Map<string, string>(), used: new Set<string>() };
}

type NativeStreamState = ReturnType<typeof createNativeStreamState>;
const maxStreamsPerConnection = 1024;

export function authorizeStreamFrame(
  text: string,
  grant: Grant,
  opened: NativeStreamState,
) {
  const frame = parseRemoteStreamClientMessage(text);
  if (frame.type === 'open') {
    if (
      opened.active.size >= 32 ||
      opened.used.size >= maxStreamsPerConnection ||
      frame.streamId.length > 128 ||
      opened.used.has(frame.streamId) ||
      !isRecord(frame.payload) ||
      !isRecord(frame.payload.args) ||
      !actionAllowed(grant, frame.endpoint, frame.payload.args)
    )
      throw new Error('Stream denied');
    opened.used.add(frame.streamId);
    opened.active.set(frame.streamId, frame.endpoint);
  } else if (frame.type === 'cancel' || frame.type === 'end') {
    if (!opened.active.has(frame.streamId)) {
      if (opened.used.has(frame.streamId)) return;
      throw new Error('Stream uplink disabled');
    }
    if (frame.type === 'cancel') opened.active.delete(frame.streamId);
  } else throw new Error('Stream uplink disabled');
  return frame;
}

const sessionFailure = '会话请求暂不可用，请稍后重试。';
const publicFailureCodes = new Set([
  'gateway/arguments-invalid',
  'gateway/context-not-found',
  'gateway/input-invalid',
  'gateway/internal',
  'gateway/method-unavailable',
  'gateway/peer-disposed',
  'gateway/service-unavailable',
  'remote-access/denied',
  'session/model-unavailable',
  'session/projections-unavailable',
  'session/workspace-attach-failed',
]);

function publicRemoteFailure(code: unknown) {
  return {
    code:
      typeof code === 'string' && publicFailureCodes.has(code)
        ? code
        : 'gateway/internal',
    message: sessionFailure,
    details: {},
  };
}

function projectSessionEmit(value: Record<string, unknown>) {
  if (
    value.type === 'ready' &&
    typeof value.clientId === 'string' &&
    isRecord(value.host) &&
    typeof value.host.home === 'string'
  )
    return {
      type: 'ready',
      clientId: value.clientId,
      host: { home: value.host.home },
    };
  if (value.type !== 'emit' || !Array.isArray(value.args)) return;
  const { event } = value;
  const [id, detail] = value.args;
  if (event === 'api-session/added') {
    const summary = publicSessionSummary(id);
    if (summary) return { type: 'emit', event, args: [summary] };
  }
  if (typeof id !== 'string') return;
  if (event === 'api-session/error')
    return { type: 'emit', event, args: [id, modelFailure] };
  if (event === 'api-session/removed')
    return { type: 'emit', event, args: [id] };
  if (
    (event === 'api-session/status' && typeof detail === 'boolean') ||
    (event === 'api-session/activity' && typeof detail === 'number')
  )
    return { type: 'emit', event, args: [id, detail] };
}

function projectFollow(value: Record<string, unknown>) {
  if (value.type === 'snapshot') {
    const records = publicHistory(value.records);
    if (!records || !isRecord(value.header))
      throw new Error('Invalid history snapshot');
    const baseline = isRecord(value.assistantStream)
      ? value.assistantStream
      : undefined;
    const attempt = isRecord(baseline?.activeAttempt)
      ? baseline.activeAttempt
      : undefined;
    const stream = attempt && publicAssistantRecords(attempt.stream);
    if (attempt && !stream) throw new Error('Invalid assistant baseline');
    return {
      ...publicFields(value, {
        type: ['snapshot'],
        cursor: 'integer',
        hasMore: 'flag',
      }),
      header: publicFields(value.header, {
        version: 'integer',
        id: 'text',
        createdAt: 'integer',
        cwd: 'text',
        parentSession: 'text',
        isSeeded: 'flag',
        origin: ['subagent'],
        delegationDepth: 'integer',
        agentPreset: 'text',
      }),
      records,
      projections: publicProjectionBaseline(value.projections),
      assistantStream: baseline && {
        ...publicFields(baseline, { revision: 'integer' }),
        activeAttempt: attempt && {
          ...publicFields(attempt, {
            attemptId: 'text',
            turn: 'integer',
            step: 'integer',
            startedAfterSeq: 'integer',
            nextIndex: 'integer',
          }),
          stream,
        },
      },
    };
  }
  if (value.type === 'assistant-stream') {
    const frame = publicAssistantFrame(value.frame);
    if (!frame) throw new Error('Invalid assistant stream frame');
    return { type: 'assistant-stream', frame };
  }
  if (value.type === 'event') {
    const entry = publicHistoryEntry(value);
    if (!entry) throw new Error('Invalid history event');
    return entry;
  }
}

export function publicNativeStreamFrame(
  text: string,
  opened: NativeStreamState,
) {
  const frame = parseRemoteStreamServerMessage(text);
  const endpoint = opened.active.get(frame.streamId);
  if (!endpoint) return;
  if (frame.type === 'error') {
    opened.active.delete(frame.streamId);
    return JSON.stringify({
      ...frame,
      error: publicRemoteFailure(frame.error.code),
    });
  }
  if (frame.type === 'end') {
    opened.active.delete(frame.streamId);
    return text;
  }
  if (!isRecord(frame.value)) return;
  const { value } = frame;
  let projected: unknown;
  switch (endpoint) {
    case '$events':
      projected = projectSessionEmit(value);
      break;
    case 'session/follow':
      projected = projectFollow(value);
      break;
    case 'session/observeEvent':
      if (value.type === 'ready') projected = { type: 'ready' };
      else if (value.type === 'event') projected = projectFollow(value);
      break;
    case 'session/observeState':
      projected = publicSessionState(value);
      break;
    case 'session/observeProjections':
      if (value.type === 'ready') projected = { type: 'ready' };
      else if (value.type === 'projection')
        projected = publicControlProjection(value);
      break;
    case 'session/control':
      projected = publicControlProjection(value);
      break;
    case 'remoteAccess/follow':
      return text;
  }
  if (projected !== undefined)
    return JSON.stringify({ ...frame, value: projected });
}

const nativeResponseOptions = { headers: { 'cache-control': 'no-store' } };

export async function withNativeEnvelope(
  response: Response,
  rpcId: unknown,
  project: (
    result: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
  unavailable: () => Response,
) {
  if (!response.ok || typeof rpcId !== 'string') {
    await response.body?.cancel().catch(() => {});
    return unavailable();
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !isRecord(body) ||
    body.type !== 'server-response' ||
    body.rpcId !== rpcId ||
    !isRecord(body.result)
  )
    return unavailable();
  const result = project(body.result);
  if (!result) return unavailable();
  return Response.json(
    { type: 'server-response', rpcId, result },
    nativeResponseOptions,
  );
}

export function publicNativeSessionResponse(
  response: Response,
  rpcId: unknown,
  method: string,
) {
  return withNativeEnvelope(
    response,
    rpcId,
    (result) => {
      if (result.ok === false && isRecord(result.error))
        return { ok: false, error: publicRemoteFailure(result.error.code) };
      if (result.ok !== true) return;
      let { value } = result;
      switch (method) {
        case '/api/session/page':
        case '/api/session/events': {
          if (!isRecord(value)) return;
          const records = publicHistory(value.records);
          if (!records) return;
          value = {
            ...publicFields(value, { cursor: 'integer', hasMore: 'flag' }),
            records,
          };
          break;
        }
        case '/api/session/state':
          value = publicSessionState(value);
          if (value === undefined) return;
          break;
        case '/api/session/projections':
          value = value === null ? null : publicProjectionBaseline(value);
          if (value === undefined) return;
          break;
        case '/api/session/list':
          if (!isRecord(value) || !Array.isArray(value.items)) return;
          value = {
            items: value.items
              .map(publicSessionSummary)
              .filter((item) => item !== undefined),
          };
          break;
      }
      return { ok: true, value };
    },
    () =>
      Response.json(
        { error: sessionFailure },
        { ...nativeResponseOptions, status: 503 },
      ),
  );
}
