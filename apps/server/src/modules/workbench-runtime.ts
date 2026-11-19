import type { FastifyInstance, FastifyRequest } from 'fastify';
import { join } from 'node:path';
import { type RequirementWorkspace } from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import {
  businessError,
  createBusiness,
  type RequirementAuthority,
} from './business.ts';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { DemandWorktrees, type DemandRepositories } from '@rdws/orchestrator';
import { createProjectRuntimes } from './native-projects.ts';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { schema, type connectDatabase } from '@rdws/db';
import { NativeWebHost, type NativeModelEgress } from '@rdws/dsh/web';
import { nativeLoginBinding, LEASE_MS, type Grant } from '@rdws/dsh/access';
import { currentAccount, type createAuth } from './auth.ts';
import { runtimeHome } from '@rdws/runtime-config';
import {
  templateBindingPath,
  personnelPath,
  nativeBootstrapPath,
  nativeTransportPath,
  nativeMuxPath,
  nativeBindingHeader,
  nativeGenerationHeader,
  isImportRequest,
  isTemplateBindingRequest,
  isPassiveRequirementRead,
  isProjectAuditRead,
  isProjectAccessAuditRead,
  isPlatformAccountAuditRead,
  isSessionWrite,
} from './workbench-paths.ts';
export type Database = ReturnType<typeof connectDatabase>['db'];
export type Auth = ReturnType<typeof createAuth>;
export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    publicMessage: message,
  });
}
export class PendingAuthority extends Error {
  readonly statusCode = 401;
  readonly publicMessage = '当前权限正在变更，请刷新后重试';
}
export type PersonnelFence = {
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
export function createWorkbenchRuntime(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  providedNative?: NativeWebHost,
  expectedOrigin = process.env.RDWS_ORIGIN || 'http://127.0.0.1:5173',
  repositoryHome?: string,
  nativeRuntimeRoot?: string,
  nativeProfiles?: ReadonlyMap<string, string>,
  modelEgress: NativeModelEgress = 'direct',
  mainPolicy?: import('./model-egress-policy.ts').MainModelPolicy,
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
    mainPolicy,
  );

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
    const passiveRead = isPassiveRequirementRead(request);
    const auditRead =
      isProjectAuditRead(request) ||
      isProjectAccessAuditRead(request) ||
      isPlatformAccountAuditRead(request);
    const sessionWrite = isSessionWrite(request);
    if (passiveRead || auditRead || sessionWrite)
      reply.header('cache-control', 'no-store');
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
            key === OBSERVED_LOGIN_HEADER &&
            (isTemplateBindingRequest(request) ||
              isImportRequest(request) ||
              passiveRead ||
              auditRead ||
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
      projectAdminOnly?: boolean;
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
    const passiveRead = isPassiveRequirementRead(request);
    const projectAudit = isProjectAuditRead(request);
    const accessAudit = isProjectAccessAuditRead(request);
    const epoch = authorizationEpoch;
    const who = await actor(request.headers);
    if (templateBinding) verifyEditLogin(request, who.authSessionId);
    if (projectAudit || accessAudit)
      verifyEditLogin(request, who.authSessionId, true);
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
      projectAudit ||
      (request.routeOptions.url === '/api/projects/:projectId/requirements' &&
        (request.method === 'GET' || request.method === 'HEAD'));
    if (projectId && (requirementId || demandList))
      await recoverPersonnelFences(
        who.userId,
        projectId,
        requirementId,
        demandList,
      );
    const scope = {
      ...who,
      projectId,
      epoch,
      requirementId,
      demandList,
      projectAdminOnly: accessAudit,
    };
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
          businessError(
            403,
            isPlatformAccountAuditRead(request)
              ? '无权读取平台账号状态记录'
              : '无权读取平台能力白名单',
          );
      }
      if (scope.memberOnly || scope.projectAdminOnly) {
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
              scope.projectAdminOnly
                ? eq(schema.projectMember.role, 'project_admin')
                : undefined,
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
        if (!current.membership)
          businessError(
            403,
            scope.projectAdminOnly
              ? '无权读取项目权限事件'
              : '无权读取当前项目模板',
          );
      }
      assertResponse(scope);
    }
    return payload;
  });

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
    const observed = request.headers[OBSERVED_LOGIN_HEADER];
    if ((required || observed !== undefined) && observed !== authSessionId)
      businessError(401, '登录已变化，请刷新后重试');
  }
  return {
    actor,
    assertResponse,
    blocked,
    bridges,
    business,
    canPrepare,
    closingSessions,
    confirmAccess,
    db,
    expectedOrigin,
    fences,
    grant,
    lease,
    loginBinding,
    mirrors,
    nativeCarrier,
    pendingNotifications,
    personnelFences,
    prepareWorktrees,
    prepared,
    projectRoles,
    projects,
    ready,
    readyAccess,
    recoverPersonnelFence,
    requestDemandScope,
    responseScopes,
    revokeMember,
    settlePersonnelFence,
    stale,
    transfers,
    verifyEditLogin,
    verifyNativeLogin,
    workspaceResult,
    worktreeReady,
    worktreesFor,
    get authorizationEpoch() {
      return authorizationEpoch;
    },
    registerShutdown() {
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
    },
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
export type WorkbenchRuntime = ReturnType<typeof createWorkbenchRuntime>;
export type Access = Awaited<ReturnType<WorkbenchRuntime['access']>>;
export type ReadyAccess = Awaited<ReturnType<WorkbenchRuntime['readyAccess']>>;
