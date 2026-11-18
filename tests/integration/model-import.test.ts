import { test, expect } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
test('one-time import uses native DSH schema, preserves later settings and never logs credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-model-import-'));
  const key = randomUUID();
  try {
    await mkdir(join(root, 'secrets'));
    await writeFile(
      join(root, 'secrets', 'model.env'),
      `MODEL_PROTOCOL=openai-chat-completions\nMODEL_ID=GLM-5.3-Flash\nMODEL_BASE_URL=https://model.invalid/v1\nMODEL_API_KEY=${key}\n`,
      { mode: 0o600 },
    );
    const run = () =>
      spawnSync(process.execPath, ['scripts/dsh-model-import.mjs'], {
        encoding: 'utf8',
        env: { ...process.env, RDWS_HOME: root },
      });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(key);
    const home = join(root, 'runtime', 'dsh', 'project-poc');
    const patch = join(home, 'profiles', 'rdws', 'cordis.patch.yml');
    const contents = await readFile(patch, 'utf8');
    expect(contents).not.toContain(key);
    expect(JSON.parse(contents)[0].config.providers['rdws-glm']).toMatchObject({
      api: 'openai-completions',
      apiKeyEnv: 'RDWS_GLM_API_KEY',
    });
    const credentialFile = join(home, '.credentials.yaml');
    expect(
      JSON.parse(await readFile(credentialFile, 'utf8')).refs.RDWS_GLM_API_KEY,
    ).toBe(key);
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    const edited = contents.replace('GLM-5.3-Flash', 'edited-in-dsh');
    await writeFile(patch, edited);
    const second = run();
    expect(second.status).toBe(0);
    expect(await readFile(patch, 'utf8')).toBe(edited);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('partial native configuration is preserved rather than overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-model-partial-'));
  try {
    const home = join(root, 'runtime', 'dsh', 'project-poc');
    await mkdir(home, { recursive: true });
    const file = join(home, '.credentials.yaml');
    await writeFile(file, 'version: 1\nrefs: {}\n', { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      ['scripts/dsh-model-import.mjs'],
      { encoding: 'utf8', env: { ...process.env, RDWS_HOME: root } },
    );
    expect(result.status).not.toBe(0);
    expect(await readFile(file, 'utf8')).toBe('version: 1\nrefs: {}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
