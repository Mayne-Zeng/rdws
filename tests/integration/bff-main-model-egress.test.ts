import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { buildApp } from '@rdws/server';
import { afterEach, expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}

type Transport = { count: boolean; bytes: number; closed: boolean };
type Gate = 'before-lock' | 'before-commit' | 'lose-commit';

function observeTransactions(latest: () => Transport | undefined) {
  let next:
    | {
        phase: Gate;
        latch: ReturnType<typeof latch>;
        wire?: Transport;
        entered: boolean;
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
          gate.entered = true;
          if (gate.phase === 'before-lock') return gate.latch.wait.then(run);
        }
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (text === 'commit' && gate?.phase === 'before-commit')
          return gate.latch.wait.then(run);
        if (text === 'commit' && gate?.phase === 'lose-commit')
          return run().then(() => {
            throw new Error('Synthetic write acknowledgement lost');
          });
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
    const requirementId = randomUUID(),
      userId = randomUUID(),
      managerId = randomUUID();
    const credentialMarker = 'only-test-model-credential';
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
    const supplier = httpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
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
      function rpc(login: Login, method: string, request: object) {
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
            payload: { args: { request } },
          },
        });
      }
      const prompt = (
        login: Login,
        sessionId: string,
        text: string,
        requestId = randomUUID(),
      ) =>
        rpc(login, 'prompt', {
          sessionId,
          mode: 'queue',
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
      async function turnEnd(login: Login, sessionId: string) {
        const response = await events(login, sessionId);
        const value = response.json().result.value as {
          records: {
            event: { type: string; data: { reason?: { kind: string } } };
          }[];
        };
        return value?.records.find(({ event }) => event.type === 'turn/end')
          ?.event.data.reason?.kind;
      }

      const before = await login(),
        after = await login(),
        observer = await login();
      const deniedSession = await create(before);
      const deniedGate = gates.arm('before-lock');
      releases.push(deniedGate.latch.release);
      expect(
        (await prompt(before, deniedSession, 'Synthetic never sent')).json()
          .result.ok,
      ).toBe(true);
      await expect.poll(() => deniedGate.entered).toBe(true);
      expect((await logout(before)).statusCode).toBe(200);
      deniedGate.latch.release();
      await expect.poll(() => deniedGate.wire?.closed).toBe(true);
      expect(deniedGate.wire?.bytes).toBe(0);
      expect(arrivals).toHaveLength(0);
      expect((await events(before, deniedSession)).statusCode).toBe(401);

      const sentSession = await create(after);
      const writtenGate = gates.arm('before-commit');
      releases.push(writtenGate.latch.release);
      expect(
        (
          await prompt(after, sentSession, 'Synthetic body before revoke')
        ).json().result.ok,
      ).toBe(true);
      await expect.poll(() => writtenGate.wire?.bytes ?? 0).toBeGreaterThan(0);
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
      expect(JSON.stringify(arrivals[0]?.body)).toContain(
        'Synthetic body before revoke',
      );
      expect((await events(after, sentSession)).statusCode).toBe(401);

      supplierReply = Promise.resolve();
      const retrySession = await create(observer);
      rateLimit = true;
      expect(
        (await prompt(observer, retrySession, 'Synthetic valid retry')).json()
          .result.ok,
      ).toBe(true);
      await expect
        .poll(async () => (await events(observer, retrySession)).body)
        .toContain(reply);
      await expect
        .poll(() => turnEnd(observer, retrySession))
        .toBe('completed');
      expect(arrivals).toHaveLength(3);

      const unknownSession = await create(observer);
      const unknownGate = gates.arm('lose-commit');
      expect(
        (
          await prompt(observer, unknownSession, 'Synthetic unknown commit')
        ).json().result.ok,
      ).toBe(true);
      await expect
        .poll(async () => (await events(observer, unknownSession)).body)
        .toContain('本轮模型请求失败');
      await expect.poll(() => turnEnd(observer, unknownSession)).toBe('error');
      expect(unknownGate.wire?.bytes).toBeGreaterThan(0);
      expect(arrivals).toHaveLength(4);

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
          .poll(() => turnEnd(observer, timeoutSession), { timeout: 4500 })
          .toBe('error');
        expect(arrivals).toHaveLength(4);
      } finally {
        await lock.query('rollback');
        lock.release();
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
      await expect.poll(() => shutdownGate.wire?.bytes ?? 0).toBeGreaterThan(0);
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
        await expect.poll(() => gate.entered).toBe(true);
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
            'Synthetic unavailable outlet',
          )
        ).json().result.ok,
      ).toBe(true);
      await expect
        .poll(() => turnEnd(manager, unavailableSession), { timeout: 4500 })
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
      const rejected = await prompt(
        paused,
        unavailableSession,
        'Synthetic paused prompt',
      );
      expect(rejected.statusCode).toBe(503);
      expect(rejected.headers['x-rdws-model-egress']).toBe('paused');
      expect(arrivals).toHaveLength(beforeOutage);
    } finally {
      releases.forEach((release) => release());
      try {
        await app?.close();
      } finally {
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
