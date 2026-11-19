import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { NativeWebHost, resolveNativeModelEgress } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';

test('Native model egress rejects unknown settings before creating the BFF', () => {
  expect(resolveNativeModelEgress()).toBe('direct');
  expect(resolveNativeModelEgress('direct')).toBe('direct');
  vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'unknown');
  try {
    expect(() =>
      buildApp({ databaseUrl: '', secret: '', origin: 'http://127.0.0.1:1' }),
    ).toThrow('Invalid RDWS_NATIVE_MODEL_EGRESS');
  } finally {
    vi.unstubAllEnvs();
  }
});

test.skipIf(process.platform === 'darwin')(
  'paused Native startup is unavailable on other platforms',
  () => {
    expect(() => resolveNativeModelEgress('paused')).toThrow(
      'Paused Native model egress requires macOS',
    );
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the BFF refuses an injected direct Host in paused mode',
  () => {
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
    try {
      expect(() =>
        buildApp({
          databaseUrl: '',
          secret: '',
          origin: 'http://127.0.0.1:1',
          nativeHost: new NativeWebHost('/tmp/rdws-model-mode-fixture'),
        }),
      ).toThrow('Native Host model egress does not match BFF configuration');
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'a denied paused launcher never creates a ready Native process',
  async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-sandbox-rejection-'),
    );
    const configuration = join(root, 'configuration');
    const profile = join(configuration, 'profiles', 'rdws');
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
                  apiKeyEnv: 'FIXTURE_MODEL',
                  baseURL: 'http://127.0.0.1:1/v1',
                  models: [{ id: 'fixture' }],
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      const program = `
      import assert from 'node:assert/strict';
      import { access } from 'node:fs/promises';
      import { join } from 'node:path';
      import { NativeWebHost } from './dsh/host/web.ts';
      const [root, config] = process.argv.slice(1);
      const host = new NativeWebHost(root, config, 'poc', undefined, 'paused');
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(host.start(), { code: 'EPERM' });
          await assert.rejects(access(join(root,'runtime/instances/project-poc.ready.json')), { code: 'ENOENT' });
          await assert.rejects(access(join(root,'runtime/instances/project-poc.lock')), { code: 'ENOENT' });
        }
      } finally { await host.close(); }
    `;
      await expect(
        promisify(execFile)(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            '(version 1) (allow default) (deny process-exec (literal "/usr/bin/sandbox-exec"))',
            process.execPath,
            '--import',
            'tsx/esm',
            '--input-type=module',
            '-e',
            program,
            root,
            configuration,
          ],
          { timeout: 12_000 },
        ),
      ).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
