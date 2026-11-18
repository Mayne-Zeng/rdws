import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  access,
  open,
  unlink,
  rename,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parseDocument } from 'yaml';
import {
  signGrant,
  verifyGrant,
  bodyHash,
  type Grant,
} from '../bridge/access.ts';
const req = createRequire(import.meta.url);
export async function writeOwner(
  handle: Awaited<ReturnType<typeof open>>,
  value: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(value));
  await handle.write(bytes, 0, bytes.length, 0);
  await handle.truncate(bytes.length);
  await handle.sync();
}
function dead(pid: unknown) {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
export async function acquireInstanceLock(path: string) {
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const recovery = await open(path + '.recover', 'wx', 0o600);
  try {
    const owner = JSON.parse(await readFile(path, 'utf8'));
    if (!dead(owner.pid) || !dead(owner.childPid))
      throw new Error('Existing native runtime shutdown is not confirmed');
    await unlink(path);
    return await open(path, 'wx', 0o600);
  } finally {
    await recovery.close();
    await unlink(path + '.recover');
  }
}
export class NativeWebHost {
  readonly contextGeneration = randomUUID();
  private contextSource?: { url: string; origin: string };
  configureContext(url: string, origin: string) {
    this.contextSource = { url, origin };
  }
  verifyContext(token: unknown) {
    return this.key
      ? verifyGrant(this.key, token, 'rdws:bff:' + this.contextGeneration)
      : undefined;
  }
  claims(token: string) {
    return this.key ? verifyGrant(this.key, token, this.audience) : undefined;
  }
  private process?: ChildProcess;
  private starting?: Promise<void>;
  private origin = '';
  private key = '';
  private lock?: Awaited<ReturnType<typeof open>>;
  readonly home: string;
  readonly audience = 'rdws:poc';
  readonly demandRoot: string;
  constructor(
    readonly runtimeHome: string,
    readonly configurationHome?: string,
  ) {
    this.home = join(runtimeHome, 'runtime', 'dsh', 'project-poc');
    this.demandRoot = join(runtimeHome, 'projects', 'poc', 'demands');
  }
  async start() {
    this.starting ??= this.launch();
    return this.starting;
  }
  private async launch() {
    const controls = join(this.runtimeHome, 'runtime', 'instances');
    await mkdir(controls, { recursive: true, mode: 0o700 });
    await mkdir(join(this.runtimeHome, 'secrets'), {
      recursive: true,
      mode: 0o700,
    });
    this.lock = await acquireInstanceLock(join(controls, 'project-poc.lock'));
    await this.lock.writeFile(
      JSON.stringify({ pid: process.pid, mode: 'web' }),
    );
    try {
      const keyFile = join(this.runtimeHome, 'secrets', 'dsh-bff-key');
      try {
        await writeFile(keyFile, randomBytes(32).toString('hex'), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.key = await readFile(keyFile, 'utf8');
      const profile = join(this.home, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const manifestFile = join(profile, 'package.json');
      let manifest: {
        private?: boolean;
        dependencies?: Record<string, string>;
        dsh?: { profile?: { bundles?: string[] } };
      } = { private: true, dependencies: {} };
      try {
        manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const bundles = (
        manifest.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base']
      ).filter((name) => name !== '@deepseek-ai/dsh-sdk-app');
      if (!bundles.includes('@deepseek-ai/dsh-web-app'))
        bundles.push('@deepseek-ai/dsh-web-app');
      manifest.dsh = {
        ...manifest.dsh,
        profile: { ...manifest.dsh?.profile, bundles },
      };
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', {
        mode: 0o600,
      });
      const modelFile = this.configurationHome
        ? join(this.configurationHome, 'profiles', 'rdws', 'cordis.patch.yml')
        : join(profile, 'cordis.patch.yml');
      if (this.configurationHome) {
        try {
          await access(join(profile, 'cordis.patch.yml'));
        } catch {
          await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', {
            mode: 0o600,
          });
        }
      }
      const document = parseDocument(await readFile(modelFile, 'utf8'));
      const rows = document.toJS() as {
        id?: string;
        config?: { providers?: Record<string, { models?: { id: string }[] }> };
      }[];
      const model = rows.find((row) => row.id === 'llm-pi-ai')?.config
        ?.providers?.['rdws-glm']?.models?.[0]?.id;
      if (!model) throw new Error('Native model not configured');
      if (
        !this.configurationHome &&
        !rows.some((row) => row.id === 'agent-default-model')
      ) {
        document.add({
          id: 'agent-default-model',
          config: { provider: 'rdws-glm', model },
        });
        const temp = modelFile + '.rdws-init';
        await writeFile(temp, document.toString(), { mode: 0o600, flag: 'wx' });
        await rename(temp, modelFile);
      }
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          server.close(() =>
            resolve(typeof address === 'object' && address ? address.port : 0),
          );
        });
      });
      this.origin = `http://127.0.0.1:${port}`;
      const overlay = join(controls, 'web.cordis.yml');
      await writeFile(
        overlay,
        JSON.stringify([
          ...(this.configurationHome
            ? [
                {
                  id: 'credentials',
                  config: {
                    path: join(this.configurationHome, '.credentials.yaml'),
                  },
                },
              ]
            : []),
          {
            id: 'webserver',
            config: { host: '127.0.0.1', port, compression: 'gzip' },
          },
          {
            id: 'web-runtime',
            config: {
              openBrowser: false,
              printUrl: false,
              surfaceContext: false,
            },
          },
          { id: 'desktop-product-telemetry', disabled: true },
          { id: 'product-analytics', disabled: true },
          { id: 'harness-dev-context', disabled: true },
          {
            insert: [
              {
                id: 'rdws-access',
                name: fileURLToPath(
                  new URL('../plugins/rdws-access/index.mjs', import.meta.url),
                ),
                config: {
                  keyFile,
                  audience: this.audience,
                  demandRoot: this.demandRoot,
                  contextSource: this.contextSource,
                  contextGeneration: this.contextGeneration,
                  contextEvidenceFile: join(
                    this.runtimeHome,
                    'runtime',
                    'context-evidence.jsonl',
                  ),
                },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      const pkg = req.resolve('@deepseek-ai/dsh/package.json');
      const meta = JSON.parse(await readFile(pkg, 'utf8'));
      const bin = join(dirname(pkg), meta.bin.dsh);
      await mkdir(this.demandRoot, { recursive: true, mode: 0o700 });
      const env: NodeJS.ProcessEnv = {
        DSH_HOME: this.home,
        DSH_PRIMARY_RUNTIME: '',
        DSH_PERMISSION_MODE: 'read-only',
      };
      for (const key of [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'NODE_EXTRA_CA_CERTS',
      ])
        if (process.env[key]) env[key] = process.env[key];
      let diagnostics = '';
      this.process = spawn(
        process.execPath,
        [
          '--import',
          req.resolve('tsx/esm'),
          bin,
          '--profile',
          'rdws',
          ...(this.configurationHome ? ['--patch', modelFile] : []),
          '--patch',
          fileURLToPath(
            new URL('../profiles/probe-policy.cordis.yml', import.meta.url),
          ),
          '--patch',
          fileURLToPath(
            new URL('../profiles/web-readonly.cordis.yml', import.meta.url),
          ),
          '--patch',
          overlay,
        ],
        { cwd: this.demandRoot, env, stdio: ['pipe', 'ignore', 'pipe', 'ipc'] },
      );
      await writeOwner(this.lock, {
        pid: process.pid,
        childPid: this.process.pid,
        mode: 'web',
      });
      this.process.stderr?.on('data', (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-8000);
      });
      for (let attempt = 0; attempt < 150; attempt++) {
        if (this.process.exitCode !== null)
          throw new Error(
            'Native web startup failed: ' +
              diagnostics
                .replace(/https?:\/\/[^\s"']+/g, '[endpoint]')
                .replaceAll(this.runtimeHome, '$RDWS_HOME'),
          );
        try {
          const result = await this.control('health', {});
          if (result.ready) return;
        } catch {
          diagnostics ||= 'Native HTTP readiness pending';
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(
        'Native web startup timed out: ' +
          diagnostics
            .replace(/https?:\/\/[^\s"']+/g, '[endpoint]')
            .replaceAll(this.runtimeHome, '$RDWS_HOME')
            .replaceAll(process.cwd(), '$REPOSITORY'),
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  ticket(input: Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>) {
    return signGrant(this.key, { ...input, aud: this.audience });
  }
  async control(
    operation: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = this.ticket({
      purpose: 'service',
      operation,
      bodyHash: bodyHash(body),
    });
    const response = await fetch(this.origin + '/_rdws/' + operation, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rdws-delegation': token,
        origin: this.origin,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Native control unavailable');
    return response.json();
  }
  async workspace(id: string, title: string) {
    await this.start();
    const cwd = join(this.demandRoot, id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const result = await this.control('workspace', {
      requirementId: id,
      cwd,
      title,
    });
    return { cwd, workspaceId: String(result.workspaceId) };
  }
  async fetch(
    path: string,
    grant: string | Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>,
    init: RequestInit = {},
  ) {
    await this.start();
    return fetch(
      this.origin +
        (path === '/api/rdws/bootstrap'
          ? '/_rdws/bootstrap'
          : path.startsWith('/api/')
            ? '/_rdws' + path
            : path),
      {
        ...init,
        headers: {
          ...init.headers,
          'x-rdws-delegation':
            typeof grant === 'string' ? grant : this.ticket(grant),
          origin: this.origin,
        },
        signal: init.signal ?? AbortSignal.timeout(30000),
      },
    );
  }
  socketUrl() {
    return this.origin.replace('http:', 'ws:') + '/_rdws/remote.mux';
  }
  async revoke(authSessionId: string, requirementId?: string) {
    if (!this.process) return;
    await this.control('revoke', {
      authSessionId,
      ...(requirementId ? { requirementId } : {}),
      before: Date.now(),
    });
  }
  async close() {
    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 6000);
        const deadline = setTimeout(
          () => reject(new Error('Native shutdown not confirmed')),
          10000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve();
        });
      });
    }
    this.process = undefined;
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(
        join(this.runtimeHome, 'runtime', 'instances', 'project-poc.lock'),
      );
    }
  }
}
