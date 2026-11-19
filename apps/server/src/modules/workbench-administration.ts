import type { FastifyInstance } from 'fastify';
import {
  ManagementCommand,
  capabilityKey,
  type CapabilityApprovalList,
  type CapabilityTemplateManagement,
  type CapabilityVersion,
  type PlatformAdministration,
  type ProjectAdministration,
  type ManagementResult,
  ProjectList,
} from '@rdws/contracts';
import { businessError, digestOf, normalizeManagement } from './business.ts';
import { eq, and, desc, asc } from 'drizzle-orm';
import { schema } from '@rdws/db';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { fail, type WorkbenchRuntime } from './workbench-runtime.ts';

export function registerAdministration(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const {
    actor,
    assertResponse,
    business,
    db,
    fences,
    pendingNotifications,
    projectRoles,
    projects,
    responseScopes,
    revokeMember,
  } = workbench;

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
      const epoch = workbench.authorizationEpoch;
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
      const epoch = workbench.authorizationEpoch;
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
      const epoch = workbench.authorizationEpoch;
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
      const epoch = workbench.authorizationEpoch;
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
      const epoch = workbench.authorizationEpoch;
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
        { ...who, projectId: project, epoch: workbench.authorizationEpoch },
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
}
