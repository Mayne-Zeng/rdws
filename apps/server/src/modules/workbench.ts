import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { RequirementInput, BusinessCommand } from '@rdws/contracts';
import { createBusiness } from './business.ts';
import {
  ContextRuns,
  contextSnapshot,
  type RunBinding,
} from './runtime-context.ts';
import { eq, and, desc } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { schema, type connectDatabase } from '@rdws/db';
import { NativeWebHost } from '@rdws/dsh/web';
import {
  actionAllowed,
  isRecord,
  LEASE_MS,
  type Grant,
} from '@rdws/dsh/access';
import { authorizeStreamFrame } from '@rdws/dsh/wire';
import type { createAuth } from './auth.ts';
import { runtimeHome } from '../../../../scripts/env.mjs';
type Database = ReturnType<typeof connectDatabase>['db'];
type Auth = ReturnType<typeof createAuth>;
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
export async function registerWorkbench(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  providedNative?: NativeWebHost,
  expectedOrigin = process.env.RDWS_ORIGIN || 'http://127.0.0.1:5173',
) {
  const instanceRoot =
    process.env.RDWS_MODE === 'test'
      ? join(runtimeHome, 'testing-web')
      : runtimeHome;
  const native =
    providedNative ??
    new NativeWebHost(
      instanceRoot,
      process.env.RDWS_MODE === 'test'
        ? join(runtimeHome, 'runtime', 'dsh', 'project-poc')
        : undefined,
    );
  const business = createBusiness(db);
  let authorizationEpoch = 0;
  const closingSessions = new Set<string>();
  const runs = new ContextRuns(
    native.contextGeneration,
    (token) => native.verifyContext(token),
    async (who, id, sessionId, relatedActors) =>
      contextSnapshot(await business.read(who, id, sessionId, relatedActors)),
    (id) => closingSessions.has(id),
  );
  app.post('/internal/rdws/context', async (request) =>
    runs.handle(
      request.body,
      request.headers.authorization?.replace(/^RDWS /, ''),
    ),
  );
  const acceptedPrompts = new Map<string, number>(),
    abandonedRuns = new Set<string>();
  async function retireRun(runId: string) {
    runs.discard(runId);
    abandonedRuns.add(runId);
    try {
      await native.control('run.cancel', { runId });
      abandonedRuns.delete(runId);
    } catch {
      return;
    }
  }
  const revokedEpoch = new Map<string, number>();
  const epochFor = (authSessionId: string, requirementId: string) =>
    Math.max(
      revokedEpoch.get(authSessionId + ':*') ?? 0,
      revokedEpoch.get(authSessionId + ':' + requirementId) ?? 0,
    );
  const stale = (scope: Access) =>
    closingSessions.has(scope.who.authSessionId) ||
    epochFor(scope.who.authSessionId, scope.item.id) > scope.epoch;
  const transfers = new Set<{
    authSessionId: string;
    requirementId: string;
    controller: AbortController;
    revoked: boolean;
  }>();
  const leases = new Map<
    string,
    {
      token: string;
      expiresAt: number;
      authSessionId: string;
      requirementId: string;
      revoked: boolean;
    }
  >();
  const bridges = new Set<{
    authSessionId: string;
    requirementId: string;
    close: () => void;
  }>();
  async function actor(headers: FastifyRequest['headers']) {
    const current = await auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });
    if (!current || closingSessions.has(current.session.id))
      fail(401, '请先登录');
    const [user] = await db
      .select()
      .from(schema.user)
      .where(
        and(eq(schema.user.id, current.user.id), eq(schema.user.active, true)),
      );
    if (!user || closingSessions.has(current.session.id))
      fail(401, '账号已停用');
    return { userId: user.id, authSessionId: current.session.id };
  }
  async function projectRoles(userId: string, projectId: string) {
    return (
      await db
        .select()
        .from(schema.projectMember)
        .where(
          and(
            eq(schema.projectMember.userId, userId),
            eq(schema.projectMember.projectId, projectId),
          ),
        )
    ).map((row) => row.role);
  }
  async function access(headers: FastifyRequest['headers'], id: string) {
    const epoch = authorizationEpoch;
    const who = await actor(headers);
    const [item] = await db
      .select()
      .from(schema.requirement)
      .where(eq(schema.requirement.id, id));
    if (!item) fail(404, '需求不存在');
    const roles = await projectRoles(who.userId, item.projectId);
    if (!roles.length) fail(403, '无权访问当前需求');
    const [participant] = await db
      .select()
      .from(schema.requirementParticipant)
      .where(
        and(
          eq(schema.requirementParticipant.requirementId, id),
          eq(schema.requirementParticipant.userId, who.userId),
        ),
      );
    if (!participant && !roles.includes('project_admin'))
      fail(403, '无权访问当前需求');
    const sessions = await db
      .select()
      .from(schema.nativeSession)
      .where(eq(schema.nativeSession.requirementId, id));
    if (epochFor(who.authSessionId, id) > epoch) fail(401, '授权已变化');
    return { who, item, roles, sessions, epoch };
  }
  type Access = Awaited<ReturnType<typeof access>>;
  async function prepared(scope: Access) {
    const address = app.server.address();
    if (address && typeof address !== 'string')
      native.configureContext(
        `http://127.0.0.1:${address.port}/internal/rdws/context`,
        expectedOrigin,
      );
    if (scope.item.projectId !== 'poc') fail(503, '项目运行时尚未配置');
    if (stale(scope)) fail(401, '授权已变化');
    const value = await native.workspace(scope.item.id, scope.item.title);
    if (stale(scope)) fail(401, '授权已变化');
    if (scope.item.nativeWorkspaceId !== value.workspaceId) {
      await db
        .update(schema.requirement)
        .set({ nativeWorkspaceId: value.workspaceId })
        .where(eq(schema.requirement.id, scope.item.id));
      scope.item.nativeWorkspaceId = value.workspaceId;
    }
    return scope;
  }
  function grant(
    scope: Access,
    purpose: 'browser' | 'create' = 'browser',
  ): Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'> {
    if (stale(scope)) fail(401, '授权已变化');
    return {
      purpose,
      ...scope.who,
      requirementId: scope.item.id,
      workspaceId: scope.item.nativeWorkspaceId!,
      cwd: join(native.demandRoot, scope.item.id),
      readSessionIds: scope.sessions.map((row) => row.id),
      ownSessionIds: scope.sessions
        .filter((row) => row.ownerId === scope.who.userId)
        .map((row) => row.id),
    };
  }
  function lease(scope: Access, request: FastifyRequest) {
    const generation =
      request.headers['x-rdws-client-generation'] ??
      new URL(request.url, 'http://rdws.invalid').searchParams.get(
        'generation',
      );
    if (typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation))
      fail(400, '连接标识不正确');
    const id = scope.who.authSessionId + ':' + scope.item.id + ':' + generation;
    let item = leases.get(id);
    if (item && (item.revoked || item.expiresAt <= Date.now()))
      fail(409, '连接已过期，请重新连接');
    if (!item) {
      item = {
        token: native.ticket(grant(scope)),
        expiresAt: Date.now() + LEASE_MS,
        authSessionId: scope.who.authSessionId,
        requirementId: scope.item.id,
        revoked: false,
      };
      leases.set(id, item);
    }
    return item.token;
  }
  async function revoke(authSessionId: string, requirementId?: string) {
    authorizationEpoch++;
    revokedEpoch.set(
      authSessionId + ':' + (requirementId ?? '*'),
      authorizationEpoch,
    );
    for (const transfer of transfers)
      if (
        transfer.authSessionId === authSessionId &&
        (!requirementId || transfer.requirementId === requirementId)
      ) {
        transfer.revoked = true;
        transfer.controller.abort();
      }
    for (const lease of leases.values())
      if (
        lease.authSessionId === authSessionId &&
        (!requirementId || lease.requirementId === requirementId)
      )
        lease.revoked = true;
    for (const bridge of [...bridges])
      if (
        bridge.authSessionId === authSessionId &&
        (!requirementId || bridge.requirementId === requirementId)
      )
        bridge.close();
    try {
      await native.revoke(authSessionId, requirementId);
      return true;
    } catch {
      return false;
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    if (
      Object.keys(request.headers).some(
        (key) =>
          key.startsWith('x-rdws-') && key !== 'x-rdws-client-generation',
      )
    )
      return reply.code(403).send({ error: '身份头不受信任' });
  });
  app.get('/api/projects/:projectId/members', async (request) => {
    const who = await actor(request.headers);
    const { projectId } = request.params as { projectId: string };
    const roles = await projectRoles(who.userId, projectId);
    if (
      !roles.some((role) =>
        ['project_admin', 'requirement_manager'].includes(role),
      )
    )
      fail(403, '无权管理项目');
    return {
      members: await db
        .select({
          id: schema.user.id,
          name: schema.user.name,
          role: schema.projectMember.role,
        })
        .from(schema.projectMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
        .where(
          and(
            eq(schema.projectMember.projectId, projectId),
            eq(schema.user.active, true),
          ),
        ),
    };
  });
  app.get('/api/projects/:projectId/requirements', async (request) => {
    const who = await actor(request.headers);
    const { projectId } = request.params as { projectId: string };
    const roles = await projectRoles(who.userId, projectId);
    if (!roles.length) fail(403, '无权访问项目');
    const rows = await db
      .select()
      .from(schema.requirement)
      .where(eq(schema.requirement.projectId, projectId))
      .orderBy(
        desc(schema.requirement.updatedAt),
        desc(schema.requirement.createdAt),
      );
    const memberships = await db
      .select()
      .from(schema.requirementParticipant)
      .where(eq(schema.requirementParticipant.userId, who.userId));
    return {
      requirements: rows
        .filter(
          (row) =>
            roles.includes('project_admin') ||
            memberships.some((member) => member.requirementId === row.id),
        )
        .map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          acceptance: row.acceptance,
          leadId: row.leadId,
          stage: row.stage,
          contextVersion: row.contextVersion,
        })),
      canCreate: roles.some((role) =>
        ['project_admin', 'requirement_manager'].includes(role),
      ),
    };
  });
  app.post(
    '/api/projects/:projectId/requirements',
    { schema: { body: RequirementInput } },
    async (request) => {
      return business.create(
        await actor(request.headers),
        (request.params as { projectId: string }).projectId,
        request.body as RequirementInput,
      );
    },
  );
  app.get('/api/requirements/:id', async (request) =>
    business.read(
      await actor(request.headers),
      (request.params as { id: string }).id,
    ),
  );
  app.post(
    '/api/requirements/:id/commands',
    { schema: { body: BusinessCommand } },
    async (request) =>
      business.execute(
        await actor(request.headers),
        (request.params as { id: string }).id,
        request.body as BusinessCommand,
      ),
  );
  app.get('/api/requirements/:id/sessions', async (request) => {
    const scope = await access(
      request.headers,
      (request.params as { id: string }).id,
    );
    return {
      sessions: scope.sessions.map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        own: row.ownerId === scope.who.userId,
      })),
    };
  });
  app.post('/api/requirements/:id/sessions', async (request) => {
    if (
      request.body &&
      (!isRecord(request.body) || Object.keys(request.body).length)
    )
      fail(400, '创建参数由服务器确定');
    const requirementId = (request.params as { id: string }).id;
    await prepared(await access(request.headers, requirementId));
    const scope = await access(request.headers, requirementId);
    const rpcId = randomUUID();
    const response = await native.fetch(
      '/api/session/create',
      grant(scope, 'create'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'session/create',
          payload: {
            args: { request: { workspaceId: scope.item.nativeWorkspaceId } },
          },
        }),
      },
    );
    const result = (await response.json()) as {
      rpcId: string;
      result: { ok: boolean; value?: { sessionId: string }; error?: unknown };
    };
    if (
      !response.ok ||
      !result.result.ok ||
      typeof result.result.value?.sessionId !== 'string'
    )
      fail(503, '会话创建失败');
    const sessionId = result.result.value.sessionId;
    try {
      await db.insert(schema.nativeSession).values({
        id: sessionId,
        requirementId: scope.item.id,
        ownerId: scope.who.userId,
      });
    } catch {
      const directory = join(runtimeHome, 'state', 'exports');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `orphan-session-${randomUUID()}.json`),
        JSON.stringify({ sessionId, requirementId: scope.item.id }),
        { mode: 0o600 },
      );
      fail(503, '会话映射保存失败，请联系管理员核对，不要重复创建');
    }
    const groups = new Set([
      scope.who.authSessionId,
      ...[...bridges]
        .filter((item) => item.requirementId === scope.item.id)
        .map((item) => item.authSessionId),
    ]);
    for (const group of groups) await revoke(group, scope.item.id);
    await access(request.headers, scope.item.id);
    return { sessionId };
  });
  app.get('/api/dsh/:id/bootstrap', async (request) => {
    const requirementId = (request.params as { id: string }).id;
    await prepared(await access(request.headers, requirementId));
    const scope = await access(request.headers, requirementId);
    const response = await native.fetch('/api/rdws/bootstrap', grant(scope));
    if (!response.ok) fail(503, '会话运行时暂不可用');
    return response.json();
  });
  const assets = new Set<string>();
  async function allowedAsset(scope: Access, path: string) {
    if (path.includes('..') || decodeURIComponent(path).includes('..'))
      return false;
    const response = await native.fetch('/api/rdws/bootstrap', grant(scope));
    if (!response.ok) return false;
    const data = (await response.json()) as {
      graph: {
        entries: { id: string; url: string }[];
        batches?: { url: string }[];
      };
    };
    for (const row of [...data.graph.entries, ...(data.graph.batches ?? [])])
      assets.add('/' + row.url.replace(/^\//, ''));
    if (assets.has(path)) return true;
    return data.graph.entries.some((row) =>
      path.startsWith('/plugins/' + row.id + '/assets/'),
    );
  }
  app.route({
    method: ['GET', 'POST'],
    url: '/api/dsh/:id/native/*',
    handler: async (request, reply) => {
      const { id, '*': tail } = request.params as { id: string; '*': string };
      await prepared(await access(request.headers, id));
      const scope = await access(request.headers, id);
      const path =
        '/' +
        tail +
        (request.method === 'GET'
          ? new URL(request.url, 'http://rdws.invalid').search
          : '');
      if (request.method === 'GET') {
        if (!(await allowedAsset(scope, path))) fail(403, '不允许读取该资源');
      } else {
        const action = tail.startsWith('api/') ? tail.slice(4) : '';
        const body = request.body;
        if (
          !isRecord(body) ||
          body.method !== action ||
          body.type !== 'client-request' ||
          !isRecord(body.payload) ||
          !isRecord(body.payload.args) ||
          !actionAllowed(
            {
              ...grant(scope),
              aud: native.audience,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 20000,
              nonce: 'bff',
            },
            action,
            body.payload.args,
          )
        )
          fail(403, '无权执行该会话操作');
      }
      const transfer = {
        ...scope.who,
        requirementId: id,
        controller: new AbortController(),
        revoked: false,
      };
      transfers.add(transfer);
      let pendingRun: RunBinding | undefined;
      let promptKey: string | undefined;
      try {
        const token =
          request.method === 'POST' ? lease(scope, request) : grant(scope);
        if (
          request.method === 'POST' &&
          isRecord(request.body) &&
          request.body.method === 'session/prompt'
        ) {
          const args = (
            request.body.payload as {
              args: { request: { sessionId: string; requestId: string } };
            }
          ).args.request;
          const claims = native.claims(String(token));
          if (!claims || typeof args.requestId !== 'string')
            fail(403, '会话请求身份无效');
          promptKey = args.sessionId + ':' + args.requestId;
          for (const [key, time] of acceptedPrompts)
            if (time < Date.now()) acceptedPrompts.delete(key);
          if (!acceptedPrompts.has(promptKey)) {
            const candidates = runs.submittedIds();
            if (candidates.length) {
              const active = await native.control('runs.active', {});
              if (Array.isArray(active.runIds))
                runs.reconcile(
                  candidates,
                  active.runIds.filter(
                    (id): id is string => typeof id === 'string',
                  ),
                );
            }
            for (const runId of abandonedRuns) {
              await native.control('run.cancel', { runId });
              abandonedRuns.delete(runId);
            }
            pendingRun = runs.admit(
              scope.who,
              id,
              args.sessionId,
              args.requestId,
              claims.nonce,
            );
            await native.control('run', { ...pendingRun });
          }
          await access(request.headers, id);
          if (stale(scope)) fail(401, '授权已变化');
        }
        const response = await native.fetch(path, token, {
          method: request.method,
          signal: transfer.controller.signal,
          ...(request.method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request.body),
              }
            : {}),
        });
        reply.code(response.status);
        for (const [key, value] of response.headers)
          if (
            ![
              'content-encoding',
              'content-length',
              'connection',
              'set-cookie',
              'transfer-encoding',
              'keep-alive',
              'upgrade',
              'te',
              'trailer',
            ].includes(key)
          )
            reply.header(key, value);
        const data = Buffer.from(await response.arrayBuffer());
        if (promptKey) {
          let accepted = false;
          try {
            const value = JSON.parse(data.toString());
            accepted =
              response.ok &&
              value.result?.ok === true &&
              value.result?.value?.accepted === true;
          } catch {
            accepted = false;
          }
          if (accepted) {
            acceptedPrompts.set(promptKey, Date.now() + 30 * 60 * 1000);
            if (acceptedPrompts.size > 4096)
              acceptedPrompts.delete(acceptedPrompts.keys().next().value!);
            if (pendingRun) {
              runs.submitted(pendingRun.runId);
              let seen = false;
              try {
                seen =
                  (
                    await native.control('run.status', {
                      runId: pendingRun.runId,
                    })
                  ).seen === true;
              } catch {
                seen = false;
              }
              if (!seen) await retireRun(pendingRun.runId);
              pendingRun = undefined;
            }
          }
        }
        await access(request.headers, id);
        if (transfer.revoked || stale(scope)) fail(401, '授权已变化');
        return reply.send(data);
      } finally {
        if (pendingRun) await retireRun(pendingRun.runId);
        transfers.delete(transfer);
      }
    },
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.get(
    '/api/dsh/:id/native/api/remote.mux',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        try {
          await access(request.headers, (request.params as { id: string }).id);
          if (request.headers.origin !== expectedOrigin)
            return reply.code(403).send({ error: '请求来源不受信任' });
        } catch {
          return reply.code(403).send({ error: '无权连接会话' });
        }
      },
    },
    (browser, request) => {
      const requirementId = (request.params as { id: string }).id;
      let stopped = false;
      let upstream: WebSocket | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let chain = Promise.resolve();
      const opened = new Set<string>();
      let authSessionId = '';
      const close = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        upstream?.close();
        browser.close(4001, 'access changed');
        bridges.delete(bridge);
      };
      const bridge = { authSessionId, requirementId, close };
      const ready = (async () => {
        await prepared(await access(request.headers, requirementId));
        const scope = await access(request.headers, requirementId);
        if (stopped || stale(scope)) return;
        authSessionId = scope.who.authSessionId;
        bridge.authSessionId = authSessionId;
        bridges.add(bridge);
        upstream = new WebSocket(native.socketUrl(), {
          headers: {
            'x-rdws-delegation': lease(scope, request),
            origin: new URL(native.socketUrl()).origin.replace('ws:', 'http:'),
          },
        });
        upstream.on('message', (data) => {
          if (!stopped && browser.readyState === WebSocket.OPEN)
            browser.send(data.toString());
        });
        upstream.on('close', close);
        upstream.on('error', close);
        timer = setInterval(() => {
          void access(request.headers, requirementId).catch(async () => {
            close();
            await revoke(authSessionId, requirementId);
          });
        }, 1000);
        await new Promise<void>((resolve, reject) => {
          upstream!.once('open', resolve);
          upstream!.once('error', reject);
        });
      })();
      browser.on('message', (data) => {
        chain = chain
          .then(async () => {
            await ready;
            if (stopped) return;
            const scope = await access(request.headers, requirementId);
            authorizeStreamFrame(
              data.toString(),
              {
                ...grant(scope),
                aud: native.audience,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 20000,
                nonce: 'bff',
              },
              opened,
            );
            if (!stopped) upstream!.send(data.toString());
          })
          .catch(close);
      });
      browser.on('close', close);
      browser.on('error', close);
      void ready.catch(close);
    },
  );
  app.addHook('preClose', async () => {
    runs.clear();
    for (const bridge of [...bridges]) bridge.close();
    await native.close();
  });
  return {
    native,
    access,
    revoke,
    async revokeRequest(headers: FastifyRequest['headers']) {
      try {
        const who = await actor(headers);
        closingSessions.add(who.authSessionId);
        runs.revoke(who.authSessionId);
        return await revoke(who.authSessionId);
      } catch {
        return false;
      }
    },
  };
}
