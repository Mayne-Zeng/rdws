import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  rm,
  lstat,
  writeFile,
  readFile,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { httpsGitFixture, fixtureGit } from '../helpers/https-git.ts';
import { expect, test, vi } from 'vitest';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { credential } from '@rdws/syncer/config';
import { mirrorGit, MirrorGitError } from '@rdws/syncer/git';

test('an unconfigured project reads as empty without creating runtime state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-mirror-'));
  try {
    const mirrors = new RepositoryMirrors(root);
    expect(await mirrors.list('poc')).toEqual([]);
    await expect(mirrors.list('../other')).rejects.toThrow();
    await mirrors.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTPS reads only the registered source and publishes a signed baseline, with durable replay', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  const gate = (publish: () => Promise<void>) => publish();
  const run = (id = randomUUID()) =>
    mirrors.sync('poc', 'app', 'admin', id, gate);
  const path = join(f.root, 'projects/poc/sources/app.git');
  try {
    const id = randomUUID();
    expect((await mirrors.list('poc'))[0]!.publishedCommit).toBeUndefined();
    const first = await run(id);
    expect(first).toMatchObject({
      status: 'succeeded',
      targetCommit: f.first,
      candidateCommit: f.first,
    });
    expect(first.signerFingerprint).toMatch(/^SHA256:/);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(
      f.requests.every(
        (r) => r.authenticated && r.route.startsWith('/team/app.git/'),
      ),
    ).toBe(true);

    const next = await f.commit();
    await f.update();
    const count = f.requests.length;
    expect(await run(id)).toEqual(first);
    expect(f.requests).toHaveLength(count);
    expect(
      await mirrors.sync('poc', 'app', 'other-admin', id, gate),
    ).toMatchObject({ candidateCommit: next, status: 'succeeded' });
    expect(f.requests.length).toBeGreaterThan(count);
    expect((await run()).candidateCommit).toBe(next);
    const unsigned = await f.commit(false);
    await f.update();
    expect(await run()).toMatchObject({
      status: 'failed',
      issue: 'signature',
      candidateCommit: unsigned,
    });
    expect((await mirrors.list('poc'))[0]!.publishedCommit).toBe(next);
    await fixtureGit(['-C', f.work, 'reset', '--hard', f.first]);
    await f.commit();
    await f.update();
    expect(await run()).toMatchObject({ status: 'failed', issue: 'history' });
    expect(
      await fixtureGit([
        '--git-dir=' + path,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
      ]),
    ).toBe('refs/heads/main ' + next);
    await expect(lstat(join(path, 'FETCH_HEAD'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(lstat(join(path, 'worktrees'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const state = join(f.root, 'projects/poc/sources/.app.state');
    const key = JSON.parse(await readFile(join(state, 'latest.json'), 'utf8'));
    const receipt = JSON.parse(
      await readFile(join(state, key + '.json'), 'utf8'),
    );
    expect(receipt.registrationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.trustDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(f.entry.url);
    await rename(join(path, 'HEAD'), join(path, 'HEAD.fixture'));
    expect((await mirrors.list('poc'))[0]).toMatchObject({
      stateIssue: 'binding',
      lastSync: { status: 'failed', issue: 'history' },
    });
    const before = f.requests.length;
    await expect(run()).rejects.toMatchObject({ reason: 'blocked' });
    expect(f.requests).toHaveLength(before);
  } finally {
    await mirrors.close();
    await f.close();
  }
});

test('explicit anonymous HTTPS sends no credentials and still verifies the baseline', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  const gate = (publish: () => Promise<void>) => publish();
  const run = () => mirrors.sync('poc', 'app', 'admin', randomUUID(), gate);
  const configure = (credentialFile: string | null) =>
    writeFile(f.registration, JSON.stringify([{ ...f.entry, credentialFile }]));
  try {
    await rename(join(f.root, 'secrets'), join(f.root, 'unused-secrets'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: Trace fixture');
    vi.stubEnv('RDWS_GIT_AUTH', 'Authorization: Another fixture');
    await configure(null);
    f.controls.anonymous = true;
    expect(await run()).toMatchObject({
      status: 'succeeded',
      candidateCommit: f.first,
      targetCommit: f.first,
      signerFingerprint: expect.stringMatching(/^SHA256:/),
    });
    expect(
      f.requests.some((request) => request.route.endsWith('/info/refs')),
    ).toBe(true);
    expect(
      f.requests.some((request) => request.route.endsWith('/git-upload-pack')),
    ).toBe(true);
    expect(f.requests.every((request) => !request.hasAuthorization)).toBe(true);

    const beforeDenial = f.requests.length;
    f.controls.anonymous = false;
    expect(await run()).toMatchObject({
      status: 'failed',
      issue: 'connection',
    });
    expect(f.requests.length).toBeGreaterThan(beforeDenial);
    expect(f.requests.every((request) => !request.hasAuthorization)).toBe(true);
    const before = f.requests.length;
    await configure(f.entry.credentialFile);
    expect(await run()).toMatchObject({
      status: 'failed',
      issue: 'credentials',
    });
    expect(f.requests).toHaveLength(before);
    const incomplete: Partial<typeof f.entry> = { ...f.entry };
    delete incomplete.credentialFile;
    await writeFile(f.registration, JSON.stringify([incomplete]));
    await expect(run()).rejects.toThrow('Repository configuration is invalid');
    expect(f.requests).toHaveLength(before);

    f.controls.anonymous = true;
    await configure(null);
    const next = await f.commit();
    await f.update();
    const changed = await mirrors.sync(
      'poc',
      'app',
      'admin',
      randomUUID(),
      async (publish) => {
        await configure(f.entry.credentialFile);
        await publish();
      },
    );
    expect(changed).toMatchObject({
      status: 'failed',
      issue: 'configuration_changed',
      candidateCommit: next,
    });
    expect((await mirrors.list('poc'))[0]!.publishedCommit).toBe(f.first);
  } finally {
    vi.unstubAllEnvs();
    await mirrors.close();
    await f.close();
  }
});

test('trust and source changes fail closed before publication', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  const run = () =>
    mirrors.sync('poc', 'app', 'admin', randomUUID(), (publish) => publish());
  try {
    const saved = { ...f.entry };
    delete (f.entry as Partial<typeof f.entry>).caFile;
    vi.stubEnv('GIT_SSL_NO_VERIFY', 'true');
    await f.ready();
    expect((await run()).status).toBe('failed');
    expect(f.requests).toHaveLength(0);
    vi.unstubAllEnvs();
    Object.assign(f.entry, saved);
    await f.ready();
    await writeFile(f.signersPath, '');
    expect(await run()).toMatchObject({ status: 'failed', issue: 'signature' });
    await writeFile(f.signersPath, f.signer);
    f.entry.targetRef = 'refs/heads/missing';
    await f.ready();
    expect(await run()).toMatchObject({ status: 'failed', issue: 'target' });
    Object.assign(f.entry, saved);
    await f.ready();
    expect((await run()).status).toBe('succeeded');
    const before = f.requests.length;
    f.entry.baselineRef = 'refs/heads/staging';
    await f.ready();
    expect((await mirrors.list('poc'))[0]).toMatchObject({
      stateIssue: 'binding',
    });
    await expect(run()).rejects.toMatchObject({ reason: 'blocked' });
    Object.assign(f.entry, saved);
    f.entry.url = saved.url.replace('/team/app.git', '/team/other.git');
    await f.ready();
    expect((await mirrors.list('poc'))[0]).toMatchObject({
      stateIssue: 'binding',
    });
    await expect(run()).rejects.toMatchObject({ reason: 'blocked' });
    expect(f.requests).toHaveLength(before);
  } finally {
    await mirrors.close();
    await f.close();
  }
});

test('only one command runs and publication with a missing final receipt stays unknown', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  const state = join(f.root, 'projects/poc/sources/.app.state');
  const displaced = state + '.fixture';
  const commandId = randomUUID();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const other = (id = randomUUID()) =>
    mirrors.sync('poc', 'app', 'admin', id, (publish) => publish());
  const attempt = mirrors.sync(
    'poc',
    'app',
    'admin',
    commandId,
    async (publish) => {
      entered();
      await pending;
      await publish();
      await rename(state, displaced);
    },
  );
  try {
    await Promise.race([
      ready,
      attempt.then(() => {
        throw new Error('Publication was not reached');
      }),
    ]);
    expect((await other(commandId)).status).toBe('running');
    await expect(other()).rejects.toMatchObject({ reason: 'busy' });
    release();
    expect(await attempt).toMatchObject({
      status: 'unknown',
      issue: 'storage',
    });
    await rename(displaced, state);
    expect((await mirrors.list('poc'))[0]).toMatchObject({
      publishedCommit: f.first,
      lastSync: { status: 'unknown', candidateCommit: f.first, commandId },
    });
    expect((await other(commandId)).status).toBe('unknown');
    expect((await other()).status).toBe('succeeded');
  } finally {
    release();
    await mirrors.close();
    await rename(displaced, state).catch(() => {});
    await f.close();
  }
});

test('HTTPS redirects and mismatched credentials never deliver a token to another repository', async () => {
  const source = await httpsGitFixture(),
    other = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(source.root);
  const run = () =>
    mirrors.sync('poc', 'app', 'admin', randomUUID(), (publish) => publish());
  try {
    source.controls.redirect = other.entry.url;
    expect(await run()).toMatchObject({
      status: 'failed',
      issue: 'connection',
    });
    expect(source.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
    source.entry.url = other.entry.url;
    await source.ready();
    expect(await run()).toMatchObject({
      status: 'failed',
      issue: 'credentials',
    });
    expect(other.requests).toHaveLength(0);
    expect((await mirrors.list('poc'))[0]!.publishedCommit).toBeUndefined();
  } finally {
    await mirrors.close();
    await Promise.all([source.close(), other.close()]);
  }
});

test('shutdown stops a sync waiting on an HTTPS helper before it can publish', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const contacted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.controls.before = async () => {
    started();
    await waiting;
  };
  const attempt = mirrors.sync(
    'poc',
    'app',
    'admin',
    randomUUID(),
    async () => {
      throw new Error('Cancelled sync must not enter the gate');
    },
  );
  try {
    await Promise.race([
      contacted,
      attempt.then(() => {
        throw new Error('HTTPS helper was not reached');
      }),
    ]);
    const lock = join(f.root, 'projects/poc/sources/.app.lock');
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    const pgids = (await readFile(join(lock, owner.groupsFile), 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    expect(pgids.length).toBeGreaterThanOrEqual(2);
    expect(process.kill(-pgids.at(-1)!, 0)).toBe(true);
    await mirrors.close();
    const result = await attempt;
    expect(['failed', 'unknown']).toContain(result.status);
    expect(result.issue).toMatch(/^(stopped|connection)$/);
    const current = (await mirrors.list('poc'))[0]!;
    expect(current.publishedCommit).toBeUndefined();
    if (result.status === 'unknown') {
      expect(current.stateIssue).toBe('review_required');
      expect(await readFile(join(lock, owner.groupsFile), 'utf8')).toContain(
        String(pgids.at(-1)),
      );
    } else {
      expect(() => process.kill(-pgids.at(-1)!, 0)).toThrow();
      await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    release();
    await mirrors.close();
    await f.close();
  }
});

test('a trust change while waiting for the publication gate prevents the original candidate from being published', async () => {
  const f = await httpsGitFixture();
  const mirrors = new RepositoryMirrors(f.root);
  try {
    const result = await mirrors.sync(
      'poc',
      'app',
      'admin',
      randomUUID(),
      async (publish) => {
        await writeFile(f.signersPath, '');
        await publish();
      },
    );
    expect(result).toMatchObject({
      status: 'failed',
      issue: 'configuration_changed',
      candidateCommit: f.first,
    });
    expect((await mirrors.list('poc'))[0]!.publishedCommit).toBeUndefined();
  } finally {
    await mirrors.close();
    await f.close();
  }
});

function stopFixtureGroup(pgid: number) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

test('worker interruption leaves the HTTP Git group identifiable behind the durable lock', async () => {
  const f = await httpsGitFixture();
  const id = randomUUID();
  const lock = join(f.root, 'projects/poc/sources/.app.lock');
  let release!: () => void, contacted!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connected = new Promise<void>((resolve) => {
    contacted = resolve;
  });
  f.controls.before = async () => {
    contacted();
    await pending;
  };
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { RepositoryMirrors } from '@rdws/syncer/mirror';
    const [,root,id] = process.argv;
    const store = new RepositoryMirrors(root);
    await store.sync('poc', 'app', 'fixture-worker', id, () => {
      throw new Error('Fixture must not publish');
    });
  `,
      f.root,
      id,
    ],
    { stdio: 'ignore' },
  );
  const exited = once(child, 'exit');
  let pgid: number | undefined;
  try {
    await Promise.race([
      connected,
      exited.then(() => {
        throw new Error('Worker exited before HTTPS request');
      }),
    ]);
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    expect(owner).toMatchObject({ workerPid: child.pid, commandId: id });
    pgid = Number(
      (await readFile(join(lock, owner.groupsFile), 'utf8'))
        .trim()
        .split('\n')
        .at(-1),
    );
    expect(pgid).toBeGreaterThan(1);
    expect(process.kill(-pgid, 0)).toBe(true);
    child.kill('SIGKILL');
    await exited;
    expect(process.kill(-pgid, 0)).toBe(true);
    const other = new RepositoryMirrors(f.root);
    try {
      expect((await other.list('poc'))[0]).toMatchObject({
        lastSync: { commandId: id, status: 'unknown' },
        stateIssue: 'review_required',
      });
      await expect(
        other.sync(
          'poc',
          'app',
          'fixture-worker',
          randomUUID(),
          async () => {},
        ),
      ).rejects.toMatchObject({ reason: 'busy' });
    } finally {
      await other.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    if (pgid && pgid > 1) stopFixtureGroup(pgid);
    release();
    await exited;
    await f.close();
  }
});

test('the Git timeout either confirms its process group stopped or reports it unconfirmed', async () => {
  const f = await httpsGitFixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controls.before = () => waiting;
  const marker = join(f.root, 'timeout.pids');
  try {
    await writeFile(marker, '', { mode: 0o600 });
    const authorization = await credential(f.root, f.entry);
    const result = await mirrorGit(
      f.remote,
      [
        '-c',
        'protocol.https.allow=always',
        '-c',
        'http.sslCAInfo=' + join(f.root, 'config/projects/poc/ca.pem'),
        'ls-remote',
        '--refs',
        '--',
        f.entry.url,
        f.entry.baselineRef,
      ],
      { timeout: 1000, authorization, groupLog: marker },
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MirrorGitError);
    const { reason } = result as MirrorGitError;
    expect(['timeout', 'unconfirmed']).toContain(reason);
    expect(f.requests.length).toBeGreaterThan(0);
    const pgid = Number((await readFile(marker, 'utf8')).trim());
    expect(pgid).toBeGreaterThan(1);
    if (reason === 'timeout') expect(() => process.kill(-pgid, 0)).toThrow();
  } finally {
    release();
    await f.close();
  }
});
