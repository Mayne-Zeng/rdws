import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export async function fixtureGit(args: string[]) {
  return (
    await exec('git', args, {
      env: {
        PATH: process.env.PATH,
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  ).stdout.trim();
}

export async function httpsGitFixture(project = 'poc') {
  const root = await mkdtemp(join(tmpdir(), 'rdws-https-git-'));
  const config = join(root, 'config', 'projects', project);
  const secrets = join(root, 'secrets');
  const work = join(root, 'work');
  const remote = join(root, 'team', 'app.git');
  const token = randomUUID();
  const key = join(root, 'signing');
  const tls = join(root, 'tls.pem');
  const ca = join(config, 'ca.pem');
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(secrets, { mode: 0o700 });
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const signer =
    'fixture@example.invalid ' + (await readFile(key + '.pub', 'utf8'));
  const signersPath = join(config, 'allowed_signers');
  await writeFile(signersPath, signer);
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    tls,
    '-out',
    ca,
  ]);
  await fixtureGit(['init', '--template=', '--initial-branch=main', work]);
  async function commit(signed = true) {
    await fixtureGit([
      '-C',
      work,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'gpg.format=ssh',
      '-c',
      'user.signingkey=' + key,
      'commit',
      '--allow-empty',
      ...(signed ? ['-S'] : ['--no-gpg-sign']),
      '-m',
      'fixture ' + randomUUID(),
    ]);
    return fixtureGit(['-C', work, 'rev-parse', 'HEAD']);
  }
  const first = await commit();
  await fixtureGit(['-C', work, 'branch', 'staging']);
  await fixtureGit(['-C', work, 'tag', 'excluded']);
  await fixtureGit(['clone', '--quiet', '--bare', '--template=', work, remote]);

  const requests: {
    authenticated: boolean;
    hasAuthorization: boolean;
    route: string;
  }[] = [];
  const controls: {
    before?: () => Promise<void>;
    redirect?: string;
    anonymous?: boolean;
  } = {};
  let closing = false;
  const tasks = new Set<Promise<void>>();
  const server = createServer(
    { key: await readFile(tls), cert: await readFile(ca) },
    (req, res) => {
      const task = (async () => {
        const target = new URL(req.url!, 'https://127.0.0.1');
        const authenticated =
          req.headers.authorization ===
          'Basic ' + Buffer.from('reader:' + token).toString('base64');
        const hasAuthorization = req.headers.authorization !== undefined;
        requests.push({
          authenticated,
          hasAuthorization,
          route: target.pathname,
        });
        if (!authenticated && (!controls.anonymous || hasAuthorization)) {
          res.writeHead(401).end();
          return;
        }
        if (controls.redirect) {
          res.writeHead(302, { location: controls.redirect }).end();
          return;
        }
        await controls.before?.();
        if (closing) return;
        const child = spawn('git', ['http-backend'], {
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: target.pathname,
            QUERY_STRING: target.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers['content-type'],
            CONTENT_LENGTH: req.headers['content-length'],
            HTTP_GIT_PROTOCOL: req.headers['git-protocol'] as
              string | undefined,
            REMOTE_USER: authenticated ? 'fixture-reader' : undefined,
          },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        child.stdin.on('error', () => {});
        req.pipe(child.stdin);
        let headers = Buffer.alloc(0);
        let started = false;
        for await (const bytes of child.stdout) {
          const chunk = bytes as Buffer;
          if (started) {
            res.write(chunk);
            continue;
          }
          headers = Buffer.concat([headers, chunk]);
          const end = headers.indexOf('\r\n\r\n');
          if (end < 0) continue;
          for (const line of headers
            .subarray(0, end)
            .toString()
            .split('\r\n')) {
            const at = line.indexOf(':');
            const name = line.slice(0, at);
            const value = line.slice(at + 1).trim();
            if (name === 'Status') res.statusCode = Number(value.split(' ')[0]);
            else res.setHeader(name, value);
          }
          started = true;
          res.write(headers.subarray(end + 4));
        }
        if (!started) res.statusCode = 502;
        res.end();
      })().catch(() => {
        res.destroy();
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address)
    throw new Error('HTTPS fixture not listening');
  const url = 'https://127.0.0.1:' + address.port + '/team/app.git';
  const entry = {
    id: 'app',
    name: 'Fixture repository',
    url,
    baselineRef: 'refs/heads/main',
    targetRef: 'refs/heads/staging',
    targetName: 'Staging',
    signersFile: 'allowed_signers',
    credentialFile: 'gitlab.json',
    caFile: 'ca.pem',
  };
  const registration = join(config, 'repositories.json');
  const ready = async () => writeFile(registration, JSON.stringify([entry]));
  await ready();
  await writeFile(
    join(secrets, 'gitlab.json'),
    JSON.stringify({ url, username: 'reader', token }),
    { mode: 0o600 },
  );
  const close = async ({ preserveRoot = false } = {}) => {
    closing = true;
    const ended = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await ended;
    await Promise.allSettled(tasks);
    if (!preserveRoot) await rm(root, { recursive: true, force: true });
  };
  async function update(branch = 'main') {
    await fixtureGit([
      '--git-dir=' + remote,
      'fetch',
      '--no-tags',
      work,
      '+refs/heads/' + branch + ':refs/heads/' + branch,
    ]);
  }
  return {
    root,
    work,
    remote,
    first,
    entry,
    requests,
    controls,
    signer,
    signersPath,
    registration,
    ready,
    commit,
    update,
    close,
  };
}
