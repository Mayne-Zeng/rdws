import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgSchema,
  check,
  bigint,
  text,
  timestamp,
  boolean,
  index,
  foreignKey,
  primaryKey,
  uniqueIndex,
  integer,
  jsonb,
  uuid,
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
export const projectModelAllowlist = pgTable(
  'project_model_allowlist',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    state: text('state', { enum: ['enabled', 'disabled'] }).notNull(),
    revision: uuid('revision').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.provider, t.model] }),
    check(
      'project_model_allowlist_reference',
      sql`char_length(${t.provider}) between 1 and 160 and char_length(${t.model}) between 1 and 160`,
    ),
    check(
      'project_model_allowlist_state',
      sql`${t.state} in ('enabled', 'disabled')`,
    ),
  ],
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
    background: text('background').notNull().default(''),
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
export const sessionModelSelection = pgTable(
  'session_model_selection',
  {
    nativeSessionId: text('native_session_id')
      .primaryKey()
      .references(() => nativeSession.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    revision: uuid('revision').notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      'session_model_selection_reference',
      sql`char_length(${t.provider}) between 1 and 160 and char_length(${t.model}) between 1 and 160`,
    ),
  ],
);
export const sessionPromptDispatch = pgTable(
  'session_prompt_dispatch',
  {
    nativeSessionId: text('native_session_id')
      .notNull()
      .references(() => nativeSession.id),
    requestId: text('request_id').notNull(),
    projectId: text('project_id').notNull(),
    requirementId: text('requirement_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    authSessionId: text('auth_session_id').notNull(),
    inputDigest: text('input_digest').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    selectionRevision: uuid('selection_revision').notNull(),
    state: text('state', { enum: ['reserved', 'pending', 'accepted'] })
      .default('reserved')
      .notNull(),
    hostGeneration: uuid('host_generation'),
    peerNonce: text('peer_nonce'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    acceptedSeq: bigint('accepted_seq', { mode: 'number' }),
    acceptedMessageId: text('accepted_message_id'),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.nativeSessionId, t.requestId] }),
    foreignKey({
      columns: [t.requirementId, t.projectId],
      foreignColumns: [requirement.id, requirement.projectId],
      name: 'session_prompt_dispatch_requirement_project_fk',
    }),
    check(
      'session_prompt_dispatch_input',
      sql`char_length(${t.requestId}) between 1 and 128 and
          ${t.inputDigest} ~ '^[a-f0-9]{64}$' and
          char_length(${t.provider}) between 1 and 160 and
          char_length(${t.model}) between 1 and 160`,
    ),
    check(
      'session_prompt_dispatch_ticket',
      sql`(${t.state} = 'reserved' and ${t.hostGeneration} is null and ${t.peerNonce} is null and ${t.leaseExpiresAt} is null)
          or (${t.state} in ('pending', 'accepted') and ${t.hostGeneration} is not null and
              ${t.peerNonce} is not null and char_length(${t.peerNonce}) between 1 and 128 and ${t.leaseExpiresAt} is not null)`,
    ),
    check(
      'session_prompt_dispatch_observation',
      sql`(${t.state} in ('reserved', 'pending') and ${t.acceptedSeq} is null and ${t.acceptedMessageId} is null)
          or (${t.state} = 'accepted' and ${t.acceptedSeq} is not null and ${t.acceptedSeq} between 0 and 9007199254740991 and
              ${t.acceptedMessageId} is not null and char_length(${t.acceptedMessageId}) between 1 and 128)`,
    ),
  ],
);
export const sessionModelFirstWrite = pgTable(
  'session_model_first_write',
  {
    projectId: text('project_id').notNull(),
    requirementId: text('requirement_id').notNull(),
    nativeSessionId: text('native_session_id').notNull(),
    selectionRequestId: text('selection_request_id').notNull(),
    selectionRevision: uuid('selection_revision').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    hostGeneration: uuid('host_generation').notNull(),
    agentGeneration: uuid('agent_generation').notNull(),
    bindingId: uuid('binding_id').notNull(),
    callId: uuid('call_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    turn: integer('turn').notNull(),
    step: integer('step').notNull(),
    stepSeq: bigint('step_seq', { mode: 'number' }).notNull(),
    noteSeq: bigint('note_seq', { mode: 'number' }).notNull(),
    state: text('state', { enum: ['prepared', 'submitted'] })
      .notNull()
      .default('prepared'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.hostGeneration, t.attemptId] }),
    foreignKey({
      columns: [t.nativeSessionId, t.selectionRequestId],
      foreignColumns: [
        sessionPromptDispatch.nativeSessionId,
        sessionPromptDispatch.requestId,
      ],
      name: 'session_model_first_write_dispatch_fk',
    }),
    check(
      'session_model_first_write_coordinates',
      sql`${t.turn} > 0 and ${t.step} > 0 and ${t.stepSeq} >= 0 and
          ${t.noteSeq} > ${t.stepSeq} and ${t.noteSeq} <= 9007199254740991`,
    ),
    check(
      'session_model_first_write_state',
      sql`(${t.state} = 'prepared' and ${t.submittedAt} is null) or
          (${t.state} = 'submitted' and ${t.submittedAt} is not null)`,
    ),
  ],
);
export const requirementWriteLease = pgTable(
  'requirement_write_lease',
  {
    requirementId: text('requirement_id').primaryKey(),
    projectId: text('project_id').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id),
    authSessionId: text('auth_session_id').notNull(),
    nativeSessionId: text('native_session_id')
      .notNull()
      .references(() => nativeSession.id),
    generation: uuid('generation').notNull(),
    phase: text('phase', { enum: ['held', 'draining', 'released'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    contextVersion: integer('context_version').notNull(),
    runId: uuid('run_id'),
    takeover: jsonb('takeover').$type<{
      userId: string;
      authSessionId: string;
      sessionId: string;
      commandId: string;
    }>(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.requirementId, t.projectId],
      foreignColumns: [requirement.id, requirement.projectId],
    }),
    check(
      'requirement_write_lease_phase',
      sql`${t.phase} in ('held', 'draining', 'released') and (${t.phase} <> 'released' or ${t.runId} is null) and (${t.takeover} is null or ${t.phase} = 'draining')`,
    ),
  ],
);
export const audit = pgSchema('audit');
export const authority = pgSchema('rdws_authority');
export const authorityOwner = authority.table(
  'owner',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    managed: boolean('managed').notNull().default(false),
    ticketDigest: text('ticket_digest'),
    proofDigest: text('proof_digest'),
    generation: uuid('generation'),
  },
  (table) => [
    check('authority_owner_singleton', sql`${table.singleton}`),
    check(
      'authority_owner_state',
      sql`(${table.generation} IS NULL) = (${table.proofDigest} IS NULL)
        AND (${table.generation} IS NULL OR ${table.ticketDigest} IS NULL)
        AND (${table.managed} OR (${table.generation} IS NULL AND ${table.ticketDigest} IS NULL))`,
    ),
    check(
      'authority_owner_ticket_digest',
      sql`${table.ticketDigest} COLLATE "C" ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'authority_owner_proof_digest',
      sql`${table.proofDigest} COLLATE "C" ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
export const sessionLogAnchor = audit.table(
  'session_log_anchor',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => nativeSession.id),
    bucketSha256: text('bucket_sha256').notNull(),
    journalName: text('journal_name').notNull(),
    throughByte: bigint('through_byte', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: 'session_log_anchor_key',
      columns: [
        t.projectId,
        t.sessionId,
        t.bucketSha256,
        t.journalName,
        t.throughByte,
      ],
    }),
    check(
      'session_log_anchor_project',
      sql`${t.projectId} collate "C" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
    ),
    check(
      'session_log_anchor_session',
      sql`${t.sessionId} collate "C" ~ '^session-[a-zA-Z0-9-]{1,120}$'`,
    ),
    check(
      'session_log_anchor_digest',
      sql`${t.sha256} collate "C" ~ '^[a-f0-9]{64}$' and ${t.bucketSha256} collate "C" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'session_log_anchor_cutoff',
      sql`${t.throughByte} between 1 and 9007199254740991`,
    ),
    check(
      'session_log_anchor_generation',
      sql`${t.journalName} collate "C" ~ '^session([.]v[1-9][0-9]{0,15})?[.]jsonl([.]zstd)?$'
        and coalesce(substring(${t.journalName} from '^session[.]v([1-9][0-9]{0,15})[.]jsonl')::numeric, 0) <= 9007199254740991`,
    ),
  ],
);
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

// §11.23 S1: the immutable historical candidate of one controlled commit.
// Append-only: the application role loses UPDATE and DELETE in the
// db-migrate guard, so corrections are new rows that reference the
// original, never rewrites.
export const requirementDeliverySnapshot = pgTable(
  'requirement_delivery_snapshot',
  {
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirement.id),
    repositoryId: text('repository_id').notNull(),
    snapshotSeq: integer('snapshot_seq').notNull(),
    commitHash: text('commit_hash').notNull(),
    parentHead: text('parent_head').notNull(),
    baseCommit: text('base_commit').notNull(),
    paths: jsonb('paths')
      .$type<
        {
          path: string;
          type: string;
          digest: string | null;
        }[]
      >()
      .notNull(),
    contentDigest: text('content_digest').notNull(),
    messageSha256: text('message_sha256').notNull(),
    commandId: text('command_id').notNull(),
    committedBy: text('committed_by')
      .notNull()
      .references(() => user.id),
    generation: uuid('generation').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.requirementId, t.repositoryId, t.snapshotSeq],
    }),
    // 原键回查: one commit of one repository lands exactly one snapshot.
    uniqueIndex('requirement_delivery_snapshot_commit_idx').on(
      t.repositoryId,
      t.commitHash,
    ),
    index('requirement_delivery_snapshot_requirement_idx').on(t.requirementId),
    check(
      'requirement_delivery_snapshot_hashes',
      sql`${t.commitHash} collate "C" ~ '^[0-9a-f]{40}$' and
          ${t.parentHead} collate "C" ~ '^[0-9a-f]{40}$' and
          ${t.baseCommit} collate "C" ~ '^[0-9a-f]{40}$' and
          ${t.contentDigest} collate "C" ~ '^[a-f0-9]{64}$' and
          ${t.messageSha256} collate "C" ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'requirement_delivery_snapshot_paths',
      sql`jsonb_typeof(${t.paths}) = 'array' and jsonb_array_length(${t.paths}) between 1 and 512`,
    ),
  ],
);
// §11.23 S1: the recorded merge outcome of one snapshot. Empty until T09;
// append-only like the snapshot.
export const requirementDeliveryMerge = pgTable(
  'requirement_delivery_merge',
  {
    requirementId: text('requirement_id').notNull(),
    repositoryId: text('repository_id').notNull(),
    snapshotSeq: integer('snapshot_seq').notNull(),
    environment: text('environment').notNull(),
    cherryPickCommit: text('cherry_pick_commit').notNull(),
    mergeCommit: text('merge_commit'),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.requirementId, t.repositoryId, t.snapshotSeq, t.environment],
    }),
    foreignKey({
      name: 'requirement_delivery_merge_snapshot_fk',
      columns: [t.requirementId, t.repositoryId, t.snapshotSeq],
      foreignColumns: [
        requirementDeliverySnapshot.requirementId,
        requirementDeliverySnapshot.repositoryId,
        requirementDeliverySnapshot.snapshotSeq,
      ],
    }),
    check(
      'requirement_delivery_merge_hashes',
      sql`${t.cherryPickCommit} collate "C" ~ '^[0-9a-f]{40}$'
          and (${t.mergeCommit} is null or ${t.mergeCommit} collate "C" ~ '^[0-9a-f]{40}$')`,
    ),
    check(
      'requirement_delivery_merge_environment',
      sql`char_length(${t.environment}) between 1 and 64`,
    ),
  ],
);
