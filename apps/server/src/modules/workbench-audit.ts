import type { FastifyInstance } from 'fastify';
import {
  businessAuditLabels,
  stageLabels,
  taskStatusLabels,
  type BusinessAuditEvent,
  type BusinessAuditPage,
} from '@rdws/contracts';
import { schema } from '@rdws/db';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { and, desc, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { businessAuditPath } from './workbench-paths.ts';
import { fail, type WorkbenchRuntime } from './workbench-runtime.ts';

const pageSize = 25;
const kinds = Object.keys(businessAuditLabels);
const detailFields = ['title', 'description', 'acceptance'] as const;

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
  { access, confirmAccess, db, verifyEditLogin }: WorkbenchRuntime,
) {
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
          !/^[a-zA-Z0-9-]{1,128}$/.test(beforeId)
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
