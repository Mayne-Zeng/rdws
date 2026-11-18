import { mkdir, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
export async function prepareNativeProfile(home: string, profile = 'rdws') {
  const directory = join(home, 'profiles', profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(directory, 'cordis.patch.yml'), '[]\n', {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const manifest = join(directory, 'package.json');
  try {
    await access(manifest);
  } catch {
    await writeFile(
      manifest,
      JSON.stringify(
        {
          name: 'dsh-profile-rdws',
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
            },
          },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  }
}
export function createProjectRuntime(options: {
  home: string;
  workspace: string;
  provider: string;
  model: string;
  observerPatch: string;
}) {
  const environment: NodeJS.ProcessEnv = {
    DSH_PRIMARY_RUNTIME: '',
    DSH_PERMISSION_MODE: 'read-only',
    DSH_MAX_TOKENS_AS_SUCCESS: 'false',
  };
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SystemRoot',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (process.env[key]) environment[key] = process.env[key];
  const harness = new DeepSeekHarness({
    dshHome: options.home,
    processCwd: options.workspace,
    cwd: options.workspace,
    profile: 'rdws-probe',
    patches: [
      join(options.home, 'profiles', 'rdws', 'cordis.patch.yml'),
      fileURLToPath(
        new URL('../profiles/probe-policy.cordis.yml', import.meta.url),
      ),
      options.observerPatch,
    ],
    provider: options.provider,
    model: options.model,
    env: environment,
    maxTokens: 1024,
    initializeTimeoutMs: 30000,
    requestTimeoutMs: 90000,
    shutdownTimeoutMs: 3000,
    approvalRequests: true,
    onUserQuestion: async () => ({ cancelled: true }),
  });
  harness.client.start();
  harness.client.onRequest(async () => ({ outcome: 'rejected' }));
  return harness;
}
