import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  chmod,
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
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import {
  editStringLimit,
  editTargetLimit,
  runMacosWorktree,
  writeContentLimit,
  writeExistingLimit,
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

    test('snapshot worker discards bytes if the named file changes during the same descriptor read', async () => {
      const path = 'read-race.txt';
      const root = await lstat(scope.tree, { bigint: true });
      const worker = fileURLToPath(
        new URL(
          '../../dsh/execution/read-snapshot-worker.mjs',
          import.meta.url,
        ),
      );
      const args = [worker, String(root.dev), String(root.ino), path, '262144'];
      await writeFile(join(scope.tree, path), 'baseline');
      const original = spawnSync(process.execPath, args, {
        cwd: scope.tree,
        env: {},
      });
      expect(original.status).toBe(0);
      expect(original.stdout).toEqual(Buffer.from('baseline'));
      for (const mutation of [
        `fs.writeFileSync('${path}', 'modified');`,
        `fs.writeFileSync('read-race-next.txt', 'modified'); fs.renameSync('read-race-next.txt', '${path}');`,
      ]) {
        await writeFile(join(scope.tree, path), 'baseline');
        const handler = `
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          const inode = fs.lstatSync('${path}').ino;
          const read = fs.readSync;
          let changed = false;
          fs.readSync = (descriptor, ...args) => {
            const count = read(descriptor, ...args);
            if (!changed && fs.fstatSync(descriptor).ino === inode) {
              changed = true;
              ${mutation}
            }
            return count;
          };
          syncBuiltinESMExports();
        `;
        const hook =
          'data:text/javascript;base64,' +
          Buffer.from(handler).toString('base64');
        const observed = spawnSync(
          process.execPath,
          ['--import', hook, ...args],
          { cwd: scope.tree, env: {} },
        );
        expect(observed.status).toBe(1);
        expect(observed.stdout).toHaveLength(0);
        expect(await readFile(join(scope.tree, path), 'utf8')).toBe('modified');
      }
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

    // §11.20.27 A segment, the T06 side of the Write and Edit loop (W5, R7,
    // R8, R9 and the T06 half of R20): the receipt channel of the file
    // worker, judged against the real Seatbelt process and the real bytes.
    test('§11.20.27 W5 Write and Edit run the two-receipt channel and refuse before any write', async () => {
      const sha = (text: string) =>
        createHash('sha256').update(text).digest('hex');
      const receipts = (result: { stdout: string; stderr: string }) => {
        expect(result.stderr).toBe('');
        return result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      };
      const target = join(scope.tree, 'wt-sum.mjs');
      const temps = async () =>
        (await readdir(scope.tree)).filter((name) =>
          name.startsWith('.rdws-write-'),
        );
      const first = 'export const sum = (a, b) => a - b;\n';
      const second =
        'export const sum = (a, b) => a + b;\nexport const twice = (x) => x + x;\n';
      // Write creates: no file before, so the first receipt says so and
      // carries no bytes; the second carries the digest of what landed.
      const created = await run({
        tool: 'file',
        operation: 'write',
        path: 'wt-sum.mjs',
        text: first,
        receipt: true,
      });
      expect(created).toMatchObject({
        status: 'ok',
        exitCode: 0,
        stop: 'confirmed',
      });
      expect(receipts(created)).toEqual([
        { kind: 'before', existed: false, size: 0, bytes: '' },
        {
          kind: 'after',
          existed: false,
          created: true,
          size: Buffer.byteLength(first),
          sha256: sha(first),
        },
      ]);
      expect(await readFile(target, 'utf8')).toBe(first);
      expect(await temps()).toEqual([]);
      // Write updates: the bytes before the write leave first, base64.
      const updated = await run({
        tool: 'file',
        operation: 'write',
        path: 'wt-sum.mjs',
        text: second,
        receipt: true,
      });
      expect(updated).toMatchObject({
        status: 'ok',
        exitCode: 0,
        stop: 'confirmed',
      });
      expect(receipts(updated)).toEqual([
        {
          kind: 'before',
          existed: true,
          size: Buffer.byteLength(first),
          sha256: sha(first),
          bytes: Buffer.from(first).toString('base64'),
        },
        {
          kind: 'after',
          existed: true,
          created: false,
          size: Buffer.byteLength(second),
          sha256: sha(second),
        },
      ]);
      expect(await readFile(target, 'utf8')).toBe(second);
      // Edit: a unique match, then every match; the file bytes equal the
      // literal replacement of the bytes before (left to right, not
      // overlapping), which is what the Host derives to compare.
      const events: string[] = [];
      const edited = await run(
        {
          tool: 'file',
          operation: 'edit',
          path: 'wt-sum.mjs',
          old_string: 'a + b',
          new_string: 'Number(a) + Number(b)',
          replace_all: false,
        },
        {
          // The two receipts are two separate writes of the worker.
          onOutput: ({ chunk }) => void events.push(chunk.toString()),
        },
      );
      const afterUnique = second.replace('a + b', 'Number(a) + Number(b)');
      expect(edited).toMatchObject({
        status: 'ok',
        exitCode: 0,
        stop: 'confirmed',
      });
      expect(receipts(edited)).toEqual([
        {
          kind: 'before',
          existed: true,
          size: Buffer.byteLength(second),
          sha256: sha(second),
          bytes: Buffer.from(second).toString('base64'),
        },
        {
          kind: 'after',
          existed: true,
          created: false,
          size: Buffer.byteLength(afterUnique),
          sha256: sha(afterUnique),
          replacements: 1,
        },
      ]);
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0]!)).toMatchObject({ kind: 'before' });
      expect(JSON.parse(events[1]!)).toMatchObject({ kind: 'after' });
      expect(await readFile(target, 'utf8')).toBe(afterUnique);
      const all = await run({
        tool: 'file',
        operation: 'edit',
        path: 'wt-sum.mjs',
        old_string: 'x',
        new_string: 'y',
        replace_all: true,
      });
      const afterAll = afterUnique.split('x').join('y');
      // Every occurrence, counted from left to right without overlapping.
      const occurrences = afterUnique.split('x').length - 1;
      expect(occurrences).toBeGreaterThan(1);
      expect(receipts(all)[1]).toMatchObject({
        kind: 'after',
        size: Buffer.byteLength(afterAll),
        sha256: sha(afterAll),
        replacements: occurrences,
      });
      expect(await readFile(target, 'utf8')).toBe(afterAll);
      // The staged file never survives and the rename stays in the tree.
      expect(await temps()).toEqual([]);
      expect((await lstat(target)).nlink).toBe(1);
      // R7: no match and an ambiguous match are error results; the first
      // receipt is not even emitted and the file is unchanged.
      for (const [edit, code] of [
        [{ old_string: 'absent', new_string: 'x', replace_all: false }, 5],
        // "const" is on both lines: two matches without replace_all.
        [{ old_string: 'const', new_string: 'X', replace_all: false }, 6],
      ] as const) {
        const refused = await run({
          tool: 'file',
          operation: 'edit',
          path: 'wt-sum.mjs',
          ...edit,
        });
        expect(refused).toMatchObject({
          status: 'failed',
          exitCode: code,
          stop: 'confirmed',
        });
        expect(refused.stdout).toBe('');
        expect(await readFile(target, 'utf8')).toBe(afterAll);
      }
      // R7: a target, a before, or a result over the limit, and a file that
      // is not UTF-8, are refused before the first receipt: zero write.
      const big = join(scope.tree, 'wt-big.txt');
      const fat = 'é'.repeat(editTargetLimit / 2 + 1);
      await writeFile(big, fat);
      const overTarget = await run({
        tool: 'file',
        operation: 'edit',
        path: 'wt-big.txt',
        old_string: 'é',
        new_string: 'x',
        replace_all: true,
      });
      expect(overTarget).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(overTarget.stdout).toBe('');
      expect(await readFile(big, 'utf8')).toBe(fat);
      await writeFile(big, 'a'.repeat(100));
      const overResult = await run({
        tool: 'file',
        operation: 'edit',
        path: 'wt-big.txt',
        old_string: 'a',
        new_string: 'b'.repeat(editStringLimit),
        replace_all: true,
      });
      expect(overResult).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(overResult.stdout).toBe('');
      expect(await readFile(big, 'utf8')).toBe('a'.repeat(100));
      await writeFile(big, Buffer.from([0xff, 0xfe, 0x61]));
      const notUtf8 = await run({
        tool: 'file',
        operation: 'edit',
        path: 'wt-big.txt',
        old_string: 'a',
        new_string: 'b',
        replace_all: false,
      });
      expect(notUtf8).toMatchObject({ status: 'failed', exitCode: 4 });
      expect(notUtf8.stdout).toBe('');
      expect(
        Buffer.from(await readFile(big)).equals(
          Buffer.from([0xff, 0xfe, 0x61]),
        ),
      ).toBe(true);
      // R8: Write over an existing file beyond the limit, over content
      // beyond the limit, and over a protected location: zero write.
      await writeFile(big, fat);
      const overExisting = await run({
        tool: 'file',
        operation: 'write',
        path: 'wt-big.txt',
        text: 'small',
        receipt: true,
      });
      expect(overExisting).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(overExisting.stdout).toBe('');
      expect(await readFile(big, 'utf8')).toBe(fat);
      // An existing file exactly at the limit is still replaced.
      await writeFile(big, 'e'.repeat(writeExistingLimit));
      expect(
        await run({
          tool: 'file',
          operation: 'write',
          path: 'wt-big.txt',
          text: 'small\n',
          receipt: true,
        }),
      ).toMatchObject({ status: 'ok', exitCode: 0 });
      expect(await readFile(big, 'utf8')).toBe('small\n');
      const overContent = await run({
        tool: 'file',
        operation: 'write',
        path: 'wt-new.txt',
        text: 'c'.repeat(writeContentLimit + 1),
        receipt: true,
      });
      expect(overContent).toMatchObject({
        status: 'rejected',
        stop: 'not-started',
      });
      await expect(lstat(join(scope.tree, 'wt-new.txt'))).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
      await writeFile(join(scope.tree, '.env'), 'KEEP=1\n');
      for (const path of [
        '.env',
        'cfg/.env.local',
        'wt-sum.mjs/.credentials.yml',
      ]) {
        expect(
          await run({
            tool: 'file',
            operation: 'write',
            path,
            text: 'over',
            receipt: true,
          }),
        ).toMatchObject({ status: 'rejected', stop: 'not-started' });
        expect(
          await run({
            tool: 'file',
            operation: 'edit',
            path,
            old_string: 'K',
            new_string: 'x',
            replace_all: false,
          }),
        ).toMatchObject({ status: 'rejected', stop: 'not-started' });
      }
      expect(await readFile(join(scope.tree, '.env'), 'utf8')).toBe('KEEP=1\n');
      // R7: the admission refuses traversal, absolute paths and .git (case
      // insensitive) before any process starts; the reserved segment prefix
      // is refused earlier, by the shared argument shape.
      for (const path of [
        '../wt-sum.mjs',
        '/wt-sum.mjs',
        '.git/config',
        'src/.GIT/config',
        'a\\u0000b',
      ]) {
        expect(
          await run({
            tool: 'file',
            operation: 'edit',
            path,
            old_string: 'a',
            new_string: 'b',
            replace_all: false,
          }),
          path,
        ).toMatchObject({ status: 'rejected', stop: 'not-started' });
      }
      // W5 and the T06 half of R20: the first receipt leaves before the
      // rename. With the directory made unwritable the staging file cannot
      // even be created, so exactly the first receipt is out, the result is
      // a failure without the second receipt, and the file is unchanged —
      // the Host side treats a missing after receipt as unknown, never as
      // success.
      await chmod(scope.tree, 0o500);
      let lost: Awaited<ReturnType<typeof run>>;
      try {
        lost = await run({
          tool: 'file',
          operation: 'write',
          path: 'wt-sum.mjs',
          text: 'lost\n',
          receipt: true,
        });
      } finally {
        await chmod(scope.tree, 0o755);
      }
      expect(lost).toMatchObject({ status: 'failed', stop: 'confirmed' });
      expect(lost.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(lost.stdout.trim())).toMatchObject({
        kind: 'before',
        existed: true,
        sha256: sha(afterAll),
      });
      expect(await readFile(target, 'utf8')).toBe(afterAll);
      expect(await temps()).toEqual([]);
      // R9: a link that exists before the run refuses the start.
      await symlink('wt-sum.mjs', join(scope.tree, 'wt-link'));
      try {
        expect(
          await run({
            tool: 'file',
            operation: 'edit',
            path: 'wt-sum.mjs',
            old_string: 'y',
            new_string: 'z',
            replace_all: true,
          }),
        ).toMatchObject({ status: 'rejected', stop: 'not-started' });
        expect(await readFile(target, 'utf8')).toBe(afterAll);
      } finally {
        await unlink(join(scope.tree, 'wt-link'));
      }
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    // §11.20.27 B segment, W19 / R16 / R5: the Shell profile refuses the
    // protected locations that exist in the tree, by literal rules for
    // reading and writing; the rest of the process boundary (no fork, no
    // network, no writes to .git, no reads of the account home) is the
    // standing Seatbelt skeleton.
    test('§11.20.27 W19 the Shell profile refuses the protected locations of the tree by literal rules', async () => {
      const canary = 'w19-canary-5c1f';
      const env = join(scope.tree, '.env');
      await writeFile(env, 'SECRET=' + canary + '\n');
      await mkdir(join(scope.tree, 'secrets'), { recursive: true });
      const pem = join(scope.tree, 'secrets', 'server.pem');
      await writeFile(
        pem,
        '-----BEGIN RSA PRIVATE KEY-----\n' +
          canary +
          '\n-----END RSA PRIVATE KEY-----\n',
      );
      await writeFile(
        join(scope.tree, 'wt-protected.test.mjs'),
        `
        import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
const denied = (name, action) => {
  try {
    action();
    console.log(name + '-allowed');
  } catch (error) {
    console.log(name + '-denied:' + error.code);
  }
};
test('protected locations are refused', () => {
  denied('env-read', () => readFileSync('.env', 'utf8'));
  denied('env-write', () => writeFileSync('.env', 'over'));
  denied('pem-read', () => readFileSync('secrets/server.pem', 'utf8'));
  denied('pem-write', () => writeFileSync('secrets/server.pem', 'over'));
  denied('git-write', () => writeFileSync('.git/HEAD', 'over'));
});
`,
      );
      try {
        const result = await run({
          tool: 'test',
          path: 'wt-protected.test.mjs',
        });
        expect(result).toMatchObject({
          status: 'ok',
          exitCode: 0,
          stop: 'confirmed',
        });
        for (const marker of [
          'env-read-denied:',
          'env-write-denied:',
          'pem-read-denied:',
          'pem-write-denied:',
          'git-write-denied:',
        ])
          expect(result.stdout, marker).toContain(marker);
        expect(result.stdout).not.toMatch(/-allowed/);
        expect(result.stdout).not.toContain(canary);
        expect(result.stderr).not.toContain(canary);
        expect(await readFile(env, 'utf8')).toBe('SECRET=' + canary + '\n');
        expect(await readFile(pem, 'utf8')).toContain(canary);
        // The same process boundary the file tools never reach: a read
        // of the account home is refused as well.
        await writeFile(
          join(scope.tree, 'wt-protected.test.mjs'),
          `
          import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
test('home is refused', () => {
  try { readFileSync(homedir() + '/.zshrc'); console.log('HOME-READ-ALLOWED'); } catch (error) { console.log('home-read-denied:' + error.code); }
});
`,
        );
        const home = await run({ tool: 'test', path: 'wt-protected.test.mjs' });
        expect(home.stdout).toContain('home-read-denied:');
        expect(home.stdout).not.toContain('HOME-READ-ALLOWED');
      } finally {
        await rm(join(scope.tree, 'secrets'), { recursive: true });
        await unlink(env).catch(() => {});
        await unlink(join(scope.tree, 'wt-protected.test.mjs')).catch(() => {});
      }
      await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);
