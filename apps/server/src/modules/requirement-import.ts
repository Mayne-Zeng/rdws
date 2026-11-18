import {
  importLimits,
  splitImportAccounts,
  splitImportTasks,
  type RequirementImportField,
  type RequirementImportFeedback,
  type RequirementImportRow,
  type RequirementInput,
} from '@rdws/contracts';

const roleFields = [
  ['managers', 'requirement_manager'],
  ['developers', 'developer'],
  ['testers', 'tester'],
] as const;
const loginName = /^[a-z0-9_.-]{1,64}$/;

export function normalizeImportRows(rows: RequirementImportRow[]) {
  return rows.map((row) => ({
    ...row,
    title: row.title.trim(),
    lead: row.lead.trim().toLowerCase(),
    managers: splitImportAccounts(row.managers),
    developers: splitImportAccounts(row.developers),
    testers: splitImportAccounts(row.testers),
    tasks: splitImportTasks(row.tasks),
  }));
}
export type NormalizedImportRows = ReturnType<typeof normalizeImportRows>;

export function importWorkload(rows: NormalizedImportRows) {
  let tasks = 0,
    roles = 0;
  for (const row of rows) {
    tasks += row.tasks.length;
    roles += row.managers.length + row.developers.length + row.testers.length;
  }
  return { tasks, roles };
}

export function importTargetLogins(rows: NormalizedImportRows) {
  if (importWorkload(rows).roles > importLimits.roleCount) return [];
  return [
    ...new Set(
      rows
        .flatMap((row) => [
          row.lead,
          ...row.managers,
          ...row.developers,
          ...row.testers,
        ])
        .filter((name) => loginName.test(name)),
    ),
  ];
}

export function validateImportRows(
  rows: NormalizedImportRows,
  users: readonly { id: string; username: string | null; active: boolean }[],
  roles: readonly { userId: string; role: string }[],
  commandId: string,
) {
  const accounts = new Map(
    users
      .filter((user) => user.active && user.username)
      .map((user) => [user.username, user.id]),
  );
  const currentlyAllowed = new Set(
    roles.map(({ userId, role }) => `${userId}:${role}`),
  );
  const workload = importWorkload(rows);
  const feedback: RequirementImportFeedback[] = [];
  const inputs: RequirementInput[] = [];
  const tooLong = (value: string, limit: number) =>
    value.length > limit &&
    (value.length > 2 * limit || [...value].length > limit);
  let tasks = 0,
    roleCount = 0;
  for (const row of rows) {
    const issues: RequirementImportFeedback['issues'] = [];
    const fail = (field: RequirementImportField, message: string) =>
      issues.push({ field, message });
    if (!row.title || tooLong(row.title, 160))
      fail('title', '请填写 1–160 字符的需求标题');
    if (tooLong(row.description, 8000))
      fail('description', '需求说明最多 8000 字符');
    if (tooLong(row.acceptance, 8000))
      fail('acceptance', '验收标准最多 8000 字符');
    tasks += row.tasks.length;
    if (row.tasks.length > 100 || row.tasks.some((task) => tooLong(task, 160)))
      fail('tasks', '每条需求最多 100 个初始子任务，每个标题最多 160 字符');
    if (
      workload.tasks > importLimits.taskCount &&
      tasks > importLimits.taskCount
    )
      fail('tasks', '本批次最多 200 个初始子任务');

    function member(name: string, role: string) {
      const id = loginName.test(name) ? accounts.get(name) : undefined;
      return id && currentlyAllowed.has(`${id}:${role}`) ? id : undefined;
    }
    const participants = new Map<string, Set<(typeof roleFields)[number][1]>>();
    for (const [field, role] of roleFields) {
      roleCount += row[field].length;
      if (
        workload.roles > importLimits.roleCount &&
        roleCount > importLimits.roleCount &&
        row[field].length
      )
        fail(field, '本批次最多填报 500 个角色项');
      if (workload.roles > importLimits.roleCount) continue;
      for (const name of new Set(row[field])) {
        const id = member(name, role);
        if (!id) {
          fail(field, '指定账号须是当前项目具备对应角色的有效成员');
          break;
        }
        const selected = participants.get(id) ?? new Set();
        selected.add(role);
        participants.set(id, selected);
      }
      if (participants.size > 50)
        fail(field, '每条需求最多可指定 50 个参与账号');
    }
    const leadId = member(row.lead, 'developer');
    if (!leadId && workload.roles <= importLimits.roleCount)
      fail('lead', '开发负责人须填写本项目有效开发成员的登录名');
    feedback.push({ row: row.row, issues });
    if (!issues.length && leadId)
      inputs.push({
        commandId,
        title: row.title,
        description: row.description,
        acceptance: row.acceptance,
        leadId,
        participants: [...participants].map(([userId, selected]) => ({
          userId,
          roles: [...selected],
        })),
        tasks: row.tasks.map((title) => ({ title })),
      });
  }
  return { feedback, inputs };
}
