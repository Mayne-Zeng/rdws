import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export class MirrorGitError extends Error {
  constructor(
    readonly reason: 'git' | 'timeout' | 'stopped' | 'unconfirmed',
    readonly exitCode?: number,
  ) {
    super(reason);
  }
}

export function mirrorGit(
  directory: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeout?: number;
    authorization?: string;
    groupLog?: string;
  } = {},
): Promise<string> {
  if (options.signal?.aborted)
    return Promise.reject(new MirrorGitError('stopped'));
  const flags = [
    '--git-dir=' + directory,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.sslVerify=true',
    '-c',
    'http.proxy=',
    '-c',
    'protocol.allow=never',
    '-c',
    'fetch.fsckObjects=true',
    '-c',
    'maintenance.auto=false',
    ...(options.authorization
      ? ['--config-env=http.extraHeader=RDWS_GIT_AUTH']
      : []),
  ];
  return new Promise((resolve, reject) => {
    const launch = options.groupLog
      ? [
          '/bin/sh',
          '-c',
          'umask 077; test -f "$1" && printf "%s\\n" "$$" >> "$1" || exit 1; shift; exec "$@"',
          'rdws-git',
          options.groupLog,
          'git',
        ]
      : ['git'];
    const child = spawn(launch[0]!, [...launch.slice(1), ...flags, ...args], {
      cwd: '/',
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        ...(options.authorization
          ? { RDWS_GIT_AUTH: options.authorization }
          : {}),
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '',
      failure: MirrorGitError['reason'] | undefined;
    let deadline: NodeJS.Timeout;
    function group(signal: number) {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    }
    function stop(reason: MirrorGitError['reason']) {
      if (failure) return;
      failure = reason;
      group(constants.signals.SIGKILL);
      deadline = setTimeout(
        () => finish(new MirrorGitError('unconfirmed')),
        1500,
      );
    }
    function finish(error?: MirrorGitError) {
      clearTimeout(timer);
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else resolve(output.trimEnd());
    }
    const cancelled = () => stop('stopped');
    const timer = setTimeout(() => stop('timeout'), options.timeout ?? 60_000);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (output.length + chunk.length > 131_072) stop('git');
      else output += chunk;
    });
    child.once('error', () => {
      if (!failure) failure = 'git';
    });
    child.once('close', (code) => {
      if (group(0)) {
        group(constants.signals.SIGKILL);
        finish(new MirrorGitError('unconfirmed'));
      } else if (failure || code !== 0)
        finish(new MirrorGitError(failure ?? 'git', code ?? undefined));
      else finish();
    });
  });
}
