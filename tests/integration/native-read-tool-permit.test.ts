import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { bodyHash, signGrant, verifyGrant } from '@rdws/dsh/access';
import {
  ContextRuns,
  readToolLimit,
  readToolPermitArguments,
  type ReadToolBinding,
} from '../../apps/server/src/modules/runtime-context.ts';

// §11.20.26 Read-specific single-use permit at the parent (hop 3), shape
// following the §11.20.8 fixture permit. The §11.20.8 six counterexamples are
// re-proven on the Read permit: wrong session, altered body, replayed
// ticket, a new ticket for the same call, a changed step and a permit that
// arrives after cancellation each yield zero permits.

vi.stubEnv('RDWS_MODE', 'test');
afterAll(() => vi.unstubAllEnvs());

const provider = 'rdws-glm';
const model = 'read-permit-model';

function fixture() {
  const key = randomUUID();
  const generation = randomUUID();
  const aud = 'rdws:bff:' + generation;
  const runs = new ContextRuns(
    generation,
    (token) => verifyGrant(key, token, aud),
    async () => ({
      value: { snapshot: { contextVersion: 1 }, digest: 'read-permit' },
      validBefore: Infinity,
    }),
    () => false,
    async () => ({
      provider,
      model,
      revision: 'fixture',
      routes: { chat: 'https://127.0.0.1:1/v1' },
      isCurrent: () => true,
    }),
  );
  const login = { userId: 'owner', authSessionId: 'login' };
  const run = runs.admit(login, 'requirement', 'session', 'prompt', 'peer');
  const other = runs.admit(
    login,
    'requirement',
    'other-session',
    'prompt',
    'peer-b',
  );
  const position = { ...run, agentGeneration: 'agent', turn: 1 };
  const segmentIds = new Set<string>();
  const binding: ReadToolBinding = {
    run,
    projectId: 'poc',
    segment: (_input, id) => segmentIds.has(id),
  };
  function signed(body: object, operation = 'read-tool-permit') {
    return signGrant(key, {
      aud,
      purpose: 'service',
      operation,
      hostGeneration: generation,
      runId: (body as { runId: string }).runId,
      bodyHash: bodyHash(body),
    });
  }
  async function openStep(step: number) {
    const input = {
      ...position,
      modelStep: {
        provider,
        model,
        noteId: randomUUID(),
        step,
        sequence: step,
      },
    };
    const response = (await runs.handle(
      input,
      signed(input, 'context-read'),
    )) as { modelBindingId?: string };
    expect(response.modelBindingId).toBeTypeOf('string');
    return { input, modelBindingId: response.modelBindingId! };
  }
  function permitBody(
    step: Awaited<ReturnType<typeof openStep>>,
    overrides: object = {},
  ) {
    return {
      ...step.input,
      authSessionId: 'login',
      modelBindingId: step.modelBindingId,
      toolName: 'read',
      toolCallId: 'call-' + randomUUID(),
      toolCallSeq: 1,
      arguments: { file_path: 'src/app.ts' },
      deadline: Date.now() + 2000,
      ...overrides,
    };
  }
  const permit = (
    body: object,
    expected: ReadToolBinding = binding,
    token = signed(body),
  ) => runs.handle(body, token, undefined, undefined, undefined, expected);
  return {
    runs,
    run,
    other,
    position,
    segmentIds,
    signed,
    openStep,
    permitBody,
    permit,
  };
}

describe('§11.20.26 Read permit shape (L1)', () => {
  test('exactly one permit for the original run, login, session, step and a registered path', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    const result = (await lab.permit(body)) as {
      digest: string;
      expiresAt: number;
    };
    expect(result.digest).toBe(bodyHash(body));
    expect(result.expiresAt).toBeLessThanOrEqual(body.deadline);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    // A second ticket for the same call in the same step: zero permits.
    await expect(
      lab.permit(body, undefined, lab.signed(body)),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test('offset and limit are positive integers and limit stays within the read limit; a registered segment path is a path', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const offset = await lab.permit(
      lab.permitBody(step, {
        arguments: { file_path: 'a.md', offset: 5, limit: 20 },
      }),
    );
    expect(offset).toMatchObject({ digest: expect.any(String) });
    const step2 = await lab.openStep(2);
    const id = randomUUID();
    lab.segmentIds.add(id);
    const segmentPath = '.rdws-read/' + id;
    await expect(
      lab.permit(
        lab.permitBody(step2, {
          arguments: { file_path: '.rdws-read/' + randomUUID() },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const segment = await lab.permit(
      lab.permitBody(step2, { arguments: { file_path: segmentPath } }),
    );
    expect(segment).toMatchObject({ digest: expect.any(String) });
  });

  test('extra keys, absolute paths, traversal, non-positive integers and oversized limits yield zero permits', async () => {
    const lab = fixture();
    expect(readToolLimit).toBe(2000);
    const rejected = [
      { file_path: 'a.md', repositoryId: 'app' },
      { file_path: 'a.md', sessionId: 'session' },
      { file_path: 'a.md', extra: 1 },
      { path: 'a.md' },
      { file_path: '' },
      { file_path: '/etc/passwd' },
      { file_path: '../outside.ts' },
      { file_path: 'src/../../outside.ts' },
      { file_path: './a.md' },
      { file_path: 'src//a.md' },
      { file_path: 'src\\a.md' },
      { file_path: 'a\u0000b' },
      { file_path: 'a.md', offset: 0 },
      { file_path: 'a.md', offset: -1 },
      { file_path: 'a.md', offset: 1.5 },
      { file_path: 'a.md', offset: '1' },
      { file_path: 'a.md', limit: 0 },
      { file_path: 'a.md', limit: readToolLimit + 1 },
      { file_path: 'a.md', limit: readToolLimit, offset: 1, note: 'x' },
      { file_path: '.rdws-read/not-a-cursor' },
      { file_path: '.rdws-read/' + randomUUID() + '/x' },
    ];
    for (const [index, args] of rejected.entries()) {
      const step = await lab.openStep(index + 1);
      await expect(
        lab.permit(lab.permitBody(step, { arguments: args })),
        JSON.stringify(args),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(
      readToolPermitArguments({
        arguments: { file_path: 'a.md', limit: readToolLimit },
      }),
    ).toBe(true);
    expect(
      readToolPermitArguments({ arguments: { file_path: 'a.md' } }, undefined),
    ).toBe(true);
    expect(readToolPermitArguments({ arguments: 'a.md' })).toBe(false);
    expect(readToolPermitArguments({ arguments: {} })).toBe(false);
  });

  test('a tool name other than read, a call identity or a deadline out of range yields zero permits', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    for (const overrides of [
      { toolName: 'rdws_authority_probe' },
      { toolName: 'write' },
      { toolCallId: '' },
      { toolCallSeq: 0 },
      { deadline: Date.now() - 1 },
      { deadline: Date.now() + 5000 },
      {
        arguments: { file_path: 'a.md', offset: 1 },
        modelBindingId: randomUUID(),
      },
    ])
      await expect(
        lab.permit(lab.permitBody(step, overrides)),
      ).rejects.toMatchObject({
        statusCode: 403,
      });
  });
});

describe('§11.20.26 Read permit counterexamples (L2, following §11.20.8)', () => {
  test('wrong session: another session of the same login cannot use the binding', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    await expect(
      lab.permit(body, { run: lab.other, projectId: 'poc' }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    // The other session's own binding with this session's coordinates.
    const foreign = {
      ...body,
      sessionId: lab.other.sessionId,
      requestId: lab.other.requestId,
      peerNonce: lab.other.peerNonce,
    };
    await expect(
      lab.permit(foreign, { run: lab.other, projectId: 'poc' }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    // Still exactly one permit available for the genuine binding.
    expect(await lab.permit(body)).toMatchObject({ digest: bodyHash(body) });
  });

  test('altered body: a changed argument after signing yields zero permits', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    const token = lab.signed(body);
    const altered = { ...body, arguments: { file_path: 'secrets.key' } };
    await expect(lab.permit(altered, undefined, token)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await lab.permit(body, undefined, token)).toMatchObject({
      digest: bodyHash(body),
    });
  });

  test('replayed ticket: the original ticket is accepted once', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    const token = lab.signed(body);
    expect(await lab.permit(body, undefined, token)).toMatchObject({
      digest: expect.any(String),
    });
    await expect(lab.permit(body, undefined, token)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test('a new ticket for the same call in parallel yields a second zero', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    const first = await lab.permit(body).catch((error: unknown) => error);
    const second = await lab
      .permit(body, undefined, lab.signed(body))
      .catch((error: unknown) => error);
    const granted = [first, second].filter(
      (value) => !(value instanceof Error),
    );
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ digest: bodyHash(body) });
    const denied = [first, second].filter((value) => value instanceof Error);
    expect(denied).toHaveLength(1);
  });

  test('changed step: a new ticket carrying the previous step binding yields zero permits', async () => {
    const lab = fixture();
    const first = await lab.openStep(1);
    const second = await lab.openStep(2);
    // The step moved on before any permit was granted for the first.
    await expect(lab.permit(lab.permitBody(first))).rejects.toMatchObject({
      statusCode: 403,
    });
    // New step coordinates with the old step marker.
    const stale = {
      ...lab.permitBody(second),
      modelStep: first.input.modelStep,
    };
    await expect(lab.permit(stale)).rejects.toMatchObject({ statusCode: 403 });
    // The current step is the only one that can be permitted.
    expect(await lab.permit(lab.permitBody(second))).toMatchObject({
      digest: expect.any(String),
    });
  });

  test('late permit after cancellation: a run removed before the reply yields zero permits', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    const token = lab.signed(body);
    lab.runs.discard(body.runId);
    await expect(lab.permit(body, undefined, token)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test('the operation is unknown unless the assembly armed the Read probe', async () => {
    const lab = fixture();
    const step = await lab.openStep(1);
    const body = lab.permitBody(step);
    await expect(lab.runs.handle(body, lab.signed(body))).rejects.toMatchObject(
      { statusCode: 403 },
    );
    await expect(
      lab.runs.handle(
        body,
        lab.signed(body),
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
