import { randomUUID } from 'node:crypto';
import { bodyHash, isRecord, onlyKeys, type Grant } from '@rdws/dsh/access';
import type {
  ModelCarrierRequest,
  ModelWireCommit,
  ModelWireOutcome,
} from '@rdws/dsh/web';
import {
  readReplyLimit,
  readToolArguments,
  readToolName,
} from '@rdws/dsh/read-tool-arguments';
import {
  writePermitEnvelopeBytes,
  writePermitEnvelopeLimit,
  writeToolArguments,
  writeToolNames,
  type WriteToolName,
} from '@rdws/dsh/write-tool-arguments';
import {
  writeToolOperations,
  type NativeWriteToolJob,
  type WriteFileRequest,
} from './native-write-tool-job.ts';
import type {
  NativeShellToolJob,
  ShellRequest,
} from './native-shell-tool-job.ts';
import {
  businessError,
  digestOf,
  type Actor,
  type createBusiness,
} from './business.ts';
import {
  fixtureToolOperations,
  type NativeFixtureToolJob,
} from './native-fixture-tool-job.ts';
import type { WriteHandoffScope } from './write-handoff.ts';
import type { OutputPolicy } from './shell-output-handling.ts';
import {
  conservativeRedaction,
  toolDefinitions,
  type FixtureToolProjection,
  type ReadToolProjection,
  type ToolDefinition,
  type WriteToolProjection,
} from './model-egress-policy.ts';
import type {
  ModelFirstWrite,
  ModelFirstWriteReceipts,
} from './model-first-write.ts';
import type { AttachmentManifest } from './model-attachment-egress.ts';
import { readWorkingDirectoryEdits } from './model-attachment-evidence.ts';
import type {
  PromptDispatch,
  SessionModelPilot,
} from './session-model-selection.ts';
type Detail = Awaited<ReturnType<ReturnType<typeof createBusiness>['read']>>;
export function contextSnapshot(data: Detail) {
  const r = data.requirement;
  const maxBytes = 24_000;
  const requirementView =
    '/?project=' +
    encodeURIComponent(r.projectId) +
    '&requirement=' +
    encodeURIComponent(r.id);
  const firstBackgroundCharacter =
    r.background[Symbol.iterator]().next().value ?? '';
  const summarizedFields = {
    description: r.description.length > 1500,
    acceptance: r.acceptance.length > 1500,
    background: false,
    tasks: false,
    participants: data.participants.some((p) => p.name.length > 40),
  };
  const snapshot = {
    requirementId: r.id,
    title: r.title,
    description: r.description.slice(0, 1500),
    acceptance: r.acceptance.slice(0, 1500),
    background: firstBackgroundCharacter,
    stage: r.stage,
    leadId: r.leadId,
    contextVersion: r.contextVersion,
    permissions: {
      canManageTasks: data.permissions.canManageTasks,
      canChangeStage: data.permissions.canChangeStage,
      canUpdateOwnTasks: data.permissions.canUpdateOwnTasks,
      userId: data.permissions.userId,
      codeWrite: data.permissions.codeWrite,
    },
    participants: data.participants
      .map((p) => ({
        id: p.id,
        name: p.name.slice(0, 40),
        active: p.active,
        eligibleDeveloper: p.eligibleDeveloper,
        roles: p.roles,
      }))
      .sort(
        (a, b) =>
          Number([r.leadId, data.permissions.userId].includes(b.id)) -
          Number([r.leadId, data.permissions.userId].includes(a.id)),
      ),
    tasks: data.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assigneeId: t.assigneeId,
    })),
    recentChanges: data.events
      .slice(0, 5)
      .map((e) => ({ kind: e.kind, version: e.version, actorId: e.actorId })),
    summarizedFields,
    truncated: Object.values(summarizedFields).some(Boolean),
    totalTasks: data.tasks.length,
    fullView: requirementView + '&view=overview',
    ...(r.background && { backgroundView: requirementView + '&view=context' }),
  };
  while (
    Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes &&
    snapshot.tasks.length
  ) {
    snapshot.tasks.pop();
    summarizedFields.tasks = true;
    snapshot.truncated = true;
  }
  while (
    Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes &&
    snapshot.participants.length > 2
  ) {
    snapshot.participants.pop();
    summarizedFields.participants = true;
    snapshot.truncated = true;
  }
  let available = maxBytes - Buffer.byteLength(JSON.stringify(snapshot));
  if (available < 0) businessError(503, '当前上下文过大，请精简需求说明后重试');
  let characters = Number(firstBackgroundCharacter !== '');
  for (const character of r.background.slice(firstBackgroundCharacter.length)) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (characters === 1500 || bytes > available) break;
    snapshot.background += character;
    available -= bytes;
    characters++;
  }
  summarizedFields.background = snapshot.background !== r.background;
  snapshot.truncated ||= summarizedFields.background;
  return { snapshot, digest: digestOf(snapshot) };
}
export interface RunBinding {
  runId: string;
  hostGeneration: string;
  requirementId: string;
  sessionId: string;
  requestId: string;
  peerNonce: string;
}
type Run = RunBinding & {
  who: Actor;
  expiresAt: number;
  agentGeneration?: string;
  turn?: number;
  submitted?: boolean;
  titleCancelled?: true;
  dispatch?: PromptDispatch;
};
type EffectiveModel = {
  provider: string;
  model: string;
  revision: string;
  routes: Readonly<Record<string, string>>;
  isCurrent(): boolean;
};
type PilotAuthority = SessionModelPilot & {
  destination: string;
  isCurrent(): boolean;
  firstWrites: ModelFirstWriteReceipts;
  lock<T>(
    dispatch: readonly PromptDispatch[],
    write: (validBefore: number) => T,
    sourceThroughSeq: number | null,
  ): Promise<T>;
};
type StepMarker = {
  sequence: number;
  step: number;
  noteId: string;
  provider: string;
  model: string;
};
type FirstWriteCoordinates = {
  stepSeq: number;
  noteSeq: number;
  sourceThroughSeq: number | null;
};
type ModelStep = {
  id: string;
  stamp: StepMarker;
  batch: Run[];
  agentGeneration: string;
  turn: number;
  closed: boolean;
  selection?: EffectiveModel;
  selectingDispatch?: PromptDispatch;
  firstWriteCoordinates?: Map<string, FirstWriteCoordinates>;
  validBefore?: number;
  contextVersion?: number;
  fixtureToolUsed?: true;
  readToolUsed?: true;
  writeToolUsed?: true;
  fixtureToolJob?: NativeFixtureToolJob;
  writeToolJob?: NativeWriteToolJob | NativeShellToolJob;
  fixtureWire?: FixtureWire;
  attempts: Set<string>;
  wireAttempt?: string;
  attachmentCalls?: Set<string>;
  attachment?: {
    callId: string;
    grant: string;
    validBefore: number;
    manifest: AttachmentManifest;
    previousRoutes?: { files: string; messages: string };
  };
};
type FixtureWire = {
  job: NativeFixtureToolJob;
  projection: FixtureToolProjection;
};
type ModelAttempt = Pick<
  ModelCarrierRequest,
  'routeId' | 'destination' | 'attemptId' | 'call' | 'signal' | 'isCurrent'
>;
type TitleOrigin = {
  bindingId: string;
  run: Run;
  sourceSeq: number;
  sourceId: string;
  expiresAt: number;
  phase: 'candidate' | 'prepared' | 'attempted' | 'closed';
  callId?: string;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const attachmentRoutes = new Set(['files', 'messages']);
const imageDigest = /^[a-f0-9]{64}$/;
const attachmentId = /^sha256:[a-f0-9]{64}$/;
const maxAttachmentCalls = 16;
const maxAttachmentOccurrences = 64;
const invalidModel = () => businessError(403, '当前模型尝试未获授权');
function parseStepMarker(input: unknown): StepMarker {
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const named = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 160;
  if (
    !isRecord(input) ||
    !positive(input.sequence) ||
    !positive(input.step) ||
    typeof input.noteId !== 'string' ||
    !uuid.test(input.noteId) ||
    !named(input.provider) ||
    !named(input.model)
  )
    return invalidModel();
  return {
    sequence: input.sequence,
    step: input.step,
    noteId: input.noteId,
    provider: input.provider,
    model: input.model,
  };
}
// §11.20.26 Read argument shape, shared by the permit and the FD4 body
// policy.
export { readLimit as readToolLimit } from '@rdws/dsh/read-tool-arguments';
// FD3 read service operations of hop 4: one metadata request per file, one
// page request per page, and the long-line segment registration.
const readToolOperations = [
  'worktree-stat',
  'worktree-read',
  'read-segment-register',
] as const;
export type ReadToolOperation = (typeof readToolOperations)[number];
export type ReadToolBinding = {
  run: RunBinding;
  // Project of the armed run; the read scope is derived here from the signed
  // run binding, the login and the own session.
  projectId: string;
  // Registered long-line segments of the original run, login and own
  // session; a segment path is accepted only when this confirms it.
  segment?: (input: Record<string, unknown>, segment: string) => boolean;
  // The trusted parent read. Repository, path and cursor are the only
  // variable fields the caller supplies.
  service?: (
    operation: ReadToolOperation,
    scope: WriteHandoffScope,
    input: Record<string, unknown>,
    // The FD3 request deadline: never later than the step, the login and
    // the permit; and whether the run is still current (cancel, release).
    expiresAt: number,
    live: () => boolean,
  ) => Promise<unknown>;
};
// The FD3 reply cap (shared with the read service, which judges it before a
// page leaves) is the backstop here.
const readBindingFields = [
  'runId',
  'hostGeneration',
  'requirementId',
  'sessionId',
  'requestId',
  'peerNonce',
  'authSessionId',
];
const readVariableFields: Record<ReadToolOperation, string[]> = {
  'worktree-stat': ['path'],
  'worktree-read': ['cursor'],
  'read-segment-register': ['snapshotId', 'line', 'prefix'],
};
export function readToolPermitArguments(
  input: Record<string, unknown>,
  segment?: ReadToolBinding['segment'],
): boolean {
  // The frozen-arguments check belongs to the Host probe, before the body
  // is signed; the parent judges the received shape exactly.
  return (
    isRecord(input.arguments) && readToolArguments(input.arguments, segment)
  );
}

// §11.20.27 write binding of one armed run (hop 3 and 4): the scope is
// re-derived from the signed run binding like the read binding; the write
// generation comes from the Broker's confirmed holding of the own session.
export type WriteToolBinding = {
  run: RunBinding;
  projectId: string;
  repositoryId: string;
  // The tools this run declared; a call of any other name is not permitted.
  tools: readonly WriteToolName[];
  holding: () =>
    | { generation: string; contextVersion: number; expiresAt: number }
    | undefined;
  // Throws when the generation is no longer the confirmed holding.
  assertLease: () => void;
  // Whether the command is the one registered for the generation and the
  // requirement tree's package.json still has the registered digest. The
  // read is bounded by the permit request (its signal and liveness).
  registered: (
    command: string,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  // Whether the command is the one registered for the generation right
  // now, without a read: the FD4 projection judges history with it.
  registeredCommand?: (command: string) => boolean;
  // The prefix policy of the output handling, once the locations are known
  // (the FD4 backstop scan of tool results).
  redaction?: () => OutputPolicy | undefined;
  // Counts a redaction the FD4 backstop had to make (must stay zero), and
  // reads the count back.
  countRedaction?: () => void;
  redactionCount?: () => number;
  job: (
    request: WriteFileRequest,
    generation: { generation: string; contextVersion: number },
  ) => NativeWriteToolJob;
  // The Shell and Git job of a permitted call (B segment).
  shell?: (
    request: ShellRequest,
    generation: { generation: string; contextVersion: number },
  ) => NativeShellToolJob;
};
// The Broker execution request of a permitted write tool call: the file
// tools, the test file of a registered Shell command, or the fixed Git query.
export function writeToolRequest(
  toolName: WriteToolName,
  args: Record<string, unknown>,
): WriteFileRequest | ShellRequest | undefined {
  if (toolName === 'write')
    return {
      tool: 'file',
      operation: 'write',
      path: String(args.file_path),
      text: String(args.content),
      receipt: true,
    };
  if (toolName === 'edit')
    return {
      tool: 'file',
      operation: 'edit',
      path: String(args.file_path),
      old_string: String(args.old_string),
      new_string: String(args.new_string),
      replace_all: args.replace_all === true,
    };
  if (toolName === 'bash')
    // The only form: node <name>.test.mjs, so the file is the rest.
    return { tool: 'test', path: String(args.command).slice('node '.length) };
  if (toolName === 'git')
    return {
      tool: 'git',
      operation: args.operation as 'status' | 'diff',
    };
  return undefined;
}

export class ContextRuns {
  private runs = new Map<string, Run>();
  // The Read binding of the armed run, remembered from its first FD3 request.
  private readArmed = new Map<string, ReadToolBinding>();
  // §11.20.27: the write bindings of the armed runs and the definitions the
  // Host registered for them (the FD4 projection compares word for word).
  private writeArmed = new Map<string, WriteToolBinding>();
  private writeDefinitions = new Map<string, ToolDefinition[]>();
  // What a session that ever held the write tools keeps after its armed
  // runs are gone: the read definition (the declared set of a run without
  // the write generation is read alone) and the output policy, so a later
  // run of that session can still project the exchanges of its history.
  private sessionTools = new Map<
    string,
    {
      read?: ToolDefinition;
      redaction?: () => OutputPolicy | undefined;
      countRedaction?: () => void;
      redactionCount?: () => number;
    }
  >();
  private nonces = new Map<string, number>();
  private modelSteps = new Map<string, ModelStep>();
  private titles = new Map<string, TitleOrigin>();
  constructor(
    readonly generation: string,
    private verify: (token: unknown) => Grant | undefined,
    private read: (
      who: Actor,
      id: string,
      sessionId: string,
      relatedActors?: Actor[],
    ) => Promise<{ value: unknown; validBefore: number }>,
    private closing: (
      authSessionId: string,
      userId: string,
      requirementId: string,
    ) => boolean,
    private selectModel?: (
      who: Actor,
      requirementId: string,
      sessionId: string,
    ) => Promise<EffectiveModel | undefined>,
    private lockModelAuthority?: <T>(
      who: Actor,
      requirementId: string,
      sessionId: string,
      relatedActors: Actor[],
      write: (validBefore: number) => T,
      writeLease?: NonNullable<NativeFixtureToolJob['wireLease']>,
    ) => Promise<T>,
    private allowTitles = false,
    private attachmentPolicy?: Pick<
      AttachmentManifest,
      'projectId' | 'credentialGeneration'
    >,
    private modelPilot?: PilotAuthority,
  ) {
    if (attachmentPolicy)
      this.attachmentPolicy = Object.freeze({ ...attachmentPolicy });
  }
  admit(
    who: Actor,
    requirementId: string,
    sessionId: string,
    requestId: string,
    peerNonce: string,
    dispatch?: PromptDispatch,
  ): RunBinding {
    if (
      this.closing(who.authSessionId, who.userId, requirementId) ||
      !requestId ||
      requestId.length > 128
    )
      businessError(403, '当前运行身份无效');
    if (
      !!this.modelPilot !== !!dispatch ||
      (dispatch &&
        (dispatch.state !== 'pending' ||
          dispatch.hostGeneration !== this.generation ||
          dispatch.nativeSessionId !== sessionId ||
          dispatch.requestId !== requestId ||
          dispatch.requirementId !== requirementId ||
          dispatch.projectId !== this.modelPilot?.projectId ||
          dispatch.actorId !== who.userId ||
          dispatch.authSessionId !== who.authSessionId ||
          dispatch.peerNonce !== peerNonce ||
          (dispatch.leaseExpiresAt?.getTime() ?? 0) <= Date.now()))
    )
      return invalidModel();
    const now = Date.now();
    for (const [id, run] of this.runs)
      if (run.expiresAt <= now) this.discard(id);
    const old = [...this.runs.values()].find(
      (r) => r.sessionId === sessionId && r.requestId === requestId,
    );
    if (old) {
      if (
        old.who.authSessionId !== who.authSessionId ||
        old.peerNonce !== peerNonce ||
        old.requirementId !== requirementId
      )
        businessError(409, '该消息已由其他运行受理');
      return this.binding(old);
    }
    if (this.runs.size >= 512)
      businessError(429, '当前排队会话较多，请稍后重试');
    const run: Run = {
      runId: randomUUID(),
      hostGeneration: this.generation,
      requirementId,
      sessionId,
      requestId,
      peerNonce,
      who,
      expiresAt: now + 30 * 60 * 1000,
      dispatch,
    };
    this.runs.set(run.runId, run);
    return this.binding(run);
  }
  private binding(run: Run): RunBinding {
    return {
      runId: run.runId,
      hostGeneration: run.hostGeneration,
      requirementId: run.requirementId,
      sessionId: run.sessionId,
      requestId: run.requestId,
      peerNonce: run.peerNonce,
    };
  }
  revoke(authSessionId: string, requirementId?: string) {
    for (const title of this.titles.values()) {
      const { run } = title;
      if (
        run.who.authSessionId === authSessionId &&
        (!requirementId || run.requirementId === requirementId)
      )
        title.phase = 'closed';
    }
    for (const [id, r] of this.runs)
      if (
        r.who.authSessionId === authSessionId &&
        (!requirementId || r.requirementId === requirementId)
      )
        this.discard(id);
  }
  revokeUser(userId: string, requirementId?: string) {
    for (const title of this.titles.values()) {
      const { run } = title;
      if (
        run.who.userId === userId &&
        (!requirementId || run.requirementId === requirementId)
      )
        title.phase = 'closed';
    }
    for (const [id, r] of this.runs)
      if (
        r.who.userId === userId &&
        (!requirementId || r.requirementId === requirementId)
      )
        this.discard(id);
  }
  clear() {
    for (const step of this.modelSteps.values()) {
      step.fixtureToolJob?.cancel();
      step.writeToolJob?.cancel();
    }
    this.runs.clear();
    this.nonces.clear();
    this.modelSteps.clear();
    this.titles.clear();
    // §11.20.27: the armed-run tables go with the runs they named.
    this.readArmed.clear();
    this.writeArmed.clear();
    this.writeDefinitions.clear();
    this.sessionTools.clear();
  }
  cancelTitle(sessionId: string) {
    for (const run of this.runs.values())
      if (run.sessionId === sessionId) run.titleCancelled = true;
    const origin = this.titles.get(sessionId);
    if (origin) origin.phase = 'closed';
  }
  discard(runId: string, normal = false) {
    if (!normal)
      for (const origin of this.titles.values())
        if (origin.run.runId === runId) origin.phase = 'closed';
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    // §11.20.27: an armed run that is discarded releases its bindings; the
    // session keeps only what its history needs (the tool projection).
    this.readArmed.delete(runId);
    this.writeArmed.delete(runId);
    this.writeDefinitions.delete(runId);
    if (!run) return;
    const step = this.modelSteps.get(run.sessionId);
    if (step?.batch.includes(run)) {
      step.closed = true;
      step.fixtureToolJob?.cancel();
      step.writeToolJob?.cancel();
      step.attachment = undefined;
      if (step.batch.every((member) => this.runs.get(member.runId) !== member))
        this.modelSteps.delete(run.sessionId);
    }
  }
  submitted(runId: string) {
    const run = this.runs.get(runId);
    if (run) run.submitted = true;
  }
  submittedIds() {
    return [...this.runs.values()]
      .filter((r) => r.submitted)
      .map((r) => r.runId);
  }
  reconcile(candidates: string[], active: ReadonlySet<string>) {
    const retired: string[] = [];
    for (const id of candidates) {
      if (!active.has(id) && this.runs.get(id)?.submitted) {
        this.discard(id);
        retired.push(id);
      }
    }
    return retired;
  }
  async authorizeImageIntake(
    who: Actor,
    projectId: string,
    requirementId: string,
    sessionId: string,
  ) {
    if (
      this.attachmentPolicy?.projectId !== projectId ||
      !this.lockModelAuthority ||
      this.closing(who.authSessionId, who.userId, requirementId)
    )
      return invalidModel();
    const { validBefore } = await this.read(who, requirementId, sessionId);
    if (
      !Number.isFinite(validBefore) ||
      validBefore <= Date.now() ||
      this.closing(who.authSessionId, who.userId, requirementId)
    )
      return invalidModel();
    return validBefore;
  }
  async authorizePreviousImage(
    who: Actor,
    projectId: string,
    requirementId: string,
    sessionId: string,
  ) {
    const validBefore = await this.authorizeImageIntake(
      who,
      projectId,
      requirementId,
      sessionId,
    );
    const selection = await this.selectModel?.(who, requirementId, sessionId);
    if (
      !selection?.isCurrent() ||
      !selection.routes.files ||
      !selection.routes.messages ||
      !this.attachmentPolicy?.credentialGeneration ||
      validBefore <= Date.now() ||
      this.closing(who.authSessionId, who.userId, requirementId)
    )
      return invalidModel();
    return {
      validBefore,
      target: {
        provider: selection.provider,
        model: selection.model,
        routes: {
          files: selection.routes.files,
          messages: selection.routes.messages,
        },
        credentialGeneration: this.attachmentPolicy.credentialGeneration,
      },
    };
  }
  private current(batch: readonly Run[]) {
    const now = Date.now();
    return batch.every(
      (run) =>
        this.runs.get(run.runId) === run &&
        run.expiresAt > now &&
        !this.closing(run.who.authSessionId, run.who.userId, run.requirementId),
    );
  }
  attachmentManifestFor(request: ModelAttempt): AttachmentManifest | undefined {
    const { routeId, destination, call, signal } = request;
    const step = call.sessionId && this.modelSteps.get(call.sessionId);
    if (!step || step.closed || !step.attachment || !step.selection) return;
    const { attachment, selection } = step;
    if (
      !this.attachmentPolicy ||
      attachment.manifest.projectId !== this.attachmentPolicy.projectId ||
      attachment.manifest.credentialGeneration !==
        this.attachmentPolicy.credentialGeneration ||
      !attachmentRoutes.has(routeId) ||
      selection.routes[routeId] !== destination ||
      selection.provider !== call.provider ||
      selection.model !== call.model ||
      step.id !== call.bindingId ||
      attachment.callId !== call.id ||
      attachment.grant !== call.attachmentGrant ||
      call.purpose !== undefined ||
      attachment.validBefore <= Date.now() ||
      !selection.isCurrent() ||
      signal.aborted ||
      !request.isCurrent() ||
      !this.current(step.batch)
    )
      return;
    return attachment.manifest;
  }
  private handleAttachment(input: Record<string, unknown>, cap: Grant) {
    const policy = this.attachmentPolicy;
    const step =
      typeof input.sessionId === 'string'
        ? this.modelSteps.get(input.sessionId)
        : undefined;
    const run = step?.batch[0];
    const closing = cap.operation === 'model-attachment-release';
    if (
      !policy ||
      !this.lockModelAuthority ||
      !run ||
      !step?.selection ||
      !onlyKeys(input, [
        ...Object.keys(this.binding(run)),
        'agentGeneration',
        'turn',
        'modelStep',
        'bindingId',
        'callId',
        ...(closing
          ? []
          : [
              'images',
              'selectionDeadline',
              'previousRoutes',
              'userContentSha256',
              'workingDirectoryEdits',
              'projectedUserContentSha256',
            ]),
      ]) ||
      Object.entries(this.binding(run)).some(
        ([key, value]) => input[key] !== value,
      ) ||
      !isRecord(input.modelStep) ||
      !onlyKeys(input.modelStep, Object.keys(step.stamp)) ||
      bodyHash(parseStepMarker(input.modelStep)) !== bodyHash(step.stamp) ||
      input.agentGeneration !== step.agentGeneration ||
      input.turn !== step.turn ||
      input.bindingId !== step.id ||
      typeof input.callId !== 'string' ||
      !uuid.test(input.callId) ||
      !Object.hasOwn(step.selection.routes, 'files') ||
      !Object.hasOwn(step.selection.routes, 'messages') ||
      step.closed ||
      !step.selection.isCurrent() ||
      !this.current(step.batch)
    )
      return invalidModel();
    const { callId } = input;
    const calls = (step.attachmentCalls ??= new Set());
    if (closing) {
      if (step.attachment?.callId === callId) step.attachment = undefined;
      if (calls.size < maxAttachmentCalls) calls.add(callId);
      return { closed: true };
    }
    if (step.attachment && step.attachment.validBefore <= Date.now())
      step.attachment = undefined;
    const workingDirectoryEdits = readWorkingDirectoryEdits(
      input.workingDirectoryEdits,
    );
    if (
      calls.size >= maxAttachmentCalls ||
      calls.has(callId) ||
      step.attachment ||
      step.attempts.size >= 128 ||
      step.wireAttempt !== undefined ||
      typeof input.userContentSha256 !== 'string' ||
      !imageDigest.test(input.userContentSha256) ||
      typeof input.projectedUserContentSha256 !== 'string' ||
      !imageDigest.test(input.projectedUserContentSha256) ||
      !workingDirectoryEdits ||
      (!workingDirectoryEdits.length &&
        input.projectedUserContentSha256 !== input.userContentSha256) ||
      !Array.isArray(input.images) ||
      input.images.length > maxAttachmentOccurrences
    )
      return invalidModel();

    const messages = new Map<string, Run>();
    const positions = new Set<string>();
    const imageHandleDigests: string[] = [];
    const images = input.images.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !onlyKeys(entry, [
          'runId',
          'requestId',
          'peerNonce',
          'userId',
          'authSessionId',
          'messageId',
          'blockIndex',
          'attachmentId',
          'handleSha256',
          'bytes',
          'sha256',
          'mediaType',
        ]) ||
        typeof entry.messageId !== 'string' ||
        !uuid.test(entry.messageId) ||
        typeof entry.blockIndex !== 'number' ||
        !Number.isSafeInteger(entry.blockIndex) ||
        entry.blockIndex < 0 ||
        typeof entry.attachmentId !== 'string' ||
        !attachmentId.test(entry.attachmentId) ||
        typeof entry.handleSha256 !== 'string' ||
        !imageDigest.test(entry.handleSha256) ||
        typeof entry.sha256 !== 'string' ||
        !imageDigest.test(entry.sha256) ||
        typeof entry.bytes !== 'number' ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        entry.bytes > 1024 * 1024 ||
        (entry.mediaType !== 'image/png' &&
          entry.mediaType !== 'image/jpeg' &&
          entry.mediaType !== 'image/webp' &&
          entry.mediaType !== 'image/gif')
      )
        return invalidModel();
      const source = step.batch.find((item) => item.runId === entry.runId);
      const position = entry.messageId + ':' + entry.blockIndex;
      const prior = messages.get(entry.messageId);
      if (
        !source ||
        source.requestId !== entry.requestId ||
        source.peerNonce !== entry.peerNonce ||
        source.who.userId !== entry.userId ||
        source.who.authSessionId !== entry.authSessionId ||
        positions.has(position) ||
        (prior && prior !== source)
      )
        return invalidModel();
      messages.set(entry.messageId, source);
      positions.add(position);
      imageHandleDigests.push(entry.handleSha256);
      return Object.freeze({
        mediaType: entry.mediaType,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    });
    if (
      input.selectionDeadline !== undefined &&
      (typeof input.selectionDeadline !== 'number' ||
        !Number.isSafeInteger(input.selectionDeadline) ||
        input.selectionDeadline <= Date.now())
    )
      return invalidModel();
    let previousRoutes;
    if (
      input.selectionDeadline !== undefined ||
      input.previousRoutes !== undefined
    ) {
      const routes = input.previousRoutes;
      if (
        typeof input.selectionDeadline !== 'number' ||
        !isRecord(routes) ||
        !onlyKeys(routes, ['files', 'messages']) ||
        typeof routes.files !== 'string' ||
        typeof routes.messages !== 'string' ||
        routes.files !== step.selection.routes.files ||
        routes.messages !== step.selection.routes.messages
      )
        return invalidModel();
      previousRoutes = { files: routes.files, messages: routes.messages };
    }
    const grant = randomUUID();
    calls.add(callId);
    step.attachment = {
      previousRoutes,
      callId,
      grant,
      validBefore: Math.min(
        cap.expiresAt,
        typeof input.selectionDeadline === 'number'
          ? input.selectionDeadline
          : Infinity,
      ),
      manifest: Object.freeze({
        ...policy,
        requirementId: run.requirementId,
        sessionId: run.sessionId,
        bindingId: step.id,
        images: Object.freeze(images),
        imageHandleDigests: Object.freeze(imageHandleDigests),
        userContentSha256: input.userContentSha256,
        workingDirectoryEdits,
        projectedUserContentSha256: input.projectedUserContentSha256,
      }),
    };
    return {
      bindingId: step.id,
      callId,
      grant,
      credentialGeneration: policy.credentialGeneration,
    };
  }
  authorizeModelAttempt<T>(request: ModelAttempt, send: () => T) {
    return this.withAuthorizedAttempt(request, send);
  }
  authorizeModelFileWireAttempt(
    request: ModelAttempt,
    write: (validBefore: number) => ModelWireOutcome,
  ): Promise<ModelWireCommit> {
    if (!this.lockModelAuthority || request.routeId !== 'files')
      return invalidModel();
    return this.withAuthorizedAttempt(request, (_step, validBefore) => ({
      outcome: write(validBefore),
      accept429() {},
    }));
  }
  async authorizeModelWireAttempt(
    request: ModelAttempt,
    write: (validBefore: number) => ModelWireOutcome,
    fixtureWire?: FixtureWire,
  ): Promise<ModelWireCommit> {
    if (request.call.purpose === 'session-title')
      return this.authorizeTitleWire(request, write);
    const pilot = this.modelPilot;
    let firstWrite: ModelFirstWrite | undefined;
    let reservedStep: ModelStep | undefined;
    const commit = await this.withAuthorizedAttempt(
      request,
      (step, validBefore) => {
        const { attemptId } = request;
        step.wireAttempt = attemptId;
        const outcome = write(validBefore);
        if (outcome === 'not-sent' && !pilot) step.wireAttempt = undefined;
        return {
          outcome,
          accept429: () => {
            if (outcome === 'submitted' && step.wireAttempt === attemptId)
              step.wireAttempt = undefined;
          },
        };
      },
      fixtureWire,
      pilot &&
        ((step) => {
          const dispatch = step.selectingDispatch;
          const coordinates = step.firstWriteCoordinates?.get(request.call.id);
          if (!dispatch || !coordinates || request.routeId !== 'main')
            return invalidModel();
          step.wireAttempt = request.attemptId;
          reservedStep = step;
          firstWrite = {
            ...coordinates,
            projectId: dispatch.projectId,
            requirementId: dispatch.requirementId,
            nativeSessionId: dispatch.nativeSessionId,
            selectionRequestId: dispatch.requestId,
            selectionRevision: dispatch.selectionRevision,
            provider: dispatch.provider,
            model: dispatch.model,
            hostGeneration: this.generation,
            agentGeneration: step.agentGeneration,
            bindingId: step.id,
            callId: request.call.id,
            attemptId: request.attemptId,
            turn: step.turn,
            step: step.stamp.step,
          };
          return pilot.firstWrites.prepare(firstWrite);
        }),
    );
    if (pilot && firstWrite && reservedStep) {
      if (commit.outcome === 'submitted')
        pilot.firstWrites.submitted(firstWrite);
      else if (
        commit.outcome === 'not-sent' &&
        this.modelSteps.get(firstWrite.nativeSessionId) === reservedStep &&
        reservedStep.wireAttempt === request.attemptId
      )
        reservedStep.wireAttempt = undefined;
    }
    return commit;
  }
  fixtureWire(request: ModelAttempt) {
    if (request.routeId !== 'main' || request.call.purpose !== undefined)
      return;
    const step = this.modelSteps.get(request.call.sessionId ?? '');
    if (step && !step.closed && request.call.bindingId === step.id)
      return step.fixtureWire;
  }
  // §11.20.26 hop 6: the FD4 body projection of the armed Read run. Only the
  // steps of the run bound at hop 3 carry the read declaration and history.
  // The armed run of a model step, when it is one of the runs that
  // reached an FD3 request (several runs may be armed in one BFF).
  private armedStep(request: ModelAttempt, runId: (runId: string) => boolean) {
    if (request.routeId !== 'main' || request.call.purpose !== undefined)
      return;
    const step = this.modelSteps.get(request.call.sessionId ?? '');
    if (
      step &&
      !step.closed &&
      request.call.bindingId === step.id &&
      step.batch.length === 1
    )
      return runId(step.batch[0]!.runId) ? step : undefined;
  }
  readWire(request: ModelAttempt): ReadToolProjection | undefined {
    const step = this.armedStep(
      request,
      (runId) => !!this.readArmed.get(runId)?.segment,
    );
    const armed = step && this.readArmed.get(step.batch[0]!.runId);
    if (!armed?.segment) return;
    return { kind: 'read', segment: armed.segment };
  }
  // §11.20.27 hop 6: the FD4 projection of the run armed with write tools,
  // once the Host registered the definitions of the armed set. B segment:
  // the projection also carries the registered command (history calls of
  // bash must be the registered one) and the prefix policy of the output
  // handling, applied once more over every tool result as a backstop.
  writeWire(request: ModelAttempt): WriteToolProjection | undefined {
    const session = this.sessionTools.get(request.call.sessionId ?? '');
    const step = this.armedStep(
      request,
      (runId) =>
        !!this.writeArmed.get(runId) ||
        !!this.writeDefinitions.get(runId) ||
        !!this.readArmed.get(runId),
    );
    if (!step) return;
    const runId = step.batch[0]!.runId;
    const armed = this.writeArmed.get(runId);
    const read = this.readArmed.get(runId);
    const tools = this.writeDefinitions.get(runId);
    if (tools?.length) {
      if (!armed) return;
      // The policy is never absent: before the locations of the run are
      // resolved the conservative default stands in (the first request of
      // a run carries no tool result).
      return {
        kind: 'tools',
        tools,
        segment: read?.segment ?? (() => false),
        redaction: armed.redaction?.() ?? conservativeRedaction(),
        redactions: armed.redactionCount?.() ?? 0,
        ...(armed.countRedaction && { countRedaction: armed.countRedaction }),
      };
    }
    // A later run of a session that lost the write tools: read alone is
    // declared, and the earlier write exchanges are projected as history.
    if (!session?.read || !read) return;
    return {
      kind: 'tools',
      tools: [session.read],
      segment: read.segment ?? (() => false),
      redaction: session.redaction?.() ?? conservativeRedaction(),
      redactions: session.redactionCount?.() ?? 0,
      ...(session.countRedaction && { countRedaction: session.countRedaction }),
    };
  }
  pilotWireModel(request: ModelAttempt) {
    if (
      !this.modelPilot ||
      request.routeId !== 'main' ||
      request.call.purpose !== undefined
    )
      return;
    const step = this.modelSteps.get(request.call.sessionId ?? '');
    if (
      step &&
      !step.closed &&
      request.call.bindingId === step.id &&
      step.selection?.isCurrent()
    )
      return step.selection.model;
  }
  private async authorizeTitleWire(
    request: ModelAttempt,
    write: (validBefore: number) => ModelWireOutcome,
  ): Promise<ModelWireCommit> {
    const { call, routeId, destination, signal } = request;
    const title =
      typeof call.sessionId === 'string'
        ? this.titles.get(call.sessionId)
        : undefined;
    if (
      !this.allowTitles ||
      !title ||
      title.phase !== 'prepared' ||
      title.bindingId !== call.bindingId ||
      title.callId !== call.id ||
      !uuid.test(request.attemptId) ||
      !this.selectModel ||
      !this.lockModelAuthority
    )
      return invalidModel();
    title.phase = 'attempted';
    const { run } = title;
    const current = () =>
      this.titles.get(run.sessionId) === title &&
      title.phase === 'attempted' &&
      title.expiresAt > Date.now() &&
      request.isCurrent() &&
      !signal.aborted &&
      !this.closing(run.who.authSessionId, run.who.userId, run.requirementId);
    if (!current()) return invalidModel();
    const selection = await this.selectModel(
      run.who,
      run.requirementId,
      run.sessionId,
    );
    if (
      !selection ||
      selection.provider !== call.provider ||
      selection.model !== call.model ||
      !Object.hasOwn(selection.routes, routeId) ||
      selection.routes[routeId] !== destination
    )
      return invalidModel();
    return this.lockModelAuthority(
      run.who,
      run.requirementId,
      run.sessionId,
      [],
      (loginDeadline) => {
        const validBefore = Math.min(loginDeadline, title.expiresAt);
        if (!(validBefore > Date.now()) || !current() || !selection.isCurrent())
          return invalidModel();
        title.phase = 'closed';
        return { outcome: write(validBefore), accept429() {} };
      },
    );
  }

  private handleTitle(input: Record<string, unknown>, cap: Grant) {
    if (
      !this.allowTitles ||
      !this.lockModelAuthority ||
      typeof input.sessionId !== 'string'
    )
      return invalidModel();
    const now = Date.now();
    const exact = (run: Run) =>
      Object.entries(this.binding(run)).every(
        ([key, value]) => input[key] === value,
      ) &&
      run.agentGeneration === input.agentGeneration &&
      run.turn === input.turn &&
      !!run.agentGeneration &&
      Number.isSafeInteger(input.sourceSeq) &&
      Number(input.sourceSeq) > 0 &&
      typeof input.sourceId === 'string' &&
      uuid.test(input.sourceId);
    if (cap.operation === 'model-title-origin') {
      for (const [id, title] of this.titles)
        if (title.run.expiresAt <= now) this.titles.delete(id);
      const run = this.runs.get(String(input.runId));
      if (!run || run.titleCancelled || !exact(run) || !this.current([run]))
        return invalidModel();
      const prior = this.titles.get(input.sessionId);
      if (prior) {
        if (
          prior.phase !== 'candidate' ||
          prior.expiresAt <= now ||
          prior.run !== run ||
          prior.sourceId !== input.sourceId ||
          prior.sourceSeq !== input.sourceSeq
        )
          return invalidModel();
        return { originId: prior.bindingId, expiresAt: prior.expiresAt };
      }
      if (this.titles.size >= 512) return invalidModel();
      const title: TitleOrigin = {
        bindingId: randomUUID(),
        run,
        sourceSeq: Number(input.sourceSeq),
        sourceId: String(input.sourceId),
        expiresAt: Math.min(cap.expiresAt, run.expiresAt),
        phase: 'candidate',
      };
      this.titles.set(input.sessionId, title);
      return { originId: title.bindingId, expiresAt: title.expiresAt };
    }
    const title = this.titles.get(input.sessionId);
    if (
      !title ||
      !exact(title.run) ||
      title.sourceId !== input.sourceId ||
      title.sourceSeq !== input.sourceSeq
    )
      return invalidModel();
    if (cap.operation === 'model-title-close') {
      title.phase = 'closed';
      return { closed: true };
    }
    if (
      title.phase !== 'candidate' ||
      title.bindingId !== input.originId ||
      typeof input.callId !== 'string' ||
      !uuid.test(input.callId) ||
      title.expiresAt <= now ||
      this.closing(
        title.run.who.authSessionId,
        title.run.who.userId,
        title.run.requirementId,
      )
    )
      return invalidModel();
    title.phase = 'prepared';
    title.callId = input.callId;
    return { bindingId: title.bindingId, expiresAt: title.expiresAt };
  }
  private async withAuthorizedAttempt<T>(
    request: ModelAttempt,
    send: (step: ModelStep, validBefore: number) => T,
    fixtureWire?: FixtureWire,
    prepare?: (step: ModelStep) => Promise<void>,
  ): Promise<T> {
    const { call, attemptId, routeId, destination, signal } = request;
    const step =
      typeof call.sessionId === 'string'
        ? this.modelSteps.get(call.sessionId)
        : undefined;
    const selection = step?.selection;
    const needsAttachment =
      this.attachmentPolicy && attachmentRoutes.has(routeId);
    const attachment = needsAttachment
      ? this.attachmentManifestFor(request)
      : undefined;
    const attachmentDeadline = needsAttachment
      ? (step?.attachment?.validBefore ?? 0)
      : Infinity;
    if (
      (needsAttachment && !attachment) ||
      (this.modelPilot && !prepare) ||
      !step ||
      step.closed ||
      step.wireAttempt !== undefined ||
      step.fixtureWire !== fixtureWire ||
      (fixtureWire && !this.lockModelAuthority) ||
      !selection ||
      (!this.selectModel && !this.modelPilot) ||
      !request.isCurrent() ||
      signal.aborted ||
      call.purpose !== undefined ||
      call.bindingId !== step.id ||
      call.provider !== selection.provider ||
      call.model !== selection.model ||
      !Object.hasOwn(selection.routes, routeId) ||
      selection.routes[routeId] !== destination ||
      !uuid.test(attemptId) ||
      step.attempts.has(attemptId) ||
      step.attempts.size >= 128 ||
      !selection.isCurrent() ||
      !this.current(step.batch)
    )
      return invalidModel();
    step.attempts.add(attemptId);
    if (prepare) await prepare(step);
    const run = step.batch[0]!;
    const related = step.batch.slice(1).map(({ who }) => who);
    const shared =
      this.lockModelAuthority || this.modelPilot
        ? undefined
        : await this.read(run.who, run.requirementId, run.sessionId, related);
    const fresh = this.modelPilot
      ? selection
      : await this.selectModel!(run.who, run.requirementId, run.sessionId);
    const finalize = (validBefore: number) => {
      const deadline = Math.min(
        validBefore,
        fixtureWire || this.modelPilot ? (step.validBefore ?? 0) : Infinity,
        attachmentDeadline,
        ...step.batch.map(({ expiresAt }) => expiresAt),
      );
      if (
        !fresh ||
        (needsAttachment &&
          step.attachment?.previousRoutes &&
          (fresh.routes.files !== step.attachment.previousRoutes.files ||
            fresh.routes.messages !==
              step.attachment.previousRoutes.messages)) ||
        fresh.revision !== selection.revision ||
        fresh.provider !== selection.provider ||
        fresh.model !== selection.model ||
        !Object.hasOwn(fresh.routes, routeId) ||
        fresh.routes[routeId] !== destination ||
        !fresh.isCurrent() ||
        !selection.isCurrent() ||
        !request.isCurrent() ||
        signal.aborted ||
        this.modelSteps.get(run.sessionId) !== step ||
        (needsAttachment &&
          this.attachmentManifestFor(request) !== attachment) ||
        step.closed ||
        step.wireAttempt !== (prepare ? attemptId : undefined) ||
        !this.current(step.batch) ||
        !(deadline > Date.now())
      )
        return invalidModel();
      fixtureWire?.job.assertWireLease();
      return send(step, deadline);
    };
    if (this.modelPilot)
      return this.modelPilot.lock(
        step.batch.map(({ dispatch }) => dispatch!),
        finalize,
        step.firstWriteCoordinates?.get(call.id)?.sourceThroughSeq ?? null,
      );
    if (this.lockModelAuthority)
      return this.lockModelAuthority(
        run.who,
        run.requirementId,
        run.sessionId,
        related,
        finalize,
        fixtureWire?.job.wireLease,
      );
    return finalize(shared!.validBefore);
  }
  private selectedPilotStep(
    input: Record<string, unknown>,
    step: ModelStep,
    previous?: ModelStep,
  ) {
    const pilot = this.modelPilot!;
    const claimed = input.modelNewRunIds;
    if (
      !Array.isArray(claimed) ||
      claimed.length > 16 ||
      claimed.some((id) => typeof id !== 'string') ||
      new Set(claimed).size !== claimed.length
    )
      return invalidModel();
    const ordered = [...step.batch.slice(1), step.batch[0]!];
    const continues =
      previous &&
      previous.agentGeneration === step.agentGeneration &&
      previous.turn === step.turn;
    if (
      continues
        ? !previous.selection || step.stamp.step !== previous.stamp.step + 1
        : step.stamp.step !== 1 || !claimed.length
    )
      return invalidModel();
    const prefix = continues
      ? [...previous.batch.slice(1), previous.batch[0]!].map(
          ({ runId }) => runId,
        )
      : [];
    const expected = [...prefix, ...claimed];
    if (
      expected.length !== ordered.length ||
      new Set(expected).size !== expected.length ||
      ordered.some(({ runId }, index) => runId !== expected[index])
    )
      return invalidModel();
    const added = ordered.slice(prefix.length);
    if (!added.length) {
      step.selectingDispatch = previous!.selectingDispatch;
      return previous!.selection!;
    }
    const selected = added[0]!.dispatch;
    if (
      !selected ||
      selected.provider !== pilot.provider ||
      !pilot.models.has(selected.model) ||
      added.some(
        ({ dispatch }) =>
          !dispatch ||
          dispatch.provider !== selected.provider ||
          dispatch.model !== selected.model ||
          dispatch.selectionRevision !== selected.selectionRevision,
      )
    )
      return invalidModel();
    step.selectingDispatch = selected;
    return {
      provider: selected.provider,
      model: selected.model,
      revision: selected.selectionRevision,
      routes: { main: pilot.destination },
      isCurrent: pilot.isCurrent,
    };
  }
  private confirmFirstWriteCoordinates(
    input: Record<string, unknown>,
    cap: Grant,
  ) {
    const step =
      typeof input.sessionId === 'string'
        ? this.modelSteps.get(input.sessionId)
        : undefined;
    const run = step?.batch[0];
    const { callId, stepSeq, noteSeq, sourceThroughSeq = null } = input;
    const validBefore = Math.min(step?.validBefore ?? 0, cap.expiresAt);
    if (
      !this.modelPilot ||
      !step ||
      !run ||
      !step.selectingDispatch ||
      step.closed ||
      !step.selection?.isCurrent() ||
      validBefore <= Date.now() ||
      !this.current(step.batch) ||
      Object.entries(this.binding(run)).some(
        ([name, value]) => input[name] !== value,
      ) ||
      input.bindingId !== step.id ||
      input.agentGeneration !== step.agentGeneration ||
      input.turn !== step.turn ||
      input.step !== step.stamp.step ||
      input.noteId !== step.stamp.noteId ||
      typeof callId !== 'string' ||
      !uuid.test(callId) ||
      typeof stepSeq !== 'number' ||
      typeof noteSeq !== 'number' ||
      !Number.isSafeInteger(stepSeq) ||
      !Number.isSafeInteger(noteSeq) ||
      stepSeq < 0 ||
      (sourceThroughSeq !== null &&
        (typeof sourceThroughSeq !== 'number' ||
          !Number.isSafeInteger(sourceThroughSeq) ||
          sourceThroughSeq < -1 ||
          stepSeq <= sourceThroughSeq)) ||
      noteSeq <= stepSeq ||
      noteSeq - stepSeq > 64
    )
      return invalidModel();
    const coordinates = (step.firstWriteCoordinates ??= new Map());
    const prior = coordinates.values().next().value;
    if (
      (prior &&
        (prior.stepSeq !== stepSeq ||
          prior.noteSeq !== noteSeq ||
          prior.sourceThroughSeq !== sourceThroughSeq)) ||
      (!coordinates.has(callId) && coordinates.size >= 128)
    )
      return invalidModel();
    coordinates.set(callId, { stepSeq, noteSeq, sourceThroughSeq });
    return {
      result: {
        bindingId: step.id,
        callId,
        stepSeq,
        noteSeq,
        ...(sourceThroughSeq !== null && { sourceThroughSeq }),
      },
      validBefore,
    };
  }
  async handle(
    input: unknown,
    token: unknown,
    reply?: (result: unknown, validBefore: number) => void,
    fixtureToolRun?: RunBinding,
    fixtureToolJob?: NativeFixtureToolJob,
    readTool?: ReadToolBinding,
    writeTool?: WriteToolBinding,
  ) {
    const cap = this.verify(token),
      now = Date.now();
    const fixtureEnabled = fixtureToolRun && process.env.RDWS_MODE === 'test';
    // The Read permit exists only in the isolated assembly that armed it.
    const readEnabled = readTool && process.env.RDWS_MODE === 'test';
    if (readEnabled && readTool.segment)
      this.readArmed.set(readTool.run.runId, readTool);
    // §11.20.27: the write tool operations exist only in the isolated
    // assembly that armed the run with a write generation.
    const writeEnabled = writeTool && process.env.RDWS_MODE === 'test';
    if (writeEnabled) this.writeArmed.set(writeTool.run.runId, writeTool);
    const writeOperation =
      writeEnabled &&
      writeToolOperations.find((operation) => operation === cap?.operation);
    const fixtureOperation =
      fixtureEnabled &&
      fixtureToolJob &&
      fixtureToolOperations.find((operation) => operation === cap?.operation);
    for (const [nonce, expiry] of this.nonces)
      if (expiry <= now) this.nonces.delete(nonce);
    if (
      !cap ||
      cap.purpose !== 'service' ||
      ![
        'context-read',
        'context-release',
        'model-step-release',
        'model-first-write-proof',
        'model-title-origin',
        'model-title-prepare',
        'model-title-close',
        ...(fixtureEnabled ? ['fixture-tool-permit'] : []),
        ...(fixtureOperation ? [fixtureOperation] : []),
        ...(readEnabled ? ['read-tool-permit'] : []),
        ...(readEnabled && readTool.service ? readToolOperations : []),
        ...(writeEnabled
          ? ['write-tool-permit', 'write-tool-definitions']
          : []),
        ...(writeOperation ? [writeOperation] : []),
        'model-attachment-prepare',
        'model-attachment-release',
      ].includes(cap.operation ?? '') ||
      cap.hostGeneration !== this.generation ||
      !isRecord(input) ||
      cap.bodyHash !== bodyHash(input) ||
      cap.runId !== input.runId ||
      this.nonces.has(cap.nonce)
    )
      businessError(403, '上下文服务请求未获授权');
    this.nonces.set(cap.nonce, cap.expiresAt);
    if (cap.operation === 'model-first-write-proof') {
      const { result, validBefore } = this.confirmFirstWriteCoordinates(
        input,
        cap,
      );
      reply?.(result, validBefore);
      return result;
    }
    if (fixtureOperation && fixtureToolJob) {
      let validBefore = cap.expiresAt;
      const result = await fixtureToolJob.control(
        fixtureOperation.slice('fixture-tool-'.length) as
          'begin' | 'status' | 'cancel',
        input,
        async ({ who, requirementId, sessionId }) => {
          const loginClosed = () =>
            this.closing(who.authSessionId, who.userId, requirementId);
          if (loginClosed()) return invalidModel();
          const current = await this.read(who, requirementId, sessionId);
          validBefore = Math.min(current.validBefore, validBefore);
          if (loginClosed() || validBefore <= Date.now()) return invalidModel();
        },
      );
      reply?.(result, validBefore);
      return result;
    }
    if (cap.operation === 'fixture-tool-permit' && fixtureToolRun) {
      const result = await this.authorizeFixtureTool(
        input,
        cap,
        fixtureToolRun,
        fixtureToolJob,
      );
      reply?.(result, result.expiresAt);
      return result;
    }
    if (cap.operation === 'read-tool-permit' && readEnabled) {
      const result = await this.authorizeReadTool(
        input,
        cap,
        readTool,
        fixtureToolJob,
      );
      reply?.(result, result.expiresAt);
      return result;
    }
    if (cap.operation === 'write-tool-permit' && writeEnabled && writeTool) {
      const result = await this.authorizeWriteTool(input, cap, writeTool);
      reply?.(result, result.expiresAt);
      return result;
    }
    if (
      cap.operation === 'write-tool-definitions' &&
      writeEnabled &&
      writeTool
    ) {
      const result = this.declareWriteTools(input, cap, writeTool);
      reply?.(result, cap.expiresAt);
      return result;
    }
    if (writeOperation && writeTool) {
      const job = this.modelSteps.get(writeTool.run.sessionId)?.writeToolJob;
      if (!job) businessError(403, '原生写工具作业未获授权');
      let validBefore = cap.expiresAt;
      const result = await job.control(
        writeOperation.slice('write-tool-'.length) as
          'begin' | 'status' | 'cancel' | 'output',
        input,
        async ({ who, requirementId, sessionId }) => {
          const loginClosed = () =>
            this.closing(who.authSessionId, who.userId, requirementId);
          if (loginClosed()) return invalidModel();
          const current = await this.read(who, requirementId, sessionId);
          validBefore = Math.min(current.validBefore, validBefore);
          if (loginClosed() || validBefore <= Date.now()) return invalidModel();
        },
      );
      if (
        writeOperation === 'write-tool-output' &&
        Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8') > readReplyLimit
      )
        businessError(413, '写工具回包超过上限');
      reply?.(result, validBefore);
      return result;
    }
    const readOperation = readToolOperations.find(
      (operation) => operation === cap.operation,
    );
    if (readOperation && readEnabled && readTool.service) {
      const result = await this.handleWorktreeRead(
        input,
        readOperation,
        readTool,
        cap,
      );
      reply?.(result, cap.expiresAt);
      return result;
    }
    if (cap.operation?.startsWith('model-attachment-')) {
      const result = this.handleAttachment(input, cap);
      const deadline =
        cap.operation === 'model-attachment-prepare' &&
        typeof input.selectionDeadline === 'number'
          ? Math.min(cap.expiresAt, input.selectionDeadline)
          : cap.expiresAt;
      reply?.(result, deadline);
      return result;
    }
    if (cap.operation?.startsWith('model-title-')) {
      const result = this.handleTitle(input, cap);
      reply?.(result, cap.expiresAt);
      return result;
    }
    const inputs = [
      input,
      ...(Array.isArray(input.relatedRuns) ? input.relatedRuns : []),
    ];
    if (inputs.length > 16 || inputs.some((i) => !isRecord(i)))
      businessError(403, '运行批次无效');
    if (cap.operation === 'model-step-release') {
      const stamp = parseStepMarker(input.modelStep);
      const current =
        typeof input.sessionId === 'string'
          ? this.modelSteps.get(input.sessionId)
          : undefined;
      if (
        current &&
        current.batch[0]?.runId === input.runId &&
        current.agentGeneration === input.agentGeneration &&
        current.turn === input.turn &&
        bodyHash(current.stamp) === bodyHash(stamp)
      ) {
        current.closed = true;
        current.fixtureToolJob?.cancel();
        current.writeToolJob?.cancel();
        current.attachment = undefined;
      }
      const result = { released: true };
      reply?.(result, cap.expiresAt);
      return result;
    }
    if (cap.operation === 'context-release') {
      for (const binding of inputs) {
        const existing = this.runs.get(String(binding.runId));
        if (
          existing &&
          Object.entries(this.binding(existing)).every(
            ([key, value]) => binding[key] === value,
          )
        )
          this.discard(
            existing.runId,
            input.titleDisposition === 'normal' &&
              existing.agentGeneration === binding.agentGeneration &&
              existing.turn === binding.turn,
          );
      }
      const result = { released: true };
      reply?.(result, cap.expiresAt);
      return result;
    }
    const batch: Run[] = [];
    for (const binding of inputs) {
      const related = this.runs.get(String(binding.runId));
      if (
        !related ||
        related.expiresAt <= now ||
        this.closing(
          related.who.authSessionId,
          related.who.userId,
          related.requirementId,
        ) ||
        Object.entries(this.binding(related)).some(
          ([key, value]) => binding[key] !== value,
        ) ||
        binding.sessionId !== input.sessionId ||
        binding.requirementId !== input.requirementId ||
        binding.agentGeneration !== input.agentGeneration ||
        binding.turn !== input.turn ||
        (related.agentGeneration &&
          (related.agentGeneration !== binding.agentGeneration ||
            related.turn !== binding.turn))
      )
        businessError(403, '批次包含失效运行身份');
      batch.push(related);
    }
    const run = this.runs.get(String(input.runId));
    if (
      !run ||
      run.expiresAt <= now ||
      this.closing(run.who.authSessionId, run.who.userId, run.requirementId) ||
      Object.entries(this.binding(run)).some(
        ([key, value]) => input[key] !== value,
      ) ||
      typeof input.agentGeneration !== 'string' ||
      !input.agentGeneration ||
      !Number.isSafeInteger(input.turn) ||
      Number(input.turn) < 1
    )
      businessError(403, '当前运行绑定已失效');
    if (
      run.agentGeneration &&
      (run.agentGeneration !== input.agentGeneration || run.turn !== input.turn)
    )
      businessError(403, '运行代次不匹配');
    if (batch.some((r) => r.who.userId !== run.who.userId))
      businessError(403, '批次身份不匹配');
    for (const r of batch) {
      r.agentGeneration = String(input.agentGeneration);
      r.turn = Number(input.turn);
    }
    let modelStep: ModelStep | undefined;
    let previous: ModelStep | undefined;
    if (input.modelStep !== undefined) {
      const stamp = parseStepMarker(input.modelStep);
      previous = this.modelSteps.get(run.sessionId);
      if (
        (!this.selectModel && !this.modelPilot) ||
        new Set(batch).size !== batch.length ||
        (previous &&
          (stamp.sequence <= previous.stamp.sequence ||
            (previous.agentGeneration === input.agentGeneration &&
              (Number(input.turn) < previous.turn ||
                (input.turn === previous.turn &&
                  stamp.step <= previous.stamp.step)))))
      )
        return invalidModel();
      modelStep = {
        id: randomUUID(),
        stamp,
        batch,
        agentGeneration: String(input.agentGeneration),
        turn: Number(input.turn),
        closed: false,
        attempts: new Set(),
      };
      if (previous) {
        previous.closed = true;
        previous.fixtureToolJob?.cancel();
        previous.writeToolJob?.cancel();
        previous.attachment = undefined;
      }
      this.modelSteps.set(run.sessionId, modelStep);
    }
    const { value, validBefore: loginExpiresAt } = await this.read(
      run.who,
      run.requirementId,
      run.sessionId,
      batch.slice(1).map((r) => r.who),
    );
    const validBefore = Math.min(
      loginExpiresAt,
      cap.expiresAt,
      ...batch.map((r) => r.expiresAt),
    );
    const selected =
      modelStep &&
      (this.modelPilot
        ? this.selectedPilotStep(input, modelStep, previous)
        : await this.selectModel!(run.who, run.requirementId, run.sessionId));
    if (!(validBefore > Date.now()) || !this.current(batch))
      businessError(403, '当前运行绑定已失效');
    let result = value;
    if (modelStep) {
      if (
        !selected ||
        !selected.isCurrent() ||
        selected.provider !== modelStep.stamp.provider ||
        selected.model !== modelStep.stamp.model ||
        this.modelSteps.get(run.sessionId) !== modelStep ||
        modelStep.closed ||
        !isRecord(value)
      )
        return invalidModel();
      modelStep.selection = {
        ...selected,
        routes: Object.freeze({ ...selected.routes }),
      };
      modelStep.validBefore = validBefore;
      if (
        isRecord(value.snapshot) &&
        typeof value.snapshot.contextVersion === 'number' &&
        Number.isSafeInteger(value.snapshot.contextVersion)
      )
        modelStep.contextVersion = value.snapshot.contextVersion;
      const wireLease = fixtureToolJob?.wireLease;
      if (fixtureToolJob && wireLease && fixtureToolRun?.runId === run.runId) {
        if (
          batch.length !== 1 ||
          modelStep.contextVersion !== wireLease.contextVersion
        )
          return invalidModel();
        if (
          modelStep.stamp.step === 1 &&
          input.fixtureToolHistory === undefined
        )
          modelStep.fixtureWire = {
            job: fixtureToolJob,
            projection: { kind: 'declaration' },
          };
        else if (
          previous?.closed &&
          previous.fixtureToolJob === fixtureToolJob &&
          previous.batch[0] === run &&
          previous.agentGeneration === modelStep.agentGeneration &&
          previous.turn === modelStep.turn &&
          previous.stamp.step + 1 === modelStep.stamp.step
        )
          modelStep.fixtureWire = {
            job: fixtureToolJob,
            projection: {
              kind: 'history',
              callId: fixtureToolJob.history(input.fixtureToolHistory),
            },
          };
        else return invalidModel();
      } else if (input.fixtureToolHistory !== undefined) return invalidModel();
      result = { ...value, modelBindingId: modelStep.id };
    }
    reply?.(result, validBefore);
    return result;
  }

  private async authorizeFixtureTool(
    input: Record<string, unknown>,
    cap: Grant,
    expected: RunBinding,
    job?: NativeFixtureToolJob,
  ) {
    const run = this.runs.get(expected.runId);
    const step = this.modelSteps.get(expected.sessionId);
    const now = Date.now();
    const { deadline } = input;
    if (
      !run ||
      !step ||
      (job?.wireLease &&
        (step.fixtureWire?.projection.kind !== 'declaration' ||
          step.fixtureWire.job !== job ||
          !step.wireAttempt)) ||
      step.batch.length !== 1 ||
      step.batch[0] !== run ||
      Object.entries(this.binding(run)).some(
        ([key, value]) =>
          expected[key as keyof RunBinding] !== value || input[key] !== value,
      ) ||
      input.authSessionId !== run.who.authSessionId ||
      input.agentGeneration !== step.agentGeneration ||
      input.turn !== step.turn ||
      input.modelBindingId !== step.id ||
      bodyHash(parseStepMarker(input.modelStep)) !== bodyHash(step.stamp) ||
      input.toolName !== 'rdws_authority_probe' ||
      !isRecord(input.arguments) ||
      Object.keys(input.arguments).length !== 0 ||
      typeof input.toolCallId !== 'string' ||
      input.toolCallId.length < 1 ||
      input.toolCallId.length > 128 ||
      !Number.isSafeInteger(input.toolCallSeq) ||
      Number(input.toolCallSeq) < 1 ||
      typeof deadline !== 'number' ||
      !Number.isSafeInteger(deadline) ||
      deadline <= now ||
      deadline > now + 2000
    )
      return invalidModel();
    const current = () =>
      this.modelSteps.get(run.sessionId) === step &&
      !step.closed &&
      step.selection?.isCurrent() &&
      this.current([run]);
    if (step.fixtureToolUsed || !current()) return invalidModel();
    const login = await this.read(run.who, run.requirementId, run.sessionId);
    const expiresAt = Math.min(
      cap.expiresAt,
      login.validBefore,
      step.validBefore ?? 0,
      run.expiresAt,
      deadline,
      job ? Date.now() + 1200 : Infinity,
    );
    if (step.fixtureToolUsed || !current() || expiresAt <= Date.now())
      return invalidModel();
    const jobId = job?.offer(
      run.who,
      run.requirementId,
      run.sessionId,
      step.contextVersion,
      bodyHash(input),
      expiresAt,
      () => !!current(),
      input.toolCallId,
      Number(input.toolCallSeq),
    );
    step.fixtureToolJob = job;
    step.fixtureToolUsed = true;
    return { digest: cap.bodyHash, expiresAt, ...(jobId && { jobId }) };
  }

  // §11.20.26 hop 4, the FD3 read service. The scope is re-derived here from
  // the signed run binding, the login and the own session; the caller only
  // supplies the variable fields of the operation. A reply over the envelope
  // cap fails without a page.
  private async handleWorktreeRead(
    input: Record<string, unknown>,
    operation: ReadToolOperation,
    binding: ReadToolBinding,
    cap: Grant,
  ) {
    const run = this.runs.get(binding.run.runId);
    if (!run || !binding.service) businessError(403, '当前运行绑定已失效');
    if (
      run.expiresAt <= Date.now() ||
      this.closing(run.who.authSessionId, run.who.userId, run.requirementId) ||
      Object.entries(this.binding(run)).some(
        ([key, value]) =>
          binding.run[key as keyof RunBinding] !== value ||
          input[key] !== value,
      ) ||
      input.authSessionId !== run.who.authSessionId
    )
      businessError(403, '当前运行绑定已失效');
    const variable = readVariableFields[operation];
    const names = Object.keys(input);
    // read-segment-register takes one optional field: the segment a
    // truncated continuation itself continues.
    const optional =
      operation === 'read-segment-register' && 'segment' in input ? 1 : 0;
    if (
      names.length !== readBindingFields.length + variable.length + optional ||
      (!optional && names.includes('segment')) ||
      !readBindingFields.every((key) => key in input) ||
      !variable.every((key) => key in input)
    )
      businessError(400, '读取参数不正确');
    const scope: WriteHandoffScope = {
      projectId: binding.projectId,
      requirementId: run.requirementId,
      sessionId: run.sessionId,
      who: {
        userId: run.who.userId,
        authSessionId: run.who.authSessionId,
      },
    };
    const result = await binding.service(
      operation,
      scope,
      Object.fromEntries(
        [...variable, ...(optional ? ['segment'] : [])].map((key) => [
          key,
          input[key],
        ]),
      ),
      cap.expiresAt,
      () => this.current([run]),
    );
    if (
      Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8') > readReplyLimit
    )
      businessError(413, '读取回包超过上限');
    return result;
  }

  // §11.20.26 Read-specific single-use permit. Same binding discipline as the
  // fixture permit — original run, login, own session, Agent generation,
  // turn, current step and mediated binding — plus the exact argument shape
  // of the locked read: {file_path[, offset][, limit]}, a registered path or
  // a registered segment, positive integers and limit within the read limit.
  private async authorizeReadTool(
    input: Record<string, unknown>,
    cap: Grant,
    binding: ReadToolBinding,
    job?: NativeFixtureToolJob,
  ) {
    const expected = binding.run;
    const run = this.runs.get(expected.runId);
    const step = this.modelSteps.get(expected.sessionId);
    const { deadline } = input;
    if (
      !run ||
      !step ||
      step.batch.length !== 1 ||
      step.batch[0] !== run ||
      Object.entries(this.binding(run)).some(
        ([key, value]) =>
          expected[key as keyof RunBinding] !== value || input[key] !== value,
      ) ||
      input.authSessionId !== run.who.authSessionId ||
      input.agentGeneration !== step.agentGeneration ||
      input.turn !== step.turn ||
      input.modelBindingId !== step.id ||
      bodyHash(parseStepMarker(input.modelStep)) !== bodyHash(step.stamp) ||
      input.toolName !== readToolName ||
      typeof input.toolCallId !== 'string' ||
      input.toolCallId.length < 1 ||
      input.toolCallId.length > 128 ||
      !Number.isSafeInteger(input.toolCallSeq) ||
      Number(input.toolCallSeq) < 1 ||
      typeof deadline !== 'number' ||
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      deadline > Date.now() + 2000 ||
      !readToolPermitArguments(input, binding.segment)
    )
      return invalidModel();
    const current = () =>
      this.modelSteps.get(run.sessionId) === step &&
      !step.closed &&
      step.selection?.isCurrent() &&
      this.current([run]);
    if (step.readToolUsed || !current()) return invalidModel();
    const login = await this.read(run.who, run.requirementId, run.sessionId);
    const expiresAt = Math.min(
      cap.expiresAt,
      login.validBefore,
      step.validBefore ?? 0,
      run.expiresAt,
      deadline,
      job ? Date.now() + 1200 : Infinity,
    );
    // Single issue: a second ticket for the same call in the same step,
    // a step that changed, or a run cancelled meanwhile all stay at zero.
    if (step.readToolUsed || !current() || expiresAt <= Date.now())
      return invalidModel();
    step.readToolUsed = true;
    return { digest: cap.bodyHash, expiresAt };
  }

  // §11.20.27 hop 2: the definitions the Host registered for the armed run,
  // exactly the armed set (read and the write tools of the run) in the
  // fixed order; the FD4 projection compares every declaration with them.
  private declareWriteTools(
    input: Record<string, unknown>,
    cap: Grant,
    binding: WriteToolBinding,
  ) {
    const run = this.runs.get(binding.run.runId);
    if (!run) businessError(403, '当前运行绑定已失效');
    const names = Object.keys(input);
    if (
      names.length !== readBindingFields.length + 1 ||
      !readBindingFields.every((key) => key in input) ||
      !('definitions' in input)
    )
      businessError(400, '写工具声明参数不正确');
    if (
      run.expiresAt <= Date.now() ||
      this.closing(run.who.authSessionId, run.who.userId, run.requirementId) ||
      Object.entries(this.binding(run)).some(
        ([key, value]) =>
          binding.run[key as keyof RunBinding] !== value ||
          input[key] !== value,
      ) ||
      input.authSessionId !== run.who.authSessionId
    )
      businessError(403, '当前运行绑定已失效');
    const tools = toolDefinitions(input.definitions, [
      'read',
      ...binding.tools,
    ]);
    if (!tools) businessError(403, '写工具声明与武装集合不一致');
    this.writeDefinitions.set(binding.run.runId, tools);
    // The session keeps the read definition and the output policy for its
    // later runs, armed with the write tools or not.
    const readDefinition = tools.find(({ name }) => name === 'read');
    this.sessionTools.set(binding.run.sessionId, {
      ...(readDefinition && { read: readDefinition }),
      ...(binding.redaction && { redaction: binding.redaction }),
      ...(binding.countRedaction && { countRedaction: binding.countRedaction }),
      ...(binding.redactionCount && { redactionCount: binding.redactionCount }),
    });
    return { declared: tools.map(({ name }) => name) };
  }

  // §11.20.27 write-specific single-use permit (W1, W2, W3). Same binding
  // discipline as the read permit, plus the write binding: the Broker's
  // confirmed holding of the own session must be the generation the run was
  // armed with, the step's frozen version must equal that generation's
  // context version (§11.20.10), every fence must hold, and — for a Shell
  // call — the command must be the one registered for the generation while
  // package.json still has the registered digest, read within this
  // request's deadline (W6). One permit per step; the permit carries the
  // job key of the Broker execution created from the frozen arguments.
  private async authorizeWriteTool(
    input: Record<string, unknown>,
    cap: Grant,
    binding: WriteToolBinding,
  ) {
    const expected = binding.run;
    const run = this.runs.get(expected.runId);
    const step = this.modelSteps.get(expected.sessionId);
    const { deadline, toolName } = input;
    if (
      !run ||
      !step ||
      step.batch.length !== 1 ||
      step.batch[0] !== run ||
      Object.entries(this.binding(run)).some(
        ([key, value]) =>
          expected[key as keyof RunBinding] !== value || input[key] !== value,
      ) ||
      input.authSessionId !== run.who.authSessionId ||
      input.agentGeneration !== step.agentGeneration ||
      input.turn !== step.turn ||
      input.modelBindingId !== step.id ||
      bodyHash(parseStepMarker(input.modelStep)) !== bodyHash(step.stamp) ||
      typeof toolName !== 'string' ||
      !writeToolNames.includes(toolName as WriteToolName) ||
      !binding.tools.includes(toolName as WriteToolName) ||
      typeof input.toolCallId !== 'string' ||
      input.toolCallId.length < 1 ||
      input.toolCallId.length > 128 ||
      !Number.isSafeInteger(input.toolCallSeq) ||
      Number(input.toolCallSeq) < 1 ||
      typeof deadline !== 'number' ||
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      deadline > Date.now() + 2000 ||
      // The exact shape; a bash command is checked against the
      // registration below, after the shape.
      !isRecord(input.arguments) ||
      !writeToolArguments(
        toolName,
        input.arguments,
        toolName === 'bash' ? () => true : undefined,
      ) ||
      writePermitEnvelopeBytes(toolName, input.arguments) >
        writePermitEnvelopeLimit
    )
      return invalidModel();
    const current = () =>
      this.modelSteps.get(run.sessionId) === step &&
      !step.closed &&
      step.selection?.isCurrent() &&
      this.current([run]);
    if (step.writeToolUsed || !current()) return invalidModel();
    const noAuthority: () => never = () =>
      businessError(409, '当前会话没有可用的写入资格');
    // The write generation of the own session and the frozen version.
    const holding = binding.holding();
    if (
      !holding ||
      holding.expiresAt <= Date.now() ||
      holding.contextVersion !== step.contextVersion
    )
      noAuthority();
    binding.assertLease();
    if (toolName === 'bash') {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(0, Math.min(deadline, cap.expiresAt) - Date.now()),
      );
      timer.unref?.();
      const live = () => {
        if (!current() || Date.now() >= deadline) noAuthority();
      };
      try {
        live();
        const registered = await binding.registered(
          String(input.arguments.command),
          live,
          controller.signal,
        );
        if (!registered) businessError(409, '命令未随当前写代登记或已变化');
      } finally {
        clearTimeout(timer);
      }
    }
    const login = await this.read(run.who, run.requirementId, run.sessionId);
    const expiresAt = Math.min(
      cap.expiresAt,
      login.validBefore,
      step.validBefore ?? 0,
      run.expiresAt,
      deadline,
      holding.expiresAt,
      Date.now() + 2000,
    );
    // Single issue; and the generation is read again after the awaits, so
    // a takeover that landed meanwhile leaves everything at zero.
    const latest = binding.holding();
    if (
      step.writeToolUsed ||
      !current() ||
      expiresAt <= Date.now() ||
      !latest ||
      latest.generation !== holding.generation
    )
      return step.writeToolUsed ? invalidModel() : noAuthority();
    binding.assertLease();
    const request = writeToolRequest(
      toolName as WriteToolName,
      input.arguments,
    );
    if (!request) return invalidModel();
    const job =
      request.tool === 'file'
        ? binding.job?.(request, holding)
        : binding.shell?.(request, holding);
    if (!job) return invalidModel();
    const jobId = job.offer(
      run.who,
      run.requirementId,
      run.sessionId,
      step.contextVersion,
      bodyHash(input),
      expiresAt,
      () => !!current(),
    );
    step.writeToolJob = job;
    step.writeToolUsed = true;
    return { digest: cap.bodyHash, expiresAt, jobId };
  }
}
