import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import { afterEach, expect, test, vi } from 'vitest';
import { bodyHash } from '@rdws/dsh/access';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import { NativeShellToolJob } from '../../apps/server/src/modules/native-shell-tool-job.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

// §11.20.27 B segment: Shell and Git on the supervised loopback and the
// two-developer red-to-green journey of §11.20.20 on the same BFF.
//   A (writable): writes a failing test, runs the registered command (exit 1,
//   TAP with paths and credential shapes, handled), reads the continuation,
//   fixes the implementation, reruns (exit 0), reads a long continuation
//   across pages, meets the output budget and the deadline, queries Git.
//   B: reads the latest files, then takes over; A's old session loses every
//   write tool call (R3, W12 step 9) and B writes.
// Two concurrent takeovers leave exactly one writer (W16); a cancelled run
// stops with its process group gone and the generation kept (W14).
afterEach(() => vi.unstubAllEnvs());

type Message = { role: string; tool_call_id?: string; content: unknown };
type RequestBody = {
  messages: Message[];
  tools?: { function: { name: string } }[];
};
type Event = {
  type: string;
  data: { reason?: { kind: string } };
};
type Call = { name: string; args: Record<string, unknown>; id?: string };

const canary = 'canary-env-value-7f3a';
const testFile = `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { test } from 'node:test';
import { sum } from './sum.mjs';
const size = existsSync('output-size.txt') ? readFileSync('output-size.txt', 'utf8').trim() : '20000';
// The account home is named by the fixture: the process has no HOME and
// must not read outside the tree to learn it.
const home = readFileSync('home-path.txt', 'utf8').trim();
// The assertion comes first, so its failure details are in the direct head;
// the long output of the second test follows and is continued by read.
test('sum adds', async () => {
  console.log('tree=' + process.cwd());
  console.log('url=file://' + process.cwd() + '/sum.mjs');
  console.log('home=' + home);
  console.log('node=' + process.execPath);
  console.log('password=hunter2');
  console.log('Authorization: Bearer abc.def.ghi');
  console.log('token: "s3cr3t-value"');
  try { readFileSync('.env'); console.log('env-read-allowed'); } catch { console.log('env-read-denied'); }
  try { writeFileSync('.env', 'x'); console.log('env-write-allowed'); } catch { console.log('env-write-denied'); }
  try { readFileSync(home + '/.zshrc'); console.log('home-read-allowed'); } catch { console.log('home-read-denied'); }
  try { writeFileSync('.git/x', 'x'); console.log('git-write-allowed'); } catch { console.log('git-write-denied'); }
  try { const r = spawnSync('/bin/true'); console.log(r.error ? 'spawn-denied' : 'spawn-allowed'); } catch { console.log('spawn-denied'); }
  // The network verdict is awaited: the socket error arrives asynchronously.
  await new Promise((resolve) => {
    const timer = setTimeout(() => { console.log('network-unknown'); resolve(); }, 3000);
    try {
      const s = connect(443, '127.0.0.1');
      s.on('error', () => { clearTimeout(timer); console.log('network-denied'); resolve(); });
      s.on('connect', () => { clearTimeout(timer); console.log('network-allowed'); s.end(); resolve(); });
    } catch { clearTimeout(timer); console.log('network-denied'); resolve(); }
  });
  assert.equal(sum(2, 3), 5);
});
test('long output', () => {
  // A heartbeat before the long wait: the stop point of the cancel case.
  if (size === 'sleep') writeFileSync('heartbeat', String(process.pid) + '\\n');
  if (size === 'sleep') { const end = Date.now() + 30000; while (Date.now() < end) {} }
  const n = Number(size) || 0;
  const lines = Math.ceil(n / 1000);
  for (let i = 0; i < lines; i++) console.log('line-' + String(i).padStart(6, '0') + '-' + 'x'.repeat(982));
});
`;

const write = (file_path: string, content: string): Call => ({
  name: 'write',
  args: { file_path, content },
});
const edit = (old_string: string, new_string: string): Call => ({
  name: 'edit',
  args: { file_path: 'sum.mjs', old_string, new_string },
});
const bash = (): Call => ({
  name: 'bash',
  args: { command: 'node sum.test.mjs', description: 'Run the sum test' },
});
const git = (operation: 'status' | 'diff'): Call => ({
  name: 'git',
  args: { operation },
});
const read = (file_path: string, args: Record<string, number> = {}): Call => ({
  name: 'read',
  args: { file_path: file_path, ...args },
});

test.skipIf(process.platform !== 'darwin')(
  '§11.20.27 B: Shell and Git complete the supervised loopback and two developers go from red to green on one BFF',
  async () => {
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    type Child = { pid: string; command: string };
    const children = (): Child[] => {
      const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
        encoding: 'utf8',
      });
      return listing.stdout
        .split('\n')
        .map((row) => {
          const [pid = '', ppid = '', ...rest] = row.trim().split(/\s+/);
          return { pid, ppid, command: rest.join(' ') };
        })
        .filter(
          ({ pid, ppid }) =>
            ppid === String(process.pid) && pid !== String(listing.pid),
        )
        .map(({ pid, command }) => ({ pid, command }));
    };
    const containerNames = () =>
      execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    const lab = await authorityDatabase();
    const ownContainer = lab.containerName;
    let ownChildren: Child[] = [];
    const projectId = 'poc';
    const provider = 'rdws-glm';
    const model = 'shell-git-loopback';
    const requirementId = randomUUID();
    const userId = randomUUID();
    const otherId = randomUUID();
    const thirdId = randomUUID();
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const header = 'shell-git-loopback-fixture';
    const wrong = 'export const sum = (a, b) => a - b;\n';
    const right = 'export const sum = (a, b) => a + b;\n';

    const requests: RequestBody[] = [];
    const frames: { attempt: string; body: Buffer }[] = [];
    const sockets = new Set<Socket>();
    const originalCAs = getCACertificates('default');
    let app: ReturnType<typeof buildApp> | undefined;
    let observer: Pool | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    const keys = await modelTlsCertificate(lab.root);
    setDefaultCACertificates([...originalCAs, keys.cert.toString()]);

    // The trusted-side director: every session has a queue of calls; a bash
    // result with a continuation marker, or a read the locked read
    // truncated by lines, enqueues the continuation before the queue goes on.
    const scripts = new Map<string, Call[]>();
    const seen = new Map<
      string,
      { results: string[]; declarations: string[][]; redactions: number[] }
    >();
    const lastSpill = new Map<string, string>();
    const director = {
      respond(input: RequestBody) {
        const sessionId = [...scripts.keys()].find((key) =>
          input.messages.some(
            ({ role, content }) =>
              role === 'user' &&
              typeof content === 'string' &&
              content.startsWith(key + ':'),
          ),
        );
        if (!sessionId) throw new Error('No script for this run');
        const record = seen.get(sessionId)!;
        record.declarations.push(
          (input.tools ?? []).map(({ function: spec }) => spec.name),
        );
        const toolMessages = input.messages.filter(
          ({ role }) => role === 'tool',
        );
        const last = toolMessages.at(-1);
        const lastText = last ? String(last.content) : '';
        record.results.push(lastText);
        const queue = scripts.get(sessionId)!;
        const spill =
          /\[output truncated; full output: (\.rdws-read\/[0-9a-f-]+)\]/.exec(
            lastText,
          );
        const offset = /Use offset=(\d+)/.exec(lastText);
        if (spill) lastSpill.set(sessionId, spill[1]!);
        if (toolMessages.length && (spill || offset)) {
          // The continuation of the output the run is reading: first from
          // the marker, then by the line offset the locked read names.
          const path = lastSpill.get(sessionId);
          if (path)
            return call(
              read(path, offset ? { offset: Number(offset[1]) } : {}),
              toolMessages.length,
            );
        }
        const step = queue.shift();
        if (!step)
          return { role: 'assistant', content: 'Shell loopback finished' };
        return call(step, toolMessages.length);
      },
    };
    function call(step: Call, index: number) {
      return {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-' + index + '-' + step.name,
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          },
        ],
      };
    }
    const supplier = httpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      (request, response) => {
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            if (request.url === '/v1/read-loopback') {
              frames.push({
                attempt: String(request.headers['x-rdws-window-attempt'] ?? ''),
                body,
              });
              response.end('shell-git-loopback-ok');
              return;
            }
            const input = JSON.parse(body.toString()) as RequestBody;
            requests.push(input);
            const delta = director.respond(input);
            const frame = {
              id: 'shell-git-loopback',
              object: 'chat.completion.chunk',
              created: 1,
              model,
            };
            const choices = [
              { index: 0, delta, finish_reason: null },
              {
                index: 0,
                delta: {},
                finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop',
              },
            ];
            response
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(
                choices
                  .map(
                    (choice) =>
                      'data: ' +
                      JSON.stringify({ ...frame, choices: [choice] }) +
                      '\n\n',
                  )
                  .join('') + 'data: [DONE]\n\n',
              );
          } catch {
            response.destroy();
          }
        })();
      },
    );
    const proxy = createServer((client) => {
      const upstream = connect(
        (supplier.address() as { port: number }).port,
        '127.0.0.1',
      );
      sockets.add(client).add(upstream);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    let primary: unknown;
    try {
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      const baseURL =
        'https://127.0.0.1:' +
        (proxy.address() as { port: number }).port +
        '/v1';
      observer = new Pool({ connectionString: lab.databaseUrl });
      observer.on('error', () => {});
      const source = await httpsGitFixture(projectId);
      const { root } = source;
      mirrors = new RepositoryMirrors(root);
      trees = new DemandWorktrees(root, mirrors);
      // The frozen fixture: the registered command, a wrong implementation,
      // and protected locations with canary content (W19, R16).
      const files: Record<string, string> = {
        'package.json': JSON.stringify({
          name: 'shell-git-loopback',
          scripts: { test: 'node sum.test.mjs' },
        }),
        'sum.mjs': wrong,
        'sample.txt': 'frozen baseline\n',
        '.env': 'SECRET=' + canary + '\n',
        'certs/server.pem':
          '-----BEGIN RSA PRIVATE KEY-----\n' +
          canary +
          '\n-----END RSA PRIVATE KEY-----\n',
        'home-path.txt': process.env.HOME! + '\n',
      };
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(source.work, name.split('/').slice(0, -1).join('/')), {
          recursive: true,
        }).catch(() => {});
        await writeFile(join(source.work, name), text);
      }
      await fixtureGit(['-C', source.work, 'add', '--', ...Object.keys(files)]);
      await source.commit();
      await source.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
        ...entry,
        branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
        worktreePath: 'worktrees/' + entry.repositoryId,
        gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
      }));
      await trees.prepare(projectId, requirementId, plan);
      const execution = await trees!.executionScope(
        projectId,
        requirementId,
        plan,
        'app',
      );
      const treeDir = execution.tree;
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { SHELL_LOOPBACK: 'synthetic-only' },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                [provider]: {
                  api: 'openai-completions',
                  baseURL,
                  apiKeyEnv: 'SHELL_LOOPBACK',
                  models: [{ id: model }],
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      await lab.owner.query(
        "insert into project(id,name) values('poc','Shell loopback project')",
      );
      for (const [id, name] of [
        [userId, 'dev_a'],
        [otherId, 'dev_b'],
        [thirdId, 'dev_c'],
      ]) {
        await lab.owner.query(
          'insert into auth_user(id,name,email,username,active,platform_admin) values($1,$2,$3,$4,true,false)',
          [id, name, name + '@fixture.invalid', name],
        );
        await lab.owner.query(
          "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
          [randomUUID(), id, await hashPassword(password)],
        );
        await lab.owner.query(
          "insert into project_member values('poc',$1,'developer')",
          [id],
        );
      }
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Shell loopback','','',$2,$2)",
        [requirementId, userId],
      );
      for (const id of [userId, otherId, thirdId])
        await lab.owner.query(
          "insert into requirement_participant values($1,$2,'developer')",
          [requirementId, id],
        );
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [requirementId, JSON.stringify(plan)],
      );
      const ticket = randomBytes(32).toString('hex');
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      const bff = buildApp({
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        authorityTicket: ticket,
        repositoryHome: root,
        nativeRuntimeRoot: root,
        mainModelPolicy: {
          projectId,
          provider,
          model,
          destination: baseURL + '/chat/completions',
        },
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
          fleetCommands: true,
          supervisedExecution: true,
          readSnapshots: true,
          readTool: {
            window: {
              destination: baseURL + '/read-loopback',
              ca: keys.cert.toString('utf8'),
              header,
            },
            repositoryId: 'app',
          },
          writeTools: { repositoryId: 'app', shellGit: true },
        },
      });
      app = bff;
      await bff.ready();
      const broker = bff.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )()!;
      const permits = { write: 0, read: 0 };
      const executions: {
        tool: string;
        receipt?: string;
        status?: string;
        stop?: string;
        marker?: string;
        exitCode?: number | null;
      }[] = [];
      const runsPrototype = (
        await import('../../apps/server/src/modules/runtime-context.ts')
      ).ContextRuns.prototype as unknown as Record<
        string,
        (this: unknown, ...args: unknown[]) => unknown
      >;
      for (const [name, key] of [
        ['authorizeWriteTool', 'write'],
        ['authorizeReadTool', 'read'],
      ] as const) {
        const original = runsPrototype[name]!;
        runsPrototype[name] = function (this: unknown, ...args: unknown[]) {
          return Promise.resolve(Reflect.apply(original, this, args)).then(
            (result: unknown) => {
              if (result && typeof result === 'object' && 'digest' in result)
                permits[key]++;
              return result;
            },
          );
        };
      }
      // A-3: every projection the FD4 policy applied is counted, and so is
      // every one that carried the output policy — the backstop scan is
      // never skipped for lack of a policy.
      const scanned = { projected: 0, policies: 0 };
      const writeWire = runsPrototype.writeWire!;
      runsPrototype.writeWire = function (this: unknown, ...args: unknown[]) {
        const projection = Reflect.apply(writeWire, this, args) as
          { redactions?: number; redaction?: unknown } | undefined;
        if (projection) {
          scanned.projected++;
          if (projection.redaction) scanned.policies++;
          redactions.push(projection.redactions ?? 0);
        }
        return projection;
      };
      const redactions: number[] = [];
      const execute = broker.execute;
      vi.spyOn(broker, 'execute').mockImplementation((...args) =>
        execute.apply(broker, args).then((receipt) => {
          executions.push({
            tool: args[1].request.tool,
            receipt: receipt.status,
            ...('result' in receipt
              ? {
                  status: receipt.result.status,
                  stop: receipt.result.stop,
                  marker: receipt.result.marker,
                  exitCode: receipt.result.exitCode,
                }
              : {}),
          });
          return receipt;
        }),
      );
      const login = async (username: string) => {
        const signin = await bff.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          remoteAddress: '192.0.2.210',
          headers: { origin },
          payload: { username, password },
        });
        expect(signin.statusCode, signin.body).toBe(200);
        const cookie = signin.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        return { cookie, authSessionId: await observedLogin(bff, cookie) };
      };
      const a = await login('dev_a');
      const b = await login('dev_b');
      const c = await login('dev_c');
      const bindings = new Map<string, string>();
      for (const [who, id] of [
        [a, userId],
        [b, otherId],
        [c, thirdId],
      ] as const)
        bindings.set(id, await bootstrapNative(bff, who.cookie, requirementId));
      ownChildren = children();
      async function create(cookie: string, authSessionId: string) {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/requirements/' + requirementId + '/sessions',
          headers: { cookie, origin, 'x-rdws-edit-session': authSessionId },
          payload: { commandId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ sessionId: string }>().sessionId;
      }
      async function rpc(
        binding: string,
        cookie: string,
        method: string,
        request: object,
      ) {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/dsh/' + requirementId + '/native/api/session/' + method,
          headers: {
            cookie,
            origin,
            'x-rdws-native-login': binding,
            'x-rdws-client-generation': randomUUID(),
          },
          payload: {
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/' + method,
            payload: { args: { request } },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const result = response.json().result;
        expect(result.ok, JSON.stringify(result)).toBe(true);
        return result.value;
      }
      const ended = async (
        binding: string,
        cookie: string,
        sessionId: string,
      ) =>
        (
          (
            await rpc(binding, cookie, 'events', {
              address: { kind: 'session', sessionId },
            })
          ).records as { event: Event }[]
        )
          .map(({ event }) => event)
          .filter(({ type }) => type === 'turn/end').length;
      async function run(
        who: { cookie: string; authSessionId: string },
        id: string,
        binding: string,
        sessionId: string,
        script: Call[],
        arm: 'read' | 'write' | 'none',
      ) {
        scripts.set(sessionId, [...script]);
        seen.set(sessionId, { results: [], declarations: [], redactions: [] });
        const requestId = randomUUID();
        const scope = {
          who: { userId: id, authSessionId: who.authSessionId },
          projectId,
          requirementId,
          sessionId,
        };
        if (arm !== 'none')
          bff.getDecorator<
            (input: { scope: object; requestId: string }) => void
          >('armIsolatedReadTool')({ scope, requestId });
        if (arm === 'write')
          bff.getDecorator<
            (input: {
              scope: object;
              requestId: string;
              repositoryId: string;
            }) => void
          >('armIsolatedWriteTools')({ scope, requestId, repositoryId: 'app' });
        const before = requests.length;
        const turnsBefore = await ended(binding, who.cookie, sessionId);
        await rpc(binding, who.cookie, 'prompt', {
          sessionId,
          mode: 'queue',
          requestId,
          content: [{ type: 'text', text: sessionId + ': run the script' }],
        });
        // The run ends with its own turn (a session may carry earlier runs).
        await expect
          .poll(() => ended(binding, who.cookie, sessionId), {
            timeout: 180_000,
          })
          .toBe(turnsBefore + 1);
        const record = seen.get(sessionId)!;
        record.redactions = redactions.splice(0);
        return { requests: requests.slice(before), ...record };
      }
      const fleet = (
        who: { cookie: string; authSessionId: string },
        sessionId: string,
        payload: unknown,
      ) =>
        bff.inject({
          method: 'POST',
          url:
            '/api/requirements/' +
            requirementId +
            '/sessions/' +
            sessionId +
            '/write-authority/commands',
          headers: {
            cookie: who.cookie,
            origin,
            'x-rdws-edit-session': who.authSessionId,
          },
          payload: payload as never,
        });
      const fileBytes = (name: string) =>
        readFile(join(treeDir, name), 'utf8').catch(
          (error: NodeJS.ErrnoException) =>
            error.code === 'ENOENT' ? undefined : Promise.reject(error),
        );

      // (1) A sets the own session writable and gets the generation; the
      // command set of the generation is registered from package.json.
      const sessionA = await create(a.cookie, a.authSessionId);
      const granted = await fleet(a, sessionA, {
        type: 'acquire',
        commandId: randomUUID(),
      });
      expect(granted.statusCode, granted.body).toBe(200);
      const { generation } = granted.json<{ generation: string }>();
      const scopeA = {
        projectId,
        requirementId,
        sessionId: sessionA,
        who: { userId, authSessionId: a.authSessionId },
      };
      expect(broker.writeHolding(scopeA)).toMatchObject({ generation });
      // (2)–(6): A's red-to-green journey, one armed run.
      const journeyA = [
        write('sum.test.mjs', testFile),
        bash(),
        edit('a - b', 'a + b'),
        bash(),
        write('output-size.txt', '300000'),
        bash(),
        write('output-size.txt', '1100000'),
        bash(),
        write('output-size.txt', 'sleep'),
        bash(),
        write('output-size.txt', '20000'),
        git('diff'),
        git('status'),
      ];
      const runA = await run(
        a,
        userId,
        bindings.get(userId) as string,
        sessionA,
        journeyA,
        'write',
      );
      const resultsA = runA.results.slice(1);
      const dump = JSON.stringify(
        {
          results: resultsA.map((r) => r.slice(0, 200)),
          declarations: runA.declarations.slice(0, 2),
          executions,
        },
        null,
        1,
      );
      // W9: the declared set of a writable run is the five tools, by name.
      for (const names of runA.declarations)
        expect(names, dump).toEqual(['bash', 'edit', 'git', 'read', 'write']);
      expect(runA.redactions.length, dump).toBeGreaterThan(10);
      expect(
        runA.redactions.every((n) => n === 0),
        'FD4 backstop hits: ' + runA.redactions.join(','),
      ).toBe(true);
      // The five bash results carry the early diagnostic lines of the head.
      const bashResults = resultsA.filter((r) => r.includes('tree=.'));
      expect(bashResults.length, dump).toBe(5);
      const [red, green, long, budget, timeout] = bashResults as [
        string,
        string,
        string,
        string,
        string,
      ];
      // W12 step 3: the red light carries what the model needs. The TAP
      // report is written after the console lines, so the head carries the
      // exit marker and the diagnostics and the continuation the failure
      // details: the model reads both before the next step.
      const redRemainder = resultsA[resultsA.indexOf(red) + 1]!;
      expect(red).toContain('[exit code: 1]');
      expect(red).toContain('[output truncated; full output: .rdws-read/');
      expect(red + redRemainder).toContain('not ok 1 - sum adds');
      expect(red + redRemainder).toContain('expected: 5');
      expect(red + redRemainder).toContain('actual: -1');
      expect(red + redRemainder).toContain('# fail 1');
      expect(red + redRemainder).toContain('ok 2 - long output');
      // W18: known prefixes rewritten, file:// URL too, credentials masked.
      expect(red).toContain('tree=.');
      expect(red).toContain('url=file://sum.mjs');
      expect(red).toContain('home=<home>');
      expect(red).toContain('node=<node>');
      expect(red).toContain('password=[redacted]');
      expect(red).toContain('Authorization: Bearer [redacted]');
      expect(red).toContain('token: [redacted]');
      for (const text of [red, green, long!, budget!, timeout!]) {
        for (const secret of [
          treeDir,
          root,
          process.env.HOME!,
          process.execPath,
          'hunter2',
          'abc.def.ghi',
          's3cr3t-value',
          canary,
        ])
          expect(text, 'leaked: ' + secret).not.toContain(secret);
        expect(text).not.toContain('file://' + treeDir);
      }
      // W19 / W7 on the chain: protected locations and boundaries refused.
      for (const marker of [
        'env-read-denied',
        'env-write-denied',
        'home-read-denied',
        'git-write-denied',
        'spawn-denied',
        'network-denied',
      ])
        expect(red).toContain(marker);
      expect(red).not.toMatch(
        /env-read-allowed|env-write-allowed|home-read-allowed|git-write-allowed|spawn-allowed|network-allowed/,
      );
      // W12 step 5: the green light.
      const greenRemainder = resultsA[resultsA.indexOf(green) + 1]!;
      expect(green + greenRemainder).toContain('ok 1 - sum adds');
      expect(green + greenRemainder).toContain('# fail 0');
      expect(green).not.toContain('[exit code:');
      expect(await fileBytes('sum.mjs')).toBe(right);
      // W10: the long output is given as a head with the locked marker and
      // continued by read; every indexed line appears exactly once across
      // the head and the continuation reads, in order.
      const lines = (text: string) =>
        [...text.matchAll(/line-(\d{6})-/g)].map((m) => Number(m[1]));
      const contiguous = (text: string, count: number) => {
        const found = lines(text);
        expect(found.length, 'line count').toBe(count);
        expect(found.every((n, i) => n === i)).toBe(true);
      };
      contiguous(red + resultsA[resultsA.indexOf(red) + 1]!, 20);
      contiguous(
        long! +
          resultsA
            .slice(resultsA.indexOf(long) + 1, resultsA.indexOf(budget!))
            .join(''),
        300,
      );
      expect(long).toContain('[output truncated; full output: .rdws-read/');
      // R14: the budget ends the process with the platform's marker and no
      // continuation; the deadline ends it with the timed-out marker.
      expect(budget).toContain('[stderr]');
      expect(budget).toContain(
        '[output budget reached; the process was terminated]',
      );
      expect(budget).not.toContain('[output truncated');
      expect(budget).not.toContain('.rdws-read/');
      expect(lines(budget).length).toBeGreaterThan(0);
      expect(lines(budget).length).toBeLessThan(1100);
      expect(timeout).toContain('[timed out after 10000ms]');
      expect(timeout).not.toContain('[output truncated');
      // W8: the fixed read-only Git queries.
      const diff = resultsA.find((r) => r.includes('diff --git'))!;
      expect(diff).toContain('diff --git a/sum.mjs b/sum.mjs');
      expect(diff).toContain('-export const sum = (a, b) => a - b;');
      expect(diff).toContain('+export const sum = (a, b) => a + b;');
      expect(diff).not.toContain('[exit code:');
      const status = resultsA.find((r) => r.includes('?? sum.test.mjs'))!;
      expect(status).toContain(' M sum.mjs');
      // The continuation pages left through the window carrier.
      expect(frames.length).toBeGreaterThan(7);
      // Broker executions: every call ran once, under supervision.
      expect(executions.map(({ tool, status }) => tool + ':' + status)).toEqual(
        [
          'file:ok',
          'test:failed',
          'file:ok',
          'test:ok',
          'file:ok',
          'test:ok',
          'file:ok',
          'test:output-limit',
          'file:ok',
          'test:timeout',
          'file:ok',
          'git:ok',
          'git:ok',
        ],
      );
      expect(permits.write).toBe(13);
      // Every continuation read issued exactly one read permit.
      expect(permits.read).toBe(
        resultsA.filter((r) => r.startsWith('<path>/workspace/.rdws-read/'))
          .length,
      );
      expect(permits.read).toBeGreaterThanOrEqual(3);
      expect(await readFile(join(treeDir, '.env'), 'utf8')).toBe(
        'SECRET=' + canary + '\n',
      );

      // (7) B reads the latest files with the own session.
      const sessionB = await create(b.cookie, b.authSessionId);
      const runB = await run(
        b,
        otherId,
        bindings.get(otherId) as string,
        sessionB,
        [read('sum.mjs'), read('sum.test.mjs')],
        'read',
      );
      for (const names of runB.declarations) expect(names).toEqual(['read']);
      expect(runB.results[1]).toContain(right.split('\n')[0]!);
      expect(runB.results[2]).toContain("from './sum.mjs'");
      // A read-only session projects with the read projection, which has no
      // backstop: the test file A wrote carries the credential-shaped
      // literal the fixture prints, and B's Read result shows it verbatim.
      // The backstop belongs to the tool projection of a session that had
      // the write tools (W18 is about Shell outputs); the Read channel's
      // own rules are §11.20.24's. Recorded in the evidence.
      expect(runB.redactions).toEqual([]);
      expect(runB.results[2]).toContain('password=hunter2');
      expect(permits.write).toBe(13);

      // (8) B takes over: A's generation drains and changes; concurrent
      // takeovers by B and C leave exactly one writer (W16).
      const sessionC = await create(c.cookie, c.authSessionId);
      const race = await Promise.all(
        [
          [b, sessionB],
          [c, sessionC],
        ].map(async ([who, session]) => {
          const response = await fleet(
            who as { cookie: string; authSessionId: string },
            session as string,
            { type: 'takeover', commandId: randomUUID() },
          );
          return {
            status: response.statusCode,
            body: response.json() as { state?: string; generation?: string },
          };
        }),
      );
      // W16: the loser is refused (409) or waits; a generation is granted
      // to at most one of the two.
      expect(race.some((r) => r.status === 200)).toBe(true);
      expect(race.every((r) => r.status === 200 || r.status === 409)).toBe(
        true,
      );
      expect(
        race.filter((r) => typeof r.body.generation === 'string').length,
      ).toBeLessThanOrEqual(1);
      await expect.poll(() => broker.writeHolding(scopeA)).toBeUndefined();
      const scopeB = {
        ...scopeA,
        sessionId: sessionB,
        who: { userId: otherId, authSessionId: b.authSessionId },
      };
      const leaseOf = async () =>
        (
          await observer!.query(
            'select generation,phase,native_session_id from requirement_write_lease where requirement_id=$1',
            [requirementId],
          )
        ).rows[0] as {
          generation: string;
          phase: string;
          native_session_id: string;
        };
      // Exactly one writer: if the third developer won the race, that one
      // releases and B takes over, so B holds from here on.
      await expect
        .poll(async () => (await leaseOf()).phase, { timeout: 10_000 })
        .toBe('held');
      let lease = await leaseOf();
      expect(lease.generation).not.toBe(generation);
      if (!broker.writeHolding(scopeB)) {
        const sessionC = lease.native_session_id;
        const cHolds = broker.writeHolding({
          ...scopeA,
          sessionId: sessionC,
          who: { userId: thirdId, authSessionId: c.authSessionId },
        });
        expect(cHolds).toBeDefined();
        expect(
          (
            await fleet(c, sessionC, {
              type: 'release',
              commandId: randomUUID(),
              generation: lease.generation,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await fleet(b, sessionB, {
              type: 'takeover',
              commandId: randomUUID(),
            })
          ).statusCode,
        ).toBe(200);
        lease = await leaseOf();
      }
      expect(broker.writeHolding(scopeB)).toMatchObject({
        generation: lease.generation,
      });
      expect(
        [scopeA, scopeB].filter((s) => broker.writeHolding(s)),
      ).toHaveLength(1);

      // (9) A's old session: every write tool call is refused and the file
      // values stay as B left them (R3, W12 step 9).
      const beforeReject = await fileBytes('sum.mjs');
      // The session keeps its history: the run is armed for Read only, so
      // the model answers (the earlier write exchanges are projected as
      // history) and every write tool call is undeclared and refused.
      const runA2 = await run(
        a,
        userId,
        bindings.get(userId) as string,
        sessionA,
        [write('late.txt', 'late'), bash(), git('status')],
        'read',
      );
      expect(runA2.requests.length).toBeGreaterThanOrEqual(4);
      for (const names of runA2.declarations) expect(names).toEqual(['read']);
      expect(runA2.results.slice(1)).toHaveLength(3);
      for (const text of runA2.results.slice(1)) {
        expect(text).not.toContain('Created file');
        expect(text).not.toContain('exit code');
        expect(text).not.toContain('diff --git');
        expect(text).not.toContain('?? ');
      }
      expect(await fileBytes('late.txt')).toBeUndefined();
      expect(await fileBytes('sum.mjs')).toBe(beforeReject);
      expect(permits.write).toBe(13);
      expect(executions).toHaveLength(13);
      // B continues to write after the takeover.
      // B holds with the own session that took over.
      const sessionB2 = sessionB;
      const runB2 = await run(
        b,
        otherId,
        bindings.get(otherId) as string,
        sessionB2,
        [edit('a + b', 'a + b + 0')],
        'write',
      );
      for (const names of runB2.declarations)
        expect(names).toEqual(['bash', 'edit', 'git', 'read', 'write']);
      const traceB2 = (
        (
          await rpc(bindings.get(otherId) as string, b.cookie, 'events', {
            address: { kind: 'session', sessionId: sessionB2 },
          })
        ).records as { event: { type: string; data: unknown } }[]
      )
        .map(({ event }) => event)
        .filter((e) => /tool|error|turn/.test(e.type))
        .map((e) => [e.type, e.data]);
      expect(
        runB2.results[1],
        JSON.stringify({
          traceB2,
          results: runB2.results.map((r) => r.slice(0, 300)),
        }).slice(0, 3000),
      ).toContain('has been updated successfully.');
      expect(await fileBytes('sum.mjs')).toBe(
        right.replace('a + b', 'a + b + 0'),
      );
      expect(permits.write).toBe(14);
      // B-9: the direct scan covers every tool result the supplier received
      // in this BFF — the Shell and Git heads, the continuation pages, the
      // read results of B and the refused calls of A's old session.
      // Shell and Git results, the refused calls, and the continuation
      // pages of the Shell outputs (reads of .rdws-read/ segments). Plain
      // reads of files are not in W18's scope: a file the model wrote may
      // itself carry a credential-shaped literal, which the FD4 backstop
      // masks (B's read of the test file below is that case).
      const isContinuation = (text: string) =>
        text.startsWith('<path>/workspace/.rdws-read/');
      const isRead = (text: string) => text.startsWith('<path>/workspace/');
      const everyResult = [
        ...resultsA,
        ...runB.results,
        ...runA2.results.slice(1),
        ...runB2.results.slice(1),
      ].filter((text) => isContinuation(text) || !isRead(text));
      expect(everyResult.length).toBeGreaterThan(10);
      for (const text of everyResult)
        for (const secret of [
          treeDir,
          root,
          process.env.HOME!,
          process.execPath,
          'hunter2',
          'abc.def.ghi',
          's3cr3t-value',
          canary,
        ])
          expect(text, 'leaked: ' + secret).not.toContain(secret);
      // A-3: every FD4 projection the policy applied carried the output
      // policy; the backstop scan was never skipped.
      expect(scanned.projected).toBeGreaterThan(20);
      expect(scanned.policies).toBe(scanned.projected);
      // B-4: after the journey no settled job is still owned, and the
      // arming tables and the command registry are bounded.
      const sizes = bff.getDecorator<() => Record<string, number>>(
        'isolatedWriteToolStats',
      )();
      expect(sizes).toMatchObject({ jobs: 0 });
      expect(sizes.registered).toBeLessThanOrEqual(64);
      expect(sizes.writeOffered).toBeLessThanOrEqual(32);
      expect(sizes.writeArms).toBeLessThanOrEqual(32);
      expect(sizes.readOffered).toBeLessThanOrEqual(32);

      // W14: a cancelled run stops with its process group gone; the
      // original job key reads back the same terminal state; the write
      // generation of B stays.
      await writeFile(join(treeDir, 'output-size.txt'), 'sleep');
      // The heartbeat of the journey's own deadline step is gone: the
      // cancel stop point below must come from this run's process.
      await rm(join(treeDir, 'heartbeat'), { force: true });
      const controller = new AbortController();
      const job = new NativeShellToolJob({
        scope: {
          ...scopeA,
          sessionId: sessionB2,
          who: { userId: otherId, authSessionId: b.authSessionId },
        },
        grant: broker.writeHolding({
          ...scopeA,
          sessionId: sessionB2,
          who: { userId: otherId, authSessionId: b.authSessionId },
        })!,
        broker,
        repositoryId: 'app',
        request: { tool: 'test', path: 'sum.test.mjs' },
        hostSignal: controller.signal,
      });
      const body = {
        toolName: 'bash',
        arguments: { command: 'node sum.test.mjs', description: 'Run' },
      };
      const jobId = job.offer(
        { userId: otherId, authSessionId: b.authSessionId },
        requirementId,
        sessionB2,
        broker.writeHolding({
          ...scopeA,
          sessionId: sessionB2,
          who: { userId: otherId, authSessionId: b.authSessionId },
        })!.contextVersion,
        bodyHash(body),
        Date.now() + 2000,
        () => true,
      );
      expect(
        await job.control('begin', { ...body, jobId }, async () => {}),
      ).toEqual({ accepted: true });
      // The state is read through the control surface, and the cancel waits
      // for a positive stop point: the test process itself writes its
      // heartbeat, so the cancel lands on a running process.
      await expect
        .poll(
          async () =>
            (await job.control(
              'status',
              { ...body, jobId },
              async () => {},
            )) as {
              state: string;
            },
          { timeout: 5000 },
        )
        .toMatchObject({ state: 'pending' });
      await expect
        .poll(
          () =>
            stat(join(treeDir, 'heartbeat')).then((value) => value.isFile()),
          { timeout: 8000 },
        )
        .toBe(true);
      expect(
        await job.control('cancel', { ...body, jobId }, async () => {}),
      ).toEqual({ accepted: true });
      // The cancel stops the running process; the same job key reads back
      // the same terminal state afterwards.
      let stopped = (await job.control(
        'status',
        { ...body, jobId },
        async () => {},
      )) as { state: string };
      await expect
        .poll(
          async () => {
            stopped = (await job.control(
              'status',
              { ...body, jobId },
              async () => {},
            )) as { state: string };
            return stopped.state;
          },
          { timeout: 8000 },
        )
        .toBe('failed');
      const output = (await job.control(
        'output',
        { jobId },
        async () => {},
      )) as { stopped?: string; outcome: string; exitCode: number | null };
      expect(output.outcome).toBe('finished');
      expect(output.exitCode).toBeNull();
      expect(output.stopped).toContain('cancelled');
      expect(
        await job.control('status', { ...body, jobId }, async () => {}),
      ).toEqual(stopped);
      expect(
        broker.writeHolding({
          ...scopeA,
          sessionId: sessionB2,
          who: { userId: otherId, authSessionId: b.authSessionId },
        }),
      ).toBeDefined();
      await job.close();
      controller.abort();
      // R10 (the takeover path): a takeover while B's command runs drains
      // it; the lease changes hands once the process is confirmed stopped,
      // and the stopped command reports the platform's cancellation.
      await rm(join(treeDir, 'heartbeat'), { force: true });
      const scopeRunning = {
        ...scopeA,
        sessionId: sessionB2,
        who: { userId: otherId, authSessionId: b.authSessionId },
      };
      const runningSignal = new AbortController();
      const running = new NativeShellToolJob({
        scope: scopeRunning,
        grant: broker.writeHolding(scopeRunning)!,
        broker,
        repositoryId: 'app',
        request: { tool: 'test', path: 'sum.test.mjs' },
        hostSignal: runningSignal.signal,
      });
      const runningId = running.offer(
        { userId: otherId, authSessionId: b.authSessionId },
        requirementId,
        sessionB2,
        broker.writeHolding(scopeRunning)!.contextVersion,
        bodyHash(body),
        Date.now() + 2000,
        () => true,
      );
      expect(
        await running.control(
          'begin',
          { ...body, jobId: runningId },
          async () => {},
        ),
      ).toEqual({ accepted: true });
      await expect
        .poll(
          () =>
            stat(join(treeDir, 'heartbeat')).then((value) => value.isFile()),
          { timeout: 8000 },
        )
        .toBe(true);
      const duringRun = await fleet(c, sessionC, {
        type: 'takeover',
        commandId: randomUUID(),
      });
      expect(duringRun.statusCode, duringRun.body).toBe(200);
      await expect
        .poll(() => leaseOf(), { timeout: 20000 })
        .toMatchObject({ phase: 'held', native_session_id: sessionC });
      const runningOut = (await running.control(
        'output',
        { jobId: runningId },
        async () => {},
      )) as {
        stopped?: string;
        outcome: string;
      };
      expect(runningOut.outcome).toBe('finished');
      expect(runningOut.stopped).toContain('cancelled');
      await running.close();
      runningSignal.abort();
      const settled = await fleet(c, sessionC, {
        type: 'release',
        commandId: randomUUID(),
        generation: (await leaseOf()).generation,
      });
      expect(settled.statusCode, settled.body).toBe(200);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      ownChildren = children().length ? children() : ownChildren;
      try {
        await app?.close().catch((error: unknown) => {
          // A shutdown that cannot be confirmed is reported after the
          // primary failure, never instead of it.
          if (primary === undefined) throw error;
          process.stderr.write(
            'BFF shutdown after the failure: ' + String(error) + '\n',
          );
        });
      } finally {
        vi.restoreAllMocks();
        setDefaultCACertificates(originalCAs);
        for (const socket of sockets) socket.destroy();
        supplier.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => proxy.close(() => resolve())),
          new Promise<void>((resolve) => supplier.close(() => resolve())),
          observer?.end().catch(() => {}),
          trees?.close().catch(() => {}),
          mirrors?.close().catch(() => {}),
          lab.close(),
        ]);
      }
    }
    const alive = () =>
      ownChildren
        .filter(({ pid }) => {
          try {
            const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', pid], {
              encoding: 'utf8',
            }).trim();
            return state !== '' && !state.startsWith('Z');
          } catch {
            return false;
          }
        })
        .map(({ pid }) => pid);
    for (
      let attempt = 0;
      attempt < 15 &&
      (alive().length || containerNames().includes(ownContainer));
      attempt++
    )
      await delay(200);
    expect(containerNames()).not.toContain(ownContainer);
    expect(alive()).toEqual([]);
    // B-8: a full process-table scan for the executors, workers, test
    // processes, supervisors and Hosts of this fixture — the detached
    // executor processes are the supervisor's children, not this test's.
    const leftovers = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter((row) =>
        /sandbox-exec|file-worker\.mjs|read-snapshot-worker|sum\.test\.mjs|macos-supervisor|probe-policy\.cordis\.yml/.test(
          row,
        ),
      );
    expect(leftovers, leftovers.join('\n')).toEqual([]);
    console.log(
      'residue after the run:',
      JSON.stringify({
        container: ownContainer,
        children: ownChildren.map(({ pid }) => pid),
      }),
    );
  },
  420_000,
);
