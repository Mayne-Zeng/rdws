import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const openAi = '/openai/v1/chat/completions';
const files = '/deepseek/v1/files';
const messages = '/deepseek/v1/messages';
const fileId = 'file-egress-fixture';
const pngSha256 =
  '999f1d1527ee7e79266f16add5430fff76b1225d742464a5b1ff1f02971bb8ee';

type Model = { marker: string; finish: string; text: string; failure?: string };
type Observation = {
  pid: number;
  port: number;
  direct: string;
  directModel: Model;
  pi?: Model;
  deepseek?: Model;
  closed?: string;
  afterClose?: Model;
};
type RequestRecord = { method: string; path: string; id?: string };

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function requestLoopback(
  url: string,
  options: Pick<RequestOptions, 'method' | 'headers'> = {},
  body?: Buffer,
) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      url,
      { ...options, agent: false, signal: AbortSignal.timeout(3000) },
      resolve,
    );
    request.once('error', reject);
    request.end(body);
  });
}

function close(server: Server) {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

test.skipIf(process.platform !== 'darwin')(
  'locked Native uses a confined model relay and cannot reach a supplier directly',
  async () => {
    const require = createRequire(
      new URL('../../dsh/package.json', import.meta.url),
    );
    const locked = require('./upstream/manifest.json');
    const packagePath = require.resolve('@deepseek-ai/dsh/package.json');
    const native = require(packagePath);
    const root = await mkdtemp(join(await realpath(tmpdir()), 'rdws-egress-'));
    const servers: Server[] = [];
    const forwarded: RequestRecord[] = [];
    const received: (RequestRecord & {
      model?: string;
      marker?: string;
      fileId?: string;
      mediaType?: string;
      sha256?: string;
    })[] = [];
    const faults: string[] = [];
    const observations: Observation[] = [];
    const relayWork = new Set<Promise<void>>();
    const closedBy: number[] = [];

    async function listen(handler: Parameters<typeof createServer>[1]) {
      const server = createServer(handler).listen(0, '127.0.0.1');
      servers.push(server);
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      return { server, port, origin: `http://127.0.0.1:${port}` };
    }

    try {
      expect(native.version).toBe(locked.version);
      const supplier = await listen(async (request, response) => {
        try {
          const path = request.url!;
          const record = {
            method: request.method!,
            path,
            id: request.headers['x-rdws-fixture-attempt'] as string | undefined,
          };
          const body = await readBody(request);
          if (path === files) {
            const form = await new Request('http://127.0.0.1' + files, {
              method: 'POST',
              headers: { 'content-type': request.headers['content-type']! },
              body: new Uint8Array(body),
            }).formData();
            const file = form.get('file');
            if (!(file instanceof File))
              throw new Error('Expected multipart file');
            received.push({
              ...record,
              mediaType: file.type,
              sha256: createHash('sha256')
                .update(Buffer.from(await file.arrayBuffer()))
                .digest('hex'),
            });
            response.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                id: fileId,
                type: 'file',
                size_bytes: file.size,
                created_at: new Date().toISOString(),
                filename: 'fixture.png',
                mime_type: 'image/png',
              }),
            );
            return;
          }

          const input = JSON.parse(body.toString());
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          if (path === messages) {
            const parts = input.messages.flatMap(
              (message: {
                content: {
                  type: string;
                  text?: string;
                  source?: { file_id?: string };
                }[];
              }) => message.content,
            );
            received.push({
              ...record,
              model: input.model,
              marker: parts.find(
                (part: { type: string }) => part.type === 'text',
              )?.text,
              fileId: parts.find(
                (part: { type: string }) => part.type === 'image',
              )?.source?.file_id,
            });
            const events = [
              {
                type: 'message_start',
                message: {
                  id: 'fixture-messages',
                  model: input.model,
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
                delta: { type: 'text_delta', text: 'Messages reply' },
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
          const marker = input.messages.find(
            (message: { role: string }) => message.role === 'user',
          )?.content;
          received.push({
            ...record,
            model: input.model,
            marker: typeof marker === 'string' ? marker : marker?.[0]?.text,
          });
          const completion = {
            id: 'fixture-completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
          };
          for (const choice of [
            {
              index: 0,
              delta: { role: 'assistant', content: 'PiAi reply' },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: 'stop' },
          ])
            response.write(
              `data: ${JSON.stringify({ ...completion, choices: [choice] })}\n\n`,
            );
          response.end('data: [DONE]\n\n');
        } catch (error) {
          faults.push(String(error));
          response.destroy();
        }
      });
      const relay = await listen((request, response) => {
        const path = request.url!;
        if (
          request.method !== 'POST' ||
          ![openAi, files, messages].includes(path)
        ) {
          response.writeHead(404).end();
          return;
        }
        const id = randomUUID();
        forwarded.push({ method: request.method, path, id });
        const work = (async () => {
          try {
            const upstream = await requestLoopback(
              supplier.origin + path,
              {
                method: 'POST',
                headers: {
                  'content-type': request.headers['content-type']!,
                  'x-rdws-fixture-attempt': id,
                },
              },
              await readBody(request),
            );
            response.writeHead(upstream.statusCode!, {
              'content-type': upstream.headers['content-type']!,
            });
            response.end(await readBody(upstream));
          } catch (error) {
            faults.push(String(error));
            response.destroy();
          }
        })();
        relayWork.add(work);
        void work.then(() => relayWork.delete(work));
      });
      const callback = await listen(async (request, response) => {
        try {
          if (request.method !== 'POST')
            throw new Error('Unexpected fixture method');
          const data = JSON.parse((await readBody(request)).toString());
          switch (request.url) {
            case '/finish':
              observations.push(data);
              break;
            case '/fail':
              faults.push(data.message);
              break;
            case '/close-relay':
              closedBy.push(data.pid);
              await close(relay.server);
              await Promise.all(relayWork);
              break;
            default:
              throw new Error('Unexpected fixture callback');
          }
          response.writeHead(204).end();
        } catch (error) {
          faults.push(String(error));
          response.writeHead(500).end();
        }
      });

      async function run(allowDirect: boolean) {
        const home = join(root, allowDirect ? 'control' : 'confined');
        const profile = join(home, 'profiles', 'rdws');
        const credentials = join(home, '.credentials.yaml');
        await mkdir(profile, { recursive: true, mode: 0o700 });
        await writeFile(
          credentials,
          JSON.stringify({
            version: 1,
            refs: { FIXTURE_MODEL: 'synthetic-egress-test' },
          }),
          { mode: 0o600 },
        );
        await writeFile(
          join(profile, 'package.json'),
          JSON.stringify({
            private: true,
            dsh: {
              profile: {
                bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
              },
            },
          }),
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
            { id: 'credentials', config: { path: credentials } },
            {
              id: 'llm-pi-ai',
              config: {
                providers: {
                  'fixture-relay': provider(
                    relay.origin + '/openai/v1',
                    'relay-model',
                  ),
                  'fixture-direct': provider(
                    supplier.origin + '/openai/v1',
                    'direct-model',
                  ),
                },
              },
            },
            {
              id: 'llm-deepseek',
              config: {
                apiKeyEnv: 'FIXTURE_MODEL',
                baseURL: relay.origin + '/deepseek/v1',
                models: [
                  { id: 'fixture-vision', inputModalities: ['text', 'image'] },
                ],
              },
            },
            {
              id: 'agent-default-model',
              config: { provider: 'fixture-relay', model: 'relay-model' },
            },
            { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
            {
              id: 'web-runtime',
              config: {
                openBrowser: false,
                printUrl: false,
                surfaceContext: false,
              },
            },
            ...[
              'session-title-llm',
              'desktop-product-telemetry',
              'product-analytics',
              'harness-dev-context',
            ].map((id) => ({ id, disabled: true })),
            {
              insert: [
                {
                  id: 'egress-fixture',
                  name: fileURLToPath(
                    new URL(
                      '../fixtures/native-egress-confinement.mjs',
                      import.meta.url,
                    ),
                  ),
                  config: {
                    allowDirect,
                    relay: relay.origin,
                    supplier: supplier.origin,
                    callback: callback.origin,
                  },
                },
              ],
            },
          ]),
          { mode: 0o600 },
        );
        const ports = [
          callback.port,
          relay.port,
          ...(allowDirect ? [supplier.port] : []),
        ];
        const policy = [
          '(version 1)',
          '(allow default)',
          '(deny network*)',
          '(allow network-bind (local ip "localhost:*"))',
          '(allow network-inbound (local ip "localhost:*"))',
          ...ports.map(
            (port) =>
              `(allow network-outbound (remote ip "localhost:${port}"))`,
          ),
        ].join('\n');
        const before = observations.length;
        const child = spawn(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            policy,
            process.execPath,
            '--import',
            require.resolve('tsx/esm'),
            join(dirname(packagePath), native.bin.dsh),
            '--profile',
            'rdws',
            '--patch',
            fileURLToPath(
              new URL(
                '../../dsh/profiles/probe-policy.cordis.yml',
                import.meta.url,
              ),
            ),
            '--patch',
            fileURLToPath(
              new URL(
                '../../dsh/profiles/web-readonly.cordis.yml',
                import.meta.url,
              ),
            ),
          ],
          {
            cwd: home,
            env: {
              PATH: '/usr/bin:/bin',
              HOME: home,
              DSH_HOME: home,
              TMPDIR: home,
              DSH_PRIMARY_RUNTIME: '',
              DSH_PERMISSION_MODE: 'read-only',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        const exited = new Promise<void>((resolve) =>
          child.once('close', () => resolve()),
        );
        child.once('error', (error) => faults.push(String(error)));
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 2400)
            stderr += String(chunk).slice(0, 2400 - stderr.length);
        });
        try {
          await expect
            .poll(
              () =>
                observations.length > before ||
                faults.length > 0 ||
                child.exitCode !== null ||
                child.signalCode !== null,
              { timeout: 11_000 },
            )
            .toBe(true);
          expect(faults).toEqual([]);
          const evidence = observations[before];
          expect(evidence, `Native did not report: ${stderr}`).toBeDefined();
          expect(evidence!.pid).toBe(child.pid);
          const web = await requestLoopback(
            `http://127.0.0.1:${evidence!.port}/__fixture_egress_ready`,
          );
          expect(web.statusCode).toBe(200);
          expect((await readBody(web)).toString()).toBe(String(child.pid));
          return evidence!;
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await exited;
        }
      }

      const control = await run(true);
      expect(control.direct).toBe('connected');
      expect(control.directModel).toMatchObject({
        finish: 'stop',
        text: 'PiAi reply',
      });
      expect(received).toEqual([
        {
          method: 'POST',
          path: openAi,
          model: 'direct-model',
          marker: control.directModel.marker,
        },
      ]);
      expect(forwarded).toEqual([]);

      const confined = await run(false);
      expect(confined.pid).not.toBe(control.pid);
      expect(confined.direct).toBe('EPERM');
      expect(confined.directModel).toMatchObject({
        marker: control.directModel.marker,
        finish: 'error',
        text: '',
        failure: expect.stringContaining('EPERM'),
      });
      expect(confined.pi).toMatchObject({ finish: 'stop', text: 'PiAi reply' });
      expect(confined.deepseek).toMatchObject({
        finish: 'stop',
        text: 'Messages reply',
      });
      expect(closedBy).toEqual([confined.pid]);
      expect(confined.closed).toBe('ECONNREFUSED');
      expect(confined.afterClose).toMatchObject({
        finish: 'error',
        text: '',
        failure: expect.stringContaining('ECONNREFUSED'),
      });
      expect(relay.server.listening).toBe(false);
      expect(relayWork.size).toBe(0);
      expect(forwarded.map(({ method, path }) => ({ method, path }))).toEqual(
        [openAi, files, messages].map((path) => ({ method: 'POST', path })),
      );
      expect(new Set(forwarded.map(({ id }) => id)).size).toBe(3);
      expect(received.slice(1)).toEqual([
        { ...forwarded[0], model: 'relay-model', marker: confined.pi?.marker },
        { ...forwarded[1], mediaType: 'image/png', sha256: pngSha256 },
        {
          ...forwarded[2],
          model: 'fixture-vision',
          marker: confined.deepseek?.marker,
          fileId,
        },
      ]);
    } finally {
      try {
        await Promise.all(servers.map(close));
      } finally {
        await Promise.all(relayWork);
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30_000,
);
