import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { NativeWriteToolJob } from '../../apps/server/src/modules/native-write-tool-job.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

// §11.20.27 A segment: the eight-hop Write and Edit loopback on the isolated
// supervised assembly — one-shot managed PostgreSQL, the real locked Native
// Host with the Write probe behind a real Workbench Prompt (real HTTP
// sign-in), the Broker, the T06 file worker under Seatbelt, a loopback TLS
// 1.3 synthetic supplier behind an independent TCP observer.
//   (1) the supplier returns exactly one call per step; (2) the armed run
//   of the session that holds the write generation declares read, edit and
//   write; (3) each write call requests its single-use permit over FD3,
//   bound to the generation; (4) begin drives the Broker execution; the
//   worker emits its two receipts, the parent derives the after bytes and
//   judges; (5) the Host provider takes the output over FD3 and the locked
//   tool renders its confirmation; (6) the next model request with that
//   result is the FD4 first write (existing mechanism) after the tool
//   projection accepted the body; (7) the supplier receives every step.
afterEach(() => vi.unstubAllEnvs());

type Message = { role: string; tool_call_id?: string; content: unknown };
type RequestBody = {
  messages: Message[];
  tools?: { function: { name: string } }[];
};
type Event = {
  type: string;
  seq: number;
  data: {
    reason?: { kind: string };
    name?: string;
    callId?: string;
    message?: { toolCallId: string; isError?: boolean; content: unknown };
  };
};
type Step = { name: 'write' | 'edit' | 'read'; args: Record<string, unknown> };
type Script = Step[];

const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

test.skipIf(process.platform !== 'darwin')(
  '§11.20.27 the locked Native write and edit complete the loopback under supervision on the isolated assembly',
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
    const model = 'write-loopback';
    const requirementId = randomUUID();
    const userId = randomUUID();
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const header = 'write-loopback-fixture';
    const first = 'export const greet = (name) => "Hello " + name;\n';
    const edited = first.replace('Hello', 'Goodbye');
    expect(edited).not.toBe(first);
    // The journey of the armed run: create, edit, read back.
    const journey: Script = [
      { name: 'write', args: { file_path: 'greet.mjs', content: first } },
      {
        name: 'edit',
        args: {
          file_path: 'greet.mjs',
          old_string: 'Hello',
          new_string: 'Goodbye',
        },
      },
      { name: 'read', args: { file_path: 'greet.mjs' } },
    ];
    // A session without the write generation: the supplier still returns a
    // write call (R1); the run declares nothing and the root guard denies.
    const foreign: Script = [
      { name: 'write', args: { file_path: 'stolen.mjs', content: 'x' } },
    ];

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

    // The trusted-side script: which steps a session runs, in order.
    const scripts = new Map<string, Script>();
    const declarations: string[][] = [];
    const results: string[][] = [];
    const director = {
      respond(input: RequestBody) {
        // The script of a run is chosen by the session its Prompt names.
        const sessionId = [...scripts.keys()].find((key) =>
          input.messages.some(
            ({ role, content }) =>
              role === 'user' &&
              typeof content === 'string' &&
              content.startsWith(key + ':'),
          ),
        );
        if (!sessionId) throw new Error('No script for this run');
        declarations.push(
          (input.tools ?? []).map(({ function: spec }) => spec.name),
        );
        const toolMessages = input.messages.filter(
          ({ role }) => role === 'tool',
        );
        results.push(toolMessages.map(({ content }) => String(content)));
        const script = scripts.get(sessionId)!;
        if (!(input.tools ?? []).length)
          return {
            role: 'assistant',
            content: 'Write loopback: no tool declared',
          };
        const step = script[toolMessages.length];
        if (!step)
          return { role: 'assistant', content: 'Write loopback finished' };
        return {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-' + step.name + '-' + toolMessages.length,
              type: 'function',
              function: {
                name: step.name,
                arguments: JSON.stringify(step.args),
              },
            },
          ],
        };
      },
    };
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
              response.end('write-loopback-ok');
              return;
            }
            const input = JSON.parse(body.toString()) as RequestBody;
            requests.push(input);
            const delta = director.respond(input);
            const frame = {
              id: 'write-loopback',
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
      await writeFile(
        join(source.work, 'package.json'),
        JSON.stringify({
          name: 'write-loopback',
          scripts: { test: 'node greet.test.mjs' },
        }),
      );
      await writeFile(join(source.work, 'sample.txt'), 'frozen baseline\n');
      await fixtureGit([
        '-C',
        source.work,
        'add',
        '--',
        'package.json',
        'sample.txt',
      ]);
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
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { WRITE_LOOPBACK: 'synthetic-only' },
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
                  apiKeyEnv: 'WRITE_LOOPBACK',
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
        "insert into project(id,name) values('poc','Write loopback project')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Dev','dev@fixture.invalid','write_loopback',true,false)",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Write loopback','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
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
          writeTools: { repositoryId: 'app' },
        },
      });
      app = bff;
      await bff.ready();
      const broker = bff.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )()!;
      // Every write permit is issued exactly once at the parent: count the
      // issuer's requests and grants directly, and every Broker execution.
      const permits = { requests: 0, granted: 0 };
      const runsPrototype = (
        await import('../../apps/server/src/modules/runtime-context.ts')
      ).ContextRuns.prototype as unknown as Record<
        string,
        (this: unknown, ...args: unknown[]) => unknown
      >;
      const authorizeWriteTool = runsPrototype.authorizeWriteTool!;
      runsPrototype.authorizeWriteTool = function (
        this: unknown,
        ...args: unknown[]
      ) {
        permits.requests++;
        return Promise.resolve(
          Reflect.apply(authorizeWriteTool, this, args),
        ).then((result: unknown) => {
          if (result && typeof result === 'object' && 'digest' in result)
            permits.granted++;
          return result;
        });
      };
      const executions: { status: string; exitCode: number | null }[] = [];
      const execute = broker.execute;
      vi.spyOn(broker, 'execute').mockImplementation((...args) => {
        return execute.apply(broker, args).then((receipt) => {
          if (receipt.status === 'finished')
            executions.push({
              status: receipt.result.status,
              exitCode: receipt.result.exitCode,
            });
          return receipt;
        });
      });
      const signin = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        remoteAddress: '192.0.2.210',
        headers: { origin },
        payload: { username: 'write_loopback', password },
      });
      expect(signin.statusCode, signin.body).toBe(200);
      const cookie = signin.cookies
        .map(({ name, value }) => name + '=' + value)
        .join('; ');
      const authSessionId = await observedLogin(bff, cookie);
      const binding = await bootstrapNative(bff, cookie, requirementId);
      ownChildren = children();
      async function create() {
        const response = await bff.inject({
          method: 'POST',
          url: '/api/requirements/' + requirementId + '/sessions',
          headers: { cookie, origin, 'x-rdws-edit-session': authSessionId },
          payload: { commandId: randomUUID() },
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ sessionId: string }>().sessionId;
      }
      async function rpc(method: string, request: object) {
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
      const traceOf = async (sessionId: string) =>
        (
          (await rpc('events', { address: { kind: 'session', sessionId } }))
            .records as { event: Event }[]
        ).map(({ event }) => event);
      const finished = async (sessionId: string) =>
        (await traceOf(sessionId)).find(({ type }) => type === 'turn/end')?.data
          .reason?.kind;
      const prompt = (sessionId: string, requestId: string) =>
        rpc('prompt', {
          sessionId,
          mode: 'queue',
          requestId,
          content: [
            {
              type: 'text',
              text: sessionId + ': run the write loopback script',
            },
          ],
        });
      const treeDir = (
        await trees!.executionScope(projectId, requirementId, plan, 'app')
      ).tree;
      const fileBytes = async (name: string) =>
        readFile(join(treeDir, name), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          },
        );

      // R1 / W2: a session without the write generation. The supplier
      // returns a write call; nothing is declared, nothing is permitted,
      // nothing is executed and no file appears.
      const outsider = await create();
      scripts.set(outsider, foreign);
      await prompt(outsider, randomUUID());
      // The run ends (the undeclared call is refused); the evidence is
      // that nothing was declared, permitted, executed or written.
      await expect
        .poll(() => finished(outsider), { timeout: 30_000 })
        .toBeTruthy();
      expect(declarations[0]).toEqual([]);
      expect(permits).toEqual({ requests: 0, granted: 0 });
      expect(executions).toEqual([]);
      expect(await fileBytes('stolen.mjs')).toBeUndefined();

      // The writable session: acquire the write generation through the
      // fleet command, then arm one Prompt request for the run.
      const sessionId = await create();
      const acquire = await bff.inject({
        method: 'POST',
        url:
          '/api/requirements/' +
          requirementId +
          '/sessions/' +
          sessionId +
          '/write-authority/commands',
        headers: { cookie, origin, 'x-rdws-edit-session': authSessionId },
        payload: { type: 'acquire', commandId: randomUUID() },
      });
      expect(acquire.statusCode, acquire.body).toBe(200);
      const { generation } = acquire.json<{ generation: string }>();
      scripts.set(sessionId, journey);
      const requestId = randomUUID();
      bff.getDecorator<(input: { scope: object; requestId: string }) => void>(
        'armIsolatedReadTool',
      )({
        scope: {
          who: { userId, authSessionId },
          projectId,
          requirementId,
          sessionId,
        },
        requestId,
      });
      bff.getDecorator<
        (input: {
          scope: object;
          requestId: string;
          repositoryId: string;
        }) => void
      >('armIsolatedWriteTools')({
        scope: {
          who: { userId, authSessionId },
          projectId,
          requirementId,
          sessionId,
        },
        requestId,
        repositoryId: 'app',
      });
      const before = requests.length;
      await prompt(sessionId, requestId);
      await expect
        .poll(() => finished(sessionId), { timeout: 90_000 })
        .toBeTruthy();
      const trace = await traceOf(sessionId);
      const dump = JSON.stringify(
        {
          declarations,
          results,
          events: trace
            .filter(({ type }) => /tool|error|turn/.test(type))
            .map(({ type, data }) => [type, data]),
        },
        null,
        1,
      );
      expect(trace.at(-1)?.data.reason?.kind, dump).toBe('completed');
      const runRequests = requests.slice(before);
      // W9 / hop 2: the declared set of the armed run is exactly edit, read
      // and write (the Host serializes by name), the same order on every
      // request of the run.
      const armed = runRequests.filter(
        (input) => (input.tools ?? []).length > 0,
      );
      expect(armed.length).toBe(4);
      for (const input of armed)
        expect(input.tools!.map(({ function: spec }) => spec.name)).toEqual([
          'edit',
          'read',
          'write',
        ]);
      expect(declarations.slice(1, 2)).toEqual([['edit', 'read', 'write']]);
      // W1 / hop 3: one permit per write call, each granted exactly once;
      // the read keeps its own permit.
      expect(permits).toEqual({ requests: 2, granted: 2 });
      // Hop 4: two Broker executions, both finished and ok, under the
      // supervision of the assembly (the proof is in every receipt).
      expect(executions).toEqual([
        { status: 'ok', exitCode: 0 },
        { status: 'ok', exitCode: 0 },
      ]);
      const receipts = (
        await observer!.query(
          "select result from command_receipt where scope=$1 and operation='write.execute' order by digest",
          ['requirement:' + requirementId],
        )
      ).rows as { result: { status: string; proof?: unknown } }[];
      expect(receipts).toHaveLength(2);
      for (const { result } of receipts)
        expect(result).toMatchObject({
          status: 'finished',
          proof: { stage: 'armed' },
        });
      // W5: the file bytes equal the call arguments, byte for byte.
      const bytes = await readFile(join(treeDir, 'greet.mjs'));
      expect(bytes.toString('utf8')).toBe(edited);
      expect(sha(bytes)).toBe(sha(edited));
      // Hop 5 / (7): the locked confirmations the model saw, without any
      // file body; then the read shows the edited text.
      // The last request of the run carries every result in order.
      const toolResults = (
        runRequests.at(-1)!.messages as { role: string; content: unknown }[]
      )
        .filter(({ role }) => role === 'tool')
        .map(({ content }) => String(content));
      expect(toolResults).toHaveLength(3);
      expect(toolResults.slice(0, 1)).toEqual([
        '<path>/workspace/greet.mjs</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
      ]);
      expect(toolResults.slice(1, 2)).toEqual([
        'The file /workspace/greet.mjs has been updated successfully.',
      ]);
      expect(toolResults[2]).toContain('Goodbye');
      expect(toolResults[2]).not.toContain('Hello');
      // The tool exchange is one call with its own adjacent result.
      for (const input of runRequests) {
        const messages = input.messages;
        messages.forEach((message, index) => {
          if (message.role === 'tool') {
            const previous = messages[index - 1]!;
            expect(previous.role).toBe('assistant');
            expect(
              (previous as { tool_calls?: { id: string }[] }).tool_calls?.[0]
                ?.id,
            ).toBe(message.tool_call_id);
          }
        });
      }
      // The write generation is still the one acquired; the command set
      // of the generation was registered from package.json (W6).
      const scope = {
        projectId,
        requirementId,
        sessionId,
        who: { userId, authSessionId },
      };
      const holding = broker.writeHolding(scope)!;
      expect(holding).toMatchObject({ generation });
      const fleet = (payload: unknown) =>
        bff.inject({
          method: 'POST',
          url:
            '/api/requirements/' +
            requirementId +
            '/sessions/' +
            sessionId +
            '/write-authority/commands',
          headers: { cookie, origin, 'x-rdws-edit-session': authSessionId },
          payload: payload as never,
        });
      // R2: a permit is issued, then the write generation is gone (released
      // here; a takeover ends it the same way). The late begin is refused
      // with 409 and nothing starts; the file never appears.
      const controller = new AbortController();
      const late = new NativeWriteToolJob({
        scope,
        grant: holding,
        broker,
        repositoryId: 'app',
        request: {
          tool: 'file',
          operation: 'write',
          path: 'late.mjs',
          text: 'late',
          receipt: true,
        },
        hostSignal: controller.signal,
      });
      const beginBody = {
        toolName: 'write',
        arguments: { file_path: 'late.mjs', content: 'late' },
      };
      const jobId = late.offer(
        { userId, authSessionId },
        requirementId,
        sessionId,
        holding.contextVersion,
        bodyHash(beginBody),
        Date.now() + 2000,
        () => true,
      );
      expect(jobId).toEqual(expect.any(String));
      const released = await fleet({
        type: 'release',
        commandId: randomUUID(),
        generation,
      });
      expect(released.statusCode, released.body).toBe(200);
      expect(broker.writeHolding(scope)).toBeUndefined();
      const executionsBefore = executions.length;
      await expect(
        late.control('begin', { ...beginBody, jobId }, async () => {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(executions).toHaveLength(executionsBefore);
      expect(await fileBytes('late.mjs')).toBeUndefined();
      await late.close();
      controller.abort();
      // R3: the old session's new calls find no write generation; a new
      // acquisition is a new generation, the old one is never carried over.
      const again = await fleet({ type: 'acquire', commandId: randomUUID() });
      expect(again.statusCode, again.body).toBe(200);
      const next = again.json<{ generation: string }>();
      expect(next.generation).not.toBe(generation);
      expect(broker.writeHolding(scope)).toMatchObject({
        generation: next.generation,
      });
      // W4 on the write job: a wrong job key is refused, a cancel before
      // the start leaves zero executions, begin is accepted once and the
      // same job key reads back the same terminal state.
      const controllerJob = new AbortController();
      const controlled = new NativeWriteToolJob({
        scope,
        grant: broker.writeHolding(scope)!,
        broker,
        repositoryId: 'app',
        request: {
          tool: 'file',
          operation: 'write',
          path: 'w4.mjs',
          text: 'w4',
          receipt: true,
        },
        hostSignal: controllerJob.signal,
      });
      const w4Body = {
        toolName: 'write',
        arguments: { file_path: 'w4.mjs', content: 'w4' },
      };
      const w4Id = controlled.offer(
        { userId, authSessionId },
        requirementId,
        sessionId,
        broker.writeHolding(scope)!.contextVersion,
        bodyHash(w4Body),
        Date.now() + 2000,
        () => true,
      );
      const executionsAtW4 = executions.length;
      await expect(
        controlled.control(
          'begin',
          { ...w4Body, jobId: randomUUID() },
          async () => {},
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(
        await controlled.control(
          'cancel',
          { ...w4Body, jobId: w4Id },
          async () => {},
        ),
      ).toEqual({ accepted: true });
      // A begin after the cancel is acknowledged but never starts (the
      // same control semantics as the constant fixture job).
      expect(
        await controlled.control(
          'begin',
          { ...w4Body, jobId: w4Id },
          async () => {},
        ),
      ).toEqual({ accepted: true });
      expect(
        await controlled.control(
          'status',
          { ...w4Body, jobId: w4Id },
          async () => {},
        ),
      ).toEqual({ state: 'aborted' });
      expect(executions).toHaveLength(executionsAtW4);
      expect(await fileBytes('w4.mjs')).toBeUndefined();
      await controlled.close();
      controllerJob.abort();
      const appliedSignal = new AbortController();
      const applied = new NativeWriteToolJob({
        scope,
        grant: broker.writeHolding(scope)!,
        broker,
        repositoryId: 'app',
        request: {
          tool: 'file',
          operation: 'write',
          path: 'w4.mjs',
          text: 'w4',
          receipt: true,
        },
        hostSignal: appliedSignal.signal,
      });
      const appliedId = applied.offer(
        { userId, authSessionId },
        requirementId,
        sessionId,
        broker.writeHolding(scope)!.contextVersion,
        bodyHash(w4Body),
        Date.now() + 2000,
        () => true,
      );
      expect(
        await applied.control(
          'begin',
          { ...w4Body, jobId: appliedId },
          async () => {},
        ),
      ).toEqual({ accepted: true });
      expect(
        await applied.control(
          'begin',
          { ...w4Body, jobId: appliedId },
          async () => {},
        ),
      ).toEqual({ accepted: true });
      await expect
        .poll(() => applied.output().state, { timeout: 5_000 })
        .toBe('ok');
      expect(
        await applied.control(
          'status',
          { ...w4Body, jobId: appliedId },
          async () => {},
        ),
      ).toEqual({ state: 'ok' });
      expect(
        await applied.control(
          'status',
          { ...w4Body, jobId: appliedId },
          async () => {},
        ),
      ).toEqual({ state: 'ok' });
      expect(applied.output()).toMatchObject({
        outcome: 'applied',
        created: true,
      });
      expect(await fileBytes('w4.mjs')).toBe('w4');
      await applied.close();
      appliedSignal.abort();
      const settled = await fleet({
        type: 'release',
        commandId: randomUUID(),
        generation: next.generation,
      });
      expect(settled.statusCode, settled.body).toBe(200);
    } finally {
      ownChildren = children().length ? children() : ownChildren;
      try {
        await app?.close();
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
    console.log(
      'residue after the run:',
      JSON.stringify({
        container: ownContainer,
        children: ownChildren.map(({ pid }) => pid),
      }),
    );
  },
  240_000,
);
