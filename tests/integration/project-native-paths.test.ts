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
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import { NativeWebHost, projectNativeConfiguration } from '@rdws/dsh/web';

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

test('a native session model choice survives restart without changing other sessions or the project default', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-project-model-'),
  );
  const configuration = join(root, 'config/projects/team-b/dsh');
  const profile = join(configuration, 'profiles/rdws');
  const patchPath = join(profile, 'cordis.patch.yml');
  const providerPatch = {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'rdws-glm': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/',
          apiKeyEnv: 'FIXTURE_MODEL',
          models: [{ id: 'project-fixture-model' }, { id: 'other-model' }],
        },
      },
    },
  };
  let host = new NativeWebHost(root, configuration, 'team-b');
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { FIXTURE_MODEL: 'fixture-only' } }),
      { mode: 0o600 },
    );
    await writeFile(patchPath, JSON.stringify([providerPatch]), {
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

    const requirementId = randomUUID();
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
    ) {
      const grant = {
        ...identity,
        purpose,
        ...(sessionId
          ? { readSessionIds: [sessionId], ownSessionIds: [sessionId] }
          : {}),
      };
      const response = await host.fetch(`/api/${method}`, grant, {
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
    async function readSelection(sessionId: string) {
      const projections = await callNative(
        'session/projections',
        { request: { sessionId } },
        'browser',
        sessionId,
      );
      expect(projections.ok).toBe(true);
      expect(projections.value.kind).toBe('sequenced');
      return projections.value.values.modelSelection?.next ?? null;
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
        providerPatch,
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
              config: { sessionId, selection: selectedModel },
            },
          ],
        },
      ]),
    );
    host = new NativeWebHost(root, configuration, 'team-b');
    await host.start();
    await expect.poll(() => readSelection(sessionId)).toEqual(selectedModel);
    expect(await readSelection(otherSessionId)).toBeNull();
    expect(await readDefault(sessionId)).toEqual(defaultModel);

    await host.close();
    await writeFile(patchPath, JSON.stringify([providerPatch]));
    host = new NativeWebHost(root, configuration, 'team-b');
    await host.start();
    expect(await readSelection(sessionId)).toEqual(selectedModel);
    expect(await readSelection(otherSessionId)).toBeNull();
    expect(await readDefault(sessionId)).toEqual(defaultModel);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
