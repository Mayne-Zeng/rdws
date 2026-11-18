import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  RequirementInput,
  BusinessCommand,
  SessionCreate,
  SessionFork,
  RepositorySyncInput,
  type ProjectRepositories,
} from '@rdws/contracts';
import { businessError, createBusiness } from './business.ts';
import {
  MirrorRequestError,
  RepositoryMirrors,
} from '../../../syncer/src/mirror.ts';
import { MirrorConfigError } from '../../../syncer/src/config.ts';
import { createSessionOperations } from './session-operations.ts';
import {
  ContextRuns,
  contextSnapshot,
  type RunBinding,
} from './runtime-context.ts';
import { eq, and, desc, asc } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { schema, type connectDatabase } from '@rdws/db';
import { NativeWebHost } from '@rdws/dsh/web';
import { sessionPage } from '@rdws/dsh/sessions';
import {
  actionAllowed,
  isRecord,
  onlyKeys,
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
  repositoryHome?: string,
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
  const mirrors = new RepositoryMirrors(repositoryHome ?? instanceRoot);
  const sessionOperations = createSessionOperations(db, business, native);
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
      .where(eq(schema.nativeSession.requirementId, id))
      .orderBy(
        asc(schema.nativeSession.createdAt),
        asc(schema.nativeSession.id),
      );
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
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/repositories',
    async (request): Promise<ProjectRepositories> => {
      const { projectId } = request.params;
      const who = await actor(request.headers);
      if (!(await projectRoles(who.userId, projectId)).length)
        businessError(403, '无权访问当前项目');
      let repositories;
      try {
        repositories = await mirrors.list(projectId);
      } catch (error) {
        if (error instanceof MirrorConfigError || error instanceof SyntaxError)
          businessError(409, '仓库配置无效，请联系运行维护者核对');
        throw error;
      }
      await actor(request.headers);
      const roles = await projectRoles(who.userId, projectId);
      if (!roles.length) businessError(403, '无权访问当前项目');
      return { repositories, canSync: roles.includes('project_admin') };
    },
  );
  app.post<{
    Params: { projectId: string; repositoryId: string };
    Body: { commandId: string };
  }>(
    '/api/projects/:projectId/repositories/:repositoryId/sync',
    {
      schema: { body: RepositorySyncInput },
      preValidation: async (request) => {
        if (Object.keys(request.body ?? {}).some((key) => key !== 'commandId'))
          businessError(400, '同步仅接受命令标识');
      },
    },
    async (request) => {
      const { projectId, repositoryId } = request.params;
      const who = await actor(request.headers);
      if (
        !(await projectRoles(who.userId, projectId)).includes('project_admin')
      )
        businessError(403, '无权同步项目仓库');
      try {
        const result = await mirrors.sync(
          projectId,
          repositoryId,
          who.userId,
          request.body.commandId,
          (publish) =>
            business.publishRepository(
              who,
              projectId,
              () => closingSessions.has(who.authSessionId),
              publish,
            ),
        );
        await actor(request.headers);
        if (
          !(await projectRoles(who.userId, projectId)).includes('project_admin')
        )
          businessError(403, '无权同步项目仓库');
        return result;
      } catch (error) {
        if (error instanceof MirrorRequestError) {
          if (error.reason === 'missing') businessError(404, '仓库未登记');
          if (error.reason === 'busy')
            businessError(409, '仓库正在同步或有待核对的锁，请先刷新状态');
          businessError(409, '镜像状态需要维护者核对');
        }
        if (error instanceof MirrorConfigError || error instanceof SyntaxError)
          businessError(409, '仓库配置无效，请联系运行维护者核对');
        throw error;
      }
    },
  );
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
        sourceSessionId: row.sourceSessionId,
        sourceThroughSeq: row.sourceThroughSeq,
      })),
    };
  });
  async function sessionOperation(
    request: FastifyRequest,
    sourceSessionId?: string,
  ) {
    const requirementId = (request.params as { id: string }).id;
    const scope = await access(request.headers, requirementId);
    const assertOpen = () => {
      if (stale(scope)) fail(401, '授权已变化');
    };
    return sessionOperations.execute(
      scope.who,
      requirementId,
      (request.body as { commandId?: string })?.commandId ?? randomUUID(),
      sourceSessionId,
      {
        assertOpen,
        current: async () => {
          assertOpen();
          await access(request.headers, requirementId);
          assertOpen();
        },
        prepare: async () => {
          await prepared(await access(request.headers, requirementId));
          const fresh = await access(request.headers, requirementId);
          assertOpen();
          return {
            workspaceId: fresh.item.nativeWorkspaceId!,
            cwd: join(native.demandRoot, requirementId),
            grant: grant(fresh),
          };
        },
        mapped: async () => {
          const groups = new Set([
            scope.who.authSessionId,
            ...[...bridges]
              .filter((item) => item.requirementId === requirementId)
              .map((item) => item.authSessionId),
          ]);
          for (const group of groups) await revoke(group, requirementId);
        },
        validateReturn: async () => {
          await access(request.headers, requirementId);
          await business.sessionTransaction(
            scope.who,
            requirementId,
            sourceSessionId,
            async () => {
              if (closingSessions.has(scope.who.authSessionId))
                fail(401, '登录已失效');
            },
          );
        },
      },
    );
  }
  const validateSessionBody = async (request: FastifyRequest) => {
    if (!onlyKeys(request.body, ['commandId']))
      fail(400, '会话参数由服务器确定');
  };
  app.post(
    '/api/requirements/:id/sessions',
    {
      schema: { body: SessionCreate },
      preValidation: async (request) => {
        request.body ??= {};
        await validateSessionBody(request);
      },
    },
    async (request, reply) => {
      const result = await sessionOperation(request);
      return reply
        .code(
          result.status === 'mapped'
            ? 200
            : result.status === 'rejected'
              ? 409
              : 202,
        )
        .send(result);
    },
  );
  app.post(
    '/api/requirements/:id/sessions/:sessionId/fork',
    { schema: { body: SessionFork }, preValidation: validateSessionBody },
    async (request, reply) => {
      const result = await sessionOperation(
        request,
        (request.params as { sessionId: string }).sessionId,
      );
      return reply
        .code(
          result.status === 'mapped'
            ? 200
            : result.status === 'rejected'
              ? 409
              : 202,
        )
        .send(result);
    },
  );
  app.get(
    '/api/requirements/:id/sessions/:sessionId/history',
    async (request) => {
      const { id, sessionId } = request.params as {
        id: string;
        sessionId: string;
      };
      const scope = await access(request.headers, id);
      if (!scope.sessions.some((s) => s.id === sessionId))
        fail(403, '无权读取该会话历史');
      const query = request.query as Record<string, string>;
      if (!onlyKeys(query, ['throughSeq', 'beforeSeq', 'pageSize']))
        fail(400, '回放参数不正确');
      function position(key: string, min: number) {
        const value = query[key];
        if (value === undefined) return undefined;
        if (
          !/^-?\d+$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < min
        )
          fail(400, '回放位置不正确');
        return Number(value);
      }
      await prepared(scope);
      const pageSize = position('pageSize', 1) ?? 20;
      if (pageSize > 50) fail(400, '回放每页最多读取 50 条消息');
      const page = await sessionPage(
        native,
        grant(scope),
        sessionId,
        position('throughSeq', -1),
        position('beforeSeq', 0),
        pageSize,
      );
      await access(request.headers, id);
      if (stale(scope)) fail(401, '授权已变化');
      const labels: Record<string, string> = {
        'turn/start': '轮次开始',
        'turn/end': '轮次结束',
        'user/message': '用户消息',
        'assistant/message': '助手回复',
        'agent/error': '本轮发生错误',
      };
      const events = page.records.flatMap(({ event }) => {
        const label = labels[event.type];
        if (!label) return [];
        let text: string | undefined;
        if (['user/message', 'assistant/message'].includes(event.type)) {
          if (
            event.type === 'user/message' &&
            (!isRecord(event.data.source) ||
              !['user', 'retry'].includes(String(event.data.source.kind)))
          )
            return [];
          const message = isRecord(event.data.message)
            ? event.data.message
            : {};
          const content = message.content ?? event.data.content;
          text =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (p) =>
                        isRecord(p) &&
                        p.type === 'text' &&
                        typeof p.text === 'string',
                    )
                    .map((p) => p.text)
                    .join('')
                : '';
        }
        const reason = isRecord(event.data.reason)
          ? event.data.reason.kind
          : undefined;
        const outcomes: Record<string, string> = {
          completed: '已完成',
          interrupted: '已中断',
          forked: '派生时结束',
          cancelled: '已取消',
          blocked: '已阻止',
          failed: '执行失败',
        };
        return [
          {
            seq: event.seq,
            type: event.type,
            label,
            ...(text === undefined ? {} : { text }),
            ...(event.type === 'turn/end'
              ? { outcome: outcomes[String(reason)] ?? '已结束' }
              : {}),
          },
        ];
      });
      return {
        cursor: page.cursor,
        beforeSeq: page.records[0]?.event.seq ?? 0,
        hasMore: page.hasMore,
        events,
      };
    },
  );
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
    await mirrors.close();
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
