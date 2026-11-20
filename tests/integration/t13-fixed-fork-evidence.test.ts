import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { zstdCompressSync } from 'node:zlib';
import { bodyHash, isRecord } from '@rdws/dsh/access';
import { forkBoundary, sessionPage, sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import {
  decodeFixedForkJournal,
  fixedForkEvidence,
  fixedForkFirstWrites,
  readFixedForkJournal,
} from '../helpers/fixed-fork-evidence.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';
import { nativeReady } from '../helpers/native-ready.ts';

type Dispatch = Parameters<typeof fixedForkEvidence>[2];
type FirstWrite = Parameters<typeof fixedForkFirstWrites>[3][number];
const expected = { sessionId: 'session-test', cwd: '/fixture/requirement' };
const dispatch: Dispatch = {
  native_session_id: expected.sessionId,
  project_id: 'poc',
  requirement_id: 'fixture-requirement',
  request_id: 'fixture-request',
  actor_id: 'fixture-actor',
  peer_nonce: 'fixture-peer',
  host_generation: 'fixture-host',
  selection_revision: 'fixture-revision',
  provider: 'fixture-provider',
  model: 'fixture-model',
  accepted_seq: null,
  accepted_message_id: null,
};
const turn = { type: 'turn/start', data: { turn: 1 } };
const step = { type: 'step/start', data: { turn: 1, step: 1 } };
const context = {
  type: 'user/message',
  surfaceOp: 'append',
  data: {
    id: 'fixture-note',
    source: {
      kind: 'rdws-context',
      requirementId: dispatch.requirement_id,
      turn: 1,
      step: 1,
    },
  },
};
const prompt = {
  id: 'fixture-input',
  source: {
    kind: 'user',
    rpcId: dispatch.request_id,
    principal: {
      kind: 'rdws',
      userId: dispatch.actor_id,
      nonce: dispatch.peer_nonce,
    },
  },
};
function splice(data: Record<string, unknown> = {}) {
  return {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      removedCount: 0,
      inserted: [],
      ...data,
    },
  };
}
function rawJournal(
  events: { type: string; data: Record<string, unknown>; surfaceOp?: string }[],
  header: Record<string, unknown> = {},
) {
  return Buffer.from(
    [
      {
        type: 'session',
        id: expected.sessionId,
        cwd: expected.cwd,
        version: 4,
        createdAt: 1,
        delegationDepth: 0,
        isSeeded: false,
        ...header,
      },
      ...events.map((event, seq) => ({ seq, time: seq + 1, ...event })),
    ]
      .map((row) => JSON.stringify(row) + '\n')
      .join(''),
  );
}

test('physical evidence rejects old journals, corrupt frames, torn lines and unavailable inclusive cutoffs', () => {
  const raw = rawJournal([turn, step]);
  const split = raw.indexOf(10) + 1;
  const headerFrame = zstdCompressSync(raw.subarray(0, split));
  const frames = Buffer.concat([
    headerFrame,
    zstdCompressSync(raw.subarray(split)),
  ]);
  const snap = decodeFixedForkJournal(frames, true, expected);
  expect(snap.events.map(({ seq }) => seq)).toEqual([0, 1]);
  expect(fixedForkEvidence(snap, 1, dispatch).action).toBe('unknown');
  for (const cutoff of [-1, 2, 0.1])
    expect(() => fixedForkEvidence(snap, cutoff, dispatch)).toThrow(
      'Invalid physical fork evidence',
    );
  for (const [bytes, compressed] of [
    [zstdCompressSync(raw), true],
    [Buffer.concat([frames, zstdCompressSync(Buffer.alloc(0))]), true],
    [
      Buffer.concat([
        headerFrame,
        zstdCompressSync(raw.subarray(split, split + 10)),
        zstdCompressSync(raw.subarray(split + 10)),
      ]),
      true,
    ],
    [frames.subarray(0, -1), true],
    [Buffer.concat([frames, Buffer.from([0])]), true],
    [raw.subarray(0, -1), false],
    [rawJournal([turn], { version: 3 }), false],
    [rawJournal([turn], { isSeeded: true }), false],
    [rawJournal([turn], { cwd: '/another/fixture' }), false],
    [Buffer.from(raw.toString().replace('"seq":1', '"seq":2')), false],
    [
      Buffer.concat([
        headerFrame,
        zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1, 10)),
      ]),
      true,
    ],
    [rawJournal(Array.from({ length: 8192 }, () => turn)), false],
  ] as const)
    expect(() => decodeFixedForkJournal(bytes, compressed, expected)).toThrow(
      'Invalid physical fork evidence',
    );
});

test('physical splices separate first ingress, queue transitions, claims and evidence inherited from the parent', () => {
  const inserted = splice({ inserted: [prompt] });
  const remove = splice({ removedCount: 1 });
  const evidence = (
    events: Parameters<typeof rawJournal>[0],
    permit = dispatch,
  ) =>
    fixedForkEvidence(
      decodeFixedForkJournal(rawJournal(events), false, expected),
      events.length - 1,
      permit,
    );
  expect(evidence([inserted])).toMatchObject({
    action: 'queued',
    insertedAt: 0,
    actionAt: 0,
  });
  expect(
    evidence([inserted, turn, remove, { type: 'user/message', data: prompt }]),
  ).toMatchObject({ action: 'claimed', insertedAt: 0, actionAt: 2 });
  expect(evidence([inserted, turn, step, remove]).action).toBe('removed');
  expect(evidence([inserted, remove]).action).toBe('removed');
  expect(
    evidence([inserted, splice({ removedCount: 1, outcome: 'canceled' })])
      .action,
  ).toBe('cancelled');
  expect(
    evidence([
      inserted,
      splice({ removedCount: 1, inserted: [{ id: 'replacement' }] }),
    ]).action,
  ).toBe('replaced');
  expect(evidence([inserted, remove, inserted]).action).toBe('ambiguous');
  expect(
    evidence([
      inserted,
      remove,
      splice({ inserted: [{ ...prompt, id: 'other-input' }] }),
    ]).action,
  ).toBe('ambiguous');
  expect(
    evidence([{ type: 'user/message', data: prompt }, inserted]).action,
  ).toBe('unknown');
  expect(
    evidence([inserted], { ...dispatch, actor_id: 'different' }).action,
  ).toBe('unknown');
  expect(
    evidence([inserted], { ...dispatch, peer_nonce: 'different' }).action,
  ).toBe('unknown');
  expect(
    evidence([inserted], {
      ...dispatch,
      accepted_seq: 0,
      accepted_message_id: 'different',
    }).action,
  ).toBe('unknown');
  const twoQueues = decodeFixedForkJournal(
    rawJournal([
      splice({ inserted: [{ id: 'other-queue-input' }] }),
      splice({
        target: 'next-turn',
        inserted: [prompt, { id: 'later-turn-input' }],
      }),
      turn,
      remove,
      splice({ target: 'next-turn', removedCount: 1 }),
    ]),
    false,
    expected,
  );
  expect(fixedForkEvidence(twoQueues, 3, dispatch).action).toBe('queued');
  expect(fixedForkEvidence(twoQueues, 4, dispatch)).toMatchObject({
    action: 'claimed',
    insertedAt: 1,
    actionAt: 4,
  });
  expect(
    evidence([
      splice({ inserted: [{ id: 'other-queue-input' }] }),
      splice({ target: 'next-turn', inserted: [prompt] }),
      turn,
      splice({ target: 'next-turn', removedCount: 1 }),
    ]).action,
  ).toBe('removed');
  expect(() =>
    evidence([turn, step, { type: 'step/end', data: { turn: 1, step: 2 } }]),
  ).toThrow('Invalid physical fork evidence');
  const inherited = decodeFixedForkJournal(
    rawJournal(
      [
        inserted,
        { type: 'session/end-seed', data: { inherited: true } },
        turn,
        remove,
      ],
      { isSeeded: true },
    ),
    false,
    expected,
  );
  expect(fixedForkEvidence(inherited, 3, dispatch)).toMatchObject({
    action: 'unknown',
    inheritedLength: 1,
  });
});

test('a submitted receipt requires both local physical positions and the original request and revision', () => {
  const snap = decodeFixedForkJournal(
    rawJournal([turn, step, context]),
    false,
    expected,
  );
  const row: FirstWrite = {
    native_session_id: dispatch.native_session_id,
    project_id: dispatch.project_id,
    requirement_id: dispatch.requirement_id,
    host_generation: dispatch.host_generation,
    selection_revision: dispatch.selection_revision,
    selection_request_id: dispatch.request_id,
    provider: dispatch.provider,
    model: dispatch.model,
    state: 'submitted',
    turn: 1,
    step: 1,
    step_seq: 1,
    note_seq: 2,
  };
  expect(fixedForkFirstWrites(snap, 1, dispatch, [row])).toEqual([]);
  expect(
    fixedForkFirstWrites(snap, 2, dispatch, [
      row,
      { ...row, selection_revision: 'same-model-different-revision' },
      { ...row, selection_request_id: 'later-request' },
      { ...row, native_session_id: 'session-sibling' },
      { ...row, turn: 2 },
      { ...row, note_seq: 1 },
    ]),
  ).toEqual([{ state: 'submitted', stepSeq: 1, noteSeq: 2 }]);
  expect(
    fixedForkFirstWrites(snap, 2, dispatch, [{ ...row, state: 'prepared' }]),
  ).toEqual([{ state: 'prepared', stepSeq: 1, noteSeq: 2 }]);
  for (const invalid of [
    { ...context, surfaceOp: 'replace' },
    {
      ...context,
      data: {
        ...context.data,
        source: { ...context.data.source, requirementId: 'fixture-sibling' },
      },
    },
  ]) {
    const journal = decodeFixedForkJournal(
      rawJournal([turn, step, invalid]),
      false,
      expected,
    );
    expect(fixedForkFirstWrites(journal, 2, dispatch, [row])).toEqual([]);
  }
});

test.skipIf(process.platform !== 'darwin')(
  'a stopped Native fork proves its exact parent prefix without treating a silent same-value revision as a selection event',
  async () => {
    const dockerContext = execFileSync(
      'docker',
      [
        'context',
        'inspect',
        '--format',
        '{{(index .Endpoints "docker").Host}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const lab = await authorityDatabase(
      process.env.DOCKER_CONTEXT
        ? dockerContext
        : process.env.DOCKER_HOST || dockerContext,
    );
    const defaultCAs = getCACertificates('default');
    let supplier: ReturnType<typeof createServer> | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    const project = 'poc';
    const owner = randomUUID();
    const requirement = randomUUID();
    const root = join(lab.root, 'native');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const provider = 'rdws-glm';
    const alpha = 'fixed-cut-a';
    const beta = 'fixed-cut-b';
    const first = randomUUID(),
      changed = randomUUID(),
      same = randomUUID(),
      later = randomUUID();
    const held = new Set<string>([changed, same]);
    const rejected: { requestId: string; model: unknown }[] = [];
    const modelsReceived: string[] = [];
    let connections = 0;
    const configuredHosts = new Set<NativeWebHost>();
    const configure = NativeWebHost.prototype.configureContext;
    const probe = vi
      .spyOn(NativeWebHost.prototype, 'configureContext')
      .mockImplementation(function (this: NativeWebHost, handler) {
        configuredHosts.add(this);
        configure.call(this, (input, token, reply) => {
          const cap = this.verifyContext(token);
          if (
            cap?.operation === 'context-read' &&
            cap.hostGeneration === this.contextGeneration &&
            isRecord(input) &&
            cap.bodyHash === bodyHash(input) &&
            typeof input.requestId === 'string' &&
            held.has(input.requestId) &&
            isRecord(input.modelStep)
          ) {
            rejected.push({
              requestId: input.requestId,
              model: input.modelStep.model,
            });
            return Promise.reject(
              new Error('Synthetic stop before step start'),
            );
          }
          return handler(input, token, reply);
        });
      });
    try {
      const keys = await modelTlsCertificate(lab.root);
      setDefaultCACertificates([...defaultCAs, keys.cert.toString()]);
      supplier = createServer(
        { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
        async (request, response) => {
          try {
            if (
              request.method !== 'POST' ||
              request.url !== '/v1/chat/completions'
            ) {
              response.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const { model } = JSON.parse(Buffer.concat(chunks).toString()) as {
              model: string;
            };
            modelsReceived.push(model);
            const frame = {
              id: 'fixed-cut-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model,
            };
            const choices = [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Synthetic fixed cutoff response',
                },
                finish_reason: null,
              },
              { index: 0, delta: {}, finish_reason: 'stop' },
            ];
            response
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(
                choices
                  .map(
                    (choice) =>
                      `data: ${JSON.stringify({ ...frame, choices: [choice] })}\n\n`,
                  )
                  .join('') + 'data: [DONE]\n\n',
              );
          } catch {
            response.destroy();
          }
        },
      );
      supplier.on('connection', () => connections++);
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      const base =
        'https://127.0.0.1:' +
        (supplier.address() as { port: number }).port +
        '/v1';
      const configuration = join(root, 'config/projects', project, 'dsh');
      const profile = join(configuration, 'profiles/rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: randomBytes(24).toString('hex') },
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
                  baseURL: base,
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: alpha }, { id: beta }],
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      await lab.owner.query(
        "insert into project(id,name) values('poc','Synthetic fixed cutoff')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','cutoff@fixture.invalid','fixture_cutoff',true)",
        [owner],
      );
      const password = randomBytes(18).toString('hex');
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), owner, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [owner],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Synthetic demand','','',$2,$2)",
        [requirement, owner],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirement, owner],
      );
      const ticket = randomBytes(32).toString('hex');
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      const {
        rows: [fixture],
      } = await lab.owner.query<{ name: string }>(
        "select current_setting('rdws.fixture_instance') as name",
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      const bff = (app = buildApp({
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        nativeRuntimeRoot: root,
        repositoryHome: root,
        authorityTicket: ticket,
        mainModelPolicy: {
          projectId: project,
          provider,
          model: alpha,
          destination: base + '/chat/completions',
        },
        sessionModelPilot: {
          alternateModel: beta,
          databaseFixture: fixture!.name,
        },
      }));
      const login = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'fixture_cutoff', password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join('; ');
      const loginId = await observedLogin(bff, cookie);
      const headers = { cookie, origin, 'x-rdws-edit-session': loginId };
      const sessions = `/api/requirements/${requirement}/sessions`;
      const created = await bff.inject({
        method: 'POST',
        url: sessions,
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(created.statusCode).toBe(200);
      const { sessionId } = created.json<{ sessionId: string }>();
      expect(configuredHosts.size).toBe(1);
      const original = [...configuredHosts][0]!;
      const { pid } = await nativeReady(root);
      const binding = await bootstrapNative(bff, cookie, requirement);
      const cwd = await realpath(
        join(root, 'projects', project, 'demands', requirement),
      );
      const {
        rows: [scope],
      } = await lab.owner.query<{ native_workspace_id: string }>(
        'select r.native_workspace_id from requirement r join native_session n on n.requirement_id=r.id where n.id=$1 and r.id=$2 and r.project_id=$3 and n.owner_id=$4 and n.source_session_id is null',
        [sessionId, requirement, project, owner],
      );
      expect(scope?.native_workspace_id).toEqual(expect.any(String));
      const browser = {
        purpose: 'browser' as const,
        userId: owner,
        authSessionId: loginId,
        requirementId: requirement,
        cwd,
        workspaceId: scope!.native_workspace_id,
        readSessionIds: [sessionId],
        ownSessionIds: [sessionId],
      };
      const wire = {
        cookie,
        origin,
        'x-rdws-native-login': binding,
        'x-rdws-client-generation': randomUUID(),
      };
      const finish = async (expectedTurns: number) => {
        const page = await vi.waitFor(
          async () => {
            const page = await sessionPage(
              original,
              browser,
              sessionId,
              undefined,
              undefined,
              100,
            );
            expect(
              page.records.filter(({ event }) => event.type === 'turn/end'),
            ).toHaveLength(expectedTurns);
            return page;
          },
          { timeout: 5000 },
        );
        return page.records.map(({ event }) => event);
      };
      async function select(model: string) {
        const selected = await bff.inject({
          method: 'POST',
          url: `${sessions}/${sessionId}/model-selection`,
          headers,
          payload: { commandId: randomUUID(), provider, model },
        });
        expect(selected.statusCode).toBe(200);
        return selected.json<{
          selection: { provider: string; model: string; revision: string };
        }>().selection;
      }
      async function send(requestId: string) {
        const sent = await bff.inject({
          method: 'POST',
          url: `/api/dsh/${requirement}/native/api/session/prompt`,
          headers: wire,
          payload: {
            type: 'client-request',
            method: 'session/prompt',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  sessionId,
                  requestId,
                  mode: 'queue',
                  content: [
                    { type: 'text', text: 'Synthetic fixed cutoff prompt' },
                  ],
                },
              },
            },
          },
        });
        expect(sent.statusCode, sent.json().error).toBe(200);
        expect(sent.json().result).toEqual({
          ok: true,
          value: { accepted: true },
        });
      }
      const initial = await select(alpha);
      await send(first);
      const initialEvents = await finish(1);
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      const replacement = await select(beta);
      await send(changed);
      const changedEvents = await finish(2);
      const repeated = await select(beta);
      expect(repeated.model).toBe(replacement.model);
      expect(repeated.revision).not.toBe(replacement.revision);
      await send(same);
      const currentEvents = await finish(3);
      expect(rejected).toEqual([
        { requestId: changed, model: beta },
        { requestId: same, model: beta },
      ]);
      expect(connections).toBe(1);
      expect(modelsReceived).toEqual([alpha]);
      const stableCut = await forkBoundary(original, browser, sessionId);
      expect(stableCut).toBe(currentEvents.at(-1)?.seq);
      const { sessionId: child } = (await sessionRpc(
        original,
        {
          ...browser,
          purpose: 'fork',
          sourceSessionId: sessionId,
          atSeq: stableCut!,
        },
        'session/fork',
        { sessionId, atSeq: stableCut, allowMigration: false },
      )) as { sessionId: string };
      expect(child).not.toBe(sessionId);
      await send(later);
      const finalEvents = await finish(4);
      expect(modelsReceived).toEqual([alpha, beta]);
      expect(connections).toBe(2);
      await bff.close();
      app = undefined;
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      const { rows: dispatches } = await lab.owner.query<
        Dispatch & { state: string }
      >(
        'select native_session_id, project_id, requirement_id, request_id, actor_id, peer_nonce, host_generation, selection_revision, provider, model, state, accepted_seq::int, accepted_message_id from session_prompt_dispatch where native_session_id=$1',
        [sessionId],
      );
      const { rows: writes } = await lab.owner.query<FirstWrite>(
        'select native_session_id, project_id, requirement_id, selection_request_id, selection_revision, host_generation, provider, model, state, turn, step, step_seq::int, note_seq::int from session_model_first_write where native_session_id=$1',
        [sessionId],
      );
      expect(writes.map(({ state }) => state)).toEqual([
        'submitted',
        'submitted',
      ]);
      expect(dispatches).toHaveLength(4);
      function originalDispatch(
        requestId: string,
        model: string,
        selectionRevision: string,
      ) {
        const row = dispatches.find(
          ({ request_id }) => request_id === requestId,
        )!;
        expect(
          Boolean(
            row &&
            row.native_session_id === sessionId &&
            row.project_id === project &&
            row.requirement_id === requirement &&
            row.actor_id === owner &&
            row.host_generation === original.contextGeneration &&
            row.peer_nonce &&
            row.provider === provider &&
            row.model === model &&
            row.state === 'accepted' &&
            row.selection_revision === selectionRevision,
          ),
        ).toBe(true);
        expect({
          accepted_seq: row.accepted_seq,
          hasMessage: Boolean(row.accepted_message_id),
        }).toEqual({
          accepted_seq: expect.any(Number),
          hasMessage: true,
        });
        return row;
      }
      const alphaDispatch = originalDispatch(first, alpha, initial.revision);
      const changedDispatch = originalDispatch(
        changed,
        beta,
        replacement.revision,
      );
      const sameDispatch = originalDispatch(same, beta, repeated.revision);
      const laterDispatch = originalDispatch(later, beta, repeated.revision);
      const parentFile = await readFixedForkJournal(root, sessionId);
      const childFile = await readFixedForkJournal(root, child);
      expect(parentFile.compressed && childFile.compressed).toBe(true);
      const parent = decodeFixedForkJournal(
        parentFile.bytes,
        parentFile.compressed,
        { sessionId, cwd },
      );
      const fork = decodeFixedForkJournal(
        childFile.bytes,
        childFile.compressed,
        { sessionId: child, cwd },
      );
      const firstCut = initialEvents.at(-1)!.seq;
      const changedCut = changedEvents.at(-1)!.seq;
      const end = parent.events.length - 1;
      for (const [seen, turn] of [
        [initialEvents, 1],
        [changedEvents, 2],
        [currentEvents, 3],
        [finalEvents, 4],
      ] as const) {
        const terminal = seen.findLast(({ type }) => type === 'turn/end')!;
        expect(terminal.data.turn).toBe(turn);
        expect(terminal.seq).toBeLessThanOrEqual(end);
        const persisted = parent.events[terminal.seq];
        expect(persisted?.type).toBe('turn/end');
        expect(persisted?.data.turn).toBe(turn);
        expect(
          bodyHash(persisted?.data.reason) === bodyHash(terminal.data.reason),
        ).toBe(true);
      }
      expect(fork.inheritedLength).toBe(stableCut! + 1);
      expect(
        bodyHash(fork.events.slice(0, fork.inheritedLength)) ===
          bodyHash(parent.events.slice(0, stableCut! + 1)),
      ).toBe(true);
      expect(fixedForkEvidence(parent, firstCut, changedDispatch).action).toBe(
        'unknown',
      );
      const changedClaim = fixedForkEvidence(
        parent,
        changedCut,
        changedDispatch,
      );
      const changedModel = changedClaim.models.filter(
        ({ seq }) => seq > firstCut,
      );
      expect(changedClaim).toMatchObject({
        action: 'claimed',
        insertedAt: changedDispatch.accepted_seq,
        actionAt: expect.any(Number),
      });
      expect(changedModel).toEqual([
        { seq: expect.any(Number), provider, model: beta },
      ]);
      expect(changedModel[0]!.seq).toBeGreaterThan(changedClaim.actionAt!);
      expect(changedModel[0]!.seq).toBeLessThan(changedCut);
      const sameClaim = fixedForkEvidence(parent, stableCut!, sameDispatch);
      expect(sameClaim).toMatchObject({
        action: 'claimed',
        insertedAt: sameDispatch.accepted_seq,
        actionAt: expect.any(Number),
      });
      expect(sameClaim.actionAt).toBeGreaterThan(changedCut);
      expect(sameClaim.models.filter(({ seq }) => seq > changedCut)).toEqual(
        [],
      );
      expect(
        parent.events.filter(
          ({ seq, type }) =>
            seq > firstCut && seq <= stableCut! && type === 'step/start',
        ),
      ).toEqual([]);
      expect(
        fixedForkFirstWrites(parent, firstCut, alphaDispatch, writes),
      ).toEqual([
        {
          state: 'submitted',
          stepSeq: expect.any(Number),
          noteSeq: expect.any(Number),
        },
      ]);
      for (const blocked of [changedDispatch, sameDispatch])
        expect(fixedForkFirstWrites(parent, end, blocked, writes)).toEqual([]);
      expect(
        fixedForkFirstWrites(parent, stableCut!, laterDispatch, writes),
      ).toEqual([]);
      expect(fixedForkFirstWrites(parent, end, laterDispatch, writes)).toEqual([
        {
          state: 'submitted',
          stepSeq: expect.any(Number),
          noteSeq: expect.any(Number),
        },
      ]);
      expect(
        fixedForkEvidence(fork, fork.events.length - 1, {
          ...sameDispatch,
          native_session_id: child,
        }),
      ).toMatchObject({
        action: 'unknown',
        inheritedLength: stableCut! + 1,
        models: [],
      });
      expect(
        fixedForkFirstWrites(
          fork,
          fork.events.length - 1,
          { ...alphaDispatch, native_session_id: child },
          writes.map((row) => ({ ...row, native_session_id: child })),
        ),
      ).toEqual([]);
      for (const [id, artifact] of [
        [sessionId, parentFile],
        [child, childFile],
      ] as const)
        expect(
          (await readFixedForkJournal(root, id)).bytes.equals(artifact.bytes),
        ).toBe(true);
      expect(connections).toBe(2);
      expect(modelsReceived).toEqual([alpha, beta]);
    } finally {
      probe.mockRestore();
      vi.unstubAllEnvs();
      try {
        await app?.close();
      } finally {
        setDefaultCACertificates(defaultCAs);
        supplier?.closeAllConnections();
        if (supplier)
          await new Promise<void>((resolve) =>
            supplier!.close(() => resolve()),
          );
        await lab.close();
      }
    }
  },
  60_000,
);
