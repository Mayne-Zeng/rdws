import { parseRemoteStreamClientMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { actionAllowed, isRecord, type Grant } from './access.ts';
export { parseRemoteStreamClientMessage };
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
