import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { Client, Pool } from 'pg';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import { afterEach, expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';

// §11.20.26 B segment: the seven-hop Read loopback on the isolated assembly —
// one-shot managed PostgreSQL, the real locked Native Host behind a real
// Workbench Prompt (real HTTP sign-in), the T05 worktree with the Seatbelt
// reader, a loopback TLS 1.3 synthetic supplier behind an independent TCP
// observer and an independent PG observer connection.
//
// (1) the supplier returns exactly one read call per step; (2) the Read probe
// declares it for the armed run; (3) the Read-specific single-use permit is
// requested over FD3; (4) the parent Broker reads the worktree and every page
// leaves through the ReadsWindow with a certificate; (5) the native
// tool/result carries the page; (6) the next model request with that result
// is the FD4 first write (existing mechanism, unchanged); (7) the supplier
// receives both the page frames and the model requests.

afterEach(() => vi.unstubAllEnvs());

type Message = { role: string; tool_call_id?: string; content: unknown };
type RequestBody = {
  messages: Message[];
  tools?: { function: { name: string } }[];
};
type Event = {
  type: string;
  seq: number;
  sourceEventSeqs?: number[];
  data: {
    reason?: { kind: string };
    turn?: number;
    step?: number;
    callId?: string;
    message?: { toolCallId: string; isError?: boolean };
  };
};
type Case = {
  name: string;
  file: string;
  args?: Record<string, number>;
  // plain: one read. long: a long line continued through registered segments
  // until the locked read no longer truncates. never: a truncation that is
  // deliberately not continued (the native line offset cannot reach the
  // tail). error: an error result without any file body.
  kind: 'plain' | 'long' | 'never' | 'error';
  // The exact text the model must end up seeing (undefined for errors).
  expected?: string;
};

const marker = '... (line truncated to 2000 chars)';
const chars: [string, string][] = [
  ['b', '1'],
  ['\u00e9', '2'],
  ['\u20ac', '3'],
  ['\ud834\udd1e', '4'],
];
// The last kept character of the displayed prefix is an N-byte character.
const keep = ([char, tag]: [string, string]) =>
  'a'.repeat(2000 - char.length) + char + 'tail-keep-' + tag;
// The first dropped character after the 2000-unit cut is an N-byte one.
const drop = ([char, tag]: [string, string]) =>
  'a'.repeat(2000) + char + 'tail-drop-' + tag;
const surrogateLine = 'a'.repeat(1999) + '\ud834\udd1e' + 'tail-surrogate';
const crlfLine = 'a'.repeat(2000) + 'tail-crlf';
// More than one 16 KiB page remains after the cut.
const multiTail = 'x'.repeat(16 * 1024 + 300);
const multiLine = 'a'.repeat(2000) + multiTail;

// Strips the locked read's envelope: numbered lines only, footers dropped.
function numberedLines(result: unknown): string[] {
  const text =
    typeof result === 'string'
      ? result
      : Array.isArray(result)
        ? ((result[0] as { text?: string } | undefined)?.text ?? '')
        : '';
  const inner = /<content>\n([\s\S]*?)\n<\/content>/.exec(text)?.[1] ?? '';
  return inner
    .split('\n')
    .filter((row) => /^\d+: /.test(row))
    .map((row) => row.replace(/^\d+: /, ''));
}

// Inventory of the application role's write paths on the seven authority
// tables (plan point 2, by table): every captured write must land in a row.
const writeInventory: Record<string, RegExp[]> = {
  auth_user: [/^update "auth_user"/i, /^insert into "auth_user"/i],
  auth_session: [
    /^insert into "auth_session"/i,
    /^update "auth_session"/i,
    /^delete from "auth_session"/i,
  ],
  project_member: [],
  requirement_participant: [],
  native_session: [/^insert into "native_session"/i],
  requirement: [/^update "requirement"/i],
  requirement_worktree_plan: [/^insert into "requirement_worktree_plan"/i],
};
type CapturedWrite = { table: string; operation: string; query: string };
function outsideInventory(write: CapturedWrite) {
  const patterns = writeInventory[write.table];
  if (!patterns) return 'table not in the inventory';
  return patterns.some((pattern) => pattern.test(write.query))
    ? undefined
    : 'statement not in the inventory';
}

test.skipIf(process.platform !== 'darwin')(
  '§11.20.26 the locked Native read completes the seven-hop loopback on the isolated assembly',
  async () => {
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    // Precise residue tracking for this run: the container name the database
    // fixture reports and the child PIDs this process spawns (the Host and
    // its helpers); both are asserted gone after the finally below. No
    // prefix or substring matching of names or command lines.
    const containerNames = () =>
      execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    // Children of this process, listed without the probing ps itself (its
    // own pid is dropped): the Host is the one carrying the probe profile.
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
    const hostOf = (sample: Child[]) =>
      sample.find(({ command }) => command.includes('probe-policy.cordis.yml'))
        ?.pid;
    const lab = await authorityDatabase();
    const ownContainer = lab.containerName;
    expect(ownContainer).toMatch(/^rdws-authority-/);
    let ownChildren: Child[] = [];
    let hostPid: string | undefined;
    const projectId = 'poc';
    const provider = 'rdws-glm';
    const model = 'read-loopback';
    const requirementId = randomUUID();
    const userId = randomUUID();
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const header = 'read-loopback-fixture';
    // Lines stay under the locked read's 2000-unit line cap, so the whole
    // file is visible; sizes still cross the Broker's 16 KiB page boundary.
    const docText = ('boundary'.repeat(20) + '\n').repeat(23);
    const largeText = ('p'.repeat(99) + '\n').repeat(340);
    const lineRows = Array.from(
      { length: 260 },
      (_, index) => 'line ' + (index + 1) + ' \u00e9' + 'z'.repeat(90),
    );
    const linesText = lineRows.join('\n') + '\n';
    const cases: Case[] = [
      {
        name: 'single page',
        file: 'read-doc.txt',
        kind: 'plain',
        expected: docText.split('\n').slice(0, -1).join('\n'),
      },
      {
        name: 'two pages',
        file: 'read-large.txt',
        kind: 'plain',
        expected: largeText.split('\n').slice(0, -1).join('\n'),
      },
      {
        name: 'line continuation',
        file: 'read-lines.txt',
        kind: 'plain',
        args: { limit: 200 },
        expected: lineRows.slice(0, 200).join('\n'),
      },
      {
        name: 'offset continuation',
        file: 'read-lines.txt',
        kind: 'plain',
        args: { offset: 201 },
        expected: lineRows.slice(200).join('\n'),
      },
      ...chars.map(([char, tag]) => ({
        name: 'last kept character of ' + tag + ' bytes',
        file: 'read-keep-' + tag + '.txt',
        kind: 'long' as const,
        expected: keep([char, tag]),
      })),
      ...chars.map(([char, tag]) => ({
        name: 'first dropped character of ' + tag + ' bytes',
        file: 'read-drop-' + tag + '.txt',
        kind: 'long' as const,
        expected: drop([char, tag]),
      })),
      {
        name: 'surrogate pair split',
        file: 'read-surrogate.txt',
        kind: 'long',
        expected: surrogateLine,
      },
      {
        name: 'CRLF line',
        file: 'read-crlf.txt',
        kind: 'long',
        expected: crlfLine,
      },
      {
        name: 'segment across page boundaries',
        file: 'read-multi.txt',
        kind: 'long',
        expected: multiLine,
      },
      {
        name: 'native offset cannot reach the tail',
        file: 'read-drop-1.txt',
        kind: 'never',
        args: { offset: 1 },
      },
      { name: 'protected path', file: '.env', kind: 'error' },
      { name: 'over the snapshot limit', file: 'read-huge.txt', kind: 'error' },
    ];
    const files: Record<string, string> = {
      'read-doc.txt': docText,
      'read-large.txt': largeText,
      'read-lines.txt': linesText,
      '.env': 'SECRET=must-never-leave\n',
      'read-huge.txt': 'h'.repeat(256 * 1024 + 1),
      'read-surrogate.txt': surrogateLine + '\n',
      'read-crlf.txt': crlfLine + '\r\n',
      'read-multi.txt': multiLine + '\n',
    };
    for (const entry of chars) {
      files['read-keep-' + entry[1] + '.txt'] = keep(entry) + '\n';
      files['read-drop-' + entry[1] + '.txt'] = drop(entry) + '\n';
    }

    const requests: RequestBody[] = [];
    const frames: { attempt: string; body: Buffer }[] = [];
    const sockets = new Set<Socket>();
    const segments: {
      snapshotId: string;
      segment: string;
      from: number;
      through: number;
    }[] = [];
    const captured: CapturedWrite[] = [];
    const originalCAs = getCACertificates('default');
    let app: ReturnType<typeof buildApp> | undefined;
    let observer: Pool | undefined;
    let listener: Client | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    let broker: OwnedWriteHandoff | undefined;
    const counts = { stat: 0, pages: 0 };
    const keys = await modelTlsCertificate(lab.root);
    setDefaultCACertificates([...originalCAs, keys.cert.toString()]);

    const director = {
      index: -1,
      continuing: false,
      // Registrations that existed when the pending read was issued; the
      // registration the trusted side owes for that read comes after it.
      mark: 0,
      results: [] as string[][],
      framesAfter: [] as number[],
      declarations: [] as string[][],
      async respond(input: RequestBody, count: number) {
        this.declarations.push(
          (input.tools ?? []).map(({ function: spec }) => spec.name),
        );
        const results = input.messages.filter(({ role }) => role === 'tool');
        if (!(input.tools ?? []).length)
          return {
            role: 'assistant',
            content: 'Read loopback: no tool declared',
          };
        if (results.length === 0) {
          this.index = 0;
          this.continuing = false;
          return this.call(cases[0]!, count);
        }
        const last = results.at(-1)!;
        const current = cases[this.index]!;
        const rows = numberedLines(last.content);
        if (!this.continuing) {
          this.results[this.index] = [...rows];
          this.framesAfter[this.index] = frames.length;
        } else this.results[this.index]!.push(...rows);
        if (
          rows.length > 0 &&
          rows[0]!.endsWith(marker) &&
          current.kind === 'long'
        ) {
          this.continuing = true;
          const seen = this.mark;
          await vi.waitFor(
            () =>
              expect(
                segments.length,
                'segment registration for ' + current.name,
              ).toBeGreaterThan(seen),
            { timeout: 10_000, interval: 20 },
          );
          return this.call(
            { name: 'segment', file: segments.at(-1)!.segment, kind: 'long' },
            count,
          );
        }
        this.continuing = false;
        this.index++;
        if (this.index >= cases.length)
          return { role: 'assistant', content: 'Read loopback finished' };
        return this.call(cases[this.index]!, count);
      },
      call(item: Case, count: number) {
        // The registration owed for this read comes after its result.
        this.mark = segments.length;
        return {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-read-' + count,
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({
                  file_path: item.file,
                  ...(item.args ?? {}),
                }),
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
              // Hop 7: a page frame (header + body), never a model request.
              frames.push({
                attempt: String(request.headers['x-rdws-window-attempt'] ?? ''),
                body,
              });
              response.end('read-loopback-ok');
              return;
            }
            const input = JSON.parse(body.toString()) as RequestBody;
            const delta = await director.respond(input, requests.length);
            requests.push(input);
            const frame = {
              id: 'read-loopback',
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
    // Independent TCP observer between the BFF / Host and the supplier.
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
      for (const [name, text] of Object.entries(files))
        await writeFile(join(source.work, name), text);
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
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { READ_LOOPBACK: 'synthetic-only' },
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
                  apiKeyEnv: 'READ_LOOPBACK',
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
        "insert into project(id,name) values('poc','Read loopback project')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Reader','reader@fixture.invalid','read_loopback',true,false)",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'tester')",
        [userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Read loopback','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'tester')",
        [requirementId, userId],
      );
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [requirementId, JSON.stringify(plan)],
      );
      // Test-time capture of every write the run performs on the seven
      // authority tables: table, operation and the exact statement.
      await lab.admin
        .query(`create function public.rdws_test_capture() returns trigger as $$
        begin perform pg_notify('rdws_write_capture', tg_table_name || '|' || tg_op || '|' || left(current_query(), 300)); return null; end $$
        language plpgsql`);
      for (const table of Object.keys(writeInventory))
        await lab.admin.query(
          'create trigger rdws_test_capture after insert or update or delete on ' +
            table +
            ' for each row execute function public.rdws_test_capture()',
        );
      // A dedicated connection carries LISTEN / NOTIFY.
      listener = new Client({ connectionString: lab.databaseUrl });
      await listener.connect();
      await listener.query('listen rdws_write_capture');
      listener.on('notification', (notice) => {
        if (notice.channel !== 'rdws_write_capture' || !notice.payload) return;
        const [table, operation, query] = notice.payload.split('|');
        captured.push({
          table: table!,
          operation: operation!,
          query: query ?? '',
        });
      });

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
          readSnapshots: true,
          readTool: {
            window: {
              destination: baseURL + '/read-loopback',
              ca: keys.cert.toString('utf8'),
              header,
            },
            repositoryId: 'app',
          },
        },
      });
      app = bff;
      await bff.ready();
      broker = bff.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      const stat = broker.readWorktreeStat;
      const page = broker.readWorktree;
      vi.spyOn(broker, 'readWorktreeStat').mockImplementation((...args) => {
        counts.stat++;
        return stat.apply(broker, args);
      });
      vi.spyOn(broker, 'readWorktree').mockImplementation((...args) => {
        counts.pages++;
        return page.apply(broker, args);
      });
      const register = broker.readWorktreeSegment;

      vi.spyOn(broker, 'readWorktreeSegment').mockImplementation(
        async (...args) => {
          const value = await register.apply(broker, args);
          segments.push(value);
          return value;
        },
      );

      // Every read is permitted exactly once at the parent: count the Read
      // permit issuer's requests and grants directly.
      const permitCounts = { requests: 0, granted: 0 };
      const runsPrototype = (
        await import('../../apps/server/src/modules/runtime-context.ts')
      ).ContextRuns.prototype as unknown as Record<
        string,
        (this: unknown, ...args: unknown[]) => unknown
      >;
      const authorizeReadTool = runsPrototype.authorizeReadTool!;
      runsPrototype.authorizeReadTool = function (
        this: unknown,
        ...args: unknown[]
      ) {
        permitCounts.requests++;
        return Promise.resolve(
          Reflect.apply(authorizeReadTool, this, args),
        ).then((result: unknown) => {
          if (result && typeof result === 'object' && 'digest' in result)
            permitCounts.granted++;
          return result;
        });
      };
      const signin = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        remoteAddress: '192.0.2.210',
        headers: { origin },
        payload: { username: 'read_loopback', password },
      });
      expect(signin.statusCode, signin.body).toBe(200);
      const cookie = signin.cookies
        .map(({ name, value }) => name + '=' + value)
        .join('; ');
      const authSessionId = await observedLogin(bff, cookie);
      const binding = await bootstrapNative(bff, cookie, requirementId);
      // The Host starts lazily with the first request: sample once it is up.
      ownChildren = children();
      hostPid = hostOf(ownChildren);
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
      const finished = async (sessionId: string) =>
        (
          (await rpc('events', { address: { kind: 'session', sessionId } }))
            .records as { event: Event }[]
        )
          .map(({ event }) => event)
          .find(({ type }) => type === 'turn/end')?.data.reason?.kind;
      const prompt = (sessionId: string, requestId: string) =>
        rpc('prompt', {
          sessionId,
          mode: 'queue',
          requestId,
          content: [{ type: 'text', text: 'Read the loopback fixture files' }],
        });

      // L3 (unarmed): a session without an armed run declares no tool.
      const sibling = await create();
      await prompt(sibling, randomUUID());
      await expect
        .poll(() => finished(sibling), { timeout: 30_000 })
        .toBe('completed');
      expect(director.declarations).toEqual([[]]);
      expect(requests[0]!.tools ?? []).toEqual([]);
      expect(frames).toHaveLength(0);

      // Hop 1: the real Workbench Prompt, armed for one request key.
      const sessionId = await create();
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
      const startedAt = Date.now();
      await prompt(sessionId, requestId);
      await expect
        .poll(() => finished(sessionId), { timeout: 60_000 })
        .toBeTruthy();
      const trace = (
        (await rpc('events', { address: { kind: 'session', sessionId } }))
          .records as { event: Event }[]
      ).map(({ event }) => event);
      const dump = JSON.stringify(
        {
          declarations: director.declarations,
          results: director.results.map((rows) => rows.slice(0, 1)),
          segments: segments.length,
          frames: frames.length,
          events: trace
            .filter(({ type }) => /tool|error|turn/.test(type))
            .map(({ type, data }) => [type, data]),
        },
        null,
        1,
      );
      expect(trace.at(-1)?.data.reason?.kind, dump).toBe('completed');

      // L1 / hop 2: exactly one read tool declared for the armed run.
      expect(director.declarations[1]).toEqual(['read']);
      // Every read issues exactly one metadata request; the model requests
      // carrying the read tool are the first step plus one per result.
      const reads = counts.stat;
      expect(requests[1]!.messages.some(({ role }) => role === 'tool')).toBe(
        false,
      );
      expect(
        requests.filter((input) =>
          input.tools?.some(({ function: spec }) => spec.name === 'read'),
        ),
      ).toHaveLength(reads + 1);

      // L6 / L9 / L10: what the model saw, restored from the line format,
      // equals the fixture bytes; long lines rejoin byte for byte.
      const expectedResults = cases.map((item, index) => {
        if (item.kind === 'error') return undefined;
        const rows = director.results[index]!;
        if (item.kind !== 'long') return rows.join('\n');
        // A displayed prefix that ends in a lone high surrogate leaves that
        // code point entirely to the continuation.
        const first = displayedPrefix(rows[0]!);
        return [first, ...rows.slice(1).map(displayedPrefix)].join('');
      });
      cases.forEach((item, index) => {
        if (item.expected !== undefined)
          expect(expectedResults[index], item.name).toBe(item.expected);
      });
      // The truncated tail is not reachable through the native line offset.
      expect(director.results[cases.length - 3]![0]!.endsWith(marker)).toBe(
        true,
      );
      expect(director.results[cases.length - 3]!.join('')).not.toContain(
        'tail-drop-1',
      );
      // L9: every read after the first of a case was a registered segment
      // of the stat snapshot, and the long tail crossed a 16 KiB page
      // boundary inside one continuation (the segment spans more than a page).
      // (plus the one registration of the "never" case, which the supplier
      // deliberately leaves unused).
      expect(segments.length).toBe(reads - cases.length + 1);
      expect(
        segments.filter(({ through, from }) => through - from > 16 * 1024),
      ).toHaveLength(1);
      expect(
        segments.filter(({ segment }) => segment.startsWith('.rdws-read/')),
      ).toHaveLength(segments.length);
      // Each case's snapshots are all the one K registered by its stat.
      const multiSnapshots = new Set(
        segments
          .filter(({ through, from }) => through - from >= 684)
          .map(({ snapshotId }) => snapshotId),
      );
      expect(multiSnapshots.size).toBeGreaterThanOrEqual(1);
      // L11 / L13: errors carry no file body and no page left for them.
      for (const index of [cases.length - 2, cases.length - 1]) {
        const rows = director.results[index]!;
        expect(rows, cases[index]!.name).toHaveLength(0);
        expect(director.framesAfter[index]).toBe(
          director.framesAfter[index - 1],
        );
      }
      expect(JSON.stringify(director.results)).not.toContain(
        'must-never-leave',
      );

      // L5 / L8 / L12 counts: one metadata request per read, one page frame
      // per page, one certificate per page, nothing to the supplier for
      // errors; metadata requests never reach the supplier.
      expect(counts.stat).toBe(reads);
      expect(frames).toHaveLength(counts.pages);
      expect(frames[0]!.body.toString()).toBe(docText);
      expect(frames[1]!.body.toString()).toBe(largeText.slice(0, 16 * 1024));
      expect(frames[2]!.body.toString()).toBe(
        largeText.slice(16 * 1024, 32 * 1024),
      );
      expect(frames[3]!.body.toString()).toBe(largeText.slice(32 * 1024));
      const rows = (
        await observer.query(
          "select result from command_receipt where actor_id=$1 and operation='worktree.read.window' order by created_at",
          [userId],
        )
      ).rows as { result: { state?: string; acceptedBytes?: number } }[];
      expect(rows).toHaveLength(frames.length);
      expect(rows.map(({ result }) => result.state)).toEqual(
        frames.map(() => 'submitted'),
      );
      expect(new Set(frames.map(({ attempt }) => attempt)).size).toBe(
        frames.length,
      );
      // L1: every read was permitted exactly once — one permit request and
      // one grant per read, no second ticket for any call.
      expect(permitCounts.requests).toBe(reads);
      expect(permitCounts.granted).toBe(reads);
      console.log(
        'loopback summary:',
        JSON.stringify({
          cases: cases.length,
          reads,
          permits: permitCounts.granted,
          segments: segments.length,
          pages: counts.pages,
          frames: frames.length,
          certificates: rows.length,
          durationMs: Date.now() - startedAt,
        }),
      );
      // L13 (as far as this chain shows it): the reading session holds no
      // write generation — none existed, none was created — and the run
      // wrote no lease. A concurrent writer session is not assembled here.
      // L6 (as far as this chain shows it): page frames, Broker page requests
      // and window certificates are one-to-one; the per-row digest /
      // coordinate join to the native call is not asserted here.
      expect(
        (
          await observer.query(
            'select count(*)::int as n from requirement_write_lease where requirement_id=$1',
            [requirementId],
          )
        ).rows[0]!.n,
      ).toBe(0);
      // The actor's receipts are exactly the page-window certificates: no
      // write execution, release or takeover receipt was produced.
      const operations = (
        await observer.query(
          'select distinct operation from command_receipt where actor_id=$1',
          [userId],
        )
      ).rows.map((row) => (row as { operation: string }).operation);
      expect(operations).toEqual(['worktree.read.window']);
      // NOTIFY delivery is asynchronous: one roundtrip on the listening
      // connection proves every earlier notification was delivered before
      // the writes are classified.
      await listener!.query('select 1');
      // Plan point 2, by table: every write of the run lands in the inventory.
      expect(captured.length).toBeGreaterThan(0);
      const outside = captured
        .map((write) => outsideInventory(write))
        .filter(Boolean);
      expect(outside, JSON.stringify(captured)).toEqual([]);
      // The classifier itself judges a statement outside the inventory red.
      expect(
        outsideInventory({
          table: 'requirement_participant',
          operation: 'DELETE',
          query: 'delete from "requirement_participant"',
        }),
      ).toBe('statement not in the inventory');
      expect(
        outsideInventory({
          table: 'command_receipt',
          operation: 'INSERT',
          query: 'x',
        }),
      ).toBe('table not in the inventory');
      // The run's own writes: the sign-in session, the two native sessions
      // and the requirement's context version; no seat, participation or
      // plan write happened.
      const tables = new Set(captured.map(({ table }) => table));
      expect(tables).toEqual(
        new Set(['auth_session', 'native_session', 'requirement']),
      );
      expect(
        captured.filter(({ table }) => table === 'native_session'),
      ).toHaveLength(2);
      expect(captured.filter(({ table }) => table === 'auth_session')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'INSERT' }),
        ]),
      );
      expect(captured.filter(({ table }) => table === 'requirement')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: 'UPDATE' }),
        ]),
      );
      await bff.close();
      app = undefined;
    } finally {
      // Sampled again before the close and unioned with the earlier sample:
      // every child this run had is asserted gone afterwards.
      const late = children();
      ownChildren = [
        ...ownChildren,
        ...late.filter(({ pid }) => !ownChildren.some((c) => c.pid === pid)),
      ];
      hostPid ??= hostOf(ownChildren);
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
          listener?.end().catch(() => {}),
          observer?.end().catch(() => {}),
          trees?.close().catch(() => {}),
          mirrors?.close().catch(() => {}),
          lab.close(),
        ]);
      }
    }
    // Nothing this run started outlives it: the exact container the fixture
    // named is gone and none of the child PIDs it spawned is still alive (a
    // short grace covers a helper that is still exiting).
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
    expect(hostPid).toBeTruthy();
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
        host: hostPid,
        children: ownChildren.map(({ pid }) => pid),
      }),
    );
  },
  180_000,
);

// The locked read shows the prefix without its truncation marker.
function displayedPrefix(row: string) {
  const text = row.endsWith(marker) ? row.slice(0, -marker.length) : row;
  return /[\ud800-\udbff]$/.test(text) ? text.slice(0, -1) : text;
}

test('§11.20.26 L4: the assembly refuses a page carrier that is not this loopback HTTPS endpoint', () => {
  vi.stubEnv('RDWS_MODE', 'test');
  vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
  expect(() =>
    buildApp({
      databaseUrl: 'postgres://127.0.0.1:1/none',
      secret: 'x'.repeat(32),
      origin: 'http://127.0.0.1:5173',
      authorityTicket: 'a'.repeat(64),
      mainModelPolicy: {
        projectId: 'poc',
        provider: 'rdws-glm',
        model: 'm',
        destination: 'https://127.0.0.1:1/v1/chat/completions',
      },
      isolatedWrite: {
        gitPath: '/usr/bin/git',
        readSnapshots: true,
        readTool: {
          window: {
            destination: 'https://example.invalid/v1/read-loopback',
            ca: 'x',
            header: 'h',
          },
          repositoryId: 'app',
        },
      },
    }),
  ).toThrow('loopback page carrier');
});
