import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { actionAllowed, isRecord, type Grant } from './access.ts';
export { parseRemoteStreamClientMessage, parseRemoteStreamServerMessage };
export function authorizeStreamFrame(
  text: string,
  grant: Grant,
  opened: Set<string>,
) {
  const frame = parseRemoteStreamClientMessage(text);
  if (frame.type === 'open') {
    if (
      opened.size >= 32 ||
      !isRecord(frame.payload) ||
      !isRecord(frame.payload.args) ||
      !actionAllowed(grant, frame.endpoint, frame.payload.args)
    )
      throw new Error('Stream denied');
    opened.add(frame.streamId);
  } else if (
    (frame.type === 'cancel' || frame.type === 'end') &&
    opened.has(frame.streamId)
  ) {
    if (frame.type === 'cancel') opened.delete(frame.streamId);
  } else throw new Error('Stream uplink disabled');
  return frame;
}

const modelFailure = '本轮模型请求失败，请稍后重试。';
const sessionFailure = '会话请求暂不可用，请稍后重试。';

function publicRemoteFailure(code: unknown) {
  return {
    code:
      typeof code === 'string' && /^[a-z-]+\/[a-z0-9-]{1,80}$/.test(code)
        ? code
        : 'gateway/internal',
    message: sessionFailure,
    details: {},
  };
}

function projectChunk(record: unknown) {
  if (
    !isRecord(record) ||
    record.type !== 'chunk' ||
    !isRecord(record.chunk) ||
    record.chunk.type !== 'finish' ||
    !isRecord(record.chunk.reason)
  )
    return;
  const { kind } = record.chunk.reason;
  if (kind === 'error' || kind === 'aborted') {
    record.chunk = {
      type: 'finish',
      reason: {
        kind,
        failure: {
          code: 'UNKNOWN',
          message: kind === 'aborted' ? '模型请求已中止。' : modelFailure,
        },
      },
    };
  }
}

function projectEntry(entry: unknown) {
  if (!isRecord(entry) || entry.type !== 'event' || !isRecord(entry.event))
    return;
  const { type, data } = entry.event;
  if (!isRecord(data)) return;
  if (
    type === 'turn/end' &&
    isRecord(data.reason) &&
    data.reason.kind === 'error'
  ) {
    data.reason = {
      kind: 'error',
      error: { code: 'UNKNOWN', message: modelFailure },
    };
  }
  if (type === 'llm/retry') {
    data.failure = { code: 'UNKNOWN', message: modelFailure };
  }
  if (
    (type === 'assistant/attempt' || type === 'assistant/message') &&
    Array.isArray(data.stream)
  ) {
    data.stream.forEach(projectChunk);
  }
}

export function publicNativeStreamFrame(text: string) {
  const frame = parseRemoteStreamServerMessage(text);
  if (frame.type === 'error') {
    return JSON.stringify({
      ...frame,
      error: publicRemoteFailure(frame.error.code),
    });
  }
  if (frame.type !== 'item' || !isRecord(frame.value)) return text;
  const { value } = frame;
  if (value.type === 'emit' && value.event === 'api-session/error') {
    if (!Array.isArray(value.args) || typeof value.args[0] !== 'string')
      throw new Error('Malformed Native session notification');
    value.args = [value.args[0], modelFailure];
  } else if (value.type === 'snapshot') {
    if (Array.isArray(value.records)) value.records.forEach(projectEntry);
    const stream = isRecord(value.assistantStream)
      ? value.assistantStream.activeAttempt
      : undefined;
    if (isRecord(stream) && Array.isArray(stream.stream))
      stream.stream.forEach(projectChunk);
  } else if (value.type === 'assistant-stream') {
    projectChunk(value.frame);
  } else if (value.type === 'event') {
    projectEntry(value);
  } else return text;
  return JSON.stringify(frame);
}

export async function publicNativeSessionResponse(
  response: Response,
  rpcId: unknown,
  history: boolean,
) {
  const options = { headers: { 'cache-control': 'no-store' } };
  const unavailable = () =>
    Response.json({ error: sessionFailure }, { ...options, status: 503 });
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !response.ok ||
    typeof rpcId !== 'string' ||
    !isRecord(body) ||
    body.type !== 'server-response' ||
    body.rpcId !== rpcId ||
    !isRecord(body.result)
  )
    return unavailable();
  const envelope = { type: 'server-response', rpcId };
  const { result } = body;
  if (result.ok === false && isRecord(result.error)) {
    return Response.json(
      {
        ...envelope,
        result: { ok: false, error: publicRemoteFailure(result.error.code) },
      },
      options,
    );
  }
  if (result.ok !== true) return unavailable();
  const value = result.value;
  if (history) {
    if (!isRecord(value) || !Array.isArray(value.records)) return unavailable();
    value.records.forEach(projectEntry);
  }
  return Response.json({ ...envelope, result: { ok: true, value } }, options);
}
