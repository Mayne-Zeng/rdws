import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { buildApp } from '@rdws/server';
import { nativeLoginBinding } from '@rdws/dsh/access';
import { NativeWebHost } from '@rdws/dsh/web';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import WebSocket from 'ws';
import { expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { journal } from '../helpers/native-journal.ts';
import { nativeReady } from '../helpers/native-ready.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import type { OwnerBoot, OwnerReport } from '../fixtures/t07-paused-owner.ts';

test.skipIf(process.platform !== 'darwin')(
  'the isolated two-model runtime saves, reads and dispatches frozen choices for an owned session',
  async () => {
    const context = execFileSync(
      'docker',
      [
        'context',
        'inspect',
        '--format',
        '{{(index .Endpoints "docker").Host}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const lab = await authorityDatabase(
      process.env.DOCKER_CONTEXT ? context : process.env.DOCKER_HOST || context,
    );
    const trust = getCACertificates('default');
    let app: ReturnType<typeof buildApp> | undefined;
    let supplier: ReturnType<typeof createServer> | undefined;
    let supplierRequests = 0;
    const receivedModels: string[] = [];
    const receivedMessages: string[] = [];
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let nextResponseGate: Promise<void> | undefined;
    let releaseSteering!: () => void;
    let releaseMixed: (() => void) | undefined;
    let releaseRevocation: (() => void) | undefined;
    const steeringGate = new Promise<void>((resolve) => {
      releaseSteering = resolve;
    });
    const root = join(lab.root, 'pilot');
    const projectId = 'poc';
    const owner = randomUUID();
    const other = randomUUID();
    const requirementId = randomUUID();
    const existingFork = 'session-' + randomUUID();
    const provider = 'rdws-glm';
    const defaultModel = 'pilot-model-a';
    const model = 'pilot-model-b';
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(24).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN;
    const nativePosts: string[] = [];
    const observations: {
      requestId: string;
      accepted: unknown;
      source: unknown;
      agentBefore: unknown;
      agentAfter: unknown;
    }[] = [];
    let loseNativeReply: string | undefined;
    let loseFreezeCommit: string | undefined;
    let withholdObservation: string | undefined;
    let freezeCommittedWithoutReply = false;
    let firstWriteFault:
      | {
          requestId: string;
          phase: 'prepare' | 'authorize' | 'settle';
          outcome: 'commit' | 'rollback' | 'hold';
          attemptId?: string;
          completion?: string;
          checked?: boolean;
          gate?: Promise<void>;
        }
      | undefined;
    let releaseSettlement: (() => void) | undefined;
    let releaseHeldTls: (() => void) | undefined;
    let heldFreeze:
      | {
          requestId: string;
          entered: boolean;
          gate: Promise<void>;
          release(): void;
        }
      | undefined;

    try {
      const nativeFetch = NativeWebHost.prototype.fetch;
      vi.spyOn(NativeWebHost.prototype, 'fetch').mockImplementation(
        async function (this: NativeWebHost, path, grant, init) {
          if (path !== '/api/session/prompt' || typeof init?.body !== 'string')
            return nativeFetch.call(this, path, grant, init);
          const requestId = JSON.parse(init.body).payload.args.request
            .requestId as string;
          nativePosts.push(requestId);
          const response = await nativeFetch.call(this, path, grant, init);
          if (requestId === loseNativeReply) {
            expect(response.status).toBe(200);
            expect((await response.json()).result).toMatchObject({
              ok: true,
              value: { accepted: true },
            });
            throw new Error('Synthetic Native response lost after acceptance');
          }
          return response;
        },
      );
      const nativeControl = NativeWebHost.prototype.control;
      vi.spyOn(NativeWebHost.prototype, 'control').mockImplementation(
        async function (this: NativeWebHost, operation, body) {
          const result = await nativeControl.call(this, operation, body);
          if (operation === 'session.prompt-observation')
            observations.push({
              requestId: String(body.requestId),
              accepted: result.accepted,
              source: result.source,
              agentBefore: result.agentBefore,
              agentAfter: result.agentAfter,
            });
          if (
            operation === 'session.prompt-observation' &&
            body.requestId === withholdObservation
          )
            return { accepted: false };
          return result;
        },
      );
      const connect = Pool.prototype.connect;
      vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
        this: Pool,
        ...args: unknown[]
      ) {
        const connection = Reflect.apply(connect, this, args);
        const watchedRequest = loseFreezeCommit ?? heldFreeze?.requestId;
        const fault = firstWriteFault;
        if (args.length || (!watchedRequest && !fault)) return connection;
        return connection.then((client: PoolClient) => {
          const query = client.query;
          let freezing = false;
          let phase: NonNullable<typeof firstWriteFault>['phase'] | undefined;
          client.query = ((...parameters: unknown[]) => {
            const input = parameters[0] as
              string | { text: string; values?: unknown[] };
            const sql = (typeof input === 'string' ? input : input.text).trim();
            const values = Array.isArray(parameters[1])
              ? parameters[1]
              : typeof input === 'string'
                ? undefined
                : input.values;
            if (
              watchedRequest &&
              sql.startsWith('update "session_prompt_dispatch"') &&
              values?.includes('pending') &&
              values.includes(watchedRequest)
            )
              freezing = true;
            if (fault) {
              if (
                sql.startsWith('insert into "session_model_first_write"') &&
                values?.[3] === fault.requestId
              ) {
                fault.attemptId = String(values[11]);
                phase = 'prepare';
              } else if (
                sql.startsWith('select ') &&
                sql.includes('from "session_prompt_dispatch"') &&
                sql.endsWith('for share') &&
                values?.includes(fault.requestId)
              ) {
                phase = 'authorize';
              } else if (fault.attemptId && values?.includes(fault.attemptId)) {
                if (sql.startsWith('update "session_model_first_write"'))
                  phase = 'settle';
                if (
                  sql.startsWith('select ') &&
                  sql.includes('from "session_model_first_write"')
                )
                  fault.checked = true;
              }
              if (sql === 'commit' && phase === fault.phase) {
                client.query = query;
                const statement =
                  fault.outcome === 'rollback' ? 'rollback' : 'commit';
                return Reflect.apply(query, client, [statement]).then(
                  async (value: { command: string }) => {
                    fault.completion = value.command;
                    if (fault.outcome === 'hold') {
                      await fault.gate;
                      return value;
                    }
                    throw new Error('Synthetic first-write commit reply lost');
                  },
                );
              }
            }
            const result = Reflect.apply(query, client, parameters);
            if (sql === 'commit' || sql === 'rollback') client.query = query;
            const held =
              heldFreeze?.requestId === watchedRequest ? heldFreeze : undefined;
            if (sql === 'commit' && freezing && held)
              return result.then(async (value: unknown) => {
                held.entered = true;
                await held.gate;
                return value;
              });
            if (
              sql === 'commit' &&
              freezing &&
              loseFreezeCommit === watchedRequest &&
              !freezeCommittedWithoutReply
            )
              return result.then(() => {
                freezeCommittedWithoutReply = true;
                throw new Error('Synthetic freeze commit reply lost');
              });
            return result;
          }) as typeof client.query;
          return client;
        });
      });
      await lab.owner.query(
        "insert into project values($1,'Model pilot',now(),now())",
        [projectId],
      );
      for (const [id, username] of [
        [owner, 'pilot_owner'],
        [other, 'pilot_other'],
      ]) {
        await lab.owner.query(
          'insert into auth_user(id,name,email,username,active) values($1,$2,$3,$2,true)',
          [id, username, username + '@fixture.invalid'],
        );
        await lab.owner.query(
          "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
          [randomUUID(), id, await hashPassword(password)],
        );
        await lab.owner.query(
          "insert into project_member values($1,$2,'developer')",
          [projectId, id],
        );
      }
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Synthetic model requirement','','',$3,$3)",
        [requirementId, projectId, owner],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer'),($1,$3,'developer')",
        [requirementId, owner, other],
      );
      const source = 'session-' + randomUUID();
      await lab.owner.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
        [source, requirementId, owner],
      );
      await lab.owner.query(
        'insert into native_session(id,requirement_id,owner_id,source_session_id,source_through_seq) values($1,$2,$3,$4,0)',
        [existingFork, requirementId, owner, source],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );

      const cert = await modelTlsCertificate(lab.root);
      setDefaultCACertificates([...trust, cert.cert.toString()]);
      supplier = createServer(
        { ...cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
        async (request, response) => {
          supplierRequests++;
          try {
            if (
              request.method !== 'POST' ||
              request.url !== '/v1/chat/completions'
            ) {
              response.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
              model: string;
              messages: unknown[];
            };
            receivedModels.push(payload.model);
            receivedMessages.push(JSON.stringify(payload.messages));
            if (supplierRequests === 1) {
              await retryGate;
              response
                .writeHead(429, {
                  'content-type': 'application/json',
                  'retry-after': '0',
                })
                .end(
                  JSON.stringify({
                    error: {
                      message: 'Synthetic rate limit',
                      type: 'rate_limit_error',
                    },
                  }),
                );
              return;
            }
            if (nextResponseGate) {
              const gate = nextResponseGate;
              nextResponseGate = undefined;
              await gate;
            }
            const chunk = {
              id: 'synthetic-model-pilot',
              object: 'chat.completion.chunk',
              created: 1,
              model: payload.model,
            };
            response
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(
                [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: 'Completed synthetic model pilot prompt',
                    },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: 'stop' },
                ]
                  .map(
                    (choice) =>
                      `data: ${JSON.stringify({ ...chunk, choices: [choice] })}\n\n`,
                  )
                  .join('') + 'data: [DONE]\n\n',
              );
          } catch {
            response.destroy();
          }
        },
      );
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      const destination = `https://127.0.0.1:${(supplier.address() as { port: number }).port}/v1/chat/completions`;
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { TEST_MODEL: randomBytes(24).toString('hex') },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                [provider]: {
                  api: 'openai-completions',
                  baseURL: destination.slice(0, -'/chat/completions'.length),
                  apiKeyEnv: 'TEST_MODEL',
                  models: [{ id: defaultModel }, { id: model }],
                  retryPolicy: { mode: 'normal', maxRetries: 1 },
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      const databaseFixture = (
        await lab.owner.query<{ name: string }>(
          "select current_setting('rdws.fixture_instance') as name",
        )
      ).rows[0]!.name;
      const config: Parameters<typeof buildApp>[0] = {
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET,
        nativeRuntimeRoot: root,
        repositoryHome: root,
        authorityTicket: ticket,
        mainModelPolicy: {
          projectId,
          provider,
          model: defaultModel,
          destination,
        },
        sessionModelPilot: { alternateModel: model, databaseFixture },
      };
      expect(() =>
        buildApp({ ...config, nativeRuntimeRoot: undefined }),
      ).toThrow('isolated mediated test runtime');
      app = buildApp({
        ...config,
        sessionModelPilot: {
          alternateModel: model,
          databaseFixture: 'other-test-database',
        },
      });
      await expect(app.ready()).rejects.toThrow(
        'Session model pilot database protection could not be confirmed',
      );
      await app.close();
      app = undefined;
      await lab.owner.query(
        'alter table command_receipt disable trigger rdws_authority_writer',
      );
      app = buildApp(config);
      await expect(app.ready()).rejects.toThrow(
        'database protection could not be confirmed',
      );
      await app.close();
      app = undefined;
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows,
      ).toEqual([{ generation: null }]);
      await lab.owner.query(
        'alter table command_receipt enable always trigger rdws_authority_writer',
      );
      await lab.owner.query(
        'grant update(step_seq) on session_model_first_write to rdws_test_app',
      );
      app = buildApp(config);
      await expect(app.ready()).rejects.toThrow(
        'Session model pilot database protection could not be confirmed',
      );
      await app.close();
      app = undefined;
      await lab.owner.query(
        'revoke update(step_seq) on session_model_first_write from rdws_test_app',
      );
      app = buildApp(config);
      let address = await app.listen({ host: '127.0.0.1', port: 0 });
      async function login(username: string) {
        const response = await fetch(address + '/api/auth/sign-in/username', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
          redirect: 'error',
        });
        expect(response.status).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .map((part) => part.split(';')[0])
          .join('; ');
        await response.text();
        const authenticated = await fetch(address + '/api/auth/get-session', {
          headers: { cookie },
          redirect: 'error',
        });
        expect(authenticated.status).toBe(200);
        const { session } = (await authenticated.json()) as {
          session: { id: string };
        };
        return {
          origin,
          cookie,
          'x-rdws-edit-session': session.id,
          'content-type': 'application/json',
        };
      }
      const headers = await login('pilot_owner');
      const otherHeaders = await login('pilot_other');
      const sessionsPath = `${address}/api/requirements/${requirementId}/sessions`;
      const created = await fetch(sessionsPath, {
        method: 'POST',
        headers,
        body: JSON.stringify({ commandId: randomUUID() }),
      });
      expect(created.status).toBe(200);
      const { sessionId } = (await created.json()) as { sessionId: string };
      expect(sessionId).toEqual(expect.any(String));
      const path = `${sessionsPath}/${encodeURIComponent(sessionId)}/model-selection`;
      const unreadable = await fetch(path, { headers: otherHeaders });
      expect(unreadable.status).toBe(403);
      await unreadable.text();
      const before = await fetch(path, { headers });
      expect(before.status, await before.clone().text()).toBe(200);
      expect(await before.json()).toEqual({ selection: null });
      const commandId = randomUUID();
      const save = (id: string, selected: string) =>
        fetch(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ commandId: id, provider, model: selected }),
        });
      const result = await save(commandId, model);
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('no-store');
      const saved = await result.json();
      expect(saved).toEqual({
        selection: { provider, model, revision: expect.any(String) },
      });
      const repeated = await save(commandId, model);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(saved);
      const conflicting = await save(commandId, defaultModel);
      expect(conflicting.status).toBe(409);
      await conflicting.text();
      const rejected = await save(randomUUID(), 'unapproved-model');
      expect(rejected.status).toBe(409);
      await rejected.text();
      const readBack = await fetch(path, { headers });
      expect(readBack.status).toBe(200);
      expect(await readBack.json()).toEqual(saved);
      const forked = await fetch(
        `${sessionsPath}/${encodeURIComponent(sessionId)}/fork`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ commandId: randomUUID() }),
        },
      );
      expect(forked.status).toBe(403);
      await forked.text();
      expect(supplierRequests).toBe(0);
      expect(
        (
          await lab.owner.query(
            'select provider,model,revision from session_model_selection where native_session_id=$1',
            [sessionId],
          )
        ).rows,
      ).toEqual([saved.selection]);
      expect(
        (
          await lab.owner.query(
            'select request_id from session_prompt_dispatch',
          )
        ).rows,
      ).toEqual([]);
      const bootstrap = await fetch(
        `${address}/api/dsh/${requirementId}/bootstrap`,
        { headers },
      );
      expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
      const { loginBinding } = (await bootstrap.json()) as {
        loginBinding: string;
      };
      const nativeHeaders = {
        origin,
        cookie: headers.cookie,
        'content-type': 'application/json',
        'x-rdws-native-login': loginBinding,
        'x-rdws-client-generation': randomUUID(),
      };
      const prompt = (
        requestId: string,
        text: string,
        wire = nativeHeaders,
        mode = 'queue',
        targetSession = sessionId,
      ) =>
        fetch(`${address}/api/dsh/${requirementId}/native/api/session/prompt`, {
          method: 'POST',
          headers: wire,
          redirect: 'error',
          body: JSON.stringify({
            type: 'client-request',
            method: 'session/prompt',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  sessionId: targetSession,
                  requestId,
                  mode,
                  content: [{ type: 'text', text }],
                },
              },
            },
          }),
        });
      const historyPath = `${sessionsPath}/${encodeURIComponent(sessionId)}/history`;
      const previousHistory = await fetch(historyPath, { headers });
      expect(previousHistory.status).toBe(200);
      const beforeActivation = await previousHistory.json();
      const follow = { address: { kind: 'session', sessionId } };
      const activation = await fetch(
        `${address}/api/dsh/${requirementId}/native/api/session/follow`,
        {
          method: 'POST',
          headers: nativeHeaders,
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/follow',
            payload: { args: { request: { ...follow, activate: true } } },
          }),
        },
      );
      expect(activation.status).toBe(403);
      expect(await activation.json()).toEqual({
        error: '隔离选模暂不支持通过跟随激活会话',
      });
      const forkPrompt = await prompt(
        randomUUID(),
        'Synthetic prompt for an existing fork',
        nativeHeaders,
        'queue',
        existingFork,
      );
      expect(forkPrompt.status).toBe(403);
      expect(await forkPrompt.json()).toEqual({
        error: '隔离选模暂不支持派生会话',
      });
      for (const [endpoint, request] of [
        ['session/follow', { ...follow, activate: true }],
        [
          'session/prompt',
          {
            sessionId,
            requestId: randomUUID(),
            mode: 'queue',
            content: [
              { type: 'text', text: 'Synthetic rejected WebSocket prompt' },
            ],
          },
        ],
      ] as const) {
        const socket = new WebSocket(
          `${address.replace('http:', 'ws:')}/api/dsh/${requirementId}/native/api/remote.mux?generation=${randomUUID()}&login=${loginBinding}`,
          {
            headers: { origin, cookie: headers.cookie },
          },
        );
        try {
          await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
          const passive = once(socket, 'message', {
            signal: AbortSignal.timeout(3000),
          });
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId: 'passive',
              endpoint: 'session/follow',
              payload: { args: { request: follow } },
            }),
          );
          const [snapshot] = await passive;
          expect(JSON.parse(String(snapshot))).toMatchObject({
            type: 'item',
            streamId: 'passive',
            value: { type: 'snapshot' },
          });
          const closing = once(socket, 'close', {
            signal: AbortSignal.timeout(3000),
          });
          socket.send(
            JSON.stringify({
              type: 'open',
              streamId: 'blocked',
              endpoint,
              payload: { args: { request } },
            }),
          );
          await closing;
        } finally {
          socket.terminate();
        }
      }
      const afterActivation = await fetch(historyPath, { headers });
      expect(afterActivation.status).toBe(200);
      expect(await afterActivation.json()).toEqual(beforeActivation);
      expect(nativePosts).toEqual([]);
      expect(supplierRequests).toBe(0);

      const firstPrompt = randomUUID();
      const firstText = 'Synthetic prompt with the saved alternate model';
      const first = await prompt(firstPrompt, firstText);
      expect(first.status, await first.clone().text()).toBe(200);
      expect((await first.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      const completedTurns = async () =>
        (await journal(root, sessionId)).events.filter(
          ({ type, data }) =>
            type === 'turn/end' && data.reason.kind === 'completed',
        ).length;
      await expect.poll(() => receivedModels).toEqual([model]);
      const nextSave = await save(randomUUID(), defaultModel);
      expect(nextSave.status).toBe(200);
      const changed = await nextSave.json();
      expect(changed.selection.revision).not.toBe(saved.selection.revision);
      releaseRetry();
      await expect.poll(completedTurns, { timeout: 8000 }).toBe(1);
      expect(receivedModels).toEqual([model, model]);
      const modelReceipt = () =>
        lab.owner.query(
          `select * from session_model_first_write
           where native_session_id=$1 and selection_request_id=$2
           order by created_at,attempt_id`,
          [sessionId, firstPrompt],
        );
      expect((await modelReceipt()).rows).toHaveLength(2);
      await expect
        .poll(async () => (await modelReceipt()).rows.map(({ state }) => state))
        .toEqual(['submitted', 'submitted']);
      const writes = (await modelReceipt()).rows;
      const [originalWrite, retriedWrite] = writes;
      expect(originalWrite).toMatchObject({
        project_id: projectId,
        requirement_id: requirementId,
        native_session_id: sessionId,
        selection_request_id: firstPrompt,
        selection_revision: saved.selection.revision,
        model,
        turn: 1,
        step: 1,
      });
      expect(retriedWrite).toMatchObject({
        binding_id: originalWrite.binding_id,
        step_seq: originalWrite.step_seq,
        note_seq: originalWrite.note_seq,
        selection_revision: saved.selection.revision,
        model,
      });
      expect(retriedWrite.attempt_id).not.toBe(originalWrite.attempt_id);
      const firstJournal = await journal(root, sessionId);
      expect(
        firstJournal.events.find(
          ({ seq }) => seq === Number(originalWrite.step_seq),
        ),
      ).toMatchObject({ type: 'step/start', data: { turn: 1, step: 1 } });
      expect(
        firstJournal.events.find(
          ({ seq }) => seq === Number(originalWrite.note_seq),
        ),
      ).toMatchObject({
        type: 'user/message',
        data: { source: { kind: 'rdws-context', turn: 1, step: 1 } },
      });
      const repeatedPrompt = await prompt(firstPrompt, firstText);
      expect(repeatedPrompt.status, await repeatedPrompt.clone().text()).toBe(
        200,
      );
      expect((await repeatedPrompt.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      expect(receivedModels).toEqual([model, model]);
      const differentPrompt = await prompt(
        firstPrompt,
        'Different synthetic prompt using the old key',
      );
      expect(differentPrompt.status).toBe(409);
      await differentPrompt.text();
      const secondPrompt = randomUUID();
      const secondText = 'Synthetic prompt after saving the default model';
      withholdObservation = secondPrompt;
      const second = await prompt(secondPrompt, secondText);
      expect(second.status, await second.clone().text()).toBe(409);
      expect(await second.json()).toEqual({ error: '原消息接纳状态尚待核对' });
      expect(
        (
          await lab.owner.query(
            'select state from session_prompt_dispatch where request_id=$1',
            [secondPrompt],
          )
        ).rows,
      ).toEqual([{ state: 'pending' }]);
      await expect.poll(completedTurns, { timeout: 8000 }).toBe(2);
      expect(receivedModels).toEqual([model, model, defaultModel]);
      withholdObservation = undefined;
      const observedSecond = await prompt(secondPrompt, secondText);
      expect(observedSecond.status).toBe(200);
      expect((await observedSecond.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      expect(supplierRequests).toBe(3);
      const resultRows = await lab.owner.query(
        'select request_id,selection_revision,model,state,accepted_seq from session_prompt_dispatch where native_session_id=$1',
        [sessionId],
      );
      expect(resultRows.rows).toHaveLength(2);
      expect(resultRows.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            request_id: firstPrompt,
            selection_revision: saved.selection.revision,
            model,
            state: 'accepted',
            accepted_seq: expect.any(String),
          }),
          expect.objectContaining({
            request_id: secondPrompt,
            selection_revision: changed.selection.revision,
            model: defaultModel,
            state: 'accepted',
            accepted_seq: expect.any(String),
          }),
        ]),
      );
      const secondLogin = await login('pilot_owner');
      const steerWire = {
        ...nativeHeaders,
        cookie: secondLogin.cookie,
        'x-rdws-native-login': nativeLoginBinding(
          secondLogin['x-rdws-edit-session'],
          projectId,
          requirementId,
        ),
        'x-rdws-client-generation': randomUUID(),
      };
      const ongoing = randomUUID();
      const steerIds = [randomUUID(), randomUUID()];
      const steerInputs = [
        'Synthetic steering input from first login',
        'Synthetic steering input from second login',
      ];
      nextResponseGate = steeringGate;
      const started = await prompt(
        ongoing,
        'Synthetic prompt held while another step queues',
      );
      expect(started.status, await started.clone().text()).toBe(200);
      await started.text();
      await expect
        .poll(() => receivedModels)
        .toEqual([model, model, defaultModel, defaultModel]);
      const steerSaved = await save(randomUUID(), model);
      expect(steerSaved.status).toBe(200);
      const steerChoice = (await steerSaved.json()).selection;
      for (const [index, wire] of [nativeHeaders, steerWire].entries()) {
        const steered = await prompt(
          steerIds[index]!,
          steerInputs[index]!,
          wire,
          'steer',
        );
        expect(steered.status, await steered.clone().text()).toBe(200);
        await steered.text();
      }
      const superseded = await save(randomUUID(), defaultModel);
      expect(superseded.status).toBe(200);
      expect((await superseded.json()).selection.revision).not.toBe(
        steerChoice.revision,
      );
      const nextTurnText =
        'Synthetic next-turn input outside the active steering batch';
      const nextTurn = await prompt(randomUUID(), nextTurnText);
      expect(nextTurn.status, await nextTurn.clone().text()).toBe(200);
      await nextTurn.text();
      releaseSteering();
      await expect.poll(completedTurns, { timeout: 8000 }).toBe(4);
      expect(receivedModels).toEqual([
        model,
        model,
        defaultModel,
        defaultModel,
        model,
        defaultModel,
      ]);
      for (const text of steerInputs)
        expect(receivedMessages[4]).toContain(text);
      expect(receivedMessages[4]).not.toContain(nextTurnText);
      expect(receivedMessages[5]).toContain(nextTurnText);
      const steerRows = await lab.owner.query(
        'select request_id,auth_session_id,selection_revision,model from session_prompt_dispatch where request_id=any($1::text[])',
        [steerIds],
      );
      expect(steerRows.rows).toHaveLength(2);
      expect(steerRows.rows).toEqual(
        expect.arrayContaining(
          [headers, secondLogin].map((login, index) => ({
            request_id: steerIds[index],
            auth_session_id: login['x-rdws-edit-session'],
            selection_revision: steerChoice.revision,
            model,
          })),
        ),
      );
      await expect
        .poll(
          async () =>
            (
              await lab.owner.query(
                `select selection_request_id, model, step, state from session_model_first_write
           where native_session_id=$1 and selection_revision=$2`,
                [sessionId, steerChoice.revision],
              )
            ).rows,
        )
        .toEqual([
          {
            selection_request_id: steerIds[0],
            model,
            step: 2,
            state: 'submitted',
          },
        ]);
      const beforeMixed = supplierRequests;
      const beforeMixedHistory = (await journal(root, sessionId)).events.length;
      nextResponseGate = new Promise<void>((resolve) => {
        releaseMixed = resolve;
      });
      const mixedStart = await prompt(
        randomUUID(),
        'Synthetic first step before conflicting saved revisions',
      );
      expect(mixedStart.status).toBe(200);
      await mixedStart.text();
      await expect.poll(() => supplierRequests).toBe(beforeMixed + 1);
      const revisions: string[] = [];
      for (const wire of [nativeHeaders, steerWire]) {
        const selectedAgain = await save(randomUUID(), model);
        expect(selectedAgain.status).toBe(200);
        revisions.push((await selectedAgain.json()).selection.revision);
        const steered = await prompt(
          randomUUID(),
          'Synthetic steer sharing the model but not the revision',
          wire,
          'steer',
        );
        expect(steered.status, await steered.clone().text()).toBe(200);
        await steered.text();
      }
      expect(new Set(revisions).size).toBe(2);
      releaseMixed!();
      await expect
        .poll(async () =>
          (await journal(root, sessionId)).events
            .slice(beforeMixedHistory)
            .some(
              ({ type, data }) =>
                type === 'turn/end' && data.reason.kind === 'blocked',
            ),
        )
        .toBe(true);
      expect(supplierRequests).toBe(beforeMixed + 1);
      expect(
        (
          await lab.owner.query(
            `select attempt_id from session_model_first_write
           where native_session_id=$1 and selection_revision=any($2::uuid[])`,
            [sessionId, revisions],
          )
        ).rows,
      ).toEqual([]);
      const beforeRevocation = supplierRequests;
      const parkWire = new Promise<void>((resolve) => {
        releaseRevocation = resolve;
      });
      const authorize = ContextRuns.prototype.authorizeModelWireAttempt;
      let atRevocationGate = false;
      let attemptSettled = false;
      const holdAuthority = vi
        .spyOn(ContextRuns.prototype, 'authorizeModelWireAttempt')
        .mockImplementation(async function (this: ContextRuns, ...args) {
          atRevocationGate = true;
          await parkWire;
          try {
            return await authorize.apply(this, args);
          } finally {
            attemptSettled = true;
          }
        });
      try {
        const queued = await prompt(
          randomUUID(),
          'Synthetic model request revoked before its first wire write',
          steerWire,
        );
        expect(queued.status, await queued.clone().text()).toBe(200);
        await queued.text();
        await expect.poll(() => atRevocationGate, { timeout: 4000 }).toBe(true);
        const revokeOriginal = fetch(address + '/api/auth/sign-out', {
          method: 'POST',
          headers: {
            origin,
            cookie: secondLogin.cookie,
            'content-type': 'application/json',
          },
          body: '{}',
        });
        void revokeOriginal.catch(() => {});
        await expect
          .poll(
            async () =>
              (
                await lab.owner.query(
                  'select id from auth_session where id=$1',
                  [secondLogin['x-rdws-edit-session']],
                )
              ).rowCount,
          )
          .toBe(0);
        releaseRevocation!();
        const logged = await revokeOriginal;
        expect(logged.status).toBe(200);
        await logged.text();
        await expect.poll(() => attemptSettled).toBe(true);
        expect(supplierRequests).toBe(beforeRevocation);
      } finally {
        releaseRevocation?.();
        holdAuthority.mockRestore();
      }
      const confirmedTraffic = supplierRequests;
      const confirmedPosts = [...nativePosts];
      const freezeKey = randomUUID();
      const freezeText =
        'Synthetic prompt whose freeze commit acknowledgement is lost';
      loseFreezeCommit = freezeKey;
      const noAck = await prompt(freezeKey, freezeText);
      loseFreezeCommit = undefined;
      expect(freezeCommittedWithoutReply).toBe(true);
      expect(noAck.status, await noAck.clone().text()).toBe(503);
      expect(await noAck.json()).toEqual({ error: '原消息派发状态尚待核对' });
      expect(
        (
          await lab.owner.query(
            'select state,host_generation is not null as host_bound from session_prompt_dispatch where request_id=$1',
            [freezeKey],
          )
        ).rows,
      ).toEqual([{ state: 'pending', host_bound: true }]);
      const freezeReplay = await prompt(freezeKey, freezeText);
      expect(freezeReplay.status).toBe(409);
      expect(await freezeReplay.json()).toEqual({
        error: '原消息接纳状态尚待核对',
      });
      expect(nativePosts).not.toContain(freezeKey);
      expect(supplierRequests).toBe(confirmedTraffic);

      const chooseRemoved = await save(randomUUID(), model);
      expect(chooseRemoved.status).toBe(200);
      const newest = await chooseRemoved.json();
      const lostPrompt = randomUUID();
      const lostText = 'Synthetic accepted prompt whose HTTP response is lost';
      loseNativeReply = lostPrompt;
      const lost = await prompt(lostPrompt, lostText);
      loseNativeReply = undefined;
      expect(lost.status).toBe(503);
      expect(await lost.json()).toEqual({ error: '原消息接纳状态尚待核对' });
      expect(
        (
          await lab.owner.query(
            'select state,model,selection_revision from session_prompt_dispatch where request_id=$1',
            [lostPrompt],
          )
        ).rows,
      ).toEqual([
        {
          state: 'pending',
          model,
          selection_revision: newest.selection.revision,
        },
      ]);
      expect(nativePosts.filter((id) => id === lostPrompt)).toHaveLength(1);
      const logout = await fetch(address + '/api/auth/sign-out', {
        method: 'POST',
        headers: {
          origin,
          cookie: headers.cookie,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(logout.status).toBe(200);
      await logout.text();
      await app.close();
      app = undefined;
      const stopped = await journal(root, sessionId);
      const inserted = stopped.events
        .filter(({ type }) => type === 'agent/inbox/spliced')
        .flatMap(({ data }) => data.inserted ?? [])
        .filter(({ source }) => source?.rpcId === lostPrompt);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.source?.principal?.userId).toBe(owner);
      const priorTraffic = supplierRequests;
      const coldTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set ticket_digest=$1 where singleton and managed and generation is null and proof_digest is null and ticket_digest is null',
            [createHash('sha256').update(coldTicket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      app = buildApp({
        ...config,
        authorityTicket: coldTicket,
        sessionModelPilot: {
          alternateModel: 'alternate-no-longer-in-native-catalog',
          databaseFixture,
        },
      });
      address = await app.listen({ host: '127.0.0.1', port: 0 });
      const fresh = await login('pilot_owner');
      expect(fresh['x-rdws-edit-session']).not.toBe(
        headers['x-rdws-edit-session'],
      );
      const coldWire = {
        ...nativeHeaders,
        cookie: fresh.cookie,
        'x-rdws-native-login': nativeLoginBinding(
          fresh['x-rdws-edit-session'],
          projectId,
          requirementId,
        ),
        'x-rdws-client-generation': randomUUID(),
      };
      const recovered = await prompt(lostPrompt, lostText, coldWire);
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      expect((await recovered.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      expect(observations).toContainEqual({
        requestId: lostPrompt,
        accepted: true,
        source: 'prepared',
        agentBefore: false,
        agentAfter: false,
      });
      expect(
        (
          await lab.owner.query(
            'select state,auth_session_id,accepted_message_id from session_prompt_dispatch where request_id=$1',
            [lostPrompt],
          )
        ).rows,
      ).toEqual([
        {
          state: 'accepted',
          auth_session_id: headers['x-rdws-edit-session'],
          accepted_message_id: inserted[0]?.id,
        },
      ]);
      const stillUnknown = await prompt(freezeKey, freezeText, coldWire);
      expect(stillUnknown.status).toBe(409);
      await stillUnknown.text();
      const notAllowed = await prompt(
        randomUUID(),
        'Synthetic pending draft with a removed model',
        coldWire,
      );
      expect(notAllowed.status).toBe(409);
      expect(await notAllowed.json()).toEqual({
        error: '已选模型当前不可用，请重新选择后发送',
      });
      expect((await journal(root, sessionId)).bytes.equals(stopped.bytes)).toBe(
        true,
      );
      expect(nativePosts).toEqual([...confirmedPosts, lostPrompt]);
      expect(supplierRequests).toBe(priorTraffic);
      const ready = await nativeReady(root, projectId);
      expect(ready.pid).toBeGreaterThan(1);
      expect(
        Number(
          execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(ready.pid)], {
            encoding: 'utf8',
          }).trim(),
        ),
      ).toBe(process.pid);
      expect(process.kill(ready.pid, 'SIGKILL')).toBe(true);
      await expect
        .poll(() => {
          try {
            process.kill(ready.pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        })
        .toBe(true);
      const withoutNative = await prompt(lostPrompt, lostText, coldWire);
      expect(withoutNative.status, await withoutNative.clone().text()).toBe(
        200,
      );
      expect((await withoutNative.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      expect(nativePosts).toEqual([...confirmedPosts, lostPrompt]);
      expect(supplierRequests).toBe(priorTraffic);
      await app.close();
      app = undefined;
      expect((await modelReceipt()).rows).toEqual(writes);
      expect(supplierRequests).toBe(priorTraffic);
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows,
      ).toEqual([{ generation: null }]);

      async function startNext(pilot: typeof config.sessionModelPilot) {
        const nextTicket = randomBytes(32).toString('hex');
        expect(
          (
            await lab.owner.query(
              'update rdws_authority.owner set ticket_digest=$1 where singleton and managed and generation is null and proof_digest is null and ticket_digest is null',
              [createHash('sha256').update(nextTicket).digest('hex')],
            )
          ).rowCount,
        ).toBe(1);
        app = buildApp({
          ...config,
          authorityTicket: nextTicket,
          sessionModelPilot: pilot,
        });
        address = await app.listen({ host: '127.0.0.1', port: 0 });
        const authenticated = await login('pilot_owner');
        return {
          authenticated,
          wire: {
            ...nativeHeaders,
            cookie: authenticated.cookie,
            'x-rdws-native-login': nativeLoginBinding(
              authenticated['x-rdws-edit-session'],
              projectId,
              requirementId,
            ),
            'x-rdws-client-generation': randomUUID(),
          },
        };
      }
      const legacy = await startNext(undefined);
      const createdLegacy = await fetch(
        `${address}/api/requirements/${requirementId}/sessions`,
        {
          method: 'POST',
          headers: legacy.authenticated,
          body: JSON.stringify({ commandId: randomUUID() }),
        },
      );
      expect(createdLegacy.status).toBe(200);
      const { sessionId: legacySession } = (await createdLegacy.json()) as {
        sessionId: string;
      };
      const legacySelection = await fetch(
        `${address}/api/requirements/${requirementId}/sessions/${legacySession}/model-selection`,
        { headers: { cookie: legacy.authenticated.cookie } },
      );
      expect(legacySelection.status).toBe(404);
      await legacySelection.text();
      const legacyKey = randomUUID();
      const legacyText = 'Synthetic prompt persisted before the model pilot';
      const legacyInput = await prompt(
        legacyKey,
        legacyText,
        legacy.wire,
        'queue',
        legacySession,
      );
      expect(legacyInput.status, await legacyInput.clone().text()).toBe(200);
      expect((await legacyInput.json()).result).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
      await expect
        .poll(async () =>
          (await journal(root, legacySession)).events.some(
            ({ type, data }) =>
              type === 'turn/end' && data.reason.kind === 'completed',
          ),
        )
        .toBe(true);
      expect(receivedModels.at(-1)).toBe(defaultModel);
      expect(supplierRequests).toBe(priorTraffic + 1);
      expect(
        (
          await lab.owner.query(
            'select state from session_prompt_dispatch where request_id=$1',
            [legacyKey],
          )
        ).rows,
      ).toEqual([]);
      await app!.close();
      app = undefined;

      const pilotAgain = await startNext(config.sessionModelPilot);
      const sameLegacyKey = await prompt(
        legacyKey,
        legacyText,
        pilotAgain.wire,
        'queue',
        legacySession,
      );
      expect(sameLegacyKey.status, await sameLegacyKey.clone().text()).toBe(
        409,
      );
      expect(await sameLegacyKey.json()).toEqual({
        error: '原消息接纳状态尚待核对',
      });
      expect(
        (
          await lab.owner.query(
            'select state,accepted_seq from session_prompt_dispatch where request_id=$1',
            [legacyKey],
          )
        ).rows,
      ).toEqual([{ state: 'pending', accepted_seq: null }]);
      const repeatLegacy = await prompt(
        legacyKey,
        legacyText,
        pilotAgain.wire,
        'queue',
        legacySession,
      );
      expect(repeatLegacy.status).toBe(409);
      await repeatLegacy.text();
      expect(supplierRequests).toBe(priorTraffic + 1);
      expect(nativePosts.filter((id) => id === legacyKey)).toHaveLength(2);
      const legacyJournal = await journal(root, legacySession);
      expect(
        legacyJournal.events
          .filter(({ type }) => type === 'agent/inbox/spliced')
          .flatMap(({ data }) => data.inserted ?? [])
          .filter(
            ({ source: requestSource }) => requestSource?.rpcId === legacyKey,
          ),
      ).toHaveLength(1);
      const databaseOwner = async () =>
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation;
      async function ownerCannotMove(generation: string) {
        expect(await databaseOwner()).toBe(generation);
        const contender = fork(
          new URL('../fixtures/t07-paused-owner.ts', import.meta.url),
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: {
              PATH: process.env.PATH,
              RDWS_MODE: 'test',
              RDWS_NATIVE_MODEL_EGRESS: 'paused',
              RDWS_HOME: join(lab.root, 'competing-owner'),
            },
          },
        );
        const results: OwnerReport[] = [];
        contender.on('message', (report: OwnerReport) => results.push(report));
        const exited = once(contender, 'close');
        void exited.catch(() => {});
        const options: OwnerBoot = {
          databaseUrl: lab.databaseUrl,
          secret: lab.childEnv.BETTER_AUTH_SECRET,
          origin,
          root: join(lab.root, 'competing-owner'),
          ticket: config.authorityTicket!,
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        };
        try {
          contender.send(options);
          await expect
            .poll(
              () =>
                contender.exitCode !== null || contender.signalCode !== null,
              { timeout: 5000 },
            )
            .toBe(true);
          expect(await exited).toEqual([1, null]);
          expect(results.map(({ kind }) => kind)).toContain('authority-denied');
          expect(results.map(({ kind }) => kind)).not.toContain('listening');
        } finally {
          if (contender.exitCode === null && contender.signalCode === null)
            contender.kill('SIGKILL');
          await exited;
        }
        expect(await databaseOwner()).toBe(generation);
      }

      const receiptState = async (key: string) =>
        (
          await lab.owner.query(
            'select state from session_model_first_write where native_session_id=$1 and selection_request_id=$2',
            [legacySession, key],
          )
        ).rows.map(({ state }) => state);
      const actualWire = ContextRuns.prototype.authorizeModelWireAttempt;
      const realWrites: string[] = [];
      const witness = vi
        .spyOn(ContextRuns.prototype, 'authorizeModelWireAttempt')
        .mockImplementation(function (
          this: ContextRuns,
          request,
          write,
          fixture,
        ) {
          return actualWire.call(
            this,
            request,
            (deadline) => {
              const result = write(deadline);
              realWrites.push(result);
              return result;
            },
            fixture,
          );
        });
      try {
        for (const [phase, outcome, expectedState] of [
          ['prepare', 'commit', 'prepared'],
          ['authorize', 'commit', 'prepared'],
          ['settle', 'rollback', 'prepared'],
          ['settle', 'commit', 'submitted'],
        ] as const) {
          const key = randomUUID();
          const beforeWire = realWrites.length;
          const traffic = supplierRequests;
          const turns = (await journal(root, legacySession)).events.filter(
            ({ type }) => type === 'turn/end',
          ).length;
          firstWriteFault = { requestId: key, phase, outcome };
          const planted = firstWriteFault;
          const response = await prompt(
            key,
            'Synthetic request with a lost first-write transaction acknowledgement',
            pilotAgain.wire,
            'queue',
            legacySession,
          );
          expect(response.status, await response.clone().text()).toBe(200);
          await response.text();
          await expect
            .poll(() => planted.completion)
            .toBe(outcome === 'rollback' ? 'ROLLBACK' : 'COMMIT');
          if (phase === 'settle')
            await expect.poll(() => planted.checked).toBe(true);
          await expect
            .poll(
              async () =>
                (await journal(root, legacySession)).events.filter(
                  ({ type }) => type === 'turn/end',
                ).length,
            )
            .toBe(turns + 1);
          expect(await receiptState(key), `${phase} ${outcome}`).toEqual([
            expectedState,
          ]);
          expect(realWrites.slice(beforeWire)).toEqual(
            phase === 'prepare' ? [] : ['submitted'],
          );
          if (phase !== 'authorize')
            expect(supplierRequests).toBe(
              traffic + (phase === 'prepare' ? 0 : 1),
            );
          const trafficBeforeReplay = supplierRequests;
          const replay = await prompt(
            key,
            'Synthetic request with a lost first-write transaction acknowledgement',
            pilotAgain.wire,
            'queue',
            legacySession,
          );
          expect(replay.status).toBe(200);
          await replay.text();
          expect(supplierRequests).toBe(trafficBeforeReplay);
          expect(nativePosts.filter((id) => id === key)).toHaveLength(1);
          expect(await receiptState(key)).toEqual([expectedState]);
          firstWriteFault = undefined;
        }
      } finally {
        witness.mockRestore();
        firstWriteFault = undefined;
      }

      const heldTlsKey = randomUUID();
      let releaseProvider!: () => void;
      nextResponseGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const beforeTls = supplierRequests;
      const atProvider = await prompt(
        heldTlsKey,
        'Synthetic prompt with a live TLS connection',
        pilotAgain.wire,
        'queue',
        legacySession,
      );
      expect(atProvider.status, await atProvider.clone().text()).toBe(200);
      await atProvider.text();
      await expect.poll(() => supplierRequests).toBe(beforeTls + 1);
      const ownerWithTls = await databaseOwner();
      expect(ownerWithTls).toEqual(expect.any(String));
      const supplierPort = Number(new URL(destination).port);
      const socketsWaiting = new Set<Socket>();
      const destroy = Socket.prototype.destroy;
      const deferDestroy = vi
        .spyOn(Socket.prototype, 'destroy')
        .mockImplementation(function (this: Socket, error?: Error) {
          if (
            this.remoteAddress === '127.0.0.1' &&
            this.remotePort === supplierPort &&
            !this.destroyed
          ) {
            socketsWaiting.add(this);
            return this;
          }
          return destroy.call(this, error);
        });
      releaseHeldTls = () => {
        deferDestroy.mockRestore();
        for (const socket of socketsWaiting) destroy.call(socket);
        releaseProvider();
      };
      const tlsClosing = app!.close();
      void tlsClosing.catch(() => {});
      await expect.poll(() => socketsWaiting.size).toBeGreaterThan(0);
      expect(
        [...socketsWaiting].every(
          (socket) => !socket.destroyed && !socket.closed,
        ),
      ).toBe(true);
      await ownerCannotMove(ownerWithTls);
      releaseHeldTls();
      releaseHeldTls = undefined;
      await tlsClosing;
      expect([...socketsWaiting].every((socket) => socket.closed)).toBe(true);
      app = undefined;
      expect(await databaseOwner()).toBeNull();

      const databasePhase = await startNext(config.sessionModelPilot);
      const dbPhaseReady = await fetch(
        `${address}/api/dsh/${requirementId}/bootstrap`,
        {
          headers: databasePhase.authenticated,
          signal: AbortSignal.timeout(8000),
        },
      );
      expect(dbPhaseReady.status, await dbPhaseReady.clone().text()).toBe(200);
      await dbPhaseReady.text();
      let releaseDatabase!: () => void;
      const databaseGate = new Promise<void>((resolve) => {
        releaseDatabase = resolve;
      });
      const duringShutdownKey = randomUUID();
      heldFreeze = {
        requestId: duringShutdownKey,
        entered: false,
        gate: databaseGate,
        release: releaseDatabase,
      };
      const awaiting = prompt(
        duringShutdownKey,
        'Synthetic prompt with freeze acknowledgement held during shutdown',
        databasePhase.wire,
        'queue',
        legacySession,
      );
      void awaiting.catch(() => {});
      await expect.poll(() => heldFreeze?.entered).toBe(true);
      expect(
        (
          await lab.owner.query(
            'select state from session_prompt_dispatch where request_id=$1',
            [duringShutdownKey],
          )
        ).rows,
      ).toEqual([{ state: 'pending' }]);
      const ownerWithCommit = await databaseOwner();
      expect(ownerWithCommit).toEqual(expect.any(String));
      const databaseClosing = app!.close();
      void databaseClosing.catch(() => {});
      await ownerCannotMove(ownerWithCommit);
      expect(nativePosts).not.toContain(duringShutdownKey);
      heldFreeze.release();
      const pendingResponse = await awaiting.catch(() => undefined);
      await pendingResponse?.text();
      await databaseClosing;
      app = undefined;
      heldFreeze = undefined;
      expect(await databaseOwner()).toBeNull();
      expect(nativePosts).not.toContain(duringShutdownKey);

      const settlementPhase = await startNext(config.sessionModelPilot);
      const settlementKey = randomUUID();
      const heldSettlement = {
        requestId: settlementKey,
        phase: 'settle',
        outcome: 'hold',
        gate: new Promise<void>((resolve) => {
          releaseSettlement = resolve;
        }),
      } as const;
      firstWriteFault = heldSettlement;
      const settleTraffic = supplierRequests;
      const priorCompleted = (await journal(root, legacySession)).events.filter(
        ({ type, data }) =>
          type === 'turn/end' && data.reason.kind === 'completed',
      ).length;
      const settling = await prompt(
        settlementKey,
        'Synthetic request with a pending settlement acknowledgement',
        settlementPhase.wire,
        'queue',
        legacySession,
      );
      expect(settling.status, await settling.clone().text()).toBe(200);
      await settling.text();
      await expect.poll(() => firstWriteFault?.completion).toBe('COMMIT');
      await expect.poll(() => supplierRequests).toBe(settleTraffic + 1);
      await expect
        .poll(
          async () =>
            (await journal(root, legacySession)).events.filter(
              ({ type, data }) =>
                type === 'turn/end' && data.reason.kind === 'completed',
            ).length,
        )
        .toBe(priorCompleted + 1);
      expect(await receiptState(settlementKey)).toEqual(['submitted']);
      const ownerWithSettlement = await databaseOwner();
      expect(ownerWithSettlement).toEqual(expect.any(String));
      const settlementClosing = app!.close();
      void settlementClosing.catch(() => {});
      await ownerCannotMove(ownerWithSettlement);
      releaseSettlement!();
      await settlementClosing;
      app = undefined;
      expect(await databaseOwner()).toBeNull();
      firstWriteFault = undefined;
    } finally {
      releaseRetry();
      releaseSteering();
      releaseMixed?.();
      releaseRevocation?.();
      releaseHeldTls?.();
      heldFreeze?.release();
      releaseSettlement?.();
      let stopped = false;
      try {
        await app?.close();
        stopped = true;
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        setDefaultCACertificates(trust);
        try {
          if (supplier) {
            const closed = once(supplier, 'close');
            supplier.close();
            supplier.closeAllConnections();
            await closed;
          }
        } finally {
          if (stopped) await lab.close();
          else await Promise.allSettled([lab.owner.end(), lab.admin.end()]);
        }
      }
    }
  },
  45_000,
);
