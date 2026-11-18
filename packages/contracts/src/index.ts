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
    source: string;
    version: number;
    taskId: string | null;
    before: unknown;
    after: unknown;
    createdAt: string;
  }[];
  permissions: {
    canManageTasks: boolean;
    canChangeStage: boolean;
    canUpdateOwnTasks: boolean;
    userId: string;
    codeWrite: false;
  };
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
