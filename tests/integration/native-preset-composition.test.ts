import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';

type Observation = {
  workspaceId: string;
  sessionIds: string[];
  created: { sessionId: string; agentPreset: string }[];
  agents: unknown[];
  unknownError?: string;
  error?: string;
};

test('Native preset IDs pin session composition across restarts only when definitions are immutable', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rdws-preset-'));
  const projectId = 'preset-proof';
  const requirementId = randomUUID();
  const config = join(root, 'config/projects', projectId, 'dsh');
  const profile = join(config, 'profiles/rdws');
  const cwd = join(root, 'projects', projectId, 'demands', requirementId);
  const probe = fileURLToPath(
    new URL('../fixtures/native-preset-composition.mjs', import.meta.url),
  );
  const firstPreset = 'rdws-fixture-r1';
  const nextPreset = 'rdws-fixture-r2';
  const firstModule = join(root, 'first.mjs');
  const nextModule = join(root, 'next.mjs');
  let host: NativeWebHost | undefined;
  let bootNumber = 0;

  function preset(id: string, moduleName: string) {
    return {
      id: 'preset-' + id,
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id, plugins: [{ id: 'marker', name: moduleName }] },
    };
  }
  async function boot(
    presets: ReturnType<typeof preset>[],
    create: string[],
    resume: string[] = [],
  ) {
    await host?.close();
    const checkpoint = join(root, `composition-${++bootNumber}.json`);
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                baseURL: 'http://127.0.0.1:1/v1',
                models: [{ id: 'unused-local-fixture' }],
              },
            },
          },
        },
        {
          insert: [
            ...presets,
            {
              id: 'test-native-preset-composition',
              name: probe,
              config: {
                cwd,
                checkpoint,
                create,
                resume,
                unknownPreset: 'unregistered-fixture',
              },
            },
          ],
        },
      ]),
    );
    host = new NativeWebHost(root, config, projectId);
    await host.start();
    await expect
      .poll(
        async () => Boolean(await readFile(checkpoint, 'utf8').catch(() => '')),
        {
          timeout: 5000,
        },
      )
      .toBe(true);
    const report = JSON.parse(
      await readFile(checkpoint, 'utf8'),
    ) as Observation;
    expect(report.error).toBeUndefined();
    expect(report.unknownError).toBe('agent-preset/not-found');
    return { report, native: host };
  }
  function composition(sessionId: string, id: string, moduleName: string) {
    return {
      sessionId,
      recordedPreset: id,
      compositions: [{ id, modules: [moduleName], leakedServices: [] }],
    };
  }
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, '.credentials.yaml'),
      'version: 1\nrefs: {}\n',
      {
        mode: 0o600,
      },
    );
    await writeFile(
      firstModule,
      "export const name = 'marker-first'; export function apply() {}",
    );
    await writeFile(
      nextModule,
      "export const name = 'marker-next'; export function apply() {}",
    );

    const { report: first } = await boot(
      [preset(firstPreset, firstModule)],
      [firstPreset],
    );
    expect(first.created).toEqual([
      { sessionId: expect.any(String), agentPreset: firstPreset },
    ]);
    const firstSession = first.created[0]!.sessionId;
    expect(first.sessionIds).toEqual([firstSession]);
    expect(first.agents).toEqual([
      composition(firstSession, firstPreset, firstModule),
    ]);

    const { report: second, native } = await boot(
      [preset(firstPreset, firstModule), preset(nextPreset, nextModule)],
      [nextPreset],
      [firstSession],
    );
    expect(second.created).toEqual([
      { sessionId: expect.any(String), agentPreset: nextPreset },
    ]);
    const nextSession = second.created[0]!.sessionId;
    expect(nextSession).not.toBe(firstSession);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.sessionIds).toHaveLength(2);
    expect(second.sessionIds).toEqual(
      expect.arrayContaining([firstSession, nextSession]),
    );
    expect(second.agents).toEqual([
      composition(firstSession, firstPreset, firstModule),
      composition(nextSession, nextPreset, nextModule),
    ]);

    for (const purpose of ['browser', 'create'] as const) {
      const response = await native.fetch(
        '/api/session/create',
        {
          purpose,
          requirementId,
          cwd,
          workspaceId: second.workspaceId,
          userId: randomUUID(),
          authSessionId: randomUUID(),
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/create',
            payload: {
              args: {
                request: {
                  workspaceId: second.workspaceId,
                  agentPreset: nextPreset,
                },
              },
            },
          }),
        },
      );
      if (purpose === 'create') {
        expect(response.status).toBe(403);
      } else {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          result: { ok: false, error: { code: 'remote-access/denied' } },
        });
      }
    }

    const { report: replay } = await boot(
      [preset(firstPreset, nextModule)],
      [],
      [firstSession, nextSession],
    );
    expect(replay.workspaceId).toBe(first.workspaceId);
    expect(replay.sessionIds).toEqual(second.sessionIds);
    expect(replay.agents).toEqual([
      composition(firstSession, firstPreset, nextModule),
      {
        sessionId: nextSession,
        error: 'gateway/internal',
        message: expect.stringContaining(`Unknown agent preset: ${nextPreset}`),
      },
    ]);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
