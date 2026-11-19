import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  businessAuditLabels,
  stageLabels,
  taskStatusLabels,
  roles,
  projectAccessAuditLabels,
  type BusinessAuditEvent,
  type BusinessAuditPage,
  type ProjectBusinessAuditPage,
  type CrossProjectBusinessAuditPage,
  type ProjectAccessAuditPage,
  type ProjectAccessAuditEvent,
  type PlatformAccountAuditPage,
} from '@rdws/contracts';
import { schema } from '@rdws/db';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import {
  businessAuditPath,
  projectBusinessAuditPath,
  crossProjectBusinessAuditPath,
  projectAccessAuditPath,
  platformAccountAuditPath,
} from './workbench-paths.ts';
import { fail, type WorkbenchRuntime } from './workbench-runtime.ts';

const pageSize = 25;
const kinds = Object.keys(businessAuditLabels);
const detailFields = ['title', 'description', 'acceptance'] as const;
const auditId = /^[a-zA-Z0-9-]{1,128}$/;
const microsecondUtc = /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function versionParameter(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,9}$/.test(value) ||
    Number(value) > 2147483647
  )
    fail(400, '审计版本不正确');
  return Number(value);
}

function isKnownValue<T extends Record<string, string>>(
  labels: T,
  value: unknown,
): value is keyof T & string {
  return typeof value === 'string' && Object.hasOwn(labels, value);
}

function auditEvent(row: {
  event: typeof schema.requirementEvent.$inferSelect;
  actorName: string | null;
}): BusinessAuditEvent {
  const {
    id,
    kind,
    actorId,
    source,
    version,
    taskId,
    createdAt,
    before,
    after,
  } = row.event;
  const result: BusinessAuditEvent = {
    id,
    kind: kind as BusinessAuditEvent['kind'],
    actorId,
    actorName: row.actorName,
    source: source === 'migration' ? 'migration' : 'web',
    version,
    taskId,
    createdAt: createdAt.toISOString(),
  };
  if (
    kind === 'requirement.stage' &&
    isKnownValue(stageLabels, before) &&
    isKnownValue(stageLabels, after)
  ) {
    result.stage = { before, after };
  }
  if ((kind === 'task.created' || kind === 'task.updated') && isRecord(after)) {
    if (isKnownValue(taskStatusLabels, after.status))
      result.taskStatus = {
        ...(isRecord(before) && isKnownValue(taskStatusLabels, before.status)
          ? { before: before.status }
          : {}),
        after: after.status,
      };
  }
  if (kind === 'requirement.details' && isRecord(after))
    result.changedFields = detailFields.filter((field) =>
      Object.hasOwn(after, field),
    );
  return result;
}

export function registerRequirementAudit(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { access, confirmAccess, db, verifyEditLogin } = workbench;
  registerProjectAudit(app, workbench);
  registerCrossProjectAudit(app, workbench);
  registerProjectAccessAudit(app, workbench);
  registerPlatformAccountAudit(app, workbench);
  app.get<{ Params: { id: string } }>(
    businessAuditPath,
    async (request): Promise<BusinessAuditPage> => {
      const { id } = request.params;
      const scope = await access(request.headers, id);
      verifyEditLogin(request, scope.who.authSessionId, true);
      const query = request.query;
      if (
        !isRecord(query) ||
        !onlyKeys(query, ['throughVersion', 'beforeVersion', 'beforeId'])
      )
        fail(400, '审计分页参数不正确');
      const through = versionParameter(query.throughVersion);
      const before = versionParameter(query.beforeVersion);
      const beforeId = query.beforeId;
      const throughVersion = through ?? scope.item.contextVersion;
      if (throughVersion > scope.item.contextVersion)
        fail(400, '审计版本不正确');
      const table = schema.requirementEvent;
      let position;
      if (before !== undefined || beforeId !== undefined) {
        if (
          through === undefined ||
          before === undefined ||
          before > through ||
          typeof beforeId !== 'string' ||
          !auditId.test(beforeId)
        )
          fail(400, '审计分页位置不正确');
        position = or(
          lt(table.version, before),
          and(eq(table.version, before), lt(table.id, beforeId)),
        );
      }
      const rows = await db
        .select({ event: table, actorName: schema.user.name })
        .from(table)
        .innerJoin(
          schema.requirement,
          and(
            eq(schema.requirement.id, table.requirementId),
            eq(schema.requirement.projectId, scope.item.projectId),
          ),
        )
        .leftJoin(schema.user, eq(schema.user.id, table.actorId))
        .where(
          and(
            eq(table.requirementId, id),
            lte(table.version, throughVersion),
            inArray(table.kind, kinds),
            inArray(table.source, ['web', 'migration']),
            position,
          ),
        )
        .orderBy(desc(table.version), desc(table.id))
        .limit(pageSize + 1);
      const events = rows.slice(0, pageSize).map(auditEvent);
      const tail = events.at(-1);
      await confirmAccess(request.headers, scope);
      return {
        requirementId: id,
        throughVersion,
        next:
          rows.length > pageSize && tail
            ? { version: tail.version, id: tail.id }
            : null,
        events,
      };
    },
  );
}

const accessAuditIds = '^[A-Za-z0-9_-]{1,128}$';
const accessAuditId = new RegExp(accessAuditIds);
const projectAccessKinds = Object.keys(projectAccessAuditLabels);
const knownProjectRoles = JSON.stringify(roles);

function registerProjectAccessAudit(
  app: FastifyInstance,
  { db, projectRoles, requestDemandScope }: WorkbenchRuntime,
) {
  const { commandReceipt: receipt, projectMember, user } = schema;
  app.get<{ Params: { projectId: string } }>(
    projectAccessAuditPath,
    { exposeHeadRoute: false },
    async (request): Promise<ProjectAccessAuditPage> => {
      const { projectId } = request.params;
      const scope = requestDemandScope(request);
      if (
        scope.projectId !== projectId ||
        !(await projectRoles(scope.userId, projectId)).includes('project_admin')
      )
        fail(403, '无权读取项目权限事件');
      const query = request.query;
      if (
        !isRecord(query) ||
        !onlyKeys(query, [
          'beforeAt',
          'beforeActorId',
          'beforeKind',
          'beforeCommandId',
        ])
      )
        fail(400, '权限审计分页参数不正确');
      const { beforeAt, beforeActorId, beforeKind, beforeCommandId } = query;
      let position;
      if (Object.keys(query).length) {
        if (
          !isMicrosecondTimestamp(beforeAt) ||
          typeof beforeActorId !== 'string' ||
          !accessAuditId.test(beforeActorId) ||
          !isKnownValue(projectAccessAuditLabels, beforeKind) ||
          typeof beforeCommandId !== 'string' ||
          !accessAuditId.test(beforeCommandId)
        )
          fail(400, '权限审计分页位置不正确');
        position = sql`(${receipt.createdAt}, ${receipt.actorId}, ${receipt.operation}, ${receipt.commandId}) <
          (cast(${beforeAt} as timestamptz), ${beforeActorId}, ${beforeKind}, ${beforeCommandId})`;
      }
      const targetId = sql<string>`${receipt.result}->>'targetId'`;
      const beforeRoles = sql<
        ProjectAccessAuditEvent['beforeRoles']
      >`${receipt.result}->'before'`;
      const afterRoles = sql<
        ProjectAccessAuditEvent['afterRoles']
      >`${receipt.result}->'after'`;
      const adminSeat = sql`'["project_admin"]'::jsonb`;
      const rows = await db
        .select({
          at: sql<string>`to_char(${receipt.createdAt} at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          recordedAt: receipt.createdAt,
          kind: receipt.operation,
          commandId: receipt.commandId,
          actorId: receipt.actorId,
          actorName: user.name,
          targetId,
          targetName: sql<
            string | null
          >`(select ${user.name} from ${user} where ${user.id} = (${targetId}))`,
          beforeRoles,
          afterRoles,
        })
        .from(receipt)
        .leftJoin(user, eq(user.id, receipt.actorId))
        .where(
          and(
            eq(receipt.scope, 'project:' + projectId),
            inArray(receipt.operation, projectAccessKinds),
            sql`exists (
            select 1 from ${projectMember}
            where ${projectMember.projectId} = ${projectId}
              and ${projectMember.userId} = ${scope.userId}
              and ${projectMember.role} = 'project_admin'
          )`,
            sql`${receipt.result}->'changed' = 'true'::jsonb`,
            sql`${receipt.result}->'projectId' = to_jsonb(${projectId}::text)`,
            sql`jsonb_typeof(${receipt.result}->'targetId') = 'string'`,
            sql`(${targetId}) ~ ${accessAuditIds}`,
            sql`${receipt.actorId} ~ ${accessAuditIds} and ${receipt.commandId} ~ ${accessAuditIds}`,
            sql`jsonb_typeof(${beforeRoles}) = 'array' and jsonb_typeof(${afterRoles}) = 'array'`,
            sql`(${beforeRoles}) <@ ${knownProjectRoles}::jsonb and (${afterRoles}) <@ ${knownProjectRoles}::jsonb`,
            sql`not ((${beforeRoles}) <@ (${afterRoles}) and (${afterRoles}) <@ (${beforeRoles}))`,
            sql`case ${receipt.operation}
              when 'project.roles' then ((${beforeRoles}) @> ${adminSeat}) = ((${afterRoles}) @> ${adminSeat})
              when 'project.admin' then
                (${beforeRoles}) <@ ((${afterRoles}) || ${adminSeat})
                and (${afterRoles}) <@ ((${beforeRoles}) || ${adminSeat})
              else false end`,
            position,
          ),
        )
        .orderBy(
          desc(receipt.createdAt),
          desc(receipt.actorId),
          desc(receipt.operation),
          desc(receipt.commandId),
        )
        .limit(pageSize + 1);
      const visible = rows.slice(0, pageSize);
      const tail = visible.at(-1);
      return {
        projectId,
        next:
          rows.length > pageSize && tail
            ? {
                at: tail.at,
                actorId: tail.actorId,
                kind: tail.kind as ProjectAccessAuditEvent['kind'],
                commandId: tail.commandId,
              }
            : null,
        events: visible.map((row) => ({
          kind: row.kind as ProjectAccessAuditEvent['kind'],
          recordedAt: row.recordedAt.toISOString(),
          commandId: row.commandId,
          actorId: row.actorId,
          actorName: row.actorName,
          targetId: row.targetId,
          targetName: row.targetName,
          beforeRoles: [...new Set(row.beforeRoles)],
          afterRoles: [...new Set(row.afterRoles)],
        })),
      };
    },
  );
}

function registerPlatformAccountAudit(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { actor, assertResponse, db, responseScopes, verifyEditLogin } =
    workbench;
  const { commandReceipt: receipt, user } = schema;
  app.get(
    platformAccountAuditPath,
    { exposeHeadRoute: false },
    async (request): Promise<PlatformAccountAuditPage> => {
      const epoch = workbench.authorizationEpoch;
      const who = await actor(request.headers);
      verifyEditLogin(request, who.authSessionId, true);
      if (!who.platformAdmin) fail(403, '无权读取平台账号状态记录');
      const scope = { ...who, epoch, platformOnly: true };
      assertResponse(scope);
      const query = request.query;
      if (
        !isRecord(query) ||
        !onlyKeys(query, ['beforeAt', 'beforeActorId', 'beforeCommandId'])
      )
        fail(400, '账号审计分页参数不正确');
      const { beforeAt, beforeActorId, beforeCommandId } = query;
      let position;
      if (Object.keys(query).length) {
        if (
          !isMicrosecondTimestamp(beforeAt) ||
          typeof beforeActorId !== 'string' ||
          !accessAuditId.test(beforeActorId) ||
          typeof beforeCommandId !== 'string' ||
          !accessAuditId.test(beforeCommandId)
        )
          fail(400, '账号审计分页位置不正确');
        position = sql`(${receipt.createdAt}, ${receipt.actorId}, ${receipt.commandId}) <
        (cast(${beforeAt} as timestamptz), ${beforeActorId}, ${beforeCommandId})`;
      }
      const targetId = sql<string>`${receipt.result}->>'targetId'`;
      const beforeActive = sql<boolean>`${receipt.result}->'before'`;
      const afterActive = sql<boolean>`${receipt.result}->'after'`;
      const rows = await db
        .select({
          at: sql<string>`to_char(${receipt.createdAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          recordedAt: receipt.createdAt,
          commandId: receipt.commandId,
          actorId: receipt.actorId,
          actorName: user.name,
          targetId,
          targetName: sql<
            string | null
          >`(select ${user.name} from ${user} where ${user.id} = (${targetId}))`,
          beforeActive,
          afterActive,
        })
        .from(receipt)
        .leftJoin(user, eq(user.id, receipt.actorId))
        .where(
          and(
            eq(receipt.scope, 'platform'),
            eq(receipt.operation, 'account.active'),
            sql`exists (select 1 from ${user} where ${user.id} = ${who.userId}
        and ${user.active} and ${user.platformAdmin})`,
            sql`${receipt.result}->'changed' = 'true'::jsonb and not (${receipt.result} ? 'projectId')`,
            sql`jsonb_typeof(${beforeActive}) = 'boolean' and jsonb_typeof(${afterActive}) = 'boolean' and (${beforeActive}) <> (${afterActive})`,
            sql`jsonb_typeof(${receipt.result}->'targetId') = 'string' and (${targetId}) <> ${receipt.actorId}`,
            sql`(${targetId}) ~ ${accessAuditIds} and ${receipt.actorId} ~ ${accessAuditIds} and ${receipt.commandId} ~ ${accessAuditIds}`,
            position,
          ),
        )
        .orderBy(
          desc(receipt.createdAt),
          desc(receipt.actorId),
          desc(receipt.commandId),
        )
        .limit(pageSize + 1);
      responseScopes.set(request, scope);
      const visible = rows.slice(0, pageSize);
      const tail = visible.at(-1);
      return {
        next:
          rows.length > pageSize && tail
            ? { at: tail.at, actorId: tail.actorId, commandId: tail.commandId }
            : null,
        events: visible.map((row) => ({
          recordedAt: row.recordedAt.toISOString(),
          commandId: row.commandId,
          actorId: row.actorId,
          actorName: row.actorName,
          targetId: row.targetId,
          targetName: row.targetName,
          beforeActive: row.beforeActive,
          afterActive: row.afterActive,
        })),
      };
    },
  );
}

function readableRequirement(userId: string) {
  const { requirement, projectMember, requirementParticipant } = schema;
  return sql<boolean>`exists (
    select 1 from ${projectMember}
    where ${projectMember.projectId} = ${requirement.projectId}
      and ${projectMember.userId} = ${userId}
      and (${projectMember.role} = 'project_admin' or exists (
        select 1 from ${requirementParticipant}
        where ${requirementParticipant.requirementId} = ${requirement.id}
          and ${requirementParticipant.userId} = ${userId}
          and ${requirementParticipant.role} = ${projectMember.role}
      ))
  )`;
}

function isMicrosecondTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !microsecondUtc.test(value)) return false;
  const millis = value.slice(0, 23) + 'Z';
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) && date.toISOString() === millis;
}

function registerProjectAudit(
  app: FastifyInstance,
  { assertResponse, db, projectRoles, requestDemandScope }: WorkbenchRuntime,
) {
  const outbound = new WeakMap<FastifyRequest, string[]>();
  const { requirement, projectMember, session, user } = schema;
  app.get<{ Params: { projectId: string } }>(
    projectBusinessAuditPath,
    {
      exposeHeadRoute: false,
      onSend: async (request, reply, payload) => {
        const ids = outbound.get(request);
        if (reply.statusCode >= 400 || !ids) return payload;
        const scope = requestDemandScope(request);
        const { projectId, userId, authSessionId } = scope;
        const visible = ids.length
          ? sql<number>`(select count(*)::integer from ${requirement}
              where ${requirement.projectId} = ${projectId}
                and ${inArray(requirement.id, ids)}
                and ${readableRequirement(userId)})`
          : sql<number>`0`;
        const [current] = await db
          .select({
            expiresAt: session.expiresAt,
            member: sql<boolean>`exists (select 1 from ${projectMember}
              where ${projectMember.projectId} = ${projectId}
                and ${projectMember.userId} = ${userId})`,
            visible,
          })
          .from(session)
          .innerJoin(user, eq(user.id, session.userId))
          .where(
            and(
              eq(session.id, authSessionId),
              eq(user.id, userId),
              eq(user.active, true),
              eq(user.authEpoch, session.authEpoch),
            ),
          );
        if (!current || current.expiresAt.getTime() <= Date.now())
          fail(401, '登录已失效，请重新登录');
        if (!current.member || current.visible !== ids.length)
          fail(403, '当前审计范围已变化，请重新读取');
        assertResponse(scope);
        for (const requirementId of ids)
          assertResponse({ ...scope, requirementId });
        return payload;
      },
    },
    async (request): Promise<ProjectBusinessAuditPage> => {
      const { projectId } = request.params;
      const scope = requestDemandScope(request);
      if (
        scope.projectId !== projectId ||
        !(await projectRoles(scope.userId, projectId)).length
      )
        fail(403, '无权访问项目审计');
      const rows = await readBusinessEvents(
        db,
        scope.userId,
        request.query,
        projectId,
      );
      const visible = rows.slice(0, pageSize);
      const tail = visible.at(-1);
      outbound.set(request, [
        ...new Set(rows.map(({ event }) => event.requirementId)),
      ]);
      return {
        projectId,
        next:
          rows.length > pageSize && tail
            ? { at: tail.at, id: tail.event.id }
            : null,
        events: visible.map((row) => ({
          ...auditEvent(row),
          requirementId: row.event.requirementId,
          requirementTitle: row.requirementTitle,
        })),
      };
    },
  );
}

function registerCrossProjectAudit(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { db, actor, verifyEditLogin, assertResponse, recoverPersonnelFences } =
    workbench;
  const { requirement, session, user } = schema;
  const outbound = new WeakMap<
    FastifyRequest,
    {
      userId: string;
      authSessionId: string;
      epoch: number;
      demands: { requirementId: string; projectId: string }[];
    }
  >();
  app.get(
    crossProjectBusinessAuditPath,
    {
      exposeHeadRoute: false,
      onSend: async (request, reply, payload) => {
        const scope = outbound.get(request);
        if (reply.statusCode >= 400 || !scope) return payload;
        for (const demand of scope.demands)
          await recoverPersonnelFences(
            scope.userId,
            demand.projectId,
            demand.requirementId,
          );
        const pairs = scope.demands.map(({ projectId, requirementId }) =>
          and(
            eq(requirement.projectId, projectId),
            eq(requirement.id, requirementId),
          ),
        );
        const visible = pairs.length
          ? sql<number>`(select count(*)::integer from ${requirement}
            where (${or(...pairs)}) and ${readableRequirement(scope.userId)})`
          : sql<number>`0`;
        const [current] = await db
          .select({ expiresAt: session.expiresAt, visible })
          .from(session)
          .innerJoin(user, eq(user.id, session.userId))
          .where(
            and(
              eq(session.id, scope.authSessionId),
              eq(user.id, scope.userId),
              eq(user.active, true),
              eq(user.authEpoch, session.authEpoch),
            ),
          );
        if (!current || current.expiresAt.getTime() <= Date.now())
          fail(401, '登录已失效，请重新登录');
        if (current.visible !== scope.demands.length)
          fail(403, '当前审计范围已变化，请重新读取');
        assertResponse(scope);
        for (const demand of scope.demands)
          assertResponse({ ...scope, ...demand });
        return payload;
      },
    },
    async (request): Promise<CrossProjectBusinessAuditPage> => {
      const epoch = workbench.authorizationEpoch;
      const who = await actor(request.headers);
      verifyEditLogin(request, who.authSessionId, true);
      const scope = { ...who, epoch };
      assertResponse(scope);
      const rows = await readBusinessEvents(db, who.userId, request.query);
      const visible = rows.slice(0, pageSize);
      const tail = visible.at(-1);
      const demands = new Map(
        rows.map(({ event, projectId }) => [
          event.requirementId,
          { projectId, requirementId: event.requirementId },
        ]),
      );
      outbound.set(request, { ...scope, demands: [...demands.values()] });
      return {
        scope: 'accessible-projects',
        next:
          rows.length > pageSize && tail
            ? { at: tail.at, id: tail.event.id }
            : null,
        events: visible.map((row) => ({
          ...auditEvent(row),
          requirementId: row.event.requirementId,
          requirementTitle: row.requirementTitle,
          projectId: row.projectId,
          projectName: row.projectName,
        })),
      };
    },
  );
}

async function readBusinessEvents(
  db: WorkbenchRuntime['db'],
  userId: string,
  query: unknown,
  projectId?: string,
) {
  const { project, requirement, requirementEvent, user } = schema;
  if (
    !isRecord(query) ||
    !onlyKeys(query, ['q', 'kind', 'beforeAt', 'beforeId'])
  )
    fail(400, '项目审计参数不正确');
  const { q, kind, beforeAt, beforeId } = query;
  if (
    q !== undefined &&
    (typeof q !== 'string' || q.length > 80 || q.includes('\0'))
  )
    fail(400, '审计搜索文字不正确');
  if (kind !== undefined && !isKnownValue(businessAuditLabels, kind))
    fail(400, '审计事件类型不正确');
  let position;
  if (beforeAt !== undefined || beforeId !== undefined) {
    if (
      !isMicrosecondTimestamp(beforeAt) ||
      typeof beforeId !== 'string' ||
      !auditId.test(beforeId)
    )
      fail(400, '审计分页位置不正确');
    position = sql`(${requirementEvent.createdAt}, ${requirementEvent.id}) <
      (cast(${beforeAt} as timestamptz), ${beforeId})`;
  }
  const keyword = typeof q === 'string' ? q.trim() : '';
  return db
    .select({
      event: requirementEvent,
      actorName: user.name,
      requirementTitle: requirement.title,
      projectId: requirement.projectId,
      projectName: project.name,
      at: sql<string>`to_char(${requirementEvent.createdAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(requirementEvent)
    .innerJoin(requirement, eq(requirement.id, requirementEvent.requirementId))
    .innerJoin(project, eq(project.id, requirement.projectId))
    .leftJoin(user, eq(user.id, requirementEvent.actorId))
    .where(
      and(
        projectId === undefined
          ? sql`${requirementEvent.id} ~ ${auditId.source}`
          : eq(requirement.projectId, projectId),
        readableRequirement(userId),
        inArray(requirementEvent.kind, kinds),
        inArray(requirementEvent.source, ['web', 'migration']),
        kind === undefined ? undefined : eq(requirementEvent.kind, kind),
        keyword
          ? sql`(strpos(lower(${requirement.title}), lower(${keyword})) > 0
        or strpos(lower(${user.name}), lower(${keyword})) > 0)`
          : undefined,
        position,
      ),
    )
    .orderBy(desc(requirementEvent.createdAt), desc(requirementEvent.id))
    .limit(pageSize + 1);
}
