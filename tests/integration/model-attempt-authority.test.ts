import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { bodyHash, signGrant, verifyGrant } from '@rdws/dsh/access';
import type { WorkingDirectoryEdit } from '../../apps/server/src/modules/model-attachment-evidence.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';

const route = 'https://fixture.invalid/v1/chat/completions';
const model = { provider: 'fixture', model: 'fixture-default' };
const attachmentRoutes = {
  files: 'https://127.0.0.1:4317/v1/files',
  messages: 'https://127.0.0.1:4317/v1/messages',
};

function fixture(titleEnabled = false, attachmentEnabled = false) {
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
        routes: {
          chat: destination,
          ...(attachmentEnabled ? attachmentRoutes : {}),
        },
        isCurrent: () =>
          revision === state.revision && destination === state.destination,
      };
    },
    titleEnabled || attachmentEnabled
      ? async (who, _requirement, _session, _related, write) => {
          reads.push([who.authSessionId]);
          return write(state.expires);
        }
      : undefined,
    titleEnabled,
    attachmentEnabled
      ? {
          projectId: 'fixture-project',
          credentialGeneration: 'configured-generation',
        }
      : undefined,
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
    opened,
    openStep,
    release,
    attempt,
    position,
    signed,
  };
}

async function prepareFirstTitle() {
  const f = fixture(true);
  await f.step(1);
  const source = {
    ...f.position.relatedRuns[0]!,
    sourceSeq: 12,
    sourceId: randomUUID(),
  };
  const origin = (await f.runs.handle(
    source,
    f.signed(source, 'model-title-origin'),
  )) as { originId: string; expiresAt: number };
  const release = { ...f.position, titleDisposition: 'normal' };
  await f.runs.handle(release, f.signed(release, 'context-release'));
  const prepare = {
    ...source,
    originId: origin.originId,
    callId: randomUUID(),
  };
  const ready = (await f.runs.handle(
    prepare,
    f.signed(prepare, 'model-title-prepare'),
  )) as { bindingId: string };
  await expect(
    f.runs.handle(prepare, f.signed(prepare, 'model-title-prepare')),
  ).rejects.toThrow();
  const attempt = f.attempt(ready.bindingId);
  const request = {
    ...attempt,
    call: { ...attempt.call, id: prepare.callId, purpose: 'session-title' },
  };
  return { f, origin, prepare, request };
}

test('a prepared first-message title keeps only its original login after the main run retires', async () => {
  const { f, request } = await prepareFirstTitle();
  const write = vi.fn(() => 'submitted' as const);
  await expect(
    f.runs.authorizeModelWireAttempt(
      { ...request, call: { ...request.call, id: randomUUID() } },
      write,
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  const commit = await f.runs.authorizeModelWireAttempt(request, write);
  expect(commit.outcome).toBe('submitted');
  expect(f.reads.at(-1)).toEqual(['first-login']);
  commit.accept429();
  await expect(
    f.runs.authorizeModelWireAttempt(
      { ...request, attemptId: randomUUID() },
      write,
    ),
  ).rejects.toThrow();
  expect(write).toHaveBeenCalledOnce();
});

test.each(['expired', 'closed', 'cold'] as const)(
  'a %s title cannot use a prepared connection or be prepared again',
  async (reason) => {
    const { f, origin, prepare, request } = await prepareFirstTitle();
    const write = vi.fn(() => 'submitted' as const);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (reason === 'expired')
        clock = vi.spyOn(Date, 'now').mockReturnValue(origin.expiresAt);
      if (reason === 'closed') {
        await f.runs.handle(prepare, f.signed(prepare, 'model-title-close'));
      }
      if (reason === 'cold') f.runs.clear();
      await expect(
        f.runs.authorizeModelWireAttempt(request, write),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        f.runs.handle(prepare, f.signed(prepare, 'model-title-prepare')),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(write).not.toHaveBeenCalled();
    } finally {
      clock?.mockRestore();
    }
  },
);

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

test('the attachment grant binds the original batch and retires by call', async () => {
  const f = fixture(false, true);
  const bindingId = await f.step(1);
  const {
    relatedRuns: [source],
    ...position
  } = f.opened.get(bindingId)!;
  const image = {
    runId: source!.runId,
    requestId: source!.requestId,
    peerNonce: source!.peerNonce,
    authSessionId: 'first-login',
    userId: 'owner',
    messageId: randomUUID(),
    blockIndex: 1,
    attachmentId: 'sha256:' + 'a'.repeat(64),
    mediaType: 'image/png',
    bytes: 20,
    sha256: 'b'.repeat(64),
    handleSha256: 'd'.repeat(64),
  };
  const callId = randomUUID();
  const userContentSha256 = bodyHash([['image']]);
  const frame = {
    ...position,
    callId,
    bindingId,
    images: [image],
    userContentSha256,
    workingDirectoryEdits: [] as readonly WorkingDirectoryEdit[],
    projectedUserContentSha256: userContentSha256,
  };
  const prepare = (input = frame, hostGeneration?: string) =>
    f.runs.handle(
      input,
      f.signed(input, 'model-attachment-prepare', hostGeneration),
    );
  for (const invalid of [
    { ...frame, images: [{ ...image, authSessionId: 'second-login' }] },
    { ...frame, images: [{ ...image, userId: 'different-actor' }] },
    { ...frame, images: [{ ...image, peerNonce: 'peer-c' }] },
    { ...frame, images: [{ ...image, requestId: 'different-request' }] },
    { ...frame, images: [image, { ...image, sha256: 'c'.repeat(64) }] },
    { ...frame, images: [{ ...image, path: 'synthetic-local-path' }] },
    { ...frame, projectId: 'untrusted-project' },
    { ...frame, images: [{ ...image, handleSha256: 'synthetic-raw-handle' }] },
    { ...frame, userContentSha256: 'synthetic-raw-user-content' },
    { ...frame, projectedUserContentSha256: '0'.repeat(64) },
    {
      ...frame,
      workingDirectoryEdits: [
        { index: 2, start: 1, end: 5 },
        { index: 1, start: 1, end: 5 },
      ],
    },
    {
      ...frame,
      workingDirectoryEdits: [
        { index: 0, start: 1, end: 5, path: '/synthetic/private' },
      ],
    },
  ])
    await expect(prepare(invalid)).rejects.toMatchObject({ statusCode: 403 });
  await expect(prepare(frame, randomUUID())).rejects.toMatchObject({
    statusCode: 403,
  });

  const token = f.signed(frame, 'model-attachment-prepare');
  const { expiresAt: attachmentDeadline } = JSON.parse(
    Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
  ) as { expiresAt: number };
  const ack = (await f.runs.handle(frame, token)) as {
    callId: string;
    bindingId: string;
    grant: string;
  };
  expect(ack).toMatchObject({ callId, bindingId });
  const wire = {
    ...f.attempt(bindingId),
    routeId: 'messages',
    destination: attachmentRoutes.messages,
    call: {
      ...f.attempt(bindingId).call,
      id: callId,
      attachmentGrant: ack.grant,
    },
  };
  const policy = {
    projectId: 'fixture-project',
    credentialGeneration: 'configured-generation',
    requirementId: 'requirement',
    sessionId: 'session',
    bindingId,
    images: [{ bytes: 20, mediaType: 'image/png', sha256: 'b'.repeat(64) }],
    userContentSha256,
    workingDirectoryEdits: [],
    projectedUserContentSha256: userContentSha256,
    imageHandleDigests: [image.handleSha256],
  };
  expect(f.runs.attachmentManifestFor(wire)).toEqual(policy);
  expect(Object.isFrozen(f.runs.attachmentManifestFor(wire)?.images)).toBe(
    true,
  );
  await expect(prepare()).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    prepare({ ...frame, callId: randomUUID() }),
  ).rejects.toMatchObject({ statusCode: 403 });

  const aborted = new AbortController();
  aborted.abort();
  for (const invalid of [
    { ...wire, call: { ...wire.call, attachmentGrant: undefined } },
    { ...wire, call: { ...wire.call, attachmentGrant: randomUUID() } },
    { ...wire, call: { ...wire.call, id: randomUUID() } },
    { ...wire, call: { ...wire.call, sessionId: 'different-session' } },
    { ...wire, call: { ...wire.call, purpose: 'session-title' } },
    { ...wire, call: { ...wire.call, model: 'different-model' } },
    { ...wire, destination: attachmentRoutes.files },
    { ...wire, signal: aborted.signal },
  ]) {
    expect(f.runs.attachmentManifestFor(invalid)).toBeUndefined();
    const noWrite = vi.fn(() => 'submitted' as const);
    await expect(
      f.runs.authorizeModelWireAttempt(invalid, noWrite),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(noWrite).not.toHaveBeenCalled();
  }

  const submit = (deadline: number) => {
    expect(deadline).toBe(attachmentDeadline);
    return 'submitted' as const;
  };
  await expect(
    f.runs.authorizeModelFileWireAttempt(
      {
        ...wire,
        routeId: 'files',
        destination: attachmentRoutes.files,
        attemptId: randomUUID(),
      },
      submit,
    ),
  ).resolves.toMatchObject({ outcome: 'submitted' });
  const submitted = await f.runs.authorizeModelWireAttempt(wire, submit);
  const close = { ...position, callId, bindingId };
  await expect(
    f.runs.handle(close, f.signed(close, 'model-attachment-release')),
  ).resolves.toEqual({ closed: true });
  expect(f.runs.attachmentManifestFor(wire)).toBeUndefined();
  const replacement = { ...frame, callId: randomUUID() };
  await expect(prepare(replacement)).rejects.toMatchObject({ statusCode: 403 });
  submitted.accept429();
  await expect(prepare()).rejects.toMatchObject({ statusCode: 403 });
  const next = (await prepare(replacement)) as typeof ack;
  const retry = {
    ...wire,
    attemptId: randomUUID(),
    call: { ...wire.call, id: next.callId, attachmentGrant: next.grant },
  };
  expect(f.runs.attachmentManifestFor(retry)).toEqual(policy);
  f.state.select = async () => f.runs.revoke('first-login');
  const noWrite = vi.fn(() => 'submitted' as const);
  await expect(
    f.runs.authorizeModelWireAttempt(retry, noWrite),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(f.runs.attachmentManifestFor(retry)).toBeUndefined();
  expect(noWrite).not.toHaveBeenCalled();
});
