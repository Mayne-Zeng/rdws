import { randomUUID } from 'node:crypto';
import { bodyHash, isRecord, type Grant } from '@rdws/dsh/access';
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
    permissions: data.permissions,
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
export class ContextRuns {
  private runs = new Map<string, Run>();
  private nonces = new Map<string, number>();
  constructor(
    readonly generation: string,
    private verify: (token: unknown) => Grant | undefined,
    private read: (
      who: Actor,
      id: string,
      sessionId: string,
      relatedActors?: Actor[],
    ) => Promise<unknown>,
    private closing: (authSessionId: string) => boolean,
  ) {}
  admit(
    who: Actor,
    requirementId: string,
    sessionId: string,
    requestId: string,
    peerNonce: string,
  ): RunBinding {
    if (this.closing(who.authSessionId) || !requestId || requestId.length > 128)
      businessError(403, '当前运行身份无效');
    const now = Date.now();
    for (const [id, run] of this.runs)
      if (run.expiresAt <= now) this.runs.delete(id);
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
  revoke(authSessionId: string) {
    for (const [id, r] of this.runs)
      if (r.who.authSessionId === authSessionId) this.runs.delete(id);
  }
  clear() {
    this.runs.clear();
    this.nonces.clear();
  }
  discard(runId: string) {
    this.runs.delete(runId);
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
    for (const id of candidates) if (!keep.has(id)) this.runs.delete(id);
  }
  async handle(input: unknown, token: unknown) {
    const cap = this.verify(token),
      now = Date.now();
    for (const [nonce, expiry] of this.nonces)
      if (expiry <= now) this.nonces.delete(nonce);
    if (
      !cap ||
      cap.purpose !== 'service' ||
      !['context-read', 'context-release'].includes(cap.operation ?? '') ||
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
    if (cap.operation === 'context-release') {
      for (const binding of inputs) {
        const existing = this.runs.get(String(binding.runId));
        if (
          existing &&
          Object.entries(this.binding(existing)).every(
            ([key, value]) => binding[key] === value,
          )
        )
          this.runs.delete(existing.runId);
      }
      return { released: true };
    }
    const batch: Run[] = [];
    for (const binding of inputs) {
      const related = this.runs.get(String(binding.runId));
      if (
        !related ||
        related.expiresAt <= now ||
        this.closing(related.who.authSessionId) ||
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
      this.closing(run.who.authSessionId) ||
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
    const result = await this.read(
      run.who,
      run.requirementId,
      run.sessionId,
      batch.slice(1).map((r) => r.who),
    );
    if (
      batch.some(
        (r) =>
          this.runs.get(r.runId) !== r ||
          this.closing(r.who.authSessionId) ||
          r.expiresAt <= Date.now(),
      )
    )
      businessError(403, '当前运行绑定已失效');
    return result;
  }
}
