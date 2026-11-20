import type { FastifyInstance } from 'fastify';
import {
  RequirementInput,
  BusinessCommand,
  RequirementDetailsInput,
  RequirementPersonnelInput,
  personnelRoles,
  type RequirementPersonnelReceipt,
  TemplateBindingInput,
} from '@rdws/contracts';
import { businessError, digestOf, normalizePersonnel } from './business.ts';
import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { schema } from '@rdws/db';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { templateBindingPath, personnelPath } from './workbench-paths.ts';
import { registerRequirementAudit } from './workbench-audit.ts';
import {
  fail,
  type WorkbenchRuntime,
  type PersonnelFence,
} from './workbench-runtime.ts';

export function registerRequirementList(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { actor, db, projectRoles } = workbench;

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
}

export function registerRequirements(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  registerRequirementAudit(app, workbench);
  const {
    access,
    actor,
    assertResponse,
    business,
    canPrepare,
    db,
    mirrors,
    personnelFences,
    prepareWorktrees,
    recoverPersonnelFence,
    requestDemandScope,
    responseScopes,
    settlePersonnelFence,
    stale,
    verifyEditLogin,
    workspaceResult,
    worktreesFor,
    writeAuthority,
  } = workbench;

  app.post(
    '/api/projects/:projectId/requirements',
    { schema: { body: RequirementInput } },
    async (request) => {
      const epoch = workbench.authorizationEpoch;
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
        const edit = () =>
          business.editPersonnel(
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
            () => {
              if (entry && personnelFences.get(key) === entry)
                personnelFences.delete(key);
              entry = undefined;
            },
          );
        const result = await writeAuthority.change(
          scope,
          'requirement.personnel',
          'requirement:' + id,
          input.commandId,
          normalizePersonnel(input),
          ({ requirementId }) => requirementId === id,
          edit,
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
    async (request) => {
      const who = await actor(request.headers);
      const { id } = request.params as { id: string };
      const input = request.body as BusinessCommand;
      const execute = () => business.execute(who, id, input);
      if (input.type === 'requirement.stage') return execute();
      if (
        input.type === 'task.update' &&
        !('status' in input.patch) &&
        !('assigneeId' in input.patch)
      )
        return execute();
      return writeAuthority.change(
        who,
        input.type,
        'requirement:' + id,
        input.commandId,
        input,
        ({ requirementId }) => requirementId === id,
        execute,
      );
    },
  );
}
