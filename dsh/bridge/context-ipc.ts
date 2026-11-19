import { randomUUID } from 'node:crypto';
import type { SendHandle } from 'node:child_process';
import { isRecord } from './access.ts';

const requestType = 'rdws-context-request';
const responseType = 'rdws-context-response';
const maxBytes = 64 * 1024;
const maxPending = 64;
const timeoutMs = 2000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Listener = (message: unknown, handle?: SendHandle) => void;
interface Channel {
  readonly connected: boolean;
  send?(message: object, callback: (error: Error | null) => void): boolean;
  on(event: 'message' | 'disconnect', listener: Listener): unknown;
  off(event: 'message' | 'disconnect', listener: Listener): unknown;
}
export type ContextHandler = (
  input: unknown,
  token: unknown,
  reply: (result: unknown, validBefore: number) => void,
) => Promise<unknown>;

const unavailable = () => new Error('Current context authorization failed');
function fits(message: object) {
  try {
    return Buffer.byteLength(JSON.stringify(message)) <= maxBytes;
  } catch {
    return false;
  }
}

function rejectHandle(handle: SendHandle) {
  if (!handle) return false;
  if ('destroy' in handle) handle.destroy();
  else {
    try {
      handle.close(() => {});
    } catch {
      /* Socket is already closed. */
    }
  }
  return true;
}

function envelope(message: unknown, type: string, generation: string) {
  if (
    isRecord(message) &&
    message.type === type &&
    message.generation === generation &&
    typeof message.id === 'string' &&
    uuid.test(message.id) &&
    fits(message)
  )
    return { message, id: message.id };
}

function send(channel: Channel, message: object) {
  return new Promise<void>((resolve, reject) => {
    if (!channel.connected || !channel.send) {
      reject(unavailable());
      return;
    }
    channel.send(message, (error) =>
      error ? reject(unavailable()) : resolve(),
    );
  });
}

export function serveContextIpc(
  channel: Channel,
  generation: string,
  handle: ContextHandler | undefined,
  current: () => boolean,
) {
  const active = new Set<string>();
  let closed = false;
  const available = () => !closed && channel.connected && current();
  const receive: Listener = (data, handleValue) => {
    if (rejectHandle(handleValue) || !handle || !available()) return;
    const request = envelope(data, requestType, generation);
    if (!request) return;
    const { message, id } = request;
    const deadline = message.deadline;
    const now = Date.now();
    if (
      typeof deadline !== 'number' ||
      !Number.isSafeInteger(deadline) ||
      deadline <= now ||
      deadline > now + timeoutMs ||
      !isRecord(message.body) ||
      typeof message.token !== 'string' ||
      active.has(id) ||
      active.size >= maxPending
    )
      return;
    active.add(id);
    let delivery: Promise<void> | undefined;
    const sendResult = (result?: unknown, validBefore = 0) => {
      if (delivery || !available() || deadline <= Date.now()) return;
      const base = { type: responseType, generation, id };
      const success = { ...base, ok: true, result };
      const eligible = isRecord(result) && fits(success);
      const completedAt = Date.now();
      if (deadline <= completedAt) return;
      delivery = send(
        channel,
        eligible && validBefore > completedAt
          ? success
          : { ...base, ok: false },
      ).catch(() => {});
    };
    void (async () => {
      try {
        await handle(message.body, message.token, sendResult);
      } catch {
        sendResult();
      } finally {
        await delivery;
        active.delete(id);
      }
    })();
  };
  channel.on('message', receive);
  return () => {
    closed = true;
    channel.off('message', receive);
    active.clear();
  };
}

export function openContextIpc(generation: string, channel: Channel = process) {
  const pending = new Map<
    string,
    (message?: Record<string, unknown>) => void
  >();
  const outgoing = new Set<string>();
  let closed = false;
  const receive: Listener = (data, handle) => {
    if (rejectHandle(handle)) return;
    const response = envelope(data, responseType, generation);
    if (response) pending.get(response.id)?.(response.message);
  };
  const close = () => {
    closed = true;
    channel.off('message', receive);
    channel.off('disconnect', close);
    for (const settle of pending.values()) settle();
    outgoing.clear();
  };
  if (channel.connected) {
    channel.on('message', receive);
    channel.on('disconnect', close);
  } else closed = true;
  return {
    close,
    async request(body: unknown, token: string, signal?: AbortSignal) {
      if (
        closed ||
        !channel.connected ||
        signal?.aborted ||
        pending.size >= maxPending ||
        outgoing.size >= maxPending
      )
        throw unavailable();
      const id = randomUUID();
      const deadline = Date.now() + timeoutMs;
      const request = {
        type: requestType,
        generation,
        id,
        deadline,
        body,
        token,
      };
      if (!fits(request)) throw unavailable();
      return new Promise<unknown>((resolve, reject) => {
        const settle = (message?: Record<string, unknown>) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (
            message?.ok === true &&
            isRecord(message.result) &&
            deadline > Date.now()
          )
            resolve(message.result);
          else reject(unavailable());
        };
        const abort = () => settle();
        const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
        timer.unref();
        pending.set(id, settle);
        signal?.addEventListener('abort', abort, { once: true });
        outgoing.add(id);
        void send(channel, request)
          .catch(abort)
          .finally(() => outgoing.delete(id));
      });
    },
  };
}
