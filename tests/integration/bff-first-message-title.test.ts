import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:https';
import { connect, createServer as createProxy, type Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { expect, test, vi } from 'vitest';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { release, wait };
}

type Wire = { count: boolean; bytes: number; closed: boolean };
type SessionEvent = {
  type: string;
  seq: number;
  data: { source?: { kind: string }; messageSeqs?: number[] };
};
type TitleGate = ReturnType<typeof latch> & {
  wire?: Wire;
  settled: boolean;
  prepare: ReturnType<typeof latch>;
  prepareEntered: boolean;
  preparedAfterRelease?: boolean;
};

test.skipIf(process.platform !== 'darwin')(
  'the formal BFF orders Native first-message title writes with normal release, cancellation and login revocation',
  async () => {
    const lab = await authorityDatabase();
    const ca = getCACertificates('default');
    const keys = await modelTlsCertificate(lab.root).catch(
      async (error: unknown) => {
        await lab.close();
        throw error;
      },
    );
    const provider = 'rdws-glm';
    const model = 'fixture-model';
    const title = 'Synthetic session title';
    const privateFailure = 'fixture-title-private-upstream-diagnostic';
    const credentialMarker = 'synthetic-title-only';
    const arrivals: ('main' | 'title')[] = [];
    const connections: Wire[] = [];
    const sockets = new Set<Socket>();
    let supplierPort = 0;
    const proxy = createProxy((socket) => {
      const upstream = connect(supplierPort, '127.0.0.1');
      const wire = { count: false, bytes: 0, closed: false };
      connections.push(wire);
      sockets.add(socket).add(upstream);
      socket.on('data', (chunk: Buffer) => {
        if (wire.count) wire.bytes += chunk.length;
      });
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => {
        wire.closed = true;
        sockets.delete(socket);
        upstream.destroy();
      });
      upstream.once('close', () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      socket.pipe(upstream).pipe(socket);
    });
    let heldTitleResponse: ReturnType<typeof latch> | undefined;
    let supplierRequests = 0;
    let titleCredentialObserved = false;
    let titleResponse: 'ok' | '429' | 'sse-error' = 'ok';
    const supplier = createServer(keys, async (request, response) => {
      supplierRequests++;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString();
        const isTitle = text.includes('Create a concise title');
        arrivals.push(isTitle ? 'title' : 'main');
        if (
          isTitle &&
          request.headers.authorization === 'Bearer ' + credentialMarker
        )
          titleCredentialObserved = true;
        if (isTitle) await heldTitleResponse?.wait;
        if (isTitle && titleResponse === '429') {
          response
            .writeHead(429, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { message: privateFailure } }));
          return;
        }
        if (isTitle && titleResponse === 'sse-error') {
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(
              'data: ' +
                JSON.stringify({ error: { message: privateFailure } }) +
                '\n\n',
            );
          return;
        }
        const frames = [
          {
            delta: {
              role: 'assistant',
              content: isTitle ? title : 'Synthetic reply',
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'stop' },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
          frames
            .map(
              (frame) =>
                'data: ' +
                JSON.stringify({
                  id: 'fixture',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model,
                  choices: [{ index: 0, ...frame }],
                }) +
                '\n\n',
            )
            .join('') + 'data: [DONE]\n\n',
        );
      } catch {
        response.destroy();
      }
    });
    let app: ReturnType<typeof buildApp> | undefined;
    const native: { current?: NativeWebHost } = {};
    const normalReleases = new Set<string>();
    const gates = new Map<string, TitleGate>();
    const diagnostics: string[] = [];
    const collect = (chunk: unknown) => {
      diagnostics.push(String(chunk));
      return true;
    };
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(collect);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(collect);
    const watched = new WeakSet<ChildProcess>();
    const originalFetch = NativeWebHost.prototype.fetch;
    const fetch = vi
      .spyOn(NativeWebHost.prototype, 'fetch')
      .mockImplementation(function (this: NativeWebHost, ...args) {
        native.current = this;
        const child = Reflect.get(this, 'process') as ChildProcess | undefined;
        if (child?.stderr && !watched.has(child)) {
          watched.add(child);
          child.stderr.on('data', collect);
        }
        return originalFetch.apply(this, args);
      });
    const handle = ContextRuns.prototype.handle;
    const handleSpy = vi
      .spyOn(ContextRuns.prototype, 'handle')
      .mockImplementation(async function (this: ContextRuns, ...args) {
        const { sessionId, titleDisposition, callId } = args[0] as {
          sessionId: string;
          titleDisposition?: string;
          callId?: string;
        };
        const gate = gates.get(sessionId);
        if (callId && gate) {
          gate.prepareEntered = true;
          await gate.prepare.wait;
        }
        const result = await handle.apply(this, args);
        if (titleDisposition === 'normal') {
          normalReleases.add(sessionId);
        }
        if (callId && gate)
          gate.preparedAfterRelease = normalReleases.has(sessionId);
        return result;
      });
    const authorize = ContextRuns.prototype.authorizeModelWireAttempt;
    const authorizeSpy = vi
      .spyOn(ContextRuns.prototype, 'authorizeModelWireAttempt')
      .mockImplementation(async function (this: ContextRuns, ...args) {
        const { purpose, sessionId } = args[0].call;
        const gate =
          purpose === 'session-title' && sessionId
            ? gates.get(sessionId)
            : undefined;
        if (gate) {
          gate.wire = connections.at(-1);
          if (!gate.wire) throw new Error('Synthetic title TCP is missing');
          gate.wire.count = true;
          await gate.wait;
        }
        try {
          return await authorize.apply(this, args);
        } finally {
          if (gate) gate.settled = true;
        }
      });
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
      const config = join(lab.root, 'config/projects/poc/dsh');
      const profile = join(config, 'profiles/rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const probeModule = join(profile, 'title-fixture.mjs');
      const commandFile = join(lab.root, 'title-fixture-command.json');
      const resultFile = join(lab.root, 'title-fixture-response.txt');
      await writeFile(
        probeModule,
        `
import { readFile, unlink, writeFile } from 'node:fs/promises';
export const inject = ['sessionTitle', 'sessions', 'agents'];
export function apply(ctx, { commandFile, resultFile }) {
  const handles = new Map();
  const agents = ctx.agents;
  const create = agents.create;
  agents.create = async function (...args) {
    const handle = await create.apply(this, args);
    handles.set(String(handle.agent.id), handle);
    return handle;
  };
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const command = await readFile(commandFile, 'utf8').catch(() => undefined);
      if (!command) return;
      await unlink(commandFile);
      const { operation, sessionId } = JSON.parse(command);
      if (operation === 'refresh') {
        const session = ctx.sessions.get(sessionId);
        if (!session) throw new Error();
        try {
          await ctx.sessionTitle.refresh(session);
          await writeFile(resultFile, 'refresh-accepted');
        } catch (error) {
          await writeFile(resultFile, error.message === 'Manual title generation is disabled in this managed runtime' ? 'refresh-disabled' : 'refresh-failed');
        }
      } else if (operation === 'dispose') {
        const handle = handles.get(sessionId);
        if (!handle) {
          await writeFile(resultFile, 'agent-handle-missing');
          return;
        }
        await handle.dispose();
        handles.delete(sessionId);
        await writeFile(resultFile, 'agent-disposed');
      }
    } catch {
      await writeFile(resultFile, 'fixture-command-failed');
    } finally {
      running = false;
    }
  }, 20).unref();
  ctx.effect(() => () => {
    agents.create = create;
    clearInterval(interval);
  });
}
`,
        { mode: 0o600 },
      );
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: credentialMarker },
        }),
        { mode: 0o600 },
      );
      const writeProfile = (titlePatch: object[] = []) =>
        writeFile(
          join(profile, 'cordis.patch.yml'),
          JSON.stringify([
            {
              insert: [
                {
                  id: 'fixture-title-actions',
                  name: probeModule,
                  config: { commandFile, resultFile },
                },
              ],
            },
            {
              id: 'session-persistence-jsonl',
              config: {
                root: join(lab.root, 'runtime/dsh/project-poc/sessions'),
                compression: 'none',
              },
            },
            {
              id: 'llm-pi-ai',
              config: {
                providers: {
                  [provider]: {
                    api: 'openai-completions',
                    baseURL: url,
                    apiKeyEnv: 'FIXTURE_MODEL',
                    models: [{ id: model }],
                  },
                },
              },
            },
            ...titlePatch,
          ]),
          { mode: 0o600 },
        );
      await writeProfile();
      const userId = randomUUID();
      const requirementId = randomUUID();
      const ticket = randomBytes(32).toString('hex');
      const password = randomBytes(18).toString('hex');
      await lab.owner.query(
        "insert into project(id,name) values('poc','Synthetic project')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','title@fixture.invalid','fixture_title',true)",
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
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      await lab.owner.query(`
        create function expire_fixture_title_login() returns trigger language plpgsql as $$
        begin
          if new.user_agent = 'rdws-title-expiry-fixture' then
            if tg_op = 'INSERT' then
              new.expires_at := clock_timestamp() + interval '4 seconds';
            else
              new.expires_at := old.expires_at;
            end if;
          end if;
          return new;
        end $$;
        create trigger expire_fixture_title_login before insert or update on auth_session
          for each row execute function expire_fixture_title_login();
      `);
      setDefaultCACertificates([...ca, keys.cert.toString()]);
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      const origin = lab.childEnv.RDWS_ORIGIN!;
      const start = (authorityTicket: string, enabled: boolean) =>
        buildApp({
          databaseUrl: lab.databaseUrl,
          secret: lab.childEnv.BETTER_AUTH_SECRET!,
          origin,
          nativeRuntimeRoot: lab.root,
          authorityTicket,
          mainModelPolicy: {
            projectId: 'poc',
            provider,
            model,
            destination: url + '/chat/completions',
            ...(enabled && { firstMessageTitle: true }),
          },
        });
      let bff = start(ticket, true);
      app = bff;
      await bff.ready();
      async function signIn(userAgent?: string) {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin, ...(userAgent && { 'user-agent': userAgent }) },
          payload: { username: 'fixture_title', password },
        });
        expect(response.statusCode).toBe(200);
        const cookie = response.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        return {
          cookie,
          login: await observedLogin(bff, cookie),
          binding: await bootstrapNative(bff, cookie, requirementId),
        };
      }
      type Login = Awaited<ReturnType<typeof signIn>>;
      const observer = await signIn();
      function rpc(who: Login, method: string, request: object) {
        return bff.inject({
          method: 'POST',
          url: `/api/dsh/${requirementId}/native/api/session/${method}`,
          headers: {
            origin,
            cookie: who.cookie,
            'x-rdws-native-login': who.binding,
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
      async function readStored(sessionId: string) {
        const root = join(lab.root, 'runtime/dsh/project-poc/sessions');
        const file = (await readdir(root, { recursive: true })).find(
          (path) =>
            path.split('/').at(-2) === sessionId && path.endsWith('.jsonl'),
        );
        if (!file) throw new Error('Expected a stored Native fixture session');
        const contents = await readFile(join(root, file), 'utf8');
        return contents
          .trimEnd()
          .split('\n')
          .slice(1)
          .map((line) => JSON.parse(line)) as SessionEvent[];
      }
      async function nativeProbe(
        operation: 'refresh' | 'dispose',
        sessionId: string,
        expected: string,
      ) {
        await rm(resultFile, { force: true });
        await writeFile(
          commandFile + '.tmp',
          JSON.stringify({ operation, sessionId }),
          { mode: 0o600 },
        );
        await rename(commandFile + '.tmp', commandFile);
        await expect
          .poll(() => readFile(resultFile, 'utf8').catch(() => undefined))
          .toBe(expected);
      }
      async function create(who: Login) {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/requirements/' + requirementId + '/sessions',
          headers: {
            origin,
            cookie: who.cookie,
            'x-rdws-edit-session': who.login,
          },
          payload: { commandId: randomUUID() },
        });
        expect(response.statusCode).toBe(200);
        return response.json<{ sessionId: string }>().sessionId;
      }
      async function send(who: Login, sessionId: string, text: string) {
        const prompt = await rpc(who, 'prompt', {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text }],
        });
        expect(prompt.statusCode).toBe(200);
        expect(prompt.json().result).toMatchObject({
          ok: true,
          value: { accepted: true },
        });
      }
      async function begin(who: Login, text: string) {
        const sessionId = await create(who);
        const gate: TitleGate = {
          ...latch(),
          settled: false,
          prepare: latch(),
          prepareEntered: false,
        };
        gates.set(sessionId, gate);
        const callsBefore = arrivals.length;
        const requestsBefore = supplierRequests;
        const connectionsBefore = connections.length;
        await send(who, sessionId, text);
        await expect.poll(() => arrivals.slice(callsBefore)).toEqual(['main']);
        await expect.poll(() => normalReleases.has(sessionId)).toBe(true);
        await expect.poll(() => gate.prepareEntered).toBe(true);
        expect(connections.slice(connectionsBefore)).toHaveLength(1);
        const stored = await readStored(sessionId);
        const source = stored.find(
          ({ type, data }) =>
            type === 'user/message' && data.source?.kind === 'user',
        );
        expect(source?.seq).toEqual(expect.any(Number));
        expect(
          stored.filter(({ type }) => type === 'session/title-llm-request'),
        ).toMatchObject([
          { data: { messageSeqs: [source?.seq], route: { provider, model } } },
        ]);
        gate.prepare.release();
        await expect.poll(() => gate.wire, { timeout: 6000 }).toBeDefined();
        expect(connections.slice(connectionsBefore)).toHaveLength(2);
        expect(connections.at(-1)).toBe(gate.wire);
        expect(gate.wire?.bytes).toBe(0);
        return { sessionId, gate, callsBefore, requestsBefore };
      }
      const positive = await begin(observer, 'Synthetic first message');
      expect(positive.gate.preparedAfterRelease).toBe(true);
      async function overlayIds() {
        const patch = JSON.parse(
          await readFile(
            join(lab.root, 'runtime/instances/web.cordis.yml'),
            'utf8',
          ),
        ) as { insert?: { id: string }[] }[];
        return patch.flatMap((entry) => entry.insert ?? []).map(({ id }) => id);
      }
      expect(await overlayIds()).toContain('rdws-session-title-llm');
      positive.gate.release();
      await expect.poll(() => arrivals).toEqual(['main', 'title']);
      expect(positive.gate.wire?.bytes).toBeGreaterThan(0);
      const { cwd, workspaceId } = await native.current!.workspace(
        requirementId,
        'Synthetic task',
      );
      async function events(sessionId: string) {
        const raw = await native.current!.fetch(
          '/api/session/events',
          {
            purpose: 'browser',
            userId,
            authSessionId: observer.login,
            requirementId,
            cwd,
            workspaceId,
            readSessionIds: [sessionId],
            ownSessionIds: [sessionId],
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/events',
              payload: {
                args: { request: { address: { kind: 'session', sessionId } } },
              },
            }),
          },
        );
        expect(raw.status).toBe(200);
        const { result } = await raw.json();
        expect(result.ok).toBe(true);
        return result.value.records.map(
          ({
            event,
          }: {
            event: { type: string; seq: number; data: unknown };
          }) => event,
        ) as { type: string; seq: number; data: unknown }[];
      }
      const providerTitles = async (sessionId: string) =>
        (await events(sessionId)).filter(
          ({ type, data }) =>
            type === 'session/title' &&
            (data as { source: { kind: string } }).source.kind === 'provider',
        );
      await expect
        .poll(async () => (await providerTitles(positive.sessionId)).length)
        .toBe(1);
      const records = await events(positive.sessionId);
      const user = records.find(
        ({ type, data }) =>
          type === 'user/message' &&
          (data as { source?: { kind?: string } }).source?.kind === 'user',
      );
      expect(user?.seq).toEqual(expect.any(Number));
      expect(
        records.filter(({ type }) => type === 'session/title-llm-request'),
      ).toMatchObject([
        { data: { messageSeqs: [user?.seq], route: { provider, model } } },
      ]);
      expect(
        records.filter(({ type }) => type === 'session/title'),
      ).toMatchObject([
        {
          data: {
            title: 'Synthetic first message',
            source: { kind: 'fallback' },
            messageSeqs: [user?.seq],
          },
        },
        {
          data: {
            title,
            source: { kind: 'provider' },
            messageSeqs: [user?.seq],
          },
        },
      ]);
      await nativeProbe('refresh', positive.sessionId, 'refresh-disabled');
      async function verifyDenied({
        sessionId,
        gate,
        callsBefore,
        requestsBefore,
      }: Awaited<ReturnType<typeof begin>>) {
        gate.release();
        await expect.poll(() => gate.settled && gate.wire?.closed).toBe(true);
        expect(gate.wire?.bytes).toBe(0);
        expect(supplierRequests - requestsBefore).toBe(1);
        expect(arrivals.slice(callsBefore)).toEqual(['main']);
        expect(await providerTitles(sessionId)).toHaveLength(0);
      }

      const cancelled = await begin(observer, 'Synthetic cancel title');
      const cancellation = await rpc(observer, 'cancel', {
        sessionId: cancelled.sessionId,
      });
      expect(cancellation.statusCode).toBe(200);
      expect(cancellation.json().result.ok).toBe(true);
      await verifyDenied(cancelled);

      const disposed = await begin(observer, 'Synthetic retired agent title');
      await nativeProbe('dispose', disposed.sessionId, 'agent-disposed');
      await verifyDenied(disposed);
      await send(observer, disposed.sessionId, 'Synthetic new agent message');
      await expect
        .poll(() => arrivals.slice(disposed.callsBefore))
        .toEqual(['main', 'main']);
      await expect
        .poll(
          async () =>
            (await events(disposed.sessionId)).filter(
              ({ type }) => type === 'turn/end',
            ).length,
        )
        .toBe(2);
      expect(await providerTitles(disposed.sessionId)).toHaveLength(0);

      const leaving = await signIn();
      const loggedOut = await begin(leaving, 'Synthetic logout title');
      async function signOut(who: Login, notice = 'confirmed') {
        const logout = await bff.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: {
            origin,
            cookie: who.cookie,
            'x-rdws-edit-session': who.login,
          },
        });
        expect(logout.statusCode).toBe(200);
        expect(logout.headers['x-rdws-native-revocation']).toBe(notice);
        expect(
          (
            await lab.owner.query('select id from auth_session where id=$1', [
              who.login,
            ])
          ).rowCount,
        ).toBe(0);
      }
      await signOut(leaving);
      expect(await observedLogin(bff, observer.cookie)).toBe(observer.login);
      await verifyDenied(loggedOut);

      const disconnected = await signIn();
      const missedNotice = await begin(
        disconnected,
        'Synthetic missed title revocation',
      );
      const unavailable = vi
        .spyOn(NativeWebHost.prototype, 'revoke')
        .mockRejectedValueOnce(
          new Error('Synthetic Native revocation delivery failure'),
        );
      try {
        await signOut(disconnected, 'lease-expiry');
      } finally {
        unavailable.mockRestore();
      }
      await verifyDenied(missedNotice);

      const delivering = await signIn();
      const written = await begin(
        delivering,
        'Synthetic title already written',
      );
      heldTitleResponse = latch();
      written.gate.release();
      await expect
        .poll(() => arrivals.slice(written.callsBefore))
        .toEqual(['main', 'title']);
      expect(written.gate.wire?.bytes).toBeGreaterThan(0);
      await signOut(delivering);
      expect(written.gate.wire?.closed).toBe(false);
      heldTitleResponse.release();
      await expect
        .poll(async () => (await providerTitles(written.sessionId)).length)
        .toBe(1);
      expect(arrivals.slice(written.callsBefore)).toEqual(['main', 'title']);

      const expiring = await signIn('rdws-title-expiry-fixture');
      const expired = await begin(expiring, 'Synthetic expired title');
      const liveLogin = () =>
        lab.owner
          .query<{ live: boolean }>(
            'select expires_at > clock_timestamp() as live from auth_session where id=$1',
            [expiring.login],
          )
          .then(({ rows }) => rows[0]?.live);
      expect(await liveLogin()).toBe(true);
      await expect.poll(liveLogin, { timeout: 5000 }).toBe(false);
      await verifyDenied(expired);

      for (const state of ['429', 'sse-error'] as const) {
        titleResponse = state;
        const next = await begin(observer, 'Synthetic failed title ' + state);
        next.gate.release();
        await expect
          .poll(() => next.gate.settled && next.gate.wire?.closed)
          .toBe(true);
        expect(next.gate.wire?.bytes).toBeGreaterThan(0);
        expect(supplierRequests - next.requestsBefore).toBe(2);
        expect(arrivals.slice(next.callsBefore)).toEqual(['main', 'title']);
        expect(await providerTitles(next.sessionId)).toHaveLength(0);
        const exposed = await rpc(observer, 'events', {
          address: { kind: 'session', sessionId: next.sessionId },
        });
        expect(exposed.statusCode).toBe(200);
        expect(exposed.body).not.toContain(privateFailure);
        expect(JSON.stringify(await events(next.sessionId))).not.toContain(
          privateFailure,
        );
      }
      titleResponse = 'ok';
      const shutting = await begin(observer, 'Synthetic title during shutdown');
      const commitGate = latch();
      let committing = false;
      const originalConnect = Pool.prototype.connect;
      const commitSpy = vi
        .spyOn(Pool.prototype, 'connect')
        .mockImplementation(function (this: Pool, ...args: unknown[]) {
          const checkout = Reflect.apply(originalConnect, this, args);
          if (args.length || committing) return checkout;
          return checkout.then((client: PoolClient) => {
            const query = client.query;
            let titleTransaction = false;
            client.query = ((...parameters: unknown[]) => {
              const input = parameters[0] as string | { text?: string };
              const sql = typeof input === 'string' ? input : input.text;
              const run = () => Reflect.apply(query, client, parameters);
              if (sql === "set local transaction_timeout='2400ms'")
                titleTransaction = true;
              if (sql === 'commit' || sql === 'rollback') client.query = query;
              if (sql === 'commit' && titleTransaction && !committing) {
                committing = true;
                return commitGate.wait.then(run);
              }
              return run();
            }) as typeof query;
            return client;
          });
        } as typeof originalConnect);
      try {
        shutting.gate.release();
        await expect
          .poll(() => committing && (shutting.gate.wire?.bytes ?? 0) > 0)
          .toBe(true);
        const closing = bff.close();
        await expect.poll(() => shutting.gate.wire?.closed).toBe(true);
        const owner = () =>
          lab.owner
            .query<{ generation: string | null }>(
              'select generation from rdws_authority.owner where singleton',
            )
            .then(({ rows }) => rows[0]!.generation);
        expect(await owner()).toEqual(expect.any(String));
        expect(shutting.gate.settled).toBe(false);
        commitGate.release();
        await closing;
        expect(await owner()).toBeNull();
        app = undefined;
      } finally {
        commitGate.release();
        commitSpy.mockRestore();
      }
      for (const { patch, enabled } of [
        { patch: [{ id: 'session-title-llm', disabled: true }], enabled: true },
        {
          patch: [
            {
              id: 'session-title',
              config: {
                fallbackMaxWords: 2,
                fallbackMaxBytes: 40,
                maxTitleBytes: 80,
              },
            },
          ],
          enabled: true,
        },
        { patch: [], enabled: false },
      ]) {
        await writeProfile(patch);
        const nextTicket = randomBytes(32).toString('hex');
        const updated = await lab.owner.query(
          'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
          [createHash('sha256').update(nextTicket).digest('hex')],
        );
        expect(updated.rowCount).toBe(1);
        bff = start(nextTicket, enabled);
        app = bff;
        await bff.ready();
        const who = {
          ...observer,
          binding: await bootstrapNative(bff, observer.cookie, requirementId),
        };
        const sessionId = await create(who);
        const offset = {
          connections: connections.length,
          requests: supplierRequests,
        };
        expect(await overlayIds()).not.toContain('rdws-session-title-llm');
        await send(who, sessionId, 'Synthetic fallback title');
        await expect
          .poll(async () =>
            (await events(sessionId)).some(({ type }) => type === 'turn/end'),
          )
          .toBe(true);
        const nativeEvents = await events(sessionId);
        expect(
          nativeEvents.filter(({ type }) => type === 'session/title'),
        ).toMatchObject([{ data: { source: { kind: 'fallback' } } }]);
        expect(connections.length - offset.connections).toBe(1);
        expect(supplierRequests - offset.requests).toBe(1);
        await bff.close();
        app = undefined;
      }
      const logs = diagnostics.join('') + (await lab.logs());
      expect(titleCredentialObserved).toBe(true);
      for (const marker of [privateFailure, credentialMarker])
        expect(logs.includes(marker)).toBe(false);
    } finally {
      heldTitleResponse?.release();
      for (const gate of gates.values()) {
        gate.prepare.release();
        gate.release();
      }
      try {
        await app?.close();
      } finally {
        fetch.mockRestore();
        stdout.mockRestore();
        stderr.mockRestore();
        handleSpy.mockRestore();
        authorizeSpy.mockRestore();
        vi.unstubAllEnvs();
        setDefaultCACertificates(ca);
        for (const socket of sockets) socket.destroy();
        supplier.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => proxy.close(() => resolve())),
          new Promise<void>((resolve) => supplier.close(() => resolve())),
          lab.close(),
        ]);
      }
    }
  },
  55_000,
);
