import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import { NativeWebHost, projectNativeConfiguration } from '@rdws/dsh/web';
import { forkBoundary, sessionRpc } from '@rdws/dsh/sessions';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';

test('native registration accepts a project profile and refuses linked runtime boot inputs', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-project-path-'),
  );
  const config = join(root, 'config/projects/team-a/dsh');
  try {
    const profile = join(config, 'profiles/rdws');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 });
    await writeFile(join(config, '.credentials.yaml'), '{}\n', { mode: 0o600 });
    expect(await projectNativeConfiguration(root, 'team-a')).toBe(config);
    await expect(projectNativeConfiguration(root, 'Team-A')).rejects.toThrow();
    await rename(
      join(config, '.credentials.yaml'),
      join(config, 'saved-credentials.yaml'),
    );
    await symlink(
      join(config, 'saved-credentials.yaml'),
      join(config, '.credentials.yaml'),
    );
    await expect(projectNativeConfiguration(root, 'team-a')).rejects.toThrow();
    const boot = join(root, 'runtime/dsh/project-team-a/profiles/rdws');
    await mkdir(boot, { recursive: true, mode: 0o700 });
    const marker = join(root, 'fixture-marker');
    await writeFile(marker, 'preserve this fixture', { mode: 0o600 });
    await symlink(marker, join(boot, 'cordis.yml'));
    const host = new NativeWebHost(root, config, 'team-a');
    await expect(host.start()).rejects.toThrow('Invalid managed Native file');
    await host.close();
    expect(await readFile(marker, 'utf8')).toBe('preserve this fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native model choices survive restarts, reach actual dispatch, and can enter a blocked fork prefix', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-project-model-'),
  );
  const configuration = join(root, 'config/projects/team-b/dsh');
  const profile = join(configuration, 'profiles/rdws');
  const patchPath = join(profile, 'cordis.patch.yml');
  const checkpoint = join(root, 'selection-checkpoint.json');
  const requirementId = randomUUID();
  const queuedSelectionId = randomUUID();
  const blockedSelectionId = randomUUID();
  let denyContextFor = '';
  let deniedContextReads = 0;
  let pauseProviderFor = '';
  let providerPaused = false;
  let releaseProvider!: () => void;
  const providerPause = new Promise<void>(
    (resolve) => (releaseProvider = resolve),
  );
  const providerHits: { id: string | undefined; model: string }[] = [];
  const settled = new Set<string>();
  const dispatches: {
    id: string;
    sessionId: string;
    provider: string;
    model: string;
    purpose: string | null;
    allowed: boolean;
  }[] = [];
  let retrySession = '';
  let deniedTitleSession = '';
  let retryPending = false;
  let retryStillAuthorized = true;
  let releaseRetry!: () => void;
  const retryDecision = new Promise<void>(
    (resolve) => (releaseRetry = resolve),
  );
  let rateLimitNextMain = false;
  let runs: ContextRuns;
  const fixture = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/context') {
        const token = request.headers.authorization?.replace(/^RDWS /, '');
        const result = await runs.handle(input, token);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.url === '/dispatch') {
        const title = input.purpose === 'session-title';
        const retry =
          input.sessionId === retrySession &&
          !title &&
          dispatches.some(
            (call) => call.sessionId === retrySession && !call.purpose,
          );
        if (retry) {
          retryPending = true;
          await retryDecision;
        }
        const allowed = title
          ? ![retrySession, deniedTitleSession].includes(input.sessionId)
          : !retry || retryStillAuthorized;
        dispatches.push({ ...input, allowed });
        response.writeHead(allowed ? 204 : 403).end();
        return;
      }
      if (request.url === '/dispatch-settled') {
        settled.add(input.id);
        response.writeHead(204).end();
        return;
      }
      if (
        request.url !== '/v1/chat/completions' ||
        typeof input.model !== 'string'
      ) {
        response.writeHead(404).end();
        return;
      }
      const id = request.headers['x-rdws-fixture-dispatch'] as
        string | undefined;
      providerHits.push({
        id,
        model: input.model,
      });
      const intent = dispatches.find((call) => call.id === id);
      if (
        intent?.sessionId === pauseProviderFor &&
        !intent.purpose &&
        !providerPaused
      ) {
        providerPaused = true;
        await providerPause;
      }
      if (rateLimitNextMain && input.model === 'project-fixture-model') {
        rateLimitNextMain = false;
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Synthetic rate limit' } }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const completion = {
        id: 'fixture-completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: input.model,
      };
      for (const choice of [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Fixture reply' },
          finish_reason: null,
        },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) {
        response.write(
          `data: ${JSON.stringify({ ...completion, choices: [choice] })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(500).end();
    }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const providerPatch = {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'rdws-glm': {
          api: 'openai-completions',
          baseURL: `${base}/v1`,
          apiKeyEnv: 'FIXTURE_MODEL',
          models: [{ id: 'project-fixture-model' }, { id: 'other-model' }],
        },
      },
    },
  };
  const inferenceProfile = [
    providerPatch,
    { id: 'session-title-llm', disabled: true },
  ];
  let host = new NativeWebHost(root, configuration, 'team-b');
  function newHost() {
    const native = new NativeWebHost(root, configuration, 'team-b');
    runs = new ContextRuns(
      native.contextGeneration,
      (token) => native.verifyContext(token),
      async (_who, _requirementId, sessionId) => {
        if (sessionId === denyContextFor) {
          deniedContextReads++;
          throw new Error('Fixture authorization revoked');
        }
        return {
          snapshot: { requirementId, contextVersion: 1 },
          digest: 'fixture-context',
        };
      },
      () => false,
    );
    native.configureContext(`${base}/context`, base);
    return native;
  }
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { FIXTURE_MODEL: 'fixture-only' } }),
      { mode: 0o600 },
    );
    await writeFile(patchPath, JSON.stringify(inferenceProfile), {
      mode: 0o600,
    });
    expect(await projectNativeConfiguration(root, 'team-b')).toBe(
      configuration,
    );
    await host.start();
    const overlay = JSON.parse(
      await readFile(
        join(root, 'runtime/instances/project-team-b.cordis.yml'),
        'utf8',
      ),
    ) as { id: string; config: unknown }[];
    expect(
      overlay.find((row) => row.id === 'agent-default-model')?.config,
    ).toEqual({ provider: 'rdws-glm', model: 'project-fixture-model' });

    const workspace = await host.workspace(
      requirementId,
      'Model scope fixture',
    );
    const identity = {
      userId: randomUUID(),
      authSessionId: randomUUID(),
      requirementId,
      ...workspace,
    };
    async function callNative(
      method: string,
      args: Record<string, unknown>,
      purpose: 'browser' | 'create',
      sessionId?: string,
      ticket?: string,
    ) {
      const grant = {
        ...identity,
        purpose,
        ...(sessionId
          ? { readSessionIds: [sessionId], ownSessionIds: [sessionId] }
          : {}),
      };
      const response = await host.fetch(`/api/${method}`, ticket ?? grant, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).result;
    }
    async function createSession() {
      const created = await callNative(
        'session/create',
        { request: { workspaceId: workspace.workspaceId } },
        'create',
      );
      expect(created.ok).toBe(true);
      const id = created.value.sessionId as string;
      expect(typeof id).toBe('string');
      return id;
    }
    async function readSelection(
      sessionId: string,
      field: 'next' | 'lastUsed' = 'next',
    ) {
      const projections = await callNative(
        'session/projections',
        { request: { sessionId } },
        'browser',
        sessionId,
      );
      expect(projections.ok).toBe(true);
      expect(projections.value.kind).toBe('sequenced');
      return projections.value.values.modelSelection?.[field] ?? null;
    }
    async function readDefault(sessionId: string) {
      const catalog = await callNative(
        'session/modelCatalog',
        {},
        'browser',
        sessionId,
      );
      expect(catalog.ok).toBe(true);
      return catalog.value.default;
    }
    const sessionId = await createSession();
    const otherSessionId = await createSession();
    const defaultModel = {
      provider: 'rdws-glm',
      model: 'project-fixture-model',
    };
    const selectedModel = { provider: 'rdws-glm', model: 'other-model' };
    const catalog = await callNative(
      'session/modelCatalog',
      {},
      'browser',
      sessionId,
    );
    expect(catalog.ok).toBe(true);
    expect(catalog.value.default).toEqual(defaultModel);
    expect(catalog.value.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'rdws-glm',
          models: expect.arrayContaining([
            expect.objectContaining({ id: 'project-fixture-model' }),
            expect.objectContaining({ id: 'other-model' }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(catalog).includes('fixture-only')).toBe(false);
    for (const [method, args] of [
      ['settings/describe', {}],
      ['credentials/describe', { refs: ['FIXTURE_MODEL'] }],
      [
        'session/selectModel',
        { request: { sessionId, provider: 'rdws-glm', model: 'other-model' } },
      ],
    ] as const) {
      const denied = await callNative(method, args, 'browser', sessionId);
      expect(denied.ok, method).toBe(false);
      expect(denied.error.code, method).toBe('remote-access/denied');
    }
    expect(await readDefault(sessionId)).toEqual(defaultModel);
    expect(await readSelection(sessionId)).toBeNull();
    expect(await readSelection(otherSessionId)).toBeNull();

    await host.close();
    await writeFile(
      patchPath,
      JSON.stringify([
        ...inferenceProfile,
        {
          insert: [
            {
              id: 'test-native-model-selection',
              name: fileURLToPath(
                new URL(
                  '../fixtures/native-model-selection.mjs',
                  import.meta.url,
                ),
              ),
              config: { sessionId, selection: selectedModel, checkpoint },
            },
          ],
        },
      ]),
    );
    host = newHost();
    await host.start();
    await expect
      .poll(async () =>
        JSON.parse(await readFile(checkpoint, 'utf8').catch(() => 'null')),
      )
      .toEqual(selectedModel);
    await expect.poll(() => readSelection(sessionId)).toEqual(selectedModel);
    expect(await readSelection(otherSessionId)).toBeNull();
    expect(await readDefault(sessionId)).toEqual(defaultModel);

    const ready = JSON.parse(
      await readFile(
        join(root, 'runtime/instances/project-team-b.ready.json'),
        'utf8',
      ),
    );
    expect(ready.generation).toBe(host.contextGeneration);
    expect(
      Number.isSafeInteger(ready.pid) &&
        ready.pid > 1 &&
        ready.pid !== process.pid,
    ).toBe(true);
    process.kill(ready.pid, 'SIGKILL');
    await host.close();
    await writeFile(patchPath, JSON.stringify(inferenceProfile));
    host = newHost();
    await host.start();
    expect(await readSelection(sessionId)).toEqual(selectedModel);
    expect(await readSelection(otherSessionId)).toBeNull();
    expect(await readDefault(sessionId)).toEqual(defaultModel);

    async function send(sessionId: string, requestId = randomUUID()) {
      const ticket = host.ticket({
        ...identity,
        purpose: 'browser',
        readSessionIds: [sessionId],
        ownSessionIds: [sessionId],
      });
      const binding = runs.admit(
        identity,
        requirementId,
        sessionId,
        requestId,
        host.claims(ticket)!.nonce,
      );
      await host.control('run', {
        ...binding,
        authSessionId: identity.authSessionId,
      });
      const result = await callNative(
        'session/prompt',
        {
          request: {
            sessionId,
            requestId,
            mode: 'queue',
            content: [{ type: 'text', text: 'Route selection fixture' }],
          },
        },
        'browser',
        sessionId,
        ticket,
      );
      expect(result).toMatchObject({ ok: true, value: { accepted: true } });
    }
    async function sessionRecords(sessionId: string) {
      const events = await callNative(
        'session/events',
        { request: { address: { kind: 'session', sessionId } } },
        'browser',
        sessionId,
      );
      expect(events.ok).toBe(true);
      return events.value.records as {
        event: {
          type: string;
          seq: number;
          data: {
            message?: { content?: { text?: string }[] };
            reason?: { kind?: string };
            source?: { kind: string };
            messageSeqs?: number[];
            retryId?: string;
          };
        };
      }[];
    }
    async function hasReply(sessionId: string) {
      const records = await sessionRecords(sessionId);
      return (
        records.some(
          ({ event }) =>
            event.type === 'assistant/message' &&
            event.data.message?.content?.some(
              (block) => block.text === 'Fixture reply',
            ),
        ) &&
        records.some(
          ({ event }) =>
            event.type === 'turn/end' &&
            event.data.reason?.kind === 'completed',
        )
      );
    }
    await send(sessionId);
    await expect.poll(() => hasReply(sessionId)).toBe(true);
    await expect
      .poll(() => readSelection(sessionId, 'lastUsed'))
      .toEqual(selectedModel);
    await send(otherSessionId);
    await expect.poll(() => hasReply(otherSessionId)).toBe(true);
    await expect
      .poll(() => readSelection(otherSessionId, 'lastUsed'))
      .toEqual(defaultModel);
    expect(providerHits.map(({ model }) => model)).toEqual([
      selectedModel.model,
      defaultModel.model,
    ]);
    expect(await readDefault(sessionId)).toEqual(defaultModel);

    await host.close();
    const titleModel = 'fixture-title-model';
    const boundedProvider = {
      ...providerPatch.config.providers['rdws-glm'],
      models: [
        ...providerPatch.config.providers['rdws-glm'].models,
        { id: titleModel },
      ],
      retryPolicy: {
        mode: 'normal',
        maxRetries: 1,
        backoff: { initialDelayMs: 35, maxDelayMs: 35, jitterRatio: 0 },
      },
    };
    await writeFile(
      patchPath,
      JSON.stringify([
        {
          id: providerPatch.id,
          config: { providers: { 'rdws-glm': boundedProvider } },
        },
        { id: 'session-title-llm', disabled: true },
        {
          insert: [
            {
              id: 'test-native-title-provider',
              name: '@deepseek-ai/dsh-session-title-first-prompt-llm',
              config: {
                provider: 'rdws-glm',
                model: titleModel,
                targetWords: 5,
                targetCjkCharacters: 10,
                maxInputBytes: 4096,
                maxOutputTokens: 64,
                timeoutMs: 2000,
              },
            },
            {
              id: 'test-native-dispatch-observer',
              name: fileURLToPath(
                new URL(
                  '../fixtures/native-dispatch-observer.mjs',
                  import.meta.url,
                ),
              ),
              config: { origin: base },
            },
            {
              id: 'test-native-claim-selection',
              name: fileURLToPath(
                new URL(
                  '../fixtures/native-claim-selection.mjs',
                  import.meta.url,
                ),
              ),
              config: {
                requestIds: [queuedSelectionId, blockedSelectionId],
                selection: selectedModel,
              },
            },
          ],
        },
      ]),
    );
    host = newHost();
    await host.start();
    const initialCalls = providerHits.length;
    retrySession = await createSession();
    rateLimitNextMain = true;
    await send(retrySession);
    await expect.poll(() => retryPending).toBe(true);
    expect(providerHits.slice(initialCalls)).toMatchObject([
      { model: defaultModel.model },
    ]);
    const retryRecords = await sessionRecords(retrySession);
    const retryData = retryRecords.find(
      ({ event }) => event.type === 'llm/retry',
    )?.event.data;
    expect(retryData).toMatchObject({
      retryId: expect.any(String),
      retry: 1,
      failure: { code: 'RATE_LIMIT' },
    });
    expect(retryRecords).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'llm/retry-started',
          data: expect.objectContaining({
            retryId: retryData?.retryId,
            retry: 1,
          }),
        }),
      }),
    );
    retryStillAuthorized = false;
    releaseRetry();
    await expect
      .poll(async () =>
        (await sessionRecords(retrySession)).some(
          ({ event }) => event.type === 'turn/end',
        ),
      )
      .toBe(true);
    const attempts = dispatches.filter(
      (call) => call.sessionId === retrySession && !call.purpose,
    );
    expect(
      attempts.map(({ provider, model, allowed }) => ({
        provider,
        model,
        allowed,
      })),
    ).toEqual([
      { ...defaultModel, allowed: true },
      { ...defaultModel, allowed: false },
    ]);
    expect(new Set(attempts.map((call) => call.id)).size).toBe(2);
    expect(providerHits.slice(initialCalls)).toHaveLength(1);

    deniedTitleSession = await createSession();
    await send(deniedTitleSession);
    await expect.poll(() => hasReply(deniedTitleSession)).toBe(true);
    await expect
      .poll(() =>
        dispatches.find(
          (call) =>
            call.sessionId === deniedTitleSession &&
            call.purpose === 'session-title',
        ),
      )
      .toMatchObject({
        provider: defaultModel.provider,
        model: titleModel,
        allowed: false,
      });

    const allowedTitleSession = await createSession();
    await send(allowedTitleSession);
    await expect.poll(() => hasReply(allowedTitleSession)).toBe(true);
    await expect
      .poll(() =>
        dispatches.find(
          (call) =>
            call.sessionId === allowedTitleSession &&
            call.purpose === 'session-title',
        ),
      )
      .toMatchObject({
        provider: defaultModel.provider,
        model: titleModel,
        allowed: true,
      });
    for (const id of [deniedTitleSession, allowedTitleSession]) {
      const records = await sessionRecords(id);
      const user = records.find(
        ({ event }) =>
          event.type === 'user/message' && event.data.source?.kind === 'user',
      );
      expect(user?.event.seq).toEqual(expect.any(Number));
      expect(records).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'session/title-llm-request',
            data: expect.objectContaining({
              messageSeqs: [user?.event.seq],
              route: { provider: defaultModel.provider, model: titleModel },
            }),
          }),
        }),
      );
    }
    const providerTitle = async (id: string) =>
      (await sessionRecords(id)).some(
        ({ event }) =>
          event.type === 'session/title' &&
          event.data.source?.kind === 'provider',
      );
    await expect.poll(() => providerTitle(allowedTitleSession)).toBe(true);
    await expect
      .poll(() => dispatches.every((call) => settled.has(call.id)))
      .toBe(true);
    expect(await providerTitle(deniedTitleSession)).toBe(false);
    const approved = dispatches
      .filter((call) => call.allowed)
      .map(({ id, model }) => ({ id, model }));
    const received = providerHits.slice(initialCalls);
    expect(approved).toHaveLength(4);
    expect(received).toHaveLength(approved.length);
    expect(received).toEqual(expect.arrayContaining(approved));
    for (const { id } of dispatches.filter((call) => !call.allowed))
      expect(received.some((hit) => hit.id === id)).toBe(false);

    function mainModels(id: string) {
      const ids = new Set(
        dispatches
          .filter((call) => call.sessionId === id && !call.purpose)
          .map((call) => call.id),
      );
      return providerHits
        .filter((hit) => hit.id && ids.has(hit.id))
        .map((hit) => hit.model);
    }
    const queued = await createSession();
    pauseProviderFor = queued;
    await send(queued);
    await expect.poll(() => providerPaused).toBe(true);
    await send(queued, queuedSelectionId);
    expect(await readSelection(queued)).toEqual(defaultModel);
    expect(mainModels(queued)).toEqual([defaultModel.model]);
    releaseProvider();
    await expect
      .poll(
        async () =>
          (await sessionRecords(queued)).filter(
            ({ event }) =>
              event.type === 'turn/end' &&
              event.data.reason?.kind === 'completed',
          ).length,
      )
      .toBe(2);
    expect(mainModels(queued)).toEqual([
      defaultModel.model,
      selectedModel.model,
    ]);
    expect(await readSelection(queued, 'lastUsed')).toEqual(selectedModel);

    const blocked = await createSession();
    await send(blocked);
    await expect.poll(() => hasReply(blocked)).toBe(true);
    await expect.poll(() => providerTitle(queued)).toBe(true);
    await expect.poll(() => providerTitle(blocked)).toBe(true);
    await expect
      .poll(() => dispatches.every((call) => settled.has(call.id)))
      .toBe(true);
    const beforeRejection = providerHits.length;
    denyContextFor = blocked;
    await send(blocked, blockedSelectionId);
    await expect
      .poll(
        async () =>
          (await sessionRecords(blocked)).findLast(
            ({ event }) => event.type === 'turn/end',
          )?.event.data.reason?.kind,
      )
      .toBe('blocked');
    expect(deniedContextReads).toBe(1);
    expect(mainModels(blocked)).toEqual([defaultModel.model]);
    expect(await readSelection(blocked)).toEqual(selectedModel);
    expect(await readSelection(blocked, 'lastUsed')).toEqual(defaultModel);
    expect(providerHits).toHaveLength(beforeRejection);
    const source = {
      ...identity,
      purpose: 'browser' as const,
      readSessionIds: [blocked],
      ownSessionIds: [blocked],
    };
    const atSeq = await forkBoundary(host, source, blocked);
    expect(atSeq).toEqual(expect.any(Number));
    const nativeFork = await sessionRpc(
      host,
      { ...source, purpose: 'fork', sourceSessionId: blocked, atSeq },
      'session/fork',
      { sessionId: blocked, atSeq, allowMigration: false },
    );
    expect(nativeFork).toMatchObject({ sessionId: expect.any(String) });
    const { sessionId: child } = nativeFork as { sessionId: string };
    expect(child).not.toBe(blocked);
    expect(await readSelection(child)).toEqual(selectedModel);
    expect(await readSelection(child, 'lastUsed')).toEqual(defaultModel);
    expect(providerHits).toHaveLength(beforeRejection);
  } finally {
    releaseRetry();
    releaseProvider();
    await Promise.all([
      host.close(),
      new Promise<void>((resolve) => fixture.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
