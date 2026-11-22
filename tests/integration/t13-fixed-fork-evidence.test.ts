import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { zstdCompressSync } from 'node:zlib';
import { bodyHash, isRecord } from '@rdws/dsh/access';
import { forkBoundary, sessionPage } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { intactForkReceipt } from '../../apps/server/src/modules/fork-model-receipt.ts';
import { usedForkModels } from '../../apps/server/src/modules/fork-model-evidence.ts';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
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

test('nested seed markers require the matching direct source and exact inherited prefix', () => {
  const marker = { type: 'session/end-seed', data: { inherited: true } };
  const ordinary = { type: 'session/end-seed', data: {} };
  const first = [turn, marker, ordinary];
  const parent = decodeFixedForkJournal(
    rawJournal(first, { isSeeded: true }),
    false,
    expected,
  );
  const child = { sessionId: 'session-grandchild', cwd: expected.cwd };
  const source = { sessionId: expected.sessionId, parent, throughSeq: 2 };
  const bytes = rawJournal([...first, marker], {
    id: child.sessionId,
    isSeeded: true,
  });
  const decode = (data: Buffer, ref = source) =>
    decodeFixedForkJournal(data, false, { ...child, source: ref });
  expect(decode(bytes).inheritedLength).toBe(3);
  expect(() => decodeFixedForkJournal(bytes, false, child)).toThrow();
  for (const ref of [
    { ...source, sessionId: 'session-neighbor' },
    { ...source, throughSeq: 1 },
    { ...source, throughSeq: 5 },
    {
      ...source,
      sessionId: child.sessionId,
      parent: { ...parent, sessionId: child.sessionId },
    },
  ]) {
    expect(() => decode(bytes, ref)).toThrow();
  }
  for (const events of [
    [turn, ordinary, ordinary, marker],
    [turn, marker, step, marker],
    [...first, marker, marker],
  ]) {
    expect(() =>
      decode(rawJournal(events, { id: child.sessionId, isSeeded: true })),
    ).toThrow();
  }
});

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
    const childRequest = randomUUID();
    let childStepEntered = false;
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
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
            input.requestId === childRequest &&
            isRecord(input.modelStep)
          ) {
            childStepEntered = true;
            return childGate.then(() => handler(input, token, reply));
          }
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
      const options: Parameters<typeof buildApp>[0] = {
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
      };
      const bff = (app = buildApp(options));
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
      async function send(
        requestId: string,
        target = sessionId,
        runtime = bff,
        carrier = wire,
      ) {
        const sent = await runtime.inject({
          method: 'POST',
          url: `/api/dsh/${requirement}/native/api/session/prompt`,
          headers: carrier,
          payload: {
            type: 'client-request',
            method: 'session/prompt',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  sessionId: target,
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
      const classify = (events: typeof initialEvents) =>
        usedForkModels(events, owner, requirement);
      expect(classify(initialEvents)).toMatchObject([
        { requestId: first, model: alpha, provider },
      ]);
      for (const events of [
        initialEvents.filter((event) => event.type !== 'assistant/message'),
        initialEvents.map((event) =>
          event.type === 'assistant/message'
            ? { ...event, type: 'assistant/attempt' }
            : event,
        ),
        initialEvents.map((event) =>
          event.type === 'assistant/message'
            ? { ...event, data: { ...event.data, interrupted: true } }
            : event,
        ),
        initialEvents.map((event) =>
          event.type === 'turn/end'
            ? {
                ...event,
                data: { ...event.data, reason: { kind: 'interrupted' } },
              }
            : event,
        ),
        initialEvents.map((event) =>
          event.type === 'step/end'
            ? { ...event, data: { ...event.data, step: 42 } }
            : event,
        ),
        [
          ...initialEvents,
          {
            seq: initialEvents.length,
            type: 'model/selection',
            data: { provider, model: beta },
          },
        ],
      ])
        expect(classify(events)).toBeUndefined();
      const provenFork = await bff.inject({
        method: 'POST',
        url: sessions + '/' + sessionId + '/fork',
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(provenFork.statusCode).toBe(200);
      const provenChild = provenFork.json<{ sessionId: string }>().sessionId;
      const storedWitness = (
        await lab.owner.query(
          "select result,digest from command_receipt where operation='model.fork-source' and result->'key'->>'sourceSessionId'=$1",
          [sessionId],
        )
      ).rows[0]!;
      expect(
        intactForkReceipt({
          digest: storedWitness.digest,
          result: storedWitness.result,
        }),
      ).toBe(true);
      expect(
        intactForkReceipt({
          digest: storedWitness.digest,
          result: {
            ...storedWitness.result,
            choice: { ...storedWitness.result.choice, model: beta },
          },
        }),
      ).toBe(false);
      const provenModelPath = sessions + '/' + provenChild + '/model-selection';
      expect(
        (await bff.inject({ url: provenModelPath, headers })).json(),
      ).toEqual({ selection: null, firstWrite: null, inherited: initial });
      wire['x-rdws-client-generation'] = randomUUID();
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
      const forkCommand = randomUUID();
      const forkFromWorkbench = async () => {
        const reply = await bff.inject({
          method: 'POST',
          url: sessions + '/' + sessionId + '/fork',
          headers,
          payload: { commandId: forkCommand },
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.json().status).toBe('mapped');
        return reply.json<{ sessionId: string }>().sessionId;
      };
      const child = await forkFromWorkbench();
      expect(child).not.toBe(sessionId);
      const history = async (id: string) => {
        const result = await bff.inject({
          url:
            sessions +
            '/' +
            id +
            '/history?throughSeq=' +
            stableCut +
            '&pageSize=50',
          headers,
        });
        expect(result.statusCode).toBe(200);
        return result.json<{ events: { type: string; seq: number }[] }>()
          .events;
      };
      const parentHistory = await history(sessionId);
      expect(
        parentHistory.some(({ type }) => type === 'assistant/message'),
      ).toBe(true);
      expect(bodyHash(await history(child))).toBe(bodyHash(parentHistory));
      wire['x-rdws-client-generation'] = randomUUID();
      async function expectUnselected(id: string) {
        const childAttempt = await bff.inject({
          method: 'POST',
          url: '/api/dsh/' + requirement + '/native/api/session/prompt',
          headers: wire,
          payload: {
            type: 'client-request',
            method: 'session/prompt',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  sessionId: id,
                  requestId: randomUUID(),
                  mode: 'queue',
                  content: [
                    { type: 'text', text: 'Synthetic unselected descendant' },
                  ],
                },
              },
            },
          },
        });
        expect(childAttempt.statusCode).toBe(409);
        expect(childAttempt.json()).toEqual({
          error: '请先为派生会话明确选择当前可用模型',
        });
      }
      await expectUnselected(child);
      const nestedCut = await forkBoundary(
        original,
        { ...browser, ownSessionIds: [child], readSessionIds: [child] },
        child,
      );
      expect(nestedCut).toBeGreaterThan(stableCut!);
      const nestedFork = await bff.inject({
        method: 'POST',
        url: sessions + '/' + child + '/fork',
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(nestedFork.statusCode, nestedFork.body).toBe(200);
      const grandchild = nestedFork.json<{ sessionId: string }>().sessionId;
      expect(
        (
          await lab.owner.query(
            'select source_session_id, source_through_seq::int as cut, owner_id from native_session where id=$1 and requirement_id=$2',
            [grandchild, requirement],
          )
        ).rows,
      ).toEqual([
        { source_session_id: child, cut: nestedCut, owner_id: owner },
      ]);
      expect(bodyHash(await history(grandchild))).toBe(bodyHash(parentHistory));
      await expectUnselected(grandchild);
      expect(
        (
          await lab.owner.query(
            'select attempt_id from session_model_first_write where native_session_id=$1',
            [grandchild],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await lab.owner.query(
            'select request_id from session_prompt_dispatch where native_session_id=$1',
            [grandchild],
          )
        ).rowCount,
      ).toBe(0);
      expect(connections).toBe(1);
      const childModelPath = sessions + '/' + child + '/model-selection';
      const saveChild = async (runtime: typeof bff, model: string) => {
        const response = await runtime.inject({
          method: 'POST',
          url: childModelPath,
          headers,
          payload: { commandId: randomUUID(), provider, model },
        });
        expect(response.statusCode).toBe(200);
        return response.json<{
          selection: { provider: string; model: string; revision: string };
        }>().selection;
      };
      const chosenChild = await saveChild(bff, beta);
      expect(chosenChild.model).toBe(repeated.model);
      expect(chosenChild.revision).not.toBe(repeated.revision);
      expect(connections).toBe(1);
      await send(later);
      const finalEvents = await finish(4);
      expect(await forkFromWorkbench()).toBe(child);
      expect(
        (
          await lab.owner.query(
            'select id,owner_id,source_through_seq::int as cut from native_session where requirement_id=$1 and source_session_id=$2 and id=$3',
            [requirement, sessionId, child],
          )
        ).rows,
      ).toEqual([{ id: child, owner_id: owner, cut: stableCut }]);

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
        {
          sessionId: child,
          cwd,
          source: { sessionId, throughSeq: stableCut!, parent },
        },
      );
      const nestedFile = await readFixedForkJournal(root, grandchild);
      const nested = decodeFixedForkJournal(
        nestedFile.bytes,
        nestedFile.compressed,
        {
          sessionId: grandchild,
          cwd,
          source: { sessionId: child, parent: fork, throughSeq: nestedCut! },
        },
      );
      expect(nested.inheritedLength).toBe(nestedCut! + 1);
      expect(
        nested.events
          .filter(
            (e) => e.type === 'session/end-seed' && e.data.inherited === true,
          )
          .map((e) => e.seq),
      ).toEqual([stableCut! + 1, nestedCut! + 1]);
      expect(bodyHash(nested.events.slice(0, nested.inheritedLength))).toBe(
        bodyHash(fork.events.slice(0, nestedCut! + 1)),
      );
      expect(
        fixedForkFirstWrites(
          nested,
          nested.events.length - 1,
          { ...alphaDispatch, native_session_id: grandchild },
          writes.map((row) => ({ ...row, native_session_id: grandchild })),
        ),
      ).toEqual([]);
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
        [grandchild, nestedFile],
      ] as const)
        expect(
          (await readFixedForkJournal(root, id)).bytes.equals(artifact.bytes),
        ).toBe(true);
      expect(connections).toBe(2);
      expect(modelsReceived).toEqual([alpha, beta]);
      const nextTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set ticket_digest=$1 where singleton and managed and generation is null and proof_digest is null and ticket_digest is null',
            [createHash('sha256').update(nextTicket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      const cold = (app = buildApp({
        ...options,
        authorityTicket: nextTicket,
      }));
      const readChild = await cold.inject({ url: childModelPath, headers });
      expect(readChild.statusCode).toBe(200);
      expect(readChild.json()).toEqual({
        selection: chosenChild,
        firstWrite: null,
      });
      const freshWire = {
        ...wire,
        'x-rdws-native-login': await bootstrapNative(cold, cookie, requirement),
        'x-rdws-client-generation': randomUUID(),
      };
      expect(connections).toBe(2);
      expect(
        (await cold.inject({ url: provenModelPath, headers })).json(),
      ).toEqual({ selection: null, firstWrite: null, inherited: initial });
      const sending = send(childRequest, child, cold, freshWire);
      void sending.catch(() => {});
      try {
        await expect.poll(() => childStepEntered).toBe(true);
        const newerChild = await saveChild(cold, alpha);
        expect(newerChild.revision).not.toBe(chosenChild.revision);
        expect(connections).toBe(2);
        releaseChild();
        await sending;
        await expect.poll(() => modelsReceived).toEqual([alpha, beta, beta]);
        const evidence = await vi.waitFor(async () => {
          const rows = (
            await lab.owner.query(
              'select model,selection_revision,state,step_seq::int as seq from session_model_first_write where native_session_id=$1 and selection_request_id=$2',
              [child, childRequest],
            )
          ).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0].state).toBe('submitted');
          return rows[0];
        });
        expect(evidence.model).toBe(beta);
        expect(evidence.selection_revision).toBe(chosenChild.revision);
        expect(evidence.seq).toBeGreaterThan(stableCut!);
        expect(
          (await cold.inject({ url: childModelPath, headers })).json(),
        ).toEqual({ selection: newerChild, firstWrite: null });
        expect(
          (
            await cold.inject({
              url: sessions + '/' + sessionId + '/model-selection',
              headers,
            })
          ).json(),
        ).toEqual({ selection: repeated, firstWrite: 'submitted' });
      } finally {
        releaseChild();
        await sending.catch(() => {});
      }
      const persistedSend = randomUUID();
      await send(persistedSend, provenChild, cold, freshWire);
      await expect
        .poll(() => modelsReceived)
        .toEqual([alpha, beta, beta, alpha]);
      await expect
        .poll(
          async () =>
            (
              await lab.owner.query(
                "select model,selection_revision as revision from session_model_first_write where native_session_id=$1 and selection_request_id=$2 and state='submitted'",
                [provenChild, persistedSend],
              )
            ).rows,
        )
        .toEqual([{ model: alpha, revision: initial.revision }]);
    } finally {
      releaseChild();
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

test.skipIf(process.platform !== 'darwin')(
  'a completed parent turn whose only first-write proof stays prepared leaves a real fork child refused',
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
    const alpha = 'prepared-cut-a';
    const beta = 'prepared-cut-b';
    const first = randomUUID();
    const modelsReceived: string[] = [];
    let connections = 0;
    let firstWriteFault:
      | {
          requestId: string;
          phase: 'prepare' | 'authorize' | 'settle';
          outcome: 'commit' | 'rollback' | 'hold' | 'confirm';
          attemptId?: string;
          completion?: string;
        }
      | undefined;
    const connect = Pool.prototype.connect;
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
      this: Pool,
      ...args: unknown[]
    ) {
      const connection = Reflect.apply(connect, this, args);
      const fault = firstWriteFault;
      if (args.length || !fault) return connection;
      return connection.then((client: PoolClient) => {
        const query = client.query;
        let phase: 'prepare' | 'authorize' | 'settle' | undefined;
        client.query = ((...parameters: unknown[]) => {
          const input = parameters[0] as
            string | { text: string; values?: unknown[] };
          const sql = (typeof input === 'string' ? input : input.text).trim();
          const values = Array.isArray(parameters[1])
            ? parameters[1]
            : typeof input === 'string'
              ? undefined
              : input.values;
          if (fault) {
            if (
              sql.startsWith('insert into "session_model_first_write"') &&
              values?.[3] === fault.requestId
            ) {
              fault.attemptId ??= String(values[11]);
              phase = 'prepare';
            } else if (
              sql.startsWith('select ') &&
              sql.includes('from "session_prompt_dispatch"') &&
              sql.endsWith('for share') &&
              values?.includes(fault.requestId)
            ) {
              phase = 'authorize';
            } else if (
              fault.attemptId &&
              values?.includes(fault.attemptId) &&
              sql.startsWith('update "session_model_first_write"')
            ) {
              phase = 'settle';
            }
            if (
              sql === 'commit' &&
              phase === fault.phase &&
              !fault.completion
            ) {
              client.query = query;
              const statement =
                fault.outcome === 'rollback' ? 'rollback' : 'commit';
              return Reflect.apply(query, client, [statement]).then(
                async (value: { command: string }) => {
                  fault.completion = value.command;
                  if (
                    fault.outcome !== 'rollback' &&
                    fault.outcome !== 'commit'
                  )
                    return value;
                  throw new Error('Synthetic first-write commit reply lost');
                },
              );
            }
          }
          const result = Reflect.apply(query, client, parameters);
          if (sql === 'commit' || sql === 'rollback') client.query = query;
          return result;
        }) as typeof client.query;
        return client;
      });
    });
    const configuredHosts = new Set<NativeWebHost>();
    const configure = NativeWebHost.prototype.configureContext;
    const probe = vi
      .spyOn(NativeWebHost.prototype, 'configureContext')
      .mockImplementation(function (this: NativeWebHost, handler) {
        configuredHosts.add(this);
        configure.call(this, handler);
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
              id: 'prepared-cut-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model,
            };
            const choices = [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Synthetic fork gate response',
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
        "insert into project(id,name) values('poc','Synthetic fork gate')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','gate@fixture.invalid','fixture_gate',true)",
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
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Synthetic fork gate demand','','',$2,$2)",
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
      const options: Parameters<typeof buildApp>[0] = {
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
      };
      const bff = (app = buildApp(options));
      const login = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'fixture_gate', password },
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
          { timeout: 10_000 },
        );
        return page.records.map(({ event }) => event);
      };
      const select = async () => {
        const selected = await bff.inject({
          method: 'POST',
          url: `${sessions}/${sessionId}/model-selection`,
          headers,
          payload: { commandId: randomUUID(), provider, model: alpha },
        });
        expect(selected.statusCode).toBe(200);
        return selected.json<{
          selection: { provider: string; model: string; revision: string };
        }>().selection;
      };
      const send = async (requestId: string, target = sessionId) => {
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
                  sessionId: target,
                  requestId,
                  mode: 'queue',
                  content: [
                    { type: 'text', text: 'Synthetic fork gate prompt' },
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
      };
      const refuseChild = async (child: string, text: string) => {
        wire['x-rdws-client-generation'] = randomUUID();
        const refused = await bff.inject({
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
                  sessionId: child,
                  requestId: randomUUID(),
                  mode: 'queue',
                  content: [{ type: 'text', text }],
                },
              },
            },
          },
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({
          error: '请先为派生会话明确选择当前可用模型',
        });
      };
      const initial = await select();
      firstWriteFault = {
        requestId: first,
        phase: 'settle',
        outcome: 'rollback',
      };
      const planted = firstWriteFault;
      await send(first);
      await expect
        .poll(() => planted.completion, { timeout: 10_000, interval: 200 })
        .toBe('ROLLBACK');
      const events = await finish(1);
      firstWriteFault = undefined;
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      expect(
        events.filter(({ type }) => type === 'assistant/message'),
      ).toHaveLength(1);
      expect(usedForkModels(events, owner, requirement)).toMatchObject([
        { requestId: first, provider, model: alpha },
      ]);
      expect(
        (
          await lab.owner.query(
            'select state, selection_revision from session_model_first_write where native_session_id=$1 and selection_request_id=$2',
            [sessionId, first],
          )
        ).rows,
      ).toEqual([{ state: 'prepared', selection_revision: initial.revision }]);
      expect(
        (
          await lab.owner.query(
            'select state, accepted_seq::int as seq from session_prompt_dispatch where native_session_id=$1 and request_id=$2',
            [sessionId, first],
          )
        ).rows,
      ).toEqual([{ state: 'accepted', seq: expect.any(Number) }]);
      const cut = await forkBoundary(original, browser, sessionId);
      const forked = await bff.inject({
        method: 'POST',
        url: sessions + '/' + sessionId + '/fork',
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(forked.statusCode, forked.body).toBe(200);
      const child = forked.json<{ sessionId: string }>().sessionId;
      expect(child).not.toBe(sessionId);
      expect(
        (
          await lab.owner.query(
            'select source_session_id, source_through_seq::int as cut, owner_id from native_session where id=$1 and requirement_id=$2',
            [child, requirement],
          )
        ).rows,
      ).toEqual([{ source_session_id: sessionId, cut, owner_id: owner }]);
      const history = async (id: string) => {
        const result = await bff.inject({
          url:
            sessions + '/' + id + '/history?throughSeq=' + cut + '&pageSize=50',
          headers,
        });
        expect(result.statusCode).toBe(200);
        return result.json<{ events: { type: string; seq: number }[] }>()
          .events;
      };
      const parentHistory = await history(sessionId);
      expect(
        parentHistory.some(({ type }) => type === 'assistant/message'),
      ).toBe(true);
      expect(bodyHash(await history(child))).toBe(bodyHash(parentHistory));
      expect(
        (
          await lab.owner.query(
            "select command_id from command_receipt where operation='model.fork-source'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await bff.inject({
            url: sessions + '/' + child + '/model-selection',
            headers,
          })
        ).json(),
      ).toEqual({ selection: null, firstWrite: null });
      await refuseChild(child, 'Synthetic prepared-only descendant');
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      await bff.close();
      app = undefined;
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
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
  90_000,
);

test.skipIf(process.platform !== 'darwin')(
  'an accepted dispatch that never forms a step leaves a real fork child refused',
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
    const alpha = 'stepless-cut-a';
    const beta = 'stepless-cut-b';
    const first = randomUUID();
    const modelsReceived: string[] = [];
    let connections = 0;
    const second = randomUUID();
    const held = new Set<string>([second]);
    const rejected: { requestId: string; model: unknown }[] = [];
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
              id: 'stepless-cut-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model,
            };
            const choices = [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: 'Synthetic fork gate response',
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
        "insert into project(id,name) values('poc','Synthetic fork gate')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture','gate@fixture.invalid','fixture_gate',true)",
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
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Synthetic fork gate demand','','',$2,$2)",
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
      const options: Parameters<typeof buildApp>[0] = {
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
      };
      const bff = (app = buildApp(options));
      const login = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'fixture_gate', password },
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
          { timeout: 10_000 },
        );
        return page.records.map(({ event }) => event);
      };
      const select = async () => {
        const selected = await bff.inject({
          method: 'POST',
          url: `${sessions}/${sessionId}/model-selection`,
          headers,
          payload: { commandId: randomUUID(), provider, model: alpha },
        });
        expect(selected.statusCode).toBe(200);
        return selected.json<{
          selection: { provider: string; model: string; revision: string };
        }>().selection;
      };
      const send = async (requestId: string, target = sessionId) => {
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
                  sessionId: target,
                  requestId,
                  mode: 'queue',
                  content: [
                    { type: 'text', text: 'Synthetic fork gate prompt' },
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
      };
      const refuseChild = async (child: string, text: string) => {
        wire['x-rdws-client-generation'] = randomUUID();
        const refused = await bff.inject({
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
                  sessionId: child,
                  requestId: randomUUID(),
                  mode: 'queue',
                  content: [{ type: 'text', text }],
                },
              },
            },
          },
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toEqual({
          error: '请先为派生会话明确选择当前可用模型',
        });
      };
      await select();
      await send(first);
      const firstEvents = await finish(1);
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      expect(usedForkModels(firstEvents, owner, requirement)).toMatchObject([
        { requestId: first, provider, model: alpha },
      ]);
      expect(
        (
          await lab.owner.query(
            'select state from session_model_first_write where native_session_id=$1 and selection_request_id=$2',
            [sessionId, first],
          )
        ).rows,
      ).toEqual([{ state: 'submitted' }]);
      held.add(second);
      await send(second);
      const events = await finish(2);
      expect(rejected).toEqual([{ requestId: second, model: alpha }]);
      held.delete(second);
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      expect(
        (
          await lab.owner.query(
            'select state, accepted_seq::int as seq, accepted_message_id from session_prompt_dispatch where native_session_id=$1 and request_id=$2',
            [sessionId, second],
          )
        ).rows,
      ).toEqual([
        {
          state: 'accepted',
          seq: expect.any(Number),
          accepted_message_id: expect.any(String),
        },
      ]);
      expect(
        (
          await lab.owner.query(
            'select attempt_id from session_model_first_write where native_session_id=$1 and selection_request_id=$2',
            [sessionId, second],
          )
        ).rowCount,
      ).toBe(0);
      const starts = events.filter(({ type }) => type === 'step/start');
      expect(starts).toHaveLength(1);
      expect(starts[0]!.data.turn).toBe(1);
      const ends = events.filter(({ type }) => type === 'turn/end');
      expect(ends).toHaveLength(2);
      const secondEnd = ends[1]!;
      expect(secondEnd.data.turn).toBe(2);
      expect(isRecord(secondEnd.data.reason)).toBe(true);
      expect(
        isRecord(secondEnd.data.reason)
          ? secondEnd.data.reason.kind
          : undefined,
      ).not.toBe('completed');
      expect(usedForkModels(events, owner, requirement)).toBeUndefined();
      const cut = await forkBoundary(original, browser, sessionId);
      const forked = await bff.inject({
        method: 'POST',
        url: sessions + '/' + sessionId + '/fork',
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(forked.statusCode, forked.body).toBe(200);
      const child = forked.json<{ sessionId: string }>().sessionId;
      expect(child).not.toBe(sessionId);
      expect(
        (
          await lab.owner.query(
            'select source_session_id, source_through_seq::int as cut, owner_id from native_session where id=$1 and requirement_id=$2',
            [child, requirement],
          )
        ).rows,
      ).toEqual([{ source_session_id: sessionId, cut, owner_id: owner }]);
      const history = async (id: string) => {
        const result = await bff.inject({
          url:
            sessions + '/' + id + '/history?throughSeq=' + cut + '&pageSize=50',
          headers,
        });
        expect(result.statusCode).toBe(200);
        return result.json<{ events: { type: string; seq: number }[] }>()
          .events;
      };
      const parentHistory = await history(sessionId);
      expect(
        parentHistory.some(({ type }) => type === 'assistant/message'),
      ).toBe(true);
      expect(bodyHash(await history(child))).toBe(bodyHash(parentHistory));
      expect(
        (
          await lab.owner.query(
            "select command_id from command_receipt where operation='model.fork-source'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await bff.inject({
            url: sessions + '/' + child + '/model-selection',
            headers,
          })
        ).json(),
      ).toEqual({ selection: null, firstWrite: null });
      await refuseChild(child, 'Synthetic stepless descendant');
      expect(modelsReceived).toEqual([alpha]);
      expect(connections).toBe(1);
      await bff.close();
      app = undefined;
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
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
  90_000,
);
