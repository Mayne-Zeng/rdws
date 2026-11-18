import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';

type Observation = {
  pid: number;
  defaultPreset: string;
  workspaceId: string;
  sessionIds: string[];
  created: { sessionId: string; agentPreset: string }[];
  agents: unknown[];
  unknownError?: string;
  error?: string;
  duplicateError?: string;
  retainedDefinition?: string;
  brokenError?: string;
  invalidComposition?: string;
};

test('Native appends preset versions live and restores exact compositions after restart', async () => {
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

  function definition(id: string, moduleName: string) {
    return { id, plugins: [{ id: 'marker', name: moduleName }] };
  }
  function preset(id: string, moduleName: string) {
    return {
      id: 'preset-' + id,
      name: '@deepseek-ai/dsh-agent-preset',
      config: definition(id, moduleName),
    };
  }
  const live = {
    signal: join(root, 'register-next'),
    checkpoint: join(root, 'live-composition.json'),
    next: definition(nextPreset, nextModule),
    duplicate: definition(firstPreset, nextModule),
    broken: definition('rdws-fixture-broken', join(root, 'missing.mjs')),
  };
  async function readObservation(path: string) {
    let report: Observation | undefined;
    await expect
      .poll(
        async () => {
          const contents = await readFile(path, 'utf8').catch(() => '');
          if (!contents) return false;
          report = JSON.parse(contents);
          return true;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect(report!.error).toBeUndefined();
    expect(report!.unknownError).toBe('agent-preset/not-found');
    return report!;
  }
  async function boot(
    presets: ReturnType<typeof preset>[],
    create: string[],
    resume: string[] = [],
    livePublication?: typeof live,
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
                live: livePublication,
              },
            },
          ],
        },
      ]),
    );
    host = new NativeWebHost(root, config, projectId);
    await host.start();
    const report = await readObservation(checkpoint);
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

    const { report: first, native } = await boot(
      [preset(firstPreset, firstModule)],
      [firstPreset],
      [],
      live,
    );
    expect(first.created).toEqual([
      { sessionId: expect.any(String), agentPreset: firstPreset },
    ]);
    const firstSession = first.created[0]!.sessionId;
    expect(first.sessionIds).toEqual([firstSession]);
    expect(first.agents).toEqual([
      composition(firstSession, firstPreset, firstModule),
    ]);

    const runningProfile = await readFile(
      join(profile, 'cordis.patch.yml'),
      'utf8',
    );
    await writeFile(live.signal, '', { flag: 'wx' });
    const second = await readObservation(live.checkpoint);
    expect(second.pid).toBe(first.pid);
    expect(second.defaultPreset).toBe(first.defaultPreset);
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(
      runningProfile,
    );
    expect(second.duplicateError).toBe(
      `Duplicate agent preset: ${firstPreset}`,
    );
    expect(second.retainedDefinition).toContain(firstModule);
    expect(second.retainedDefinition).not.toContain(nextModule);
    expect(second.brokenError).toBe('agent-preset/invalid');
    expect(second.invalidComposition).toContain('missing.mjs');
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

    const { report: restored } = await boot(
      [preset(firstPreset, firstModule), preset(nextPreset, nextModule)],
      [],
      [firstSession, nextSession],
    );
    expect(restored.workspaceId).toBe(first.workspaceId);
    expect(restored.sessionIds).toEqual(second.sessionIds);
    expect(restored.created).toEqual([]);
    expect(restored.agents).toEqual(second.agents);

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
    await host?.close();
    expect(() => process.kill(replay.pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    const journals = join(
      root,
      'runtime/dsh',
      'project-' + projectId,
      'sessions',
    );
    const matches = (await readdir(journals, { recursive: true })).filter(
      (entry) =>
        entry.split(sep).at(-2) === firstSession &&
        /(?:^|\/)session(?:\.v[1-9]\d*)?\.jsonl\.zstd$/.test(entry),
    );
    expect(matches).toHaveLength(1);
    const journal = join(journals, matches[0]!);
    const bytes = await readFile(journal);
    expect(bytes.readUInt32LE(0)).toBe(0xfd2fb528);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { stdout, stderr } = await promisify(execFile)('pnpm', [
      '--silent',
      'trace:prefix',
      'hash',
      journal,
      String(bytes.length),
    ]);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      status: 'hashed',
      throughByte: bytes.length,
      sha256,
    });
    expect(await readFile(journal)).toEqual(bytes);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
