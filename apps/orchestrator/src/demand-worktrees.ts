import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { schema } from '@rdws/db';
import {
  isMissing,
  readOwned,
  safeDirectory,
  safeId,
} from '@rdws/syncer/config';
import { mirrorGit, MirrorGitError } from '@rdws/syncer/git';
import type { RepositoryMirrors } from '@rdws/syncer/mirror';

export type DemandRepositories =
  (typeof schema.requirementWorktreePlan.$inferSelect)['repositories'];
type Paths = {
  runtimeRoot: string;
  demand: string;
  control: string;
  lock: string;
  manifest: string;
};
const bareConfig =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';
const parts = ['.gitstore', 'worktrees', 'demand.yaml'];
const uuid = /^[a-f0-9-]{36}$/;

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
async function syncPath(path: string) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function record(path: string, value: string) {
  const stage = path + '.' + randomUUID();
  try {
    await writeFile(stage, value, { flag: 'wx', mode: 0o600 });
    await syncPath(stage);
    await link(stage, path);
    await syncPath(dirname(path));
  } finally {
    await unlink(stage).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}
const read = async (path: string, size = 4096) =>
  (await readOwned(path, size)).toString();

export class DemandWorktrees {
  private readonly stop = new AbortController();
  private readonly runs = new Set<Promise<void>>();
  constructor(
    private readonly root: string,
    private readonly mirrors: RepositoryMirrors,
  ) {}

  private async paths(
    projectId: string,
    id: string,
    plan: DemandRepositories,
    create = false,
  ): Promise<Paths> {
    if (
      !safeId(projectId) ||
      !uuid.test(id) ||
      !plan.length ||
      plan.length > 16
    )
      throw new Error('Invalid worktree plan');
    const ids = new Set<string>();
    const copies = plan.map((item) => {
      const {
        repositoryId,
        baseCommit,
        baselineRef,
        sourceBinding,
        branch,
        worktreePath,
        gitStorePath,
      } = item;
      if (
        !safeId(repositoryId) ||
        ids.has(repositoryId) ||
        !/^[0-9a-f]{40}$/.test(baseCommit) ||
        !/^[0-9a-f]{64}$/.test(sourceBinding) ||
        !baselineRef.startsWith('refs/heads/') ||
        branch !== 'rdws/' + id + '/' + repositoryId ||
        worktreePath !== 'worktrees/' + repositoryId ||
        gitStorePath !== '.gitstore/' + repositoryId + '.git'
      )
        throw new Error('Invalid frozen repository');
      ids.add(repositoryId);
      return {
        repositoryId,
        baseCommit,
        baselineRef,
        sourceBinding,
        branch,
        worktreePath,
        gitStorePath,
      };
    });
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    await safeDirectory(this.root, []);
    const root = await realpath(this.root);
    const parent = await safeDirectory(
      root,
      ['projects', projectId, 'demands'],
      create,
    );
    const demand = join(parent, id);
    return {
      runtimeRoot: root,
      demand,
      control: join(demand, '.rdws-worktree'),
      lock: join(parent, '.' + id + '.worktree-lock'),
      manifest:
        JSON.stringify({ projectId, requirementId: id, repositories: copies }) +
        '\n',
    };
  }

  private async pointers(
    root: string,
    plan: DemandRepositories,
    stagedRoot?: string,
  ) {
    const trees = await safeDirectory(root, ['worktrees']);
    const stores = await safeDirectory(root, ['.gitstore']);
    return Promise.all(
      plan.map(async (item) => {
        const store = await safeDirectory(stores, [item.repositoryId + '.git']);
        const tree = await safeDirectory(trees, [item.repositoryId]);
        const links = await safeDirectory(store, ['worktrees']);
        const names = await readdir(links);
        if (names.length !== 1 || names[0] !== item.repositoryId)
          throw new Error('Unexpected private worktree registration');
        const admin = await safeDirectory(links, [item.repositoryId]);
        const gitFile = join(tree, '.git');
        const pointers = [gitFile, join(admin, 'gitdir')];
        for (const file of [
          ...pointers,
          join(admin, 'commondir'),
          join(admin, 'HEAD'),
          join(store, 'config'),
        ]) {
          const entry = await lstat(file);
          if (!entry.isFile() || entry.nlink !== 1)
            throw new Error('Private Git metadata has shared or linked files');
        }
        const expected = ['gitdir: ' + admin + '\n', gitFile + '\n'];
        const old = stagedRoot
          ? [
              'gitdir: ' +
                join(
                  stagedRoot,
                  item.gitStorePath,
                  'worktrees',
                  item.repositoryId,
                ) +
                '\n',
              join(stagedRoot, item.worktreePath, '.git') + '\n',
            ]
          : [];
        const objects = await safeDirectory(store, ['objects']);
        const info = await safeDirectory(objects, ['info']);
        if (
          (await read(join(store, 'config'))) !== bareConfig ||
          (await read(join(admin, 'commondir'))) !== '../..\n' ||
          (await read(join(admin, 'HEAD'))) !==
            'ref: refs/heads/' + item.branch + '\n' ||
          (
            await read(
              join(await safeDirectory(store, ['refs', 'rdws']), 'base'),
              64,
            )
          ).trim() !== item.baseCommit ||
          (await readdir(info)).length ||
          (await exists(join(store, 'commondir'))) ||
          (await exists(join(store, 'info', 'grafts'))) ||
          (await exists(join(admin, 'config.worktree')))
        )
          throw new Error('Invalid private Git configuration');
        const actual = await Promise.all(pointers.map((file) => read(file)));
        if (
          actual.some((value, i) => value !== expected[i] && value !== old[i])
        )
          throw new Error(
            'Private Git pointers are outside their registered paths',
          );
        if (stagedRoot) {
          for (const folder of await readdir(objects)) {
            if (folder === 'info') continue;
            const directory = await safeDirectory(objects, [folder]);
            for (const object of await readdir(directory)) {
              const entry = await lstat(join(directory, object));
              if (!entry.isFile() || entry.nlink !== 1)
                throw new Error(
                  'Private repository has shared or linked objects',
                );
            }
          }
        }
        return { store, tree, pointers, admin };
      }),
    );
  }

  private async verify(paths: Paths, plan: DemandRepositories) {
    await safeDirectory(paths.demand, ['.rdws-worktree']);
    const stamp =
      createHash('sha256').update(paths.manifest).digest('hex') + '\n';
    if (
      (await read(join(paths.control, 'ready'))) !== stamp ||
      (await read(join(paths.demand, 'demand.yaml'), 32768)) !== paths.manifest
    )
      throw new Error('Worktree readiness cannot be verified');
    const repositories = await this.pointers(paths.demand, plan);
    await Promise.all(
      repositories.map(async ({ store }, index) => {
        const repository = plan[index]!;
        const output = await mirrorGit(
          store,
          [
            'rev-parse',
            repository.baseCommit + '^{commit}',
            'refs/heads/' + repository.branch + '^{commit}',
          ],
          { signal: this.stop.signal, timeout: 3500 },
        );
        const [base, head, ...extra] = output.split('\n');
        if (
          base !== repository.baseCommit ||
          !/^[a-f0-9]{40}$/.test(head ?? '') ||
          extra.length
        )
          throw new Error('Private Git branch or base commit is unavailable');
      }),
    );
    return repositories;
  }

  async ready(projectId: string, id: string, plan: DemandRepositories) {
    try {
      await this.verify(await this.paths(projectId, id, plan), plan);
      return true;
    } catch {
      return false;
    }
  }

  async executionScope(
    projectId: string,
    id: string,
    plan: DemandRepositories,
    repositoryId: string,
  ) {
    const index = plan.findIndex((item) => item.repositoryId === repositoryId);
    if (index < 0) throw new Error('Repository is outside the frozen plan');
    const paths = await this.paths(projectId, id, plan);
    const repository = (await this.verify(paths, plan))[index]!;
    return {
      runtimeRoot: paths.runtimeRoot,
      control: paths.control,
      tree: repository.tree,
      store: repository.store,
      admin: repository.admin,
    };
  }

  prepare(projectId: string, id: string, plan: DemandRepositories) {
    const task = this.run(projectId, id, plan);
    this.runs.add(task);
    return task.finally(() => this.runs.delete(task));
  }

  async close() {
    this.stop.abort();
    await Promise.allSettled(this.runs);
  }

  private async run(projectId: string, id: string, plan: DemandRepositories) {
    if (this.stop.signal.aborted)
      throw new Error('Worktree preparation stopped');
    const paths = await this.paths(projectId, id, plan, true);
    const ready = join(paths.control, 'ready');
    if (await exists(ready)) {
      await this.verify(paths, plan);
      return;
    }
    await mkdir(paths.lock, { mode: 0o700 });
    const groupLog = join(paths.lock, 'git.pids');
    let stage: string | undefined;
    let promotion = false;
    let stopped = true;
    try {
      await record(
        join(paths.lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, requirementId: id }),
      );
      await writeFile(groupLog, '', { flag: 'wx', mode: 0o600 });
      if (await exists(ready)) {
        await this.verify(paths, plan);
        return;
      }
      if (!(await exists(paths.demand))) {
        await mkdir(paths.demand, { mode: 0o700 });
        await mkdir(paths.control, { mode: 0o700 });
        await record(join(paths.control, 'plan'), paths.manifest);
        await syncPath(paths.demand);
        await syncPath(dirname(paths.demand));
      }
      await safeDirectory(paths.demand, ['.rdws-worktree']);
      if ((await read(join(paths.control, 'plan'), 32768)) !== paths.manifest)
        throw new Error('Demand workspace is already occupied');
      const marker = join(paths.control, 'promotion');
      const git = (directory: string, args: string[]) =>
        mirrorGit(directory, args, { signal: this.stop.signal, groupLog });
      if (await exists(marker)) {
        const pending = (await read(marker)).trim();
        if (!/^stage-[a-zA-Z0-9]{6}$/.test(pending))
          throw new Error('Invalid worktree promotion record');
        stage = await safeDirectory(paths.control, [pending]);
        promotion = true;
      } else {
        for (const part of parts)
          if (await exists(join(paths.demand, part)))
            throw new Error('Demand worktree already exists');
        stage = await mkdtemp(join(paths.control, 'stage-'));
        await safeDirectory(stage, ['.gitstore'], true);
        await safeDirectory(stage, ['worktrees'], true);
        for (const item of plan) {
          const source = await this.mirrors.frozenSource(projectId, item, {
            signal: this.stop.signal,
            groupLog,
          });
          const store = join(stage, item.gitStorePath);
          await git(store, [
            'init',
            '--bare',
            '--template=',
            '--object-format=sha1',
          ]);
          await writeFile(join(store, 'config'), bareConfig);
          await git(store, [
            '-c',
            'protocol.file.allow=always',
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-auto-maintenance',
            '--no-recurse-submodules',
            '--',
            pathToFileURL(source).href,
            item.baseCommit + ':refs/rdws/base',
          ]);
          await git(store, [
            'worktree',
            'add',
            '--no-track',
            '-b',
            item.branch,
            join(stage, item.worktreePath),
            item.baseCommit,
          ]);
        }
        await this.pointers(stage, plan);
        await record(join(stage, 'demand.yaml'), paths.manifest);
        promotion = true;
        await record(marker, basename(stage) + '\n');
      }
      for (const part of parts) {
        const source = join(stage, part);
        const destination = join(paths.demand, part);
        const staged = await exists(source);
        if (staged === (await exists(destination)))
          throw new Error('Ambiguous worktree promotion');
        if (staged) {
          await rename(source, destination);
          await syncPath(paths.demand);
          await syncPath(stage);
        }
      }
      const candidates = await this.pointers(paths.demand, plan, stage);
      for (const [index, { store, tree }] of candidates.entries()) {
        await git(store, ['worktree', 'repair', tree]);
        if (
          (await git(store, [
            'rev-parse',
            '--verify',
            'refs/heads/' + plan[index]!.branch,
          ])) !== plan[index]!.baseCommit
        )
          throw new Error('Prepared branch differs from its frozen base');
      }
      for (const { pointers, admin, tree } of await this.pointers(
        paths.demand,
        plan,
      )) {
        for (const path of [...pointers, admin, tree]) await syncPath(path);
      }
      if (
        (await read(join(paths.demand, 'demand.yaml'), 32768)) !==
        paths.manifest
      )
        throw new Error('Worktree manifest changed');
      await record(
        ready,
        createHash('sha256').update(paths.manifest).digest('hex') + '\n',
      );
      await rmdir(stage);
      await unlink(marker);
    } catch (error) {
      stopped = !(
        error instanceof MirrorGitError && error.reason === 'unconfirmed'
      );
      throw error;
    } finally {
      if (stopped) {
        if (stage && !promotion)
          await rm(stage, { recursive: true, force: true });
        for (const path of [groupLog, join(paths.lock, 'owner.json')])
          await unlink(path).catch((error) => {
            if (!isMissing(error)) throw error;
          });
        await rmdir(paths.lock);
      }
    }
  }
}
