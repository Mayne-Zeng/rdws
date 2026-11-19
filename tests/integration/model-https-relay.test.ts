import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { RequestListener } from 'node:http';
import { createServer } from 'node:https';
import {
  createConnection,
  createServer as tcpServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createModelHttpsRelay, type ModelCarrierRequest } from '@rdws/dsh/web';
import {
  firstWriteLimit,
  modelSocketDescriptor,
  submitModelPrefix,
} from '../../dsh/host/model-wire.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

type Certificate = Awaited<ReturnType<typeof modelTlsCertificate>>;
const authorization = 'Bearer synthetic-request-auth-marker';
const modelBody = '{"prompt":"synthetic-request-body-marker"}';
const modelPath = '/v1/chat/completions';
const errorMessage = 'Model HTTPS transport unavailable';
let root: string;
let certificate: Certificate;
let wrongSan: Certificate;

beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  root = await mkdtemp(join(tmpdir(), 'rdws-model-https-'));
  const other = join(root, 'wrong');
  await mkdir(other, { mode: 0o700 });
  [certificate, wrongSan] = await Promise.all([
    modelTlsCertificate(root),
    modelTlsCertificate(other, '127.0.0.2'),
  ]);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function supplier(
  handle: RequestListener,
  keys = certificate,
  version: 'TLSv1.2' | 'TLSv1.3' = 'TLSv1.3',
) {
  const listener = createServer(
    { ...keys, minVersion: version, maxVersion: version },
    handle,
  );
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  return {
    listener,
    port,
    destination: `https://127.0.0.1:${port}${modelPath}`,
    close() {
      listener.closeAllConnections();
      return new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

async function ciphertextTap(target: Awaited<ReturnType<typeof supplier>>) {
  const sockets = new Set<Socket>();
  let established = false;
  let sourceClosed = false;
  const backlog: Buffer[] = [];
  let observed = 0;
  let release = () => {};
  const tlsReady = once(target.listener, 'secureConnection').then(() => {
    established = true;
  });
  const tap = tcpServer((source) => {
    const upstream = createConnection(target.port, '127.0.0.1');
    for (const peer of [source, upstream]) {
      sockets.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => sockets.delete(peer));
    }
    upstream.pipe(source);
    let hold = true;
    source.on('data', (bytes: Buffer) => {
      if (established) observed += bytes.length;
      if (established && hold) backlog.push(bytes);
      else upstream.write(bytes);
    });
    source.on('end', () => upstream.end());
    source.once('close', () => {
      sourceClosed = true;
    });
    release = () => {
      hold = false;
      for (const bytes of backlog) upstream.write(bytes);
      backlog.length = 0;
    };
  }).listen(0, '127.0.0.1');
  await once(tap, 'listening');
  return {
    destination: `https://127.0.0.1:${(tap.address() as { port: number }).port}${modelPath}`,
    tlsReady,
    received: () => observed,
    senderClosed: () => sourceClosed,
    release() {
      release();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => tap.close(() => resolve()));
    },
  };
}

function attempt(
  destination: string,
  payload = modelBody,
  signal = new AbortController().signal,
): ModelCarrierRequest {
  return {
    destination,
    routeId: 'fixture-pi',
    attemptId: randomUUID(),
    call: {
      id: randomUUID(),
      provider: 'fixture',
      model: 'main',
      bindingId: randomUUID(),
    },
    headers: new Headers({ authorization, 'content-type': 'application/json' }),
    body: new Response(payload).body!,
    signal,
    isCurrent: () => true,
  };
}

const allow = async (
  write: (validBefore: number) => ReturnType<typeof submitModelPrefix>,
) => ({ outcome: write(Date.now() + 5_000), accept429() {} });

test.skipIf(process.platform !== 'darwin')(
  'accepted first ciphertext precedes revocation and the same connection completes a 1 MiB request and SSE',
  async () => {
    let arrives = 0;
    let finished = 0;
    let receivedExactly = false;
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const payload = modelBody + ' '.repeat(1024 * 1024 - modelBody.length);
    const target = await supplier(async (incoming, response) => {
      arrives++;
      const received: Buffer[] = [];
      for await (const bytes of incoming) received.push(bytes);
      finished++;
      receivedExactly =
        incoming.headers.authorization === authorization &&
        incoming.url === modelPath &&
        Buffer.concat(received).toString() === payload;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      await tail;
      response.end('data: last\n\n');
    });
    const tap = await ciphertextTap(target);
    const relay = createModelHttpsRelay(tap.destination, certificate.cert);
    let prepared = false;
    let authorizeWrite!: () => void;
    let permitRemainder!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      authorizeWrite = resolve;
    });
    const remainder = new Promise<void>((resolve) => {
      permitRemainder = resolve;
    });
    const input = attempt(tap.destination, payload);
    try {
      const timeline: string[] = [];
      const operation = relay(input, async (write) => {
        await tap.tlsReady;
        prepared = true;
        await firstWrite;
        const result = await allow(write);
        expect(result.outcome).toBe('submitted');
        input.isCurrent = () => false;
        timeline.push('kernel-start', 'revoke');
        await remainder;
        return result;
      });
      void operation.catch(() => {});
      await expect.poll(() => prepared).toBe(true);
      expect(tap.received()).toBe(0);
      expect(arrives).toBe(0);
      authorizeWrite();
      await expect.poll(tap.received, { timeout: 3000 }).toBe(firstWriteLimit);
      expect(arrives).toBe(0);
      expect(timeline).toEqual(['kernel-start', 'revoke']);
      permitRemainder();
      tap.release();
      const response = await operation;
      const reader = response.body!.getReader();
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(
        'data: first\n\n',
      );
      releaseTail();
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(
        'data: last\n\n',
      );
      expect((await reader.read()).done).toBe(true);
      expect([arrives, finished, receivedExactly]).toEqual([1, 1, true]);
    } finally {
      releaseTail();
      authorizeWrite();
      permitRemainder();
      await Promise.all([tap.close(), target.close()]);
    }
  },
);

test
  .skipIf(process.platform !== 'darwin')
  .each(['revoked', 'expired', 'canceled'] as const)(
  'a prepared encrypted attempt cannot send after %s',
  async (cause) => {
    let requests = 0;
    const target = await supplier((_incoming, response) => {
      requests++;
      response.end();
    });
    const tap = await ciphertextTap(target);
    const relay = createModelHttpsRelay(tap.destination, certificate.cert);
    const abort = new AbortController();
    const input = attempt(tap.destination, modelBody, abort.signal);
    let entered = false;
    try {
      await expect(
        relay(input, async (write) => {
          await tap.tlsReady;
          entered = true;
          await setImmediate();
          expect(tap.received()).toBe(0);
          if (cause === 'revoked') input.isCurrent = () => false;
          if (cause === 'canceled') abort.abort();
          const outcome = write(
            cause === 'expired' ? Date.now() - 1 : Infinity,
          );
          expect(outcome).toBe('not-sent');
          if (cause === 'canceled') await new Promise<never>(() => {});
          return { outcome, accept429() {} };
        }),
      ).rejects.toThrow(errorMessage);
      expect(entered).toBe(true);
      await expect.poll(tap.senderClosed).toBe(true);
      expect(tap.received()).toBe(0);
      expect(requests).toBe(0);
    } finally {
      await Promise.all([tap.close(), target.close()]);
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'invalid identity, protocol, and route do not reach a model authorization or request',
  async () => {
    const received = vi.fn();
    const handler: RequestListener = (_incoming, response) => {
      received();
      response.end();
    };
    const wrong = await supplier(handler, wrongSan);
    const old = await supplier(handler, certificate, 'TLSv1.2');
    const write = vi.fn(allow);
    try {
      await expect(
        createModelHttpsRelay(wrong.destination, wrongSan.cert)(
          attempt(wrong.destination),
          write,
        ),
      ).rejects.toThrow(errorMessage);
      await expect(
        createModelHttpsRelay(old.destination, certificate.cert)(
          attempt(old.destination),
          write,
        ),
      ).rejects.toThrow(errorMessage);
      const relay = createModelHttpsRelay(old.destination, certificate.cert);
      const files = old.destination.replace(modelPath, '/v1/files');
      expect(() => createModelHttpsRelay(files, certificate.cert)).toThrow(
        errorMessage,
      );
      await expect(relay(attempt(files), write)).rejects.toThrow(errorMessage);
      expect(received).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await Promise.all([wrong.close(), old.close()]);
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'only a complete 429 releases retry, while truncated headers or bodies stay fenced',
  async () => {
    const retry = vi.fn();
    let visits = 0;
    const target = await supplier(async (incoming, response) => {
      for await (const _ of incoming) void _;
      visits++;
      if (visits === 1) {
        response.writeHead(429, { 'content-length': 4 });
        response.end('busy');
        return;
      }
      if (visits === 2) {
        response.writeHead(429, { 'content-length': 100 });
        response.end('short');
        return;
      }
      response.writeHead(200, { 'content-length': 100 });
      response.end('short');
    });
    const relay = createModelHttpsRelay(target.destination, certificate.cert);
    const authorize = async (write: Parameters<typeof allow>[0]) => ({
      ...(await allow(write)),
      accept429: retry,
    });
    try {
      expect((await relay(attempt(target.destination), authorize)).status).toBe(
        429,
      );
      expect(retry).toHaveBeenCalledOnce();
      await expect(
        relay(attempt(target.destination), authorize),
      ).rejects.toThrow(errorMessage);
      const partial = await relay(attempt(target.destination), authorize);
      await expect(partial.text()).rejects.toThrow(errorMessage);
      expect(retry).toHaveBeenCalledOnce();
      expect(visits).toBe(3);
    } finally {
      await target.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the preflight refuses oversized, instrumented and unsupported attempts before any connection',
  async () => {
    const handler = vi.fn<RequestListener>();
    const target = await supplier(handler);
    const relay = createModelHttpsRelay(target.destination, certificate.cert);
    const wire = vi.fn(allow);
    try {
      await expect(
        relay(attempt(target.destination, 'a'.repeat(1024 * 1024 + 1)), wire),
      ).rejects.toThrow(errorMessage);
      const observed = channel('http.client.request.created');
      const subscriber = vi.fn();
      observed.subscribe(subscriber);
      try {
        await expect(relay(attempt(target.destination), wire)).rejects.toThrow(
          errorMessage,
        );
      } finally {
        observed.unsubscribe(subscriber);
      }
      expect(subscriber).not.toHaveBeenCalled();
      const nodeOptions = process.env.NODE_OPTIONS;
      try {
        process.env.NODE_OPTIONS = '"--tls-keylog" /tmp/unused-fixture-keylog';
        await expect(relay(attempt(target.destination), wire)).rejects.toThrow(
          errorMessage,
        );
      } finally {
        if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = nodeOptions;
      }
      const version = Object.getOwnPropertyDescriptor(process, 'version')!;
      try {
        Object.defineProperty(process, 'version', {
          ...version,
          value: 'v24.19.0',
        });
        await expect(relay(attempt(target.destination), wire)).rejects.toThrow(
          errorMessage,
        );
      } finally {
        Object.defineProperty(process, 'version', version);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(wire).not.toHaveBeenCalled();
    } finally {
      await target.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'canceling a streaming response closes its TLS connection and leaves a neighbor stream usable',
  async () => {
    let visits = 0;
    let closed = false;
    const target = await supplier(async (incoming, response) => {
      for await (const _ of incoming) void _;
      if (++visits === 1) {
        incoming.socket.once('close', () => {
          closed = true;
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: waiting\n\n');
      } else {
        response.end('neighbor');
      }
    });
    try {
      const relay = createModelHttpsRelay(target.destination, certificate.cert);
      const first = await relay(attempt(target.destination), allow);
      const reader = first.body!.getReader();
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(
        'data: waiting\n\n',
      );
      const neighbor = relay(attempt(target.destination), allow);
      await reader.cancel();
      await expect.poll(() => closed).toBe(true);
      expect(await (await neighbor).text()).toBe('neighbor');
      expect(visits).toBe(2);
    } finally {
      await target.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'both request markers stay out of surfaced errors, process output and runtime artifacts',
  async () => {
    let visits = 0;
    const target = await supplier(async (incoming, response) => {
      for await (const _ of incoming) void _;
      if (++visits === 1) response.end('ok');
      else
        response.socket!.end(
          'Malformed HTTP response ' + authorization + ' ' + modelBody,
        );
    });
    const output: string[] = [];
    const collect = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(collect);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(collect);
    try {
      const relay = createModelHttpsRelay(target.destination, certificate.cert);
      expect(
        await (await relay(attempt(target.destination), allow)).text(),
      ).toBe('ok');
      await expect(
        relay(attempt(target.destination), async () => {
          throw new Error(authorization + ' ' + modelBody);
        }),
      ).rejects.toThrow(errorMessage);
      const failure = await relay(attempt(target.destination), allow).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ message: errorMessage });
      expect(JSON.stringify(failure)).toBe('{}');
      expect(visits).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await target.close();
    }
    for (const marker of [authorization, modelBody]) {
      expect(output.join('').includes(marker)).toBe(false);
      for (const file of await readdir(root, {
        withFileTypes: true,
        recursive: true,
      })) {
        if (file.isFile())
          expect(
            (await readFile(join(file.parentPath, file.name))).includes(marker),
          ).toBe(false);
      }
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'a TCP close cannot complete an HTTP response without explicit framing',
  async () => {
    let visits = 0;
    const openedRetry = vi.fn();
    const target = await supplier(async (request, response) => {
      for await (const _ of request) void _;
      const status = ++visits === 1 ? '429 Too Many Requests' : '200 OK';
      const socket = response.socket!;
      socket.write(
        'HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\nshort',
        () => socket.destroy(),
      );
    });
    try {
      const relay = createModelHttpsRelay(target.destination, certificate.cert);
      const authorize = async (write: Parameters<typeof allow>[0]) => ({
        ...(await allow(write)),
        accept429: openedRetry,
      });
      await expect(
        relay(attempt(target.destination), authorize),
      ).rejects.toThrow(errorMessage);
      await expect(
        relay(attempt(target.destination), authorize),
      ).rejects.toThrow(errorMessage);
      expect(visits).toBe(2);
      expect(openedRetry).not.toHaveBeenCalled();
    } finally {
      await target.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'HTTP performance observers do not see the request or reflected credentials',
  async () => {
    let authenticated = false;
    const target = await supplier(async (request, response) => {
      for await (const _ of request) void _;
      authenticated = request.headers.authorization === authorization;
      response.setHeader('x-fixture', authorization);
      response.end('ok');
    });
    const clientEntries: string[] = [];
    const observer = new PerformanceObserver((events) => {
      for (const entry of events.getEntriesByType('http'))
        if (entry.name === 'HttpClient') clientEntries.push(entry.name);
    });
    observer.observe({ entryTypes: ['http'] });
    try {
      const relay = createModelHttpsRelay(target.destination, certificate.cert);
      expect(
        await (await relay(attempt(target.destination), allow)).text(),
      ).toBe('ok');
      await setImmediate();
      expect(authenticated).toBe(true);
      expect(clientEntries).toEqual([]);
    } finally {
      observer.disconnect();
      await target.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the pinned nonblocking TCP adapter observes a real zero-write boundary under saturation',
  async () => {
    const listening = tcpServer().listen(0, '127.0.0.1');
    await once(listening, 'listening');
    const accept = once(listening, 'connection');
    const socket = createConnection(
      (listening.address() as { port: number }).port,
      '127.0.0.1',
    );
    await once(socket, 'connect');
    const [peer] = (await accept) as [Socket];
    try {
      const descriptor = modelSocketDescriptor(socket)!;
      expect(descriptor).toBeGreaterThan(2);
      let complete = 0;
      let blocked = false;
      let shortWrite = false;
      const payload = Buffer.alloc(firstWriteLimit - 1, 23);
      const expires = Date.now() + 10_000;
      for (let count = 0; count < 512; count++) {
        const outcome = submitModelPrefix(socket, descriptor, payload, expires);
        if (outcome === 'submitted') complete += payload.length;
        if (outcome === 'indeterminate') shortWrite = true;
        if (outcome === 'not-sent') {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      expect(socket.readyState).toBe('open');
      expect(Date.now()).toBeLessThan(expires);
      expect(complete).toBeGreaterThan(0);
      socket.end();
      let received = 0;
      for await (const bytes of peer) received += (bytes as Buffer).length;
      expect(received).toBeGreaterThanOrEqual(complete);
      if (shortWrite) expect(received).toBeGreaterThan(complete);
    } finally {
      socket.destroy();
      peer.destroy();
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
  },
);
