import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { NativeWebHost } from '@rdws/dsh/web';
import { bodyHash, isRecord, signGrant } from '@rdws/dsh/access';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import { afterEach, expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';
import {
  NativeFixtureToolJob,
  type FixtureToolArm,
} from '../../apps/server/src/modules/native-fixture-tool-job.ts';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

type Transport = { count: boolean; bytes: number; closed: boolean };
type Gate = 'before-lock' | 'with-lease-lock' | 'before-commit' | 'lose-commit';

function observeTransactions(latest: () => Transport | undefined) {
  let next:
    | {
        phase: Gate;
        latch: ReturnType<typeof latch>;
        wire?: Transport;
        entered: boolean;
      }
    | undefined;
  let settlement:
    | {
        latch: ReturnType<typeof latch>;
        entered: boolean;
        command: () => unknown;
      }
    | undefined;
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      let gate: typeof next;
      client.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as string | { text: string };
        const text = typeof input === 'string' ? input : input.text;
        const run = () => Reflect.apply(query, client, parameters);
        if (text === "set local transaction_timeout='2400ms'" && next) {
          gate = next;
          next = undefined;
          gate.wire = latest();
          if (!gate.wire)
            throw new Error('Synthetic TLS connection was not observed');
          gate.wire.count = true;
          if (gate.phase !== 'with-lease-lock') gate.entered = true;
          if (gate.phase === 'before-lock') return gate.latch.wait.then(run);
        }
        if (
          gate?.phase === 'with-lease-lock' &&
          text.startsWith('select ') &&
          text.includes(' from "requirement_write_lease" ') &&
          text.endsWith(' for share')
        )
          return run().then(async (result: { rowCount: number }) => {
            if (result.rowCount !== 1)
              throw new Error('Synthetic write lease was not locked');
            gate!.entered = true;
            await gate!.latch.wait;
            return result;
          });
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (text === 'commit' && gate?.phase === 'before-commit')
          return gate.latch.wait.then(run);
        if (text === 'commit' && gate?.phase === 'lose-commit')
          return run().then(() => {
            throw new Error('Synthetic write acknowledgement lost');
          });
        const held = settlement;
        const values = parameters[1];
        if (
          held &&
          text.startsWith('update "command_receipt"') &&
          Array.isArray(values) &&
          values.includes(held.command()) &&
          values.some(
            (value: unknown) =>
              typeof value === 'string' && value.includes('"stop":"confirmed"'),
          )
        ) {
          settlement = undefined;
          return run().then(async (result: { rowCount: number }) => {
            expect(result.rowCount).toBe(1);
            held.entered = true;
            await held.latch.wait;
            return result;
          });
        }
        return run();
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    arm(phase: Gate): NonNullable<typeof next> {
      if (next) throw new Error('A fixture gate is already armed');
      return (next = { phase, latch: latch(), entered: false });
    },
    holdSettlement(command: () => unknown): NonNullable<typeof settlement> {
      if (settlement) throw new Error('A fixture settlement is already armed');
      return (settlement = { command, latch: latch(), entered: false });
    },
    restore() {
      spy.mockRestore();
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

test.skipIf(process.platform !== 'darwin')(
  'the formal BFF orders durable logout and the same connection’s actual model write',
  async () => {
    const lab = await authorityDatabase();
    const originalCAs = getCACertificates('default');
    const provider = 'rdws-glm',
      model = 'fixture-model';
    const otherModel = 'fixture-other-model';
    const otherProvider = 'rdws-secondary';
    const requirementId = randomUUID(),
      userId = randomUUID(),
      managerId = randomUUID();
    const credentialMarker = 'only-test-model-credential';
    const bodyMarker = 'Synthetic model request body marker';
    const retryDelayMs = 3000;
    const retryTimeout = { timeout: retryDelayMs + 5000 };
    const pass = randomBytes(18).toString('hex');
    const ticket = randomBytes(32).toString('hex');
    const base = lab.childEnv.RDWS_ORIGIN!;
    const reply = 'Synthetic reply after write';
    const arrivals: { body: unknown; auth?: string }[] = [];
    const upstreamSockets = new Set<Socket>();
    const transmissions: Transport[] = [];
    const releaseFirstReply = latch();
    const keys = await modelTlsCertificate(lab.root).catch(
      async (error: unknown) => {
        await lab.close();
        throw error;
      },
    );
    let supplierReply = releaseFirstReply.wait;
    let rateLimit = false;
    let supplierRequests = 0;
    const supplier = httpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
        supplierRequests++;
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          arrivals.push({
            body: JSON.parse(Buffer.concat(chunks).toString()),
            auth: request.headers.authorization,
          });
          if (rateLimit) {
            rateLimit = false;
            response.writeHead(429, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                error: { message: 'Synthetic complete rate limit' },
              }),
            );
            return;
          }
          await supplierReply;
          const frame = {
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
          };
          const choices = [
            {
              index: 0,
              delta: { role: 'assistant', content: reply },
              finish_reason: null,
            },
            { index: 0, delta: {}, finish_reason: 'stop' },
          ];
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(
              choices
                .map(
                  (choice) =>
                    'data: ' +
                    JSON.stringify({ ...frame, choices: [choice] }) +
                    '\n\n',
                )
                .join('') + 'data: [DONE]\n\n',
            );
        } catch {
          response.destroy();
        }
      },
    );
    let supplierPort = 0;
    const proxy = createServer((client) => {
      const upstream = connect(supplierPort, '127.0.0.1');
      const observation = { count: false, bytes: 0, closed: false };
      transmissions.push(observation);
      upstreamSockets.add(client).add(upstream);
      client.on('data', (data: Buffer) => {
        if (observation.count) observation.bytes += data.length;
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.once('close', () => {
        observation.closed = true;
        upstreamSockets.delete(client);
        upstream.destroy();
      });
      upstream.once('close', () => {
        upstreamSockets.delete(upstream);
        client.destroy();
      });
      client.pipe(upstream).pipe(client);
    });
    const config = join(lab.root, 'config', 'projects', 'poc', 'dsh');
    const profile = join(config, 'profiles', 'rdws');
    const gates = observeTransactions(() => transmissions.at(-1));
    let app: ReturnType<typeof buildApp> | undefined;
    const releases: Array<() => void> = [releaseFirstReply.release];
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
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      supplierPort = (supplier.address() as { port: number }).port;
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      const url =
        'https://127.0.0.1:' +
        (proxy.address() as { port: number }).port +
        '/v1';
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: credentialMarker },
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
                  baseURL: url,
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: model }, { id: otherModel }],
                  retryPolicy: {
                    mode: 'normal',
                    maxRetries: 1,
                    backoff: {
                      initialDelayMs: retryDelayMs,
                      maxDelayMs: retryDelayMs,
                      jitterRatio: 0,
                    },
                  },
                },
                [otherProvider]: {
                  api: 'openai-completions',
                  baseURL: url,
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: model }],
                },
              },
            },
          },
          { id: 'session-title-llm', disabled: true },
        ]),
        { mode: 0o600 },
      );
      await lab.owner.query(
        "insert into project(id,name) values('poc','Synthetic project')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','model@fixture.invalid','fixture_model',true)",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(pass)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Fixture manager','manager@fixture.invalid','fixture_manager',true,true)",
        [managerId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), managerId, await hashPassword(pass)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'project_admin')",
        [managerId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Synthetic task','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      setDefaultCACertificates([...originalCAs, keys.cert.toString()]);
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      let bff = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin: base,
        nativeRuntimeRoot: lab.root,
        authorityTicket: ticket,
        mainModelPolicy: {
          projectId: 'poc',
          provider,
          model,
          destination: url + '/chat/completions',
        },
      });
      app = bff;
      await bff.ready();
      async function login(username = 'fixture_model') {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin: base },
          payload: { username, password: pass },
        });
        expect(response.statusCode).toBe(200);
        const cookie = response.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        const id = await observedLogin(bff, cookie);
        const binding = await bootstrapNative(bff, cookie, requirementId);
        return { cookie, id, binding };
      }
      type Login = Awaited<ReturnType<typeof login>>;
      async function create({ cookie, id }: Login) {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/requirements/' + requirementId + '/sessions',
          headers: { cookie, origin: base, 'x-rdws-edit-session': id },
          payload: { commandId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ sessionId: string }>().sessionId;
      }
      function rpc(login: Login, method: string, request?: object) {
        return bff.inject({
          method: 'POST',
          url: `/api/dsh/${requirementId}/native/api/session/${method}`,
          headers: {
            cookie: login.cookie,
            origin: base,
            'x-rdws-native-login': login.binding,
            'x-rdws-client-generation': randomUUID(),
          },
          payload: {
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/' + method,
            payload: { args: request ? { request } : {} },
          },
        });
      }
      const prompt = (
        login: Login,
        sessionId: string,
        text: string,
        requestId = randomUUID(),
        mode: 'queue' | 'steer' = 'queue',
      ) =>
        rpc(login, 'prompt', {
          sessionId,
          mode,
          requestId,
          content: [{ type: 'text', text }],
        });
      const logout = ({ cookie, id }: Login) =>
        Promise.resolve(
          bff.inject({
            method: 'POST',
            url: '/api/auth/sign-out',
            headers: { cookie, origin: base, 'x-rdws-edit-session': id },
          }),
        );
      const events = (login: Login, sessionId: string) =>
        rpc(login, 'events', { address: { kind: 'session', sessionId } });
      type Catalog = {
        default: { provider: string; model: string };
        groups: { id: string; models: { id: string }[] }[];
        routableProviders: string[];
        failures: { id: string; name: string; message: string }[];
      };
      async function readCatalog(login: Login): Promise<Catalog> {
        const response = await rpc(login, 'modelCatalog');
        expect(response.statusCode).toBe(200);
        const result = response.json().result;
        expect(result.ok).toBe(true);
        return result.value;
      }
      const listedModels = (catalog: Catalog) =>
        catalog.groups.map(({ id, models }) => [
          id,
          models.map((entry) => entry.id),
        ]);
      async function nativeLastUsed(login: Login, sessionId: string) {
        const response = await rpc(login, 'projections', { sessionId });
        expect(response.statusCode).toBe(200);
        const result = response.json().result;
        expect(result.ok).toBe(true);
        expect(result.value.kind).toBe('sequenced');
        return result.value.values.modelSelection?.lastUsed ?? null;
      }
      async function historyRecords(login: Login, sessionId: string) {
        const response = await events(login, sessionId);
        expect(response.statusCode).toBe(200);
        const value = response.json().result.value as {
          records: {
            event: {
              type: string;
              data: {
                reason?: { kind: string };
                delayMs?: number;
                turn?: number;
                step?: number;
                target?: string;
                source?: { rpcId?: string };
                inserted?: { source?: { rpcId?: string } }[];
              };
            };
          }[];
        };
        return value.records;
      }
      async function turnEnd(login: Login, sessionId: string) {
        const records = await historyRecords(login, sessionId);
        return records.find(({ event }) => event.type === 'turn/end')?.event
          .data.reason?.kind;
      }

      const before = await login(),
        after = await login(),
        observer = await login();
      const managedCatalog = await readCatalog(observer);
      expect(listedModels(managedCatalog)).toEqual([[provider, [model]]]);
      expect(managedCatalog.routableProviders).toEqual([provider]);

      const nativeFetch = NativeWebHost.prototype.fetch;
      let catalogCase: 'different-default' | 'missing-model' | 'unroutable' =
        'different-default';
      const override = vi
        .spyOn(NativeWebHost.prototype, 'fetch')
        .mockImplementation(async function (
          this: NativeWebHost,
          path,
          ...parameters
        ) {
          const response = await nativeFetch.call(this, path, ...parameters);
          if (path !== '/api/session/modelCatalog') return response;
          const envelope = await response.json();
          const catalog: Catalog = envelope.result.value;
          catalog.default = { provider, model: otherModel };
          if (catalogCase === 'missing-model')
            catalog.groups = catalog.groups.map((group) =>
              group.id === provider
                ? {
                    ...group,
                    models: group.models.filter(({ id }) => id !== model),
                  }
                : group,
            );
          if (catalogCase === 'unroutable') {
            catalog.routableProviders = [otherProvider];
            catalog.failures = [provider, otherProvider].map((id) => ({
              id,
              name: id,
              message: 'Synthetic provider diagnostic',
            }));
          }
          return Response.json(envelope);
        });
      try {
        const mismatched = await readCatalog(observer);
        expect(mismatched.default).toEqual({ provider, model: otherModel });
        expect(listedModels(mismatched)).toEqual([[provider, [model]]]);
        expect(mismatched.routableProviders).toEqual([provider]);
        catalogCase = 'missing-model';
        const unavailable = await readCatalog(observer);
        expect(unavailable).toEqual({
          default: { provider, model: otherModel },
          groups: [],
          routableProviders: [],
          failures: [],
        });
        catalogCase = 'unroutable';
        expect(await readCatalog(observer)).toEqual({
          ...unavailable,
          failures: [
            { id: provider, name: provider, message: '供应商模型目录暂不可用' },
          ],
        });
      } finally {
        override.mockRestore();
      }

      const deniedSession = await create(before);
      expect(await nativeLastUsed(observer, deniedSession)).toBeNull();
      const deniedGate = gates.arm('before-lock');
      releases.push(deniedGate.latch.release);
      expect(
        (await prompt(before, deniedSession, `${bodyMarker}: denied`)).json()
          .result.ok,
      ).toBe(true);
      await expect.poll(() => deniedGate.entered, retryTimeout).toBe(true);
      expect((await logout(before)).statusCode).toBe(200);
      deniedGate.latch.release();
      await expect.poll(() => deniedGate.wire?.closed).toBe(true);
      expect(deniedGate.wire?.bytes).toBe(0);
      expect(arrivals).toHaveLength(0);
      expect(supplierRequests).toBe(0);
      expect(await nativeLastUsed(observer, deniedSession)).toMatchObject({
        provider,
        model,
      });
      expect((await events(before, deniedSession)).statusCode).toBe(401);

      const sentSession = await create(after);
      const writtenGate = gates.arm('before-commit');
      releases.push(writtenGate.latch.release);
      expect(
        (await prompt(after, sentSession, bodyMarker)).json().result.ok,
      ).toBe(true);
      await expect
        .poll(() => writtenGate.wire?.bytes ?? 0, retryTimeout)
        .toBeGreaterThan(0);
      const revoking = logout(after);
      await expect
        .poll(
          async () =>
            (
              await lab.admin.query(
                `select exists(select 1 from pg_stat_activity where datname='rdws_test'
          and query like 'delete from "auth_session"%'
          and cardinality(pg_blocking_pids(pid)) > 0) as waiting`,
              )
            ).rows[0]?.waiting,
        )
        .toBe(true);
      writtenGate.latch.release();
      expect((await revoking).statusCode).toBe(200);
      releaseFirstReply.release();
      await expect
        .poll(async () => (await events(observer, sentSession)).body)
        .toContain(reply);
      await expect.poll(() => turnEnd(observer, sentSession)).toBe('completed');
      await expect.poll(() => writtenGate.wire?.closed).toBe(true);
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]?.auth).toBe('Bearer ' + credentialMarker);
      expect(JSON.stringify(arrivals[0]?.body)).toContain(bodyMarker);
      expect((await events(after, sentSession)).statusCode).toBe(401);
      const sentHistory = await events(observer, sentSession);
      expect(sentHistory.body).toContain(bodyMarker);
      expect(sentHistory.body.includes(credentialMarker)).toBe(false);

      supplierReply = Promise.resolve();
      const retrySession = await create(observer);
      const retryPrompt = 'Synthetic valid retry';
      rateLimit = true;
      expect(
        (await prompt(observer, retrySession, retryPrompt)).json().result.ok,
      ).toBe(true);
      await expect
        .poll(
          async () => (await events(observer, retrySession)).body,
          retryTimeout,
        )
        .toContain(reply);
      await expect
        .poll(() => turnEnd(observer, retrySession))
        .toBe('completed');
      expect(arrivals).toHaveLength(3);
      for (const arrival of arrivals.slice(1))
        expect(JSON.stringify(arrival.body)).toContain(retryPrompt);

      const unknownSession = await create(observer);
      const unknownGate = gates.arm('lose-commit');
      const unknownPrompt = `${bodyMarker}: unknown commit`;
      expect(
        (await prompt(observer, unknownSession, unknownPrompt)).json().result
          .ok,
      ).toBe(true);
      await expect
        .poll(async () => (await events(observer, unknownSession)).body)
        .toContain('本轮模型请求失败');
      await expect
        .poll(() => turnEnd(observer, unknownSession), retryTimeout)
        .toBe('error');
      expect(unknownGate.wire?.bytes).toBeGreaterThan(0);
      expect(arrivals).toHaveLength(4);
      expect(JSON.stringify(arrivals.at(-1)?.body)).toContain(unknownPrompt);

      const timeoutSession = await create(observer);
      const lock = await lab.owner.connect();
      try {
        await lock.query('begin');
        await lock.query('select id from auth_session where id=$1 for update', [
          observer.id,
        ]);
        expect(
          (
            await prompt(observer, timeoutSession, 'Synthetic lock timeout')
          ).json().result.ok,
        ).toBe(true);
        await expect
          .poll(() => turnEnd(observer, timeoutSession), retryTimeout)
          .toBe('error');
        expect(arrivals).toHaveLength(4);
      } finally {
        await lock.query('rollback');
        lock.release();
      }

      const backingOff = await login();
      const backoffSession = await create(backingOff);
      const backoffPrompt = `${bodyMarker}: revoked during backoff`;
      const arrivalsBeforeBackoff = arrivals.length;
      const requestsBeforeBackoff = supplierRequests;
      rateLimit = true;
      expect(
        (await prompt(backingOff, backoffSession, backoffPrompt)).json().result
          .ok,
      ).toBe(true);
      await expect
        .poll(
          async () =>
            (await historyRecords(observer, backoffSession)).find(
              ({ event }) => event.type === 'llm/retry',
            )?.event.data.delayMs,
          { interval: 40, timeout: retryTimeout.timeout },
        )
        .toBe(retryDelayMs);
      expect(arrivals).toHaveLength(arrivalsBeforeBackoff + 1);
      expect(JSON.stringify(arrivals.at(-1)?.body)).toContain(backoffPrompt);
      expect((await logout(backingOff)).statusCode).toBe(200);
      const afterLogout = await historyRecords(observer, backoffSession);
      expect(afterLogout.map(({ event }) => event.type)).not.toContain(
        'llm/retry-started',
      );
      await expect
        .poll(() => turnEnd(observer, backoffSession), retryTimeout)
        .toBeDefined();
      expect(arrivals).toHaveLength(arrivalsBeforeBackoff + 1);
      expect(supplierRequests).toBe(requestsBeforeBackoff + 1);
      expect(await turnEnd(observer, backoffSession)).toBe('error');

      for (const revokeRelatedLogin of [false, true]) {
        const earlier = await login();
        const latest = await login();
        const sessionId = await create(observer);
        const beforeBatch = arrivals.length;
        const beforeBatchRequests = supplierRequests;
        const firstStep = latch();
        releases.push(firstStep.release);
        supplierReply = firstStep.wait;
        expect(
          (
            await prompt(observer, sessionId, 'Synthetic batch first step')
          ).json().result.ok,
        ).toBe(true);
        await expect
          .poll(() => arrivals.length, retryTimeout)
          .toBe(beforeBatch + 1);
        const steering = [
          {
            login: earlier,
            body: 'Synthetic steering from earlier login',
            id: randomUUID(),
          },
          {
            login: latest,
            body: 'Synthetic steering from latest login',
            id: randomUUID(),
          },
        ];
        for (const input of steering)
          expect(
            (
              await prompt(
                input.login,
                sessionId,
                input.body,
                input.id,
                'steer',
              )
            ).json().result.ok,
          ).toBe(true);
        const queued = await historyRecords(latest, sessionId);
        expect(
          queued.flatMap(({ event }) =>
            event.type === 'agent/inbox/spliced' &&
            event.data.target === 'next-step'
              ? (event.data.inserted?.map(({ source }) => source?.rpcId) ?? [])
              : [],
          ),
        ).toEqual(steering.map(({ id }) => id));
        expect(queued.some(({ event }) => event.type === 'turn/end')).toBe(
          false,
        );
        expect(arrivals).toHaveLength(beforeBatch + 1);

        const nextStep = revokeRelatedLogin
          ? gates.arm('before-lock')
          : undefined;
        if (nextStep) releases.push(nextStep.latch.release);
        supplierReply = Promise.resolve();
        firstStep.release();
        if (nextStep) {
          await expect.poll(() => nextStep.entered, retryTimeout).toBe(true);
          const claimed = await historyRecords(latest, sessionId);
          const secondStepIndex = claimed.findIndex(
            ({ event }) =>
              event.type === 'step/start' &&
              event.data.turn === 1 &&
              event.data.step === 2,
          );
          expect(secondStepIndex).toBeGreaterThanOrEqual(0);
          expect(
            claimed.slice(secondStepIndex + 1).flatMap(({ event }) => {
              const requestId = event.data.source?.rpcId;
              return event.type === 'user/message' && requestId
                ? [requestId]
                : [];
            }),
          ).toEqual(steering.map(({ id }) => id));
          expect((await logout(earlier)).statusCode).toBe(200);
          expect((await events(earlier, sessionId)).statusCode).toBe(401);
          nextStep.latch.release();
          await expect.poll(() => nextStep.wire?.closed).toBe(true);
          expect(nextStep.wire?.bytes).toBe(0);
        }
        await expect
          .poll(() => turnEnd(latest, sessionId), retryTimeout)
          .toBeDefined();
        const finished = await historyRecords(latest, sessionId);
        expect(
          finished
            .filter(({ event }) => event.type === 'step/start')
            .map(({ event }) => [event.data.turn, event.data.step]),
        ).toEqual([
          [1, 1],
          [1, 2],
        ]);
        const requests = revokeRelatedLogin ? 1 : 2;
        expect(supplierRequests).toBe(beforeBatchRequests + requests);
        expect(arrivals).toHaveLength(beforeBatch + requests);
        if (!revokeRelatedLogin)
          for (const { body } of steering)
            expect(JSON.stringify(arrivals.at(-1)?.body)).toContain(body);
        expect((await turnEnd(latest, sessionId)) === 'completed').toBe(
          !revokeRelatedLogin,
        );
      }

      const shutdownSession = await create(observer);
      const shutdownId = randomUUID();
      const shutdownGate = gates.arm('before-commit');
      releases.push(shutdownGate.latch.release);
      expect(
        (
          await prompt(
            observer,
            shutdownSession,
            'Synthetic interrupted by shutdown',
            shutdownId,
          )
        ).json().result.ok,
      ).toBe(true);
      await expect
        .poll(() => shutdownGate.wire?.bytes ?? 0, retryTimeout)
        .toBeGreaterThan(0);
      const closing = bff.close();
      await expect.poll(() => shutdownGate.wire?.closed).toBe(true);
      const ownership = () =>
        lab.owner
          .query('select generation from rdws_authority.owner where singleton')
          .then(({ rows }) => rows[0]?.generation);
      expect(await ownership()).not.toBeNull();
      shutdownGate.latch.release();
      await closing;
      expect(await ownership()).toBeNull();
      const arrivalsAtShutdown = arrivals.length;

      const freshTicket = randomBytes(32).toString('hex');
      await lab.owner.query(
        'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
        [createHash('sha256').update(freshTicket).digest('hex')],
      );
      const restarted = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin: base,
        nativeRuntimeRoot: lab.root,
        authorityTicket: freshTicket,
        mainModelPolicy: {
          projectId: 'poc',
          provider,
          model,
          destination: url + '/chat/completions',
        },
      });
      app = restarted;
      bff = restarted;
      const rebound = await bootstrapNative(
        restarted,
        observer.cookie,
        requirementId,
      );
      const current = { ...observer, binding: rebound };
      const replay = await prompt(
        current,
        shutdownSession,
        'Synthetic interrupted by shutdown',
        shutdownId,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json().result).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
      expect(
        (
          await prompt(current, shutdownSession, 'Fresh key after cold boot')
        ).json().result.ok,
      ).toBe(true);
      await expect
        .poll(async () => (await events(current, shutdownSession)).body)
        .toContain(reply);
      const history = (await events(current, shutdownSession)).json().result
        .value.records as {
        event: {
          type: string;
          data: { inserted?: Array<{ source?: { rpcId?: string } }> };
        };
      }[];
      expect(
        history
          .flatMap(({ event }) =>
            event.type === 'agent/inbox/spliced'
              ? (event.data.inserted ?? [])
              : [],
          )
          .filter((message) => message.source?.rpcId === shutdownId),
      ).toHaveLength(1);
      expect(arrivals).toHaveLength(arrivalsAtShutdown + 1);
      expect(JSON.stringify(arrivals.at(-1)?.body)).toContain(
        'Fresh key after cold boot',
      );

      const manager = await login('fixture_manager');
      const manage = (command: object) =>
        bff.inject({
          method: 'POST',
          url: '/api/management/commands',
          headers: { cookie: manager.cookie, origin: base },
          payload: {
            ...command,
            username: 'fixture_model',
            commandId: randomUUID(),
          },
        });
      for (const command of [
        { kind: 'project.roles', projectId: 'poc', roles: [] },
        { kind: 'account.active', active: false },
      ]) {
        const active =
          command.kind === 'project.roles'
            ? current
            : {
                ...current,
                binding: await bootstrapNative(
                  bff,
                  current.cookie,
                  requirementId,
                ),
              };
        const sessionId = await create(active);
        const gate = gates.arm('before-lock');
        releases.push(gate.latch.release);
        const count = arrivals.length;
        expect(
          (
            await prompt(active, sessionId, 'Synthetic management revocation')
          ).json().result.ok,
        ).toBe(true);
        await expect.poll(() => gate.entered, retryTimeout).toBe(true);
        expect((await manage(command)).statusCode).toBe(200);
        gate.latch.release();
        await expect.poll(() => gate.wire?.closed).toBe(true);
        expect(gate.wire?.bytes).toBe(0);
        expect(arrivals).toHaveLength(count);
        if (command.kind === 'project.roles')
          expect(
            (await manage({ ...command, roles: ['developer'] })).statusCode,
          ).toBe(200);
      }
      for (const path of await readdir(join(lab.root, 'runtime'), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (path.isFile())
          expect(
            (await readFile(join(path.parentPath, path.name))).includes(
              credentialMarker,
            ),
          ).toBe(false);
      }

      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      const unavailableSession = await create(manager);
      const beforeOutage = arrivals.length;
      expect(
        (
          await prompt(
            manager,
            unavailableSession,
            `${bodyMarker}: unavailable outlet`,
          )
        ).json().result.ok,
      ).toBe(true);
      await expect
        .poll(() => turnEnd(manager, unavailableSession), retryTimeout)
        .toBe('error');
      expect(arrivals).toHaveLength(beforeOutage);

      await bff.close();
      const pauseTicket = randomBytes(32).toString('hex');
      await lab.owner.query(
        'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
        [createHash('sha256').update(pauseTicket).digest('hex')],
      );
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      bff = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin: base,
        nativeRuntimeRoot: lab.root,
        nativeProfiles: new Map([['poc', config]]),
        authorityTicket: pauseTicket,
      });
      app = bff;
      const paused = {
        ...manager,
        binding: await bootstrapNative(bff, manager.cookie, requirementId),
      };
      const pausedCatalog = await readCatalog(paused);
      expect(listedModels(pausedCatalog)).toEqual(
        expect.arrayContaining([
          [provider, [model, otherModel]],
          [otherProvider, [model]],
        ]),
      );
      expect(pausedCatalog.routableProviders).toEqual(
        expect.arrayContaining([provider, otherProvider]),
      );
      const rejected = await prompt(
        paused,
        unavailableSession,
        'Synthetic paused prompt',
      );
      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers['x-rdws-model-egress']).toBe('paused');
      expect(arrivals).toHaveLength(beforeOutage);
      await bff.close();
      app = undefined;
      const diagnostics = output.join('') + (await lab.logs());
      for (const marker of [credentialMarker, bodyMarker])
        expect(diagnostics.includes(marker)).toBe(false);
    } finally {
      releases.forEach((release) => release());
      try {
        await app?.close();
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        gates.restore();
        setDefaultCACertificates(originalCAs);
        for (const socket of upstreamSockets) socket.destroy();
        supplier.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => proxy.close(() => resolve())),
          new Promise<void>((resolve) => supplier.close(() => resolve())),
          lab.close(),
        ]);
      }
    }
  },
  60_000,
);

test.skipIf(process.platform !== 'darwin')(
  'a real Workbench Prompt submits one isolated tool and denies stale proof or release before TLS application bytes',
  async () => {
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    const lab = await authorityDatabase();
    const projectId = 'poc';
    const provider = 'rdws-glm';
    const model = 'fixture-tool-wire';
    const requirementId = randomUUID();
    const userId = randomUUID();
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const callId = 'call-rdws-wire-fixture';
    const toolName = 'rdws_authority_probe';
    type Message = { role: string; tool_call_id?: string; content?: unknown };
    type RequestBody = { messages: Message[]; tools?: unknown[] };
    type Event = {
      type: string;
      seq: number;
      sourceEventSeqs?: number[];
      data: {
        reason?: { kind: string };
        turn?: number;
        step?: number;
        callId?: string;
        message?: { toolCallId: string };
        inserted?: { source?: { rpcId?: string } }[];
      };
    };
    const requests: RequestBody[] = [];
    const transmissions: Transport[] = [];
    const sockets = new Set<Socket>();
    const gates = observeTransactions(() => transmissions.at(-1));
    const originalCAs = getCACertificates('default');
    const keys = await modelTlsCertificate(lab.root).catch(async (error) => {
      gates.restore();
      await lab.close();
      throw error;
    });
    const permits = vi.spyOn(NativeFixtureToolJob.prototype, 'offer');
    let wrongProjection = false;
    const history = NativeFixtureToolJob.prototype.history;
    const histories = vi
      .spyOn(NativeFixtureToolJob.prototype, 'history')
      .mockImplementation(function (this: NativeFixtureToolJob, value) {
        const original = history.call(this, value);
        return wrongProjection ? original + '-different' : original;
      });
    let shortenProof = false;
    let proofExpiresAt = 0;
    let wrongSignedHistory = false;
    const verify = NativeWebHost.prototype.verifyContext;
    const grants = vi
      .spyOn(NativeWebHost.prototype, 'verifyContext')
      .mockImplementation(function (this: NativeWebHost, token) {
        const cap = verify.call(this, token);
        if (!shortenProof || cap?.operation !== 'context-read') return cap;
        shortenProof = false;
        proofExpiresAt = Date.now() + 1100;
        return { ...cap, expiresAt: proofExpiresAt };
      });
    const configure = NativeWebHost.prototype.configureContext;
    const signedProofs = vi
      .spyOn(NativeWebHost.prototype, 'configureContext')
      .mockImplementation(function (this: NativeWebHost, handle) {
        configure.call(this, (input, token, reply) => {
          if (
            wrongSignedHistory &&
            isRecord(input) &&
            isRecord(input.fixtureToolHistory)
          ) {
            const grant = verify.call(this, token);
            if (grant?.operation === 'context-read') {
              const changed = {
                ...input,
                fixtureToolHistory: {
                  ...input.fixtureToolHistory,
                  callSeq: Number(input.fixtureToolHistory.callSeq) + 1,
                },
              };
              const testToken = signGrant(Reflect.get(this, 'key') as string, {
                ...grant,
                bodyHash: bodyHash(changed),
              });
              return handle(changed, testToken, reply);
            }
          }
          return handle(input, token, reply);
        });
      });
    const rawEvents = new Map<string, Event[]>();
    const fetch = NativeWebHost.prototype.fetch;
    const rawFeed = vi
      .spyOn(NativeWebHost.prototype, 'fetch')
      .mockImplementation(async function (this: NativeWebHost, path, ...args) {
        const response = await fetch.call(this, path, ...args);
        const body = args[1]?.body;
        if (
          path === '/api/session/events' &&
          response.ok &&
          typeof body === 'string'
        ) {
          const session =
            JSON.parse(body).payload.args.request.address.sessionId;
          const value = (await response.clone().json()).result?.value;
          if (value?.records)
            rawEvents.set(
              session,
              value.records.map(({ event }: { event: Event }) => event),
            );
        }
        return response;
      });
    let repeatCall = false;
    const supplier = httpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input = JSON.parse(
            Buffer.concat(chunks).toString(),
          ) as RequestBody;
          requests.push(input);
          const toolResult = input.messages.some(({ role }) => role === 'tool');
          const invoke = !!input.tools?.length || (toolResult && repeatCall);
          const delta = invoke
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: toolResult ? callId + '-second' : callId,
                    type: 'function',
                    function: { name: toolName, arguments: '{}' },
                  },
                ],
              }
            : { role: 'assistant', content: 'Synthetic fixture finished' };
          const frame = {
            id: 'tool-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model,
          };
          const choices = [
            { index: 0, delta, finish_reason: null },
            {
              index: 0,
              delta: {},
              finish_reason: invoke ? 'tool_calls' : 'stop',
            },
          ];
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(
              choices
                .map(
                  (choice) =>
                    'data: ' +
                    JSON.stringify({ ...frame, choices: [choice] }) +
                    '\n\n',
                )
                .join('') + 'data: [DONE]\n\n',
            );
        } catch {
          response.destroy();
        }
      },
    );
    const proxy = createServer((client) => {
      const upstream = connect(
        (supplier.address() as { port: number }).port,
        '127.0.0.1',
      );
      const observation = { count: false, bytes: 0, closed: false };
      transmissions.push(observation);
      sockets.add(client).add(upstream);
      client.on('data', (data: Buffer) => {
        if (observation.count) observation.bytes += data.length;
      });
      client
        .on('error', () => upstream.destroy())
        .once('close', () => {
          observation.closed = true;
          sockets.delete(client);
          upstream.destroy();
        });
      upstream
        .on('error', () => client.destroy())
        .once('close', () => {
          sockets.delete(upstream);
          client.destroy();
        });
      client.pipe(upstream).pipe(client);
    });
    let source: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    try {
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      const baseURL =
        'https://127.0.0.1:' +
        (proxy.address() as { port: number }).port +
        '/v1';
      setDefaultCACertificates([...originalCAs, keys.cert.toString()]);
      source = await httpsGitFixture(projectId);
      const { root } = source;
      mirrors = new RepositoryMirrors(root);
      trees = new DemandWorktrees(root, mirrors);
      await writeFile(join(source.work, 'sample.txt'), 'baseline');
      await fixtureGit(['-C', source.work, 'add', '--', 'sample.txt']);
      await source.commit();
      await source.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
        ...entry,
        branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
        worktreePath: 'worktrees/' + entry.repositoryId,
        gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
      }));
      await trees.prepare(projectId, requirementId, plan);
      const checkout = await trees.executionScope(
        projectId,
        requirementId,
        plan,
        'app',
      );
      const file = join(checkout.tree, 'sample.txt');
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: 'only-synthetic-tool-model' },
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
                  baseURL,
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: model }],
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      await lab.owner.query(
        "insert into project(id,name) values('poc','Synthetic tool project')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','tool@fixture.invalid','fixture_tool',true)",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Synthetic task','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [requirementId, JSON.stringify(plan)],
      );
      const receipts = async () =>
        (
          await lab.owner.query(
            "select command_id, result from command_receipt where scope=$1 and operation='write.execute'",
            ['requirement:' + requirementId],
          )
        ).rows;
      const lease = async () =>
        (
          await lab.owner.query(
            'select phase, generation, run_id from requirement_write_lease where requirement_id=$1',
            [requirementId],
          )
        ).rows[0];
      const gitPath = execFileSync('/usr/bin/which', ['git'], {
        encoding: 'utf8',
      }).trim();
      const scenarios = [
        'complete',
        'repeat-call',
        'before-lock',
        'with-lease-lock',
        'expired-proof',
        'signed-mismatch',
        'body-mismatch',
        'shutdown-job',
      ] as const;
      for (const [index, scenario] of scenarios.entries()) {
        const ticket = randomBytes(32).toString('hex');
        await lab.owner.query(
          'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
          [createHash('sha256').update(ticket).digest('hex')],
        );
        const bff = buildApp({
          databaseUrl: lab.databaseUrl,
          origin,
          secret: lab.childEnv.BETTER_AUTH_SECRET!,
          authorityTicket: ticket,
          repositoryHome: root,
          nativeRuntimeRoot: root,
          mainModelPolicy: {
            projectId,
            provider,
            model,
            destination: baseURL + '/chat/completions',
          },
          isolatedWrite: { gitPath, fixtureTool: true },
        });
        let gate: ReturnType<typeof gates.arm> | undefined;
        let settlement: ReturnType<typeof gates.holdSettlement> | undefined;
        try {
          await bff.ready();
          const broker = bff.getDecorator<() => FixtureToolArm['broker']>(
            'isolatedWriteHandoff',
          )();
          const signin = await bff.inject({
            method: 'POST',
            url: '/api/auth/sign-in/username',
            remoteAddress: `192.0.2.${190 + index}`,
            headers: { origin },
            payload: { username: 'fixture_tool', password },
          });
          expect(signin.statusCode).toBe(200);
          const cookie = signin.cookies
            .map(({ name, value }) => name + '=' + value)
            .join('; ');
          const authSessionId = await observedLogin(bff, cookie);
          const binding = await bootstrapNative(bff, cookie, requirementId);
          async function create() {
            const response = await bff.inject({
              method: 'POST',
              url: '/api/requirements/' + requirementId + '/sessions',
              headers: { cookie, origin, 'x-rdws-edit-session': authSessionId },
              payload: { commandId: randomUUID() },
            });
            expect(response.statusCode, response.body).toBe(200);
            return response.json<{ sessionId: string }>().sessionId;
          }
          async function rpc(method: string, request: object) {
            const response = await bff.inject({
              method: 'POST',
              url: `/api/dsh/${requirementId}/native/api/session/${method}`,
              headers: {
                cookie,
                origin,
                'x-rdws-native-login': binding,
                'x-rdws-client-generation': randomUUID(),
              },
              payload: {
                type: 'client-request',
                rpcId: randomUUID(),
                method: 'session/' + method,
                payload: { args: { request } },
              },
            });
            expect(response.statusCode, response.body).toBe(200);
            const result = response.json().result;
            expect(result.ok, JSON.stringify(result)).toBe(true);
            return result.value;
          }
          const sessionId = await create();
          const sibling = scenario === 'complete' ? await create() : undefined;
          const scope = {
            who: { userId, authSessionId },
            projectId,
            requirementId,
            sessionId,
          };
          const grant = await broker.acquire(scope, randomUUID());
          const requestId = randomUUID();
          bff.getDecorator<(input: Omit<FixtureToolArm, 'broker'>) => void>(
            'armIsolatedNativeTool',
          )({ scope, grant, requestId });
          const prompt = (sessionId: string, key = requestId) =>
            rpc('prompt', {
              sessionId,
              mode: 'queue',
              requestId: key,
              content: [
                { type: 'text', text: 'Synthetic Workbench tool probe' },
              ],
            });
          const events = async (id = sessionId): Promise<Event[]> =>
            (
              await rpc('events', {
                address: { kind: 'session', sessionId: id },
              })
            ).records.map(({ event }: { event: Event }) => event);
          const finished = async (id = sessionId) =>
            (await events(id)).find(({ type }) => type === 'turn/end')?.data
              .reason?.kind;
          if (sibling) {
            requests.length = 0;
            await prompt(sibling);
            await expect.poll(() => finished(sibling)).toBe('completed');
            expect(requests).toHaveLength(1);
            expect(requests[0]!.tools ?? []).toEqual([]);
            expect(await receipts()).toEqual([]);
          }
          requests.length = 0;
          permits.mockClear();
          histories.mockClear();
          repeatCall = scenario === 'repeat-call';
          wrongSignedHistory = scenario === 'signed-mismatch';
          wrongProjection = scenario === 'body-mismatch';
          const before = await readFile(file, 'utf8');
          const receiptCount = (await receipts()).length;
          const socketsBefore = transmissions.length;
          if (scenario === 'shutdown-job') {
            settlement = gates.holdSettlement(
              () => permits.mock.results[0]?.value,
            );
          }
          if (scenario === 'before-lock' || scenario === 'with-lease-lock')
            gate = gates.arm(scenario);
          if (scenario === 'expired-proof') {
            shortenProof = true;
            gate = gates.arm('before-lock');
          }
          await prompt(sessionId);
          if (settlement) {
            await expect
              .poll(() => settlement?.entered, { timeout: 5000 })
              .toBe(true);
            const owner = async () =>
              (
                await lab.owner.query(
                  'select generation from rdws_authority.owner where singleton',
                )
              ).rows[0]?.generation;
            const originalOwner = await owner();
            const originalRun = (await lease()).run_id;
            expect(originalOwner).toEqual(expect.any(String));
            expect(originalRun).toEqual(expect.any(String));
            const closing = bff.close();
            void closing.catch(() => {});
            expect(await owner()).toBe(originalOwner);
            expect(await lease()).toMatchObject({
              generation: grant.generation,
              run_id: originalRun,
            });
            const commandId = permits.mock.results[0]?.value;
            expect(commandId).toEqual(expect.any(String));
            expect(
              (await receipts()).find(
                ({ command_id }) => command_id === commandId,
              )?.result,
            ).toMatchObject({
              status: 'reserved',
              runId: originalRun,
            });
            settlement.latch.release();
            await closing;
            expect(await owner()).toBeNull();
            expect(await lease()).toMatchObject({
              phase: 'released',
              run_id: null,
            });
            expect(
              (await receipts()).find(
                ({ command_id }) => command_id === commandId,
              )?.result,
            ).toMatchObject({
              status: 'finished',
              runId: originalRun,
              result: { status: 'ok', stop: 'confirmed' },
            });
            expect(requests).toHaveLength(1);
            expect(await readFile(file, 'utf8')).toBe(
              before + '|workbench-tool',
            );
          } else if (gate) {
            await expect
              .poll(() => gate?.entered, { timeout: 4000, interval: 15 })
              .toBe(true);
            if (scenario === 'expired-proof') {
              expect(proofExpiresAt).toBeGreaterThan(Date.now());
              await delay(proofExpiresAt - Date.now() + 5);
              expect(await lease()).toMatchObject({
                phase: 'held',
                generation: grant.generation,
                run_id: null,
              });
              broker.assertWireLease(
                scope,
                grant.generation,
                grant.contextVersion,
              );
              gate.latch.release();
            } else {
              const release = broker.release(
                scope,
                grant.generation,
                randomUUID(),
              );
              if (scenario === 'before-lock') {
                await release;
                expect(await lease()).toMatchObject({
                  phase: 'released',
                  generation: grant.generation,
                });
              } else {
                expect(await lease()).toMatchObject({
                  phase: 'held',
                  generation: grant.generation,
                  run_id: null,
                });
                await expect
                  .poll(
                    () => {
                      try {
                        broker.assertWireLease(
                          scope,
                          grant.generation,
                          grant.contextVersion,
                        );
                        return '';
                      } catch (error) {
                        return (error as Error).message;
                      }
                    },
                    { timeout: 500, interval: 10 },
                  )
                  .toBe('写入授权正在变更或已到期');
              }
              gate.latch.release();
              await release;
              expect(await lease()).toMatchObject({
                phase: 'released',
                generation: grant.generation,
              });
            }
            await expect.poll(() => gate?.wire?.closed).toBe(true);
            expect(gate.wire?.bytes).toBe(0);
            expect(requests).toEqual([]);
            expect(await observedLogin(bff, cookie)).toBe(authSessionId);
            await expect
              .poll(() => finished(), { timeout: 5000 })
              .toBe('error');
            expect(await readFile(file, 'utf8')).toBe(before);
            expect(await receipts()).toHaveLength(receiptCount);
            expect(permits).not.toHaveBeenCalled();
          } else if (wrongSignedHistory || wrongProjection) {
            await expect
              .poll(() => finished(), { timeout: 5000 })
              .toBe(wrongSignedHistory ? 'blocked' : 'error');
            expect(requests).toHaveLength(1);
            expect(transmissions.slice(socketsBefore)).toHaveLength(1);
            expect(permits).toHaveBeenCalledTimes(1);
            expect(histories).toHaveBeenCalledTimes(1);
            expect(histories.mock.results[0]?.type).toBe(
              wrongSignedHistory ? 'throw' : 'return',
            );
            expect(await readFile(file, 'utf8')).toBe(
              before + '|workbench-tool',
            );
            expect(await receipts()).toHaveLength(receiptCount + 1);
          } else {
            await expect
              .poll(() => finished(), { timeout: 5000 })
              .toBe(repeatCall ? 'blocked' : 'completed');
            expect(requests).toHaveLength(2);
            expect(requests[0]!.tools).toHaveLength(1);
            expect(requests[1]!.tools ?? []).toEqual([]);
            expect(
              requests[1]!.messages.filter(({ role }) => role === 'tool'),
            ).toEqual([
              {
                role: 'tool',
                tool_call_id: callId,
                content: 'RDWS fixture worktree state: ok',
              },
            ]);
            expect(permits).toHaveBeenCalledTimes(1);
            const nativeCall = permits.mock.calls[0]!;
            expect(nativeCall.at(-2)).toBe(callId);
            expect(histories).toHaveBeenCalledTimes(1);
            const raw = rawEvents.get(sessionId)!;
            const call = raw.find(({ type }) => type === 'tool/call')!;
            const result = raw.find(({ type }) => type === 'tool/result')!;
            expect(call.data).toMatchObject({ callId, turn: 1, step: 1 });
            expect(result).toMatchObject({
              sourceEventSeqs: [call.seq],
              data: { message: { toolCallId: callId }, turn: 1, step: 1 },
            });
            expect(histories.mock.calls[0]![0]).toEqual({
              callId,
              callSeq: call.seq,
              resultSeq: result.seq,
            });
            expect(nativeCall.at(-1)).toBe(call.seq);
            if (!repeatCall) {
              await prompt(sessionId);
              const sentinel = randomUUID();
              await prompt(sessionId, sentinel);
              await expect
                .poll(
                  async () => {
                    await events();
                    return rawEvents
                      .get(sessionId)
                      ?.filter(({ type }) => type === 'turn/end').length;
                  },
                  { timeout: 5000 },
                )
                .toBe(2);
              const inserted = rawEvents
                .get(sessionId)
                ?.flatMap(({ type, data }) =>
                  type === 'agent/inbox/spliced' ? (data.inserted ?? []) : [],
                )
                .map(({ source }) => source?.rpcId);
              expect(inserted?.filter((id) => id === requestId)).toHaveLength(
                1,
              );
              expect(inserted?.filter((id) => id === sentinel)).toHaveLength(1);
            }
            expect(await readFile(file, 'utf8')).toBe(
              before + '|workbench-tool',
            );
            const rows = await receipts();
            expect(rows).toHaveLength(receiptCount + 1);
            expect(
              rows.find(
                ({ command_id }) =>
                  command_id === permits.mock.results[0]?.value,
              ),
            ).toMatchObject({
              result: {
                status: 'finished',
                result: { status: 'ok', stop: 'confirmed' },
              },
            });
            expect(requests).toHaveLength(2);
          }
        } finally {
          gate?.latch.release();
          settlement?.latch.release();
          await bff.close();
        }
      }
    } finally {
      gates.restore();
      permits.mockRestore();
      histories.mockRestore();
      grants.mockRestore();
      signedProofs.mockRestore();
      rawFeed.mockRestore();
      setDefaultCACertificates(originalCAs);
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => supplier.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        trees?.close(),
        mirrors?.close(),
      ]);
      await Promise.all([source?.close(), lab.close()]);
    }
  },
  90_000,
);
