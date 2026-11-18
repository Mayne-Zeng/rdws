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
