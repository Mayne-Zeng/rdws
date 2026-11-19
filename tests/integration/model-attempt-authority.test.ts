import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { bodyHash, signGrant, verifyGrant } from '@rdws/dsh/access';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';

const route = 'https://fixture.invalid/v1/chat/completions';
const model = { provider: 'fixture', model: 'fixture-default' };

function fixture() {
  const generation = randomUUID();
  const key = randomUUID();
  const aud = 'rdws:bff:' + generation;
  const reads: string[][] = [];
  const state = {
    expires: Infinity,
    revision: 1,
    destination: route,
    active: true,
    read: async () => {},
    select: async () => {},
  };
  const runs = new ContextRuns(
    generation,
    (token) => verifyGrant(key, token, aud),
    async (who, _requirementId, _sessionId, related) => {
      reads.push([
        who.authSessionId,
        ...(related ?? []).map((actor) => actor.authSessionId),
      ]);
      await state.read();
      return {
        value: { snapshot: {}, digest: 'fixture' },
        validBefore: state.expires,
      };
    },
    () => false,
    async () => {
      const { revision, destination } = state;
      await state.select();
      return {
        ...model,
        revision: String(revision),
        routes: { chat: destination },
        isCurrent: () =>
          revision === state.revision && destination === state.destination,
      };
    },
  );
  const older = runs.admit(
    { userId: 'owner', authSessionId: 'first-login' },
    'requirement',
    'session',
    'first-prompt',
    'peer-a',
  );
  const newer = runs.admit(
    { userId: 'owner', authSessionId: 'second-login' },
    'requirement',
    'session',
    'second-prompt',
    'peer-b',
  );
  const position = {
    ...newer,
    agentGeneration: 'agent',
    turn: 1,
    relatedRuns: [{ ...older, agentGeneration: 'agent', turn: 1 }],
  };
  function newPosition() {
    const run = runs.admit(
      { userId: 'owner', authSessionId: 'new-agent-login' },
      'requirement',
      'session',
      randomUUID(),
      'peer-c',
    );
    return { ...run, agentGeneration: 'next-agent', turn: 1, relatedRuns: [] };
  }
  function signed(
    input: { runId: string },
    operation = 'context-read',
    hostGeneration: string = generation,
  ) {
    return signGrant(key, {
      aud,
      purpose: 'service',
      operation,
      hostGeneration,
      runId: input.runId,
      bodyHash: bodyHash(input),
    });
  }
  function prepareStep(
    number: number,
    sequence = number,
    requested = model,
    source = position,
  ) {
    return {
      ...source,
      modelStep: { ...requested, noteId: randomUUID(), step: number, sequence },
    };
  }
  const opened = new Map<string, ReturnType<typeof prepareStep>>();
  const openStep = (
    input: ReturnType<typeof prepareStep>,
    hostGeneration?: string,
  ) => runs.handle(input, signed(input, 'context-read', hostGeneration));
  async function step(
    number: number,
    sequence = number,
    requested = model,
    source = position,
  ) {
    const input = prepareStep(number, sequence, requested, source);
    const response = (await openStep(input)) as { modelBindingId?: string };
    expect(response.modelBindingId).toBeTypeOf('string');
    opened.set(response.modelBindingId!, input);
    return response.modelBindingId!;
  }
  async function release(step: string | ReturnType<typeof prepareStep>) {
    const input = typeof step === 'string' ? opened.get(step)! : step;
    return runs.handle(input, signed(input, 'model-step-release'));
  }
  function attempt(bindingId: string, signal = new AbortController().signal) {
    return {
      routeId: 'chat',
      destination: route,
      attemptId: randomUUID(),
      call: { id: randomUUID(), bindingId, sessionId: 'session', ...model },
      signal,
      isCurrent: () => state.active,
    };
  }
  return {
    runs,
    state,
    reads,
    step,
    newPosition,
    prepareStep,
    openStep,
    release,
    attempt,
  };
}

test('only the exact current model, route, session and attempt use the original login batch', async () => {
  const { runs, reads, step, attempt } = fixture();
  const id = await step(1);
  const request = attempt(id);
  const handoff = vi.fn(() => 'handed off');
  for (const invalid of [
    { ...request, call: { ...request.call, bindingId: undefined } },
    { ...request, call: { ...request.call, bindingId: randomUUID() } },
    { ...request, call: { ...request.call, sessionId: 'other-session' } },
    { ...request, call: { ...request.call, model: 'other-model' } },
    { ...request, call: { ...request.call, purpose: 'session-title' } },
    { ...request, destination: 'https://other.invalid/v1/chat/completions' },
    { ...request, routeId: 'other' },
  ])
    await expect(
      runs.authorizeModelAttempt(invalid, handoff),
    ).rejects.toMatchObject({ statusCode: 403 });
  expect(handoff).not.toHaveBeenCalled();
  await expect(runs.authorizeModelAttempt(request, handoff)).resolves.toBe(
    'handed off',
  );
  await expect(
    runs.authorizeModelAttempt(request, handoff),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(runs.authorizeModelAttempt(attempt(id), handoff)).resolves.toBe(
    'handed off',
  );
  expect(handoff).toHaveBeenCalledTimes(2);
  expect(reads).toEqual(
    Array.from({ length: 3 }, () => ['second-login', 'first-login']),
  );
});

test('reserving and releasing steps close earlier attempts even when readbacks arrive late', async () => {
  const { runs, state, step, release, attempt } = fixture();
  const first = await step(1);
  let finishRead!: () => void;
  state.read = () =>
    new Promise<void>((resolve) => {
      finishRead = resolve;
    });
  const oldRead = step(2).catch((error) => error);
  const handoff = vi.fn();
  await expect(
    runs.authorizeModelAttempt(attempt(first), handoff),
  ).rejects.toMatchObject({ statusCode: 403 });
  state.read = async () => {};
  await expect(
    step(3, 3, { ...model, model: 'other-model' }),
  ).rejects.toMatchObject({ statusCode: 403 });
  finishRead();
  expect(await oldRead).toMatchObject({ statusCode: 403 });
  await expect(step(3, 4)).rejects.toMatchObject({ statusCode: 403 });
  const current = await step(4, 5);
  await release(first);
  await expect(
    runs.authorizeModelAttempt(attempt(current), handoff),
  ).resolves.toBeUndefined();
  await release(current);
  await expect(
    runs.authorizeModelAttempt(attempt(current), handoff),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(handoff).toHaveBeenCalledOnce();
});

test('the exact signed step can close before any binding ID is issued', async () => {
  const { state, prepareStep, openStep, release, step } = fixture();
  const input = prepareStep(1);
  let finishRead!: () => void;
  state.read = () =>
    new Promise<void>((resolve) => {
      finishRead = resolve;
    });
  const open = openStep(input).catch((error) => error);
  await release(input);
  finishRead();
  expect(await open).toMatchObject({ statusCode: 403 });
  state.read = async () => {};
  await expect(step(1, 2)).rejects.toMatchObject({ statusCode: 403 });
  await expect(step(2, 3)).resolves.toBeTypeOf('string');
});

test('concurrent revalidation admits one physical write and only its verified retry can free the slot', async () => {
  const { runs, state, step, attempt } = fixture();
  const id = await step(1);
  let finishReads!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishReads = resolve;
  });
  let waiting = 0;
  state.read = async () => {
    waiting++;
    await gate;
  };
  const first = attempt(id);
  const write = vi.fn(() => 'submitted' as const);
  const current = runs.authorizeModelWireAttempt(first, write);
  const competing = runs.authorizeModelWireAttempt(attempt(id), write);
  void competing.catch(() => {});
  try {
    await expect.poll(() => waiting).toBe(2);
  } finally {
    finishReads();
  }
  const accepted = await current;
  await expect(competing).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    runs.authorizeModelWireAttempt(attempt(id), write),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(write).toHaveBeenCalledOnce();
  accepted.accept429();
  await expect(
    runs.authorizeModelWireAttempt(first, write),
  ).rejects.toMatchObject({ statusCode: 403 });
  const partial = await runs.authorizeModelWireAttempt(
    attempt(id),
    () => 'indeterminate',
  );
  partial.accept429();
  accepted.accept429();
  await expect(
    runs.authorizeModelWireAttempt(attempt(id), write),
  ).rejects.toMatchObject({ statusCode: 403 });
  const next = await step(2);
  await expect(
    runs.authorizeModelWireAttempt(attempt(next), write),
  ).resolves.toMatchObject({ outcome: 'submitted' });
  expect(write).toHaveBeenCalledTimes(2);
});

test('a known zero frees only the slot, with the earliest proven deadline delivered to the writer', async () => {
  const { runs, step, attempt, state } = fixture();
  const id = await step(1);
  state.expires = Date.now() + 10_000;
  const first = attempt(id);
  const zero = await runs.authorizeModelWireAttempt(first, (validBefore) => {
    expect(validBefore).toBe(state.expires);
    return 'not-sent';
  });
  expect(zero.outcome).toBe('not-sent');
  await expect(
    runs.authorizeModelWireAttempt(first, () => 'submitted'),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    runs.authorizeModelWireAttempt(attempt(id), () => {
      throw new Error('Fixture transport state lost');
    }),
  ).rejects.toThrow('Fixture transport state lost');
  await expect(
    runs.authorizeModelWireAttempt(attempt(id), () => 'submitted'),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test('a cold Host and a fresh Agent do not accept the previous signed run or its model binding', async () => {
  const { runs, step, prepareStep, openStep, newPosition, attempt } = fixture();
  const oldInput = prepareStep(1);
  const oldId = await step(1);
  runs.clear();
  const newRun = newPosition();
  const handoff = vi.fn();
  await expect(openStep(oldInput)).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    openStep(prepareStep(1, 1, model, newRun), 'stale-host'),
  ).rejects.toMatchObject({ statusCode: 403 });
  const current = await step(1, 1, model, newRun);
  await expect(
    runs.authorizeModelAttempt(attempt(oldId), handoff),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    runs.authorizeModelAttempt(attempt(current), handoff),
  ).resolves.toBeUndefined();
  expect(handoff).toHaveBeenCalledOnce();
});

test.each([
  'revoked',
  'expired',
  'revision',
  'route',
  'detached',
  'aborted',
  'released',
  'replaced',
  'agent-replaced',
] as const)(
  '%s while an attempt is waiting prevents synchronous handoff',
  async (reason) => {
    const { runs, state, step, newPosition, release, attempt } = fixture();
    const id = await step(1);
    const controller = new AbortController();
    const request = attempt(id, controller.signal);
    const handoff = vi.fn();
    let resume!: () => void, enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const hold = async () => {
      enter();
      await gate;
    };
    if (reason === 'revision' || reason === 'route') state.select = hold;
    else state.read = hold;
    const pending = runs
      .authorizeModelAttempt(request, handoff)
      .catch((error) => error);
    try {
      await entered;
      await expect(
        runs.authorizeModelAttempt(request, handoff),
      ).rejects.toMatchObject({ statusCode: 403 });
      if (reason === 'revoked') runs.revoke('first-login');
      if (reason === 'expired') state.expires = Date.now();
      if (reason === 'revision') state.revision++;
      if (reason === 'route')
        state.destination = 'https://changed.invalid/v1/chat/completions';
      if (reason === 'detached') state.active = false;
      if (reason === 'aborted') controller.abort();
      if (reason === 'released') await release(id);
      if (reason === 'replaced' || reason === 'agent-replaced') {
        state.read = async () => {};
        if (reason === 'replaced') await step(2);
        else await step(1, 2, model, newPosition());
      }
      resume();
      expect(await pending).toMatchObject({ statusCode: 403 });
      expect(handoff).not.toHaveBeenCalled();
    } finally {
      resume();
    }
  },
);
