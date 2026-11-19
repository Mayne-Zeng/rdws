import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  readdir,
} from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { createProjectRuntime, prepareNativeProfile } from '@rdws/dsh/host';
import { summarizeFrames, type ProbeFrame } from '@rdws/dsh/events';
import { runtimeHome } from '@rdws/runtime-config';
const home = join(runtimeHome, 'runtime', 'dsh', 'project-poc');
const runId = randomUUID();
const workspace = join(
  runtimeHome,
  'projects',
  'poc',
  'demands',
  `probe-${runId}`,
);
const controls = join(runtimeHome, 'runtime', 'instances');
await mkdir(controls, { recursive: true, mode: 0o700 });
const lockPath = join(controls, 'project-poc.lock');
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(JSON.stringify({ pid: process.pid, runId }));
const report: Record<string, unknown> = {
  runId,
  startedAt: new Date().toISOString(),
  runtimeVersion: '0.2.2-rc.3',
  transport: 'official-sdk-stdio',
  completed: false,
};
let harness: ReturnType<typeof createProjectRuntime> | undefined;
let closed = false;
let stage = 'native-config';
let sensitive: string[] = [];
function sanitize(value: string) {
  let safe = value;
  for (const secret of sensitive.filter(Boolean))
    safe = safe.split(secret).join('[redacted]');
  return safe
    .replaceAll(runtimeHome, '$RDWS_HOME')
    .replaceAll(process.cwd(), '$REPOSITORY')
    .replaceAll(process.env.HOME ?? runtimeHome, '$HOME')
    .replace(/https?:\/\/[^\s"']+/g, '[endpoint]');
}
try {
  const credentials = parse(
    await readFile(join(home, '.credentials.yaml'), 'utf8'),
  ) as { refs?: Record<string, string> };
  const nativeConfigPath = join(home, 'profiles', 'rdws', 'cordis.patch.yml');
  const nativeConfigBefore = await readFile(nativeConfigPath, 'utf8');
  const patch = parse(nativeConfigBefore) as {
    id?: string;
    config?: {
      providers?: Record<
        string,
        {
          api?: string;
          baseURL?: string;
          models?: { id: string }[];
          apiKeyEnv?: string;
        }
      >;
    };
  }[];
  const providers = patch.find((entry) => entry.id === 'llm-pi-ai')?.config
    ?.providers;
  const route = providers?.['rdws-glm'];
  sensitive = [...Object.values(credentials.refs ?? {}), route?.baseURL ?? ''];
  if (
    !route?.models?.[0]?.id ||
    route.api !== 'openai-completions' ||
    !credentials.refs?.[route.apiKeyEnv ?? '']
  )
    throw new Error('Native GLM route or credential reference is incomplete.');
  report.provider = 'rdws-glm';
  report.model = route.models[0].id;
  report.protocol = route.api;
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await prepareNativeProfile(home, 'rdws-probe');
  const observation = join(controls, `stream-${runId}.jsonl`);
  await writeFile(observation, '', { mode: 0o600, flag: 'wx' });
  const observerPatch = join(controls, `observer-${runId}.cordis.yml`);
  await writeFile(
    observerPatch,
    JSON.stringify([
      {
        insert: [
          {
            id: 'rdws-probe-observer',
            name: fileURLToPath(
              new URL(
                '../dsh/plugins/probe-observer/index.mjs',
                import.meta.url,
              ),
            ),
            config: { path: observation },
          },
        ],
      },
    ]),
    { mode: 0o600, flag: 'wx' },
  );
  stage = 'startup';
  harness = createProjectRuntime({
    home,
    workspace,
    provider: 'rdws-glm',
    model: route.models[0].id,
    observerPatch,
  });
  await harness.start();
  report.handshake = true;
  const sessions: ({ sessionId: string } & Record<string, unknown>)[] = [];
  for (const [index, prompt] of [
    'Reply with RDWS_GLM_STREAM_OK, then count from 1 through 30 with each number on a separate line. Do not use any tools.',
    'Reply with RDWS_SECOND_SESSION_OK followed by the numbers 31 through 40. Do not use any tools.',
  ].entries()) {
    stage = `session-${index + 1}`;
    const session = harness.session();
    const cwd = await session.getWorkingDirectory();
    if (cwd !== workspace)
      throw new Error('Session cwd does not match its demand workspace.');
    const started = Date.now();
    const result = await session.run(prompt);
    const completed = Date.now();
    if (result.finishReason === 'error')
      report.nativeFailure = JSON.parse(
        sanitize(
          JSON.stringify({
            events: result.events.map((event) => ({
              type: event.type,
              ...(event.type === 'turn/end'
                ? { reason: event.data.reason }
                : {}),
            })),
            notificationMethods: [
              ...new Set(result.notifications.map((item) => item.method)),
            ],
          }),
        ),
      );
    if (
      result.finishReason === 'error' ||
      !result.finalResponse.includes(
        index === 0 ? 'RDWS_GLM_STREAM_OK' : 'RDWS_SECOND_SESSION_OK',
      )
    )
      throw new Error(
        sanitize(
          result.finalResponse || `Unexpected finish: ${result.finishReason}`,
        ),
      );
    const frames = (await readFile(observation, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProbeFrame)
      .filter((frame) => frame.sessionId === result.sessionId);
    const stream = summarizeFrames(frames, completed);
    const toolCalls = result.events.filter(
      (event) => event.type === 'tool/call',
    ).length;
    if (
      stream.textChunks < 2 ||
      !stream.arrivedBeforeCompletion ||
      toolCalls !== 0
    )
      throw new Error('Live streaming or no-tool probe assertions failed.');
    sessions.push({
      sessionId: result.sessionId,
      cwdVerified: true,
      elapsedMs: completed - started,
      finishReason: result.finishReason,
      responseCharacters: result.finalResponse.length,
      markerVerified: true,
      toolCalls,
      ...stream,
    });
  }
  report.sessions = sessions;
  stage = 'shutdown';
  await harness.close();
  closed = true;
  stage = 'restore';
  harness = createProjectRuntime({
    home,
    workspace,
    provider: 'rdws-glm',
    model: route.models[0].id,
    observerPatch,
  });
  closed = false;
  await harness.start();
  const restored = [];
  for (const saved of sessions) {
    const session = await harness.resumeSession(saved.sessionId);
    const cwd = await session.getWorkingDirectory();
    if (session.id !== saved.sessionId || cwd !== workspace)
      throw new Error(
        'Persisted session restore did not preserve identity and directory.',
      );
    restored.push({ sessionId: session.id, restored: true, cwdVerified: true });
  }
  report.restoredSessions = restored;
  await harness.close();
  closed = true;
  const logs = await readdir(join(home, 'sessions'), { recursive: true });
  const nativeSessionFiles = logs
    .filter(
      (path) =>
        /\.jsonl(?:\.zstd)?$/.test(path) &&
        sessions.some((session) => path.split('/').includes(session.sessionId)),
    )
    .map((path) => basename(path));
  report.nativeSessionFiles = nativeSessionFiles;
  if (nativeSessionFiles.length !== sessions.length)
    throw new Error(
      'Native session journals were not found for every probe session.',
    );
  report.nativeConfigurationUnchanged =
    nativeConfigBefore === (await readFile(nativeConfigPath, 'utf8'));
  if (!report.nativeConfigurationUnchanged)
    throw new Error('Native model configuration unexpectedly changed.');
  report.completed = true;
} catch (error) {
  report.failure = {
    stage,
    name: error instanceof Error ? error.name : 'UnknownError',
    message:
      stage === 'native-config'
        ? 'Native configuration could not be read or validated.'
        : sanitize(error instanceof Error ? error.message : String(error)),
  };
  process.exitCode = 1;
} finally {
  if (harness && !closed) {
    try {
      await harness.close();
      closed = true;
    } catch {
      report.cleanupConfirmed = false;
    }
  }
  if (!harness) closed = true;
  report.cleanupConfirmed = closed;
  report.finishedAt = new Date().toISOString();
  const directory = join(runtimeHome, 'state', 'exports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `dsh-probe-${runId}.json`),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  await lock.close();
  if (closed) await unlink(lockPath);
  console.log(JSON.stringify(report, null, 2));
}
