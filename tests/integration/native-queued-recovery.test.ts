import { randomUUID } from 'node:crypto';
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
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { loadEnvironment, runtimeHome } from '@rdws/runtime-config';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

loadEnvironment('test');

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function readJournal(root: string, sessionId: string) {
  const base = join(root, 'runtime', 'dsh', 'project-poc', 'sessions');
  const matches = (await readdir(base, { recursive: true })).filter((entry) => {
    const parts = entry.split(sep);
    return (
      parts.at(-2) === sessionId &&
      /^session(?:\.v[1-9]\d*)?\.jsonl\.zstd$/.test(parts.at(-1)!)
    );
  });
  expect(matches).toHaveLength(1);
  const bytes = await readFile(join(base, matches[0]!));
  const rows = [];
  let text = '';
  for (let offset = 0; offset < bytes.length;) {
    const result = zstdDecompressSync(bytes.subarray(offset), {
      info: true,
    }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.engine.bytesWritten <= 0)
      throw new Error('Journal decoder made no progress');
    text += result.buffer.toString();
    offset += result.engine.bytesWritten;
  }
  for (const line of text.trim().split('\n')) rows.push(JSON.parse(line));
  return {
    bytes,
    header: rows[0],
    events: rows.filter((row) => Number.isSafeInteger(row.seq)),
  };
}

test.each([
  { mode: 'queue', queue: 'next-turn', replayBeforeSending: true },
  { mode: 'steer', queue: 'next-step', replayBeforeSending: false },
] as const)(
  'cold $queue recovery retains the input and lets the first newly authorized send finish',
  async ({ mode, queue, replayBeforeSending }) => {
    const databaseUrl = process.env.DATABASE_URL!;
    const pool = new Pool({
      connectionString: process.env.DATABASE_MIGRATION_URL,
    });
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-queued-recovery-'),
    );
    const config = join(root, 'config');
    const profile = join(config, 'profiles', 'rdws');
    const requirementId = randomUUID();
    const oldRequestId = randomUUID();
    const oldText = 'Synthetic unclaimed input from previous generation';
    const newText = 'Synthetic explicit send after recovery';
    const origin = process.env.RDWS_ORIGIN!;
    const target = latch<string>();
    const armed = latch<string>();
    const checkpoint = latch<{
      sessionId: string;
      requestId: string;
      messageId: string;
    }>();
    const errors: unknown[] = [];
    const provider: { model: string; body: string }[] = [];
    const supplier = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        const input = JSON.parse(body);
        if (request.url === '/target') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ sessionId: await target.promise }));
        } else if (request.url === '/armed') {
          armed.resolve(input.sessionId);
          response.writeHead(204).end();
        } else if (request.url === '/checkpoint') {
          checkpoint.resolve(input);
          response.writeHead(204).end();
        } else if (request.url === '/fixture-error') {
          errors.push(input);
          response.writeHead(204).end();
        } else if (request.url === '/v1/chat/completions') {
          provider.push({ model: input.model, body });
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const choice of [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Fixture reply' },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: 'stop' },
          ]) {
            response.write(
              `data: ${JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: input.model,
                choices: [choice],
              })}\n\n`,
            );
          }
          response.end('data: [DONE]\n\n');
        } else response.writeHead(404).end();
      } catch (error) {
        errors.push(String(error));
        response.writeHead(500).end();
      }
    });
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const supplierOrigin = `http://127.0.0.1:${(supplier.address() as { port: number }).port}`;
    let app: ReturnType<typeof buildApp> | undefined;
    let testDatabase = false;
    async function start(hold: boolean) {
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
                  baseURL: supplierOrigin + '/v1',
                  models: [{ id: 'fixture-main' }, { id: 'fixture-title' }],
                },
              },
            },
          },
          { id: 'session-title-llm', disabled: true },
          {
            insert: [
              {
                id: 'test-native-queued-title',
                name: '@deepseek-ai/dsh-session-title-first-prompt-llm',
                config: {
                  provider: 'rdws-glm',
                  model: 'fixture-title',
                  targetWords: 5,
                  targetCjkCharacters: 10,
                  maxInputBytes: 4096,
                  maxOutputTokens: 64,
                  timeoutMs: 2000,
                },
              },
              ...(hold
                ? [
                    {
                      id: 'test-native-queued-checkpoint',
                      name: fileURLToPath(
                        new URL(
                          '../fixtures/native-queued-checkpoint.mjs',
                          import.meta.url,
                        ),
                      ),
                      config: {
                        origin: supplierOrigin,
                        requestId: oldRequestId,
                        queue,
                      },
                    },
                  ]
                : []),
            ],
          },
        ]),
        { mode: 0o600 },
      );
      const host = new NativeWebHost(root, config, 'poc');
      app = buildApp({
        databaseUrl,
        origin,
        secret: process.env.BETTER_AUTH_SECRET!,
        nativeHost: host,
        repositoryHome: join(root, 'repository-unconfigured'),
      });
      await app.ready();
      expect(app.server.address()).toBeNull();
      return { app, host };
    }
    try {
      const identitySql = 'select current_database() db, session_user role';
      expect((await pool.query(identitySql)).rows[0]).toEqual({
        db: 'rdws_test',
        role: 'rdws_test_migrator',
      });
      const application = new Pool({ connectionString: databaseUrl });
      try {
        expect((await application.query(identitySql)).rows[0]).toEqual({
          db: 'rdws_test',
          role: 'rdws_test_app',
        });
      } finally {
        await application.end();
      }
      testDatabase = true;
      const accounts = JSON.parse(
        await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
      ) as { username: string; password: string }[];
      const manager = accounts.find(
        (account) => account.username === 'manager',
      );
      expect(manager).toBeDefined();
      async function login(
        instance: ReturnType<typeof buildApp>,
        remoteAddress: string,
      ) {
        const response = await instance.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin },
          remoteAddress,
          payload: manager,
        });
        expect(response.statusCode).toBe(200);
        return {
          userId: response.json<{ user: { id: string } }>().user.id,
          cookie: response.cookies
            .map(({ name, value }) => `${name}=${value}`)
            .join('; '),
        };
      }
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: 'fixture-only' },
        }),
        { mode: 0o600 },
      );
      const first = await start(true);
      const oldLogin = await login(first.app, '192.0.2.10');
      await pool.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Queued recovery fixture','Fixture context via inherited channel','',$2,$2)",
        [requirementId, oldLogin.userId],
      );
      await pool.query(
        "insert into requirement_participant(requirement_id,user_id,role) values($1,$2,'requirement_manager')",
        [requirementId, oldLogin.userId],
      );
      const created = await first.app.inject({
        method: 'POST',
        url: `/api/requirements/${requirementId}/sessions`,
        headers: { origin, cookie: oldLogin.cookie },
        payload: { commandId: randomUUID() },
      });
      expect(created.statusCode, created.body).toBe(200);
      const { sessionId } = created.json<{ sessionId: string }>();
      target.resolve(sessionId);
      async function client(
        instance: ReturnType<typeof buildApp>,
        cookie: string,
      ) {
        const binding = await bootstrapNative(instance, cookie, requirementId);
        return async (
          action: string,
          request: Record<string, unknown>,
          expectedStatus = 200,
        ) => {
          const response = await instance.inject({
            method: 'POST',
            url: `/api/dsh/${requirementId}/native/api/session/${action}`,
            headers: {
              origin,
              cookie,
              'x-rdws-client-generation': randomUUID(),
              'x-rdws-native-login': binding,
            },
            payload: {
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/' + action,
              payload: { args: { request } },
            },
          });
          expect(response.statusCode, response.body).toBe(expectedStatus);
          if (expectedStatus !== 200) return response.statusCode;
          const result = response.json().result;
          expect(result.ok, JSON.stringify(result.error)).toBe(true);
          return result.value;
        };
      }
      const old = await client(first.app, oldLogin.cookie);
      const input = (
        requestId: string,
        text: string,
        mode: 'queue' | 'steer' = 'queue',
      ) => ({
        sessionId,
        requestId,
        mode,
        content: [{ type: 'text', text }],
      });
      expect(
        await Promise.race([
          armed.promise,
          new Promise<void>((resolve) => setTimeout(resolve, 4500).unref()),
        ]),
        JSON.stringify(errors),
      ).toBe(sessionId);
      expect(await old('prompt', input(oldRequestId, oldText, mode))).toEqual({
        accepted: true,
      });
      const marker = await Promise.race([
        checkpoint.promise,
        new Promise<void>((resolve) => setTimeout(resolve, 4500).unref()),
      ]);
      expect(marker, JSON.stringify(errors)).toMatchObject({
        sessionId,
        requestId: oldRequestId,
        messageId: expect.any(String),
      });
      const saved = await readJournal(root, sessionId);
      expect(saved.header.id).toBe(sessionId);
      const insertion = saved.events.find(
        ({ type, data }) =>
          type === 'agent/inbox/spliced' &&
          data.inserted?.some(
            (message: { id: string }) => message.id === marker?.messageId,
          ),
      );
      expect(insertion).toMatchObject({
        seq: expect.any(Number),
        data: {
          target: queue,
          inserted: [
            {
              id: marker?.messageId,
              source: { rpcId: oldRequestId },
              content: [{ type: 'text', text: oldText }],
            },
          ],
        },
      });
      expect(saved.events.some(({ type }) => type === 'turn/start')).toBe(
        false,
      );
      expect(provider).toEqual([]);
      const ready = JSON.parse(
        await readFile(
          join(root, 'runtime/instances/project-poc.ready.json'),
          'utf8',
        ),
      );
      const lock = JSON.parse(
        await readFile(
          join(root, 'runtime/instances/project-poc.lock'),
          'utf8',
        ),
      );
      expect(ready.generation).toBe(first.host.contextGeneration);
      expect(lock.pid).toBe(process.pid);
      expect(lock.childPid).toBe(ready.pid);
      expect(
        Number.isSafeInteger(ready.pid) &&
          ready.pid > 1 &&
          ready.pid !== process.pid,
      ).toBe(true);
      process.kill(ready.pid, 'SIGKILL');
      await first.app.close();
      expect(() => process.kill(ready.pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      expect(
        (await readJournal(root, sessionId)).bytes.equals(saved.bytes),
      ).toBe(true);

      const second = await start(false);
      expect(second.host.contextGeneration).not.toBe(
        first.host.contextGeneration,
      );
      const freshLogin = await login(second.app, '192.0.2.11');
      expect(freshLogin.userId).toBe(oldLogin.userId);
      expect(await observedLogin(second.app, freshLogin.cookie)).not.toBe(
        await observedLogin(second.app, oldLogin.cookie),
      );
      const fresh = await client(second.app, freshLogin.cookie);
      const oldInsertions = (
        events: Awaited<ReturnType<typeof readJournal>>['events'],
      ) =>
        events.filter(
          ({ type, data }) =>
            type === 'agent/inbox/spliced' &&
            data.inserted?.some(
              (message: { source?: { rpcId?: string } }) =>
                message.source?.rpcId === oldRequestId,
            ),
        );
      await fresh('events', { address: { kind: 'session', sessionId } });
      expect(
        (await readJournal(root, sessionId)).bytes.equals(saved.bytes),
      ).toBe(true);
      expect(provider).toEqual([]);
      if (replayBeforeSending) {
        expect(
          await fresh('prompt', input(oldRequestId, oldText, mode)),
        ).toEqual({ accepted: true });
        const replayed = await readJournal(root, sessionId);
        expect(replayed.events.slice(0, saved.events.length)).toEqual(
          saved.events,
        );
        expect(replayed.events.some(({ type }) => type === 'turn/start')).toBe(
          false,
        );
        expect(oldInsertions(replayed.events)).toHaveLength(1);
        expect(
          replayed.events.some(
            ({ type, data }) =>
              type === 'agent/inbox/spliced' && data.outcome === 'canceled',
          ),
        ).toBe(false);
      } else {
        const revoked = await client(second.app, oldLogin.cookie);
        const logout = await second.app.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: { origin, cookie: oldLogin.cookie },
          payload: {},
        });
        expect(logout.statusCode).toBe(200);
        expect(
          await revoked(
            'prompt',
            input(randomUUID(), 'Revoked fixture input'),
            401,
          ),
        ).toBe(401);
        expect(
          (await readJournal(root, sessionId)).bytes.equals(saved.bytes),
        ).toBe(true);
      }
      expect(provider).toEqual([]);
      const freshRequest = randomUUID();
      expect(await fresh('prompt', input(freshRequest, newText))).toEqual({
        accepted: true,
      });
      await expect
        .poll(
          async () => {
            const { events } = await readJournal(root, sessionId);
            return events
              .filter(({ type }) => type === 'turn/end')
              .map(({ data }) => data.reason.kind);
          },
          { timeout: 5000 },
        )
        .toEqual(['completed']);
      await expect
        .poll(() => provider.map(({ model }) => model).sort(), {
          timeout: 5500,
        })
        .toEqual(['fixture-main', 'fixture-title']);
      expect(
        provider.every(
          ({ body }) => body.includes(newText) && !body.includes(oldText),
        ),
      ).toBe(true);
      expect(
        provider.find(({ model }) => model === 'fixture-main')?.body,
      ).toContain('Fixture context via inherited channel');
      for (const url of [
        '/internal/rdws/context',
        '/internal/rdws/context/poc',
      ]) {
        const response = await second.app.inject({
          method: 'POST',
          url,
          headers: { origin },
          payload: {},
        });
        expect(response.statusCode).toBe(404);
      }
      const final = await readJournal(root, sessionId);
      expect(final.events.slice(0, saved.events.length)).toEqual(saved.events);
      expect(
        final.bytes.subarray(0, saved.bytes.length).equals(saved.bytes),
      ).toBe(true);
      const pending: string[] = [];
      const canceled: number[] = [];
      for (const event of final.events) {
        if (event.type !== 'agent/inbox/spliced' || event.data.target !== queue)
          continue;
        const { start, removedCount = 0, inserted, outcome } = event.data;
        const removed = pending.splice(
          start,
          removedCount,
          ...inserted.map((message: { id: string }) => message.id),
        );
        if (outcome === 'canceled') {
          expect(removed).toEqual([marker?.messageId]);
          canceled.push(event.seq);
        }
      }
      expect(canceled).toHaveLength(1);
      const freshInsertion = final.events.find(
        ({ type, data }) =>
          type === 'agent/inbox/spliced' &&
          data.inserted?.some(
            (message: { source?: { rpcId?: string } }) =>
              message.source?.rpcId === freshRequest,
          ),
      );
      expect(canceled[0]).toBeGreaterThan(freshInsertion?.seq);
      expect(canceled[0]).toBeLessThan(
        final.events.find(({ type }) => type === 'turn/start')?.seq,
      );
      expect(
        final.events.some(
          ({ type, data }) =>
            type === 'user/message' && data.source?.rpcId === oldRequestId,
        ),
      ).toBe(false);
      await second.app.close();
      const stopped = await readJournal(root, sessionId);
      const third = await start(false);
      expect(third.host.contextGeneration).not.toBe(
        second.host.contextGeneration,
      );
      const replay = await client(third.app, freshLogin.cookie);
      expect(
        await replay('prompt', input(oldRequestId, oldText, mode)),
      ).toEqual({ accepted: true });
      const replayed = await readJournal(root, sessionId);
      expect(replayed.events.slice(0, stopped.events.length)).toEqual(
        stopped.events,
      );
      expect(
        replayed.events
          .slice(stopped.events.length)
          .filter(
            ({ type, data }) =>
              type === 'agent/inbox/spliced' && data.inserted?.length,
          ),
      ).toEqual([]);
      expect(oldInsertions(replayed.events)).toHaveLength(1);
      expect(
        replayed.events.filter(({ type }) => type === 'turn/start'),
      ).toHaveLength(1);
      expect(provider).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      target.resolve('');
      await app?.close();
      await new Promise<void>((resolve) => supplier.close(() => resolve()));
      if (testDatabase) {
        await pool.query(
          'delete from session_operation where requirement_id=$1',
          [requirementId],
        );
        await pool.query('delete from native_session where requirement_id=$1', [
          requirementId,
        ]);
        await pool.query(
          'delete from requirement_participant where requirement_id=$1',
          [requirementId],
        );
        await pool.query('delete from requirement where id=$1', [
          requirementId,
        ]);
      }
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
