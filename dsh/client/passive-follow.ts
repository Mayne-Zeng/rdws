type SocketData = Parameters<WebSocket['send']>[0];
const streamIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sessionIdPattern = /^session-[a-zA-Z0-9-]{1,120}$/;

function hasKeys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function passiveModelFollow(data: SocketData): SocketData {
  if (typeof data !== 'string' || data.length > 16 * 1024) return data;
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return data;
  }
  if (
    !hasKeys(frame, ['type', 'streamId', 'endpoint', 'payload']) ||
    frame.type !== 'open' ||
    frame.endpoint !== 'session/follow' ||
    typeof frame.streamId !== 'string' ||
    !streamIdPattern.test(frame.streamId) ||
    !hasKeys(frame.payload, ['args']) ||
    !hasKeys(frame.payload.args, ['request'])
  )
    return data;
  const { request } = frame.payload.args;
  if (
    !hasKeys(
      request,
      ['address', 'activate', 'assistantStream'],
      ['maxMessages', 'turnWindow'],
    ) ||
    request.activate !== true ||
    request.assistantStream !== true ||
    !hasKeys(request.address, ['kind', 'sessionId']) ||
    request.address.kind !== 'session' ||
    typeof request.address.sessionId !== 'string' ||
    !sessionIdPattern.test(request.address.sessionId)
  )
    return data;
  const { maxMessages = 50, turnWindow } = request;
  if (
    !positiveInteger(maxMessages) ||
    (turnWindow !== undefined &&
      (!hasKeys(turnWindow, ['minMessages', 'minTurns']) ||
        !positiveInteger(turnWindow.minMessages) ||
        turnWindow.minMessages > maxMessages ||
        !positiveInteger(turnWindow.minTurns))) ||
    JSON.stringify(frame) !== data
  )
    return data;
  request.activate = false;
  return JSON.stringify(frame);
}
