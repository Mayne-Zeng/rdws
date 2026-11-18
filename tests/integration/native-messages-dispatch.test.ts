import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';

type Dispatch = {
  id: string;
  call: string;
  path: string;
  imageSource?: string;
  fileId?: string;
  allowed: boolean;
};

function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('native Messages and image uploads cross separate transport boundaries', async () => {
  const model = 'fixture-vision';
  const project = 'messages-probe';
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rdws-messages-'));
  const config = join(root, 'config');
  const profile = join(config, 'profiles', 'rdws');
  const host = new NativeWebHost(root, config, project);
  const begin = latch();
  const firstDispatch = latch<Omit<Dispatch, 'allowed'>>();
  const fileDecision = latch();
  let authorized = true;
  const dispatches: Dispatch[] = [];
  const received: {
    path: string;
    method: string | undefined;
    id: string | string[] | undefined;
    bytes: number;
    body?: unknown;
  }[] = [];
  const milestones: string[] = [];
  const extensions: Record<string, unknown>[] = [];
  const outcomes: Record<string, unknown>[] = [];
  const faults: unknown[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (path === '/v1/files') {
        received.push({
          path,
          method: request.method,
          id: request.headers['x-rdws-fixture-dispatch'],
          bytes: bytes.length,
        });
        const form = await new Request('http://127.0.0.1/v1/files', {
          method: 'POST',
          headers: { 'content-type': request.headers['content-type']! },
          body: new Uint8Array(bytes),
        }).formData();
        const image = form.get('file');
        if (
          !(image instanceof File) ||
          image.type !== 'image/png' ||
          !image.size
        )
          throw new Error('Expected a real PNG multipart upload');
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'fixture-file',
            type: 'file',
            size_bytes: image.size,
            created_at: new Date().toISOString(),
            filename: image.name,
            mime_type: image.type,
          }),
        );
        return;
      }
      const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (path === '/v1/messages') {
        received.push({
          path,
          method: request.method,
          id: request.headers['x-rdws-fixture-dispatch'],
          bytes: bytes.length,
          body,
        });
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              model,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Fixture reply' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ];
        response
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(''),
          );
        return;
      }
      if (path === '/begin') await begin.promise;
      else if (path === '/dispatch') {
        const intent = body as Omit<Dispatch, 'allowed'>;
        milestones.push(`${intent.call} ${intent.path}`);
        if (intent.call === 'revoked' && intent.path === '/v1/files') {
          firstDispatch.resolve(intent);
          await fileDecision.promise;
        }
        const allowed =
          intent.call === 'extension-error' ||
          (intent.call === 'revoked' && authorized);
        dispatches.push({ ...intent, allowed });
        if (!allowed) {
          response.writeHead(403).end();
          return;
        }
      } else if (path === '/extension') {
        milestones.push(`${body.id} extension`);
        extensions.push(body);
        if (body.id === 'extension-error') {
          response.writeHead(403).end();
          return;
        }
      } else if (path === '/settled') outcomes.push(body);
      else if (path === '/fixture-error') faults.push(body);
      else throw new Error('Unexpected fixture request');
      response.writeHead(204).end();
    } catch (error) {
      faults.push(String(error));
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { FIXTURE_MODEL: 'fixture-only' } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                apiKeyEnv: 'FIXTURE_MODEL',
                baseURL: origin + '/v1',
                models: [{ id: 'unused-fixture-model' }],
              },
            },
          },
        },
        {
          id: 'llm-deepseek',
          config: {
            apiKeyEnv: 'FIXTURE_MODEL',
            baseURL: origin + '/v1',
            models: [{ id: model, inputModalities: ['text', 'image'] }],
          },
        },
        { id: 'session-title-llm', disabled: true },
        {
          insert: [
            {
              id: 'test-native-messages-dispatch',
              name: fileURLToPath(
                new URL(
                  '../fixtures/native-messages-dispatch.mjs',
                  import.meta.url,
                ),
              ),
              config: { origin, model },
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );
    await host.start();
    begin.resolve();
    expect(
      await Promise.race([
        firstDispatch.promise,
        new Promise<void>((resolve) => setTimeout(resolve, 4000).unref()),
      ]),
      JSON.stringify(faults),
    ).toMatchObject({ call: 'revoked', path: '/v1/files' });
    expect(received).toEqual([]);
    expect(extensions).toEqual([]);
    authorized = false;
    fileDecision.resolve();
    await expect
      .poll(() => outcomes.length === 3 || faults.length > 0, {
        timeout: 5000,
      })
      .toBe(true);
    expect(faults).toEqual([]);
    expect(milestones).toEqual([
      'revoked /v1/files',
      'revoked extension',
      'revoked /v1/messages',
      'extension-error /v1/files',
      'extension-error extension',
      'extension-error /v1/messages',
      'cached-file extension',
      'cached-file /v1/messages',
    ]);
    expect(extensions).toEqual([
      {
        id: 'revoked',
        sessionId: 'fixture-revoked',
        model,
        imageSource: 'base64',
      },
      {
        id: 'extension-error',
        sessionId: 'fixture-extension-error',
        model,
        imageSource: 'file',
      },
      {
        id: 'cached-file',
        sessionId: 'fixture-cached-file',
        model,
        imageSource: 'file',
      },
    ]);
    expect(outcomes).toEqual([
      { id: 'revoked', finish: 'error', text: '' },
      { id: 'extension-error', finish: 'stop', text: 'Fixture reply' },
      { id: 'cached-file', finish: 'error', text: '' },
    ]);
    const allowed = dispatches.filter((item) => item.allowed);
    expect(allowed.map(({ call, path }) => ({ call, path }))).toEqual([
      { call: 'extension-error', path: '/v1/files' },
      { call: 'extension-error', path: '/v1/messages' },
    ]);
    expect(new Set(dispatches.map(({ id }) => id)).size).toBe(5);
    expect(
      dispatches
        .filter(({ path }) => path === '/v1/messages')
        .map(({ call, imageSource, fileId }) => ({
          call,
          imageSource,
          fileId,
        })),
    ).toEqual([
      { call: 'revoked', imageSource: 'base64' },
      { call: 'extension-error', imageSource: 'file', fileId: 'fixture-file' },
      { call: 'cached-file', imageSource: 'file', fileId: 'fixture-file' },
    ]);
    expect(
      received.map(({ path, method, id }) => ({ path, method, id })),
    ).toEqual(allowed.map(({ path, id }) => ({ path, method: 'POST', id })));
    expect(received[0]!.bytes).toBeGreaterThan(0);
    expect(received[1]!.body).toMatchObject({
      model,
      messages: [
        expect.objectContaining({
          content: expect.arrayContaining([
            {
              type: 'image',
              source: { type: 'file', file_id: 'fixture-file' },
            },
          ]),
        }),
      ],
    });
    expect(received[1]!.body).not.toHaveProperty('rdws_fixture_only');
  } finally {
    begin.resolve();
    fileDecision.resolve();
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
