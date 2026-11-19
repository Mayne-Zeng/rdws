import { Type, type Static } from 'typebox';
export const ProjectList = Type.Object({
  projects: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      roles: Type.Array(Type.String()),
    }),
  ),
});
export type ProjectList = Static<typeof ProjectList>;
export const Health = Type.Object({ status: Type.Literal('ok') });
export const ApiError = Type.Object({ error: Type.String() });
export const SessionCreate = Type.Object(
  {
    commandId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);
export const SessionFork = Type.Object(
  {
    commandId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);
export interface SessionOperationResult {
  commandId: string;
  status:
    | 'reserved'
    | 'dispatched'
    | 'native-created'
    | 'mapped'
    | 'unknown'
    | 'rejected';
  sessionId?: string;
  error?: string;
}
export interface SessionHistoryPage {
  cursor: number;
  beforeSeq: number;
  hasMore: boolean;
  events: {
    seq: number;
    type: string;
    label: string;
    text?: string;
    outcome?: string;
  }[];
}
export interface RequirementWorktree {
  repositoryId: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  gitStorePath: string;
}
export interface RequirementWorkspace {
  state: 'unconfigured' | 'pending' | 'ready';
  canPrepare: boolean;
  repositories: RequirementWorktree[];
}
export const stageLabels = {
  intake: '录入',
  assignment: '指派',
  design: '设计',
  development: '开发',
  testing: '测试',
  integration: '非生产集成',
} as const;
export const taskStatusLabels = {
  todo: '待开始',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
} as const;
export type Stage = keyof typeof stageLabels;
export type TaskStatus = keyof typeof taskStatusLabels;
export const capabilityKindLabels = {
  plugin: '插件',
  skill: '技能',
  mcp: 'MCP',
} satisfies Record<CapabilityKind, string>;
export const roles = [
  'project_admin',
  'requirement_manager',
  'developer',
  'tester',
] as const;
export const TaskInput = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }),
    description: Type.Optional(Type.String({ maxLength: 8000 })),
    acceptance: Type.Optional(Type.String({ maxLength: 8000 })),
    assigneeId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TaskInput = Static<typeof TaskInput>;
export const RequirementInput = Type.Object(
  {
    commandId: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }),
    description: Type.String({ maxLength: 8000 }),
    acceptance: Type.String({ maxLength: 8000 }),
    leadId: Type.String(),
    participants: Type.Optional(
      Type.Array(
        Type.Object(
          {
            userId: Type.String(),
            roles: Type.Array(
              Type.Unsafe<(typeof roles)[number]>(
                Type.Union(roles.map((role) => Type.Literal(role))),
              ),
              { minItems: 1, maxItems: 4, uniqueItems: true },
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    ),
    participantIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
    tasks: Type.Optional(Type.Array(TaskInput, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export type RequirementInput = Static<typeof RequirementInput>;
export const importColumns = {
  title: '需求标题',
  description: '需求说明',
  acceptance: '验收标准',
  lead: '开发负责人',
  managers: '需求经理',
  developers: '开发人员',
  testers: '测试人员',
  tasks: '初始子任务',
} as const;
export const importLimits = {
  rows: 50,
  taskCount: 200,
  roleCount: 500,
  bytes: 2 * 1024 * 1024,
} as const;
const ImportRow = Type.Object(
  {
    row: Type.Integer({ minimum: 2, maximum: 1048576 }),
    title: Type.String(),
    description: Type.String(),
    acceptance: Type.String(),
    lead: Type.String(),
    managers: Type.String(),
    developers: Type.String(),
    testers: Type.String(),
    tasks: Type.String(),
  },
  { additionalProperties: false },
);
export const RequirementImportPreviewInput = Type.Object(
  { rows: Type.Array(ImportRow, { minItems: 1, maxItems: importLimits.rows }) },
  { additionalProperties: false },
);
export const RequirementImportInput = Type.Object(
  {
    commandId: Type.String({ format: 'uuid' }),
    rows: RequirementImportPreviewInput.properties.rows,
  },
  { additionalProperties: false },
);
export type RequirementImportRow = Static<typeof ImportRow>;
export type RequirementImportInput = Static<typeof RequirementImportInput>;
export type RequirementImportField = keyof typeof importColumns;
export interface RequirementImportFeedback {
  row: number;
  issues: { field: RequirementImportField; message: string }[];
}
export type RequirementImportReceipt = { commandId: string } & (
  | {
      status: 'created';
      rows: {
        row: number;
        id: string;
        workspaceState: RequirementWorkspace['state'];
      }[];
    }
  | { status: 'rejected'; rows: RequirementImportFeedback[] }
);
export const splitImportAccounts = (value: string) =>
  value
    .split(/[;；\r\n]+/u)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
export const splitImportTasks = (value: string) =>
  value
    .split(/\r?\n|\r/u)
    .map((title) => title.trim())
    .filter(Boolean);
export const RequirementDetailsInput = Type.Object(
  {
    commandId: Type.String({ format: 'uuid' }),
    patch: Type.Object(
      {
        title: Type.Optional(RequirementInput.properties.title),
        description: Type.Optional(RequirementInput.properties.description),
        acceptance: Type.Optional(RequirementInput.properties.acceptance),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
  },
  { additionalProperties: false },
);
export type RequirementDetailsInput = Static<typeof RequirementDetailsInput>;
export interface RequirementDetailsReceipt {
  commandId: string;
  changed: boolean;
  contextVersion: number;
}
export const personnelRoles = [
  'requirement_manager',
  'developer',
  'tester',
] as const;
export type PersonnelRole = (typeof personnelRoles)[number];
const PersonId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
});
const PersonnelRoleChange = Type.Object(
  {
    userId: PersonId,
    role: Type.Unsafe<PersonnelRole>(
      Type.Union(personnelRoles.map((role) => Type.Literal(role))),
    ),
  },
  { additionalProperties: false },
);
export const RequirementPersonnelInput = Type.Object(
  {
    commandId: Type.String({ format: 'uuid' }),
    previewLeadId: PersonId,
    leadId: PersonId,
    add: Type.Array(PersonnelRoleChange, { maxItems: 50 }),
    remove: Type.Array(PersonnelRoleChange, { maxItems: 50 }),
    taskDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    handoffs: Type.Array(
      Type.Object(
        { fromId: PersonId, toId: PersonId },
        { additionalProperties: false },
      ),
      { maxItems: 51 },
    ),
    overrides: Type.Array(
      Type.Object(
        { taskId: Type.String({ format: 'uuid' }), toId: PersonId },
        { additionalProperties: false },
      ),
      { maxItems: 80 },
    ),
  },
  { additionalProperties: false },
);
export type RequirementPersonnelInput = Static<
  typeof RequirementPersonnelInput
>;
export interface RequirementPersonnelReceipt {
  commandId: string;
  status: 'saved' | 'unchanged' | 'stale' | 'invalid';
  contextVersion: number;
  revocation: 'none' | 'confirmed' | 'lease-expiry' | 'previously-recorded';
}
export interface RequirementPersonnelCandidates {
  members: { id: string; name: string; role: PersonnelRole }[];
}
export function taskAssignmentMaterial(
  tasks: readonly { id: string; assigneeId: string }[],
) {
  return JSON.stringify(
    tasks.map(({ id, assigneeId }) => [id, assigneeId]).sort(),
  );
}
export const BusinessCommand = Type.Union([
  Type.Object(
    {
      commandId: Type.String({ format: 'uuid' }),
      type: Type.Literal('requirement.stage'),
      stage: Type.Unsafe<Stage>(
        Type.Union(
          Object.keys(stageLabels).map((stage) => Type.Literal(stage)),
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      commandId: Type.String({ format: 'uuid' }),
      type: Type.Literal('task.create'),
      task: TaskInput,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      commandId: Type.String({ format: 'uuid' }),
      type: Type.Literal('task.update'),
      taskId: Type.String(),
      patch: Type.Object(
        {
          title: Type.Optional(
            Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }),
          ),
          description: Type.Optional(Type.String({ maxLength: 8000 })),
          acceptance: Type.Optional(Type.String({ maxLength: 8000 })),
          assigneeId: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Unsafe<TaskStatus>(
              Type.Union(
                Object.keys(taskStatusLabels).map((status) =>
                  Type.Literal(status),
                ),
              ),
            ),
          ),
        },
        { additionalProperties: false, minProperties: 1 },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type BusinessCommand = Static<typeof BusinessCommand>;
export interface RequirementSummary {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  leadId: string;
  stage: Stage;
  contextVersion: number;
  updatedAt?: string;
}
export interface TaskRecord {
  id: string;
  requirementId: string;
  title: string;
  description: string;
  acceptance: string;
  assigneeId: string;
  status: TaskStatus;
}
export interface RequirementDetail {
  reachedStages: string[];
  requirement: RequirementSummary;
  tasks: TaskRecord[];
  assignmentNames?: Record<string, string>;
  participants: {
    id: string;
    name: string;
    active: boolean;
    eligibleDeveloper: boolean;
    roles: string[];
  }[];
  events: {
    id: string;
    kind: string;
    actorId: string;
    actorName: string | null;
    source: string;
    version: number;
    taskId: string | null;
    before: unknown;
    after: unknown;
    changedFields?: (keyof RequirementDetailsInput['patch'])[];
    createdAt: string;
  }[];
  permissions: {
    canManageTasks: boolean;
    canChangeStage: boolean;
    canUpdateOwnTasks: boolean;
    canEditDetails: boolean;
    userId: string;
    codeWrite: false;
  };
}
export const businessAuditLabels = {
  'requirement.initialized': '初始化需求',
  'requirement.participation.repaired': '补全需求参与关系',
  'requirement.created': '创建需求',
  'requirement.stage': '调整需求阶段',
  'requirement.details': '编辑需求资料',
  'requirement.personnel': '调整人员与分工',
  'task.created': '创建子任务',
  'task.updated': '更新子任务',
} as const;
export interface BusinessAuditEvent {
  id: string;
  kind: keyof typeof businessAuditLabels;
  actorId: string;
  actorName: string | null;
  source: 'web' | 'migration';
  version: number;
  taskId: string | null;
  createdAt: string;
  stage?: { before: Stage; after: Stage };
  taskStatus?: { before?: TaskStatus; after: TaskStatus };
  changedFields?: (keyof RequirementDetailsInput['patch'])[];
}
export interface BusinessAuditPage {
  requirementId: string;
  throughVersion: number;
  next: { version: number; id: string } | null;
  events: BusinessAuditEvent[];
}
export interface ProjectBusinessAuditPage {
  projectId: string;
  next: { at: string; id: string } | null;
  events: (BusinessAuditEvent & {
    requirementId: string;
    requirementTitle: string;
  })[];
}

export const projectAccessAuditLabels = {
  'project.roles': '项目角色变更',
  'project.admin': '管理员席位变更',
} as const;
export interface ProjectAccessAuditCursor {
  at: string;
  actorId: string;
  kind: keyof typeof projectAccessAuditLabels;
  commandId: string;
}
export interface ProjectAccessAuditEvent extends Omit<
  ProjectAccessAuditCursor,
  'at'
> {
  recordedAt: string;
  actorName: string | null;
  targetId: string;
  targetName: string | null;
  beforeRoles: (typeof roles)[number][];
  afterRoles: (typeof roles)[number][];
}
export interface ProjectAccessAuditPage {
  projectId: string;
  next: ProjectAccessAuditCursor | null;
  events: ProjectAccessAuditEvent[];
}

export interface PlatformAccountAuditCursor {
  at: string;
  actorId: string;
  commandId: string;
}
export interface PlatformAccountAuditEvent extends Omit<
  PlatformAccountAuditCursor,
  'at'
> {
  recordedAt: string;
  actorName: string | null;
  targetId: string;
  targetName: string | null;
  beforeActive: boolean;
  afterActive: boolean;
}
export interface PlatformAccountAuditPage {
  next: PlatformAccountAuditCursor | null;
  events: PlatformAccountAuditEvent[];
}

export const RepositorySyncInput = Type.Object(
  { commandId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
export type RepositorySyncIssue =
  | 'credentials'
  | 'connection'
  | 'target'
  | 'signature'
  | 'history'
  | 'configuration_changed'
  | 'authorization'
  | 'storage'
  | 'timeout'
  | 'stopped';
export interface RepositorySyncResult {
  commandId: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  previousCommit?: string;
  candidateCommit?: string;
  targetCommit?: string;
  signerFingerprint?: string;
  issue?: RepositorySyncIssue;
}
export interface RepositorySummary {
  id: string;
  name: string;
  baselineRef: string;
  targetName: string;
  targetRef: string;
  publishedCommit?: string;
  stateIssue?: 'binding' | 'storage' | 'review_required';
  lastSync?: RepositorySyncResult;
}
export interface ProjectRepositories {
  canSync: boolean;
  repositories: RepositorySummary[];
}

const ManagementCommandId = Type.String({ format: 'uuid' });
const ManagedProjectId = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' });
const ManagedName = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: '\\S',
});
const ManagedUsername = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_.-]+$',
});
const MemberRole = Type.Union([
  Type.Literal('requirement_manager'),
  Type.Literal('developer'),
  Type.Literal('tester'),
]);
const CapabilityKind = Type.Union([
  Type.Literal('plugin'),
  Type.Literal('skill'),
  Type.Literal('mcp'),
]);
export type CapabilityKind = Static<typeof CapabilityKind>;
const CapabilityReference = Type.String({
  minLength: 3,
  maxLength: 160,
  pattern:
    '^@?[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)+$(?![\\s\\S])',
});
const CapabilityRevision = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:+-]*$(?![\\s\\S])',
});
const CapabilityVersion = Type.Object(
  {
    kind: CapabilityKind,
    reference: CapabilityReference,
    revision: CapabilityRevision,
  },
  { additionalProperties: false },
);
export type CapabilityVersion = Static<typeof CapabilityVersion>;
export function capabilityKey({
  kind,
  reference,
  revision,
}: CapabilityVersion) {
  return JSON.stringify([kind, reference, revision]);
}
export const ManagementCommand = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('project.create'),
      commandId: ManagementCommandId,
      projectId: ManagedProjectId,
      name: ManagedName,
      username: ManagedUsername,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('project.rename'),
      commandId: ManagementCommandId,
      projectId: ManagedProjectId,
      name: ManagedName,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('project.roles'),
      commandId: ManagementCommandId,
      projectId: ManagedProjectId,
      username: ManagedUsername,
      roles: Type.Array(MemberRole, { maxItems: 3, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('project.admin'),
      commandId: ManagementCommandId,
      projectId: ManagedProjectId,
      username: ManagedUsername,
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('account.active'),
      commandId: ManagementCommandId,
      username: ManagedUsername,
      active: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('capability.approval'),
      commandId: ManagementCommandId,
      capabilityKind: CapabilityKind,
      reference: CapabilityReference,
      revision: CapabilityRevision,
      approved: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('capability.template.save'),
      commandId: ManagementCommandId,
      projectId: ManagedProjectId,
      templateId: Type.Optional(Type.String({ format: 'uuid' })),
      expectedRevision: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 2147483646 }),
      ),
      name: ManagedName,
      description: Type.String({ maxLength: 1000 }),
      capabilities: Type.Array(CapabilityVersion, { maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
]);
export type ManagementCommand = Static<typeof ManagementCommand>;
export interface CapabilityApprovalList {
  approvals: {
    kind: CapabilityKind;
    reference: string;
    revision: string;
    approved: boolean;
  }[];
}
export interface CapabilityTemplateList {
  templates: {
    templateId: string;
    revision: number;
    name: string;
    description: string;
    capabilities: (CapabilityVersion & { approved: boolean })[];
  }[];
}
export interface CapabilityTemplateManagement extends CapabilityTemplateList {
  options: CapabilityVersion[];
}
export const TemplateBindingInput = Type.Object(
  {
    commandId: ManagementCommandId,
    templateId: Type.String({ format: 'uuid' }),
    revision: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  },
  { additionalProperties: false },
);
export type TemplateBindingInput = Static<typeof TemplateBindingInput>;
type TemplateVersion = Pick<TemplateBindingInput, 'templateId' | 'revision'>;
export interface RequirementTemplateBinding {
  binding: (TemplateVersion & { name: string; available: boolean }) | null;
  options?: (TemplateVersion & { name: string })[];
}
export type SessionTemplateStatus =
  | (TemplateVersion & { status: 'recorded'; name: string })
  | { status: 'unbound' | 'unavailable' };
export interface TemplateBindingReceipt {
  commandId: string;
  status: 'saved' | 'unchanged' | 'unavailable';
  before: TemplateVersion | null;
  after: TemplateVersion | null;
  replayed: boolean;
}
export interface ManagementAccount {
  username: string;
  name: string;
  active: boolean;
}
export interface ProjectAdministration {
  project: { id: string; name: string; nativeConfigured: boolean };
  members: (ManagementAccount & { roles: string[] })[];
}
export interface PlatformAdministration {
  projects: {
    id: string;
    name: string;
    nativeConfigured: boolean;
    admins: string[];
  }[];
  accounts: (ManagementAccount & { platformAdmin: boolean })[];
}
export interface ManagementResult {
  changed: boolean;
  replayed: boolean;
  revocation: 'confirmed' | 'lease-expiry' | 'none' | 'previously-recorded';
  template?: {
    status: 'saved' | 'unchanged' | 'conflict' | 'unavailable';
    templateId?: string;
    revision?: number;
  };
}
