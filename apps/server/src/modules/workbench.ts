import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  RequirementInput,
  BusinessCommand,
  RequirementDetailsInput,
  RequirementPersonnelInput,
  RequirementImportInput,
  RequirementImportPreviewInput,
  importColumns,
  importLimits,
  type RequirementImportRow,
  type RequirementImportReceipt,
  personnelRoles,
  type RequirementPersonnelReceipt,
  TemplateBindingInput,
  SessionCreate,
  SessionFork,
  RepositorySyncInput,
  ManagementCommand,
  capabilityKey,
  type CapabilityApprovalList,
  type CapabilityTemplateManagement,
  type CapabilityVersion,
  type PlatformAdministration,
  type ProjectAdministration,
  type ManagementResult,
  ProjectList,
  type ProjectRepositories,
  type RequirementWorkspace,
} from '@rdws/contracts';
import {
  businessError,
  createBusiness,
  digestOf,
  normalizeManagement,
  normalizePersonnel,
  type RequirementAuthority,
} from './business.ts';
import {
  MirrorRequestError,
  RepositoryMirrors,
} from '../../../syncer/src/mirror.ts';
import { MirrorConfigError } from '../../../syncer/src/config.ts';
import {
  DemandWorktrees,
  type DemandRepositories,
} from '../../../orchestrator/src/demand-worktrees.ts';
import {
  createProjectRuntimes,
  type ProjectRuntime,
} from './native-projects.ts';
import { type RunBinding } from './runtime-context.ts';
import { eq, and, desc, asc, isNull, sql, inArray } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { schema, type connectDatabase } from '@rdws/db';
import { NativeWebHost, type NativeModelEgress } from '@rdws/dsh/web';
import { sessionPage } from '@rdws/dsh/sessions';
import {
  actionAllowed,
  isRecord,
  nativeLoginBinding,
  onlyKeys,
  LEASE_MS,
  type Grant,
} from '@rdws/dsh/access';
import {
  authorizeStreamFrame,
  publicNativeSessionResponse,
  publicNativeStreamFrame,
} from '@rdws/dsh/wire';
import { currentAccount, type createAuth } from './auth.ts';
import { runtimeHome } from '../../../../scripts/env.mjs';
type Database = ReturnType<typeof connectDatabase>['db'];
type Auth = ReturnType<typeof createAuth>;
const templateBindingPath = '/api/requirements/:id/capability-template';
const personnelPath = '/api/requirements/:id/personnel';
const sessionsPath = '/api/requirements/:id/sessions';
const sessionHistoryPath = '/api/requirements/:id/sessions/:sessionId/history';
const sessionForkPath = '/api/requirements/:id/sessions/:sessionId/fork';
const nativeBootstrapPath = '/api/dsh/:id/bootstrap';
const nativeTransportPath = '/api/dsh/:id/native/*';
const nativeMuxPath = '/api/dsh/:id/native/api/remote.mux';
const nativeBindingHeader = 'x-rdws-native-login';
const nativeGenerationHeader = 'x-rdws-client-generation';
const importPreviewPath =
  '/api/projects/:projectId/requirements/import/preview';
const importCommitPath = '/api/projects/:projectId/requirements/import/commit';
const isImportRequest = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === importPreviewPath ||
    request.routeOptions.url === importCommitPath);
const isTemplateBindingRequest = (request: FastifyRequest) =>
  request.routeOptions.url === templateBindingPath &&
  (request.method === 'GET' || request.method === 'POST');
const isPassiveSessionRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  (request.routeOptions.url === sessionsPath ||
    request.routeOptions.url === sessionHistoryPath);
const isSessionWrite = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === sessionsPath ||
    request.routeOptions.url === sessionForkPath);
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
async function publicModelCatalog(response: Response, rpcId: unknown) {
  const message = '模型目录暂不可用';
  if (!response.ok || typeof rpcId !== 'string') {
    await response.body?.cancel().catch(() => {});
    fail(503, message);
  }
  const incoming: unknown = await response.json().catch(() => undefined);
  if (
    !isRecord(incoming) ||
    incoming.type !== 'server-response' ||
    incoming.rpcId !== rpcId ||
    !isRecord(incoming.result)
  )
    fail(503, message);

  const envelope = { type: 'server-response', rpcId };
  const options = { headers: { 'cache-control': 'no-store' } };
  const { result } = incoming;
  if (result.ok === false) {
    return Response.json(
      {
        ...envelope,
        result: {
          ok: false,
          error: { code: 'gateway/internal', message, details: {} },
        },
      },
      options,
    );
  }
  const catalog = result.value;
  if (
    result.ok !== true ||
    !isRecord(catalog) ||
    !isRecord(catalog.default) ||
    !Array.isArray(catalog.groups) ||
    !Array.isArray(catalog.routableProviders) ||
    !Array.isArray(catalog.failures)
  )
    fail(503, message);
  const failures = catalog.failures.map((failure: unknown) => {
    if (
      !isRecord(failure) ||
      typeof failure.id !== 'string' ||
      typeof failure.name !== 'string'
    )
      fail(503, message);
    return {
      id: failure.id,
      name: failure.name,
      message: '供应商模型目录暂不可用',
    };
  });
  return Response.json(
    {
      ...envelope,
      result: {
        ok: true,
        value: {
          default: catalog.default,
          groups: catalog.groups,
          routableProviders: catalog.routableProviders,
          failures,
        },
      },
    },
    options,
  );
}
class PendingAuthority extends Error {
  readonly statusCode = 401;
  readonly publicMessage = '当前权限正在变更，请刷新后重试';
}
export async function registerWorkbench(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  providedNative?: NativeWebHost,
  expectedOrigin = process.env.RDWS_ORIGIN || 'http://127.0.0.1:5173',
  repositoryHome?: string,
  nativeRuntimeRoot?: string,
  nativeProfiles?: ReadonlyMap<string, string>,
  modelEgress: NativeModelEgress = 'direct',
) {
  const instanceRoot =
    process.env.RDWS_MODE === 'test'
      ? join(runtimeHome, 'testing-web')
      : runtimeHome;
  const business = createBusiness(db);
  const mirrors = new RepositoryMirrors(repositoryHome ?? instanceRoot);
  const worktrees = new DemandWorktrees(
    nativeRuntimeRoot ?? instanceRoot,
    mirrors,
  );
  const providedWorktrees = providedNative
    ? new DemandWorktrees(providedNative.runtimeHome, mirrors)
    : undefined;
  const worktreesFor = (projectId: string) =>
    providedNative?.projectId === projectId ? providedWorktrees! : worktrees;
  let authorizationEpoch = 0;
  let stopping = false;
  const closingSessions = new Set<string>();
  const logoutNotifications = new Map<string, Promise<boolean>>();
  const scopeEpochs = new Map<string, number>();
  const pendingNotifications = new Map<string, Promise<boolean>>();
  const fences = new Map<
    string,
    { userId: string; projectId?: string; digest: string }
  >();
  type PersonnelFence = {
    key: string;
    projectId: string;
    requirementId: string;
    actorId: string;
    commandId: string;
    digest: string;
    userIds: string[];
    cutoff: number;
    uncertain?: boolean;
    recovery?: Promise<void>;
  };
  const personnelFences = new Map<string, PersonnelFence>();
  const scopeKey = (userId: string, project?: string) =>
    userId + ':' + (project ?? '*');
  function blocked(
    userId: string,
    project?: string,
    ignore?: string,
    requirementId?: string,
    list = false,
  ) {
    const projectBlocked = [...fences.entries()].some(
      ([key, scope]) =>
        key !== ignore &&
        scope.userId === userId &&
        (!scope.projectId ||
          project === scope.projectId ||
          project === ':project-list'),
    );
    return (
      projectBlocked ||
      !!(
        (requirementId || list) &&
        [...personnelFences.values()].some(
          (entry) =>
            entry.projectId === project &&
            (list || entry.requirementId === requirementId) &&
            entry.userIds.includes(userId),
        )
      )
    );
  }
  function changed(
    userId: string,
    project: string | undefined,
    epoch: number,
    requirementId?: string,
    list = false,
  ) {
    const own = scopeEpochs.get(scopeKey(userId, project)) ?? 0;
    const demandEpoch = requirementId
      ? (scopeEpochs.get(scopeKey(userId, 'demand:' + requirementId)) ?? 0)
      : 0;
    const listEpoch = list
      ? (scopeEpochs.get(scopeKey(userId, 'demands:' + project)) ?? 0)
      : 0;
    return (
      Math.max(
        own,
        demandEpoch,
        listEpoch,
        scopeEpochs.get(scopeKey(userId)) ?? 0,
      ) > epoch
    );
  }
  const projects = createProjectRuntimes(
    nativeRuntimeRoot ?? instanceRoot,
    process.env.RDWS_MODE === 'test' || nativeRuntimeRoot
      ? join(runtimeHome, 'runtime', 'dsh', 'project-poc')
      : undefined,
    providedNative,
    db,
    business,
    (id, userId, projectId, requirementId) =>
      closingSessions.has(id) ||
      stopping ||
      blocked(userId, projectId, undefined, requirementId),
    nativeProfiles,
    modelEgress,
  );
  async function retireRun(runtime: ProjectRuntime, runId: string) {
    runtime.runs.discard(runId);
    runtime.abandonedRuns.add(runId);
    try {
      await runtime.native.control('run.cancel', { runId });
      runtime.abandonedRuns.delete(runId);
    } catch {
      return;
    }
  }
  const revokedEpoch = new Map<string, number>();
  const epochFor = (
    authSessionId: string,
    requirementId: string,
    projectId: string,
  ) =>
    Math.max(
      revokedEpoch.get(authSessionId + ':*') ?? 0,
      revokedEpoch.get(authSessionId + ':' + requirementId) ?? 0,
      revokedEpoch.get(authSessionId + ':project:' + projectId) ?? 0,
    );
  const stale = (scope: Access) =>
    stopping ||
    blocked(scope.who.userId, scope.item.projectId, undefined, scope.item.id) ||
    changed(
      scope.who.userId,
      scope.item.projectId,
      scope.epoch,
      scope.item.id,
    ) ||
    closingSessions.has(scope.who.authSessionId) ||
    epochFor(scope.who.authSessionId, scope.item.id, scope.item.projectId) >
      scope.epoch;
  const transfers = new Set<{
    authSessionId: string;
    userId: string;
    requirementId: string;
    projectId: string;
    controller: AbortController;
    revoked: boolean;
  }>();
  const leases = new Map<
    string,
    {
      token: string;
      expiresAt: number;
      authSessionId: string;
      userId: string;
      requirementId: string;
      projectId: string;
      revoked: boolean;
    }
  >();
  const bridges = new Set<{
    authSessionId: string;
    userId: string;
    requirementId: string;
    projectId: string;
    close: () => void;
  }>();
  async function actor(headers: FastifyRequest['headers']) {
    const current = await auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });
    if (!current || closingSessions.has(current.session.id))
      fail(401, '请先登录');
    const user = await currentAccount(db, current.session.id, current.user.id);
    if (!user || closingSessions.has(current.session.id))
      fail(401, '账号或会话不可用');
    if (blocked(current.user.id)) throw new PendingAuthority();
    return {
      userId: user.id,
      authSessionId: current.session.id,
      platformAdmin: user.platformAdmin,
    };
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
  async function access(
    headers: FastifyRequest['headers'],
    id: string,
  ): Promise<Access> {
    const epoch = authorizationEpoch;
    const who = await actor(headers);
    const [row] = await db
      .select({
        item: schema.requirement,
        plan: schema.requirementWorktreePlan.repositories,
      })
      .from(schema.requirement)
      .leftJoin(
        schema.requirementWorktreePlan,
        eq(schema.requirementWorktreePlan.requirementId, schema.requirement.id),
      )
      .where(eq(schema.requirement.id, id))
      .catch((error) => {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === '42P01')
          businessError(503, '请先升级需求工作树数据库结构');
        throw error;
      });
    if (!row) fail(404, '需求不存在');
    const { item, plan } = row;
    await recoverPersonnelFences(who.userId, item.projectId, id);
    const roles = await projectRoles(who.userId, item.projectId);
    if (!roles.length) fail(403, '无权访问当前需求');
    const participants = await db
      .select({ role: schema.requirementParticipant.role })
      .from(schema.requirementParticipant)
      .where(
        and(
          eq(schema.requirementParticipant.requirementId, id),
          eq(schema.requirementParticipant.userId, who.userId),
        ),
      );
    if (
      !participants.some((item) => roles.includes(item.role)) &&
      !roles.includes('project_admin')
    )
      fail(403, '无权访问当前需求');
    const sessions = await db
      .select()
      .from(schema.nativeSession)
      .where(eq(schema.nativeSession.requirementId, id))
      .orderBy(
        asc(schema.nativeSession.createdAt),
        asc(schema.nativeSession.id),
      );
    if (epochFor(who.authSessionId, id, item.projectId) > epoch)
      fail(401, '授权已变化');
    const scope = {
      who,
      item,
      roles,
      sessions,
      epoch,
      plan: plan ?? undefined,
    };
    if (blocked(who.userId, item.projectId, undefined, id))
      throw new PendingAuthority();
    if (stale(scope)) fail(401, '授权已变化');
    return scope;
  }
  type Access = {
    who: Awaited<ReturnType<typeof actor>>;
    item: typeof schema.requirement.$inferSelect;
    roles: string[];
    sessions: (typeof schema.nativeSession.$inferSelect)[];
    epoch: number;
    plan?: DemandRepositories;
  };
  async function worktreeReady(scope: Access) {
    const { plan } = scope;
    if (
      plan &&
      !(await worktreesFor(scope.item.projectId).ready(
        scope.item.projectId,
        scope.item.id,
        plan,
      ))
    )
      businessError(503, '需求工作树尚未就绪，请从需求档案核对');
    if (stale(scope)) fail(401, '授权已变化');
    return !!plan;
  }
  const canPrepare = (scope: Access) =>
    scope.roles.some((role) =>
      ['project_admin', 'requirement_manager'].includes(role),
    );
  async function workspaceResult(
    scope: Access,
    plan: DemandRepositories | undefined,
  ): Promise<RequirementWorkspace> {
    return {
      state: !plan
        ? 'unconfigured'
        : (await worktreesFor(scope.item.projectId).ready(
              scope.item.projectId,
              scope.item.id,
              plan,
            ))
          ? 'ready'
          : 'pending',
      canPrepare: !!plan && canPrepare(scope),
      repositories: (plan ?? []).map(
        ({ repositoryId, baseCommit, branch, worktreePath, gitStorePath }) => ({
          repositoryId,
          baseCommit,
          branch,
          worktreePath,
          gitStorePath,
        }),
      ),
    };
  }
  async function prepareWorktrees(
    projectId: string,
    id: string,
    plan: DemandRepositories,
  ) {
    const driver = worktreesFor(projectId);
    try {
      await driver.prepare(projectId, id, plan);
      return 'ready' as const;
    } catch {
      return (await driver.ready(projectId, id, plan))
        ? ('ready' as const)
        : ('pending' as const);
    }
  }
  async function prepared(scope: Access) {
    if (stale(scope)) fail(401, '授权已变化');
    const existingOnly = await worktreeReady(scope);
    const runtime = await projects.get(scope.item.projectId);
    if (stale(scope)) fail(401, '授权已变化');
    const value = await runtime.native.workspace(
      scope.item.id,
      scope.item.title,
      existingOnly,
    );
    if (stale(scope)) fail(401, '授权已变化');
    if (!scope.item.nativeWorkspaceId) {
      const [updated] = await db
        .update(schema.requirement)
        .set({ nativeWorkspaceId: value.workspaceId })
        .where(
          and(
            eq(schema.requirement.id, scope.item.id),
            eq(schema.requirement.projectId, scope.item.projectId),
            isNull(schema.requirement.nativeWorkspaceId),
          ),
        )
        .returning({ nativeWorkspaceId: schema.requirement.nativeWorkspaceId });
      if (updated) scope.item.nativeWorkspaceId = updated.nativeWorkspaceId;
      else {
        const [current] = await db
          .select({ nativeWorkspaceId: schema.requirement.nativeWorkspaceId })
          .from(schema.requirement)
          .where(eq(schema.requirement.id, scope.item.id));
        scope.item.nativeWorkspaceId = current?.nativeWorkspaceId ?? null;
      }
    }
    if (scope.item.nativeWorkspaceId !== value.workspaceId)
      businessError(409, '原生工作区映射不一致，请联系项目维护者');
    if (stale(scope)) fail(401, '授权已变化');
    return runtime;
  }
  async function confirmAccess(
    headers: FastifyRequest['headers'],
    original: Access,
  ) {
    const fresh = await access(headers, original.item.id);
    if (
      stale(original) ||
      fresh.item.projectId !== original.item.projectId ||
      fresh.who.authSessionId !== original.who.authSessionId ||
      fresh.who.userId !== original.who.userId
    )
      fail(401, '授权已变化');
    return fresh;
  }
  async function readyAccess(
    headers: FastifyRequest['headers'],
    original: Access,
  ) {
    const runtime = await prepared(original);
    const fresh = await confirmAccess(headers, original);
    return { ...fresh, runtime };
  }
  async function ready(headers: FastifyRequest['headers'], id: string) {
    return readyAccess(headers, await access(headers, id));
  }
  type ReadyAccess = Awaited<ReturnType<typeof readyAccess>>;
  const loginBinding = ({ who, item }: Access) =>
    nativeLoginBinding(who.authSessionId, item.projectId, item.id);
  function verifyNativeLogin(scope: Access, binding: unknown) {
    if (binding !== loginBinding(scope))
      businessError(401, '登录已变化，请刷新后重新打开会话');
  }
  function nativeCarrier(request: FastifyRequest, socket: boolean) {
    const query = new URL(request.url, expectedOrigin).searchParams;
    const binding = socket
      ? query.get('login')
      : request.headers[nativeBindingHeader];
    const generation = socket
      ? query.get('generation')
      : request.headers[nativeGenerationHeader];
    if (
      (socket
        ? query.getAll('login').length > 1 ||
          query.getAll('generation').length > 1
        : query.has('login') || query.has('generation')) ||
      (binding != null &&
        (typeof binding !== 'string' || !/^[0-9a-f]{64}$/.test(binding))) ||
      typeof generation !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(generation)
    )
      fail(400, '连接标识不正确');
    return { binding, generation };
  }
  function grant(
    scope: ReadyAccess,
    purpose: 'browser' | 'create' = 'browser',
  ): Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'> {
    if (stale(scope)) fail(401, '授权已变化');
    return {
      purpose,
      userId: scope.who.userId,
      authSessionId: scope.who.authSessionId,
      requirementId: scope.item.id,
      workspaceId: scope.item.nativeWorkspaceId!,
      cwd: join(scope.runtime.native.demandRoot, scope.item.id),
      readSessionIds: scope.sessions.map((row) => row.id),
      ownSessionIds: scope.sessions
        .filter((row) => row.ownerId === scope.who.userId)
        .map((row) => row.id),
    };
  }
  function lease(scope: ReadyAccess, generation: string) {
    const id = scope.who.authSessionId + ':' + scope.item.id + ':' + generation;
    let item = leases.get(id);
    if (item && (item.revoked || item.expiresAt <= Date.now()))
      fail(409, '连接已过期，请重新连接');
    if (!item) {
      item = {
        token: scope.runtime.native.ticket(grant(scope)),
        expiresAt: Date.now() + LEASE_MS,
        authSessionId: scope.who.authSessionId,
        userId: scope.who.userId,
        requirementId: scope.item.id,
        projectId: scope.item.projectId,
        revoked: false,
      };
      leases.set(id, item);
    }
    return item.token;
  }
  async function revoke(
    authSessionId: string,
    requirementId?: string,
    projectId?: string,
    before = Date.now(),
    invalidateRuns = true,
  ) {
    authorizationEpoch++;
    revokedEpoch.set(
      authSessionId +
        ':' +
        (requirementId ?? (projectId ? 'project:' + projectId : '*')),
      authorizationEpoch,
    );
    for (const transfer of transfers)
      if (
        transfer.authSessionId === authSessionId &&
        (!projectId || transfer.projectId === projectId) &&
        (!requirementId || transfer.requirementId === requirementId)
      ) {
        transfer.revoked = true;
        transfer.controller.abort();
      }
    for (const lease of leases.values())
      if (
        lease.authSessionId === authSessionId &&
        (!projectId || lease.projectId === projectId) &&
        (!requirementId || lease.requirementId === requirementId)
      )
        lease.revoked = true;
    for (const bridge of [...bridges])
      if (
        bridge.authSessionId === authSessionId &&
        (!projectId || bridge.projectId === projectId) &&
        (!requirementId || bridge.requirementId === requirementId)
      )
        bridge.close();
    const targets = projectId
      ? [projects.peek(projectId)].filter((item) => item !== undefined)
      : projects.all();
    const results = await Promise.allSettled(
      targets.map(async (runtime) => {
        if (invalidateRuns) runtime.runs.revoke(authSessionId, requirementId);
        await runtime.native.revoke(
          authSessionId,
          requirementId,
          before,
          invalidateRuns,
        );
      }),
    );
    return results.every((result) => result.status === 'fulfilled');
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === nativeMuxPath) return;
    const passiveRead = isPassiveSessionRead(request);
    const sessionWrite = isSessionWrite(request);
    if (passiveRead || sessionWrite) reply.header('cache-control', 'no-store');
    if (
      Object.keys(request.headers).some(
        (key) =>
          key.startsWith('x-rdws-') &&
          !(
            (key === nativeBindingHeader || key === nativeGenerationHeader) &&
            request.method === 'POST' &&
            request.routeOptions.url === nativeTransportPath
          ) &&
          !(
            key === 'x-rdws-edit-session' &&
            (isTemplateBindingRequest(request) ||
              isImportRequest(request) ||
              passiveRead ||
              sessionWrite ||
              (request.method === 'GET' &&
                request.routeOptions.url === nativeBootstrapPath) ||
              (request.routeOptions.url === personnelPath &&
                (request.method === 'GET' || request.method === 'POST')) ||
              (request.method === 'GET' &&
                request.routeOptions.url === '/api/requirements/:id') ||
              (request.method === 'POST' &&
                request.routeOptions.url === '/api/requirements/:id/details'))
          ),
      )
    )
      return reply.code(403).send({ error: '身份头不受信任' });
  });
  const responseScopes = new WeakMap<
    FastifyRequest,
    {
      userId: string;
      authSessionId: string;
      projectId?: string;
      epoch: number;
      requirementId?: string;
      demandList?: boolean;
      platformOnly?: boolean;
      memberOnly?: boolean;
      importReply?: string[];
      demandAccess?: {
        requirementId: string;
        projectId: string;
        authority: RequirementAuthority;
      };
    }
  >();
  function assertResponse(
    scope: {
      userId: string;
      authSessionId: string;
      projectId?: string;
      epoch: number;
      requirementId?: string;
      demandList?: boolean;
      importReply?: string[];
    },
    ignore?: string,
  ) {
    const {
      userId,
      authSessionId,
      projectId,
      epoch,
      requirementId,
      demandList,
    } = scope;
    const importDemandChanged = scope.importReply?.some(
      (id) =>
        blocked(userId, projectId, ignore, id) ||
        changed(userId, projectId, epoch, id),
    );
    if (
      stopping ||
      closingSessions.has(authSessionId) ||
      blocked(userId, projectId, ignore, requirementId, demandList) ||
      changed(userId, projectId, epoch, requirementId, demandList) ||
      importDemandChanged
    )
      businessError(401, '当前权限正在变更，请刷新后重试');
  }
  app.addHook('preHandler', async (request, reply) => {
    if (isImportRequest(request)) return;
    const personnel = request.routeOptions.url === personnelPath;
    if (request.routeOptions.url === templateBindingPath || personnel)
      reply.header('cache-control', 'no-store');
    const path = new URL(request.url, expectedOrigin).pathname;
    const project = /^\/api\/projects\/([^/]+)/.exec(path);
    const demand = /^\/api\/(?:requirements|dsh)\/([^/]+)/.exec(path);
    if (path !== '/api/projects' && !project && !demand) return;
    const templateBinding = isTemplateBindingRequest(request);
    const passiveRead = isPassiveSessionRead(request);
    const epoch = authorizationEpoch;
    const who = await actor(request.headers);
    if (templateBinding) verifyEditLogin(request, who.authSessionId);
    if (passiveRead || isSessionWrite(request))
      verifyEditLogin(request, who.authSessionId, false);
    if (personnel) verifyEditLogin(request, who.authSessionId, true);
    const requirementId = demand ? decodeURIComponent(demand[1]!) : undefined;
    const projectId = project
      ? decodeURIComponent(project[1]!)
      : requirementId
        ? (
            await db
              .select({ projectId: schema.requirement.projectId })
              .from(schema.requirement)
              .where(eq(schema.requirement.id, requirementId))
          )[0]?.projectId
        : ':project-list';
    const demandList =
      request.routeOptions.url === '/api/projects/:projectId/requirements' &&
      (request.method === 'GET' || request.method === 'HEAD');
    if (projectId && (requirementId || demandList))
      await recoverPersonnelFences(
        who.userId,
        projectId,
        requirementId,
        demandList,
      );
    const scope = { ...who, projectId, epoch, requirementId, demandList };
    assertResponse(scope);
    responseScopes.set(
      request,
      passiveRead && projectId && requirementId
        ? {
            ...scope,
            demandAccess: { projectId, requirementId, authority: 'reader' },
          }
        : scope,
    );
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const scope = responseScopes.get(request);
    if (
      scope &&
      (reply.statusCode < 400 ||
        ((scope.requirementId || scope.importReply) &&
          reply.statusCode === 409))
    ) {
      if (scope.importReply)
        await business.authorizeImport(
          scope,
          scope.projectId!,
          scope.importReply,
        );
      if (scope.demandAccess) {
        const { requirementId, projectId, authority } = scope.demandAccess;
        await business.authorizeRequirement(
          scope,
          requirementId,
          projectId,
          authority,
        );
      }
      if (scope.platformOnly) {
        const current = await currentAccount(
          db,
          scope.authSessionId,
          scope.userId,
        );
        if (!current) fail(401, '账号或会话不可用');
        if (!current.platformAdmin)
          businessError(403, '无权读取平台能力白名单');
      }
      if (scope.memberOnly) {
        const [current] = await db
          .select({
            expiresAt: schema.session.expiresAt,
            membership: schema.projectMember.projectId,
          })
          .from(schema.session)
          .innerJoin(schema.user, eq(schema.session.userId, schema.user.id))
          .leftJoin(
            schema.projectMember,
            and(
              eq(schema.projectMember.userId, schema.user.id),
              eq(schema.projectMember.projectId, scope.projectId!),
            ),
          )
          .where(
            and(
              eq(schema.session.id, scope.authSessionId),
              eq(schema.user.id, scope.userId),
              eq(schema.user.active, true),
              eq(schema.session.authEpoch, schema.user.authEpoch),
            ),
          )
          .limit(1);
        if (!current || current.expiresAt <= new Date())
          fail(401, '账号或会话不可用');
        if (!current.membership) businessError(403, '无权读取当前项目模板');
      }
      assertResponse(scope);
    }
    return payload;
  });
  app.get(
    '/api/projects',
    { schema: { response: { 200: ProjectList } } },
    async (request) => {
      const who = await actor(request.headers);
      const rows = await db
        .select({
          id: schema.project.id,
          name: schema.project.name,
          role: schema.projectMember.role,
        })
        .from(schema.projectMember)
        .innerJoin(
          schema.project,
          eq(schema.project.id, schema.projectMember.projectId),
        )
        .where(eq(schema.projectMember.userId, who.userId))
        .orderBy(asc(schema.project.id), asc(schema.projectMember.role));
      const result = new Map<
        string,
        { id: string; name: string; roles: string[] }
      >();
      for (const row of rows) {
        const item = result.get(row.id) ?? {
          id: row.id,
          name: row.name,
          roles: [],
        };
        item.roles.push(row.role);
        result.set(row.id, item);
      }
      return { projects: [...result.values()] };
    },
  );
  const nameProjection = {
    username: schema.user.username,
    name: schema.user.name,
    active: schema.user.active,
  };
  app.get(
    '/api/management/capability-approvals',
    async (request, reply): Promise<CapabilityApprovalList> => {
      reply.header('cache-control', 'no-store');
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      if (!who.platformAdmin) businessError(403, '无权读取平台能力白名单');
      const table = schema.capabilityApproval;
      const approvals = await db
        .select({
          kind: table.kind,
          reference: table.reference,
          revision: table.revision,
          approved: table.approved,
        })
        .from(table)
        .orderBy(asc(table.kind), asc(table.reference), asc(table.revision));
      responseScopes.set(request, { ...who, epoch, platformOnly: true });
      return { approvals };
    },
  );
  app.get(
    '/api/management/platform',
    async (request): Promise<PlatformAdministration> => {
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      if (!who.platformAdmin) businessError(403, '无权管理平台设置');
      const [accounts, records, admins] = await Promise.all([
        db
          .select({
            ...nameProjection,
            platformAdmin: schema.user.platformAdmin,
          })
          .from(schema.user)
          .orderBy(asc(schema.user.username)),
        db
          .select({ id: schema.project.id, name: schema.project.name })
          .from(schema.project)
          .orderBy(asc(schema.project.id)),
        db
          .select({
            username: schema.user.username,
            projectId: schema.projectMember.projectId,
          })
          .from(schema.projectMember)
          .innerJoin(
            schema.user,
            eq(schema.user.id, schema.projectMember.userId),
          )
          .where(eq(schema.projectMember.role, 'project_admin')),
      ]);
      const registered = await Promise.all(
        records.map(async (item) => ({
          ...item,
          nativeConfigured: await projects.configured(item.id),
          admins: admins
            .filter((row) => row.projectId === item.id)
            .flatMap((row) => (row.username ? [row.username] : []))
            .sort(),
        })),
      );
      assertResponse({ ...who, epoch });
      responseScopes.set(request, { ...who, epoch });
      return {
        projects: registered,
        accounts: accounts.flatMap((row) =>
          row.username ? [{ ...row, username: row.username }] : [],
        ),
      };
    },
  );
  async function projectTemplates(
    projectId: string,
  ): Promise<CapabilityTemplateManagement> {
    return db.transaction(
      async (tx) => {
        const table = schema.capabilityTemplateRevision;
        const rows = await tx
          .selectDistinctOn([table.templateId], {
            templateId: table.templateId,
            revision: table.revision,
            name: table.name,
            description: table.description,
            capabilities: table.capabilities,
          })
          .from(table)
          .where(eq(table.projectId, projectId))
          .orderBy(asc(table.templateId), desc(table.revision));
        const approval = schema.capabilityApproval;
        const options = await tx
          .select({
            kind: approval.kind,
            reference: approval.reference,
            revision: approval.revision,
          })
          .from(approval)
          .where(eq(approval.approved, true))
          .orderBy(
            asc(approval.kind),
            asc(approval.reference),
            asc(approval.revision),
          );
        const approved = new Set(options.map(capabilityKey));
        return {
          options,
          templates: rows.map((row) => ({
            ...row,
            capabilities: row.capabilities.map((item) => ({
              ...item,
              approved: approved.has(capabilityKey(item)),
            })),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  app.get<{ Params: { projectId: string } }>(
    '/api/management/projects/:projectId/capability-templates',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      if (!who.platformAdmin) businessError(403, '无权管理项目能力模板');
      const { projectId } = request.params;
      const [project] = await db
        .select({ id: schema.project.id })
        .from(schema.project)
        .where(eq(schema.project.id, projectId));
      if (!project) businessError(404, '项目不存在');
      const data = await projectTemplates(projectId);
      responseScopes.set(request, { ...who, epoch, platformOnly: true });
      return data;
    },
  );
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/capability-templates',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      const { projectId } = request.params;
      if (!(await projectRoles(who.userId, projectId)).length)
        businessError(403, '无权读取当前项目模板');
      const { templates } = await projectTemplates(projectId);
      responseScopes.set(request, {
        ...who,
        epoch,
        projectId,
        memberOnly: true,
      });
      return { templates };
    },
  );
  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/access',
    async (request): Promise<ProjectAdministration> => {
      const { projectId } = request.params;
      const who = await actor(request.headers);
      if (
        !(await projectRoles(who.userId, projectId)).includes('project_admin')
      )
        businessError(403, '无权管理当前项目成员');
      const [project] = await db
        .select({ id: schema.project.id, name: schema.project.name })
        .from(schema.project)
        .where(eq(schema.project.id, projectId));
      if (!project) businessError(404, '项目不存在');
      const rows = await db
        .select({ ...nameProjection, role: schema.projectMember.role })
        .from(schema.projectMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
        .where(eq(schema.projectMember.projectId, projectId))
        .orderBy(asc(schema.user.username), asc(schema.projectMember.role));
      const members = new Map<
        string,
        ProjectAdministration['members'][number]
      >();
      for (const { username, name, active, role } of rows) {
        if (!username) continue;
        const member = members.get(username) ?? {
          username,
          name,
          active,
          roles: [],
        };
        member.roles.push(role);
        members.set(username, member);
      }
      return {
        project: {
          ...project,
          nativeConfigured: await projects.configured(projectId),
        },
        members: [...members.values()],
      };
    },
  );
  async function revokeMember(
    userId: string,
    projectId?: string,
    requirementId?: string,
    before = Date.now(),
  ) {
    ++authorizationEpoch;
    scopeEpochs.set(
      scopeKey(userId, requirementId ? 'demand:' + requirementId : projectId),
      authorizationEpoch,
    );
    scopeEpochs.set(
      scopeKey(
        userId,
        requirementId ? 'demands:' + projectId : ':project-list',
      ),
      authorizationEpoch,
    );
    for (const transfer of transfers)
      if (
        transfer.userId === userId &&
        (!projectId || transfer.projectId === projectId) &&
        (!requirementId || transfer.requirementId === requirementId)
      ) {
        transfer.revoked = true;
        transfer.controller.abort();
      }
    for (const lease of leases.values())
      if (
        lease.userId === userId &&
        (!projectId || lease.projectId === projectId) &&
        (!requirementId || lease.requirementId === requirementId)
      )
        lease.revoked = true;
    for (const bridge of [...bridges])
      if (
        bridge.userId === userId &&
        (!projectId || bridge.projectId === projectId) &&
        (!requirementId || bridge.requirementId === requirementId)
      )
        bridge.close();
    for (const runtime of projects.all())
      if (!projectId || runtime.native.projectId === projectId)
        runtime.runs.revokeUser(userId, requirementId);
    const sessions = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, userId))
      .catch(() => undefined);
    if (!sessions) return false;
    return (
      await Promise.all(
        sessions.map((item) =>
          revoke(item.id, requirementId, projectId, before),
        ),
      )
    ).every(Boolean);
  }
  async function settlePersonnelFence(
    entry: PersonnelFence,
    committed: boolean,
  ) {
    if (personnelFences.get(entry.key) !== entry) return false;
    const results = committed
      ? await Promise.all(
          entry.userIds.map((id) =>
            revokeMember(
              id,
              entry.projectId,
              entry.requirementId,
              entry.cutoff,
            ).catch(() => false),
          ),
        )
      : [];
    if (personnelFences.get(entry.key) === entry)
      personnelFences.delete(entry.key);
    return results.every(Boolean);
  }
  function recoverPersonnelFence(entry: PersonnelFence) {
    entry.recovery ??= (async () => {
      const committed = await business
        .recoverPersonnelCommit(
          entry.actorId,
          entry.projectId,
          entry.requirementId,
          entry.commandId,
          entry.digest,
        )
        .catch(() => undefined);
      if (committed !== undefined) await settlePersonnelFence(entry, committed);
    })().finally(() => {
      entry.recovery = undefined;
    });
    return entry.recovery;
  }
  async function recoverPersonnelFences(
    userId: string,
    projectId: string,
    requirementId?: string,
    list = false,
  ) {
    for (const entry of personnelFences.values()) {
      if (
        entry.uncertain &&
        entry.projectId === projectId &&
        (list || entry.requirementId === requirementId) &&
        (entry.actorId === userId || entry.userIds.includes(userId))
      )
        await recoverPersonnelFence(entry);
    }
  }
  const commandFields = {
    'project.create': ['projectId', 'name', 'username'],
    'project.rename': ['projectId', 'name'],
    'project.roles': ['projectId', 'username', 'roles'],
    'project.admin': ['projectId', 'username', 'enabled'],
    'account.active': ['username', 'active'],
    'capability.approval': [
      'capabilityKind',
      'reference',
      'revision',
      'approved',
    ],
    'capability.template.save': [
      'projectId',
      'templateId',
      'expectedRevision',
      'name',
      'description',
      'capabilities',
    ],
  } as const;
  app.post<{ Body: ManagementCommand }>(
    '/api/management/commands',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          allOf: ManagementCommand.anyOf.map((command) => ({
            if: { properties: { kind: command.properties.kind } },
            then: command,
          })),
        },
      },
      preValidation: async (request) => {
        const body = request.body;
        if (
          !isRecord(body) ||
          typeof body.kind !== 'string' ||
          !Object.hasOwn(commandFields, body.kind) ||
          !onlyKeys(body, [
            'kind',
            'commandId',
            ...commandFields[body.kind as keyof typeof commandFields],
          ])
        )
          businessError(400, '管理操作参数不正确');
        if (
          body.kind === 'capability.approval' &&
          (typeof body.commandId !== 'string' ||
            typeof body.capabilityKind !== 'string' ||
            typeof body.reference !== 'string' ||
            typeof body.revision !== 'string' ||
            typeof body.approved !== 'boolean')
        )
          businessError(400, '审核登记参数不正确');
        if (body.kind === 'capability.template.save') {
          const {
            projectId,
            templateId,
            expectedRevision,
            name,
            description,
            capabilities,
          } = body;
          if (
            typeof body.commandId !== 'string' ||
            typeof projectId !== 'string' ||
            (templateId === undefined) !== (expectedRevision === undefined) ||
            (templateId !== undefined &&
              (typeof templateId !== 'string' ||
                !Number.isInteger(expectedRevision))) ||
            typeof name !== 'string' ||
            name.includes('\0') ||
            typeof description !== 'string' ||
            description.includes('\0') ||
            !Array.isArray(capabilities) ||
            capabilities.some(
              (item: unknown) =>
                !isRecord(item) ||
                !onlyKeys(item, ['kind', 'reference', 'revision']) ||
                typeof item.kind !== 'string' ||
                typeof item.reference !== 'string' ||
                typeof item.revision !== 'string',
            )
          )
            businessError(400, '能力模板参数不正确');
          if (
            new Set((capabilities as CapabilityVersion[]).map(capabilityKey))
              .size !== capabilities.length
          )
            businessError(400, '模板引用重复');
        }
      },
    },
    async (request): Promise<ManagementResult> => {
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      const input = request.body;
      const project = 'projectId' in input ? input.projectId : undefined;
      const key = JSON.stringify([
        who.userId,
        project,
        input.kind,
        input.commandId,
      ]);
      const digest = digestOf(normalizeManagement(input));
      const held = fences.get(key);
      if (held && held.digest !== digest)
        businessError(409, '操作标识已用于不同内容，请核对原操作');
      assertResponse(
        { ...who, projectId: project, epoch: authorizationEpoch },
        held ? key : undefined,
      );
      let mine = false,
        retain = false;
      try {
        const result = await business.manage(
          who,
          input,
          (userId, projectId) => {
            if (!fences.has(key)) mine = true;
            fences.set(key, { userId, projectId, digest });
          },
          () => assertResponse({ ...who, epoch }),
        );
        if ('unknown' in result) {
          retain = true;
          businessError(503, '管理操作结果待核对，请重试同一操作');
        }
        const { receipt, replayed } = result;
        const pending = fences.get(key);
        const actorFence =
          pending &&
          receipt.targetId === pending.userId &&
          receipt.projectId === pending.projectId;
        if (actorFence && !receipt.changed) fences.delete(key);
        if (actorFence && receipt.changed && receipt.targetId) {
          let notification = pendingNotifications.get(key);
          if (!notification) {
            notification = revokeMember(
              receipt.targetId,
              receipt.projectId,
            ).finally(() => {
              fences.delete(key);
              pendingNotifications.delete(key);
            });
            pendingNotifications.set(key, notification);
          }
          const confirmed = await notification;
          return {
            changed: true,
            replayed,
            revocation: confirmed ? 'confirmed' : 'lease-expiry',
          };
        }
        return {
          changed: receipt.changed,
          replayed,
          ...(receipt.template ? { template: receipt.template } : {}),
          revocation:
            replayed && receipt.changed && receipt.targetId
              ? 'previously-recorded'
              : 'none',
        };
      } finally {
        if (mine && !retain) fences.delete(key);
      }
    },
  );
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
            memberships.some(
              (member) =>
                member.requirementId === row.id && roles.includes(member.role),
            ),
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
  const importRoute = {
    bodyLimit: importLimits.bytes,
    attachValidation: true,
    async onRequest(request: FastifyRequest, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      verifyEditLogin(request, who.authSessionId);
      const { projectId } = request.params as { projectId: string };
      const scope = { ...who, projectId, epoch, importReply: [] as string[] };
      assertResponse(scope);
      await business.authorizeImport(who, projectId);
      assertResponse(scope);
      responseScopes.set(request, scope);
    },
    async preValidation(request: FastifyRequest, reply: FastifyReply) {
      const raw: unknown = request.body;
      const commit = request.routeOptions.url === importCommitPath;
      const columns = Object.keys(importColumns);
      if (
        !isRecord(raw) ||
        !onlyKeys(raw, commit ? ['commandId', 'rows'] : ['rows']) ||
        (commit && typeof raw.commandId !== 'string') ||
        !Array.isArray(raw.rows) ||
        raw.rows.length > importLimits.rows ||
        !raw.rows.every(
          (row) =>
            isRecord(row) &&
            onlyKeys(row, ['row', ...columns]) &&
            typeof row.row === 'number' &&
            columns.every(
              (field) =>
                typeof row[field] === 'string' &&
                !/[\0\p{Surrogate}]/u.test(row[field]),
            ),
        ) ||
        new Set(raw.rows.map((row) => row.row)).size !== raw.rows.length
      )
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
    },
  };
  app.post<{ Body: { rows: RequirementImportRow[] } }>(
    importPreviewPath,
    {
      ...importRoute,
      schema: { body: RequirementImportPreviewInput },
    },
    async (request, reply) => {
      if (request.validationError)
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
      const scope = requestDemandScope(request);
      return business.previewImport(scope, scope.projectId, request.body.rows);
    },
  );
  app.post<{ Body: RequirementImportInput }>(
    importCommitPath,
    {
      ...importRoute,
      schema: { body: RequirementImportInput },
    },
    async (request, reply) => {
      if (request.validationError)
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
      const scope = requestDemandScope(request);
      const input = request.body;
      let receipt = await business.findImportReceipt(
        scope,
        scope.projectId,
        input,
      );
      if (!receipt) {
        let baselines:
          Awaited<ReturnType<typeof mirrors.captureBaselines>> | undefined;
        try {
          baselines = await mirrors.captureBaselines(scope.projectId);
        } catch {
          receipt = await business.findImportReceipt(
            scope,
            scope.projectId,
            input,
          );
          if (!receipt) businessError(503, '暂未取得已验基线，请核对原批次');
        }
        if (!receipt && baselines) {
          assertResponse(scope);
          receipt = await business.commitImport(
            scope,
            scope.projectId,
            input,
            baselines,
            () => assertResponse(scope),
          );
        }
      }
      if (receipt === 'conflict')
        return reply.code(409).send({
          code: 'command-conflict',
          error: '操作标识已用于不同内容，请重新校验后提交',
        });
      if (!receipt) businessError(503, '导入结果待核对，请重试原批次');
      if (receipt.status === 'rejected') return receipt;
      const ids = receipt.rows.map((row) => row.id);
      const scoped = { ...scope, importReply: ids };
      responseScopes.set(request, scoped);
      await business.authorizeImport(scope, scope.projectId, ids);
      assertResponse(scoped);
      const registered = await db
        .select()
        .from(schema.requirementWorktreePlan)
        .where(inArray(schema.requirementWorktreePlan.requirementId, ids));
      const plans = new Map(
        registered.map((row) => [row.requirementId, row.repositories]),
      );
      const rows: Extract<
        RequirementImportReceipt,
        { status: 'created' }
      >['rows'] = [];
      for (let offset = 0; offset < receipt.rows.length; offset += 4) {
        assertResponse(scoped);
        rows.push(
          ...(await Promise.all(
            receipt.rows.slice(offset, offset + 4).map(async (row) => {
              const plan = plans.get(row.id);
              const workspaceState = plan
                ? (await worktreesFor(scope.projectId).ready(
                    scope.projectId,
                    row.id,
                    plan,
                  ))
                  ? 'ready'
                  : 'pending'
                : 'unconfigured';
              return { ...row, workspaceState } as const;
            }),
          )),
        );
      }
      return { ...receipt, rows };
    },
  );
  app.post(
    '/api/projects/:projectId/requirements',
    { schema: { body: RequirementInput } },
    async (request) => {
      const epoch = authorizationEpoch;
      const who = await actor(request.headers);
      const { projectId } = request.params as { projectId: string };
      const input = request.body as RequirementInput;
      const confirm = () => assertResponse({ ...who, projectId, epoch });
      let created = await business.findCreatedRequirement(
        who,
        projectId,
        input,
      );
      let baselines: Awaited<ReturnType<typeof mirrors.captureBaselines>> = [];
      if (!created) {
        try {
          baselines = await mirrors.captureBaselines(projectId);
        } catch {
          created = await business.findCreatedRequirement(
            who,
            projectId,
            input,
          );
          if (!created)
            businessError(503, '暂未取得已验基线，请核对原创建操作');
        }
      }
      confirm();
      const { rows } = await db.execute(
        sql`select to_regclass('public.requirement_worktree_plan') is not null as ready`,
      );
      if (!rows[0]?.ready) businessError(503, '请先升级需求工作树数据库结构');
      const record = created
        ? { ...created, first: false }
        : await business.create(who, projectId, input, baselines, confirm);
      const { plan } = await access(request.headers, record.id);
      const state = plan
        ? record.first
          ? await prepareWorktrees(projectId, record.id, plan)
          : (await worktreesFor(projectId).ready(projectId, record.id, plan))
            ? 'ready'
            : 'pending'
        : undefined;
      await business.findCreatedRequirement(who, projectId, input);
      await access(request.headers, record.id);
      confirm();
      return state
        ? { id: record.id, workspaceState: state }
        : { id: record.id };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/requirements/:id/worktrees',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const scope = await access(request.headers, request.params.id);
      const { plan } = scope;
      const data = await workspaceResult(scope, plan);
      const fresh = await access(request.headers, scope.item.id);
      if (stale(scope)) fail(401, '授权已变化');
      return { ...data, canPrepare: !!plan && canPrepare(fresh) };
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/requirements/:id/worktrees',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (
        request.body !== undefined &&
        (!isRecord(request.body) || Object.keys(request.body).length)
      )
        businessError(400, '工作树准备不接受外部参数');
      const scope = await access(request.headers, request.params.id);
      if (!canPrepare(scope)) businessError(403, '无权准备需求工作树');
      const { plan } = scope;
      if (!plan) businessError(409, '需求未登记冻结基线');
      const admission = await access(request.headers, scope.item.id);
      if (!canPrepare(admission) || stale(scope))
        businessError(403, '需求工作树准备权限已变化');
      const state = await prepareWorktrees(
        scope.item.projectId,
        scope.item.id,
        plan,
      );
      const fresh = await access(request.headers, scope.item.id);
      if (!canPrepare(fresh) || stale(scope))
        businessError(403, '需求工作树准备权限已变化');
      return { state };
    },
  );
  function requestDemandScope(request: FastifyRequest) {
    const original = responseScopes.get(request);
    if (!original?.projectId) businessError(404, '需求不存在');
    return { ...original, projectId: original.projectId };
  }
  function verifyEditLogin(
    request: FastifyRequest,
    authSessionId: string,
    required = request.method === 'POST',
  ) {
    const observed = request.headers['x-rdws-edit-session'];
    if ((required || observed !== undefined) && observed !== authSessionId)
      businessError(401, '登录已变化，请刷新后重试');
  }
  app.get<{ Params: { id: string } }>(
    '/api/requirements/:id',
    {
      async onRequest(_request, reply) {
        reply.header('cache-control', 'no-store');
      },
    },
    async (request) => {
      const scope = requestDemandScope(request);
      verifyEditLogin(request, scope.authSessionId);
      const { id } = request.params;
      const detail = await business.read(scope, id);
      if (detail.requirement.projectId !== scope.projectId)
        businessError(403, '需求所属项目已变化');
      responseScopes.set(request, {
        ...scope,
        demandAccess: {
          requirementId: id,
          projectId: scope.projectId,
          authority: detail.permissions.canEditDetails ? 'editor' : 'reader',
        },
      });
      return detail;
    },
  );
  app.post<{ Params: { id: string }; Body: RequirementDetailsInput }>(
    '/api/requirements/:id/details',
    {
      schema: { body: RequirementDetailsInput },
      attachValidation: true,
      async onRequest(_request, reply) {
        reply.header('cache-control', 'no-store');
      },
      async preValidation(request, reply) {
        const raw: unknown = request.body;
        if (
          !isRecord(raw) ||
          !onlyKeys(raw, ['commandId', 'patch']) ||
          typeof raw.commandId !== 'string' ||
          !isRecord(raw.patch) ||
          !onlyKeys(raw.patch, ['title', 'description', 'acceptance']) ||
          !Object.keys(raw.patch).length ||
          Object.values(raw.patch).some(
            (value) =>
              typeof value !== 'string' || /[\0\p{Surrogate}]/u.test(value),
          )
        )
          return reply
            .code(400)
            .send({ code: 'invalid-details', error: '需求资料参数不正确' });
        if (typeof raw.patch.title === 'string')
          raw.patch.title = raw.patch.title.trim();
      },
    },
    async (request, reply) => {
      if (request.validationError)
        return reply
          .code(400)
          .send({ code: 'invalid-details', error: '需求资料参数不正确' });
      const scope = requestDemandScope(request);
      verifyEditLogin(request, scope.authSessionId);
      const { id } = request.params;
      const result = await business.editDetails(
        scope,
        id,
        scope.projectId,
        request.body,
        () => assertResponse(scope),
      );
      responseScopes.set(request, {
        ...scope,
        demandAccess: {
          requirementId: id,
          projectId: scope.projectId,
          authority: 'editor',
        },
      });
      if (result === 'conflict')
        return reply.code(409).send({
          code: 'command-conflict',
          error: '操作标识已用于不同内容，请重新编辑',
        });
      return result;
    },
  );
  function templateBindingFailure(error: unknown): never {
    const failure = error as { code?: string; cause?: { code?: string } };
    if ((failure.cause?.code ?? failure.code) === '42P01')
      businessError(503, '请先升级需求模板绑定数据库结构');
    throw error;
  }
  app.get<{ Params: { id: string } }>(personnelPath, async (request) => {
    const scope = requestDemandScope(request);
    const { id } = request.params;
    await business.authorizeRequirement(scope, id, scope.projectId, 'editor');
    const members = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        role: schema.projectMember.role,
      })
      .from(schema.projectMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
      .where(
        and(
          eq(schema.projectMember.projectId, scope.projectId),
          eq(schema.user.active, true),
          inArray(schema.projectMember.role, [...personnelRoles]),
        ),
      )
      .orderBy(
        asc(schema.user.name),
        asc(schema.user.id),
        asc(schema.projectMember.role),
      );
    responseScopes.set(request, {
      ...scope,
      demandAccess: {
        requirementId: id,
        projectId: scope.projectId,
        authority: 'editor',
      },
    });
    return { members };
  });
  app.post<{ Params: { id: string }; Body: RequirementPersonnelInput }>(
    personnelPath,
    {
      schema: { body: RequirementPersonnelInput },
      attachValidation: true,
      async preValidation(request, reply) {
        reply.header('cache-control', 'no-store');
        const raw: unknown = request.body;
        const textFields = [
          'commandId',
          'previewLeadId',
          'leadId',
          'taskDigest',
        ] as const;
        const validText = (value: unknown) =>
          typeof value === 'string' && !/[\0\p{Surrogate}]/u.test(value);
        const validRows = (value: unknown, fields: string[]) =>
          Array.isArray(value) &&
          value.every(
            (row) =>
              isRecord(row) &&
              onlyKeys(row, fields) &&
              fields.every((field) => validText(row[field])),
          );
        if (
          !isRecord(raw) ||
          !onlyKeys(raw, [
            ...textFields,
            'add',
            'remove',
            'handoffs',
            'overrides',
          ]) ||
          !textFields.every((field) => validText(raw[field])) ||
          !validRows(raw.add, ['userId', 'role']) ||
          !validRows(raw.remove, ['userId', 'role']) ||
          !validRows(raw.handoffs, ['fromId', 'toId']) ||
          !validRows(raw.overrides, ['taskId', 'toId'])
        )
          return reply
            .code(400)
            .send({ code: 'invalid-personnel', error: '需求人员参数不正确' });
      },
    },
    async (request, reply): Promise<RequirementPersonnelReceipt | void> => {
      const scope = requestDemandScope(request);
      const { id } = request.params;
      const input = request.body;
      if (
        request.validationError ||
        new Set(
          [...input.add, ...input.remove].map(
            ({ userId, role }) => `${userId}:${role}`,
          ),
        ).size !==
          input.add.length + input.remove.length ||
        new Set(input.handoffs.map((entry) => entry.fromId)).size !==
          input.handoffs.length ||
        new Set(input.overrides.map((entry) => entry.taskId)).size !==
          input.overrides.length
      ) {
        await reply
          .code(400)
          .send({ code: 'invalid-personnel', error: '需求人员参数重复或无效' });
        return;
      }
      const key = JSON.stringify([
        scope.userId,
        scope.projectId,
        id,
        input.commandId,
      ]);
      if (personnelFences.has(key))
        businessError(503, '人员变更结果尚未确认，请重试原操作');
      let entry: PersonnelFence | undefined;
      try {
        const result = await business.editPersonnel(
          scope,
          scope.projectId,
          id,
          input,
          () => {
            assertResponse(scope);
            if (personnelFences.has(key))
              businessError(503, '人员变更结果尚未确认，请重试原操作');
          },
          (userIds) => {
            entry = {
              key,
              actorId: scope.userId,
              projectId: scope.projectId,
              requirementId: id,
              commandId: input.commandId,
              digest: digestOf(normalizePersonnel(input)),
              cutoff: Date.now(),
              userIds,
            };
            personnelFences.set(key, entry);
          },
        );
        responseScopes.set(request, {
          ...scope,
          demandAccess: {
            requirementId: id,
            projectId: scope.projectId,
            authority: 'editor',
          },
        });
        if (result === 'conflict') {
          await reply.code(409).send({
            code: 'command-conflict',
            error: '操作标识已用于不同内容，请重新编辑',
          });
          return;
        }
        const { removedUserIds, ...receipt } = result;
        const revocation = entry
          ? (await settlePersonnelFence(entry, true))
            ? 'confirmed'
            : 'lease-expiry'
          : removedUserIds.length
            ? 'previously-recorded'
            : 'none';
        return { ...receipt, revocation };
      } catch (error) {
        if (!entry) throw error;
        entry.uncertain = true;
        await recoverPersonnelFence(entry);
        if (!personnelFences.has(key)) {
          await business.authorizeRequirement(
            scope,
            id,
            scope.projectId,
            'editor',
          );
          assertResponse(scope);
        }
        businessError(503, '人员变更结果尚未确认，请重试原操作');
      }
    },
  );
  app.get<{ Params: { id: string } }>(templateBindingPath, async (request) => {
    const scope = requestDemandScope(request);
    const { id } = request.params;
    const result = await business
      .readTemplateBinding(scope, id, scope.projectId)
      .catch(templateBindingFailure);
    responseScopes.set(request, {
      ...scope,
      demandAccess: {
        requirementId: id,
        projectId: scope.projectId,
        authority: result.options !== undefined ? 'project-admin' : 'reader',
      },
    });
    return result;
  });
  app.post<{ Params: { id: string }; Body: TemplateBindingInput }>(
    templateBindingPath,
    {
      schema: { body: TemplateBindingInput },
      async preValidation(request, reply) {
        reply.header('cache-control', 'no-store');
        const raw: unknown = request.body;
        if (
          !isRecord(raw) ||
          !onlyKeys(raw, ['commandId', 'templateId', 'revision']) ||
          typeof raw.commandId !== 'string' ||
          typeof raw.templateId !== 'string' ||
          typeof raw.revision !== 'number'
        )
          businessError(400, '能力模板绑定参数不正确');
      },
    },
    async (request, reply) => {
      const scope = requestDemandScope(request);
      const { id } = request.params;
      const result = await business
        .bindTemplate(scope, id, scope.projectId, request.body, () =>
          assertResponse(scope),
        )
        .catch(templateBindingFailure);
      responseScopes.set(request, {
        ...scope,
        demandAccess: {
          requirementId: id,
          projectId: scope.projectId,
          authority: 'project-admin',
        },
      });
      if (result === 'conflict')
        return reply
          .code(409)
          .send({ error: '操作标识已用于不同内容，请核对原操作' });
      return result;
    },
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
  app.get(sessionsPath, async (request) => {
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
    await worktreeReady(scope);
    const runtime = await projects.get(scope.item.projectId);
    return runtime.sessions.execute(
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
          const fresh = await ready(request.headers, requirementId);
          assertOpen();
          return {
            workspaceId: fresh.item.nativeWorkspaceId!,
            cwd: join(fresh.runtime.native.demandRoot, requirementId),
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
          for (const group of groups)
            await revoke(
              group,
              requirementId,
              scope.item.projectId,
              Date.now(),
              false,
            );
        },
        validateReturn: async () => {
          await access(request.headers, requirementId);
          await business.sessionTransaction(
            scope.who,
            requirementId,
            scope.item.projectId,
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
    sessionsPath,
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
    sessionForkPath,
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
  app.get<{ Params: { id: string; sessionId: string } }>(
    sessionHistoryPath,
    async (request) => {
      const { id, sessionId } = request.params;
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
      const runtime = await prepared(scope);
      const pageSize = position('pageSize', 1) ?? 20;
      if (pageSize > 50) fail(400, '回放每页最多读取 50 条消息');
      const page = await sessionPage(
        runtime.native,
        grant({ ...scope, runtime }),
        sessionId,
        position('throughSeq', -1),
        position('beforeSeq', 0),
        pageSize,
      );
      const fresh = await confirmAccess(request.headers, scope);
      if (!fresh.sessions.some((s) => s.id === sessionId))
        fail(403, '无权读取该会话历史');
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
  app.get(nativeBootstrapPath, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requirementId = (request.params as { id: string }).id;
    const original = await access(request.headers, requirementId);
    verifyEditLogin(request, original.who.authSessionId, true);
    const scope = await readyAccess(request.headers, original);
    const response = await scope.runtime.native.fetch(
      '/api/rdws/bootstrap',
      grant(scope),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(503, '会话运行时暂不可用');
    }
    const data = await response.json();
    const fresh = await confirmAccess(request.headers, original);
    return {
      ...data,
      loginBinding: loginBinding(fresh),
      modelEgressPaused: scope.runtime.native.modelEgress === 'paused',
    };
  });
  async function allowedAsset(scope: ReadyAccess, path: string) {
    if (path.includes('..') || decodeURIComponent(path).includes('..'))
      return false;
    const response = await scope.runtime.native.fetch(
      '/api/rdws/bootstrap',
      grant(scope),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const data = (await response.json()) as {
      graph: {
        entries: { id: string; url: string }[];
        batches?: { url: string }[];
      };
    };
    if (
      [...data.graph.entries, ...(data.graph.batches ?? [])].some(
        (row) => '/' + row.url.replace(/^\//, '') === path,
      )
    )
      return true;
    return data.graph.entries.some((row) =>
      path.startsWith('/plugins/' + row.id + '/assets/'),
    );
  }
  app.route({
    method: ['GET', 'POST'],
    url: nativeTransportPath,
    handler: async (request, reply) => {
      const { id, '*': tail } = request.params as { id: string; '*': string };
      const original = await access(request.headers, id);
      const carrier =
        request.method === 'POST' ? nativeCarrier(request, false) : undefined;
      if (carrier) verifyNativeLogin(original, carrier.binding);
      const scope = await readyAccess(request.headers, original);
      const { native, runs, inFlightPrompts, acceptedPrompts, abandonedRuns } =
        scope.runtime;
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
        projectId: scope.item.projectId,
        controller: new AbortController(),
        revoked: false,
      };
      transfers.add(transfer);
      let pendingRun: RunBinding | undefined;
      let promptKey: string | undefined;
      try {
        const token = carrier ? lease(scope, carrier.generation) : grant(scope);
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
          if (native.modelEgress === 'paused') {
            if (
              !args.requestId ||
              args.requestId.length > 128 ||
              typeof request.body.rpcId !== 'string' ||
              !request.body.rpcId
            )
              fail(403, '会话请求身份无效');
            await confirmAccess(request.headers, original);
            if (
              transfer.revoked ||
              stale(original) ||
              claims.expiresAt <= Date.now()
            )
              fail(401, '授权已变化');
            return reply
              .code(503)
              .header('x-rdws-model-egress', 'paused')
              .header('cache-control', 'no-store')
              .send({ error: '模型发送已暂停，请在恢复后重试。' });
          }
          const key = JSON.stringify([args.sessionId, args.requestId]);
          if (inFlightPrompts.has(key))
            businessError(409, '原消息正在提交，请稍后核对');
          inFlightPrompts.add(key);
          promptKey = key;
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
            await confirmAccess(request.headers, original);
            if (transfer.revoked || stale(original)) fail(401, '授权已变化');
            pendingRun = runs.admit(
              scope.who,
              id,
              args.sessionId,
              args.requestId,
              claims.nonce,
            );
            await native.control('run', {
              ...pendingRun,
              authSessionId: scope.who.authSessionId,
            });
          }
          await confirmAccess(request.headers, original);
          if (transfer.revoked || stale(original)) fail(401, '授权已变化');
        }
        let response = await native.fetch(path, token, {
          method: request.method,
          signal: transfer.controller.signal,
          ...(request.method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request.body),
              }
            : {}),
        });
        if (request.method === 'POST') {
          const rpcId = (request.body as { rpcId?: unknown }).rpcId;
          response =
            path === '/api/session/modelCatalog'
              ? await publicModelCatalog(response, rpcId)
              : await publicNativeSessionResponse(
                  response,
                  rpcId,
                  path === '/api/session/page' ||
                    path === '/api/session/events',
                );
        }
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
              if (!seen) await retireRun(scope.runtime, pendingRun.runId);
              pendingRun = undefined;
            }
          }
        }
        await confirmAccess(request.headers, original);
        if (transfer.revoked || stale(original)) fail(401, '授权已变化');
        return reply.send(data);
      } finally {
        try {
          if (pendingRun) await retireRun(scope.runtime, pendingRun.runId);
        } finally {
          if (promptKey) inFlightPrompts.delete(promptKey);
          transfers.delete(transfer);
        }
      }
    },
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const upgradeAccess = new WeakMap<
    FastifyRequest,
    { original: Access; generation: string }
  >();
  app.get(
    nativeMuxPath,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (
          Object.keys(request.headers).some((key) => key.startsWith('x-rdws-'))
        )
          return reply.code(403).send({ error: '身份头不受信任' });
        if (request.headers.origin !== expectedOrigin)
          return reply.code(403).send({ error: '请求来源不受信任' });
        let original: Access;
        try {
          original = await access(
            request.headers,
            (request.params as { id: string }).id,
          );
        } catch {
          return reply.code(403).send({ error: '无权连接会话' });
        }
        const { binding, generation } = nativeCarrier(request, true);
        verifyNativeLogin(original, binding);
        upgradeAccess.set(request, { original, generation });
      },
    },
    (browser, request) => {
      const { original, generation } = upgradeAccess.get(request)!;
      const requirementId = original.item.id;
      let stopped = false;
      let upstream: WebSocket | undefined;
      let hostSignal: AbortSignal | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let chain = Promise.resolve();
      const opened = new Set<string>();
      const close = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        hostSignal?.removeEventListener('abort', close);
        upstream?.close();
        browser.close(4001, 'access changed');
        bridges.delete(bridge);
      };
      const bridge = {
        authSessionId: original.who.authSessionId,
        userId: original.who.userId,
        requirementId,
        projectId: original.item.projectId,
        close,
      };
      const connection = (async () => {
        const scope = await readyAccess(request.headers, original);
        const { native } = scope.runtime;
        if (stopped) return;
        if (stale(original)) return close();
        bridges.add(bridge);
        hostSignal = native.signal;
        hostSignal.addEventListener('abort', close, { once: true });
        if (hostSignal.aborted) {
          close();
          return;
        }
        upstream = new WebSocket(native.socketUrl(), {
          agent: false,
          followRedirects: false,
          headers: {
            'x-rdws-delegation': lease(scope, generation),
            origin: new URL(native.socketUrl()).origin.replace('ws:', 'http:'),
          },
        });
        upstream.on('message', (data) => {
          if (
            stopped ||
            stale(original) ||
            browser.readyState !== WebSocket.OPEN
          )
            return;
          try {
            browser.send(publicNativeStreamFrame(data.toString()));
          } catch {
            close();
          }
        });
        upstream.on('close', close);
        upstream.on('error', close);
        timer = setInterval(() => {
          if (
            blocked(bridge.userId, bridge.projectId, undefined, requirementId)
          )
            return;
          void confirmAccess(request.headers, original).catch(async (error) => {
            if (
              error instanceof PendingAuthority ||
              blocked(bridge.userId, bridge.projectId, undefined, requirementId)
            )
              return;
            close();
            if (!stale(original))
              await revoke(
                bridge.authSessionId,
                requirementId,
                bridge.projectId,
              );
          });
        }, 1000);
        await new Promise<void>((resolve, reject) => {
          upstream!.once('open', resolve);
          upstream!.once('error', reject);
        });
        return scope.runtime;
      })();
      browser.on('message', (data) => {
        chain = chain
          .then(async () => {
            const runtime = await connection;
            if (stopped || !runtime) return;
            if (
              blocked(bridge.userId, bridge.projectId, undefined, requirementId)
            )
              return;
            const scope = await confirmAccess(request.headers, original);
            const frame = authorizeStreamFrame(
              data.toString(),
              {
                ...grant({ ...scope, runtime }),
                aud: runtime.native.audience,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 20000,
                nonce: 'bff',
              },
              opened,
            );
            if (
              runtime.native.modelEgress === 'paused' &&
              frame.type === 'open' &&
              frame.endpoint === 'session/prompt'
            ) {
              close();
              return;
            }
            if (!stopped && !stale(original)) upstream!.send(data.toString());
          })
          .catch((error) => {
            if (!(error instanceof PendingAuthority)) close();
          });
      });
      browser.on('close', close);
      browser.on('error', close);
      void connection.catch(close);
    },
  );
  app.addHook('preClose', async () => {
    stopping = true;
    projects.stopAdmission();
    for (const bridge of [...bridges]) bridge.close();
    for (const transfer of transfers) transfer.controller.abort();
    const statuses = await Promise.allSettled([
      mirrors.close(),
      worktrees.close(),
      providedWorktrees?.close(),
      projects.close(),
    ]);
    if (statuses.some((status) => status.status === 'rejected'))
      throw new Error('Project shutdown was not confirmed');
  });
  return {
    access,
    revoke,
    closeLogin(authSessionId: string) {
      closingSessions.add(authSessionId);
      const pending = logoutNotifications.get(authSessionId);
      if (pending) return pending;
      const notification = revoke(authSessionId)
        .catch(() => false)
        .finally(() => logoutNotifications.delete(authSessionId));
      logoutNotifications.set(authSessionId, notification);
      return notification;
    },
  };
}
