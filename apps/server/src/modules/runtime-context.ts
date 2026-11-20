import { randomUUID } from 'node:crypto';
import { bodyHash, isRecord, onlyKeys, type Grant } from '@rdws/dsh/access';
import type {
  ModelCarrierRequest,
  ModelWireCommit,
  ModelWireOutcome,
} from '@rdws/dsh/web';
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
import type { FixtureToolProjection } from './model-egress-policy.ts';
import type { AttachmentManifest } from './model-attachment-egress.ts';
import { readWorkingDirectoryEdits } from './model-attachment-evidence.ts';
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
};
type EffectiveModel = {
  provider: string;
  model: string;
  revision: string;
  routes: Readonly<Record<string, string>>;
  isCurrent(): boolean;
};
type StepMarker = {
  sequence: number;
  step: number;
  noteId: string;
  provider: string;
  model: string;
};
type ModelStep = {
  id: string;
  stamp: StepMarker;
  batch: Run[];
  agentGeneration: string;
  turn: number;
  closed: boolean;
  selection?: EffectiveModel;
  validBefore?: number;
  contextVersion?: number;
  fixtureToolUsed?: true;
  fixtureToolJob?: NativeFixtureToolJob;
  fixtureWire?: FixtureWire;
  attempts: Set<string>;
  wireAttempt?: string;
  attachmentCalls?: Set<string>;
  attachment?: {
    callId: string;
    grant: string;
    validBefore: number;
    manifest: AttachmentManifest;
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
export class ContextRuns {
  private runs = new Map<string, Run>();
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
  ): RunBinding {
    if (
      this.closing(who.authSessionId, who.userId, requirementId) ||
      !requestId ||
      requestId.length > 128
    )
      businessError(403, '当前运行身份无效');
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
    for (const step of this.modelSteps.values()) step.fixtureToolJob?.cancel();
    this.runs.clear();
    this.nonces.clear();
    this.modelSteps.clear();
    this.titles.clear();
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
    if (!run) return;
    const step = this.modelSteps.get(run.sessionId);
    if (step?.batch.includes(run)) {
      step.closed = true;
      step.fixtureToolJob?.cancel();
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
    const grant = randomUUID();
    calls.add(callId);
    step.attachment = {
      callId,
      grant,
      validBefore: cap.expiresAt,
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
    return { bindingId: step.id, callId, grant };
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
  authorizeModelWireAttempt(
    request: ModelAttempt,
    write: (validBefore: number) => ModelWireOutcome,
    fixtureWire?: FixtureWire,
  ): Promise<ModelWireCommit> {
    if (request.call.purpose === 'session-title')
      return this.authorizeTitleWire(request, write);
    return this.withAuthorizedAttempt(
      request,
      (step, validBefore) => {
        const { attemptId } = request;
        step.wireAttempt = attemptId;
        const outcome = write(validBefore);
        if (outcome === 'not-sent') step.wireAttempt = undefined;
        return {
          outcome,
          accept429: () => {
            if (outcome === 'submitted' && step.wireAttempt === attemptId)
              step.wireAttempt = undefined;
          },
        };
      },
      fixtureWire,
    );
  }
  fixtureWire(request: ModelAttempt) {
    if (request.routeId !== 'main' || request.call.purpose !== undefined)
      return;
    const step = this.modelSteps.get(request.call.sessionId ?? '');
    if (step && !step.closed && request.call.bindingId === step.id)
      return step.fixtureWire;
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
      !step ||
      step.closed ||
      step.wireAttempt !== undefined ||
      step.fixtureWire !== fixtureWire ||
      (fixtureWire && !this.lockModelAuthority) ||
      !selection ||
      !this.selectModel ||
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
    const run = step.batch[0]!;
    const related = step.batch.slice(1).map(({ who }) => who);
    const shared = this.lockModelAuthority
      ? undefined
      : await this.read(run.who, run.requirementId, run.sessionId, related);
    const fresh = await this.selectModel(
      run.who,
      run.requirementId,
      run.sessionId,
    );
    const finalize = (validBefore: number) => {
      const deadline = Math.min(
        validBefore,
        fixtureWire ? (step.validBefore ?? 0) : Infinity,
        attachmentDeadline,
        ...step.batch.map(({ expiresAt }) => expiresAt),
      );
      if (
        !fresh ||
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
        step.wireAttempt !== undefined ||
        !this.current(step.batch) ||
        !(deadline > Date.now())
      )
        return invalidModel();
      fixtureWire?.job.assertWireLease();
      return send(step, deadline);
    };
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
  async handle(
    input: unknown,
    token: unknown,
    reply?: (result: unknown, validBefore: number) => void,
    fixtureToolRun?: RunBinding,
    fixtureToolJob?: NativeFixtureToolJob,
  ) {
    const cap = this.verify(token),
      now = Date.now();
    const fixtureEnabled = fixtureToolRun && process.env.RDWS_MODE === 'test';
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
        'model-title-origin',
        'model-title-prepare',
        'model-title-close',
        ...(fixtureEnabled ? ['fixture-tool-permit'] : []),
        ...(fixtureOperation ? [fixtureOperation] : []),
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
    if (cap.operation?.startsWith('model-attachment-')) {
      const result = this.handleAttachment(input, cap);
      reply?.(result, cap.expiresAt);
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
        !this.selectModel ||
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
      (await this.selectModel!(run.who, run.requirementId, run.sessionId));
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
}
