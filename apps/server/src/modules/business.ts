import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray, asc, desc, gt, or, sql } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import type {
  RequirementInput,
  BusinessCommand,
  ManagementCommand,
  ManagementResult,
  TaskInput,
  RequirementTemplateBinding,
  TemplateBindingInput,
  TemplateBindingReceipt,
  CapabilityVersion,
  RequirementDetailsInput,
  RequirementDetailsReceipt,
  RequirementPersonnelInput,
  RequirementPersonnelReceipt,
  RequirementImportInput,
  RequirementImportReceipt,
  RequirementImportRow,
} from '@rdws/contracts';
import { capabilityKey, taskAssignmentMaterial } from '@rdws/contracts';
import type { PublishedBaseline } from '../../../syncer/src/mirror.ts';
import {
  importTargetLogins,
  normalizeImportRows,
  validateImportRows,
  type NormalizedImportRows,
} from './requirement-import.ts';
type Database = ReturnType<typeof connectDatabase>['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Actor = { userId: string; authSessionId: string };
export type RequirementAuthority = 'reader' | 'editor' | 'project-admin';
type PersonnelResult = Omit<RequirementPersonnelReceipt, 'revocation'> & {
  removedUserIds: string[];
};
type StoredImport =
  | Extract<RequirementImportReceipt, { status: 'rejected' }>
  | {
      commandId: string;
      status: 'created';
      rows: { row: number; id: string }[];
    };
const participantKey = ({ userId, role }: { userId: string; role: string }) =>
  `${userId}:${role}`;
export function normalizePersonnel(input: RequirementPersonnelInput) {
  return {
    ...input,
    add: [...input.add].sort((a, b) =>
      participantKey(a).localeCompare(participantKey(b)),
    ),
    remove: [...input.remove].sort((a, b) =>
      participantKey(a).localeCompare(participantKey(b)),
    ),
    handoffs: [...input.handoffs].sort((a, b) =>
      a.fromId.localeCompare(b.fromId),
    ),
    overrides: [...input.overrides].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    ),
  };
}
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
    deferTargetValidation = false,
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
    const validTargets =
      users.length === ids.length && users.every((u) => u.active);
    if (!validTargets && !deferTargetValidation)
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
    return { users, roles, session, validTargets };
  }
  async function scope(
    tx: Transaction,
    who: Actor,
    id: string,
    lock = false,
    projectId?: string,
  ) {
    const query = tx
      .select()
      .from(schema.requirement)
      .where(
        and(
          eq(schema.requirement.id, id),
          projectId === undefined
            ? undefined
            : eq(schema.requirement.projectId, projectId),
        ),
      );
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
  function eventRecord(
    requirementId: string,
    who: Actor,
    commandId: string,
    version: number,
    kind: string,
    before: unknown,
    after: unknown,
    taskId?: string,
  ) {
    return {
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
    };
  }
  async function event(
    tx: Transaction,
    ...args: Parameters<typeof eventRecord>
  ) {
    await tx.insert(schema.requirementEvent).values(eventRecord(...args));
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
  const mayCreate = (roles: { userId: string; role: string }[], who: Actor) =>
    roles.some(
      (item) =>
        item.userId === who.userId &&
        ['project_admin', 'requirement_manager'].includes(item.role),
    );
  const mayEditDetails = (
    roles: { userId: string; role: string }[],
    participants: { userId: string; role: string }[],
    who: Actor,
  ) =>
    roles.some(
      (role) =>
        role.userId === who.userId &&
        (role.role === 'project_admin' ||
          (role.role === 'requirement_manager' &&
            participants.some(
              (participant) =>
                participant.userId === who.userId &&
                participant.role === role.role,
            ))),
    );

  function createdRequirement(value: unknown) {
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.id)
    )
      businessError(409, '原需求创建结果无法核实');
    return { id: value.id };
  }

  async function findCreatedRequirement(
    who: Actor,
    projectId: string,
    input: RequirementInput,
  ) {
    return db.transaction(async (tx) => {
      const { roles, session } = await identity(tx, who, projectId);
      if (!mayCreate(roles, who)) businessError(403, '无权创建需求');
      const [receipt] = await tx
        .select()
        .from(schema.commandReceipt)
        .where(
          and(
            eq(schema.commandReceipt.actorId, who.userId),
            eq(schema.commandReceipt.scope, 'project:' + projectId),
            eq(schema.commandReceipt.operation, 'requirement.create'),
            eq(schema.commandReceipt.commandId, input.commandId),
          ),
        );
      if (session.expiresAt <= new Date()) businessError(401, '登录已失效');
      if (!receipt) return undefined;
      if (receipt.digest !== digestOf(input))
        businessError(409, '操作标识已用于不同内容，请重新发起');
      return createdRequirement(receipt.result);
    });
  }

  function creationParticipants(
    input: RequirementInput,
    roles: { userId: string; role: string }[],
    who: Actor,
  ) {
    const own = roles
      .filter((role) => role.userId === who.userId)
      .map((role) => role.role);
    const participants: { userId: string; role: string }[] = [];
    const add = (userId: string, role: string) => {
      if (
        !participants.some(
          (person) => person.userId === userId && person.role === role,
        )
      )
        participants.push({ userId, role });
    };
    for (const person of input.participants ?? [])
      for (const role of person.roles) {
        if (
          !roles.some(
            (member) => member.userId === person.userId && member.role === role,
          )
        )
          businessError(400, '参与角色必须属于当前项目成员');
        add(person.userId, role);
      }
    for (const id of input.participantIds ?? []) {
      const current = roles.filter((role) => role.userId === id);
      if (current.length !== 1) businessError(400, '请明确选择成员的参与角色');
      add(id, current[0]!.role);
    }
    if (
      !roles.some(
        (role) => role.userId === input.leadId && role.role === 'developer',
      )
    )
      businessError(400, '开发负责人必须是项目开发成员');
    add(input.leadId, 'developer');
    add(
      who.userId,
      own.includes('requirement_manager')
        ? 'requirement_manager'
        : 'project_admin',
    );
    return participants;
  }
  async function persistRequirements(
    tx: Transaction,
    who: Actor,
    projectId: string,
    inputs: RequirementInput[],
    roles: { userId: string; role: string }[],
    baselines: PublishedBaseline[],
  ) {
    const batch = inputs.map((input) => ({
      id: randomUUID(),
      input,
      participants: creationParticipants(input, roles, who),
    }));
    const tasks = batch.flatMap(({ id, input, participants }) =>
      (input.tasks ?? []).map((task) => {
        const assigneeId = task.assigneeId ?? input.leadId;
        validAssignee(assigneeId, participants, roles);
        return {
          id: randomUUID(),
          requirementId: id,
          title: task.title.trim(),
          description: task.description ?? '',
          acceptance: task.acceptance ?? '',
          assigneeId,
          createdBy: who.userId,
        };
      }),
    );
    await tx.insert(schema.requirement).values(
      batch.map(({ id, input }) => ({
        id,
        projectId,
        title: input.title.trim(),
        description: input.description,
        acceptance: input.acceptance,
        leadId: input.leadId,
        createdBy: who.userId,
      })),
    );
    if (baselines.length)
      await tx.insert(schema.requirementWorktreePlan).values(
        batch.map(({ id }) => ({
          requirementId: id,
          repositories: baselines.map((entry) => ({
            ...entry,
            branch: 'rdws/' + id + '/' + entry.repositoryId,
            worktreePath: 'worktrees/' + entry.repositoryId,
            gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
          })),
        })),
      );
    await tx
      .insert(schema.requirementParticipant)
      .values(
        batch.flatMap(({ id, participants }) =>
          participants.map((person) => ({ ...person, requirementId: id })),
        ),
      );
    const events = batch.map(({ id, input, participants }) =>
      eventRecord(id, who, input.commandId, 1, 'requirement.created', null, {
        stage: 'assignment',
        participants,
      }),
    );
    if (tasks.length) {
      const commandIds = new Map<string, string>(
        batch.map(({ id, input }) => [id, input.commandId]),
      );
      for (const task of await tx.insert(schema.task).values(tasks).returning())
        events.push(
          eventRecord(
            task.requirementId,
            who,
            commandIds.get(task.requirementId)!,
            1,
            'task.created',
            null,
            task,
            task.id,
          ),
        );
    }
    await tx.insert(schema.requirementEvent).values(events);
    return batch.map(({ id }) => id);
  }

  async function create(
    who: Actor,
    projectId: string,
    input: RequirementInput,
    baselines: PublishedBaseline[] = [],
    confirm = () => {},
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
      const admission = await identity(
        tx,
        who,
        projectId,
        targetIds,
        true,
        true,
      );
      if (!mayCreate(admission.roles, who)) businessError(403, '无权创建需求');
      const current = () => {
        if (admission.session.expiresAt <= new Date())
          businessError(401, '登录已失效');
        confirm();
      };
      const receipt = await reserve(
        tx,
        who,
        'project:' + projectId,
        'requirement.create',
        input.commandId,
        input,
      );
      current();
      if ('result' in receipt)
        return { ...createdRequirement(receipt.result), first: false };
      if (!admission.validTargets) businessError(400, '分派成员不存在或已停用');
      const [id] = await persistRequirements(
        tx,
        who,
        projectId,
        [input],
        admission.roles,
        baselines,
      );
      if (!id) throw new Error('Missing created requirement');
      await finish(tx, receipt.value, { id });
      current();
      return { id, first: true };
    });
  }
  async function importAuthority(
    tx: Transaction,
    who: Actor,
    projectId: string,
  ) {
    const authority = await identity(tx, who, projectId);
    if (!mayCreate(authority.roles, who))
      businessError(403, '无权批量导入当前项目的需求');
    return authority;
  }
  async function authorizeImport(
    who: Actor,
    projectId: string,
    ids: string[] = [],
  ) {
    return db.transaction(
      async (tx) => {
        const { roles, session } = await importAuthority(tx, who, projectId);
        if (ids.length) {
          const scoped = await tx
            .select({ id: schema.requirement.id })
            .from(schema.requirement)
            .where(
              and(
                eq(schema.requirement.projectId, projectId),
                inArray(schema.requirement.id, ids),
              ),
            );
          if (scoped.length !== ids.length)
            businessError(403, '无法读取该批次的当前需求');
          if (!roles.some((role) => role.role === 'project_admin')) {
            const own = roles.map((role) => role.role);
            const participants = await tx
              .selectDistinct({
                id: schema.requirementParticipant.requirementId,
              })
              .from(schema.requirementParticipant)
              .where(
                and(
                  inArray(schema.requirementParticipant.requirementId, ids),
                  eq(schema.requirementParticipant.userId, who.userId),
                  inArray(schema.requirementParticipant.role, own),
                ),
              );
            if (participants.length !== ids.length)
              businessError(403, '无法读取该批次的当前需求');
          }
        }
        if (session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function importTargets(
    tx: Transaction,
    projectId: string,
    rows: NormalizedImportRows,
  ) {
    const names = importTargetLogins(rows);
    if (!names.length) return [];
    const accounts = await tx
      .selectDistinct({ id: schema.user.id })
      .from(schema.user)
      .innerJoin(
        schema.projectMember,
        eq(schema.projectMember.userId, schema.user.id),
      )
      .where(
        and(
          eq(schema.projectMember.projectId, projectId),
          inArray(schema.user.username, names),
        ),
      );
    return accounts.map(({ id }) => id);
  }
  async function previewImport(
    who: Actor,
    projectId: string,
    input: RequirementImportRow[],
  ) {
    const normalized = normalizeImportRows(input);
    return db.transaction(
      async (tx) => {
        await importAuthority(tx, who, projectId);
        const targets = await importTargets(tx, projectId, normalized);
        const { users, roles, session } = await identity(
          tx,
          who,
          projectId,
          targets,
          false,
          true,
        );
        const { feedback } = validateImportRows(normalized, users, roles, '');
        if (session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
        return { rows: feedback };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function importReceipt(
    tx: Transaction,
    who: Actor,
    projectId: string,
    commandId: string,
    digest: string,
  ): Promise<StoredImport | 'conflict' | undefined> {
    const table = schema.commandReceipt;
    const [row] = await tx
      .select({ digest: table.digest, result: table.result })
      .from(table)
      .where(
        and(
          eq(table.actorId, who.userId),
          eq(table.scope, 'project:' + projectId),
          eq(table.operation, 'requirement.import'),
          eq(table.commandId, commandId),
        ),
      );
    if (!row) return undefined;
    return row.digest === digest ? (row.result as StoredImport) : 'conflict';
  }
  async function findImportReceipt(
    who: Actor,
    projectId: string,
    input: RequirementImportInput,
  ) {
    const digest = digestOf(normalizeImportRows(input.rows));
    return db.transaction(
      async (tx) => {
        const { session } = await importAuthority(tx, who, projectId);
        const result = await importReceipt(
          tx,
          who,
          projectId,
          input.commandId,
          digest,
        );
        if (session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
        return result;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function commitImport(
    who: Actor,
    projectId: string,
    input: RequirementImportInput,
    baselines: PublishedBaseline[],
    confirm: () => void,
  ): Promise<StoredImport | 'conflict'> {
    const normalized = normalizeImportRows(input.rows);
    const digest = digestOf(normalized),
      deadline = performance.now() + 7500;
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local transaction_timeout='8s'`);
      await tx.execute(sql`set local lock_timeout='3s'`);
      const before = await importAuthority(tx, who, projectId);
      const old = await importReceipt(
        tx,
        who,
        projectId,
        input.commandId,
        digest,
      );
      const checked = (expires: Date) => {
        if (expires <= new Date()) businessError(401, '登录已失效，请重新登录');
        if (performance.now() >= deadline)
          businessError(503, '本批次入库等待超时，请核对原批次');
        confirm();
      };
      checked(before.session.expiresAt);
      if (old) return old;
      const targets = await importTargets(tx, projectId, normalized);
      const { users, roles, session } = await identity(
        tx,
        who,
        projectId,
        targets,
        true,
        true,
      );
      if (!mayCreate(roles, who))
        businessError(403, '无权批量导入当前项目的需求');
      const reservation = await reserve(
        tx,
        who,
        'project:' + projectId,
        'requirement.import',
        input.commandId,
        normalized,
      ).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 409)
          return 'conflict' as const;
        throw error;
      });
      checked(session.expiresAt);
      if (reservation === 'conflict') return reservation;
      if ('result' in reservation) return reservation.result as StoredImport;
      const { feedback, inputs } = validateImportRows(
        normalized,
        users,
        roles,
        input.commandId,
      );
      let receipt: StoredImport = {
        commandId: input.commandId,
        status: 'rejected',
        rows: feedback,
      };
      if (
        feedback.every((row) => !row.issues.length) &&
        inputs.length === normalized.length
      ) {
        const ids = await persistRequirements(
          tx,
          who,
          projectId,
          inputs,
          roles,
          baselines,
        );
        receipt = {
          commandId: input.commandId,
          status: 'created',
          rows: normalized.map(({ row }, index) => ({ row, id: ids[index]! })),
        };
      }
      await finish(tx, reservation.value, receipt);
      checked(session.expiresAt);
      return receipt;
    });
  }
  async function execute(who: Actor, id: string, input: BusinessCommand) {
    const [existing] = await db
      .select()
      .from(schema.requirement)
      .where(eq(schema.requirement.id, id));
    if (!existing) businessError(404, '需求不存在');
    return transaction(async (tx) => {
      const reopening =
        input.type === 'task.update' &&
        (input.patch.status === 'todo' || input.patch.status === 'in_progress');
      const [preview] =
        reopening && !input.patch.assigneeId
          ? await tx
              .select({ assigneeId: schema.task.assigneeId })
              .from(schema.task)
              .where(
                and(
                  eq(schema.task.id, input.taskId),
                  eq(schema.task.requirementId, id),
                ),
              )
          : [];
      const target =
        input.type === 'task.create'
          ? input.task.assigneeId
          : input.type === 'task.update'
            ? (input.patch.assigneeId ?? preview?.assigneeId)
            : undefined;
      const { roles, validTargets } = await identity(
        tx,
        who,
        existing.projectId,
        target ? [target] : [],
        true,
        !!preview,
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
        if (
          reopening &&
          (task.status === 'done' || task.status === 'cancelled')
        ) {
          if (
            !input.patch.assigneeId &&
            task.assigneeId !== preview?.assigneeId
          )
            businessError(409, '子任务分派已变化，请重新读取');
          if (!validTargets)
            businessError(400, '原负责人已失效，请明确改派后再开启');
          validAssignee(
            input.patch.assigneeId ?? task.assigneeId,
            state.participants,
            roles,
          );
        }
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
  async function editDetails(
    who: Actor,
    id: string,
    projectId: string,
    input: RequirementDetailsInput,
    confirmResponse: () => void,
  ): Promise<RequirementDetailsReceipt | 'conflict'> {
    return transaction(async (tx) => {
      const authority = await identity(tx, who, projectId, [], true);
      const state = await scope(tx, who, id, true, projectId);
      if (!mayEditDetails(authority.roles, state.participants, who))
        businessError(403, '无权编辑当前需求资料');
      const confirm = () => {
        if (authority.session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
        confirmResponse();
      };
      const patch = { ...input.patch };
      if (patch.title !== undefined) patch.title = patch.title.trim();
      confirm();
      const reservation = await reserve(
        tx,
        who,
        'requirement:' + id,
        'requirement.details',
        input.commandId,
        patch,
      ).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 409)
          return 'conflict' as const;
        throw error;
      });
      confirm();
      if (reservation === 'conflict') return reservation;
      if ('result' in reservation)
        return reservation.result as RequirementDetailsReceipt;
      const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter(
        (key) => patch[key] !== state.item[key],
      );
      const changed = fields.length > 0;
      const version = state.item.contextVersion + Number(changed);
      if (changed) {
        const previous = Object.fromEntries(
          fields.map((key) => [key, state.item[key]]),
        );
        const delta = Object.fromEntries(
          fields.map((key) => [key, patch[key]]),
        );
        await tx
          .update(schema.requirement)
          .set({ ...delta, contextVersion: version, updatedAt: new Date() })
          .where(
            and(
              eq(schema.requirement.id, id),
              eq(schema.requirement.projectId, projectId),
            ),
          );
        await event(
          tx,
          id,
          who,
          input.commandId,
          version,
          'requirement.details',
          previous,
          delta,
        );
      }
      const receipt = {
        commandId: input.commandId,
        changed,
        contextVersion: version,
      };
      await finish(tx, reservation.value, receipt);
      confirm();
      return receipt;
    });
  }
  async function editPersonnel(
    who: Actor,
    projectId: string,
    id: string,
    input: RequirementPersonnelInput,
    confirmAuthority: () => void,
    fence: (removed: string[]) => void,
  ): Promise<PersonnelResult | 'conflict'> {
    const normalized = normalizePersonnel(input);
    const {
      commandId,
      previewLeadId,
      leadId,
      add,
      remove,
      handoffs,
      overrides,
      taskDigest,
    } = normalized;
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='3s'`);
      const targets = [
        previewLeadId,
        leadId,
        ...add.map((p) => p.userId),
        ...remove.map((p) => p.userId),
        ...handoffs.flatMap((p) => [p.fromId, p.toId]),
        ...overrides.map((p) => p.toId),
      ];
      const authority = await identity(tx, who, projectId, targets, true, true);
      const state = await scope(tx, who, id, true, projectId);
      if (!mayEditDetails(authority.roles, state.participants, who))
        businessError(403, '无权维护当前需求人员');
      const confirm = () => {
        if (authority.session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
        confirmAuthority();
      };
      confirm();
      const reservation = await reserve(
        tx,
        who,
        'requirement:' + id,
        'requirement.personnel',
        commandId,
        normalized,
      ).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 409)
          return 'conflict' as const;
        throw error;
      });
      confirm();
      if (reservation === 'conflict') return reservation;
      if ('result' in reservation) return reservation.result as PersonnelResult;

      const complete = async (
        status: PersonnelResult['status'],
        version = state.item.contextVersion,
        removedUserIds: string[] = [],
      ) => {
        const receipt = {
          commandId,
          status,
          contextVersion: version,
          removedUserIds,
        };
        await finish(tx, reservation.value, receipt);
        confirm();
        if (removedUserIds.length) fence(removedUserIds);
        return receipt;
      };
      if (state.item.leadId !== previewLeadId) return complete('stale');
      const active = new Set(
        authority.users.filter((user) => user.active).map((user) => user.id),
      );
      const projectRoles = new Set(authority.roles.map(participantKey));
      const current = new Set(state.participants.map(participantKey));
      const added = add.filter(
        (person) => !current.has(participantKey(person)),
      );
      const removed = remove.filter((person) =>
        current.has(participantKey(person)),
      );
      for (const person of removed) current.delete(participantKey(person));
      for (const person of added) current.add(participantKey(person));
      const eligible = (userId: string) =>
        active.has(userId) &&
        projectRoles.has(`${userId}:developer`) &&
        current.has(`${userId}:developer`);
      if (
        !eligible(leadId) ||
        add.some(
          (person) =>
            !active.has(person.userId) ||
            !projectRoles.has(participantKey(person)),
        ) ||
        [...handoffs, ...overrides].some(({ toId }) => !eligible(toId))
      )
        return complete('invalid');

      const formerAssignees = new Set(
        removed
          .filter((person) => person.role === 'developer')
          .map((person) => person.userId),
      );
      if (leadId !== previewLeadId) formerAssignees.add(previewLeadId);
      const affected = formerAssignees.size
        ? await tx
            .select({ id: schema.task.id, assigneeId: schema.task.assigneeId })
            .from(schema.task)
            .where(
              and(
                eq(schema.task.requirementId, id),
                inArray(schema.task.status, ['todo', 'in_progress']),
                inArray(schema.task.assigneeId, [...formerAssignees]),
              ),
            )
            .orderBy(asc(schema.task.id))
            .for('update')
        : [];
      const currentDigest = createHash('sha256')
        .update(taskAssignmentMaterial(affected))
        .digest('hex');
      if (taskDigest !== currentDigest) return complete('stale');
      const taskIds = new Set(affected.map((task) => task.id));
      const currentAssignees = new Set(affected.map((task) => task.assigneeId));
      if (
        handoffs.some(
          ({ fromId, toId }) =>
            !currentAssignees.has(fromId) || fromId === toId,
        ) ||
        overrides.some(({ taskId }) => !taskIds.has(taskId))
      )
        return complete('invalid');
      const byPerson = new Map(
        handoffs.map(({ fromId, toId }) => [fromId, toId]),
      );
      const byTask = new Map(
        overrides.map(({ taskId, toId }) => [taskId, toId]),
      );
      const transfers = affected.map((task) => ({
        ...task,
        toId: byTask.get(task.id) ?? byPerson.get(task.assigneeId),
      }));
      if (
        transfers.some(({ assigneeId, toId }) => !toId || toId === assigneeId)
      )
        return complete('invalid');
      if (!added.length && !removed.length && previewLeadId === leadId)
        return complete('unchanged');
      confirm();

      for (const person of removed)
        await tx
          .delete(schema.requirementParticipant)
          .where(
            and(
              eq(schema.requirementParticipant.requirementId, id),
              eq(schema.requirementParticipant.userId, person.userId),
              eq(schema.requirementParticipant.role, person.role),
            ),
          );
      if (added.length)
        await tx
          .insert(schema.requirementParticipant)
          .values(added.map((person) => ({ ...person, requirementId: id })));
      const version = state.item.contextVersion + 1;
      for (const task of transfers) {
        await tx
          .update(schema.task)
          .set({ assigneeId: task.toId!, updatedAt: new Date() })
          .where(
            and(eq(schema.task.id, task.id), eq(schema.task.requirementId, id)),
          );
        await event(
          tx,
          id,
          who,
          commandId,
          version,
          'task.updated',
          { assigneeId: task.assigneeId },
          { assigneeId: task.toId },
          task.id,
        );
      }
      await tx
        .update(schema.requirement)
        .set({ leadId, contextVersion: version, updatedAt: new Date() })
        .where(
          and(
            eq(schema.requirement.id, id),
            eq(schema.requirement.projectId, projectId),
          ),
        );
      await event(
        tx,
        id,
        who,
        commandId,
        version,
        'requirement.personnel',
        { leadId: previewLeadId, participants: removed },
        { leadId, participants: added },
      );
      return complete('saved', version, [
        ...new Set(removed.map((person) => person.userId)),
      ]);
    });
  }
  async function recoverPersonnelCommit(
    actorId: string,
    projectId: string,
    id: string,
    commandId: string,
    digest: string,
  ) {
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`set local lock_timeout='3s'`);
        const [demand] = await tx
          .select({ id: schema.requirement.id })
          .from(schema.requirement)
          .where(
            and(
              eq(schema.requirement.id, id),
              eq(schema.requirement.projectId, projectId),
            ),
          )
          .for('update');
        if (!demand) return undefined;
        const table = schema.commandReceipt;
        const [receipt] = await tx
          .select({ digest: table.digest, result: table.result })
          .from(table)
          .where(
            and(
              eq(table.actorId, actorId),
              eq(table.scope, 'requirement:' + id),
              eq(table.operation, 'requirement.personnel'),
              eq(table.commandId, commandId),
            ),
          );
        if (!receipt) return false;
        return receipt.digest === digest &&
          (receipt.result as PersonnelResult | null)?.status === 'saved'
          ? true
          : undefined;
      },
      { isolationLevel: 'read committed' },
    );
  }
  async function readWithDeadline(
    who: Actor,
    id: string,
    sessionId?: string,
    relatedActors: Actor[] = [],
  ) {
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`set local statement_timeout='1800ms'`);
        const state = await scope(tx, who, id);
        const authority = await identity(tx, who, state.item.projectId);
        let validBefore = authority.session.expiresAt.getTime();
        for (const actor of relatedActors) {
          const { session } = await identity(tx, actor, state.item.projectId);
          validBefore = Math.min(validBefore, session.expiresAt.getTime());
        }
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
          .select({
            record: schema.requirementEvent,
            actorName: schema.user.name,
          })
          .from(schema.requirementEvent)
          .leftJoin(
            schema.user,
            eq(schema.user.id, schema.requirementEvent.actorId),
          )
          .where(eq(schema.requirementEvent.requirementId, id))
          .orderBy(
            desc(schema.requirementEvent.version),
            desc(
              sql`case when ${schema.requirementEvent.kind} = 'requirement.personnel' then 1 else 0 end`,
            ),
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
        const participantIds = new Set(
          state.participants.map((member) => member.userId),
        );
        const assignmentIds = new Set(tasks.map((task) => task.assigneeId));
        for (const { record } of events) {
          if (
            !['task.created', 'task.updated', 'requirement.personnel'].includes(
              record.kind,
            )
          )
            continue;
          for (const value of [record.before, record.after]) {
            if (!value || typeof value !== 'object') continue;
            const assignment = value as {
              assigneeId?: unknown;
              leadId?: unknown;
            };
            const id = assignment.assigneeId ?? assignment.leadId;
            if (typeof id === 'string') assignmentIds.add(id);
          }
        }
        const people = await tx
          .select({
            id: schema.user.id,
            name: schema.user.name,
            active: schema.user.active,
          })
          .from(schema.user)
          .where(
            inArray(schema.user.id, [
              ...new Set([...participantIds, ...assignmentIds]),
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
        const detail = {
          requirement: state.item,
          tasks,
          assignmentNames: Object.fromEntries(
            people
              .filter((person) => assignmentIds.has(person.id))
              .map((person) => [person.id, person.name]),
          ),
          events: events.map(({ record, actorName }) =>
            record.kind === 'requirement.details'
              ? {
                  id: record.id,
                  kind: record.kind,
                  actorId: record.actorId,
                  actorName,
                  source: record.source,
                  version: record.version,
                  taskId: record.taskId,
                  createdAt: record.createdAt,
                  before: null,
                  after: null,
                  changedFields: Object.keys(
                    record.after as RequirementDetailsInput['patch'],
                  ) as (keyof RequirementDetailsInput['patch'])[],
                }
              : { ...record, actorName },
          ),
          reachedStages: [
            ...new Set([
              'assignment',
              state.item.stage,
              ...stageEvents
                .flatMap((e) => [e.before, e.after])
                .filter((v): v is string => typeof v === 'string'),
            ]),
          ],
          participants: people
            .filter((p) => participantIds.has(p.id))
            .map((p) => ({
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
            canEditDetails: mayEditDetails(
              authority.roles,
              state.participants,
              who,
            ),
            userId: who.userId,
            codeWrite: false,
          },
        };
        return { detail, validBefore };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function read(
    who: Actor,
    id: string,
    sessionId?: string,
    relatedActors: Actor[] = [],
  ) {
    return (await readWithDeadline(who, id, sessionId, relatedActors)).detail;
  }
  async function sessionTransaction<T>(
    who: Actor,
    id: string,
    projectId: string,
    sourceId: string | undefined,
    work: (
      tx: Transaction,
      item: typeof schema.requirement.$inferSelect,
      expiresAt: number,
    ) => Promise<T>,
  ) {
    return transaction(async (tx) => {
      const auth = await identity(tx, who, projectId, [], true);
      const state = await scope(tx, who, id, true, projectId);
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
      const expiresAt = auth.session.expiresAt.getTime();
      if (expiresAt <= Date.now()) businessError(401, '登录已失效，请重新登录');
      const result = await work(tx, state.item, expiresAt);
      if (expiresAt <= Date.now()) businessError(401, '登录已失效，请重新登录');
      return result;
    });
  }
  async function authorizeRequirement(
    who: Actor,
    id: string,
    projectId: string,
    required: RequirementAuthority,
    reader: Database | Transaction = db,
  ) {
    const {
      session,
      user,
      requirement,
      projectMember,
      requirementParticipant,
    } = schema;
    const [current] = await reader
      .select({
        demand: requirement.id,
        expiresAt: session.expiresAt,
        admin: sql<boolean>`exists (select 1 from ${projectMember}
          where ${projectMember.projectId} = ${projectId}
            and ${projectMember.userId} = ${who.userId}
            and ${projectMember.role} = 'project_admin')`,
        participant: sql<boolean>`exists (select 1 from ${requirementParticipant}
          join ${projectMember} on ${projectMember.role} = ${requirementParticipant.role}
            and ${projectMember.projectId} = ${projectId}
            and ${projectMember.userId} = ${who.userId}
          where ${requirementParticipant.requirementId} = ${id}
            and ${requirementParticipant.userId} = ${who.userId}
            ${required === 'editor' ? sql`and ${requirementParticipant.role} = 'requirement_manager'` : sql``})`,
      })
      .from(session)
      .innerJoin(user, eq(session.userId, user.id))
      .leftJoin(
        requirement,
        and(eq(requirement.id, id), eq(requirement.projectId, projectId)),
      )
      .where(
        and(
          eq(session.id, who.authSessionId),
          eq(user.id, who.userId),
          eq(user.active, true),
          eq(user.authEpoch, session.authEpoch),
        ),
      );
    if (!current || current.expiresAt <= new Date())
      businessError(401, '登录已失效，请重新登录');
    if (
      !current.demand ||
      (!current.admin && (required === 'project-admin' || !current.participant))
    )
      businessError(403, '无权执行当前需求操作');
    return current;
  }
  async function readTemplateBinding(
    who: Actor,
    id: string,
    projectId: string,
  ): Promise<RequirementTemplateBinding> {
    return db.transaction(
      async (tx) => {
        const authority = await authorizeRequirement(
          who,
          id,
          projectId,
          'reader',
          tx,
        );
        const bindingTable = schema.requirementCapabilityBinding;
        const revisions = schema.capabilityTemplateRevision;
        const [bound] = await tx
          .select({
            templateId: bindingTable.templateId,
            revision: bindingTable.revision,
          })
          .from(bindingTable)
          .where(
            and(
              eq(bindingTable.requirementId, id),
              eq(bindingTable.projectId, projectId),
            ),
          );
        if (!bound && !authority.admin) return { binding: null };
        const available = schema.capabilityApproval;
        const approvals = new Set(
          (
            await tx
              .select()
              .from(available)
              .where(eq(available.approved, true))
          ).map(capabilityKey),
        );
        const rows = await tx
          .select({
            templateId: revisions.templateId,
            revision: revisions.revision,
            name: revisions.name,
            capabilities: revisions.capabilities,
          })
          .from(revisions)
          .where(
            and(
              eq(revisions.projectId, projectId),
              authority.admin
                ? undefined
                : and(
                    eq(revisions.templateId, bound!.templateId),
                    eq(revisions.revision, bound!.revision),
                  ),
            ),
          )
          .orderBy(
            asc(revisions.name),
            asc(revisions.templateId),
            desc(revisions.revision),
          );
        const versions = rows.map(({ capabilities, ...version }) => ({
          ...version,
          available: capabilities.every((item) =>
            approvals.has(capabilityKey(item)),
          ),
        }));
        const binding =
          versions.find(
            (version) =>
              version.templateId === bound?.templateId &&
              version.revision === bound.revision,
          ) ?? null;
        return authority.admin
          ? {
              binding,
              options: versions
                .filter((version) => version.available)
                .map(({ templateId, revision, name }) => ({
                  templateId,
                  revision,
                  name,
                })),
            }
          : { binding };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function approvedTemplateReferences(
    tx: Transaction,
    references: CapabilityVersion[],
  ) {
    if (!references.length) return true;
    const approval = schema.capabilityApproval;
    const active = await tx
      .select({ kind: approval.kind })
      .from(approval)
      .where(
        and(
          eq(approval.approved, true),
          or(
            ...references.map((item) =>
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
    return active.length === references.length;
  }
  async function sessionTemplate(
    tx: Transaction,
    item: typeof schema.requirement.$inferSelect,
  ) {
    const binding = schema.requirementCapabilityBinding;
    const revision = schema.capabilityTemplateRevision;
    const [selection] = await tx
      .transaction((read) =>
        read
          .select({
            templateId: revision.templateId,
            revision: revision.revision,
            capabilities: revision.capabilities,
          })
          .from(binding)
          .innerJoin(
            revision,
            and(
              eq(revision.projectId, binding.projectId),
              eq(revision.templateId, binding.templateId),
              eq(revision.revision, binding.revision),
            ),
          )
          .where(
            and(
              eq(binding.projectId, item.projectId),
              eq(binding.requirementId, item.id),
            ),
          ),
      )
      .catch((error: unknown) => {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === '42P01') return [];
        throw error;
      });
    return selection
      ? {
          selection,
          approved: await approvedTemplateReferences(
            tx,
            selection.capabilities,
          ),
        }
      : undefined;
  }
  async function bindTemplate(
    who: Actor,
    id: string,
    projectId: string,
    input: TemplateBindingInput,
    confirmResponse: () => void,
  ): Promise<TemplateBindingReceipt | 'conflict'> {
    return transaction(async (tx) => {
      const auth = await identity(tx, who, projectId, [], true);
      if (!auth.roles.some((role) => role.role === 'project_admin'))
        businessError(403, '无权绑定当前需求模板');
      const [demand] = await tx
        .select({ id: schema.requirement.id })
        .from(schema.requirement)
        .where(
          and(
            eq(schema.requirement.id, id),
            eq(schema.requirement.projectId, projectId),
          ),
        )
        .for('update');
      if (!demand) businessError(403, '需求所属项目已变化');
      function confirm() {
        if (auth.session.expiresAt <= new Date())
          businessError(401, '登录已失效，请重新登录');
        confirmResponse();
      }
      confirm();
      const { commandId, templateId, revision } = input;
      const choice = { templateId, revision };
      const reservation = await reserve(
        tx,
        who,
        'requirement:' + id,
        'capability.template.bind',
        commandId,
        choice,
      ).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 409)
          return 'conflict' as const;
        throw error;
      });
      confirm();
      if (reservation === 'conflict') return reservation;
      if (reservation.result)
        return {
          ...(reservation.result as Omit<TemplateBindingReceipt, 'replayed'>),
          replayed: true,
        };

      const table = schema.requirementCapabilityBinding,
        versions = schema.capabilityTemplateRevision;
      const [bound] = await tx
        .select({ templateId: table.templateId, revision: table.revision })
        .from(table)
        .where(
          and(eq(table.requirementId, id), eq(table.projectId, projectId)),
        );
      const [selected] = await tx
        .select({ capabilities: versions.capabilities })
        .from(versions)
        .where(
          and(
            eq(versions.projectId, projectId),
            eq(versions.templateId, templateId),
            eq(versions.revision, revision),
          ),
        );
      const available =
        selected &&
        (await approvedTemplateReferences(tx, selected.capabilities));
      const status = !available
        ? 'unavailable'
        : bound?.templateId === templateId && bound.revision === revision
          ? 'unchanged'
          : 'saved';
      confirm();
      if (status === 'saved')
        await tx
          .insert(table)
          .values({ requirementId: id, projectId, ...choice })
          .onConflictDoUpdate({ target: table.requirementId, set: choice });
      const receipt: Omit<TemplateBindingReceipt, 'replayed'> = {
        commandId,
        status,
        before: bound ?? null,
        after: status === 'saved' ? choice : (bound ?? null),
      };
      await finish(tx, reservation.value, receipt);
      confirm();
      return { ...receipt, replayed: false };
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
    if (!(await approvedTemplateReferences(tx, input.capabilities)))
      return unchanged('unavailable');
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
    authorizeImport,
    previewImport,
    findImportReceipt,
    commitImport,
    findCreatedRequirement,
    execute,
    read,
    readWithDeadline,
    sessionTransaction,
    sessionTemplate,
    approvedTemplateReferences,
    authorizeRequirement,
    editDetails,
    editPersonnel,
    recoverPersonnelCommit,
    readTemplateBinding,
    bindTemplate,
    publishRepository,
    manage,
  };
}
