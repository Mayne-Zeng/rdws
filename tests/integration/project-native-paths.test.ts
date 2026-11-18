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

test('a flushed native session model choice survives abrupt exit and routes only its own inference', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-project-model-'),
  );
  const configuration = join(root, 'config/projects/team-b/dsh');
  const profile = join(configuration, 'profiles/rdws');
  const patchPath = join(profile, 'cordis.patch.yml');
  const checkpoint = join(root, 'selection-checkpoint.json');
  const requirementId = randomUUID();
  const modelsUsed: string[] = [];
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
      if (
        request.url !== '/v1/chat/completions' ||
        typeof input.model !== 'string'
      ) {
        response.writeHead(404).end();
        return;
      }
      modelsUsed.push(input.model);
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
      async () => ({
        snapshot: { requirementId, contextVersion: 1 },
        digest: 'fixture-context',
      }),
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

    async function send(sessionId: string) {
      const ticket = host.ticket({
        ...identity,
        purpose: 'browser',
        readSessionIds: [sessionId],
        ownSessionIds: [sessionId],
      });
      const requestId = randomUUID();
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
    async function hasReply(sessionId: string) {
      const events = await callNative(
        'session/events',
        { request: { address: { kind: 'session', sessionId } } },
        'browser',
        sessionId,
      );
      expect(events.ok).toBe(true);
      const records = events.value.records as {
        event: {
          type: string;
          data: {
            message?: { content?: { text?: string }[] };
            reason?: { kind?: string };
          };
        };
      }[];
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
    expect(modelsUsed).toEqual([selectedModel.model, defaultModel.model]);
    expect(await readDefault(sessionId)).toEqual(defaultModel);
  } finally {
    await Promise.all([
      host.close(),
      new Promise<void>((resolve) => fixture.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
