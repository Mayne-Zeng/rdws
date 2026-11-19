import { fstatSync, writeSync } from 'node:fs';
import type { Socket } from 'node:net';

export type ModelWireOutcome = 'submitted' | 'not-sent' | 'indeterminate';
export const firstWriteLimit = 16 * 1024;

export function modelSocketDescriptor(socket: Socket) {
  if (process.platform !== 'darwin' || process.version !== 'v24.20.0') return;
  if (
    socket.destroyed ||
    socket.readyState !== 'open' ||
    socket.writableLength !== 0
  )
    return;
  const handle = (socket as Socket & { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 3) return;
  try {
    if (fstatSync(fd).isSocket()) return fd;
  } catch {
    return;
  }
}

export function submitModelPrefix(
  socket: Socket,
  descriptor: number,
  prefix: Buffer,
  validBefore: number,
): ModelWireOutcome {
  if (
    modelSocketDescriptor(socket) !== descriptor ||
    !(Date.now() < validBefore) ||
    prefix.length === 0 ||
    prefix.length > firstWriteLimit
  )
    return 'not-sent';
  try {
    const written = writeSync(descriptor, prefix, 0, prefix.length);
    if (written === 0) return 'not-sent';
    return written === prefix.length ? 'submitted' : 'indeterminate';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EAGAIN' || code === 'EWOULDBLOCK'
      ? 'not-sent'
      : 'indeterminate';
  }
}
