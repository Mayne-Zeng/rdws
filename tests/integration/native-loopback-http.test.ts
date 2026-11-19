import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import { expect, test, vi } from 'vitest';
import { nativeLoopbackRequest } from '../../dsh/host/loopback-http.ts';

async function fixture(handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${port}` };
}

function stop(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

test('Native loopback preserves request data, response streaming and empty statuses', async () => {
  let finish!: () => void;
  const seen: {
    body: string;
    encoding: string | undefined;
    fixture: string | undefined;
  }[] = [];
  const { server, origin } = await fixture(async (request, response) => {
    if (request.url !== '/exchange') {
      response.writeHead(Number(request.url?.slice(1)));
      response.end();
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({
      body: Buffer.concat(chunks).toString(),
      encoding: request.headers['accept-encoding'],
      fixture: request.headers['x-fixture'] as string | undefined,
    });
    finish = () => response.end('second');
    response.writeHead(201, { 'x-fixture-reply': 'available' });
    response.write('first-');
  });
  try {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('first-'));
        controller.enqueue(encoder.encode('upload'));
        controller.close();
      },
    });
    const response = await nativeLoopbackRequest(origin, '/exchange', {
      method: 'POST',
      body,
      headers: new Headers({
        'x-fixture': 'synthetic',
        'accept-encoding': 'gzip',
      }),
    });
    expect(seen).toEqual([
      { body: 'first-upload', encoding: 'identity', fixture: 'synthetic' },
    ]);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-fixture-reply')).toBe('available');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'first-',
    );
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'second',
    );
    expect((await reader.read()).done).toBe(true);

    for (const status of [204, 205, 304]) {
      const empty = await nativeLoopbackRequest(origin, '/' + status, {});
      expect(empty.status).toBe(status);
      expect(empty.body).toBeNull();
    }
    const head = await nativeLoopbackRequest(origin, '/200', {
      method: 'HEAD',
    });
    expect(head.body).toBeNull();
    for (const status of [300, 305, 409]) {
      const ordinary = await nativeLoopbackRequest(origin, '/' + status, {});
      expect(ordinary.status).toBe(status);
      await ordinary.arrayBuffer();
    }
  } finally {
    await stop(server);
  }
});

test('invalid destinations and rejected responses cannot keep a Native loopback connection', async () => {
  const received: string[] = [];
  const tickets: (string | string[] | undefined)[] = [];
  const closed = new Set<string>();
  let foreignHits = 0;
  const destination = await fixture((_request, response) => {
    foreignHits++;
    response.end('unexpected destination');
  });
  const { server, origin } = await fixture((request, response) => {
    const path = request.url!;
    received.push(path);
    tickets.push(request.headers['x-rdws-delegation']);
    request.socket.once('close', () => closed.add(path));
    if (path === '/encoded')
      response.writeHead(200, { 'content-encoding': 'gzip' }).write('fixture');
    else if (path === '/upgrade')
      response
        .writeHead(101, { connection: 'Upgrade', upgrade: 'fixture' })
        .end();
    else if (path === '/302-no-location')
      response.writeHead(302).write('fixture');
    else
      response
        .writeHead(Number(path.slice(1)), {
          location: destination.origin + '/redirected',
        })
        .write('fixture');
  });
  try {
    const other = new URL(destination.origin).host;
    const headers = { 'x-rdws-delegation': 'synthetic-loopback-ticket' };
    for (const path of [
      'extra-port',
      `//${other}/path`,
      `/\\${other}/path`,
      `//fixture@${other}/path`,
    ]) {
      await expect(
        nativeLoopbackRequest(origin, path, { headers }),
      ).rejects.toThrow('Invalid Native loopback target');
    }
    await expect(
      nativeLoopbackRequest(
        origin.replace('127.0.0.1', 'localhost'),
        '/200',
        {},
      ),
    ).rejects.toThrow('Invalid Native loopback target');
    expect(received).toEqual([]);
    const denied = [
      '/301',
      '/302',
      '/303',
      '/307',
      '/308',
      '/302-no-location',
      '/encoded',
      '/upgrade',
    ];
    for (const path of denied) {
      await expect(
        nativeLoopbackRequest(origin, path, {
          headers,
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow('Invalid Native loopback response');
    }
    await vi.waitFor(() =>
      expect([...closed].sort()).toEqual([...denied].sort()),
    );
    expect(received).toEqual(denied);
    expect(tickets).toEqual(denied.map(() => headers['x-rdws-delegation']));
    expect(foreignHits).toBe(0);
  } finally {
    await Promise.all([stop(server), stop(destination.server)]);
  }
});

test('canceling a response or failing an upload closes its Native socket', async () => {
  const closed = new Set<string>();
  let enterUpload!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    enterUpload = resolve;
  });
  const { server, origin } = await fixture((request, response) => {
    const path = request.url!;
    request.socket.once('close', () => closed.add(path));
    if (path === '/upload') request.once('data', enterUpload);
    else response.writeHead(200).write('partial');
  });
  try {
    const response = await nativeLoopbackRequest(origin, '/cancel', {});
    await response.body!.cancel();
    const controller = new AbortController();
    const canceled = await nativeLoopbackRequest(origin, '/abort', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(canceled.arrayBuffer()).rejects.toBeInstanceOf(Error);
    let failUpload!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        failUpload = stream;
        stream.enqueue(new TextEncoder().encode('fragment'));
      },
    });
    const upload = nativeLoopbackRequest(origin, '/upload', {
      method: 'POST',
      body,
    }).catch((error) => error);
    await uploaded;
    failUpload.error(new Error('Synthetic upload failure'));
    expect(await upload).toMatchObject({ message: 'Synthetic upload failure' });
    await vi.waitFor(() =>
      expect([...closed].sort()).toEqual(['/abort', '/cancel', '/upload']),
    );
  } finally {
    await stop(server);
  }
});
