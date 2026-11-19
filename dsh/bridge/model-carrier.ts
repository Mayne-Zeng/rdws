import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  connect,
  constants,
  performServerHandshake,
  sensitiveHeaders,
  type Http2Session,
  type Http2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2';
import { Readable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { isRecord } from './access.ts';

const authority = 'rdws-model-carrier.invalid';
const generationHeader = 'x-rdws-carrier-generation';
const versionHeader = 'x-rdws-carrier-version';
const attemptHeader = 'x-rdws-carrier-attempt';
const callHeader = 'x-rdws-carrier-call';
const version = '1';
const maxStreams = 16;
const idleMs = 30000;
const settings = { headerTableSize: 0, maxConcurrentStreams: maxStreams };
const limits = {
  settings,
  maxDeflateDynamicTableSize: 0,
  maxHeaderListPairs: 40,
  maxSessionMemory: 4,
};
const empty = new Set([204, 205, 304]);
const redirects = new Set([301, 302, 303, 307, 308]);
const routeKey = /^[a-z0-9][a-z0-9-]{0,47}$/;
const modelEndpoint = /(?:\/chat\/completions|\/files|\/messages)$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hop = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'host',
  'te',
  'trailer',
  'content-length',
]);

export interface ModelCarrierCall {
  id: string;
  provider: string;
  model: string;
  sessionId?: string;
  purpose?: string;
  bindingId?: string;
}
export interface ModelCarrierRequest {
  routeId: string;
  destination: string;
  attemptId: string;
  call: ModelCarrierCall;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export interface NativeModelTransport {
  routes: Readonly<Record<string, string>>;
  handle(request: ModelCarrierRequest): Promise<Response>;
  signal?: AbortSignal;
}

const unavailable = () => new Error('Native model carrier unavailable');

export function snapshotModelRoutes(routes: Readonly<Record<string, string>>) {
  const result = new Map<string, string>();
  const urls = new Set<string>();
  for (const [id, value] of Object.entries(routes)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid Native model route');
    }
    if (
      !routeKey.test(id) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#') ||
      !modelEndpoint.test(url.pathname) ||
      urls.has(url.href)
    )
      throw new Error('Invalid Native model route');
    result.set(id, url.href);
    urls.add(url.href);
  }
  if (!result.size) throw new Error('Native model carrier requires routes');
  return result;
}

export function businessHeader(name: string) {
  return (
    !name.startsWith(':') &&
    !name.startsWith('x-rdws-carrier-') &&
    !hop.has(name)
  );
}

function incomingHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (businessHeader(key))
      for (const entry of Array.isArray(value) ? value : [value])
        if (typeof entry === 'string') result.append(key, entry);
  }
  return result;
}

function businessHeaders(headers: Headers): OutgoingHttpHeaders {
  const nominated = new Set(
    (headers.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase()),
  );
  const result = Object.fromEntries(
    [...headers].filter(
      ([name]) => businessHeader(name) && !nominated.has(name),
    ),
  );
  return { ...result, [sensitiveHeaders]: Object.keys(result) };
}

function decodeCall(raw: unknown): ModelCarrierCall | undefined {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(raw)) return;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    const named = (text: unknown) =>
      typeof text === 'string' && text.length > 0 && text.length <= 160;
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id) ||
      !named(value.provider) ||
      !named(value.model) ||
      (value.sessionId !== undefined && !named(value.sessionId)) ||
      (value.purpose !== undefined && !named(value.purpose)) ||
      (value.bindingId !== undefined &&
        (typeof value.bindingId !== 'string' || !uuid.test(value.bindingId)))
    )
      return;
    return {
      id: value.id,
      provider: value.provider as string,
      model: value.model as string,
      sessionId: value.sessionId as string | undefined,
      purpose: value.purpose as string | undefined,
      bindingId: value.bindingId as string | undefined,
    };
  } catch {
    return;
  }
}

function bodyOf(stream: Readable) {
  return Readable.toWeb(stream, {
    strategy: {
      highWaterMark: stream.readableHighWaterMark,
      size: (chunk: Uint8Array) => chunk.byteLength,
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

function managed(session: Http2Session) {
  session.on('error', () => session.destroy());
  session.on('goaway', () => session.destroy());
}

function transportFailure(
  stream: Http2Stream,
  code = constants.NGHTTP2_REFUSED_STREAM,
) {
  if (!stream.destroyed && !stream.closed) stream.close(code);
}

export function serveModelCarrier(
  socket: Duplex,
  generation: string,
  routes: ReadonlyMap<string, string>,
  handle: NativeModelTransport['handle'],
  current: () => boolean,
  lifecycle?: AbortSignal,
) {
  const session = performServerHandshake(socket, limits);
  managed(session);
  let remote = false,
    acknowledged = false,
    identity = false,
    active = 0;
  const close = () => session.destroy();
  const ready = () =>
    identity && !session.closed && !session.destroyed && !lifecycle?.aborted;
  if (lifecycle?.aborted) close();
  else lifecycle?.addEventListener('abort', close, { once: true });
  session.once('close', () => lifecycle?.removeEventListener('abort', close));
  session.once('remoteSettings', () => {
    remote = true;
  });
  session.once('localSettings', () => {
    acknowledged = true;
  });
  session.on('stream', (stream, headers, _flags, raw) => {
    stream.on('error', () => {});
    stream.setTimeout(idleMs, () =>
      transportFailure(stream, constants.NGHTTP2_CANCEL),
    );
    const names = new Set<string>();
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i]!;
      if (
        names.has(name) ||
        (!name.startsWith(':') &&
          !businessHeader(name) &&
          ![
            versionHeader,
            generationHeader,
            callHeader,
            attemptHeader,
          ].includes(name))
      ) {
        transportFailure(stream);
        return;
      }
      names.add(name);
    }
    if (
      !remote ||
      !acknowledged ||
      headers[':scheme'] !== 'http' ||
      headers[':authority'] !== authority ||
      headers[generationHeader] !== generation ||
      headers[versionHeader] !== version
    ) {
      transportFailure(stream);
      return;
    }
    if (
      !identity &&
      headers[':method'] === 'GET' &&
      headers[':path'] === '/ready' &&
      stream.endAfterHeaders
    ) {
      identity = true;
      stream.respond(
        { ':status': 204, [versionHeader]: version },
        { endStream: true },
      );
      stream.resume();
      return;
    }
    const path = headers[':path'];
    const routeId =
      typeof path === 'string' && path.startsWith('/models/')
        ? path.slice(8)
        : '';
    const destination = routes.get(routeId);
    const call = decodeCall(headers[callHeader]);
    const attemptId = headers[attemptHeader];
    if (
      !ready() ||
      !current() ||
      headers[':method'] !== 'POST' ||
      !destination ||
      !call ||
      typeof attemptId !== 'string' ||
      !uuid.test(attemptId) ||
      active >= maxStreams
    ) {
      transportFailure(stream);
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    stream.once('aborted', abort);
    stream.once('close', abort);
    const isCurrent = () =>
      !stream.closed &&
      !stream.destroyed &&
      !controller.signal.aborted &&
      ready() &&
      current();
    active++;
    void (async () => {
      try {
        const response = await handle({
          routeId,
          destination,
          attemptId,
          call,
          headers: incomingHeaders(headers),
          body: bodyOf(
            Readable.from(stream, {
              objectMode: false,
              highWaterMark: stream.readableHighWaterMark,
            }),
          ),
          signal: controller.signal,
          isCurrent,
        });
        if (!isCurrent()) {
          await response.body?.cancel();
          transportFailure(stream, constants.NGHTTP2_CANCEL);
          return;
        }
        const encoding = response.headers.get('content-encoding');
        if (
          !response.ok ||
          (encoding && encoding.toLowerCase() !== 'identity')
        ) {
          const status =
            response.status >= 400 && response.status <= 599
              ? response.status
              : 503;
          await response.body?.cancel();
          if (!stream.closed && !stream.destroyed) {
            stream.respond({ ':status': status, 'content-type': 'text/plain' });
            stream.end('Model request unavailable');
            stream.resume();
          }
          return;
        }
        stream.respond({
          ':status': response.status,
          ...businessHeaders(response.headers),
        });
        if (response.body)
          await pipeline(
            Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
            stream,
          );
        else stream.end();
      } catch {
        transportFailure(stream, constants.NGHTTP2_INTERNAL_ERROR);
      } finally {
        active--;
      }
    })();
  });
  return {
    get ready() {
      return ready();
    },
    get closed() {
      return session.closed || session.destroyed;
    },
    close,
  };
}

export function openModelCarrier(socket: Duplex, generation: string) {
  const session = connect('http://' + authority, {
    ...limits,
    createConnection: () => socket,
  });
  managed(session);
  const lifetime = new AbortController();
  session.once('close', () => lifetime.abort());
  let active = 0;
  const protocol = {
    ':authority': authority,
    ':scheme': 'http',
    [generationHeader]: generation,
    [versionHeader]: version,
  };
  const handshakeSignal = AbortSignal.any([
    lifetime.signal,
    AbortSignal.timeout(5000),
  ]);
  const ready = Promise.all([
    once(session, 'remoteSettings', { signal: handshakeSignal }),
    once(session, 'localSettings', { signal: handshakeSignal }),
  ]).then(async () => {
    const probe = session.request(
      { ...protocol, ':method': 'GET', ':path': '/ready' },
      { endStream: true },
    );
    probe.on('error', () => {});
    try {
      const [headers] = await once(probe, 'response', {
        signal: handshakeSignal,
      });
      if (headers[':status'] !== 204 || headers[versionHeader] !== version)
        throw unavailable();
    } finally {
      probe.resume();
    }
  });
  void ready.catch(() => session.destroy());
  return {
    ready,
    close: () => session.destroy(),
    async fetch(route: string, call: ModelCarrierCall, request: Request) {
      try {
        await ready;
      } catch {
        throw unavailable();
      }
      request.signal.throwIfAborted();
      if (
        session.destroyed ||
        session.closed ||
        active >= maxStreams ||
        request.method !== 'POST' ||
        !routeKey.test(route)
      )
        throw unavailable();
      const headers = new Headers(request.headers);
      headers.set('accept-encoding', 'identity');
      return new Promise<Response>((resolve, reject) => {
        const fail = () => reject(unavailable());
        const stream = session.request(
          {
            ...protocol,
            ...businessHeaders(headers),
            ':method': 'POST',
            ':path': '/models/' + route,
            [callHeader]: Buffer.from(JSON.stringify(call)).toString(
              'base64url',
            ),
            [attemptHeader]: randomUUID(),
          },
          { endStream: request.body === null },
        );
        active++;
        const abort = () => {
          transportFailure(stream, constants.NGHTTP2_CANCEL);
          fail();
        };
        stream.setTimeout(idleMs, abort);
        stream.on('error', fail);
        stream.once('close', () => {
          active--;
          request.signal.removeEventListener('abort', abort);
          fail();
        });
        request.signal.addEventListener('abort', abort, { once: true });
        stream.once('response', (remote) => {
          const status = remote[':status'];
          if (
            typeof status !== 'number' ||
            status < 200 ||
            status > 599 ||
            redirects.has(status)
          ) {
            abort();
            return;
          }
          if (empty.has(status)) stream.resume();
          resolve(
            new Response(empty.has(status) ? null : bodyOf(stream), {
              status,
              headers: incomingHeaders(remote),
            }),
          );
        });
        if (request.body)
          void pipeline(
            Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>),
            stream,
          ).catch(abort);
      });
    },
  };
}
