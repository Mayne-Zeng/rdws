import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  open,
  unlink,
  rename,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { serveContextIpc, type ContextHandler } from '../bridge/context-ipc.ts';
import {
  signGrant,
  verifyGrant,
  bodyHash,
  LEASE_MS,
  type Grant,
} from '../bridge/access.ts';
import {
  capabilityRelease,
  DemandPresets,
  type PresetSelection,
  type ReleasedCapability,
} from './presets.ts';
export { isDemandPreset } from './presets.ts';
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
    await verifyFile(path, true);
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
export const validProjectId = (id: string) =>
  /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);

async function managedDirectory(root: string, parts: string[], create = false) {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    const entry = await lstat(current);
    if (
      !entry.isDirectory() ||
      entry.uid !== process.getuid?.() ||
      entry.mode & 0o022 ||
      (await realpath(current)) !== current
    )
      throw new Error('Invalid managed Native directory');
  }
  return current;
}

async function verifyFile(path: string, privateMode = false) {
  const entry = await lstat(path);
  if (
    !entry.isFile() ||
    entry.uid !== process.getuid?.() ||
    entry.mode & (privateMode ? 0o077 : 0o022)
  )
    throw new Error('Invalid managed Native file');
}

async function verifyOptionalFile(path: string, privateMode = false) {
  try {
    await verifyFile(path, privateMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function projectNativeConfiguration(
  root: string,
  projectId: string,
) {
  if (!validProjectId(projectId)) throw new Error('Invalid Native project ID');
  const directory = await managedDirectory(await realpath(root), [
    'config',
    'projects',
    projectId,
    'dsh',
  ]);
  const profile = await managedDirectory(directory, ['profiles', 'rdws']);
  await verifyFile(join(profile, 'cordis.patch.yml'));
  await verifyFile(join(directory, '.credentials.yaml'), true);
  return directory;
}

export class NativeWebHost {
  readonly contextGeneration = randomUUID();
  private contextHandler?: ContextHandler;
  configureContext(handle: ContextHandler) {
    this.contextHandler = handle;
  }
  verifyContext(token: unknown) {
    return this.key
      ? verifyGrant(this.key, token, 'rdws:bff:' + this.contextGeneration)
      : undefined;
  }
  claims(token: string) {
    const grant = this.key && verifyGrant(this.key, token, this.audience);
    return grant && grant.hostGeneration === this.contextGeneration
      ? grant
      : undefined;
  }
  private process?: ChildProcess;
  private starting?: Promise<void>;
  private origin = '';
  private closing = false;
  private ready = false;
  private invalidation = new AbortController();
  private key = '';
  private lock?: Awaited<ReturnType<typeof open>>;
  readonly home: string;
  readonly audience: string;
  readonly presets: DemandPresets;
  private readonly releasedCapabilities: readonly ReleasedCapability[];
  demandRoot: string;
  private lockPath = '';
  private readyPath = '';
  private shutdown?: Promise<void>;
  get signal() {
    return this.invalidation.signal;
  }
  constructor(
    readonly runtimeHome: string,
    readonly configurationHome?: string,
    readonly projectId = 'poc',
    release: readonly ReleasedCapability[] = capabilityRelease,
  ) {
    if (!validProjectId(projectId))
      throw new Error('Invalid Native project ID');
    this.home = join(runtimeHome, 'runtime', 'dsh', 'project-' + projectId);
    this.demandRoot = join(runtimeHome, 'projects', projectId, 'demands');
    this.audience = 'rdws:' + projectId;
    this.releasedCapabilities = release.map((entry) => ({ ...entry }));
    this.presets = new DemandPresets(
      runtimeHome,
      projectId,
      this.releasedCapabilities,
    );
  }
  async start() {
    if (this.closing || this.invalidation.signal.aborted)
      throw new Error('Native instance stopped');
    if (!this.starting) {
      const starting = this.launch();
      this.starting = starting;
      void starting.catch(() => {
        if (!this.lock && !this.process && !this.closing)
          this.starting = undefined;
      });
    }
    await this.starting;
    if (!this.ready || this.closing)
      throw new Error('Native instance unavailable');
  }
  private async launch() {
    const root = await realpath(this.runtimeHome).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(this.runtimeHome, { recursive: true, mode: 0o700 });
        return realpath(this.runtimeHome);
      },
    );
    const controls = await managedDirectory(
      root,
      ['runtime', 'instances'],
      true,
    );
    const secrets = await managedDirectory(root, ['secrets'], true);
    const instance = 'project-' + this.projectId;
    const home = await managedDirectory(
      root,
      ['runtime', 'dsh', instance],
      true,
    );
    this.demandRoot = await managedDirectory(
      root,
      ['projects', this.projectId, 'demands'],
      true,
    );
    this.lockPath = join(controls, instance + '.lock');
    this.readyPath = join(controls, instance + '.ready.json');
    this.lock = await acquireInstanceLock(this.lockPath);
    try {
      await writeOwner(this.lock, { pid: process.pid, mode: 'web' });
      const keyFile = join(
        secrets,
        this.projectId === 'poc'
          ? 'dsh-bff-key'
          : 'dsh-bff-key-' + this.projectId,
      );
      try {
        await writeFile(keyFile, randomBytes(32).toString('hex'), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await verifyFile(keyFile, true);
      this.key = (await readFile(keyFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(this.key))
        throw new Error('Invalid Native signing key');
      const profile = await managedDirectory(home, ['profiles', 'rdws'], true);
      await Promise.all([
        verifyOptionalFile(join(home, 'cordis.patch.yml')),
        verifyOptionalFile(join(profile, 'cordis.yml')),
        verifyOptionalFile(join(home, '.credentials.yaml'), true),
      ]);
      const manifestFile = join(profile, 'package.json');
      let manifest: {
        private?: boolean;
        dependencies?: Record<string, string>;
        dsh?: { profile?: { bundles?: string[] } };
      } = { private: true, dependencies: {} };
      try {
        await verifyFile(manifestFile);
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
          await verifyFile(join(profile, 'cordis.patch.yml'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', {
            mode: 0o600,
            flag: 'wx',
          });
        }
      }
      await verifyFile(modelFile);
      if (this.configurationHome)
        await verifyFile(
          join(this.configurationHome, '.credentials.yaml'),
          true,
        );
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
      const overlay = join(
        controls,
        this.projectId === 'poc' ? 'web.cordis.yml' : instance + '.cordis.yml',
      );
      if (
        await lstat(overlay).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        )
      )
        await verifyFile(overlay);
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
            config: { host: '127.0.0.1', port: 0, compression: 'gzip' },
          },
          {
            id: 'web-runtime',
            config: {
              openBrowser: false,
              printUrl: false,
              surfaceContext: false,
            },
          },
          ...(this.configurationHome &&
          !rows.some((row) => row.id === 'agent-default-model')
            ? [
                {
                  id: 'agent-default-model',
                  config: { provider: 'rdws-glm', model },
                },
              ]
            : []),
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
                  presetRuntimeHome: root,
                  projectId: this.projectId,
                  releasedCapabilities: this.releasedCapabilities,
                  contextGeneration: this.contextGeneration,
                  contextEvidenceFile: join(
                    this.runtimeHome,
                    'runtime',
                    this.projectId === 'poc'
                      ? 'context-evidence.jsonl'
                      : 'context-evidence-' + this.projectId + '.jsonl',
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
        DSH_HOME: home,
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
      if (this.closing) throw new Error('Native instance stopped');
      const child = spawn(
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
      this.process = child;
      let exited = false;
      let port = 0;
      const stopContext = serveContextIpc(
        child,
        this.contextGeneration,
        this.contextHandler,
        () =>
          this.process === child &&
          this.ready &&
          !this.closing &&
          !this.invalidation.signal.aborted,
      );
      const invalidate = () => {
        stopContext();
        exited = true;
        this.origin = '';
        if (this.ready) this.invalidation.abort();
        this.ready = false;
      };
      child.once('error', invalidate);
      child.once('exit', invalidate);
      child.once('disconnect', invalidate);
      child.on('message', (message: unknown, handle) => {
        if (handle || exited || port || !message || typeof message !== 'object')
          return;
        const value = message as Record<string, unknown>;
        if (
          value.type === 'rdws-ready' &&
          value.generation === this.contextGeneration &&
          Number.isInteger(value.port) &&
          Number(value.port) > 0 &&
          Number(value.port) <= 65535
        )
          port = Number(value.port);
      });
      child.stderr?.resume();
      await writeOwner(this.lock, {
        pid: process.pid,
        childPid: child.pid,
        mode: 'web',
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (exited || this.closing) break;
        if (port) {
          this.origin = 'http://127.0.0.1:' + port;
          const result = await this.control('health', {}).catch(
            () => undefined,
          );
          const proof =
            result &&
            verifyGrant(
              this.key,
              result.proof,
              'rdws:ready:' + this.contextGeneration,
            );
          if (
            !exited &&
            !this.closing &&
            proof?.purpose === 'service' &&
            proof.hostGeneration === this.contextGeneration &&
            proof.bodyHash === bodyHash({ port })
          ) {
            this.ready = true;
            const temporary = this.readyPath + '.' + this.contextGeneration;
            try {
              await writeFile(
                temporary,
                JSON.stringify({
                  port,
                  generation: this.contextGeneration,
                  pid: child.pid,
                }),
                { mode: 0o600, flag: 'wx' },
              );
              await rename(temporary, this.readyPath);
            } finally {
              await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
            }
            if (!exited && !this.closing) return;
          }
          this.origin = '';
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('Native web startup failed or timed out');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  ticket(
    input: Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>,
    notAfter = Infinity,
  ) {
    if (!this.key || !this.origin || this.closing)
      throw new Error('Native instance unavailable');
    const now = Date.now(),
      lease = Math.min(LEASE_MS, notAfter - now);
    if (lease <= 0) throw new Error('Native delegation expired');
    return signGrant(
      this.key,
      { ...input, aud: this.audience, hostGeneration: this.contextGeneration },
      now,
      lease,
    );
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
      signal: AbortSignal.timeout(operation === 'health' ? 500 : 5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Native control unavailable');
    return response.json();
  }
  async preparePreset(requirementId: string, selection: PresetSelection) {
    const definition = this.presets.definition(requirementId, selection);
    await this.presets.publish(definition);
    await this.ensurePreset(requirementId, definition.id);
    return definition;
  }
  async ensurePreset(requirementId: string, id: string) {
    await this.start();
    const result = await this.control('preset.ensure', { requirementId, id });
    if (result.id !== id) throw new Error('Native preset was not loaded');
  }
  async workspace(id: string, title: string, existingOnly = false) {
    await this.start();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid requirement ID');
    const cwd = await managedDirectory(this.demandRoot, [id], !existingOnly);
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
        signal: AbortSignal.any([
          this.signal,
          init.signal ?? AbortSignal.timeout(30000),
        ]),
        redirect: 'error',
      },
    );
  }
  socketUrl() {
    return this.origin.replace('http:', 'ws:') + '/_rdws/remote.mux';
  }
  async revoke(
    authSessionId: string,
    requirementId?: string,
    before = Date.now(),
    invalidateRuns = true,
  ) {
    if (!this.process) return;
    await this.control('revoke', {
      authSessionId,
      ...(requirementId ? { requirementId } : {}),
      before,
      invalidateRuns,
    });
  }
  close() {
    this.closing = true;
    this.invalidation.abort();
    this.shutdown ??= (async () => {
      await this.starting?.catch(() => {});
      await this.stop();
    })();
    return this.shutdown;
  }
  private async stop() {
    const child = this.process;
    this.ready = false;
    this.origin = '';
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolve();
        };
        const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
        const deadline = setTimeout(() => {
          child.off('exit', done);
          reject(new Error('Native shutdown not confirmed'));
        }, 10000);
        child.once('exit', done);
        child.kill('SIGTERM');
      });
    }
    this.process = undefined;
    this.key = '';
    if (this.lock) {
      const owner = await this.lock.stat();
      const current = await lstat(this.lockPath);
      if (
        !current.isFile() ||
        owner.dev !== current.dev ||
        owner.ino !== current.ino
      )
        throw new Error('Native lock ownership changed');
      await unlink(this.readyPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await unlink(this.lockPath);
      await this.lock.close();
      this.lock = undefined;
    }
  }
}
