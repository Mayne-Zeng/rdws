import { hasSubscribers } from 'node:diagnostics_channel';
import { once } from 'node:events';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { createConnection, isIP, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { debuglog } from 'node:util';
import {
  businessHeader,
  type ModelCarrierRequest,
} from '../bridge/model-carrier.ts';
import {
  firstWriteLimit,
  modelSocketDescriptor,
  submitModelPrefix,
  type ModelWireOutcome,
} from './model-wire.ts';

export type { ModelWireOutcome } from './model-wire.ts';
export type ModelWireCommit = {
  outcome: ModelWireOutcome;
  accept429(): void;
};
type AuthorizeWire = (
  write: (validBefore: number) => ModelWireOutcome,
) => Promise<ModelWireCommit>;

const bodyLimit = 1024 * 1024;
const headerLimit = 16 * 1024;
const retryBodyLimit = 64 * 1024;
const diagnosticChannels = [
  'http.client.request.created',
  'http.client.request.start',
  'http.client.request.error',
  'http.client.response.finish',
  'net.client.socket',
];
const debugCategories = ['http', 'tls', 'net', 'stream'].map((name) =>
  debuglog(name),
);
const unavailable = () => new Error('Model HTTPS transport unavailable');

function connectionHeaders(value?: string) {
  return new Set(value?.split(',').map((name) => name.trim().toLowerCase()));
}

async function untilClosed<T>(task: Promise<T>, signal: AbortSignal) {
  const stop = () => rejectClose(unavailable());
  let rejectClose!: (error: Error) => void;
  const closed = new Promise<never>((_resolve, reject) => {
    rejectClose = reject;
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    return await Promise.race([task, closed]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

function diagnosticsSafe() {
  return (
    !diagnosticChannels.some(hasSubscribers) &&
    !debugCategories.some((debug) => debug.enabled) &&
    !process.env.NODE_DEBUG_NATIVE &&
    ![...process.execArgv, process.env.NODE_OPTIONS ?? ''].some((option) =>
      /--tls[-_]keylog/.test(option),
    )
  );
}

async function readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) return Buffer.concat(chunks, length);
      length += result.value.byteLength;
      if (length > bodyLimit) throw unavailable();
      chunks.push(result.value);
    }
  } catch {
    cancel();
    throw unavailable();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function requestHeaders(headers: Headers, url: URL, length: number) {
  const nominated = connectionHeaders(headers.get('connection') ?? undefined);
  const result = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const [name, value] of headers) {
    if (!businessHeader(name) || nominated.has(name) || name === 'expect')
      continue;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > headerLimit) throw unavailable();
    result[name] = value;
  }
  return Object.assign(result, {
    host: url.host,
    'accept-encoding': 'identity',
    connection: 'close',
    'content-length': String(length),
  });
}

function completeCiphertext(bytes: Buffer) {
  if (!bytes.length) return false;
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const length = bytes.readUInt16BE(offset + 3);
    if (
      bytes[offset] !== 23 ||
      bytes[offset + 1] !== 3 ||
      bytes[offset + 2] !== 3 ||
      length === 0 ||
      length > 16_640
    )
      return false;
    offset += length + 5;
    if (offset === bytes.length) return true;
  }
  return false;
}

async function drainRetry(incoming: IncomingMessage) {
  let bytes = 0;
  for await (const chunk of incoming) {
    bytes += (chunk as Buffer).byteLength;
    if (bytes > retryBodyLimit) throw unavailable();
  }
  if (!incoming.complete) throw unavailable();
}

function hasResponseFraming(incoming: IncomingMessage) {
  const transfer = incoming.headers['transfer-encoding'];
  const length = incoming.headers['content-length'];
  return transfer !== undefined
    ? transfer.toLowerCase() === 'chunked' && length === undefined
    : length !== undefined &&
        /^[0-9]+$/.test(length) &&
        Number.isSafeInteger(Number(length));
}

function responseStream(incoming: IncomingMessage, drain: () => Promise<void>) {
  const body = incoming[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await body.next();
        if (cancelled) return;
        if (part.done) {
          if (!incoming.complete) throw unavailable();
          await drain();
          if (!cancelled) controller.close();
        } else controller.enqueue(part.value);
      } catch {
        await drain();
        if (!cancelled) controller.error(unavailable());
      }
    },
    cancel() {
      cancelled = true;
      return drain();
    },
  });
}

export function createModelHttpsRelay(
  destination: string,
  ca?: string | Buffer,
  projectBody?: (body: Buffer) => Buffer | undefined,
  purpose?: 'session-title',
) {
  return modelHttpsRelay(destination, ca, projectBody, purpose);
}

export function createLoopbackAttachmentHttpsRelay(
  destination: string,
  ca: Buffer,
  routeId: 'files' | 'messages',
) {
  if (!ca.length) throw unavailable();
  return modelHttpsRelay(destination, ca, undefined, undefined, routeId);
}

function modelHttpsRelay(
  destination: string,
  ca: string | Buffer | undefined,
  projectBody?: (body: Buffer) => Buffer | undefined,
  purpose?: 'session-title',
  attachmentRoute?: 'files' | 'messages',
) {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== 'https:' ||
    (attachmentRoute
      ? url.href !== destination ||
        url.hostname !== '127.0.0.1' ||
        !url.pathname.endsWith(`/${attachmentRoute}`)
      : !url.pathname.endsWith('/chat/completions')) ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    url.username ||
    url.password
  )
    throw unavailable();
  const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
  const port = url.port ? Number(url.port) : 443;

  return async (
    request: ModelCarrierRequest,
    authorize: AuthorizeWire,
  ): Promise<Response> => {
    if (
      process.platform !== 'darwin' ||
      process.version !== 'v24.20.0' ||
      request.destination !== url.href ||
      (attachmentRoute !== undefined && request.routeId !== attachmentRoute) ||
      request.call.purpose !== purpose ||
      !request.call.bindingId ||
      !request.isCurrent() ||
      request.signal.aborted ||
      !diagnosticsSafe()
    )
      throw unavailable();

    const controller = new AbortController();
    const { signal } = controller;
    let socket: Socket | undefined;
    let transport: Duplex | undefined;
    let secure: TLSSocket | undefined;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let closed: Promise<void> | undefined;
    let authorization: Promise<ModelWireCommit> | undefined;
    let stopped = false;
    const deadline = setTimeout(stop, 10_000).unref();
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      request.signal.removeEventListener('abort', stop);
      controller.abort();
      incoming?.destroy();
      outgoing?.destroy();
      secure?.destroy();
      transport?.destroy();
      socket?.destroy();
    }
    async function drain() {
      stop();
      await Promise.allSettled([closed, authorization]);
    }
    request.signal.addEventListener('abort', stop, { once: true });
    try {
      const buffered = await readBody(request.body, signal);
      const body = projectBody ? projectBody(buffered) : buffered;
      if (!body || body.length > bodyLimit) throw unavailable();
      const headers = requestHeaders(request.headers, url, body.length);
      signal.throwIfAborted();
      if (!request.isCurrent() || !diagnosticsSafe()) throw unavailable();
      const raw = createConnection({ host, port });
      socket = raw;
      let canRead = true;
      let phase: 'handshake' | 'capture' | 'sealed' | 'stream' = 'handshake';
      const captured: Buffer[] = [];
      let length = 0;
      const bridge = new Duplex({
        read() {
          if (canRead) raw.resume();
        },
        write(chunk: Buffer, _encoding, done) {
          if (phase === 'capture') {
            length += chunk.length;
            if (length > bodyLimit + 2 * headerLimit)
              return done(unavailable());
            captured.push(Buffer.from(chunk));
            done();
            return;
          }
          if (phase === 'sealed') return done(unavailable());
          raw.write(chunk, done);
        },
        destroy(error, done) {
          raw.destroy();
          done(error);
        },
      });
      transport = bridge;
      bridge.on('error', () => {});
      raw.on('error', () => bridge.destroy(unavailable()));
      raw.on('data', (chunk: Buffer) => {
        if (!canRead) bridge.destroy(unavailable());
        else if (!bridge.push(chunk)) raw.pause();
      });
      raw.on('end', () => bridge.push(null));
      closed = new Promise<void>((resolve) =>
        raw.once('close', () => {
          if (!raw.readableEnded) bridge.destroy(unavailable());
          resolve();
        }),
      );
      raw.setTimeout(30_000, stop);
      const tls = connectTls({
        socket: bridge,
        host,
        ...(isIP(host) ? {} : { servername: host }),
        ca,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
        enableTrace: false,
      });
      secure = tls;
      tls.on('error', () => {});
      if (tls.listenerCount('keylog') !== 0) throw unavailable();
      await once(tls, 'secureConnect', { signal });
      if (
        !tls.authorized ||
        tls.getProtocol() !== 'TLSv1.3' ||
        (tls.alpnProtocol && tls.alpnProtocol !== 'http/1.1')
      )
        throw unavailable();
      canRead = false;
      raw.pause();
      await setImmediate(undefined, { signal });
      await new Promise<void>((resolve, reject) => {
        tls.write(Buffer.alloc(0), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      const fd = modelSocketDescriptor(raw);
      if (
        fd === undefined ||
        bridge.writableLength !== 0 ||
        bridge.readableLength !== 0 ||
        tls.listenerCount('keylog') !== 0 ||
        !diagnosticsSafe()
      )
        throw unavailable();
      signal.throwIfAborted();
      phase = 'capture';
      const reply = new Promise<IncomingMessage>((resolve, reject) => {
        outgoing = httpRequest(
          {
            hostname: host,
            port,
            path: url.pathname,
            method: 'POST',
            headers,
            httpValidation: 'strict',
            maxHeaderSize: headerLimit,
            createConnection: () => tls,
          },
          (response) => {
            incoming = response;
            response.on('error', () => {});
            resolve(response);
          },
        );
        outgoing.once('error', reject);
        outgoing.once('close', () => reject(unavailable()));
        outgoing.once('upgrade', (_response, socket) => {
          socket.destroy();
          reject(unavailable());
        });
      });
      Object.defineProperty(outgoing!, 'getHeaders', { value: () => ({}) });
      void reply.catch(() => {});
      const ready = once(outgoing!, 'finish', { signal });
      outgoing!.end(body);
      await ready;
      const performanceState = Object.getOwnPropertySymbols(outgoing!).find(
        (key) => key.description === 'ClientRequestStatistics',
      );
      if (
        performanceState &&
        !Reflect.deleteProperty(outgoing!, performanceState)
      )
        throw unavailable();
      phase = 'sealed';
      const bytes = Buffer.concat(captured, length);
      captured.length = 0;
      if (
        !completeCiphertext(bytes) ||
        bridge.writableLength !== 0 ||
        tls.writableLength !== 0
      )
        throw unavailable();
      const prefix = bytes.subarray(0, firstWriteLimit);
      authorization = authorize((validBefore) => {
        if (
          signal.aborted ||
          !request.isCurrent() ||
          tls.listenerCount('keylog') !== 0 ||
          !diagnosticsSafe()
        )
          return 'not-sent';
        return submitModelPrefix(raw, fd, prefix, validBefore);
      });
      const commit = await untilClosed(authorization, signal);
      if (commit.outcome !== 'submitted') throw unavailable();
      signal.throwIfAborted();
      if (bytes.length > prefix.length)
        await new Promise<void>((resolve, reject) => {
          raw.write(bytes.subarray(prefix.length), (error) =>
            error ? reject(error) : resolve(),
          );
        });
      phase = 'stream';
      canRead = true;
      raw.resume();
      const response = await reply;
      const status = response.statusCode ?? 0;
      const encoding = response.headers['content-encoding'];
      if (
        status < 200 ||
        status > 599 ||
        (status >= 300 && status < 400) ||
        (encoding !== undefined && encoding.toLowerCase() !== 'identity')
      )
        throw unavailable();
      if (status !== 204 && status !== 205 && !hasResponseFraming(response))
        throw unavailable();
      if (status === 429) {
        await drainRetry(response);
        await drain();
        commit.accept429();
        return new Response(null, { status });
      }
      clearTimeout(deadline);
      if (status >= 400 || status === 204 || status === 205) {
        await drain();
        return new Response(null, { status });
      }
      const returned = new Headers();
      const nominated = connectionHeaders(response.headers.connection);
      for (const [key, value] of Object.entries(response.headers))
        if (businessHeader(key) && !nominated.has(key))
          for (const entry of Array.isArray(value) ? value : [value])
            if (entry !== undefined) returned.append(key, entry);
      return new Response(responseStream(response, drain), {
        status,
        headers: returned,
      });
    } catch {
      await drain();
      throw unavailable();
    }
  };
}
