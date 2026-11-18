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

test('a project without a default model uses its own registered provider in the boot overlay', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-project-model-'),
  );
  const configuration = join(root, 'config/projects/team-b/dsh');
  const profile = join(configuration, 'profiles/rdws');
  const host = new NativeWebHost(root, configuration, 'team-b');
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { FIXTURE_MODEL: 'fixture-only' } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                baseURL: 'http://127.0.0.1:9/',
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: 'project-fixture-model' }],
              },
            },
          },
        },
      ]),
      { mode: 0o600 },
    );
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
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
