import { expect, test } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeProfile } from '@rdws/dsh/host';
import { summarizeFrames } from '@rdws/dsh/events';
import { parse } from 'yaml';
import { apply } from '../../dsh/plugins/probe-observer/index.mjs';
test('native profile initialization preserves user model and credential files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-dsh-profile-'));
  try {
    await mkdir(join(root, 'profiles', 'rdws'), { recursive: true });
    const patch = join(root, 'profiles', 'rdws', 'cordis.patch.yml');
    await writeFile(patch, '[]');
    await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs: {}\n');
    await prepareNativeProfile(root);
    await prepareNativeProfile(root);
    expect(await readFile(patch, 'utf8')).toBe('[]');
    expect(await readFile(join(root, '.credentials.yaml'), 'utf8')).toBe(
      'version: 1\nrefs: {}\n',
    );
    const manifest = JSON.parse(
      await readFile(join(root, 'profiles', 'rdws', 'package.json'), 'utf8'),
    );
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-sdk-app',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('live observer records metadata while excluding content and extension payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-dsh-stream-'));
  try {
    const path = join(root, 'frames.jsonl');
    let receive:
      | ((data: {
          agent: { session: { id: string } };
          frame: {
            type: string;
            chunk: { type: string; text: string; extension: string };
          };
        }) => void)
      | undefined;
    apply(
      {
        on: (
          name: string,
          handler: typeof receive,
          options: { global: boolean },
        ) => {
          expect(name).toBe('agent/assistant-stream');
          expect(options.global).toBe(true);
          receive = handler;
        },
      },
      { path },
    );
    receive!({
      agent: { session: { id: 'session-test' } },
      frame: {
        type: 'chunk',
        chunk: {
          type: 'text-delta',
          text: 'private-text',
          extension: 'private-extension',
        },
      },
    });
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain('private-text');
    expect(content).not.toContain('private-extension');
    expect(JSON.parse(content)).toMatchObject({
      sessionId: 'session-test',
      type: 'chunk',
      chunkType: 'text-delta',
      textLength: 12,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('stream evidence distinguishes live text from final or non-text events', () => {
  const frames = [
    { sessionId: 'a', type: 'start', receivedAt: 10 },
    {
      sessionId: 'a',
      type: 'chunk',
      chunkType: 'reasoning-delta',
      textLength: 30,
      receivedAt: 11,
    },
    {
      sessionId: 'a',
      type: 'chunk',
      chunkType: 'text-delta',
      textLength: 2,
      receivedAt: 12,
    },
    {
      sessionId: 'a',
      type: 'chunk',
      chunkType: 'text-delta',
      textLength: 3,
      receivedAt: 15,
    },
  ];
  expect(summarizeFrames(frames, 20)).toMatchObject({
    textChunks: 2,
    textCharacters: 5,
    arrivedBeforeCompletion: true,
  });
  expect(summarizeFrames(frames, 12).arrivedBeforeCompletion).toBe(false);
});
test('probe policy disables execution and telemetry without replacing native model settings', async () => {
  const entries = parse(
    await readFile('dsh/profiles/probe-policy.cordis.yml', 'utf8'),
  ) as { id: string; disabled?: boolean; config?: { mode?: string } }[];
  for (const id of [
    'tool-bash',
    'tool-fs',
    'tool-plugin-manager',
    'tool-subagent',
    'session-log-deepseek',
    'session-telemetry-otel',
    'otel',
  ])
    expect(entries.find((entry) => entry.id === id)?.disabled).toBe(true);
  expect(
    entries.find((entry) => entry.id === 'sandbox-policy')?.config?.mode,
  ).toBe('read-only');
  expect(
    entries.find((entry) => entry.id === 'tool-executor-native')?.disabled,
  ).not.toBe(true);
  expect(entries.find((entry) => entry.id === 'llm-pi-ai')).toBeUndefined();
});

test('Web agent presets cannot reintroduce scoped tools', async () => {
  const entries = parse(
    await readFile('dsh/profiles/web-readonly.cordis.yml', 'utf8'),
  ) as { id: string; config: { id: string; plugins: unknown[] } }[];
  expect(entries.map((entry) => entry.id).sort()).toEqual([
    'preset-cordis',
    'preset-minimal',
    'preset-ptc',
    'preset-standard',
  ]);
  for (const entry of entries) expect(entry.config.plugins).toEqual([]);
});
