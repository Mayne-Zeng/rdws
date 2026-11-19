import { randomUUID } from 'node:crypto';
import { bodyHash, isRecord, type Grant } from '@rdws/dsh/access';
import type { ModelCarrierRequest } from '@rdws/dsh/web';
import {
  businessError,
  digestOf,
  type Actor,
  type createBusiness,
} from './business.ts';
type Detail = Awaited<ReturnType<ReturnType<typeof createBusiness>['read']>>;
export function contextSnapshot(data: Detail) {
  const r = data.requirement;
  const summarizedFields = {
    description: r.description.length > 1500,
    acceptance: r.acceptance.length > 1500,
    tasks: false,
    participants: data.participants.some((p) => p.name.length > 40),
  };
  const snapshot = {
    requirementId: r.id,
    title: r.title,
    description: r.description.slice(0, 1500),
    acceptance: r.acceptance.slice(0, 1500),
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
    fullView:
      '/?project=' +
      encodeURIComponent(r.projectId) +
      '&requirement=' +
      encodeURIComponent(r.id) +
      '&view=overview',
  };
  while (
    Buffer.byteLength(JSON.stringify(snapshot)) > 24000 &&
    snapshot.tasks.length
  ) {
    snapshot.tasks.pop();
    summarizedFields.tasks = true;
    snapshot.truncated = true;
  }
  while (
    Buffer.byteLength(JSON.stringify(snapshot)) > 24000 &&
    snapshot.participants.length > 2
  ) {
    snapshot.participants.pop();
    summarizedFields.participants = true;
    snapshot.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 24000)
    businessError(503, '当前上下文过大，请精简需求说明后重试');
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
  attempts: Set<string>;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
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
  ) {}
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
    for (const [id, r] of this.runs)
      if (
        r.who.authSessionId === authSessionId &&
        (!requirementId || r.requirementId === requirementId)
      )
        this.discard(id);
  }
  revokeUser(userId: string, requirementId?: string) {
    for (const [id, r] of this.runs)
      if (
        r.who.userId === userId &&
        (!requirementId || r.requirementId === requirementId)
      )
        this.discard(id);
  }
  clear() {
    this.runs.clear();
    this.nonces.clear();
    this.modelSteps.clear();
  }
  discard(runId: string) {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    if (!run) return;
    const step = this.modelSteps.get(run.sessionId);
    if (step?.batch.includes(run)) {
      step.closed = true;
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
  reconcile(candidates: string[], active: string[]) {
    const keep = new Set(active);
    for (const id of candidates) if (!keep.has(id)) this.discard(id);
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
  async authorizeModelAttempt<T>(
    request: Pick<
      ModelCarrierRequest,
      'routeId' | 'destination' | 'attemptId' | 'call' | 'signal' | 'isCurrent'
    >,
    send: () => T,
  ): Promise<T> {
    const { call, attemptId, routeId, destination, signal } = request;
    const step =
      typeof call.sessionId === 'string'
        ? this.modelSteps.get(call.sessionId)
        : undefined;
    const selection = step?.selection;
    if (
      !step ||
      step.closed ||
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
    const { validBefore } = await this.read(
      run.who,
      run.requirementId,
      run.sessionId,
      step.batch.slice(1).map(({ who }) => who),
    );
    const fresh = await this.selectModel(
      run.who,
      run.requirementId,
      run.sessionId,
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
      step.closed ||
      !this.current(step.batch) ||
      !(validBefore > Date.now())
    )
      return invalidModel();
    return send();
  }
  async handle(
    input: unknown,
    token: unknown,
    reply?: (result: unknown, validBefore: number) => void,
  ) {
    const cap = this.verify(token),
      now = Date.now();
    for (const [nonce, expiry] of this.nonces)
      if (expiry <= now) this.nonces.delete(nonce);
    if (
      !cap ||
      cap.purpose !== 'service' ||
      !['context-read', 'context-release', 'model-step-release'].includes(
        cap.operation ?? '',
      ) ||
      cap.hostGeneration !== this.generation ||
      !isRecord(input) ||
      cap.bodyHash !== bodyHash(input) ||
      cap.runId !== input.runId ||
      this.nonces.has(cap.nonce)
    )
      businessError(403, '上下文服务请求未获授权');
    this.nonces.set(cap.nonce, cap.expiresAt);
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
      )
        current.closed = true;
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
          this.discard(existing.runId);
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
    if (input.modelStep !== undefined) {
      const stamp = parseStepMarker(input.modelStep);
      const previous = this.modelSteps.get(run.sessionId);
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
      result = { ...value, modelBindingId: modelStep.id };
    }
    reply?.(result, validBefore);
    return result;
  }
}
