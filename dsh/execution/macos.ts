import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
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
import { promisify } from 'node:util';

type Scope = {
  runtimeRoot: string;
  control: string;
  tree: string;
  store: string;
  admin: string;
};
type ReadScope = Pick<Scope, 'runtimeRoot' | 'tree'>;

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
  bytes?: Buffer;
};
type Options = {
  runId?: string;
  signal?: AbortSignal;
  onOutput?: (event: Event) => void;
  timeoutMs?: number;
  authorizeStart?: (start: () => void) => Promise<void>;
};

const sandbox = '/usr/bin/sandbox-exec';
const bash = '/bin/bash';
const perl = '/usr/bin/perl';
const systemGit = '/usr/bin/git';
const locateTool = promisify(execFile);
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
export const maxSnapshotBytes = 256 * 1024;
const maxReadDiagnostics = 4 * 1024;
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

function profile(
  scope: ReadScope & { store?: string },
  executable: string,
  home: string,
  git: boolean,
  readWorker?: string,
) {
  const store = git && scope.store ? [scope.store] : [];
  const paths = [
    scope.runtimeRoot,
    scope.tree,
    ...(scope.store ? [scope.store] : []),
    executable,
    home,
    ...(readWorker ? [readWorker] : []),
  ];
  if (
    (!readWorker && !scope.store) ||
    paths.some((path) => !isAbsolute(path) || controls.test(path))
  )
    throw new Error('Invalid sandbox path');
  const quoted = JSON.stringify;
  const ancestors = new Set<string>();
  for (const path of [
    scope.tree,
    executable,
    ...store,
    ...(readWorker ? [readWorker] : []),
  ]) {
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
    ...(git || readWorker
      ? []
      : [`(allow file-write* (subpath ${quoted(scope.tree)}))`]),
    '(allow file-write* (literal "/dev/null"))',
    '(deny file-write-create (vnode-type SYMLINK))',
    `(deny file-write* (subpath ${quoted(join(scope.tree, '.git'))}))`,
    `(deny file-map-executable (subpath ${quoted(scope.tree)}))`,
    `(deny file-read* (subpath ${quoted(home)}) (subpath ${quoted(scope.runtimeRoot)}))`,
    ...(readWorker
      ? [
          '(deny file-read-data)',
          '(allow file-read-data (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (literal "/usr/bin/perl") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
          `(allow file-read* (literal ${quoted(readWorker)}))`,
          `(allow file-read-data (literal ${quoted(readWorker)}) (literal ${quoted(executable)}) (subpath ${quoted(scope.tree)}))`,
        ]
      : []),
    `(allow file-read* (subpath ${quoted(scope.tree)}) (literal ${quoted(executable)}))`,
    ...store.map((path) => `(allow file-read* (subpath ${quoted(path)}))`),
    ...[...ancestors].map(
      (path) => `(allow file-read-metadata (literal ${quoted(path)}))`,
    ),
    `(allow process-exec (literal ${quoted(executable === bash ? bash : perl)}) (literal ${quoted(executable)}))`,
  ].join('\n');
}

async function gitExecutable(path: string, signal?: AbortSignal) {
  if (!isAbsolute(path)) throw new Error('Invalid Git executable');
  const executable = await realpath(path);
  if (executable !== systemGit) return executable;
  const { stdout } = await locateTool(
    '/usr/bin/xcrun',
    ['--no-cache', '--find', 'git'],
    {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      timeout: 1500,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      signal,
    },
  );
  const candidate = stdout.trim();
  if (!isAbsolute(candidate) || controls.test(candidate))
    throw new Error('Invalid system Git executable');
  const resolved = await realpath(candidate);
  if (resolved === systemGit || !(await lstat(resolved)).isFile())
    throw new Error('Invalid system Git executable');
  await access(resolved, constants.X_OK);
  return resolved;
}

async function program(
  scope: Scope,
  gitPath: string,
  request: ExecutionRequest,
  signal?: AbortSignal,
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
      return {
        executable: await gitExecutable(gitPath, signal),
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
  scope: Pick<Scope, 'tree'>,
  policy: string,
  { executable, args, input }: Awaited<ReturnType<typeof program>>,
  { signal, onOutput, timeoutMs = 10_000 }: Options,
  rawSnapshot = false,
): Promise<Result> {
  if (signal?.aborted) return Promise.resolve(result(runId, 'aborted'));
  let launched: ChildProcess | undefined;
  return new Promise<Result>((resolve) => {
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
    launched = child;
    let initialized = false;
    let reaped = false;
    child.once('exit', () => {
      reaped = true;
    });
    child.once('error', () => {
      if (initialized)
        finish('unavailable', null, child.pid ? 'unconfirmed' : 'not-started');
    });
    const statusPipe = child.stdio?.[3];
    if (!statusPipe || !child.stdout || !child.stderr) {
      if (child.pid)
        throw new Error('Isolated execution pipes are unavailable');
      resolve(result(runId, 'unavailable'));
      return;
    }
    let startup = '';
    let inputFailed = false;
    statusPipe.on('data', (chunk: Buffer) => {
      startup = (startup + chunk.toString('ascii')).slice(0, 32);
    });
    statusPipe.on('end', () => {
      child.stdin?.end(startup === 'ready\n' ? input : undefined);
    });
    child.stdin?.on('error', () => {
      inputFailed = true;
    });
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const captured = { stdout: 0, stderr: 0 };
    let bytes = 0;
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
        stdout: rawSnapshot
          ? ''
          : Buffer.concat(streams.stdout).toString('utf8'),
        stderr: rawSnapshot
          ? ''
          : Buffer.concat(streams.stderr).toString('utf8'),
        ...(rawSnapshot &&
          status === 'ok' &&
          stop === 'confirmed' && { bytes: Buffer.concat(streams.stdout) }),
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
        const available = rawSnapshot
          ? (stream === 'stdout' ? maxSnapshotBytes : maxReadDiagnostics) -
            captured[stream]
          : maxBytes - bytes;
        const part = chunk.subarray(0, available);
        if (part.length) {
          bytes += part.length;
          captured[stream] += part.length;
          streams[stream].push(part);
          try {
            if (onOutput)
              void Promise.resolve(
                onOutput({ runId, stream, chunk: Buffer.from(part) }),
              ).catch(() => terminate('failed'));
          } catch {
            terminate('failed');
          }
        }
        if (part.length < chunk.length) terminate('output-limit');
      });
    }
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
    initialized = true;
  }).catch((): Result => {
    if (
      launched?.pid &&
      launched.exitCode === null &&
      launched.signalCode === null
    ) {
      try {
        process.kill(-launched.pid, 'SIGKILL');
      } catch {
        // A setup failure cannot supply the normal group and reaping evidence.
      }
    }
    return { ...result(runId, 'unavailable'), stop: 'unconfirmed' };
  });
}

function protectedReadPath(path: string) {
  return path
    .toLowerCase()
    .split('/')
    .some(
      (part) =>
        part === '.credentials.yaml' ||
        part === '.credentials.yml' ||
        part === '.ssh' ||
        part === '.gnupg' ||
        part === '.env' ||
        part === 'model.env' ||
        part.startsWith('.env.') ||
        part.endsWith('.pem') ||
        part.endsWith('.key') ||
        part === '.netrc' ||
        part === '.npmrc' ||
        part === '.git-credentials',
    );
}

export async function readMacosWorktree(
  verifiedScope: () => Promise<ReadScope>,
  path: string,
  options: Pick<Options, 'signal' | 'authorizeStart'> = {},
): Promise<Result> {
  const runId = randomUUID();
  if (options.signal?.aborted) return result(runId, 'aborted');
  if (!safeRelativePath(path) || protectedReadPath(path))
    return result(runId, 'rejected');
  if (process.platform !== 'darwin') return result(runId, 'unavailable');
  try {
    const scope = await verifiedScope();
    const identity = await lstat(scope.tree, { bigint: true });
    if (
      !identity.isDirectory() ||
      identity.uid !== BigInt(process.getuid!()) ||
      (identity.mode & 0o022n) !== 0n
    )
      return result(runId, 'rejected');
    const [worker, executable, home] = await Promise.all([
      realpath(new URL('./read-snapshot-worker.mjs', import.meta.url)),
      realpath(process.execPath),
      realpath(userInfo().homedir),
    ]);
    const policy = profile(scope, executable, home, false, worker);
    const program = {
      executable,
      args: [
        '--no-addons',
        worker,
        String(identity.dev),
        String(identity.ino),
        path,
        String(maxSnapshotBytes),
      ],
      input: undefined,
    };
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let open = true;
    let pending: Promise<Result> | undefined;
    const start = () => {
      if (!open) throw new Error('Read cannot be started again');
      signal.throwIfAborted();
      open = false;
      pending = launch(runId, scope, policy, program, { signal }, true);
    };
    try {
      if (options.authorizeStart) await options.authorizeStart(start);
      else start();
    } catch {
      controller.abort();
    } finally {
      open = false;
    }
    const outcome = await pending;
    return outcome
      ? { ...outcome, marker: 'none' }
      : result(runId, options.signal?.aborted ? 'aborted' : 'rejected');
  } catch {
    return result(runId, options.signal?.aborted ? 'aborted' : 'rejected');
  }
}

export async function runMacosWorktree(
  verifiedScope: () => Promise<Scope>,
  gitPath: string,
  request: ExecutionRequest,
  options: Options = {},
): Promise<Result> {
  const runId = options.runId ?? randomUUID();
  if (options.signal?.aborted) return result(runId, 'aborted');
  if (!allowedRequest(request)) return result(runId, 'rejected');
  if (process.platform !== 'darwin') return result(runId, 'unavailable');

  let scope: Scope;
  try {
    scope = await verifiedScope();
  } catch {
    return result(runId, options.signal?.aborted ? 'aborted' : 'rejected');
  }
  const markerPath = join(scope.control, 'isolated-execution');
  try {
    await mkdir(markerPath, { mode: 0o700 });
  } catch (error) {
    const denied = result(
      runId,
      options.signal?.aborted ? 'aborted' : 'rejected',
    );
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? { ...denied, marker: 'retained' }
      : denied;
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
      const command = await program(scope, gitPath, request, options.signal);
      const policy = profile(
        scope,
        command.executable,
        home,
        request.tool === 'git',
      );
      const control = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, control.signal])
        : control.signal;
      let open = true;
      let execution: Promise<Result> | undefined;
      const start = () => {
        if (!open)
          throw new Error('Isolated execution cannot be started again');
        signal.throwIfAborted();
        open = false;
        execution = launch(runId, scope, policy, command, {
          ...options,
          signal,
        }).catch(() => ({
          ...result(runId, 'unavailable'),
          stop: 'unconfirmed',
        }));
      };
      try {
        if (options.authorizeStart) await options.authorizeStart(start);
        else start();
      } catch {
        control.abort();
      } finally {
        open = false;
      }
      return (
        execution ??
        result(runId, options.signal?.aborted ? 'aborted' : 'rejected')
      );
    } catch {
      return result(runId, options.signal?.aborted ? 'aborted' : 'unavailable');
    }
  }
}
