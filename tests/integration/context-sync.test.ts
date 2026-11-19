import { test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ContextRuns,
  contextSnapshot,
} from '../../apps/server/src/modules/runtime-context.ts';
import { signGrant, verifyGrant, bodyHash } from '@rdws/dsh/access';
import { installContext } from '../../dsh/plugins/rdws-access/context.mjs';
import { NativeWebHost } from '@rdws/dsh/web';
import {
  createProjectRuntimes,
  type ProjectRuntime,
} from '../../apps/server/src/modules/native-projects.ts';
test('the native stream observer preserves the AsyncIterable contract', () => {
  const callbacks = new Map<string, unknown>();
  installContext(
    { on: (name: string, handler: unknown) => callbacks.set(name, handler) },
    { contextEvidenceFile: '/dev/null' },
    'synthetic',
    () => {},
    async () => ({}),
  );
  const stream = callbacks.get('llm/stream') as (
    options: { messages: unknown[] },
    next: () => AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>;
  const result = stream({ messages: [] }, () =>
    (async function* () {
      yield { type: 'finish' };
    })(),
  );
  expect(typeof result[Symbol.asyncIterator]).toBe('function');
});
test('context reads bind the actual login, native request and Agent generation', async () => {
  const key = randomUUID(),
    generation = randomUUID(),
    aud = 'rdws:bff:' + generation;
  let seen = '';
  const runs = new ContextRuns(
    generation,
    (token) => verifyGrant(key, token, aud),
    async (who) => {
      seen = who.authSessionId;
      return { value: { stage: 'testing' }, validBefore: Infinity };
    },
    () => false,
  );
  const run = runs.admit(
    { userId: 'u', authSessionId: 'login' },
    'r',
    's',
    'prompt',
    'peer',
  );
  const input = { ...run, agentGeneration: 'agent', turn: 1 };
  const ticket = (body: typeof input, operation = 'context-read') =>
    signGrant(key, {
      aud,
      purpose: 'service',
      operation,
      bodyHash: bodyHash(body),
      runId: run.runId,
      hostGeneration: generation,
    });
  const firstTicket = ticket(input);
  expect(await runs.handle(input, firstTicket)).toEqual({ stage: 'testing' });
  await expect(runs.handle(input, firstTicket)).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(seen).toBe('login');
  for (const invalid of [
    { ...input, sessionId: 'other' },
    { ...input, requirementId: 'foreign' },
    { ...input, peerNonce: 'other' },
    { ...input, agentGeneration: 'old' },
  ])
    await expect(runs.handle(invalid, ticket(invalid))).rejects.toMatchObject({
      statusCode: 403,
    });
  await expect(
    runs.handle(input, ticket(input, 'other')),
  ).rejects.toMatchObject({ statusCode: 403 });
  runs.revoke('login');
  await expect(runs.handle(input, ticket(input))).rejects.toMatchObject({
    statusCode: 403,
  });
});
test.each(['logout', 'demand fence'] as const)(
  '%s while a context read is pending discards the result',
  async (kind) => {
    const key = randomUUID(),
      generation = randomUUID(),
      aud = 'rdws:bff:' + generation;
    let closing = false,
      release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = new ContextRuns(
      generation,
      (t) => verifyGrant(key, t, aud),
      async (_who, requirementId) => {
        if (requirementId === 'r') await barrier;
        return { value: { requirementId }, validBefore: Infinity };
      },
      (_authSession, _userId, requirementId) =>
        closing && (kind === 'logout' || requirementId === 'r'),
    );
    const run = runs.admit(
      { userId: 'u', authSessionId: 'login' },
      'r',
      's',
      'prompt',
      'peer',
    );
    const body = { ...run, agentGeneration: 'agent', turn: 1 };
    const token = signGrant(key, {
      aud,
      purpose: 'service',
      operation: 'context-read',
      bodyHash: bodyHash(body),
      runId: run.runId,
      hostGeneration: generation,
    });
    const reply = vi.fn();
    const result = runs.handle(body, token, reply);
    closing = true;
    release();
    await expect(result).rejects.toMatchObject({ statusCode: 403 });
    expect(reply).not.toHaveBeenCalled();
    if (kind === 'demand fence') {
      const neighbor = runs.admit(
        { userId: 'u', authSessionId: 'login' },
        'neighbor',
        'other-session',
        'next',
        'peer',
      );
      const input = { ...neighbor, agentGeneration: 'agent', turn: 1 };
      await expect(
        runs.handle(
          input,
          signGrant(key, {
            aud,
            purpose: 'service',
            operation: 'context-read',
            bodyHash: bodyHash(input),
            runId: neighbor.runId,
            hostGeneration: generation,
          }),
        ),
      ).resolves.toEqual({ requirementId: 'neighbor' });
    }
  },
);
test('an invalid earlier input cannot borrow the final prompt identity', async () => {
  const callbacks = new Map<string, unknown>(),
    routes = new Map<string, (input: Record<string, unknown>) => unknown>();
  const request = vi.fn(async (_body: unknown, token: string) => {
    if (
      verifyGrant('synthetic', token, 'rdws:bff:host')?.operation ===
      'context-read'
    )
      throw new Error('The invalid batch must never request context');
    return { released: true };
  });
  installContext(
    { on: (name: string, handler: unknown) => callbacks.set(name, handler) },
    {
      contextGeneration: 'host',
      contextEvidenceFile: '/dev/null',
    },
    'synthetic',
    (name: string, handler: (input: Record<string, unknown>) => unknown) =>
      routes.set(name, handler),
    request,
  );
  routes.get('run')!({
    runId: 'current',
    hostGeneration: 'host',
    sessionId: 's',
    requirementId: 'r',
    requestId: 'new',
    peerNonce: 'new-peer',
  });
  const agent = { session: { id: 's' }, ctx: { emit: () => {} } };
  const enter = callbacks.get('agent/pre-step') as (
    input: unknown,
    next: () => Promise<unknown>,
  ) => Promise<{ kind: string }>;
  const result = await enter(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({
      kind: 'enter',
      messages: [
        {
          id: 'old-message',
          source: {
            kind: 'user',
            rpcId: 'old',
            principal: { kind: 'rdws', nonce: 'old-peer' },
          },
        },
        {
          id: 'new-message',
          source: {
            kind: 'user',
            rpcId: 'new',
            principal: { kind: 'rdws', nonce: 'new-peer' },
          },
        },
      ],
    }),
  );
  expect(result.kind).toBe('reject');
  expect(
    request.mock.calls.every(
      ([, token]) =>
        verifyGrant('synthetic', token, 'rdws:bff:host')?.operation ===
        'context-release',
    ),
  ).toBe(true);
});
test('related inputs are checked against every original login', async () => {
  const key = randomUUID(),
    generation = randomUUID(),
    aud = 'rdws:bff:' + generation;
  const runs = new ContextRuns(
    generation,
    (t) => verifyGrant(key, t, aud),
    async () => ({ value: { ok: true }, validBefore: Infinity }),
    () => false,
  );
  const old = runs.admit(
    { userId: 'u', authSessionId: 'old' },
    'r',
    's',
    'old',
    'old-peer',
  );
  const current = runs.admit(
    { userId: 'u', authSessionId: 'new' },
    'r',
    's',
    'new',
    'new-peer',
  );
  runs.revoke('old');
  const body = {
    ...current,
    agentGeneration: 'a',
    turn: 1,
    relatedRuns: [{ ...old, agentGeneration: 'a', turn: 1 }],
  };
  const token = signGrant(key, {
    aud,
    purpose: 'service',
    operation: 'context-read',
    bodyHash: bodyHash(body),
    runId: current.runId,
    hostGeneration: generation,
  });
  await expect(runs.handle(body, token)).rejects.toMatchObject({
    statusCode: 403,
  });
});
test('earliest related-login expiry rejects the context before synchronous reply', async () => {
  const key = randomUUID(),
    generation = randomUUID();
  const aud = 'rdws:bff:' + generation;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.useFakeTimers();
  try {
    const oldExpiry = Date.now() + 100;
    const read = vi.fn(
      async (
        _actor,
        _requirement,
        _session,
        related: { authSessionId: string }[] = [],
      ) => {
        const validBefore = related.some(
          (actor) => actor.authSessionId === 'old',
        )
          ? oldExpiry
          : Infinity;
        await barrier;
        return { value: { snapshot: 'authorized content' }, validBefore };
      },
    );
    const runs = new ContextRuns(
      generation,
      (token) => verifyGrant(key, token, aud),
      read,
      () => false,
    );
    const old = runs.admit(
      { userId: 'u', authSessionId: 'old' },
      'r',
      's',
      'old-key',
      'peer',
    );
    const current = runs.admit(
      { userId: 'u', authSessionId: 'current' },
      'r',
      's',
      'new-key',
      'peer',
    );
    const body = {
      ...current,
      turn: 1,
      agentGeneration: 'a',
      relatedRuns: [{ ...old, turn: 1, agentGeneration: 'a' }],
    };
    const sign = (input: typeof body | Omit<typeof body, 'relatedRuns'>) =>
      signGrant(key, {
        aud,
        purpose: 'service',
        operation: 'context-read',
        hostGeneration: generation,
        runId: current.runId,
        bodyHash: bodyHash(input),
      });
    const reply = vi.fn();
    const response = runs
      .handle(body, sign(body), reply)
      .catch((error) => error);
    expect(read.mock.calls[0]?.[3]).toEqual([
      { userId: 'u', authSessionId: 'old' },
    ]);
    vi.setSystemTime(oldExpiry);
    release();
    expect(await response).toMatchObject({ statusCode: 403 });
    expect(reply).not.toHaveBeenCalled();
    const single = { ...current, turn: 1, agentGeneration: 'a' };
    await expect(runs.handle(single, sign(single), reply)).resolves.toEqual({
      snapshot: 'authorized content',
    });
    expect(reply).toHaveBeenCalledOnce();
  } finally {
    release();
    vi.useRealTimers();
  }
});

test('project runtimes share four context reads while release can still complete', async () => {
  const key = randomUUID();
  const release: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  const read = vi.fn(async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    throw new Error('Synthetic database completion');
  });
  const fixtureRoot = '/tmp/rdws-context-budget-test';
  const verifier = vi
    .spyOn(NativeWebHost.prototype, 'verifyContext')
    .mockImplementation(function (this: NativeWebHost, token) {
      return verifyGrant(key, token, 'rdws:bff:' + this.contextGeneration);
    });
  const projects = createProjectRuntimes(
    fixtureRoot,
    undefined,
    new NativeWebHost(fixtureRoot),
    {} as Parameters<typeof createProjectRuntimes>[3],
    { readWithDeadline: read } as unknown as Parameters<
      typeof createProjectRuntimes
    >[4],
    () => false,
    new Map([['neighbor', fixtureRoot]]),
  );
  try {
    const first = await projects.get('poc'),
      neighbor = await projects.get('neighbor');
    function request(runtime: ProjectRuntime) {
      const run = runtime.runs.admit(
        { userId: 'u', authSessionId: 's' },
        'd',
        randomUUID(),
        'prompt',
        'peer',
      );
      const body = { ...run, turn: 1, agentGeneration: 'a' };
      return (operation = 'context-read') =>
        runtime.runs.handle(
          body,
          signGrant(key, {
            aud: 'rdws:bff:' + run.hostGeneration,
            purpose: 'service',
            operation,
            hostGeneration: run.hostGeneration,
            runId: run.runId,
            bodyHash: bodyHash(body),
          }),
        );
    }
    for (const project of [first, neighbor, first, neighbor])
      pending.push(request(project)().catch((error) => error));
    expect(read).toHaveBeenCalledTimes(4);
    const busy = request(neighbor);
    await expect(busy()).rejects.toMatchObject({ statusCode: 503 });
    await expect(busy('context-release')).resolves.toEqual({ released: true });
    expect(read).toHaveBeenCalledTimes(4);
    release[0]!();
    expect(await pending[0]).toEqual(
      new Error('Synthetic database completion'),
    );
    pending.push(request(neighbor)().catch((error) => error));
    expect(read).toHaveBeenCalledTimes(5);
  } finally {
    for (const finish of release) finish();
    await Promise.all(pending);
    await projects.close();
    verifier.mockRestore();
  }
});
test('summaries mark truncated fields, keep a complete-view link and enforce a byte budget', () => {
  const data = {
    requirement: {
      id: 'r',
      projectId: 'p',
      title: 'Synthetic',
      description: '字'.repeat(8000),
      acceptance: '验'.repeat(8000),
      leadId: 'u',
      contextVersion: 1,
      stage: 'testing',
    },
    permissions: { userId: 'u', codeWrite: false },
    participants: [{ id: 'u', name: 'lead', roles: ['developer'] }],
    tasks: Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      title: '任'.repeat(160),
      status: 'todo',
      assigneeId: 'u',
    })),
    events: [],
  } as unknown as Parameters<typeof contextSnapshot>[0];
  const { snapshot } = contextSnapshot(data);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.summarizedFields.description).toBe(true);
  expect(snapshot.summarizedFields.acceptance).toBe(true);
  expect(snapshot.fullView).toContain('requirement=r');
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
    24000,
  );
});

test.each(['before-pre-step', 'downstream-reject'] as const)(
  'claimed input is retired on %s while real queued input survives',
  async (phase) => {
    const callbacks = new Map<string, unknown>(),
      routes = new Map<string, (input: Record<string, unknown>) => unknown>();
    installContext(
      { on: (name: string, handler: unknown) => callbacks.set(name, handler) },
      { contextGeneration: 'host', contextEvidenceFile: '/dev/null' },
      'synthetic',
      (name: string, handler: (input: Record<string, unknown>) => unknown) =>
        routes.set(name, handler),
      async () => ({ released: true }),
    );
    const emit = (name: string, args: unknown) =>
      (callbacks.get(name) as ((args: unknown) => unknown) | undefined)?.(args);
    const agent = { session: { id: 's' }, ctx: { emit: () => {} } };
    emit('agent/created', { agent });
    for (const id of ['claimed', 'queued']) {
      routes.get('run')!({
        runId: id,
        hostGeneration: 'host',
        sessionId: 's',
        requirementId: 'r',
        requestId: id,
        peerNonce: 'peer',
      });
      emit('agent/inbox/inserted', {
        agent,
        message: {
          source: {
            kind: 'user',
            rpcId: id,
            principal: { kind: 'rdws', nonce: 'peer' },
          },
        },
      });
    }
    emit('agent/inbox/claimed', {
      agent,
      turn: 1,
      message: {
        source: {
          kind: 'user',
          rpcId: 'claimed',
          principal: { kind: 'rdws', nonce: 'peer' },
        },
      },
    });
    if (phase === 'downstream-reject')
      await (
        callbacks.get('agent/pre-step') as (
          input: unknown,
          next: () => Promise<unknown>,
        ) => Promise<unknown>
      )(
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'reject' }),
      );
    emit('agent/status', { agent, status: 'idle' });
    expect(routes.get('runs.active')!({})).toEqual({ runIds: ['queued'] });
  },
);

test('an authorized insertion retires only its Agent’s recovered RDWS inputs without a current run', () => {
  const callbacks = new Map<string, (args: unknown) => void>();
  const routes = new Map<string, (input: Record<string, unknown>) => unknown>();
  installContext(
    {
      on: (name: string, handler: (args: unknown) => void) =>
        callbacks.set(name, handler),
    },
    { contextGeneration: 'host', contextEvidenceFile: '/dev/null' },
    'synthetic',
    (name: string, handler: (input: Record<string, unknown>) => unknown) =>
      routes.set(name, handler),
    async () => ({ released: true }),
  );
  const emit = (name: string, args: unknown) => callbacks.get(name)!(args);
  const admit = (id: string, sessionId = 'recovered') =>
    routes.get('run')!({
      runId: id,
      hostGeneration: 'host',
      sessionId,
      requirementId: 'r',
      requestId: id,
      peerNonce: 'peer',
      authSessionId: 'login',
    });
  const input = (id: string, kind = 'user', principal = 'rdws') => ({
    id,
    source: {
      kind,
      rpcId: id,
      principal: { kind: principal, userId: 'user', nonce: 'peer' },
    },
  });
  const removed: string[] = [];
  const inbox = {
    nextStep: [input('stale-step', 'retry'), input('retained')],
    nextTurn: [
      input('stale-turn'),
      input('explicit-owner', 'user', 'owner'),
      input('restored-binding'),
    ],
    remove: (id: string) => {
      removed.push(id);
      return true;
    },
  };
  const agent = { session: { id: 'recovered' }, inbox };
  admit('retained');
  emit('agent/created', { agent, source: 'resume' });
  expect(removed).toEqual([]);
  emit('agent/inbox/inserted', { agent, message: input('no-run') });
  expect(removed).toEqual([]);
  admit('wrong-session', 'neighbor');
  emit('agent/inbox/inserted', { agent, message: input('wrong-session') });
  expect(removed).toEqual([]);

  admit('restored-binding');
  const newMessage = input('new');
  admit(newMessage.id);
  inbox.nextTurn.push(newMessage);
  emit('agent/inbox/inserted', { agent, message: newMessage });
  expect(removed).toEqual(['stale-step', 'stale-turn']);
  expect(routes.get('run.status')!({ runId: 'new' })).toEqual({ seen: true });
  emit('agent/inbox/inserted', { agent, message: newMessage });
  expect(removed).toEqual(['stale-step', 'stale-turn']);

  const startup = { session: { id: 'startup' }, inbox };
  emit('agent/created', { agent: startup, source: 'startup' });
  admit('new-startup', 'startup');
  emit('agent/inbox/inserted', {
    agent: startup,
    message: input('new-startup'),
  });
  expect(removed).toEqual(['stale-step', 'stale-turn']);

  const early = input('new-before-created');
  const revoked = [input('revoked-first'), input('revoked-last')];
  const neighbor = {
    session: { id: 'neighbor' },
    inbox: {
      nextStep: [],
      nextTurn: [input('stale-neighbor'), revoked[0]!, early, revoked[1]!],
      remove: inbox.remove,
    },
  };
  for (const message of [revoked[0]!, early, revoked[1]!]) {
    admit(message.id, 'neighbor');
    emit('agent/inbox/inserted', { agent: neighbor, message });
    if (message !== early) routes.get('run.cancel')!({ runId: message.id });
  }
  expect(removed).toEqual(['stale-step', 'stale-turn']);
  emit('agent/created', { agent: neighbor, source: 'resume' });
  expect(removed).toEqual(['stale-step', 'stale-turn', 'stale-neighbor']);

  const liveReplacement = {
    nextStep: [input('stale-with-discard-hook')],
    nextTurn: [input('restored-replaced')],
    remove(id: string) {
      removed.push(id);
      this.nextTurn[0] = input('restored-replaced', 'user', 'owner');
      return true;
    },
  };
  const replacing = { session: { id: 'replacing' }, inbox: liveReplacement };
  emit('agent/created', { agent: replacing, source: 'resume' });
  const replacementTrigger = input('new-after-replacement');
  admit(replacementTrigger.id, 'replacing');
  liveReplacement.nextTurn.push(replacementTrigger);
  emit('agent/inbox/inserted', {
    agent: replacing,
    message: replacementTrigger,
  });
  expect(removed).toEqual([
    'stale-step',
    'stale-turn',
    'stale-neighbor',
    'stale-with-discard-hook',
  ]);

  const failedTrigger = input('new-with-removal-failure');
  const failed = {
    session: { id: 'failed' },
    inbox: {
      nextStep: [input('unremoved')],
      nextTurn: [failedTrigger],
      remove() {
        throw new Error('Fixture inbox append failure');
      },
    },
  };
  admit(failedTrigger.id, 'failed');
  emit('agent/inbox/inserted', { agent: failed, message: failedTrigger });
  expect(() =>
    emit('agent/created', { agent: failed, source: 'resume' }),
  ).not.toThrow();
  expect(failed.inbox.nextStep).toEqual([input('unremoved')]);
  expect(routes.get('run.status')!({ runId: failedTrigger.id })).toEqual({
    seen: true,
  });
});
