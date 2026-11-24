import { getEventListeners } from 'node:events';
import { userInfo } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { NativeShellToolJob } from '../../apps/server/src/modules/native-shell-tool-job.ts';
import { NativeWriteToolJob } from '../../apps/server/src/modules/native-write-tool-job.ts';
import {
  closeWriteJobs,
  ownWriteJob,
} from '../../apps/server/src/modules/native-projects.ts';
import {
  reassembleAndScrub,
  scanOutput,
  scrubOutput,
} from '../../apps/server/src/modules/shell-output-handling.ts';

// §11.20.27 repair round: the job lifecycle (B-4, B-5), the fail-closed
// output policy (A-2) and the chunk reassembly (B-2) judged on their own
// with a fake Broker. The processes, the Broker transactions and the
// supervision are the loopback's subject; here the job is driven through
// the same control surface the Host uses.
afterEach(() => vi.unstubAllEnvs());

// The real account home: the job's policy names it from the process.
const home = userInfo().homedir;
const tree = home + '/runtime/rdws/projects/poc/demands/d/worktrees/app';
const runtimeRoot = home + '/runtime/rdws';
const scope = {
  projectId: 'poc',
  requirementId: 'req',
  sessionId: 'ses',
  who: { userId: 'u', authSessionId: 'a' },
};
const grant = { generation: 'g', contextVersion: 3 };
const digestBody = {
  toolName: 'bash',
  arguments: { command: 'node x.test.mjs', description: 'Run' },
};
const sha = (value: string | Buffer) =>
  import('node:crypto').then(({ createHash }) =>
    createHash('sha256').update(value).digest('hex'),
  );

type Receipt = {
  status: string;
  result: { status: string; stop: string; exitCode: number | null };
};
function broker(input: {
  chunks?: ('stdout' | 'stderr')[];
  text?: string[];
  receipt?: Receipt;
  locations?: 'ok' | 'fail' | 'empty';
  settle?: boolean;
}) {
  return {
    assertWireLease() {},
    async execute(
      _scope: unknown,
      _invocation: unknown,
      onOutput?: (event: {
        stream: 'stdout' | 'stderr';
        chunk: Buffer;
      }) => void,
    ) {
      const streams = input.chunks ?? ['stdout'];
      input.text?.forEach((text, index) => {
        const stream = streams[index] ?? 'stdout';
        // Chunks of 8 bytes: a prefix or a credential is split across
        // chunk boundaries as it would be by the real executor.
        const bytes = Buffer.from(text);
        for (let at = 0; at < bytes.length; at += 8)
          onOutput?.({ stream, chunk: bytes.subarray(at, at + 8) });
      });
      return (
        input.receipt ?? {
          status: 'finished',
          result: { status: 'ok', stop: 'confirmed', exitCode: 0 },
        }
      );
    },
    async executionLocations() {
      if (input.locations === 'fail') throw new Error('database unavailable');
      if (input.locations === 'empty') return { tree: '', runtimeRoot: '' };
      return { tree, runtimeRoot };
    },
    async registerOutputSnapshot() {
      return '.rdws-read/0f0e0d0c-0b0a-4988-8776-655443322110';
    },
  } as never;
}

async function settled<T extends NativeShellToolJob | NativeWriteToolJob>(
  job: T,
  body: Record<string, unknown>,
  jobId: string,
) {
  expect(
    await job.control('begin', { ...body, jobId }, async () => {}),
  ).toEqual({ accepted: true });
  await expect
    .poll(
      async () =>
        (
          (await job.control('status', { ...body, jobId }, async () => {})) as {
            state: string;
          }
        ).state,
      { timeout: 4000 },
    )
    .toMatch(/^(ok|failed|unknown)$/);
}

test.beforeAll(() => {
  process.env.RDWS_MODE = 'test';
});

test('§11.20.27 B-2 a prefix and a credential split across chunks are handled after reassembly, and per-chunk handling would miss them', () => {
  const policy = { prefixes: [{ value: home, replacement: '<home>' }] };
  const whole =
    'location: ' + tree + '/x.test.mjs\npassword=hunter2\nplain line\n';
  const expected =
    'location: <home>/runtime/rdws/projects/poc/demands/d/worktrees/app/x.test.mjs\npassword=[redacted]\nplain line\n';
  // Cuts that fall inside the home prefix (so the prefix is split across
  // two chunks), inside the credential value, and at a line end.
  const cuts = {
    prefix: whole.indexOf(home) + home.length - 2,
    credential: whole.indexOf('hunter2') + 3,
    lineEnd: whole.length - 'plain line\n'.length - 1,
  };
  for (const [name, cut] of Object.entries(cuts)) {
    const chunks = [
      Buffer.from(whole.slice(0, cut)),
      Buffer.from(whole.slice(cut)),
    ];
    const handled = reassembleAndScrub(chunks, policy);
    expect(handled.text, name).toBe(expected);
    expect(scanOutput(handled.text, policy), name).toEqual({
      prefixes: 0,
      credentials: 0,
    });
    // The red control: handling the chunks one by one misses the split
    // prefix and the split credential — which is why the job reassembles
    // first; a cut at a line end is harmless either way.
    const perChunk = chunks
      .map((chunk) => scrubOutput(chunk.toString('utf8'), policy).text)
      .join('');
    if (name === 'lineEnd') expect(perChunk).toBe(expected);
    else {
      expect(perChunk, 'per-chunk control ' + name).not.toBe(expected);
      // The leaked tail of the split value, or the split prefix itself.
      expect(perChunk).toMatch(name === 'prefix' ? /Users/ : /ter2/);
    }
  }
});

test('§11.20.27 A-2 when the Broker cannot name the locations the output is refused, never given with an empty policy', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  for (const locations of ['fail', 'empty'] as const) {
    const job = new NativeShellToolJob({
      scope,
      grant,
      broker: broker({
        text: ['tree=' + tree + '\nhome=' + home + '\npassword=hunter2\n'],
        locations,
      }),
      repositoryId: 'app',
      request: { tool: 'test', path: 'x.test.mjs' },
      hostSignal: new AbortController().signal,
    });
    const jobId = job.offer(
      scope.who,
      scope.requirementId,
      scope.sessionId,
      3,
      await digest(digestBody),
      Date.now() + 5000,
      () => true,
    );
    await settled(job, digestBody, jobId);
    const output = (await job.control('output', { jobId }, async () => {})) as {
      outcome: string;
      reason?: string;
      stdout: { text: string };
      stderr: { text: string };
    };
    expect(output, locations).toMatchObject({
      outcome: 'refused',
      reason: 'output-policy-unavailable',
    });
    expect(output.stdout.text).toBe('');
    expect(output.stderr.text).toBe('');
    expect(JSON.stringify(output)).not.toContain(home);
    expect(JSON.stringify(output)).not.toContain('hunter2');
    await job.close();
  }
  // The control: with the locations the same output is handled and given.
  const job = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({
      text: ['tree=' + tree + '\nhome=' + home + '\npassword=hunter2\n'],
    }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: new AbortController().signal,
  });
  const jobId = job.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    Date.now() + 5000,
    () => true,
  );
  await settled(job, digestBody, jobId);
  const output = (await job.control('output', { jobId }, async () => {})) as {
    outcome: string;
    stdout: { text: string };
  };
  expect(output.outcome).toBe('finished');
  expect(output.stdout.text).toContain('tree=.');
  expect(output.stdout.text).toContain('home=<home>');
  expect(output.stdout.text).toContain('password=[redacted]');
  await job.close();
});

async function digest(body: Record<string, unknown>) {
  const { bodyHash } = await import('@rdws/dsh/access');
  return bodyHash(body);
}

test('§11.20.27 B-4 a settled job releases its raw output, its host listener and its owner reference', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  const host = new AbortController();
  const before = getEventListeners(host.signal, 'abort').length;
  let settledCount = 0;
  const job = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({ text: ['x'.repeat(64 * 1024) + '\n'] }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: host.signal,
    onSettled: () => {
      settledCount++;
    },
  });
  expect(getEventListeners(host.signal, 'abort').length).toBe(before + 1);
  const jobId = job.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    Date.now() + 5000,
    () => true,
  );
  await settled(job, digestBody, jobId);
  expect(job.retained).toEqual({ bytes: 0, listening: false });
  expect(getEventListeners(host.signal, 'abort').length).toBe(before);
  expect(settledCount).toBe(1);
  // The result is still readable after the release, and close is final.
  expect(
    (
      (await job.control('output', { jobId }, async () => {})) as {
        state: string;
      }
    ).state,
  ).toBe('ok');
  await job.close();
  expect(settledCount).toBe(1);
  // The file job follows the same lifecycle.
  const fileHost = new AbortController();
  const fileBefore = getEventListeners(fileHost.signal, 'abort').length;
  const fileJob = new NativeWriteToolJob({
    scope,
    grant,
    broker: broker({
      text: [
        JSON.stringify({ kind: 'before', existed: false, size: 0, bytes: '' }) +
          '\n' +
          JSON.stringify({
            kind: 'after',
            existed: false,
            created: true,
            size: 1,
            sha256: await sha('x'),
          }) +
          '\n',
      ],
    }),
    repositoryId: 'app',
    request: {
      tool: 'file',
      operation: 'write',
      path: 'a.txt',
      text: 'x',
      receipt: true,
    },
    hostSignal: fileHost.signal,
  });
  const fileBody = {
    toolName: 'write',
    arguments: { file_path: 'a.txt', content: 'x' },
  };
  const fileId = fileJob.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(fileBody),
    Date.now() + 5000,
    () => true,
  );
  await settled(fileJob, fileBody, fileId);
  expect(fileJob.retained).toEqual({ bytes: 0, listening: false });
  expect(getEventListeners(fileHost.signal, 'abort').length).toBe(fileBefore);
  expect(
    await fileJob.control('output', { jobId: fileId }, async () => {}),
  ).toMatchObject({ outcome: 'applied', created: true });
  await fileJob.close();
});

test('§11.20.27 B-5 a job whose stop could not be confirmed fails the shutdown instead of being swallowed', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  const unknown = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({
      receipt: {
        status: 'unknown',
        result: { status: 'aborted', stop: 'unconfirmed', exitCode: null },
      },
    }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: new AbortController().signal,
  });
  const jobId = unknown.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    Date.now() + 5000,
    () => true,
  );
  await settled(unknown, digestBody, jobId);
  await expect(closeWriteJobs([unknown])).rejects.toThrow(
    'could not be confirmed stopped',
  );
  const known = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({ text: ['ok\n'] }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: new AbortController().signal,
  });
  const knownId = known.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    Date.now() + 5000,
    () => true,
  );
  await settled(known, digestBody, knownId);
  await expect(closeWriteJobs([known])).resolves.toBeUndefined();
});

test('§11.20.27 A-7 a late begin after the permit expired is refused with the authority conflict, not the generic denial', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  const job = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({ text: ['ok\n'] }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: new AbortController().signal,
  });
  const jobId = job.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    Date.now() + 1,
    () => true,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await expect(
    job.control('begin', { ...digestBody, jobId }, async () => {}),
  ).rejects.toMatchObject({ statusCode: 409 });
  // Without a permit at all the generic denial stays.
  const bare = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({ text: ['ok\n'] }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: new AbortController().signal,
  });
  await expect(
    bare.control(
      'begin',
      { ...digestBody, jobId: randomish() },
      async () => {},
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  await job.close();
  await bare.close();
});

function randomish() {
  return '00000000-0000-4000-8000-000000000000';
}

// Repair round 3 (B-4r): the two terminal paths that never begin.
async function refusedBeforeBegin(lateBegin: boolean) {
  const host = new AbortController();
  const before = getEventListeners(host.signal, 'abort').length;
  let settledCount = 0;
  const job = new NativeShellToolJob({
    scope,
    grant,
    broker: broker({ text: ['ok\n'] }),
    repositoryId: 'app',
    request: { tool: 'test', path: 'x.test.mjs' },
    hostSignal: host.signal,
    onSettled: () => {
      settledCount++;
    },
  });
  const jobId = job.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest(digestBody),
    lateBegin ? Date.now() + 1 : Date.now() + 5000,
    () => true,
  );
  if (lateBegin) {
    // The permit expired: the begin is refused with the authority conflict
    // and nothing ran; then the step releases the job.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      job.control('begin', { ...digestBody, jobId }, async () => {}),
    ).rejects.toMatchObject({ statusCode: 409 });
  }
  // The step release cancels the job directly (runtime-context's discard
  // and close do the same); a definite zero-execution terminal state
  // releases at once.
  job.cancel();
  expect(job.retained).toEqual({ bytes: 0, listening: false });
  expect(getEventListeners(host.signal, 'abort').length).toBe(before);
  expect(settledCount).toBe(1);
  await job.close();
  expect(settledCount).toBe(1);
}

test('§11.20.27 B-4 a job cancelled before its begin is released: the cancel, and the late begin refused then cancelled', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  await refusedBeforeBegin(false);
  await refusedBeforeBegin(true);
  // The file job follows the same path.
  const fileHost = new AbortController();
  const fileBefore = getEventListeners(fileHost.signal, 'abort').length;
  const fileJob = new NativeWriteToolJob({
    scope,
    grant,
    broker: broker({ text: [''] }),
    repositoryId: 'app',
    request: {
      tool: 'file',
      operation: 'write',
      path: 'a.txt',
      text: 'x',
      receipt: true,
    },
    hostSignal: fileHost.signal,
  });
  fileJob.offer(
    scope.who,
    scope.requirementId,
    scope.sessionId,
    3,
    await digest({
      toolName: 'write',
      arguments: { file_path: 'a.txt', content: 'x' },
    }),
    Date.now() + 5000,
    () => true,
  );
  fileJob.cancel();
  expect(fileJob.retained).toEqual({ bytes: 0, listening: false });
  expect(getEventListeners(fileHost.signal, 'abort').length).toBe(fileBefore);
  await fileJob.close();
});

test('§11.20.27 B-4 the owner holds a job from its offer until it settles; a refused offer is cancelled and released', async () => {
  vi.stubEnv('RDWS_MODE', 'test');
  const host = new AbortController();
  const table = new Set<NativeShellToolJob>();
  const job = ownWriteJob(
    (onSettled) =>
      new NativeShellToolJob({
        scope,
        grant,
        broker: broker({ text: ['ok\n'] }),
        repositoryId: 'app',
        request: { tool: 'test', path: 'x.test.mjs' },
        hostSignal: host.signal,
        onSettled,
      }),
    table,
  );
  // Before the offer the job is constructed but not owned.
  expect(table.size).toBe(0);
  // An offer that is accepted makes the job owned; it is offered with a
  // permit whose step is no longer current, as after a takeover.
  const offerDigest = await digest(digestBody);
  expect(() =>
    job.offer(
      scope.who,
      scope.requirementId,
      scope.sessionId,
      3,
      offerDigest,
      Date.now() + 5000,
      () => false,
    ),
  ).not.toThrow();
  expect(table.has(job)).toBe(true);
  job.cancel();
  expect(table.has(job)).toBe(false);
  expect(job.retained).toEqual({ bytes: 0, listening: false });
  // A job whose offer throws is released the same way and never kept.
  const refusing = ownWriteJob(
    (onSettled) =>
      new NativeShellToolJob({
        scope: { ...scope, who: { userId: 'u', authSessionId: 'closed' } },
        grant,
        broker: broker({ text: ['ok\n'] }),
        repositoryId: 'app',
        request: { tool: 'test', path: 'x.test.mjs' },
        hostSignal: host.signal,
        onSettled,
      }),
    table,
  );
  let threw = false;
  try {
    refusing.offer(
      scope.who,
      scope.requirementId,
      scope.sessionId,
      3,
      await digest(digestBody),
      Date.now() - 1,
      () => true,
    );
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(table.has(refusing)).toBe(false);
  expect(refusing.retained).toEqual({ bytes: 0, listening: false });
});
