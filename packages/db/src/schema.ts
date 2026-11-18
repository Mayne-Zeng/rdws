import { sql } from 'drizzle-orm';
import {
  pgTable,
  check,
  text,
  timestamp,
  boolean,
  index,
  foreignKey,
  primaryKey,
  uniqueIndex,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
};
export const user = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  active: boolean('active').default(true).notNull(),
  authEpoch: integer('auth_epoch').default(0).notNull(),
  platformAdmin: boolean('platform_admin').default(false).notNull(),
  ...timestamps,
});
export const session = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    authEpoch: integer('auth_epoch').default(0).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [index('auth_session_user_idx').on(t.userId)],
);
export const account = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('auth_account_provider_idx').on(t.providerId, t.accountId),
  ],
);
export const verification = pgTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
});
export const project = pgTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...timestamps,
});
export const projectMember = pgTable(
  'project_member',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId, t.role] })],
);

export const requirement = pgTable(
  'requirement',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    acceptance: text('acceptance').notNull(),
    leadId: text('lead_id')
      .notNull()
      .references(() => user.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    nativeWorkspaceId: text('native_workspace_id'),
    stage: text('stage').notNull().default('assignment'),
    contextVersion: integer('context_version').notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex('requirement_id_project_idx').on(t.id, t.projectId)],
);
export const requirementParticipant = pgTable(
  'requirement_participant',
  {
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirement.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.requirementId, t.userId, t.role] })],
);
export const requirementWorktreePlan = pgTable(
  'requirement_worktree_plan',
  {
    requirementId: text('requirement_id')
      .primaryKey()
      .references(() => requirement.id),
    repositories: jsonb('repositories')
      .$type<
        {
          repositoryId: string;
          baseCommit: string;
          baselineRef: string;
          sourceBinding: string;
          branch: string;
          worktreePath: string;
          gitStorePath: string;
        }[]
      >()
      .notNull(),
  },
  (t) => [
    check(
      'requirement_worktree_plan_repositories',
      sql`jsonb_typeof(${t.repositories}) = 'array' and jsonb_array_length(${t.repositories}) between 1 and 16`,
    ),
  ],
);
export const nativeSession = pgTable('native_session', {
  id: text('id').primaryKey(),
  requirementId: text('requirement_id')
    .notNull()
    .references(() => requirement.id),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id),
  sourceSessionId: text('source_session_id'),
  sourceThroughSeq: integer('source_through_seq'),
  ...timestamps,
});
export const sessionOperation = pgTable(
  'session_operation',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirement.id),
    operation: text('operation').notNull(),
    commandId: text('command_id').notNull(),
    digest: text('digest').notNull(),
    status: text('status').notNull().default('reserved'),
    generation: text('generation'),
    sourceSessionId: text('source_session_id'),
    frozen: jsonb('frozen').$type<{
      workspaceId: string;
      cwd: string;
      atSeq?: number;
      requestDigest?: string;
      dispatchVersion?: 1;
      agentPreset?: string | null;
      rejection?: 'preset-unavailable' | 'preset-unapproved' | 'preset-paused';
    }>(),
    nativeSessionId: text('native_session_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('session_operation_command_idx').on(
      t.actorId,
      t.requirementId,
      t.operation,
      t.commandId,
    ),
  ],
);
export const task = pgTable(
  'task',
  {
    id: text('id').primaryKey(),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirement.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    acceptance: text('acceptance').notNull().default(''),
    assigneeId: text('assignee_id')
      .notNull()
      .references(() => user.id),
    status: text('status').notNull().default('todo'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (t) => [index('task_requirement_idx').on(t.requirementId)],
);
export const requirementEvent = pgTable(
  'requirement_event',
  {
    id: text('id').primaryKey(),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirement.id),
    taskId: text('task_id'),
    kind: text('kind').notNull(),
    actorId: text('actor_id').notNull(),
    source: text('source').notNull(),
    commandId: text('command_id').notNull(),
    version: integer('version').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('requirement_event_scope_idx').on(t.requirementId, t.version)],
);
export const commandReceipt = pgTable(
  'command_receipt',
  {
    actorId: text('actor_id').notNull(),
    scope: text('scope').notNull(),
    operation: text('operation').notNull(),
    commandId: text('command_id').notNull(),
    digest: text('digest').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.scope, t.operation, t.commandId] }),
  ],
);
export const capabilityApproval = pgTable(
  'capability_approval',
  {
    kind: text('kind', { enum: ['plugin', 'skill', 'mcp'] }).notNull(),
    reference: text('reference').notNull(),
    revision: text('revision').notNull(),
    approved: boolean('approved').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.reference, t.revision] }),
    check(
      'capability_approval_kind',
      sql`${t.kind} in ('plugin', 'skill', 'mcp')`,
    ),
    check(
      'capability_approval_reference',
      sql`char_length(${t.reference}) <= 160 and ${t.reference} ~ '^@?[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)+$'`,
    ),
    check(
      'capability_approval_revision',
      sql`char_length(${t.revision}) <= 128 and ${t.revision} ~ '^[A-Za-z0-9][A-Za-z0-9._:+-]*$'`,
    ),
  ],
);
export const capabilityTemplateRevision = pgTable(
  'capability_template_revision',
  {
    templateId: text('template_id').notNull(),
    revision: integer('revision').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    capabilities: jsonb('capabilities')
      .$type<
        {
          kind: 'plugin' | 'skill' | 'mcp';
          reference: string;
          revision: string;
        }[]
      >()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.revision] }),
    uniqueIndex('capability_template_revision_project_idx').on(
      t.projectId,
      t.templateId,
      t.revision,
    ),
    check('capability_template_revision_number', sql`${t.revision} > 0`),
    check(
      'capability_template_revision_name',
      sql`char_length(${t.name}) between 1 and 80`,
    ),
    check(
      'capability_template_revision_description',
      sql`char_length(${t.description}) <= 1000`,
    ),
    check(
      'capability_template_revision_choices',
      sql`jsonb_typeof(${t.capabilities}) = 'array' and jsonb_array_length(${t.capabilities}) <= 64`,
    ),
  ],
);

export const requirementCapabilityBinding = pgTable(
  'requirement_capability_binding',
  {
    requirementId: text('requirement_id').primaryKey(),
    projectId: text('project_id').notNull(),
    templateId: text('template_id').notNull(),
    revision: integer('revision').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'requirement_capability_binding_demand_fk',
      columns: [t.requirementId, t.projectId],
      foreignColumns: [requirement.id, requirement.projectId],
    }),
    foreignKey({
      name: 'requirement_capability_binding_template_fk',
      columns: [t.projectId, t.templateId, t.revision],
      foreignColumns: [
        capabilityTemplateRevision.projectId,
        capabilityTemplateRevision.templateId,
        capabilityTemplateRevision.revision,
      ],
    }),
  ],
);
