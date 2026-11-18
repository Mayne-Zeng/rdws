import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  RepositorySummary,
  RepositorySyncIssue,
  RepositorySyncResult,
} from '@rdws/contracts';
import {
  credential,
  isMissing,
  MirrorConfigError,
  owned,
  readOwned,
  readTrust,
  repositories,
  safeDirectory,
  safeId,
  type RegisteredRepository,
} from './config.ts';
import { mirrorGit, MirrorGitError } from './git.ts';

const oid = /^[0-9a-f]{40}$/;
export type PublishedBaseline = {
  repositoryId: string;
  baselineRef: string;
  baseCommit: string;
  sourceBinding: string;
};
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const bareConfig =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';
const fetchFlags = [
  'fetch',
  '--atomic',
  '--no-tags',
  '--no-write-fetch-head',
  '--no-auto-maintenance',
  '--no-recurse-submodules',
  '--refmap=',
  '--',
];

export class MirrorRequestError extends Error {
  constructor(readonly reason: 'busy' | 'missing' | 'blocked') {
    super(reason);
  }
}

class SyncFailure extends Error {
  constructor(readonly issue: RepositorySyncIssue) {
    super(issue);
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function persist(path: string, data: unknown) {
  const temporary = path + '.tmp-' + randomUUID();
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(data) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(join(path, '..'), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

function boundTo(project: string, row: RegisteredRepository) {
  return digest(JSON.stringify([project, row.id, row.url, row.baselineRef]));
}

async function published(
  sources: string,
  project: string,
  row: RegisteredRepository,
  options: {
    groupLog?: string;
    signal?: AbortSignal;
    inspectObjects?: boolean;
  } = {},
) {
  const name = row.id + '.git',
    path = join(sources, name);
  if (!(await exists(path))) return undefined;
  try {
    await safeDirectory(sources, [name]);
    owned(await lstat(path), true);
    if (
      (await readOwned(join(path, 'config'), 2048)).toString() !== bareConfig ||
      (await readOwned(join(path, 'HEAD'), 1024)).toString() !==
        'ref: ' + row.baselineRef + '\n' ||
      (await readOwned(join(path, 'rdws-binding'), 128)).toString() !==
        boundTo(project, row)
    )
      throw new MirrorRequestError('blocked');
    const refParts = row.baselineRef.split('/');
    const branch = refParts.pop()!;
    const refDirectory = await safeDirectory(path, refParts);
    const expected = (await readOwned(join(refDirectory, branch), 64))
      .toString()
      .trim();
    if (!oid.test(expected)) throw new MirrorRequestError('blocked');
    for (const file of [
      'commondir',
      'shallow',
      'packed-refs',
      'info/grafts',
      'FETCH_HEAD',
      'worktrees',
    ])
      if (await exists(join(path, file)))
        throw new MirrorRequestError('blocked');
    const objects = await safeDirectory(path, ['objects']);
    const info = await safeDirectory(objects, ['info']);
    const pack = await safeDirectory(objects, ['pack']);
    if ((await readdir(info)).length) throw new MirrorRequestError('blocked');
    for (const entry of await readdir(objects)) {
      if (entry === 'info' || entry === 'pack') continue;
      if (!/^[0-9a-f]{2}$/.test(entry)) throw new MirrorRequestError('blocked');
      const fanout = await safeDirectory(objects, [entry]);
      if (options.groupLog || options.inspectObjects) {
        for (const object of await readdir(fanout)) {
          const stat = await lstat(join(fanout, object));
          if (!stat.isFile() || !/^[0-9a-f]{38}$/.test(object))
            throw new MirrorRequestError('blocked');
          owned(stat);
        }
      }
    }
    for (const entry of await readdir(pack)) {
      const stat = await lstat(join(pack, entry));
      if (!stat.isFile()) throw new MirrorRequestError('blocked');
      owned(stat);
    }
    const loose = join(objects, expected.slice(0, 2), expected.slice(2));
    if (await exists(loose)) {
      const stat = await lstat(loose);
      if (!stat.isFile()) throw new MirrorRequestError('blocked');
      owned(stat);
    }
    const type = await mirrorGit(path, ['cat-file', '-t', expected], {
      ...options,
      timeout: 3000,
    });
    if (type !== 'commit') throw new MirrorRequestError('blocked');
    return expected;
  } catch (error) {
    if (error instanceof MirrorGitError && error.reason === 'unconfirmed')
      throw error;
    throw new MirrorRequestError('blocked');
  }
}

function trustFingerprint(
  row: RegisteredRepository,
  trust: Awaited<ReturnType<typeof readTrust>>,
) {
  return digest(
    JSON.stringify([
      row,
      digest(trust.signers),
      trust.ca ? digest(trust.ca) : null,
    ]),
  );
}

type PublishGate = (
  publish: (confirm?: () => void) => Promise<void>,
) => Promise<void>;
type Receipt = {
  binding: string;
  actorId: string;
  registrationDigest: string;
  trustDigest?: string;
  result: RepositorySyncResult;
};

async function receipt(path: string) {
  try {
    return JSON.parse(
      (await readOwned(path, 8192, true)).toString(),
    ) as Receipt;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export class RepositoryMirrors {
  private readonly stop = new AbortController();
  private readonly tasks = new Set<Promise<RepositorySyncResult>>();
  private readonly running = new Set<string>();

  constructor(private readonly root: string) {}

  async captureBaselines(project: string): Promise<PublishedBaseline[]> {
    const { entries } = await repositories(this.root, project);
    if (!entries.length) return [];
    const sources = await this.sourceDirectory(project);
    const baselines = [];
    for (const row of entries) {
      const baseCommit = await this.verifiedTip(sources, project, row);
      baselines.push({
        repositoryId: row.id,
        baselineRef: row.baselineRef,
        baseCommit,
        sourceBinding: boundTo(project, row),
      });
    }
    return baselines;
  }

  async frozenSource(
    project: string,
    baseline: PublishedBaseline,
    options: { signal?: AbortSignal; groupLog?: string } = {},
  ) {
    const { entries } = await repositories(this.root, project);
    const row = entries.find((entry) => entry.id === baseline.repositoryId);
    if (
      !row ||
      row.baselineRef !== baseline.baselineRef ||
      boundTo(project, row) !== baseline.sourceBinding ||
      !oid.test(baseline.baseCommit)
    )
      throw new MirrorRequestError('blocked');
    const sources = await this.sourceDirectory(project);
    const tip = await this.verifiedTip(sources, project, row, options);
    const path = join(sources, row.id + '.git');
    if (tip !== baseline.baseCommit) {
      await this.requirePublication(
        sources,
        row,
        baseline.sourceBinding,
        baseline.baseCommit,
      );
      await mirrorGit(
        path,
        ['merge-base', '--is-ancestor', baseline.baseCommit, tip],
        { ...options, timeout: 5000 },
      );
    }
    return path;
  }

  private sourceDirectory(project: string) {
    return safeDirectory(this.root, ['projects', project, 'sources']);
  }

  private async requirePublication(
    sources: string,
    row: RegisteredRepository,
    binding: string,
    commit: string,
  ) {
    const dir = await safeDirectory(sources, ['.' + row.id + '.state']);
    for await (const file of await opendir(dir)) {
      if (!file.isFile() || !/^[0-9a-f]{64}\.json$/.test(file.name)) continue;
      const saved = await receipt(join(dir, file.name));
      if (
        saved?.binding === binding &&
        saved.result?.status === 'succeeded' &&
        saved.result.candidateCommit === commit &&
        /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(
          saved.result.signerFingerprint ?? '',
        )
      )
        return;
    }
    throw new MirrorRequestError('blocked');
  }

  private async verifiedTip(
    sources: string,
    project: string,
    row: RegisteredRepository,
    options: { signal?: AbortSignal; groupLog?: string } = {},
  ) {
    const lock = join(sources, '.' + row.id + '.lock');
    if (await exists(lock)) throw new MirrorRequestError('busy');
    const first = await published(sources, project, row, {
      ...options,
      signal: options.signal ?? this.stop.signal,
      inspectObjects: true,
    });
    if (!first) throw new MirrorRequestError('missing');
    await this.requirePublication(sources, row, boundTo(project, row), first);
    const confirmed = await readOwned(
      join(sources, row.id + '.git', row.baselineRef),
      64,
    );
    if (confirmed.toString().trim() !== first || (await exists(lock)))
      throw new MirrorRequestError('busy');
    return first;
  }

  async list(project: string): Promise<RepositorySummary[]> {
    const { entries } = await repositories(this.root, project);
    return Promise.all(
      entries.map(async (row) => {
        const { id, name, baselineRef, targetName, targetRef } = row;
        const summary: RepositorySummary = {
          id,
          name,
          baselineRef,
          targetName,
          targetRef,
        };
        try {
          const sources = await safeDirectory(this.root, [
            'projects',
            project,
            'sources',
          ]);
          try {
            summary.publishedCommit = await published(sources, project, row);
          } catch (error) {
            summary.stateIssue =
              error instanceof MirrorRequestError ? 'binding' : 'storage';
          }
          const state = join(sources, '.' + id + '.state');
          if (await exists(state)) {
            await safeDirectory(sources, ['.' + id + '.state']);
            const marker = join(state, 'latest.json');
            if (await exists(marker)) {
              const key: unknown = JSON.parse(
                (await readOwned(marker, 1024, true)).toString(),
              );
              if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))
                throw new MirrorConfigError('Invalid receipt key');
              const saved = await receipt(join(state, key + '.json'));
              if (!saved || saved.binding !== boundTo(project, row))
                throw new MirrorRequestError('blocked');
              summary.lastSync = this.observed(saved.result, key);
              if (
                summary.lastSync.status === 'succeeded' &&
                !summary.stateIssue &&
                summary.lastSync.candidateCommit !== summary.publishedCommit
              ) {
                summary.publishedCommit = await published(
                  sources,
                  project,
                  row,
                );
                if (
                  summary.lastSync.candidateCommit !== summary.publishedCommit
                )
                  summary.stateIssue = 'review_required';
              }
            }
          }
          if (
            (await exists(join(sources, '.' + id + '.lock'))) &&
            summary.lastSync?.status !== 'running'
          ) {
            const lock = join(sources, '.' + id + '.lock');
            if (!this.running.has(lock)) summary.stateIssue = 'review_required';
          }
        } catch (error) {
          if (error instanceof MirrorRequestError)
            summary.stateIssue ??= 'binding';
          else if (!isMissing(error)) summary.stateIssue = 'storage';
        }
        return summary;
      }),
    );
  }

  sync(
    project: string,
    repository: string,
    actorId: string,
    commandId: string,
    gate: PublishGate,
  ) {
    if (this.stop.signal.aborted) throw new MirrorRequestError('blocked');
    const task = this.run(project, repository, actorId, commandId, gate);
    this.tasks.add(task);
    return task.finally(() => this.tasks.delete(task));
  }

  async close() {
    this.stop.abort();
    await Promise.allSettled(this.tasks);
  }

  private observed(
    result: RepositorySyncResult,
    key: string,
  ): RepositorySyncResult {
    if (result.status === 'running' && !this.running.has(key))
      return { ...result, status: 'unknown' };
    return result;
  }

  private async run(
    project: string,
    repository: string,
    actorId: string,
    commandId: string,
    gate: PublishGate,
  ): Promise<RepositorySyncResult> {
    const registration = await repositories(this.root, project);
    const row = registration.entries.find((item) => item.id === repository);
    if (!row || !safeId(repository)) throw new MirrorRequestError('missing');
    const sources = await safeDirectory(
      this.root,
      ['projects', project, 'sources'],
      true,
    );
    const key = digest(
      JSON.stringify([project, repository, actorId, commandId]),
    );
    const state = await safeDirectory(
      sources,
      ['.' + repository + '.state'],
      true,
    );
    const log = join(state, key + '.json');
    const binding = boundTo(project, row);
    const replay = async () => {
      const saved = await receipt(log);
      if (!saved) return undefined;
      if (
        saved.binding !== binding ||
        saved.actorId !== actorId ||
        saved.result.commandId !== commandId
      )
        throw new MirrorRequestError('blocked');
      return this.observed(saved.result, key);
    };
    const existing = await replay();
    if (existing) return existing;
    const lock = join(sources, '.' + repository + '.lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const running = await replay();
      if (running) return running;
      throw new MirrorRequestError('busy');
    }
    const groupsFile = 'git-' + key + '.pids';
    const groupLog = join(lock, groupsFile);
    this.running.add(lock);
    this.running.add(key);
    let work: string | undefined,
      stopConfirmed = true,
      attempted = false;
    const result: RepositorySyncResult = {
      commandId,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const registrationDigest = digest(JSON.stringify(row));
    let trustDigest: string | undefined;
    const save = () =>
      persist(log, {
        binding,
        actorId,
        registrationDigest,
        trustDigest,
        result,
      } satisfies Receipt);
    let issue: RepositorySyncIssue = 'storage';
    let recorded = false;
    try {
      try {
        const duplicate = await replay();
        if (duplicate) return duplicate;
        await writeFile(
          join(lock, 'owner.json'),
          JSON.stringify({
            workerPid: process.pid,
            commandId,
            startedAt: result.startedAt,
            receipt: key,
            groupsFile,
          }),
          { flag: 'wx', mode: 0o600 },
        );
        await writeFile(groupLog, '', { mode: 0o600, flag: 'wx' });
        const signal = this.stop.signal;
        const local = { signal, timeout: 3000, groupLog };
        result.previousCommit = await published(sources, project, row, local);
        await save();
        recorded = true;
        await persist(join(state, 'latest.json'), key);
        const mirror = join(sources, repository + '.git');
        work = await mkdtemp(join(sources, '.' + repository + '-candidate-'));
        const candidate = join(work, 'candidate.git');
        const signerPath = join(work, 'allowed_signers');
        await mirrorGit(
          candidate,
          ['init', '--bare', '--template=', '--object-format=sha1'],
          local,
        );

        issue = 'signature';
        const trust = await readTrust(registration.dir, row);
        trustDigest = trustFingerprint(row, trust);
        await writeFile(signerPath, trust.signers, { mode: 0o600, flag: 'wx' });
        const transport = ['-c', 'protocol.https.allow=always'];
        if (trust.ca) {
          const caPath = join(work, 'ca.pem');
          await writeFile(caPath, trust.ca, { mode: 0o600, flag: 'wx' });
          transport.push('-c', 'http.sslCAInfo=' + caPath);
        }

        issue = 'credentials';
        const remote = {
          signal,
          authorization: await credential(this.root, row),
          groupLog,
        };
        issue = 'connection';
        const target = await mirrorGit(
          candidate,
          [
            ...transport,
            'ls-remote',
            '--exit-code',
            '--refs',
            '--',
            row.url,
            row.targetRef,
          ],
          remote,
        ).catch((error: unknown) => {
          if (error instanceof MirrorGitError && error.exitCode === 2)
            throw new SyncFailure('target');
          throw error;
        });
        const [targetCommit, targetRef] = target.split('\t');
        if (
          !targetCommit ||
          !oid.test(targetCommit) ||
          targetRef !== row.targetRef
        )
          throw new SyncFailure('target');
        result.targetCommit = targetCommit;
        issue = 'connection';
        await mirrorGit(
          candidate,
          [
            ...transport,
            ...fetchFlags,
            row.url,
            row.baselineRef + ':' + row.baselineRef,
          ],
          remote,
        );
        const sha = await mirrorGit(
          candidate,
          ['rev-parse', '--verify', row.baselineRef + '^{commit}'],
          local,
        );
        if (!oid.test(sha)) throw new SyncFailure('connection');
        result.candidateCommit = sha;

        issue = 'signature';
        const verification = [
          '-c',
          'gpg.format=ssh',
          '-c',
          'gpg.ssh.allowedSignersFile=' + signerPath,
          '-c',
          'gpg.minTrustLevel=fully',
          '-c',
          'gpg.openpgp.program=/usr/bin/false',
          '-c',
          'gpg.x509.program=/usr/bin/false',
        ];
        await mirrorGit(
          candidate,
          [...verification, 'verify-commit', sha],
          local,
        );
        const signer = await mirrorGit(
          candidate,
          [...verification, 'show', '-s', '--format=%GF', sha],
          local,
        );
        if (!/^SHA256:[A-Za-z0-9+/=]{30,64}$/.test(signer))
          throw new SyncFailure('signature');
        result.signerFingerprint = signer;

        issue = 'storage';
        if (result.previousCommit) {
          await mirrorGit(
            mirror,
            [
              '-c',
              'protocol.file.allow=always',
              ...fetchFlags,
              pathToFileURL(candidate).href,
              row.baselineRef,
            ],
            { signal, timeout: 30_000, groupLog },
          );
          issue = 'history';
          await mirrorGit(
            mirror,
            ['merge-base', '--is-ancestor', result.previousCommit, sha],
            local,
          );
        } else {
          await chmod(candidate, 0o700);
          await writeFile(join(candidate, 'config'), bareConfig);
          await writeFile(
            join(candidate, 'HEAD'),
            'ref: ' + row.baselineRef + '\n',
          );
          await writeFile(join(candidate, 'rdws-binding'), binding, {
            mode: 0o600,
            flag: 'wx',
          });
        }
        issue = 'storage';
        await save();
        issue = 'authorization';
        await gate(async (confirm) => {
          issue = 'configuration_changed';
          const fresh = await repositories(this.root, project);
          const current = fresh.entries.find((item) => item.id === repository);
          if (
            !current ||
            trustFingerprint(current, await readTrust(fresh.dir, current)) !==
              trustDigest
          )
            throw new SyncFailure(issue);
          if (signal.aborted) throw new SyncFailure('stopped');
          issue = 'authorization';
          confirm?.();
          issue = 'storage';
          attempted = true;
          if (!result.previousCommit) await rename(candidate, mirror);
          else if (result.previousCommit !== sha)
            await mirrorGit(
              mirror,
              [
                'update-ref',
                '--no-deref',
                row.baselineRef,
                sha,
                result.previousCommit,
              ],
              { timeout: 3000, groupLog },
            );
        });
        result.status = 'succeeded';
      } catch (error) {
        if (error instanceof MirrorGitError) {
          stopConfirmed = error.reason !== 'unconfirmed';
          if (error.reason === 'timeout' || error.reason === 'stopped')
            issue = error.reason;
        }
        if (!recorded) throw error;
        result.status = attempted || !stopConfirmed ? 'unknown' : 'failed';
        result.issue = error instanceof SyncFailure ? error.issue : issue;
      }
      result.finishedAt = new Date().toISOString();
      try {
        await save();
      } catch {
        return { ...result, status: 'unknown', issue: 'storage' };
      }
      return result;
    } finally {
      this.running.delete(key);
      this.running.delete(lock);
      if (stopConfirmed) {
        if (work) await rm(work, { recursive: true, force: true });
        for (const file of [groupLog, join(lock, 'owner.json')]) {
          await unlink(file).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
        }
        await rmdir(lock);
      }
    }
  }
}
