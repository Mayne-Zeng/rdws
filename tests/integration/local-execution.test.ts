import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import {
  runMacosWorktree,
  type ExecutionRequest,
} from '../../dsh/execution/macos.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';

async function fingerprint(directory: string) {
  const hash = createHash('sha256');
  for (const file of (
    await readdir(directory, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()) {
    hash.update(file + '\0');
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

describe.runIf(process.platform === 'darwin')(
  'macOS isolated demand execution',
  () => {
    const project = 'poc';
    const demand = randomUUID();
    const otherDemand = randomUUID();
    let fixture: Awaited<ReturnType<typeof httpsGitFixture>>;
    let mirrors: RepositoryMirrors;
    let trees: DemandWorktrees;
    let plan: Parameters<DemandWorktrees['prepare']>[2];
    let scope: Awaited<ReturnType<DemandWorktrees['executionScope']>>;
    let sibling: Awaited<ReturnType<DemandWorktrees['executionScope']>>;
    let other: Awaited<ReturnType<DemandWorktrees['executionScope']>>;
    let git: string;
    let marker: string;
    const verified = () => trees.executionScope(project, demand, plan, 'app');
    const run = (
      request: ExecutionRequest,
      options?: Parameters<typeof runMacosWorktree>[3],
    ) => runMacosWorktree(verified, git, request, options);
    const shell = (script: string) => run({ tool: 'shell', script });

    beforeAll(async () => {
      git = execFileSync('/usr/bin/which', ['git'], {
        encoding: 'utf8',
      }).trim();
      fixture = await httpsGitFixture(project);
      mirrors = new RepositoryMirrors(fixture.root);
      trees = new DemandWorktrees(fixture.root, mirrors);
      await writeFile(join(fixture.work, 'sample.txt'), 'frozen baseline\n');
      await fixtureGit(['-C', fixture.work, 'add', '--', 'sample.txt']);
      const base = await fixture.commit();
      await fixture.update();
      await writeFile(
        fixture.registration,
        JSON.stringify([fixture.entry, { ...fixture.entry, id: 'second' }]),
      );
      for (const repository of ['app', 'second']) {
        const published = await mirrors.sync(
          project,
          repository,
          'fixture',
          randomUUID(),
          (publish) => publish(),
        );
        expect(published).toMatchObject({
          status: 'succeeded',
          candidateCommit: base,
        });
      }
      const baselines = await mirrors.captureBaselines(project);
      const frozenPlan = (id: string) =>
        baselines.map((row) => ({
          ...row,
          branch: 'rdws/' + id + '/' + row.repositoryId,
          worktreePath: 'worktrees/' + row.repositoryId,
          gitStorePath: '.gitstore/' + row.repositoryId + '.git',
        }));
      plan = frozenPlan(demand);
      await trees.prepare(project, demand, plan);
      await trees.prepare(project, otherDemand, frozenPlan(otherDemand));
      scope = await verified();
      sibling = await trees.executionScope(project, demand, plan, 'second');
      other = await trees.executionScope(
        project,
        otherDemand,
        frozenPlan(otherDemand),
        'app',
      );
      marker = join(scope.control, 'isolated-execution');
    });

    afterAll(async () => {
      await trees?.close();
      await mirrors?.close();
      if (marker)
        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await fixture?.close();
    });

    test('streams file and shell results and runs a real test and read-only Git queries', async () => {
      const store = await fingerprint(scope.store);
      const events: { runId: string; stream: string; chunk: Buffer }[] = [];
      const read = await run(
        { tool: 'file', operation: 'read', path: 'sample.txt' },
        { onOutput: (event) => events.push(event) },
      );
      expect(read).toMatchObject({
        status: 'ok',
        exitCode: 0,
        stop: 'confirmed',
        stdout: 'frozen baseline\n',
      });
      expect(events.length).toBeGreaterThan(0);
      expect(
        events.every(
          ({ runId, stream }) => runId === read.runId && stream === 'stdout',
        ),
      ).toBe(true);
      expect(Buffer.concat(events.map((event) => event.chunk)).toString()).toBe(
        read.stdout,
      );
      expect(
        await run({
          tool: 'file',
          operation: 'write',
          path: 'sample.txt',
          text: 'isolated edit\n',
        }),
      ).toMatchObject({ status: 'ok', stop: 'confirmed' });
      expect(
        await shell(
          "printf 'shell file\n' > shell.txt; printf 'shell stdout\n'",
        ),
      ).toMatchObject({
        status: 'ok',
        stdout: 'shell stdout\n',
        stop: 'confirmed',
      });
      expect(await readFile(join(scope.tree, 'shell.txt'), 'utf8')).toBe(
        'shell file\n',
      );
      expect(await run({ tool: 'git', operation: 'status' })).toMatchObject({
        status: 'ok',
        stop: 'confirmed',
        stdout: expect.stringContaining(' M sample.txt'),
      });
      expect(await run({ tool: 'git', operation: 'diff' })).toMatchObject({
        status: 'ok',
        stdout: expect.stringContaining('+isolated edit'),
      });
      expect(await run({ tool: 'git', operation: 'head' })).toMatchObject({
        status: 'ok',
        stdout: plan[0]!.baseCommit + '\n',
      });
      await writeFile(
        join(scope.tree, 'probe.mjs'),
        `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { test } from 'node:test';
      test('actual worktree contents', () => {
        assert.equal(readFileSync('sample.txt', 'utf8'), 'isolated edit\\n');
        assert.equal(readFileSync('shell.txt', 'utf8'), 'shell file\\n');
      });
    `,
      );
      expect(await run({ tool: 'test', path: 'probe.mjs' })).toMatchObject({
        status: 'ok',
        stop: 'confirmed',
        stdout: expect.stringContaining('ok 1 - actual worktree contents'),
      });
      expect(await fingerprint(scope.store)).toBe(store);
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('resolves the macOS system Git launcher before read-only execution', async () => {
      const authorizeStart = vi.fn(async () => {});
      expect(
        await runMacosWorktree(verified, '/usr/bin/git', {
          tool: 'git',
          operation: 'head',
        }),
      ).toMatchObject({
        status: 'ok',
        stop: 'confirmed',
        stdout: plan[0]!.baseCommit + '\n',
      });
      expect(
        await runMacosWorktree(
          verified,
          '/usr/bin/git',
          { tool: 'git', operation: 'head' },
          { authorizeStart },
        ),
      ).toMatchObject({ status: 'rejected', stop: 'not-started', stdout: '' });
      expect(authorizeStart).toHaveBeenCalledOnce();
    });

    test('rejects read and write outside the worktree and preserves Git administration', async () => {
      const source = join(scope.runtimeRoot, 'projects', project, 'sources');
      const protectedPaths = [
        join(source, 'app.git/HEAD'),
        join(other.tree, 'sample.txt'),
        join(sibling.tree, 'sample.txt'),
        fixture.registration,
        join(scope.runtimeRoot, 'secrets/gitlab.json'),
        join(scope.store, 'config'),
      ];
      const runtime = join(scope.runtimeRoot, 'runtime');
      await mkdir(runtime);
      const state = join(runtime, 'fixture-state');
      await writeFile(state, 'restricted runtime\n');
      protectedPaths.push(state);
      const before = await Promise.all(
        protectedPaths.map((path) => readFile(path, 'utf8')),
      );
      const sourceBefore = await fingerprint(source);
      const storeBefore = await fingerprint(scope.store);
      const otherBefore = await fingerprint(other.store);
      const inside = await readFile(join(scope.tree, '.git'), 'utf8');
      expect(before.every((value) => value.length > 0)).toBe(true);
      const control = await shell(
        'IFS= read -r text < sample.txt; printf "%s\\n" "$text"',
      );
      expect(control).toMatchObject({
        status: 'ok',
        stdout: await readFile(join(scope.tree, 'sample.txt'), 'utf8'),
      });
      for (const path of protectedPaths) {
        const read = await shell('IFS= read -r text < ' + quote(path));
        expect(read).toMatchObject({
          status: 'failed',
          stop: 'confirmed',
          stdout: '',
          stderr: expect.stringContaining('Operation not permitted'),
        });
        const write = await shell('printf denied > ' + quote(path));
        expect(write).toMatchObject({
          status: 'failed',
          stop: 'confirmed',
          stderr: expect.stringContaining('Operation not permitted'),
        });
      }
      expect(await shell('printf denied > .git')).toMatchObject({
        status: 'failed',
        stderr: expect.stringContaining('Operation not permitted'),
      });
      const folded = join(scope.tree, '.GIT');
      if (
        await lstat(folded).then(
          () => true,
          () => false,
        )
      ) {
        expect(await shell('printf denied > .GIT')).toMatchObject({
          status: 'failed',
          stderr: expect.stringContaining('Operation not permitted'),
        });
      }
      for (const path of [
        '../sample.txt',
        protectedPaths[0]!,
        '.git',
        './.GiT',
      ]) {
        expect(
          await run({ tool: 'file', operation: 'write', path, text: 'denied' }),
        ).toMatchObject({ status: 'rejected', stop: 'not-started' });
      }
      const push = {
        tool: 'git',
        operation: 'push',
      } as unknown as ExecutionRequest;
      expect(await run(push)).toMatchObject({
        status: 'rejected',
        stop: 'not-started',
      });
      expect(await shell('exec ' + quote(git) + ' --version')).toMatchObject({
        status: 'failed',
        stderr: expect.stringContaining('Operation not permitted'),
      });
      expect(await readFile(join(scope.tree, '.git'), 'utf8')).toBe(inside);
      expect(
        await Promise.all(protectedPaths.map((path) => readFile(path, 'utf8'))),
      ).toEqual(before);
      expect(await fingerprint(source)).toBe(sourceBefore);
      expect(await fingerprint(scope.store)).toBe(storeBefore);
      expect(await fingerprint(other.store)).toBe(otherBefore);
    });

    test('rejects unsafe registrations and existing filesystem aliases in every mode', async () => {
      const alias = join(scope.tree, 'foreign');
      const target = join(other.tree, 'sample.txt');
      for (const create of [link, symlink]) {
        await create(target, alias);
        try {
          for (const request of [
            { tool: 'file', operation: 'read', path: 'foreign' },
            { tool: 'shell', script: 'exit 0' },
            { tool: 'test', path: 'foreign' },
            { tool: 'git', operation: 'head' },
          ] as const) {
            expect(await run(request)).toMatchObject({
              status: 'rejected',
              stop: 'not-started',
            });
          }
        } finally {
          await unlink(alias);
        }
      }
      const wrong = () =>
        trees.executionScope(project, demand, plan, 'unknown');
      expect(
        await runMacosWorktree(wrong, git, { tool: 'git', operation: 'head' }),
      ).toMatchObject({ status: 'rejected', stop: 'not-started' });
      const pointer = join(scope.tree, '.git');
      const original = await readFile(pointer, 'utf8');
      await writeFile(pointer, 'gitdir: ' + other.admin + '\n');
      try {
        expect(await run({ tool: 'git', operation: 'head' })).toMatchObject({
          status: 'rejected',
          stop: 'not-started',
        });
      } finally {
        await writeFile(pointer, original);
      }
    });

    test('the sandbox and Node runtime deny network, links, process creation and signals', async () => {
      let connections = 0;
      const listener = () =>
        createServer((socket) => {
          connections++;
          socket.end();
        });
      const tcp = listener(),
        unix = listener();
      const socketPath = join(fixture.root, 't06.sock');
      tcp.listen(0, '127.0.0.1');
      unix.listen(socketPath);
      try {
        await Promise.all([once(tcp, 'listening'), once(unix, 'listening')]);
        const address = tcp.address();
        if (!address || typeof address === 'string')
          throw new Error('TCP fixture unavailable');
        await Promise.all([
          once(connect(address.port, '127.0.0.1'), 'end'),
          once(connect(socketPath), 'end'),
        ]);
        expect(connections).toBe(2);
        await writeFile(
          join(scope.tree, 'controls.mjs'),
          `
        import assert from 'node:assert/strict';
        import { linkSync, symlinkSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        import { connect } from 'node:net';
        import { test } from 'node:test';
        test('hardlink and symlink', () => {
          assert.throws(() => linkSync('sample.txt', 'extra-hard'), { code: 'EPERM' });
          assert.throws(() => symlinkSync('sample.txt', 'extra-sym'), { code: 'ERR_ACCESS_DENIED' });
        });
        test('process creation, replacement and signal', () => {
          assert.throws(() => spawn(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
          assert.throws(() => process.execve(process.execPath, [process.execPath, '--version'], {}), {
            code: 'ERR_ACCESS_DENIED', permission: 'ChildProcess',
          });
          assert.throws(() => process.dlopen({ exports: {} }, 'fixture.node'), { code: 'ERR_DLOPEN_DISABLED' });
          assert.throws(() => process.kill(${process.pid}, 0), { code: 'EPERM' });
        });
        for (const [name, destination] of [
          ['TCP', { port: ${address.port}, host: '127.0.0.1' }],
          ['Unix socket', { path: ${JSON.stringify(socketPath)} }],
        ]) {
          test(name, async () => {
            await assert.rejects(new Promise((resolve, reject) => {
              const socket = connect(destination).on('error', reject).on('connect', () => {
                socket.destroy(); resolve();
              });
            }), { code: 'EPERM' });
          });
        }
      `,
        );
        const controls = await run({ tool: 'test', path: 'controls.mjs' });
        expect(controls).toMatchObject({
          status: 'ok',
          stop: 'confirmed',
          stdout: expect.stringContaining('# pass 4'),
        });
        expect(await shell('(:); exit $?')).toMatchObject({
          status: 'failed',
          stop: 'confirmed',
          stderr: expect.stringContaining('fork: Operation not permitted'),
        });
        expect(connections).toBe(2);
      } finally {
        tcp.close();
        unix.close();
        await Promise.all([once(tcp, 'close'), once(unix, 'close')]);
      }
    });

    test('separates command outcomes, output limits and observed stopping', async () => {
      expect(await shell('printf failure >&2; exit 8')).toMatchObject({
        status: 'failed',
        stop: 'confirmed',
        exitCode: 8,
        stderr: 'failure',
      });
      expect(
        await shell(
          "printf 'sandbox-exec: fake\\n' >&2; printf ready >&3; exit 71",
        ),
      ).toMatchObject({
        status: 'failed',
        stop: 'confirmed',
        marker: 'released',
        exitCode: 71,
        stderr: expect.stringContaining('Bad file descriptor'),
      });
      expect(
        await runMacosWorktree(verified, '/nonexistent/t06-fixture-git', {
          tool: 'git',
          operation: 'head',
        }),
      ).toMatchObject({ status: 'unavailable', stop: 'not-started' });
      const nonExecutable = join(scope.runtimeRoot, 'non-executable-git');
      await writeFile(nonExecutable, 'fixture', { mode: 0o600 });
      expect(
        await runMacosWorktree(verified, nonExecutable, {
          tool: 'git',
          operation: 'head',
        }),
      ).toMatchObject({
        status: 'unavailable',
        stop: 'confirmed',
        exitCode: 71,
        stderr: expect.stringContaining('Cannot execute target'),
      });
      const node = process.execPath;
      try {
        process.execPath = nonExecutable;
        expect(
          await run(
            {
              tool: 'file',
              operation: 'write',
              path: 'untouched.txt',
              text: 'x'.repeat(64 * 1024),
            },
            {
              onOutput: () => {
                throw new Error('fixture observer failure');
              },
            },
          ),
        ).toMatchObject({
          status: 'unavailable',
          stop: 'confirmed',
          marker: 'released',
        });
      } finally {
        process.execPath = node;
      }
      await expect(
        lstat(join(scope.tree, 'untouched.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const controller = new AbortController();
      const command: ExecutionRequest = {
        tool: 'shell',
        script: 'printf "%s\\n" "$$"; while :; do :; done',
      };
      const stopped = await run(command, {
        signal: controller.signal,
        onOutput: () => controller.abort(),
      });
      expect(stopped).toMatchObject({ status: 'aborted', stop: 'confirmed' });
      const pid = Number(stopped.stdout.trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(-pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      expect(await run(command, { signal: controller.signal })).toMatchObject({
        status: 'aborted',
        stop: 'not-started',
      });
      const preLaunch = new AbortController();
      expect(
        await runMacosWorktree(
          async () => {
            preLaunch.abort();
            return verified();
          },
          git,
          command,
          { signal: preLaunch.signal },
        ),
      ).toMatchObject({ status: 'aborted', stop: 'not-started' });
      const timeout = await run(command, { timeoutMs: 300 });
      expect(timeout).toMatchObject({ status: 'timeout', stop: 'confirmed' });
      const exhausted = await shell('while :; do printf "%01024d" 0; done');
      expect(exhausted).toMatchObject({
        status: 'output-limit',
        stop: 'confirmed',
      });
      expect(exhausted.stdout).toHaveLength(64 * 1024);
    });

    test('launch authorization can deny execution after worktree preparation', async () => {
      const path = 'denied-start.txt';
      const authorizeStart = vi.fn(async () => {});
      const denied = await run(
        { tool: 'file', operation: 'write', path, text: 'unexpected write' },
        { authorizeStart },
      );
      expect(authorizeStart).toHaveBeenCalledOnce();
      expect(denied).toMatchObject({
        status: 'rejected',
        stop: 'not-started',
        marker: 'released',
      });
      await expect(lstat(join(scope.tree, path))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    test('a lost launch confirmation cancels and reaps the process that really started', async () => {
      let observe!: () => void;
      const started = new Promise<void>((resolve) => {
        observe = resolve;
      });
      const path = 'launched-before-lost-confirmation.txt';
      const runResult = await run(
        {
          tool: 'shell',
          script: `printf yes > ${path}; printf started; while :; do :; done`,
        },
        {
          timeoutMs: 2500,
          onOutput: () => observe(),
          async authorizeStart(start) {
            start();
            expect(start).toThrow();
            await started;
            throw new Error('Synthetic launch confirmation lost');
          },
        },
      );
      expect(runResult).toMatchObject({
        status: 'aborted',
        stop: 'confirmed',
        marker: 'released',
        stdout: 'started',
      });
      expect(await readFile(join(scope.tree, path), 'utf8')).toBe('yes');
    });

    test('an early spawn error without stdio is observed with no process started', async () => {
      const processes = createRequire(import.meta.url)(
        'node:child_process',
      ) as typeof import('node:child_process');
      const child = new processes.ChildProcess();
      const spawn = vi.spyOn(processes, 'spawn').mockImplementationOnce(() => {
        process.nextTick(() =>
          child.emit(
            'error',
            Object.assign(new Error('Synthetic file descriptor exhaustion'), {
              code: 'EMFILE',
            }),
          ),
        );
        return child;
      });
      syncBuiltinESMExports();
      try {
        const failed = await runMacosWorktree(
          () => Promise.resolve(scope),
          git,
          { tool: 'shell', script: 'exit 0' },
        );
        expect(spawn).toHaveBeenCalledOnce();
        expect(failed).toMatchObject({
          status: 'unavailable',
          stop: 'not-started',
          marker: 'released',
        });
      } finally {
        spawn.mockRestore();
        syncBuiltinESMExports();
      }
    });

    test('an asynchronous output failure stops the actual isolated process', async () => {
      const failed = await run(
        { tool: 'shell', script: 'printf started; while :; do :; done' },
        {
          async onOutput() {
            throw new Error('Synthetic output consumer failure');
          },
          timeoutMs: 2500,
        },
      );
      expect(failed).toMatchObject({
        status: 'failed',
        stop: 'confirmed',
        marker: 'released',
        stdout: 'started',
      });
    });

    test('retains the isolation marker when process-group disappearance cannot be confirmed', async () => {
      let known = 0;
      const kill = process.kill.bind(process);
      const spy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) => {
          if (pid === -known && signal === 0)
            throw Object.assign(new Error('unconfirmed fixture'), {
              code: 'EPERM',
            });
          return kill(pid, signal);
        });
      try {
        const uncertain = await run(
          { tool: 'shell', script: 'printf "%s\\n" "$$"' },
          {
            onOutput: ({ chunk }) => {
              known = Number(chunk.toString().trim());
            },
          },
        );
        expect(uncertain).toMatchObject({
          status: 'ok',
          stop: 'unconfirmed',
          marker: 'retained',
        });
        expect(
          JSON.parse(await readFile(join(marker, 'owner.json'), 'utf8')),
        ).toMatchObject({ runId: uncertain.runId, launcherPid: process.pid });
        expect(await shell('exit 0')).toMatchObject({
          status: 'rejected',
          stop: 'not-started',
        });
      } finally {
        spy.mockRestore();
        expect(known).toBeGreaterThan(1);
        expect(() => kill(-known, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        await rm(marker, { recursive: true });
      }
    });

    test('reports a retained marker without losing the confirmed run when cleanup fails', async () => {
      const extra = join(marker, 'fixture-retention');
      try {
        const outcome = await run(
          { tool: 'shell', script: 'printf closed' },
          {
            onOutput: () => writeFileSync(extra, 'synthetic marker content'),
          },
        );
        expect(outcome).toMatchObject({
          status: 'ok',
          stop: 'confirmed',
          marker: 'retained',
          stdout: 'closed',
        });
        expect(await shell('exit 0')).toMatchObject({
          status: 'rejected',
          stop: 'not-started',
        });
        expect(await readFile(extra, 'utf8')).toBe('synthetic marker content');
      } finally {
        await rm(marker, { recursive: true });
      }
    });
  },
);
