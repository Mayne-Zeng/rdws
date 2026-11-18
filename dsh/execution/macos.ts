import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

type Scope = {
  runtimeRoot: string;
  control: string;
  tree: string;
  store: string;
  admin: string;
};

export type ExecutionRequest =
  | { tool: 'file'; operation: 'read'; path: string }
  | { tool: 'file'; operation: 'write'; path: string; text: string }
  | { tool: 'shell'; script: string }
  | { tool: 'test'; path: string }
  | { tool: 'git'; operation: 'status' | 'diff' | 'head' };

type Status =
  | 'ok'
  | 'failed'
  | 'rejected'
  | 'unavailable'
  | 'aborted'
  | 'timeout'
  | 'output-limit';
type Event = { runId: string; stream: 'stdout' | 'stderr'; chunk: Buffer };
type Result = {
  runId: string;
  status: Status;
  stop: 'not-started' | 'confirmed' | 'unconfirmed';
  marker: 'none' | 'released' | 'retained';
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
type Options = {
  signal?: AbortSignal;
  onOutput?: (event: Event) => void;
  timeoutMs?: number;
};

const sandbox = '/usr/bin/sandbox-exec';
const bash = '/bin/bash';
const perl = '/usr/bin/perl';
const shellBootstrap = [
  "printf 'ready\\n' >&3 || exit 71",
  'exec 3>&-',
  'script=$1; shift',
  'eval "$script"',
].join('\n');
const execBootstrap = String.raw`
  use strict;
  use Fcntl qw(F_SETFD FD_CLOEXEC);
  open(my $status, '>&=3') or exit 71;
  fcntl($status, F_SETFD, FD_CLOEXEC) or exit 71;
  syswrite($status, "ready\n") or exit 71;
  exec { $ARGV[0] } @ARGV;
  my $error = "$!";
  syswrite($status, "exec-failed\n");
  warn "Cannot execute target: $error\n";
  exit 71;
`;
const maxBytes = 64 * 1024;
const stopTimeoutMs = 1500;
const controls = /[\p{Cc}\p{Cf}]/u;
const gitQueries = {
  status: ['status', '--porcelain=v1', '--ignore-submodules=all'],
  diff: [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    'HEAD',
    '--',
  ],
  head: ['rev-parse', '--verify', 'HEAD^{commit}'],
} as const;

function result(runId: string, status: Status): Result {
  return {
    runId,
    status,
    stop: 'not-started',
    marker: 'none',
    exitCode: null,
    stdout: '',
    stderr: '',
  };
}

function safeRelativePath(path: string) {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    !controls.test(path) &&
    !path.includes('\\') &&
    path
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

function allowedRequest(request: ExecutionRequest) {
  switch (request.tool) {
    case 'file':
      return (
        safeRelativePath(request.path) &&
        (request.operation === 'read' ||
          (request.operation === 'write' &&
            typeof request.text === 'string' &&
            Buffer.byteLength(request.text) <= maxBytes))
      );
    case 'shell':
      return (
        typeof request.script === 'string' &&
        !request.script.includes('\0') &&
        Buffer.byteLength(request.script) <= 32 * 1024
      );
    case 'test':
      return safeRelativePath(request.path);
    case 'git':
      return Object.hasOwn(gitQueries, request.operation);
    default:
      return false;
  }
}

async function inspectFiles(root: string, signal?: AbortSignal) {
  const directories = [root];
  let entries = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    signal?.throwIfAborted();
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid!() ||
      stat.mode & 0o022
    ) {
      throw new Error('Invalid execution directory');
    }
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (++entries > 100_000)
        throw new Error('Execution directory is too large');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else {
        const file = await lstat(path);
        if (
          !file.isFile() ||
          file.nlink !== 1 ||
          file.uid !== process.getuid!() ||
          file.mode & 0o022
        ) {
          throw new Error('Invalid execution file');
        }
      }
    }
  }
}

function profile(scope: Scope, executable: string, home: string, git: boolean) {
  const paths = [scope.runtimeRoot, scope.tree, scope.store, executable, home];
  if (paths.some((path) => !isAbsolute(path) || controls.test(path)))
    throw new Error('Invalid sandbox path');
  const quoted = JSON.stringify;
  const ancestors = new Set<string>();
  for (const path of [scope.tree, executable, ...(git ? [scope.store] : [])]) {
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent))
      ancestors.add(parent);
  }
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny mach-lookup)',
    '(deny signal)',
    '(deny process-fork)',
    '(deny process-exec)',
    '(deny file-link)',
    '(deny file-write*)',
    ...(git ? [] : [`(allow file-write* (subpath ${quoted(scope.tree)}))`]),
    '(allow file-write* (literal "/dev/null"))',
    '(deny file-write-create (vnode-type SYMLINK))',
    `(deny file-write* (subpath ${quoted(join(scope.tree, '.git'))}))`,
    `(deny file-map-executable (subpath ${quoted(scope.tree)}))`,
    `(deny file-read* (subpath ${quoted(home)}) (subpath ${quoted(scope.runtimeRoot)}))`,
    `(allow file-read* (subpath ${quoted(scope.tree)}) (literal ${quoted(executable)}))`,
    ...(git ? [`(allow file-read* (subpath ${quoted(scope.store)}))`] : []),
    ...[...ancestors].map(
      (path) => `(allow file-read-metadata (literal ${quoted(path)}))`,
    ),
    `(allow process-exec (literal ${quoted(executable === bash ? bash : perl)}) (literal ${quoted(executable)}))`,
  ].join('\n');
}

async function program(
  scope: Scope,
  gitPath: string,
  request: ExecutionRequest,
) {
  switch (request.tool) {
    case 'file': {
      const worker = await readFile(
        new URL('./file-worker.mjs', import.meta.url),
        'utf8',
      );
      return {
        executable: await realpath(process.execPath),
        args: [
          '--no-addons',
          '--input-type=module',
          '-e',
          worker,
          '--',
          request.operation,
          request.path,
          String(maxBytes),
        ],
        input: request.operation === 'write' ? request.text : undefined,
      };
    }
    case 'shell':
      return {
        executable: bash,
        args: [request.script],
      };
    case 'test':
      return {
        executable: await realpath(process.execPath),
        args: [
          '--permission',
          '--allow-fs-read=' + scope.tree,
          '--allow-fs-write=' + scope.tree,
          '--no-addons',
          '--test-reporter=tap',
          '--',
          join(scope.tree, request.path),
        ],
      };
    case 'git':
      if (!isAbsolute(gitPath)) throw new Error('Invalid Git executable');
      return {
        executable: await realpath(gitPath),
        args: [
          '--no-pager',
          '--no-optional-locks',
          '--git-dir=' + scope.admin,
          '--work-tree=' + scope.tree,
          '-c',
          'core.bare=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'protocol.allow=never',
          '-c',
          'credential.helper=',
          '-c',
          'maintenance.auto=false',
          ...gitQueries[request.operation],
        ],
      };
  }
}

function groupGone(pid: number) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function launch(
  runId: string,
  scope: Scope,
  policy: string,
  { executable, args, input }: Awaited<ReturnType<typeof program>>,
  { signal, onOutput, timeoutMs = 10_000 }: Options,
): Promise<Result> {
  if (signal?.aborted) return Promise.resolve(result(runId, 'aborted'));
  return new Promise((resolve) => {
    const launcher =
      executable === bash
        ? [
            bash,
            '--noprofile',
            '--norc',
            '-c',
            shellBootstrap,
            'rdws-sandbox-launcher',
            ...args,
          ]
        : [perl, '-e', execBootstrap, '--', executable, ...args];
    const child = spawn(sandbox, ['-p', policy, ...launcher], {
      cwd: scope.tree,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
    });
    let startup = '';
    let inputFailed = false;
    child.stdio[3]!.on('data', (chunk: Buffer) => {
      startup = (startup + chunk.toString('ascii')).slice(0, 32);
    });
    child.stdio[3]!.on('end', () => {
      child.stdin?.end(startup === 'ready\n' ? input : undefined);
    });
    child.stdin?.on('error', () => {
      inputFailed = true;
    });
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0;
    let reaped = false;
    let settled = false;
    let requested: Status | undefined;
    let stopTimer: NodeJS.Timeout | undefined;

    function finish(
      status: Status,
      exitCode: number | null,
      stop: Result['stop'],
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        runId,
        status,
        exitCode,
        stop,
        marker: 'retained',
        stdout: Buffer.concat(streams.stdout).toString('utf8'),
        stderr: Buffer.concat(streams.stderr).toString('utf8'),
      });
    }

    function terminate(reason: Status) {
      if (settled || requested) return;
      requested = reason;
      if (child.pid && !reaped) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Only the exit and process group checks can confirm termination.
        }
      }
      stopTimer = setTimeout(
        () => finish(reason, null, 'unconfirmed'),
        stopTimeoutMs,
      );
    }
    const abort = () => terminate('aborted');
    const deadline = setTimeout(() => terminate('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]!.on('data', (chunk: Buffer) => {
        if (settled) return;
        const part = chunk.subarray(0, maxBytes - bytes);
        if (part.length) {
          bytes += part.length;
          streams[stream].push(part);
          try {
            onOutput?.({ runId, stream, chunk: Buffer.from(part) });
          } catch {
            terminate('failed');
          }
        }
        if (part.length < chunk.length) terminate('output-limit');
      });
    }
    child.once('error', () =>
      finish('unavailable', null, child.pid ? 'unconfirmed' : 'not-started'),
    );
    child.once('exit', () => {
      reaped = true;
    });
    child.once('close', (code) => {
      const stop = child.pid
        ? reaped && groupGone(child.pid)
          ? 'confirmed'
          : 'unconfirmed'
        : 'not-started';
      const status =
        startup !== 'ready\n'
          ? 'unavailable'
          : code === 0 && !inputFailed
            ? 'ok'
            : 'failed';
      finish(
        status === 'unavailable' && requested === 'failed'
          ? status
          : (requested ?? status),
        code,
        stop,
      );
    });
  });
}

export async function runMacosWorktree(
  verifiedScope: () => Promise<Scope>,
  gitPath: string,
  request: ExecutionRequest,
  options: Options = {},
): Promise<Result> {
  const runId = randomUUID();
  if (options.signal?.aborted) return result(runId, 'aborted');
  if (!allowedRequest(request)) return result(runId, 'rejected');
  if (process.platform !== 'darwin') return result(runId, 'unavailable');

  let scope: Scope;
  let markerPath: string;
  try {
    scope = await verifiedScope();
    markerPath = join(scope.control, 'isolated-execution');
    await mkdir(markerPath, { mode: 0o700 });
  } catch {
    return result(runId, options.signal?.aborted ? 'aborted' : 'rejected');
  }

  const owner = join(markerPath, 'owner.json');
  const outcome = await executeRegistered();
  if (outcome.stop === 'unconfirmed') return { ...outcome, marker: 'retained' };
  try {
    await unlink(owner).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rmdir(markerPath);
    return { ...outcome, marker: 'released' };
  } catch {
    return { ...outcome, marker: 'retained' };
  }

  async function executeRegistered(): Promise<Result> {
    try {
      await writeFile(
        owner,
        JSON.stringify({ runId, launcherPid: process.pid }) + '\n',
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      try {
        await inspectFiles(scope.tree, options.signal);
        await inspectFiles(scope.store, options.signal);
      } catch {
        return result(runId, options.signal?.aborted ? 'aborted' : 'rejected');
      }
      const home = await realpath(userInfo().homedir);
      const command = await program(scope, gitPath, request);
      const policy = profile(
        scope,
        command.executable,
        home,
        request.tool === 'git',
      );
      return await launch(runId, scope, policy, command, options);
    } catch {
      return result(runId, 'unavailable');
    }
  }
}
