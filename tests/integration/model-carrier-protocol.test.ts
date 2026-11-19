import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect as connectHttp2, type OutgoingHttpHeaders } from 'node:http2';
import { createConnection, createServer, type Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import {
  openModelCarrier,
  serveModelCarrier,
  snapshotModelRoutes,
} from '../../dsh/bridge/model-carrier.ts';

const authority = 'rdws-model-carrier.invalid';
const routes = snapshotModelRoutes({ files: 'http://127.0.0.1:1/v1/files' });
const message = () => ({
  id: randomUUID(),
  provider: 'fixture',
  model: 'fixture',
});
const input = (signal?: AbortSignal) =>
  new Request('http://127.0.0.1:1/v1/files', {
    method: 'POST',
    body: 'Synthetic input',
    signal,
  });

test('only the three V0 model endpoint families enter a route snapshot', () => {
  expect(() =>
    snapshotModelRoutes({ invalid: 'http://127.0.0.1:1/v1/models' }),
  ).toThrow('Invalid Native model route');
  for (const delimiter of ['?', '#'])
    expect(() =>
      snapshotModelRoutes({ files: 'http://127.0.0.1:1/v1/files' + delimiter }),
    ).toThrow('Invalid Native model route');
  expect([
    ...snapshotModelRoutes({
      chat: 'https://fixture.invalid/pi/v1/chat/completions',
      files: 'https://fixture.invalid/ds/v1/files',
      messages: 'https://fixture.invalid/ds/v1/messages',
    }).keys(),
  ]).toEqual(['chat', 'files', 'messages']);
});

async function endpoints() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const connected = once(listener, 'connection');
  const client = createConnection({
    host: '127.0.0.1',
    port: (listener.address() as { port: number }).port,
  });
  const [server] = (await connected) as [Socket];
  return {
    server,
    client,
    close: () => {
      server.destroy();
      client.destroy();
      listener.close();
    },
  };
}

test('a missing carrier handshake sends neither model headers nor body', async () => {
  const sockets = await endpoints();
  const bytes: Buffer[] = [];
  sockets.server.on('data', (chunk) => bytes.push(Buffer.from(chunk)));
  const client = openModelCarrier(sockets.client, 'generation');
  try {
    const request = new Request('http://127.0.0.1:1/v1/files', {
      method: 'POST',
      body: 'Synthetic pre-handshake model body',
      headers: { 'x-api-key': 'synthetic-pre-handshake-credential' },
    });
    const pending = client
      .fetch('files', message(), request)
      .catch((error) => error);
    await expect.poll(() => bytes.length).toBeGreaterThan(0);
    sockets.server.destroy();
    expect(await pending).toMatchObject({
      message: 'Native model carrier unavailable',
    });
    expect(
      Buffer.concat(bytes).includes('Synthetic pre-handshake model body'),
    ).toBe(false);
    expect(
      Buffer.concat(bytes).includes('synthetic-pre-handshake-credential'),
    ).toBe(false);
  } finally {
    client.close();
    sockets.close();
  }
});

test('the parent verifies its generation, ready Host, method and exact route before a model callback', async () => {
  const sockets = await endpoints();
  let current = false;
  const handler = vi.fn(async (request) => {
    const data = await new Response(request.body).text();
    return new Response(data);
  });
  const server = serveModelCarrier(
    sockets.server,
    'generation',
    routes,
    handler,
    () => current,
  );
  const peer = connectHttp2('http://' + authority, {
    createConnection: () => sockets.client,
    settings: { headerTableSize: 0 },
    maxDeflateDynamicTableSize: 0,
  });
  peer.on('error', () => {});
  const base = {
    ':scheme': 'http',
    ':authority': authority,
    'x-rdws-carrier-generation': 'generation',
    'x-rdws-carrier-version': '1',
  };
  const model = {
    ':method': 'POST',
    ':path': '/models/files',
    'x-rdws-carrier-call': Buffer.from(JSON.stringify(message())).toString(
      'base64url',
    ),
    'x-rdws-carrier-attempt': randomUUID(),
  };
  async function status(headers: OutgoingHttpHeaders) {
    const stream = peer.request({ ...base, ...headers }, { endStream: true });
    stream.resume();
    const [response] = await once(stream, 'response');
    await once(stream, 'close');
    return response[':status'];
  }
  try {
    await Promise.all([
      once(peer, 'remoteSettings'),
      once(peer, 'localSettings'),
    ]);
    await expect(
      status({
        ':method': 'GET',
        ':path': '/ready',
        'x-rdws-carrier-generation': 'old',
      }),
    ).rejects.toThrow();
    await expect(status(model)).rejects.toThrow();
    expect(server.ready).toBe(false);
    expect(await status({ ':method': 'GET', ':path': '/ready' })).toBe(204);
    expect(server.ready).toBe(true);
    await expect(status(model)).rejects.toThrow();
    current = true;
    for (const invalid of [
      { ':method': 'GET' },
      { ':method': 'DELETE' },
      { ':scheme': 'https' },
      { ':path': '/models/replacement' },
      { ':path': '/models/files?target=elsewhere' },
      { ':authority': 'another.invalid' },
      { host: 'another.invalid' },
      { 'x-rdws-carrier-attempt': ['old', 'new'] },
      { 'x-rdws-carrier-target': 'elsewhere' },
    ])
      await expect(status({ ...model, ...invalid })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(await status(model)).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      routeId: 'files',
      destination: routes.get('files'),
    });
    peer.goaway();
    await expect.poll(() => server.closed).toBe(true);
  } finally {
    peer.destroy();
    server.close();
    sockets.close();
  }
});

test('reading and canceling a model reply signals its callback and preserves a concurrent response', async () => {
  const sockets = await endpoints();
  let canceled = false;
  const server = serveModelCarrier(
    sockets.server,
    'generation',
    routes,
    async (request) => {
      await new Response(request.body).text();
      if (request.call.model !== 'held')
        return new Response('Neighbor completed');
      request.signal.addEventListener(
        'abort',
        () => {
          canceled = true;
        },
        { once: true },
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('First segment'));
          },
        }),
      );
    },
    () => true,
  );
  const client = openModelCarrier(sockets.client, 'generation');
  try {
    await client.ready;
    const held = await client.fetch(
      'files',
      { ...message(), model: 'held' },
      input(),
    );
    const reader = held.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'First segment',
    );
    const other = client.fetch('files', message(), input());
    await reader.cancel();
    await expect.poll(() => canceled).toBe(true);
    expect(await (await other).text()).toBe('Neighbor completed');
    server.close();
    await expect(client.fetch('files', message(), input())).rejects.toThrow(
      'Native model carrier unavailable',
    );
  } finally {
    client.close();
    server.close();
    sockets.close();
  }
});

test('headers nominated by Connection are dropped in both directions', async () => {
  const sockets = await endpoints();
  const handler = vi.fn(async (request) => {
    await new Response(request.body).text();
    return new Response('Expected reply', {
      headers: {
        connection: 'x-fixture-reply-hop',
        'x-fixture-reply-hop': 'drop',
        'x-fixture-reply': 'keep',
      },
    });
  });
  const server = serveModelCarrier(
    sockets.server,
    'generation',
    routes,
    handler,
    () => true,
  );
  const client = openModelCarrier(sockets.client, 'generation');
  try {
    const response = await client.fetch(
      'files',
      message(),
      new Request('http://127.0.0.1:1/v1/files', {
        method: 'POST',
        body: 'Synthetic input',
        headers: {
          connection: 'x-fixture-request-hop',
          'x-fixture-request-hop': 'drop',
          'x-fixture-request': 'keep',
        },
      }),
    );
    expect(await response.text()).toBe('Expected reply');
    const received = handler.mock.calls[0]?.[0].headers;
    expect(received?.get('x-fixture-request')).toBe('keep');
    expect(received?.has('x-fixture-request-hop')).toBe(false);
    expect(response.headers.get('x-fixture-reply')).toBe('keep');
    expect(response.headers.has('x-fixture-reply-hop')).toBe(false);
  } finally {
    client.close();
    server.close();
    sockets.close();
  }
});

test('canceled model callbacks retain their slots until actual settlement', async () => {
  const sockets = await endpoints();
  let active = 0,
    aborted = 0,
    discarded = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = serveModelCarrier(
    sockets.server,
    'generation',
    routes,
    async (request) => {
      if (request.call.model !== 'held') return new Response('New request');
      active++;
      request.signal.addEventListener(
        'abort',
        () => {
          aborted++;
        },
        { once: true },
      );
      await wait;
      return new Response(
        new ReadableStream({
          cancel() {
            discarded++;
          },
        }),
      );
    },
    () => true,
  );
  const client = openModelCarrier(sockets.client, 'generation');
  try {
    await client.ready;
    const controls = Array.from({ length: 16 }, () => new AbortController());
    const pending = controls.map(({ signal }) =>
      client
        .fetch('files', { ...message(), model: 'held' }, input(signal))
        .catch((error) => error),
    );
    await expect.poll(() => active).toBe(16);
    for (const controller of controls) controller.abort();
    const rejected = await Promise.all(pending);
    expect(rejected.every((error) => error instanceof Error)).toBe(true);
    await expect.poll(() => aborted).toBe(16);
    await expect(client.fetch('files', message(), input())).rejects.toThrow(
      'Native model carrier unavailable',
    );
    release();
    await expect.poll(() => discarded).toBe(16);
    expect(await (await client.fetch('files', message(), input())).text()).toBe(
      'New request',
    );
  } finally {
    release();
    client.close();
    server.close();
    sockets.close();
  }
});
