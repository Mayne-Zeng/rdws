import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { nativeLoopbackRequest } from '../../dsh/host/loopback-http.ts';
import type { ModelCarrierRequest } from '../../dsh/bridge/model-carrier.ts';

const readyWrite = vi.hoisted(() => ({
  after: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const write: typeof fs.writeFile = async (...args) => {
    await fs.writeFile(...args);
    if (typeof args[0] === 'string') readyWrite.after?.(args[0]);
  };
  return { ...fs, writeFile: write };
});

const credential = 'synthetic-carrier-credential';
const deniedDetails = 'synthetic-private-diagnostic-and-path';
const fileId = 'synthetic-carrier-file';

test.skipIf(process.platform !== 'darwin')(
  'the locked Native carries model streams and Files through the inherited Host channel',
  async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-model-carrier-'),
    );
    const config = join(root, 'configuration');
    const profile = join(config, 'profiles', 'rdws');
    const lifecycle = new AbortController();
    const calls: {
      routeId: string;
      attemptId: string;
      call: ModelCarrierRequest['call'];
    }[] = [];
    const arrivals: {
      path: string;
      attempt: unknown;
      source?: string;
      sha256?: string;
      file?: string;
      credential: boolean;
    }[] = [];
    const errors: string[] = [];
    let cancelObserved = false,
      canceledSocket = false;
    let releasePi!: () => void;
    const piTail = new Promise<void>((resolve) => {
      releasePi = resolve;
    });
    let releaseFiles!: () => void;
    const sharedFiles = new Promise<void>((resolve) => {
      releaseFiles = resolve;
    });
    const supplier = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const path = request.url!;
        const source = String(request.headers['x-fixture-session']);
        const arrival = {
          path,
          source,
          attempt: request.headers['x-fixture-attempt'],
          credential: [
            request.headers.authorization,
            request.headers['x-api-key'],
          ].some(
            (value) => typeof value === 'string' && value.includes(credential),
          ),
        };
        if (path === '/ds/v1/files') {
          const form = await new Request('http://127.0.0.1' + path, {
            method: 'POST',
            headers: { 'content-type': request.headers['content-type']! },
            body: new Uint8Array(bytes),
          }).formData();
          const file = form.get('file');
          if (!(file instanceof File)) throw new Error('Expected test upload');
          arrivals.push({
            ...arrival,
            sha256: createHash('sha256')
              .update(Buffer.from(await file.arrayBuffer()))
              .digest('hex'),
          });
          if (source === 'shared-first') await sharedFiles;
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: fileId,
              type: 'file',
              size_bytes: file.size,
              created_at: new Date().toISOString(),
              filename: 'test.png',
              mime_type: 'image/png',
            }),
          );
          return;
        }
        const body = JSON.parse(bytes.toString());
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (path === '/ds/v1/messages') {
          const image = body.messages
            .flatMap((item: { content: unknown[] }) => item.content)
            .find((part: { type?: string }) => part.type === 'image')?.source;
          arrivals.push({
            ...arrival,
            file: image?.type === 'base64' ? 'inline' : image?.file_id,
          });
          const events = [
            {
              type: 'message_start',
              message: {
                id: 'fixture-messages',
                model: body.model,
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
              delta: { type: 'text_delta', text: 'Messages carrier reply' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ];
          response.end(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(''),
          );
          return;
        }
        arrivals.push(arrival);
        const envelope = {
          id: 'fixture-pi',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
        };
        response.write(
          `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: 'PiAi carrier reply' }, finish_reason: null }] })}\n\n`,
        );
        if (source === 'cancel') {
          response.once('close', () => {
            canceledSocket = true;
          });
          return;
        }
        if (source === 'pi') await piTail;
        response.end(
          `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      } catch (error) {
        errors.push(String(error));
        response.destroy();
      }
    });
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const port = (supplier.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const routes = {
      pi: `${origin}/pi/v1/chat/completions`,
      files: `${origin}/ds/v1/files`,
      messages: `${origin}/ds/v1/messages`,
    };
    const host = new NativeWebHost(
      root,
      config,
      'carrier-fixture',
      undefined,
      'mediated',
      {
        routes,
        signal: lifecycle.signal,
        async handle(request) {
          calls.push({
            routeId: request.routeId,
            attemptId: request.attemptId,
            call: request.call,
          });
          const source = request.call.sessionId;
          if (source === 'denied') throw new Error(deniedDetails);
          if (
            source === 'deepseek-denied' ||
            (source === 'deepseek-inline' && request.routeId === 'files')
          )
            return new Response(deniedDetails, { status: 403 });
          if (source === 'cancel')
            request.signal.addEventListener(
              'abort',
              () => {
                cancelObserved = true;
              },
              { once: true },
            );
          const headers = new Headers(request.headers);
          headers.set('x-fixture-session', source ?? '');
          headers.set('x-fixture-attempt', request.attemptId);
          const destination = new URL(request.destination);
          return nativeLoopbackRequest(origin, destination.pathname, {
            method: 'POST',
            headers,
            body: request.body,
            signal: request.signal,
          });
        },
      },
    );
    const probe = async (suffix = '') => {
      const response = await host.fetch(
        '/__fixture_model_' + (suffix || 'carrier'),
        { purpose: 'service', operation: 'fixture' },
        { signal: AbortSignal.timeout(15000) },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({ version: 1, refs: { FIXTURE_MODEL: credential } }),
        { mode: 0o600 },
      );
      const provider = (baseURL: string, id: string) => ({
        api: 'openai-completions',
        apiKeyEnv: 'FIXTURE_MODEL',
        baseURL,
        models: [{ id }],
        retryPolicy: { mode: 'normal', maxRetries: 0 },
      });
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                'rdws-glm': provider(`${origin}/pi/v1`, 'fixture-pi'),
                'fixture-unapproved': provider(
                  `${origin}/outside/v1`,
                  'fixture-other',
                ),
              },
            },
          },
          {
            id: 'llm-deepseek',
            config: {
              apiKeyEnv: 'FIXTURE_MODEL',
              baseURL: `${origin}/ds/v1`,
              models: [
                { id: 'fixture-vision', inputModalities: ['text', 'image'] },
              ],
              retryPolicy: { mode: 'normal', maxRetries: 0 },
            },
          },
          { id: 'session-title-llm', disabled: true },
          {
            insert: [
              {
                id: 'test-model-carrier',
                name: fileURLToPath(
                  new URL(
                    '../fixtures/native-model-carrier.mjs',
                    import.meta.url,
                  ),
                ),
                config: { port },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      await host.start();
      const ready = JSON.parse(
        await readFile(
          join(
            root,
            'runtime',
            'instances',
            'project-carrier-fixture.ready.json',
          ),
          'utf8',
        ),
      );
      const running = probe('carrier?shared=1').catch((error) => error);
      try {
        await expect
          .poll(async () => (await probe('progress')).firstChunk)
          .toBe(true);
      } finally {
        releasePi();
      }
      try {
        await expect
          .poll(() =>
            arrivals.some(
              ({ source, path }) =>
                source === 'shared-first' && path === '/ds/v1/files',
            ),
          )
          .toBe(true);
        await probe('waiter');
        await expect
          .poll(async () => (await probe('progress')).firstWaiterAborted)
          .toBe(true);
      } finally {
        releaseFiles();
      }
      const results = await running;
      expect(results).toMatchObject({
        pid: ready.pid,
        tcp: expect.stringMatching(/^(EPERM|EACCES)$/),
        outside: { finish: 'error' },
        denied: { finish: 'error' },
        pi: { finish: 'stop', text: 'PiAi carrier reply' },
        deepseek: { finish: 'stop', text: 'Messages carrier reply' },
        firstWaiter: { finish: 'aborted' },
        allDenied: { finish: 'error' },
        fallback: { finish: 'stop' },
        canceled: { finish: 'aborted', text: 'PiAi carrier reply' },
        concurrent: { finish: 'stop', text: 'PiAi carrier reply' },
      });
      await expect.poll(() => cancelObserved && canceledSocket).toBe(true);
      expect(
        calls.find(({ call }) => call.sessionId === 'concurrent')?.call.purpose,
      ).toBe('session-title');
      for (const source of ['deepseek-inline', 'deepseek-denied']) {
        const attempts = calls.filter(({ call }) => call.sessionId === source);
        expect(attempts.map(({ routeId }) => routeId)).toEqual([
          'files',
          'messages',
        ]);
        expect(new Set(attempts.map(({ call }) => call.id)).size).toBe(1);
        expect(new Set(attempts.map(({ attemptId }) => attemptId)).size).toBe(
          2,
        );
      }
      expect(arrivals).toHaveLength(6);
      expect(arrivals.every(({ credential }) => credential)).toBe(true);
      expect(
        arrivals.every(({ attempt }) =>
          calls.some(({ attemptId }) => attemptId === attempt),
        ),
      ).toBe(true);
      expect(arrivals.map(({ source }) => source)).not.toContain(
        'deepseek-denied',
      );
      expect(arrivals.map(({ path }) => path)).not.toContain(
        '/outside/v1/chat/completions',
      );
      expect(
        arrivals.filter(({ source }) => source === 'deepseek-inline'),
      ).toMatchObject([{ path: '/ds/v1/messages', file: 'inline' }]);
      expect(
        arrivals.filter(
          ({ source }) => source === 'shared-first' || source === 'deepseek',
        ),
      ).toMatchObject([
        {
          source: 'shared-first',
          path: '/ds/v1/files',
          sha256:
            '999f1d1527ee7e79266f16add5430fff76b1225d742464a5b1ff1f02971bb8ee',
        },
        { path: '/ds/v1/messages', source: 'deepseek', file: fileId },
      ]);
      expect(errors).toEqual([]);
      const before = calls.length;
      lifecycle.abort();
      const closed = await probe();
      expect(closed).toMatchObject({
        pid: ready.pid,
        pi: { finish: 'error' },
        deepseek: { finish: 'error' },
      });
      expect(calls).toHaveLength(before);
      expect(arrivals).toHaveLength(6);
      expect(JSON.stringify(results)).not.toContain(deniedDetails);
      expect(JSON.stringify(closed)).not.toContain(credential);

      let earlyCalls = 0;
      const startupSignal = new AbortController();
      const early = new NativeWebHost(
        root,
        config,
        'carrier-interrupted',
        undefined,
        'mediated',
        {
          routes,
          signal: startupSignal.signal,
          async handle() {
            earlyCalls++;
            throw new Error('Unexpected early callback');
          },
        },
      );
      try {
        const starting = expect(early.start()).rejects.toThrow(
          'Native web startup failed or timed out',
        );
        startupSignal.abort();
        await starting;
        const instances = join(root, 'runtime', 'instances');
        await expect(
          readFile(join(instances, 'project-carrier-interrupted.ready.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          readFile(join(instances, 'project-carrier-interrupted.lock')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(earlyCalls).toBe(0);
      } finally {
        await early.close();
      }

      const publishingSignal = new AbortController();
      const publishing = new NativeWebHost(
        root,
        config,
        'carrier-publishing',
        undefined,
        'mediated',
        {
          routes,
          signal: publishingSignal.signal,
          async handle() {
            earlyCalls++;
            throw new Error('Unexpected publishing callback');
          },
        },
      );
      let preparedPath: string | undefined;
      const published = join(
        root,
        'runtime',
        'instances',
        'project-carrier-publishing.ready.json',
      );
      readyWrite.after = (path) => {
        if (path.startsWith(published + '.')) {
          preparedPath = path;
          publishingSignal.abort();
        }
      };
      try {
        await expect(publishing.start()).rejects.toThrow(
          'Native web startup failed or timed out',
        );
        expect(preparedPath).toBeDefined();
        for (const path of [
          preparedPath!,
          published,
          published.replace('.ready.json', '.lock'),
        ])
          await expect(readFile(path)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        expect(earlyCalls).toBe(0);
      } finally {
        readyWrite.after = undefined;
        await publishing.close();
      }

      const runtime = join(root, 'runtime');
      for (const file of await readdir(runtime, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!file.isFile()) continue;
        const bytes = await readFile(join(file.parentPath, file.name));
        for (const marker of [
          credential,
          deniedDetails,
          'Synthetic carrier pi',
        ])
          expect(bytes.includes(marker)).toBe(false);
      }
    } finally {
      releasePi();
      releaseFiles();
      await host.close();
      await new Promise<void>((resolve) => {
        supplier.close(() => resolve());
        supplier.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('the BFF requires ownership and will not substitute an injected mediated Host', () => {
  const options = { databaseUrl: '', secret: '', origin: 'http://127.0.0.1:1' };
  const mode = process.env.RDWS_NATIVE_MODEL_EGRESS;
  try {
    process.env.RDWS_NATIVE_MODEL_EGRESS = 'mediated';
    expect(() => buildApp(options)).toThrow(
      process.platform === 'darwin'
        ? 'requires an owned runtime'
        : 'requires macOS',
    );
    if (process.platform === 'darwin') {
      delete process.env.RDWS_NATIVE_MODEL_EGRESS;
      const host = new NativeWebHost(
        '/tmp/rdws-carrier-disabled',
        undefined,
        'poc',
        undefined,
        'mediated',
        {
          routes: { fixture: 'http://127.0.0.1:1/v1/chat/completions' },
          async handle() {
            throw new Error('Unexpected carrier call');
          },
        },
      );
      expect(() => buildApp({ ...options, nativeHost: host })).toThrow(
        'Native Host model egress does not match BFF configuration',
      );
      process.env.RDWS_NATIVE_MODEL_EGRESS = 'mediated';
      expect(() =>
        buildApp({
          ...options,
          nativeHost: host,
          authorityTicket: 'c'.repeat(64),
          mainModelPolicy: {
            projectId: 'poc',
            provider: 'rdws-glm',
            model: 'fixture',
            destination: 'https://127.0.0.1:1/v1/chat/completions',
          },
        }),
      ).toThrow('requires an owned runtime');
    }
  } finally {
    if (mode === undefined) delete process.env.RDWS_NATIVE_MODEL_EGRESS;
    else process.env.RDWS_NATIVE_MODEL_EGRESS = mode;
  }
});
