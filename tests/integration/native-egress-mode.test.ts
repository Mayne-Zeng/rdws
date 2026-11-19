import { execFile } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { NativeWebHost, resolveNativeModelEgress } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { prepareMainModelBody } from '../../apps/server/src/modules/model-egress-policy.ts';

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

test('the mediated Chat route admits only the bound text request shape', () => {
  const good = {
    model: 'fixture',
    stream: true,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Text audio example' }] },
    ],
  };
  const prepare = (value: unknown) =>
    prepareMainModelBody(Buffer.from(JSON.stringify(value)), 'fixture');
  expect(prepare(good)?.toString()).toBe(JSON.stringify(good));
  for (const bad of [
    { ...good, model: 'other' },
    { ...good, modalities: ['audio'] },
    { ...good, functions: [] },
    { ...good, stream_options: { include_usage: true, extension: 'private' } },
    {
      ...good,
      messages: [
        { role: 'assistant', content: 'Okay', audio: { id: 'extra' } },
      ],
    },
    {
      ...good,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Text', image_url: 'extra' }],
        },
      ],
    },
  ])
    expect(prepare(bad)).toBeUndefined();
});

test.skipIf(process.platform !== 'darwin')(
  'mediated BFF refuses missing ownership or carrier diagnostics before startup',
  () => {
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    const options = {
      databaseUrl: '',
      secret: '',
      origin: 'http://127.0.0.1:1',
      mainModelPolicy: {
        projectId: 'poc',
        provider: 'rdws-glm',
        model: 'fixture',
        destination: 'https://127.0.0.1:1/v1/chat/completions',
      },
    };
    const diagnostic = channel('http2.server.stream.start');
    const observe = () => {};
    try {
      expect(() => buildApp(options)).toThrow('requires an owned runtime');
      diagnostic.subscribe(observe);
      expect(() =>
        buildApp({ ...options, authorityTicket: '7'.repeat(64) }),
      ).toThrow('carrier diagnostics are not private');
    } finally {
      diagnostic.unsubscribe(observe);
      vi.unstubAllEnvs();
    }
  },
);

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
