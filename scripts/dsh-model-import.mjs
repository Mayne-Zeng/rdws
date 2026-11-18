import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { runtimeHome } from './env.mjs';
const home = join(runtimeHome, 'runtime', 'dsh', 'project-poc');
const profile = join(home, 'profiles', 'rdws');
const credentialsPath = join(home, '.credentials.yaml');
const patchPath = join(profile, 'cordis.patch.yml');
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const existing = await Promise.all([
  exists(credentialsPath),
  exists(patchPath),
]);
if (existing.every(Boolean)) {
  console.log(
    'Native configuration already exists; preserved. Use DSH settings for subsequent edits.',
  );
  process.exit(0);
}
if (existing.some(Boolean))
  throw new Error(
    'Partial native configuration exists; refusing to overwrite it.',
  );
const source = parseEnv(
  await readFile(join(runtimeHome, 'secrets', 'model.env'), 'utf8'),
);
if (
  source.MODEL_PROTOCOL !== 'openai-chat-completions' ||
  !source.MODEL_ID?.trim() ||
  !source.MODEL_API_KEY?.trim()
)
  throw new Error('Incomplete model initialization input.');
let endpoint;
try {
  endpoint = new URL(source.MODEL_BASE_URL);
} catch {
  throw new Error('Invalid model base URL.');
}
if (
  !['http:', 'https:'].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password
)
  throw new Error(
    'Model base URL must use HTTP(S) without embedded credentials.',
  );
const patch = [
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'rdws-glm': {
          displayName: 'GLM',
          api: 'openai-completions',
          baseURL: source.MODEL_BASE_URL,
          apiKeyEnv: 'RDWS_GLM_API_KEY',
          models: [{ id: source.MODEL_ID }],
        },
      },
    },
  },
];
await mkdir(profile, { recursive: true, mode: 0o700 });
await writeFile(
  credentialsPath,
  JSON.stringify(
    { version: 1, refs: { RDWS_GLM_API_KEY: source.MODEL_API_KEY } },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
await writeFile(patchPath, JSON.stringify(patch, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  'Initialized native DSH provider and write-only credential reference. Runtime validation is still pending.',
);
