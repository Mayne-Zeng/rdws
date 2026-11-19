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
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from '@rdws/db';
import {
  createModelHttpsRelay,
  NativeWebHost,
  type ModelCarrierRequest,
} from '@rdws/dsh/web';
import { Pool } from 'pg';
import { expect, test } from 'vitest';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import { createProjectContextReader } from '../../apps/server/src/modules/native-projects.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { loadEnvironment } from '@rdws/runtime-config';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

test.skipIf(process.platform !== 'darwin')(
  'the locked Agent retries through fresh authority while independent streams cannot reuse its Note',
  async () => {
    loadEnvironment('test');
    const { db, pool } = connectDatabase(process.env.DATABASE_URL!);
    const fixtures = new Pool({
      connectionString: process.env.DATABASE_MIGRATION_URL,
    });
    const readContext = createProjectContextReader(createBusiness(db));
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-model-attempt-'),
    );
    const configuration = join(root, 'configuration');
    const profile = join(configuration, 'profiles', 'rdws');
    const requirementId = randomUUID();
    const authSessionId = randomUUID();
    const replyText = 'Authorized retry fixture reply';
    const provider = 'rdws-glm';
    const model = 'fixture-model';
    const path = '/v1/chat/completions';
    const keys = await modelTlsCertificate(root);
    const arrivals: {
      url?: string;
      headers: IncomingHttpHeaders;
      body: string;
    }[] = [];
    const supplier = createServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          arrivals.push({
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          });
          if (arrivals.length === 1) {
            response
              .writeHead(429, { 'content-type': 'application/json' })
              .end(
                JSON.stringify({ error: { message: 'Synthetic rate limit' } }),
              );
            return;
          }
          const frame = {
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
          };
          const frames = [
            {
              index: 0,
              delta: { role: 'assistant', content: replyText },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: 'stop' },
          ].map(
            (choice) =>
              `data: ${JSON.stringify({ ...frame, choices: [choice] })}\n\n`,
          );
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(frames.join('') + 'data: [DONE]\n\n');
        } catch {
          response.destroy();
        }
      },
    );
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const origin = `https://127.0.0.1:${(supplier.address() as { port: number }).port}`;
    const routes = { pi: origin + path };
    const relay = createModelHttpsRelay(routes.pi, keys.cert);
    const attempts: Pick<ModelCarrierRequest, 'attemptId' | 'call'>[] = [];
    const handedOff: string[] = [];
    const denied: string[] = [];
    const reads: string[][] = [];
    const selections: string[][] = [];
    const operations: string[] = [];
    const lifecycle = new AbortController();
    let onBoundAttempt: ((request: ModelCarrierRequest) => void) | undefined;
    let onWrite: (() => void) | undefined;
    let readFence: (() => Promise<void>) | undefined;
    let authorityProject = 'poc';
    const host = new NativeWebHost(
      root,
      configuration,
      authorityProject,
      undefined,
      'mediated',
      {
        routes,
        signal: lifecycle.signal,
        async handle(request): Promise<Response> {
          attempts.push({ attemptId: request.attemptId, call: request.call });
          if (request.call.bindingId) onBoundAttempt?.(request);
          try {
            return await relay(request, (write) =>
              runs.authorizeModelWireAttempt(request, (validBefore) => {
                const outcome = write(validBefore);
                if (outcome === 'submitted') {
                  handedOff.push(request.attemptId);
                  onWrite?.();
                }
                return outcome;
              }),
            );
          } catch (error) {
            denied.push(request.attemptId);
            throw error;
          }
        },
      },
    );
    const runs = new ContextRuns(
      host.contextGeneration,
      (token) => host.verifyContext(token),
      async (who, id, sessionId, relatedActors) => {
        const result = await readContext(
          authorityProject,
          who,
          id,
          sessionId,
          relatedActors,
        );
        reads.push([who.userId, who.authSessionId, id, sessionId]);
        await readFence?.();
        return result;
      },
      () => false,
      async (who, id, sessionId) => {
        selections.push([who.userId, who.authSessionId, id, sessionId]);
        return {
          provider,
          model,
          revision: 'active-revision',
          routes,
          isCurrent: () => true,
        };
      },
    );
    host.configureContext(async (input, token, reply) => {
      const result = await runs.handle(input, token, reply);
      operations.push(host.verifyContext(token)!.operation!);
      return result;
    });
    try {
      const {
        rows: [account],
      } = await fixtures.query<{ id: string; auth_epoch: number }>(
        "select id, auth_epoch from auth_user where username='lead' and active",
      );
      const userId = account!.id;
      await fixtures.query(
        "insert into auth_session(id, user_id, token, auth_epoch, expires_at) values ($1,$2,$3,$4,now()+interval '2 minutes')",
        [authSessionId, userId, randomUUID(), account!.auth_epoch],
      );
      await fixtures.query(
        "insert into requirement(id, project_id, title, description, acceptance, lead_id, created_by) values ($1,'poc','Model attempt fixture','Synthetic scope','Retry authorization',$2,$2)",
        [requirementId, userId],
      );
      await fixtures.query(
        "insert into requirement_participant(requirement_id, user_id, role) values ($1,$2,'developer')",
        [requirementId, userId],
      );
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: 'synthetic-attempt-fixture' },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                [provider]: {
                  api: 'openai-completions',
                  baseURL: origin + '/v1',
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: model }],
                  retryPolicy: {
                    mode: 'normal',
                    maxRetries: 1,
                    backoff: {
                      initialDelayMs: 35,
                      maxDelayMs: 35,
                      jitterRatio: 0,
                    },
                  },
                },
              },
            },
          },
          { id: 'session-title-llm', disabled: true },
          {
            insert: [
              {
                id: 'test-native-title-provider',
                name: '@deepseek-ai/dsh-session-title-first-prompt-llm',
                config: {
                  provider,
                  model,
                  targetWords: 5,
                  targetCjkCharacters: 10,
                  maxInputBytes: 4096,
                  maxOutputTokens: 64,
                  timeoutMs: 2000,
                },
              },
              {
                id: 'test-native-attempt-authority',
                name: fileURLToPath(
                  new URL(
                    '../fixtures/native-attempt-authority.mjs',
                    import.meta.url,
                  ),
                ),
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      await host.start();
      const workspace = await host.workspace(
        requirementId,
        'Model attempt fixture',
      );
      const identity = { userId, authSessionId, requirementId, ...workspace };
      async function rpc(method: string, request: object, ticket: string) {
        const response = await host.fetch(`/api/${method}`, ticket, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method,
            payload: { args: { request } },
          }),
        });
        expect(response.status).toBe(200);
        const { result } = await response.json();
        expect(result).toMatchObject({ ok: true });
        return result.value;
      }
      const { sessionId } = (await rpc(
        'session/create',
        { workspaceId: workspace.workspaceId },
        host.ticket({ ...identity, purpose: 'create' }),
      )) as { sessionId: string };
      await fixtures.query(
        'insert into native_session(id, requirement_id, owner_id) values ($1,$2,$3)',
        [sessionId, requirementId, userId],
      );
      const sessionGrant = {
        ...identity,
        purpose: 'browser' as const,
        readSessionIds: [sessionId],
        ownSessionIds: [sessionId],
      };
      async function send(text: string) {
        const ticket = host.ticket(sessionGrant);
        const requestId = randomUUID();
        const binding = runs.admit(
          identity,
          requirementId,
          sessionId,
          requestId,
          host.claims(ticket)!.nonce,
        );
        await host.control('run', { ...binding, authSessionId });
        expect(
          await rpc(
            'session/prompt',
            {
              sessionId,
              requestId,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            ticket,
          ),
        ).toMatchObject({ accepted: true });
      }
      await send('Authorize both attempts');
      const events = async () =>
        (
          await rpc(
            'session/events',
            {
              address: { kind: 'session', sessionId },
            },
            host.ticket(sessionGrant),
          )
        ).records as { event: { type: string; data: unknown } }[];
      await expect
        .poll(
          async () =>
            (await events()).some(({ event }) => event.type === 'turn/end'),
          { timeout: 8000 },
        )
        .toBe(true);
      await expect
        .poll(() =>
          attempts.some(({ call }) => call.purpose === 'session-title'),
        )
        .toBe(true);
      await expect
        .poll(() => operations.includes('model-step-release'))
        .toBe(true);
      const retained = await events();
      expect(retained.map(({ event }) => event.type)).toEqual(
        expect.arrayContaining(['llm/retry', 'llm/retry-started', 'step/end']),
      );
      expect(JSON.stringify(retained)).toContain(replyText);
      expect(JSON.stringify(retained)).toContain('rdws-context');
      const main = attempts.filter(({ call }) => call.bindingId !== undefined);
      expect(main).toHaveLength(2);
      const activeBinding = main[0]!.call.bindingId!;
      expect(main[0]!.call).toMatchObject({
        provider,
        model,
        sessionId,
        bindingId: activeBinding,
      });
      expect(main[1]!.call.bindingId).toBe(activeBinding);
      expect(main[0]!.attemptId).not.toBe(main[1]!.attemptId);
      expect(handedOff).toEqual(main.map(({ attemptId }) => attemptId));
      const independent = attempts.filter(
        ({ call }) => call.bindingId === undefined,
      );
      expect(independent.map(({ call }) => call.purpose)).toEqual(
        expect.arrayContaining([undefined, 'session-title']),
      );
      expect(denied).toEqual(
        expect.arrayContaining(independent.map(({ attemptId }) => attemptId)),
      );
      expect(reads).toEqual(
        Array.from({ length: 3 }, () => [
          userId,
          authSessionId,
          requirementId,
          sessionId,
        ]),
      );
      expect(selections).toEqual(reads);
      expect(arrivals.map(({ url }) => url)).toEqual([path, path]);
      for (const { body, headers } of arrivals) {
        expect(JSON.parse(body)).toMatchObject({ model });
        expect(
          Object.keys(headers).filter((name) =>
            name.startsWith('x-rdws-carrier-'),
          ),
        ).toEqual([]);
      }
      expect(JSON.stringify({ arrivals, retained })).not.toContain(
        activeBinding,
      );
      const firstTurnCount = attempts.length;
      onBoundAttempt = () => {
        authorityProject = 'unrelated-project';
      };
      await send('Reject the mismatched project during revalidation');
      await expect
        .poll(
          async () =>
            (await events()).filter(({ event }) => event.type === 'turn/end')
              .length,
        )
        .toBe(2);
      const mismatched = attempts
        .slice(firstTurnCount)
        .filter(({ call }) => call.bindingId !== undefined);
      expect(mismatched.length).toBeGreaterThan(0);
      expect(denied).toEqual(
        expect.arrayContaining(mismatched.map(({ attemptId }) => attemptId)),
      );
      expect(arrivals).toHaveLength(2);

      authorityProject = host.projectId;
      let revoked: ModelCarrierRequest | undefined;
      let resumeRevoked!: () => void;
      const revokeGate = new Promise<void>((resolve) => {
        resumeRevoked = resolve;
      });
      onBoundAttempt = (request) => {
        readFence = async () => {
          revoked = request;
          await revokeGate;
        };
      };
      try {
        await send('Prepare ciphertext before revoking the original run');
        await expect.poll(() => revoked?.isCurrent()).toBe(true);
        runs.revoke(authSessionId);
      } finally {
        resumeRevoked();
      }
      await expect.poll(() => denied.includes(revoked!.attemptId)).toBe(true);
      async function completedTurns() {
        return (await events()).filter(({ event }) => event.type === 'turn/end')
          .length;
      }
      await expect.poll(completedTurns).toBe(3);
      expect(arrivals).toHaveLength(2);

      onBoundAttempt = undefined;
      readFence = undefined;
      const priorReplies = JSON.stringify(await events()).split(
        replyText,
      ).length;
      let receivedBeforeRevoke = -1;
      onWrite = () => {
        onWrite = undefined;
        receivedBeforeRevoke = arrivals.length;
        runs.revoke(authSessionId);
      };
      await send('Revoke the original run after the actual first write');
      await expect.poll(completedTurns).toBe(4);
      expect(receivedBeforeRevoke).toBe(2);
      expect(arrivals).toHaveLength(3);
      expect(
        JSON.stringify(await events()).split(replyText).length,
      ).toBeGreaterThan(priorReplies);
      const alreadySubmitted = [...handedOff];

      let resumeRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        resumeRead = resolve;
      });
      let waiting: ModelCarrierRequest | undefined;
      onBoundAttempt = (request) => {
        readFence = async () => {
          waiting = request;
          await readGate;
        };
      };
      try {
        await send('Close the real carrier during revalidation');
        await expect.poll(() => waiting?.isCurrent()).toBe(true);
        lifecycle.abort();
        expect(waiting!.isCurrent()).toBe(false);
      } finally {
        resumeRead();
      }
      await expect.poll(() => denied.includes(waiting!.attemptId)).toBe(true);
      expect(handedOff).toEqual(alreadySubmitted);
      expect(arrivals).toHaveLength(3);
      await host.close();
      const encodedCall = Buffer.from(JSON.stringify(main[0]!.call)).toString(
        'base64url',
      );
      for (const file of await readdir(join(root, 'runtime'), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!file.isFile()) continue;
        const bytes = await readFile(join(file.parentPath, file.name));
        expect(bytes.includes(activeBinding)).toBe(false);
        expect(bytes.includes(encodedCall)).toBe(false);
      }
    } finally {
      lifecycle.abort();
      await host.close();
      supplier.closeAllConnections();
      await new Promise<void>((resolve) => supplier.close(() => resolve()));
      try {
        await fixtures.query(
          'delete from native_session where requirement_id=$1',
          [requirementId],
        );
        await fixtures.query(
          'delete from requirement_participant where requirement_id=$1',
          [requirementId],
        );
        await fixtures.query('delete from requirement where id=$1', [
          requirementId,
        ]);
        await fixtures.query('delete from auth_session where id=$1', [
          authSessionId,
        ]);
      } finally {
        await Promise.all([
          pool.end(),
          fixtures.end(),
          rm(root, { recursive: true, force: true }),
        ]);
      }
    }
  },
  30_000,
);
