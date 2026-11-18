import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray, asc, desc, gt, or, sql } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import type {
  RequirementInput,
  BusinessCommand,
  ManagementCommand,
  ManagementResult,
  TaskInput,
} from '@rdws/contracts';
import { capabilityKey } from '@rdws/contracts';
type Database = ReturnType<typeof connectDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Actor = { userId: string; authSessionId: string };
export function businessError(
  statusCode: number,
  publicMessage: string,
): never {
  throw Object.assign(new Error(publicMessage), { statusCode, publicMessage });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const digestOf = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function normalizeManagement(input: ManagementCommand) {
  return {
    ...input,
    ...('username' in input ? { username: input.username.toLowerCase() } : {}),
    ...('name' in input ? { name: input.name.trim() } : {}),
    ...(input.kind === 'project.roles'
      ? { roles: [...input.roles].sort() }
      : {}),
    ...(input.kind === 'capability.template.save'
      ? {
          description: input.description.trim(),
          capabilities: [...input.capabilities].sort((a, b) =>
            capabilityKey(a) < capabilityKey(b)
              ? -1
              : capabilityKey(a) > capabilityKey(b)
                ? 1
                : 0,
          ),
        }
      : {}),
  } as ManagementCommand;
}
export function createBusiness(db: Database) {
  async function transaction<T>(
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout='3s'`);
          return work(tx);
        });
      } catch (error) {
        const code =
          (error as { cause?: { code?: string }; code?: string }).cause?.code ??
          (error as { code?: string }).code;
        if (attempt >= 2 || !['40001', '40P01'].includes(code ?? ''))
          throw error;
      }
    }
  }
  async function identity(
    tx: Transaction,
    who: Actor,
    projectId: string,
    targets: string[] = [],
    lock = false,
  ) {
    const sessions = tx
      .select()
      .from(schema.session)
      .where(
        and(
          eq(schema.session.id, who.authSessionId),
          eq(schema.session.userId, who.userId),
          gt(schema.session.expiresAt, new Date()),
        ),
      );
    const [session] = await (lock ? sessions.for('share') : sessions);
    if (!session) businessError(401, '登录已失效，请重新登录');
    const ids = [...new Set([who.userId, ...targets])].sort();
    const query = tx
      .select()
      .from(schema.user)
      .where(inArray(schema.user.id, ids))
      .orderBy(asc(schema.user.id));
    const users = await (lock ? query.for('share') : query);
    const actor = users.find((u) => u.id === who.userId);
    if (!actor?.active || actor.authEpoch !== session.authEpoch)
      businessError(401, '账号已停用');
    if (users.length !== ids.length || users.some((u) => !u.active))
      businessError(400, '分派成员不存在或已停用');
    const roleQuery = tx
      .select()
      .from(schema.projectMember)
      .where(
        and(
          eq(schema.projectMember.projectId, projectId),
          inArray(schema.projectMember.userId, ids),
        ),
      )
      .orderBy(
        asc(schema.projectMember.userId),
        asc(schema.projectMember.role),
      );
    const roles = await (lock ? roleQuery.for('share') : roleQuery);
    if (!roles.some((r) => r.userId === who.userId))
      businessError(403, '无权访问当前项目');
    return { users, roles };
  }
  async function scope(tx: Transaction, who: Actor, id: string, lock = false) {
    const query = tx
      .select()
      .from(schema.requirement)
      .where(eq(schema.requirement.id, id));
    const [item] = await (lock ? query.for('update') : query);
    if (!item) businessError(404, '需求不存在');
    const memberQuery = tx
      .select()
      .from(schema.requirementParticipant)
      .where(eq(schema.requirementParticipant.requirementId, id))
      .orderBy(
        asc(schema.requirementParticipant.userId),
        asc(schema.requirementParticipant.role),
      );
    const participants = await (lock ? memberQuery.for('share') : memberQuery);
    const roles = await tx
      .select()
      .from(schema.projectMember)
      .where(
        and(
          eq(schema.projectMember.projectId, item.projectId),
          eq(schema.projectMember.userId, who.userId),
        ),
      );
    if (
      !roles.length ||
      (!participants.some(
        (p) =>
          p.userId === who.userId && roles.some((role) => role.role === p.role),
      ) &&
        !roles.some((p) => p.role === 'project_admin'))
    )
      businessError(403, '无权访问当前需求');
    const developer =
      roles.some((p) => p.role === 'developer') &&
      participants.some(
        (p) => p.userId === who.userId && p.role === 'developer',
      );
    return {
      item,
      participants,
      developer,
      lead: developer && item.leadId === who.userId,
    };
  }
  async function reserve(
    tx: Transaction,
    who: Actor,
    scope: string,
    operation: string,
    commandId: string,
    input: unknown,
  ) {
    const value = {
      actorId: who.userId,
      scope,
      operation,
      commandId,
      digest: digestOf(input),
    };
    const inserted = await tx
      .insert(schema.commandReceipt)
      .values(value)
      .onConflictDoNothing()
      .returning();
    if (inserted.length) return { value };
    const [old] = await tx
      .select()
      .from(schema.commandReceipt)
      .where(
        and(
          eq(schema.commandReceipt.actorId, value.actorId),
          eq(schema.commandReceipt.scope, scope),
          eq(schema.commandReceipt.operation, operation),
          eq(schema.commandReceipt.commandId, commandId),
        ),
      );
    if (!old || old.digest !== value.digest)
      businessError(409, '操作标识已用于不同内容，请重新发起');
    return { value, result: old.result };
  }
  async function finish(
    tx: Transaction,
    value: typeof schema.commandReceipt.$inferInsert,
    result: unknown,
  ) {
    await tx
      .update(schema.commandReceipt)
      .set({ result })
      .where(
        and(
          eq(schema.commandReceipt.actorId, value.actorId),
          eq(schema.commandReceipt.scope, value.scope),
          eq(schema.commandReceipt.operation, value.operation),
          eq(schema.commandReceipt.commandId, value.commandId),
        ),
      );
    return result;
  }
  async function event(
    tx: Transaction,
    requirementId: string,
    who: Actor,
    commandId: string,
    version: number,
    kind: string,
    before: unknown,
    after: unknown,
    taskId?: string,
  ) {
    await tx.insert(schema.requirementEvent).values({
      id: randomUUID(),
      requirementId,
      taskId,
      actorId: who.userId,
      commandId,
      version,
      source: 'web',
      kind,
      before,
      after,
    });
  }
  function validAssignee(
    id: string,
    participants: { userId: string; role: string }[],
    roles: { userId: string; role: string }[],
  ) {
    if (
      !participants.some((p) => p.userId === id && p.role === 'developer') ||
      !roles.some((p) => p.userId === id && p.role === 'developer')
    )
      businessError(400, '任务负责人必须是当前需求的有效开发成员');
  }
  async function insertTask(
    tx: Transaction,
    id: string,
    input: TaskInput,
    leadId: string,
    who: Actor,
    commandId: string,
    version: number,
    participants: { userId: string; role: string }[],
    roles: { userId: string; role: string }[],
  ) {
    const assigneeId = input.assigneeId ?? leadId;
    validAssignee(assigneeId, participants, roles);
    const [task] = await tx
      .insert(schema.task)
      .values({
        id: randomUUID(),
        requirementId: id,
        title: input.title.trim(),
        description: input.description ?? '',
        acceptance: input.acceptance ?? '',
        assigneeId,
        createdBy: who.userId,
      })
      .returning();
    await event(
      tx,
      id,
      who,
      commandId,
      version,
      'task.created',
      null,
      task,
      task!.id,
    );
    return task!;
  }
  async function create(
    who: Actor,
    projectId: string,
    input: RequirementInput,
  ) {
    return transaction(async (tx) => {
      const targetIds = [
        input.leadId,
        ...(input.participants ?? []).map((p) => p.userId),
        ...(input.participantIds ?? []),
        ...(input.tasks ?? []).flatMap((t) =>
          t.assigneeId ? [t.assigneeId] : [],
        ),
      ];
      const { roles } = await identity(tx, who, projectId, targetIds, true);
      const own = roles
        .filter((r) => r.userId === who.userId)
        .map((r) => r.role);
      if (
        !own.some((r) => r === 'project_admin' || r === 'requirement_manager')
      )
        businessError(403, '无权创建需求');
      const receipt = await reserve(
        tx,
        who,
        'project:' + projectId,
        'requirement.create',
        input.commandId,
        input,
      );
      if ('result' in receipt) return receipt.result;
      const participants: { userId: string; role: string }[] = [];
      const add = (userId: string, role: string) => {
        if (!participants.some((p) => p.userId === userId && p.role === role))
          participants.push({ userId, role });
      };
      for (const p of input.participants ?? [])
        for (const role of p.roles) {
          if (!roles.some((r) => r.userId === p.userId && r.role === role))
            businessError(400, '参与角色必须属于当前项目成员');
          add(p.userId, role);
        }
      for (const id of input.participantIds ?? []) {
        const current = roles.filter((r) => r.userId === id);
        if (current.length !== 1)
          businessError(400, '请明确选择成员的参与角色');
        add(id, current[0]!.role);
      }
      if (
        !roles.some((r) => r.userId === input.leadId && r.role === 'developer')
      )
        businessError(400, '开发负责人必须是项目开发成员');
      add(input.leadId, 'developer');
      add(
        who.userId,
        own.includes('requirement_manager')
          ? 'requirement_manager'
          : 'project_admin',
      );
      const id = randomUUID();
      await tx.insert(schema.requirement).values({
        id,
        projectId,
        title: input.title.trim(),
        description: input.description,
        acceptance: input.acceptance,
        leadId: input.leadId,
        createdBy: who.userId,
      });
      await tx
        .insert(schema.requirementParticipant)
        .values(participants.map((p) => ({ ...p, requirementId: id })));
      await event(
        tx,
        id,
        who,
        input.commandId,
        1,
        'requirement.created',
        null,
        { stage: 'assignment', participants },
      );
      for (const task of input.tasks ?? [])
        await insertTask(
          tx,
          id,
          task,
          input.leadId,
          who,
          input.commandId,
          1,
          participants,
          roles,
        );
      return finish(tx, receipt.value, { id });
    });
  }
  async function execute(who: Actor, id: string, input: BusinessCommand) {
    const [existing] = await db
      .select()
      .from(schema.requirement)
      .where(eq(schema.requirement.id, id));
    if (!existing) businessError(404, '需求不存在');
    return transaction(async (tx) => {
      const target =
        input.type === 'task.create'
          ? input.task.assigneeId
          : input.type === 'task.update'
            ? input.patch.assigneeId
            : undefined;
      const { roles } = await identity(
        tx,
        who,
        existing.projectId,
        target ? [target] : [],
        true,
      );
      const state = await scope(tx, who, id, true);
      state.developer =
        roles.some((r) => r.userId === who.userId && r.role === 'developer') &&
        state.participants.some(
          (p) => p.userId === who.userId && p.role === 'developer',
        );
      state.lead = state.developer && state.item.leadId === who.userId;
      const receipt = await reserve(
        tx,
        who,
        'requirement:' + id,
        input.type,
        input.commandId,
        input,
      );
      if ('result' in receipt) return receipt.result;
      const version = state.item.contextVersion + 1;
      let changed = false;
      let taskId: string | undefined;
      if (input.type === 'requirement.stage') {
        if (!state.lead) businessError(403, '仅需求开发负责人可调整阶段');
        if (state.item.stage !== input.stage) {
          await tx
            .update(schema.requirement)
            .set({ stage: input.stage })
            .where(eq(schema.requirement.id, id));
          await event(
            tx,
            id,
            who,
            input.commandId,
            version,
            'requirement.stage',
            state.item.stage,
            input.stage,
          );
          changed = true;
        }
      } else if (input.type === 'task.create') {
        if (!state.lead) businessError(403, '仅需求开发负责人可维护子任务');
        const task = await insertTask(
          tx,
          id,
          input.task,
          state.item.leadId,
          who,
          input.commandId,
          version,
          state.participants,
          roles,
        );
        taskId = task.id;
        changed = true;
      } else {
        const [task] = await tx
          .select()
          .from(schema.task)
          .where(
            and(
              eq(schema.task.id, input.taskId),
              eq(schema.task.requirementId, id),
            ),
          )
          .for('update');
        if (!task) businessError(404, '子任务不存在');
        taskId = task.id;
        if (
          !state.lead &&
          (!state.developer ||
            task.assigneeId !== who.userId ||
            Object.keys(input.patch).some((k) => k !== 'status'))
        )
          businessError(403, '只能更新本人子任务的状态');
        if (input.patch.assigneeId)
          validAssignee(input.patch.assigneeId, state.participants, roles);
        const patch = {
          ...input.patch,
          ...(input.patch.title ? { title: input.patch.title.trim() } : {}),
        };
        const delta = Object.fromEntries(
          Object.entries(patch).filter(
            ([k, v]) => task[k as keyof typeof task] !== v,
          ),
        );
        if (Object.keys(delta).length) {
          await tx
            .update(schema.task)
            .set({ ...delta, updatedAt: new Date() })
            .where(eq(schema.task.id, task.id));
          await event(
            tx,
            id,
            who,
            input.commandId,
            version,
            'task.updated',
            Object.fromEntries(
              Object.keys(delta).map((k) => [k, task[k as keyof typeof task]]),
            ),
            delta,
            task.id,
          );
          changed = true;
        }
      }
      if (changed)
        await tx
          .update(schema.requirement)
          .set({ contextVersion: version, updatedAt: new Date() })
          .where(eq(schema.requirement.id, id));
      return finish(tx, receipt.value, {
        id,
        taskId,
        changed,
        contextVersion: changed ? version : state.item.contextVersion,
      });
    });
  }
  async function read(
    who: Actor,
    id: string,
    sessionId?: string,
    relatedActors: Actor[] = [],
  ) {
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`set local statement_timeout='1800ms'`);
        const state = await scope(tx, who, id);
        await identity(tx, who, state.item.projectId);
        for (const actor of relatedActors)
          await identity(tx, actor, state.item.projectId);
        if (sessionId) {
          const [mapping] = await tx
            .select()
            .from(schema.nativeSession)
            .where(
              and(
                eq(schema.nativeSession.id, sessionId),
                eq(schema.nativeSession.requirementId, id),
                eq(schema.nativeSession.ownerId, who.userId),
              ),
            );
          if (!mapping) businessError(403, '当前会话不属于运行身份');
        }
        const tasks = await tx
          .select()
          .from(schema.task)
          .where(eq(schema.task.requirementId, id))
          .orderBy(asc(schema.task.createdAt), asc(schema.task.id));
        const events = await tx
          .select()
          .from(schema.requirementEvent)
          .where(eq(schema.requirementEvent.requirementId, id))
          .orderBy(
            desc(schema.requirementEvent.version),
            desc(schema.requirementEvent.createdAt),
            desc(schema.requirementEvent.id),
          )
          .limit(100);
        const stageEvents = await tx
          .selectDistinct({
            before: schema.requirementEvent.before,
            after: schema.requirementEvent.after,
          })
          .from(schema.requirementEvent)
          .where(
            and(
              eq(schema.requirementEvent.requirementId, id),
              eq(schema.requirementEvent.kind, 'requirement.stage'),
            ),
          );
        const people = await tx
          .select({
            id: schema.user.id,
            name: schema.user.name,
            active: schema.user.active,
          })
          .from(schema.user)
          .where(
            inArray(schema.user.id, [
              ...new Set(state.participants.map((p) => p.userId)),
            ]),
          );
        const developers = await tx
          .select({ userId: schema.projectMember.userId })
          .from(schema.projectMember)
          .where(
            and(
              eq(schema.projectMember.projectId, state.item.projectId),
              eq(schema.projectMember.role, 'developer'),
            ),
          );
        return {
          requirement: state.item,
          tasks,
          events,
          reachedStages: [
            ...new Set([
              'assignment',
              state.item.stage,
              ...stageEvents
                .flatMap((e) => [e.before, e.after])
                .filter((v): v is string => typeof v === 'string'),
            ]),
          ],
          participants: people.map((p) => ({
            ...p,
            eligibleDeveloper:
              p.active &&
              developers.some((d) => d.userId === p.id) &&
              state.participants.some(
                (r) => r.userId === p.id && r.role === 'developer',
              ),
            roles: state.participants
              .filter((r) => r.userId === p.id)
              .map((r) => r.role),
          })),
          permissions: {
            canManageTasks: state.lead,
            canChangeStage: state.lead,
            canUpdateOwnTasks: state.developer,
            userId: who.userId,
            codeWrite: false,
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function sessionTransaction<T>(
    who: Actor,
    id: string,
    sourceId: string | undefined,
    work: (
      tx: Transaction,
      item: typeof schema.requirement.$inferSelect,
    ) => Promise<T>,
  ) {
    return transaction(async (tx) => {
      const [found] = await tx
        .select({ projectId: schema.requirement.projectId })
        .from(schema.requirement)
        .where(eq(schema.requirement.id, id));
      if (!found) businessError(404, '需求不存在');
      await identity(tx, who, found.projectId, [], true);
      const state = await scope(tx, who, id, true);
      if (sourceId) {
        const [source] = await tx
          .select()
          .from(schema.nativeSession)
          .where(
            and(
              eq(schema.nativeSession.id, sourceId),
              eq(schema.nativeSession.requirementId, id),
              eq(schema.nativeSession.ownerId, who.userId),
            ),
          )
          .for('share');
        if (!source) businessError(403, '只能派生本人在当前需求中的会话');
      }
      return work(tx, state.item);
    });
  }
  type ManagementReceipt = {
    changed: boolean;
    targetId?: string;
    projectId?: string;
    before: unknown;
    after: unknown;
    template?: ManagementResult['template'];
  };
  async function saveTemplate(
    tx: Transaction,
    input: Extract<ManagementCommand, { kind: 'capability.template.save' }>,
  ): Promise<ManagementReceipt> {
    const [project] = await tx
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.id, input.projectId));
    if (!project) businessError(404, '项目不存在');
    const table = schema.capabilityTemplateRevision;
    const [previous] = input.templateId
      ? await tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.projectId, input.projectId),
              eq(table.templateId, input.templateId),
            ),
          )
          .orderBy(desc(table.revision))
          .limit(1)
      : [];
    if (input.templateId && !previous) businessError(404, '模板不存在');
    const prior = previous
      ? { templateId: previous.templateId, revision: previous.revision }
      : null;
    function unchanged(
      status: 'conflict' | 'unavailable' | 'unchanged',
    ): ManagementReceipt {
      return {
        changed: false,
        before: prior,
        after: prior,
        template: { status, ...prior },
      };
    }
    if (previous && input.expectedRevision !== previous.revision)
      return unchanged('conflict');
    const approval = schema.capabilityApproval;
    if (input.capabilities.length) {
      const active = await tx
        .select({ kind: approval.kind })
        .from(approval)
        .where(
          and(
            eq(approval.approved, true),
            or(
              ...input.capabilities.map((item) =>
                and(
                  eq(approval.kind, item.kind),
                  eq(approval.reference, item.reference),
                  eq(approval.revision, item.revision),
                ),
              ),
            ),
          ),
        )
        .orderBy(
          asc(approval.kind),
          asc(approval.reference),
          asc(approval.revision),
        )
        .for('share');
      if (active.length !== input.capabilities.length)
        return unchanged('unavailable');
    }
    if (
      previous &&
      previous.name === input.name &&
      previous.description === input.description &&
      digestOf(previous.capabilities) === digestOf(input.capabilities)
    )
      return unchanged('unchanged');
    const [created] = await tx
      .insert(table)
      .values({
        templateId: input.templateId ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        capabilities: input.capabilities,
      })
      .onConflictDoNothing({ target: [table.templateId, table.revision] })
      .returning({ templateId: table.templateId, revision: table.revision });
    if (!created) return unchanged('conflict');
    return {
      changed: true,
      before: prior,
      after: created,
      template: { status: 'saved', ...created },
    };
  }
  async function manage(
    who: Actor,
    input: ManagementCommand,
    fence: (userId: string, projectId?: string) => void,
    confirm: () => void,
  ) {
    const normalized = normalizeManagement(input);
    const projectId =
      'projectId' in normalized ? normalized.projectId : undefined;
    const key = projectId ? 'project:' + projectId : 'platform';
    let fenced = false;
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout='3s'`);
        const [session] = await tx
          .select()
          .from(schema.session)
          .where(
            and(
              eq(schema.session.id, who.authSessionId),
              eq(schema.session.userId, who.userId),
            ),
          )
          .for('share');
        if (!session) businessError(401, '登录已失效');
        const [target] =
          'username' in normalized
            ? await tx
                .select({ id: schema.user.id })
                .from(schema.user)
                .where(eq(schema.user.username, normalized.username))
            : [];
        const users = await tx
          .select()
          .from(schema.user)
          .where(
            inArray(schema.user.id, [
              ...new Set([who.userId, ...(target ? [target.id] : [])]),
            ]),
          )
          .orderBy(asc(schema.user.id))
          .for('update');
        const actor = users.find((row) => row.id === who.userId);
        if (
          !actor?.active ||
          actor.authEpoch !== session.authEpoch ||
          session.expiresAt <= new Date()
        )
          businessError(401, '登录已失效');
        if (normalized.kind !== 'project.roles' && !actor.platformAdmin)
          businessError(403, '无权管理平台设置');
        const members = projectId
          ? await tx
              .select()
              .from(schema.projectMember)
              .where(
                and(
                  eq(schema.projectMember.projectId, projectId),
                  inArray(
                    schema.projectMember.userId,
                    users.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(
                asc(schema.projectMember.userId),
                asc(schema.projectMember.role),
              )
              .for('update')
          : [];
        if (
          normalized.kind === 'project.roles' &&
          !members.some(
            (row) => row.userId === who.userId && row.role === 'project_admin',
          )
        )
          businessError(403, '无权管理当前项目成员');
        const receipt = await reserve(
          tx,
          who,
          key,
          normalized.kind,
          normalized.commandId,
          normalized,
        );
        function confirmTemplate() {
          if (normalized.kind !== 'capability.template.save') return;
          if (session!.expiresAt <= new Date())
            businessError(401, '登录已失效');
          confirm();
        }
        confirmTemplate();
        if ('result' in receipt)
          return {
            receipt: receipt.result as ManagementReceipt,
            replayed: true,
            fenced: false,
          };

        const person = users.find((row) => row.id === target?.id);
        if (
          'username' in normalized &&
          (!person || person.username !== normalized.username)
        )
          businessError(404, '找不到该账号');
        const result: ManagementReceipt = {
          changed: false,
          before: null,
          after: null,
        };
        if (normalized.kind === 'account.active') {
          if (person!.id === who.userId)
            businessError(409, '不能切换当前账号的状态');
          result.before = person!.active;
          result.after = normalized.active;
          result.targetId = person!.id;
          result.changed = person!.active !== normalized.active;
          if (result.changed)
            await tx
              .update(schema.user)
              .set({
                active: normalized.active,
                authEpoch: person!.authEpoch + 1,
                updatedAt: new Date(),
              })
              .where(eq(schema.user.id, person!.id));
        } else if (normalized.kind === 'capability.template.save') {
          Object.assign(result, await saveTemplate(tx, normalized));
        } else if (normalized.kind === 'capability.approval') {
          const table = schema.capabilityApproval;
          const item = {
            kind: normalized.capabilityKind,
            reference: normalized.reference,
            revision: normalized.revision,
          };
          const exact = and(
            eq(table.kind, item.kind),
            eq(table.reference, item.reference),
            eq(table.revision, item.revision),
          );
          if (normalized.approved) {
            const [created] = await tx
              .insert(table)
              .values({ ...item, approved: true })
              .onConflictDoNothing()
              .returning({ approved: table.approved });
            if (created)
              Object.assign(result, {
                changed: true,
                before: false,
                after: true,
              });
            else {
              const [current] = await tx
                .select({ approved: table.approved })
                .from(table)
                .where(exact)
                .for('share');
              Object.assign(result, {
                before: current!.approved,
                after: current!.approved,
              });
            }
          } else {
            const [stopped] = await tx
              .update(table)
              .set({ approved: false })
              .where(and(exact, eq(table.approved, true)))
              .returning({ approved: table.approved });
            Object.assign(result, {
              changed: !!stopped,
              before: !!stopped,
              after: false,
            });
          }
        } else if (normalized.kind === 'project.create') {
          if (!person!.active)
            businessError(409, '初始项目管理员须使用活动账号');
          const [created] = await tx
            .insert(schema.project)
            .values({ id: normalized.projectId, name: normalized.name })
            .onConflictDoNothing()
            .returning();
          if (!created) businessError(409, '项目标识已存在');
          await tx.insert(schema.projectMember).values({
            userId: person!.id,
            projectId: created.id,
            role: 'project_admin',
          });
          result.changed = true;
          result.after = {
            id: created.id,
            name: created.name,
            adminId: person!.id,
          };
        } else if (normalized.kind === 'project.rename') {
          const [existing] = await tx
            .select()
            .from(schema.project)
            .where(eq(schema.project.id, normalized.projectId))
            .for('update');
          if (!existing) businessError(404, '项目不存在');
          result.before = existing.name;
          result.after = normalized.name;
          result.changed = existing.name !== normalized.name;
          if (result.changed)
            await tx
              .update(schema.project)
              .set({ name: normalized.name, updatedAt: new Date() })
              .where(eq(schema.project.id, existing.id));
        } else {
          const [existing] = await tx
            .select({ id: schema.project.id })
            .from(schema.project)
            .where(eq(schema.project.id, normalized.projectId));
          if (!existing) businessError(404, '项目不存在');
          const prior = members
            .filter((r) => r.userId === person!.id)
            .map((r) => r.role)
            .sort();
          const after =
            normalized.kind === 'project.roles'
              ? [
                  ...prior.filter(
                    (role) =>
                      !['requirement_manager', 'developer', 'tester'].includes(
                        role,
                      ),
                  ),
                  ...normalized.roles,
                ].sort()
              : [
                  ...prior.filter((role) => role !== 'project_admin'),
                  ...(normalized.enabled ? ['project_admin'] : []),
                ].sort();
          const added = after.filter((r) => !prior.includes(r));
          const removed = prior.filter((r) => !after.includes(r));
          if (added.length && !person!.active) businessError(409, '账号已停用');
          if (removed.length)
            await tx
              .delete(schema.projectMember)
              .where(
                and(
                  eq(schema.projectMember.projectId, existing.id),
                  eq(schema.projectMember.userId, person!.id),
                  inArray(schema.projectMember.role, removed),
                ),
              );
          if (added.length)
            await tx.insert(schema.projectMember).values(
              added.map((role) => ({
                projectId: existing.id,
                userId: person!.id,
                role,
              })),
            );
          Object.assign(result, {
            changed: Boolean(added.length || removed.length),
            targetId: person!.id,
            projectId: existing.id,
            before: prior,
            after,
          });
        }
        confirmTemplate();
        await finish(tx, receipt.value, result);
        confirmTemplate();
        if (result.changed && result.targetId) {
          fence(result.targetId, result.projectId);
          fenced = true;
        }
        return { receipt: result, replayed: false, fenced };
      });
    } catch (error) {
      if (!fenced) throw error;
      const issue = error as {
        code?: string;
        severity?: string;
        cause?: { code?: string; severity?: string };
      };
      const postgres = issue.cause ?? issue;
      if (
        postgres.severity === 'ERROR' &&
        postgres.code &&
        ['23502', '23503', '23505', '23514', '40001', '40P01'].includes(
          postgres.code,
        )
      )
        throw error;
      const [saved] = await db
        .select()
        .from(schema.commandReceipt)
        .where(
          and(
            eq(schema.commandReceipt.actorId, who.userId),
            eq(schema.commandReceipt.scope, key),
            eq(schema.commandReceipt.operation, normalized.kind),
            eq(schema.commandReceipt.commandId, normalized.commandId),
          ),
        )
        .catch(() => []);
      if (!saved || saved.digest !== digestOf(normalized))
        return { unknown: true as const };
      return {
        receipt: saved.result as ManagementReceipt,
        replayed: false,
        fenced,
      };
    }
  }

  async function publishRepository(
    who: Actor,
    projectId: string,
    closing: () => boolean,
    publish: (confirm: () => void) => Promise<void>,
  ) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='3s'`);
      const { roles } = await identity(tx, who, projectId, [], true);
      if (!roles.some((row) => row.role === 'project_admin'))
        businessError(403, '无权同步项目仓库');
      const [session] = await tx
        .select({ expiresAt: schema.session.expiresAt })
        .from(schema.session)
        .where(eq(schema.session.id, who.authSessionId));
      const confirm = () => {
        if (!session || session.expiresAt <= new Date() || closing())
          businessError(401, '登录已失效，请重新登录');
      };
      confirm();
      await publish(confirm);
    });
  }
  return {
    create,
    execute,
    read,
    sessionTransaction,
    publishRepository,
    manage,
  };
}
