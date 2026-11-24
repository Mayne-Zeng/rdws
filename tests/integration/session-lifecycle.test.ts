import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '@rdws/server';
import { fixtureBinding, observedLogin } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { actionAllowed, type Grant } from '@rdws/dsh/access';
import { forkBoundary } from '@rdws/dsh/sessions';
import { parseRemoteStreamServerMessage } from '@rdws/dsh/wire';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
loadEnvironment('test');
const pool = createTestPool('migration');
let account: { username: string; password: string };
let owner: string;
const ids: string[] = [];
beforeAll(async () => {
  owner = (
    await pool.query("select id from auth_user where username='manager'")
  ).rows[0].id;
  account = (await readTestAccounts()).find(
    (row) => row.username === 'manager',
  )!;
});
afterAll(async () => {
  for (const id of ids) {
    if (
      (await pool.query("select to_regclass('session_operation') present"))
        .rows[0].present
    )
      await pool.query(
        'delete from session_operation where requirement_id=$1',
        [id],
      );
    await pool.query('delete from native_session where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
  }
  await pool.end();
});
class Host extends NativeWebHost {
  calls: { action: string; input: Record<string, unknown> }[] = [];
  gate?: () => Promise<void>;
  lost = false;
  wrongWorkspace = false;
  attachFailed = false;
  notify?: () => Promise<void>;
  cursor = 5;
  constructor() {
    super('/tmp/rdws-session-lifecycle-test');
  }
  override async workspace(id: string) {
    return { cwd: join(this.demandRoot, id), workspaceId: 'w' };
  }
  override ticket() {
    return 'fixture-session-ticket';
  }
  override async control(_operation: string, input: Record<string, unknown>) {
    return {
      cwd: join(this.demandRoot, String(input.requirementId)),
      workspaceId: this.wrongWorkspace ? 'other' : 'w',
    };
  }
  override async fetch(
    path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    const request = JSON.parse(String(init.body));
    const action = path.slice('/api/'.length);
    const input = request.payload.args.request as Record<string, unknown>;
    if (action === 'session/events') {
      const cursor = Number(input.throughSeq ?? this.cursor);
      return Response.json({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            cursor,
            hasMore: false,
            records: [
              {
                type: 'event',
                event: { seq: 0, type: 'turn/start', data: {} },
              },
              {
                type: 'event',
                event: {
                  seq: 1,
                  type: 'user/message',
                  // Only this record carries a Native time; the route must
                  // pass it through and omit the field for the others.
                  time: 1_700_000_000_000,
                  surfaceOp: 'append',
                  data: {
                    source: { kind: 'user', principal: { secret: 'internal' } },
                    message: {
                      content: [{ type: 'text', text: '<b>history</b>' }],
                    },
                  },
                },
              },
              {
                type: 'event',
                event: {
                  seq: 2,
                  type: 'request/header',
                  data: { private: 'internal' },
                },
              },
              {
                type: 'event',
                event: {
                  seq: 3,
                  type: 'turn/end',
                  data: { reason: { kind: 'interrupted' } },
                },
              },
              {
                type: 'event',
                event: { seq: 4, type: 'session/title', data: {} },
              },
              {
                type: 'event',
                event: { seq: 5, type: 'turn/start', data: {} },
              },
            ].filter((r) => r.event.seq <= cursor),
          },
        },
      });
    }
    this.calls.push({ action, input });
    await this.gate?.();
    if (this.lost) throw new Error('Controlled lost Native response');
    if (this.attachFailed)
      return Response.json({
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'session/workspace-attach-failed',
            details: { sessionId: 'session-' + randomUUID(), workspaceId: 'w' },
          },
        },
      });
    return Response.json({
      rpcId: request.rpcId,
      result: { ok: true, value: { sessionId: 'session-' + randomUUID() } },
    });
  }
  override async revoke() {
    await this.notify?.();
  }
  override async close() {}
}
async function fixture(host = new Host()) {
  const id = randomUUID();
  ids.push(id);
  await pool.query(
    'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
    [id, 'poc', 'Lifecycle', 'test', 'test', owner, 'w'],
  );
  await pool.query(
    'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
    [id, owner, 'requirement_manager'],
  );
  const source = 'session-' + randomUUID();
  await pool.query(
    'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
    [source, id, owner],
  );
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin: process.env.RDWS_ORIGIN!,
    nativeHost: host,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    remoteAddress: '127.0.10.' + ids.length,
    url: '/api/auth/sign-in/username',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: account,
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const post = (commandId: string, fork = false) =>
    app.inject({
      method: 'POST',
      url: `/api/requirements/${id}/sessions${fork ? '/' + source + '/fork' : ''}`,
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId },
    });
  return { app, id, source, cookie, post, host };
}
const inferenceDiagnostic = 'synthetic-inference-diagnostic';
const inferenceFailure = {
  code: 'FIXTURE_PROVIDER_FAILURE',
  message: inferenceDiagnostic,
  requestId: inferenceDiagnostic,
};
const finish = {
  type: 'finish',
  reason: { kind: 'error', failure: inferenceFailure },
};
const failedStream = [{ type: 'chunk', time: 1, chunk: finish }];
const assistantMessage = {
  id: 'fixture-assistant',
  role: 'assistant',
  source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
  content: [{ type: 'text', text: 'Visible assistant reply' }],
};
const inferenceRecords = [
  {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 1,
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'fixture-user',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: inferenceDiagnostic }],
      },
    },
  },
  ...['assistant/attempt', 'assistant/message'].map((type, index) => ({
    type: 'event',
    event: {
      type,
      seq: index + 2,
      time: 1,
      ...(type === 'assistant/message' ? { surfaceOp: 'append' } : {}),
      data: {
        turn: 1,
        step: 1,
        ...(type === 'assistant/message'
          ? {
              message: {
                ...assistantMessage,
                source: {
                  ...assistantMessage.source,
                  replayState: inferenceDiagnostic,
                },
              },
              interrupted: true,
              stream: [
                {
                  type: 'chunk',
                  time: 1,
                  chunk: {
                    type: 'finish',
                    reason: { kind: 'aborted', failure: inferenceFailure },
                  },
                },
              ],
            }
          : { stream: failedStream }),
      },
    },
  })),
  {
    type: 'event',
    event: {
      type: 'llm/retry',
      seq: 4,
      time: 1,
      data: {
        retryId: 'fixture-retry',
        turn: 1,
        step: 1,
        provider: 'fixture',
        mode: inferenceDiagnostic,
        policyKey: 'normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 200.5,
        failure: inferenceFailure,
      },
    },
  },
  {
    type: 'event',
    event: {
      type: 'turn/end',
      seq: 5,
      time: 1,
      data: { turn: 1, reason: { kind: 'error', error: inferenceFailure } },
    },
  },
];
const opaqueExtension = {
  type: 'event',
  event: {
    type: 'supplier/' + inferenceDiagnostic,
    seq: 6,
    time: 2,
    ignorable: true,
    data: { raw: inferenceDiagnostic },
    surfaceOp: { diagnostic: inferenceDiagnostic },
  },
};
const redactedExtension = {
  type: 'event',
  event: { type: 'rdws/redacted', seq: 6, time: 2, ignorable: true, data: {} },
};
const replacement = {
  type: 'event',
  event: {
    type: 'user/message',
    seq: 7,
    time: 3,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [1],
    data: {
      id: 'replacement',
      role: 'user',
      source: { kind: 'model-selection' },
      content: [
        { type: 'text', text: 'Replacement' },
        {
          type: 'file',
          attachment: {
            attachmentId: 'fixture-file',
            name: 'fixture.txt',
            bytes: 3,
          },
        },
      ],
    },
  },
};
const noisyReplacement = {
  ...replacement,
  event: {
    ...replacement.event,
    data: {
      ...replacement.event.data,
      source: {
        kind: 'model-selection',
        rpcId: inferenceDiagnostic,
        clientTimeZone: inferenceDiagnostic,
      },
    },
  },
};
const malformedContext = {
  type: 'event',
  event: {
    type: 'user/message',
    seq: 8,
    time: 2,
    surfaceOp: 'append',
    data: {
      id: 'synthetic-attachment',
      role: 'user',
      source: { kind: 'rdws-context' },
      content: [
        {
          type: 'file',
          attachment: {
            attachmentId: 'synthetic-file',
            name: inferenceDiagnostic,
            bytes: 1,
          },
        },
      ],
    },
  },
};

test('Native inference diagnostics are projected from HTTP session history without modifying message text', async () => {
  const { app, id, source, cookie, host } = await fixture();
  host.ticket = () => 'synthetic-inference-ticket';
  const rpcId = randomUUID();
  const binding = await fixtureBinding(app, cookie, 'poc', id);
  async function read(method: string, response: Response) {
    host.fetch = async () => response;
    return app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/${method}`,
      headers: {
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-native-login': binding,
        'x-rdws-client-generation': randomUUID(),
      },
      payload: {
        type: 'client-request',
        rpcId,
        method,
        payload: {
          args: {
            request: { address: { kind: 'session', sessionId: source } },
          },
        },
      },
    });
  }
  const envelope = { type: 'server-response', rpcId };
  try {
    for (const method of ['session/page', 'session/events']) {
      const response = await read(
        method,
        Response.json(
          {
            ...envelope,
            result: {
              ok: true,
              value: {
                cursor: 8,
                hasMore: false,
                records: [
                  ...inferenceRecords,
                  opaqueExtension,
                  noisyReplacement,
                  malformedContext,
                ],
              },
            },
          },
          { headers: { 'x-native-diagnostic': inferenceDiagnostic } },
        ),
      );
      expect(response.statusCode).toBe(200);
      const { records, cursor, hasMore } = response.json().result.value;
      expect(records[0]).toEqual(inferenceRecords[0]);
      expect(JSON.stringify(records.slice(1))).not.toContain(
        inferenceDiagnostic,
      );
      expect(
        records.map((row: { event: { seq: number } }) => row.event.seq),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(records[5]).toEqual(redactedExtension);
      expect(records[6]).toEqual(replacement);
      expect(records[7]).toEqual({
        ...redactedExtension,
        event: { ...redactedExtension.event, seq: 8 },
      });
      expect(records[3].event.data).toMatchObject({
        retryId: 'fixture-retry',
        retry: 1,
        delayMs: 200.5,
      });
      expect(records[4].event.data.reason.kind).toBe('error');
      expect(records[1].event.data.stream[0].chunk.reason.kind).toBe('error');
      expect(records[2].event.data.message).toEqual(assistantMessage);
      expect(records[2].event.data.stream[0].chunk.reason.kind).toBe('aborted');
      expect(cursor).toBe(8);
      expect(hasMore).toBe(false);
      expect(response.headers['x-native-diagnostic']).toBeUndefined();
    }
    const error = await read(
      'session/page',
      Response.json({
        ...envelope,
        result: {
          ok: false,
          error: {
            code: 'gateway/internal',
            message: inferenceDiagnostic,
            details: { requestId: inferenceDiagnostic },
          },
        },
      }),
    );
    expect(error.statusCode).toBe(200);
    expect(error.body).not.toContain(inferenceDiagnostic);
    expect(error.json()).toMatchObject({
      ...envelope,
      result: { ok: false, error: { code: 'gateway/internal', details: {} } },
    });
    const malformed = await read(
      'session/page',
      new Response(inferenceDiagnostic, { status: 500 }),
    );
    expect(malformed.statusCode).toBe(503);
    expect(malformed.body).not.toContain(inferenceDiagnostic);
    expect(inferenceRecords[4]?.event.data).toEqual({
      turn: 1,
      reason: { kind: 'error', error: inferenceFailure },
    });
  } finally {
    await app.close();
  }
});

test('public Native reads retain only the state, summary and model projection fields', async () => {
  const { app, id, source, cookie, host } = await fixture();
  host.ticket = () => 'synthetic-inference-ticket';
  const binding = await fixtureBinding(app, cookie, 'poc', id);
  const selected = { provider: 'synthetic-provider', model: 'synthetic-model' };
  const projection = {
    asOfSeq: 7,
    values: { modelSelection: { next: selected, lastUsed: null } },
  };
  const state = {
    active: true,
    running: false,
    cursor: 7,
    pendingInput: ['question'],
    queue: [
      {
        id: 'queued-message',
        placement: 'queued',
        content: [
          {
            type: 'text',
            text: 'Keep the queued content ' + inferenceDiagnostic,
          },
        ],
      },
    ],
  };
  const summary = {
    sessionId: source,
    agentAvailable: true,
    running: false,
    updatedAt: 1,
    blank: false,
    projections: { kind: 'sequenced', ...projection },
  };
  const privateFields = { diagnostic: inferenceDiagnostic };
  const noisyProjection = {
    ...projection,
    ...privateFields,
    values: {
      modelSelection: {
        next: { ...selected, ...privateFields },
        lastUsed: null,
        ...privateFields,
      },
      vendorDetail: privateFields,
    },
  };
  async function read(method: string, value: unknown, expected: unknown) {
    const rpcId = randomUUID();
    host.fetch = async () =>
      Response.json({
        type: 'server-response',
        rpcId,
        result: { ok: true, value },
      });
    const response = await app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/${method}`,
      headers: {
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-native-login': binding,
        'x-rdws-client-generation': randomUUID(),
      },
      payload: {
        type: 'client-request',
        rpcId,
        method,
        payload: {
          args:
            method === 'session/list' ? {} : { request: { sessionId: source } },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().result).toEqual({ ok: true, value: expected });
  }
  try {
    await read(
      'session/state',
      {
        ...state,
        ...privateFields,
        queue: [
          ...state.queue.map((item) => ({
            ...item,
            ...privateFields,
            content: item.content.map((content) => ({
              ...content,
              ...privateFields,
            })),
          })),
          { id: 'invalid-item', placement: inferenceDiagnostic, content: [] },
        ],
      },
      state,
    );
    await read(
      'session/projections',
      { kind: 'sequenced', ...noisyProjection },
      { kind: 'sequenced', ...projection },
    );
    await read(
      'session/list',
      {
        ...privateFields,
        items: [
          {
            ...summary,
            ...privateFields,
            formatStatus: inferenceDiagnostic,
            origin: inferenceDiagnostic,
            projections: { kind: 'sequenced', ...noisyProjection },
          },
          {
            ...summary,
            running: inferenceDiagnostic,
            updatedAt: inferenceDiagnostic,
          },
        ],
      },
      { items: [summary] },
    );
  } finally {
    await app.close();
  }
});

test('Native inference diagnostics are projected from live and resumed WebSocket session frames', async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const { app, id, source, cookie, host } = await fixture();
  host.ticket = () => 'synthetic-inference-ticket';
  host.socketUrl = () =>
    `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let browser: WebSocket | undefined;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connected = once(upstream, 'connection');
    const binding = await fixtureBinding(app, cookie, 'poc', id);
    browser = new WebSocket(
      `${address.replace('http:', 'ws:')}/api/dsh/${id}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
      {
        headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      },
    );
    await once(browser, 'open');
    const [native] = (await connected) as [WebSocket];
    async function open(
      streamId: string,
      endpoint: string,
      args: Record<string, unknown>,
    ) {
      const sent = once(native, 'message');
      browser!.send(
        JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }),
      );
      await sent;
    }
    async function receive(frame: unknown) {
      const pending = once(browser!, 'message');
      native.send(JSON.stringify(frame));
      const [raw] = await pending;
      expect(() => parseRemoteStreamServerMessage(String(raw))).not.toThrow();
      return JSON.parse(String(raw));
    }
    await open('events', '$events', {});
    native.send(
      JSON.stringify({
        type: 'item',
        streamId: 'events',
        value: {
          type: 'emit',
          event: 'synthetic/unknown',
          args: [inferenceDiagnostic],
        },
      }),
    );
    const status = await receive({
      type: 'item',
      streamId: 'events',
      value: {
        type: 'emit',
        event: 'api-session/status',
        args: [source, true, inferenceDiagnostic],
        diagnostic: inferenceDiagnostic,
      },
    });
    expect(status.value).toEqual({
      type: 'emit',
      event: 'api-session/status',
      args: [source, true],
    });
    const emit = await receive({
      type: 'item',
      streamId: 'events',
      value: {
        type: 'emit',
        event: 'api-session/error',
        args: [source, inferenceDiagnostic],
      },
    });
    expect(JSON.stringify(emit)).not.toContain(inferenceDiagnostic);
    expect(emit.value).toMatchObject({
      event: 'api-session/error',
      args: [source, expect.any(String)],
    });

    const session = { address: { kind: 'session', sessionId: source } };
    const queued = {
      id: 'queued-message',
      role: 'user',
      source: { kind: 'user', rpcId: 'original-request' },
      content: [{ type: 'text', text: inferenceDiagnostic }],
    };
    await open('follow', 'session/follow', {
      request: { ...session, assistantStream: true },
    });
    const snapshot = await receive({
      type: 'item',
      streamId: 'follow',
      value: {
        type: 'snapshot',
        header: { id: source, version: 4, createdAt: 1, isSeeded: false },
        cursor: 6,
        hasMore: false,
        records: [...inferenceRecords, opaqueExtension],
        projections: {
          asOfSeq: 6,
          values: {
            inbox: {
              'next-step': [],
              'next-turn': [
                { content: [] },
                {
                  ...queued,
                  source: { ...queued.source, diagnostic: inferenceDiagnostic },
                  content: [
                    { ...queued.content[0], diagnostic: inferenceDiagnostic },
                  ],
                },
              ],
              diagnostic: inferenceDiagnostic,
            },
          },
        },
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId: 'attempt',
            turn: 1,
            step: 1,
            startedAfterSeq: 6,
            nextIndex: 2,
            stream: [
              ...failedStream,
              {
                type: 'text-chunks',
                time0: 1,
                index: 0,
                dt: [],
                texts: ['Buffered content'],
                providerDiagnostic: inferenceDiagnostic,
              },
            ],
          },
        },
      },
    });
    expect(snapshot.value.records[0]).toEqual(inferenceRecords[0]);
    expect(snapshot.value.records[2].event.data.message).toEqual(
      assistantMessage,
    );
    expect(JSON.stringify(snapshot.value.records.slice(1))).not.toContain(
      inferenceDiagnostic,
    );
    expect(JSON.stringify(snapshot.value.assistantStream)).not.toContain(
      inferenceDiagnostic,
    );
    expect(snapshot.value.records.at(-1)).toEqual(redactedExtension);
    expect(snapshot.value.assistantStream.activeAttempt.nextIndex).toBe(2);
    expect(
      snapshot.value.assistantStream.activeAttempt.stream[1].texts,
    ).toEqual(['Buffered content']);
    expect(snapshot.value.projections).toEqual({
      asOfSeq: 6,
      values: { inbox: { 'next-step': [], 'next-turn': [queued] } },
    });
    const chunk = await receive({
      type: 'item',
      streamId: 'follow',
      value: {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt',
          revision: 3,
          index: 2,
          time: 1,
          chunk: finish,
        },
      },
    });
    expect(JSON.stringify(chunk)).not.toContain(inferenceDiagnostic);
    expect(chunk.value.frame).toMatchObject({
      index: 2,
      revision: 3,
      chunk: { type: 'finish', reason: { kind: 'error' } },
    });
    const end = {
      type: 'item',
      streamId: 'follow',
      value: {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt',
          revision: 4,
          index: 3,
          outcome: {
            kind: 'committed',
            eventType: 'assistant/attempt',
            seq: 2,
          },
        },
      },
    };
    expect(await receive(end)).toEqual(end);
    expect(
      (
        await receive({
          type: 'item',
          streamId: 'follow',
          value: noisyReplacement,
        })
      ).value,
    ).toEqual(replacement);
    await open('observe', 'session/observeEvent', { request: session });
    const event = await receive({
      type: 'item',
      streamId: 'observe',
      value: inferenceRecords[3],
    });
    expect(JSON.stringify(event)).not.toContain(inferenceDiagnostic);
    expect(event.value.event).toMatchObject({
      type: 'llm/retry',
      seq: 4,
      data: { retry: 1, delayMs: 200.5 },
    });
    const completed = await receive({
      type: 'item',
      streamId: 'observe',
      value: inferenceRecords[4],
    });
    expect(JSON.stringify(completed)).not.toContain(inferenceDiagnostic);
    expect(completed.value.event).toMatchObject({ type: 'turn/end', seq: 5 });
    expect(
      (
        await receive({
          type: 'item',
          streamId: 'observe',
          value: opaqueExtension,
        })
      ).value,
    ).toEqual(redactedExtension);
    const retryStarted = await receive({
      type: 'item',
      streamId: 'observe',
      value: {
        type: 'event',
        event: {
          type: 'llm/retry-started',
          seq: 7,
          time: 3,
          data: {
            retryId: 'next',
            turn: 1,
            step: 1,
            retry: 1,
            provider: inferenceDiagnostic,
          },
        },
      },
    });
    expect(retryStarted.value.event.data).toEqual({
      retryId: 'next',
      turn: 1,
      step: 1,
      retry: 1,
    });
    const logicalError = await receive({
      type: 'error',
      streamId: 'observe',
      error: {
        code: 'supplier/private-diagnostic',
        message: inferenceDiagnostic,
        details: { requestId: inferenceDiagnostic },
      },
    });
    expect(JSON.stringify(logicalError)).not.toContain(inferenceDiagnostic);
    expect(logicalError).toMatchObject({
      type: 'error',
      streamId: 'observe',
      error: { code: 'gateway/internal', details: {} },
    });
    expect(browser.readyState).toBe(WebSocket.OPEN);

    const closed = once(browser, 'close');
    native.send(inferenceDiagnostic);
    expect((await closed)[0]).toBe(4001);
  } finally {
    browser?.terminate();
    for (const client of upstream.clients) client.terminate();
    await Promise.all([
      app.close(),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
test('the model catalog forwards available models without exposing Native diagnostics', async () => {
  const { app, id, cookie, host } = await fixture();
  const diagnostic = 'synthetic-private-provider-diagnostic';
  const rpcId = randomUUID();
  const model = { id: 'test-model', name: 'Test model' };
  const reasoning = {
    efforts: [{ id: 'high', name: 'High' }],
    defaultEffort: 'high',
  };
  const badge = { text: { en: 'Preview', 'zh-cn': '预览' }, tone: 'info' };
  const catalog = {
    default: { provider: 'available', model: model.id },
    groups: [
      {
        id: 'available',
        name: 'Available',
        models: [{ ...model, reasoning, badge }],
      },
    ],
    routableProviders: ['available'],
    failures: [{ id: 'unavailable', name: 'Unavailable', message: diagnostic }],
  };
  host.ticket = () => 'synthetic-catalog-ticket';
  const binding = await fixtureBinding(app, cookie, 'poc', id);
  async function requestCatalog(
    response: Response,
    requestId: unknown = rpcId,
  ) {
    host.fetch = async () => response;
    return app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/session/modelCatalog`,
      headers: {
        'x-rdws-native-login': binding,
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-client-generation': randomUUID(),
      },
      payload: {
        type: 'client-request',
        rpcId: requestId,
        method: 'session/modelCatalog',
        payload: { args: {} },
      },
    });
  }
  const envelope = { type: 'server-response', rpcId };
  try {
    const partial = await requestCatalog(
      Response.json(
        {
          ...envelope,
          result: {
            ok: true,
            value: {
              ...catalog,
              default: { ...catalog.default, apiKey: diagnostic },
              groups: [
                {
                  ...catalog.groups[0],
                  endpoint: diagnostic,
                  models: [
                    {
                      ...model,
                      credentials: { token: diagnostic },
                      reasoning: {
                        defaultEffort: diagnostic,
                        efforts: [
                          { ...reasoning.efforts[0], stack: diagnostic },
                        ],
                      },
                      badge: {
                        ...badge,
                        text: {
                          ...badge.text,
                          BAD_KEY: diagnostic,
                          es: diagnostic,
                        },
                        service: diagnostic,
                      },
                    },
                  ],
                },
              ],
              routableProviders: ['available', 1, diagnostic, 'available'],
            },
          },
        },
        { headers: { 'x-native-diagnostic': diagnostic } },
      ),
    );
    expect(partial.statusCode).toBe(200);
    expect(partial.body).not.toContain(diagnostic);
    expect(partial.headers['x-native-diagnostic']).toBeUndefined();
    expect(partial.headers['cache-control']).toBe('no-store');
    expect(partial.json()).toEqual({
      ...envelope,
      result: {
        ok: true,
        value: {
          ...catalog,
          groups: [
            {
              ...catalog.groups[0],
              models: [
                { ...model, badge, reasoning: { efforts: reasoning.efforts } },
              ],
            },
          ],
          failures: [
            {
              id: 'unavailable',
              name: 'Unavailable',
              message: '供应商模型目录暂不可用',
            },
          ],
        },
      },
    });

    const valid = await requestCatalog(
      Response.json({
        ...envelope,
        result: { ok: true, value: catalog },
      }),
    );
    expect(valid.json().result.value.groups[0].models[0].reasoning).toEqual(
      reasoning,
    );

    const failure = await requestCatalog(
      Response.json({
        ...envelope,
        result: {
          ok: false,
          error: {
            code: 'gateway/internal',
            message: diagnostic,
            details: { diagnostic },
          },
        },
      }),
    );
    expect(failure.statusCode).toBe(200);
    expect(failure.json()).toEqual({
      ...envelope,
      result: {
        ok: false,
        error: {
          code: 'gateway/internal',
          message: '模型目录暂不可用',
          details: {},
        },
      },
    });

    for (const status of [200, 502]) {
      const malformed = await requestCatalog(
        new Response(diagnostic, { status }),
      );
      expect(malformed.statusCode).toBe(503);
      expect(malformed.body).not.toContain(diagnostic);
    }
    for (const [status, requestId] of [
      [502, rpcId],
      [200, 17],
    ] as const) {
      let canceled = false;
      const body = new ReadableStream({
        cancel() {
          canceled = true;
        },
      });
      const rejected = await requestCatalog(
        new Response(body, { status }),
        requestId,
      );
      expect(rejected.statusCode).toBe(503);
      expect(canceled).toBe(true);
    }
    const mismatched = await requestCatalog(
      Response.json({
        ...envelope,
        rpcId: randomUUID(),
        result: { ok: true, value: catalog },
      }),
    );
    expect(mismatched.statusCode).toBe(503);
    expect(mismatched.body).not.toContain(diagnostic);
  } finally {
    await app.close();
  }
});
test('one create command survives concurrent retry and returns the same Native id', async () => {
  const f = await fixture();
  try {
    const command = randomUUID();
    const results = await Promise.all([f.post(command), f.post(command)]);
    expect(results.every((r) => [200, 202].includes(r.statusCode))).toBe(true);
    const done = await f.post(command);
    expect(done.statusCode).toBe(200);
    expect(done.json().sessionId).toBeTruthy();
    expect(f.host.calls).toHaveLength(1);
    expect((await f.post(command)).json().sessionId).toBe(
      done.json().sessionId,
    );
  } finally {
    await f.app.close();
  }
});
test('fork freezes the last closed logical prefix and maps provenance once', async () => {
  const f = await fixture();
  try {
    const command = randomUUID(),
      r = await f.post(command, true);
    expect(r.statusCode).toBe(200);
    expect(f.host.calls).toEqual([
      {
        action: 'session/fork',
        input: { sessionId: f.source, atSeq: 4, allowMigration: false },
      },
    ]);
    const child = (
      await pool.query('select * from native_session where id=$1', [
        r.json().sessionId,
      ])
    ).rows[0];
    expect(child.source_session_id).toBe(f.source);
    expect(child.source_through_seq).toBe(4);
    expect((await f.post(command, true)).json().sessionId).toBe(child.id);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await f.app.close();
  }
});
test('session writes check the observed login before preparing Native or using a receipt', async () => {
  const f = await fixture();
  const workspace = vi.spyOn(f.host, 'workspace');
  const control = vi.spyOn(f.host, 'control');
  const origin = process.env.RDWS_ORIGIN!;
  try {
    const oldLogin = await observedLogin(f.app, f.cookie);
    const relogin = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: '127.0.20.1',
      headers: { origin },
      payload: account,
    });
    expect(relogin.statusCode).toBe(200);
    const cookie = relogin.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const current = await observedLogin(f.app, cookie);
    expect(current).not.toBe(oldLogin);
    const directory = `/api/requirements/${f.id}/sessions`;
    for (const [operation, url] of [
      ['create', directory],
      ['fork', `${directory}/${f.source}/fork`],
    ] as const) {
      const commandId = randomUUID();
      const receipts = () =>
        pool.query(
          'select command_id, actor_id, status from session_operation where requirement_id=$1 and command_id=$2',
          [f.id, commandId],
        );
      const dispatches = f.host.calls.length;
      const sessions = () =>
        pool.query(
          'select id from native_session where requirement_id=$1 order by id',
          [f.id],
        );
      const before = (await sessions()).rows;
      workspace.mockClear();
      control.mockClear();
      for (const headers of [
        { cookie, 'x-rdws-edit-session': oldLogin },
        { cookie, 'x-rdws-edit-session': [current, current] },
        { 'x-rdws-edit-session': current },
      ]) {
        const result = await f.app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin },
          payload: { commandId },
        });
        expect(result.statusCode).toBe(401);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      expect(workspace).not.toHaveBeenCalled();
      expect(control).not.toHaveBeenCalled();
      expect(f.host.calls).toHaveLength(dispatches);
      expect((await receipts()).rows).toEqual([]);
      expect((await sessions()).rows).toEqual(before);

      const mapped = await f.app.inject({
        method: 'POST',
        url,
        headers: { cookie: f.cookie, origin, 'x-rdws-edit-session': oldLogin },
        payload: { commandId },
      });
      expect(mapped.statusCode).toBe(200);
      expect(mapped.headers['cache-control']).toBe('no-store');
      const child = mapped.json().sessionId;
      expect((await receipts()).rows).toEqual([
        { actor_id: owner, command_id: commandId, status: 'mapped' },
      ]);
      expect(f.host.calls).toHaveLength(dispatches + 1);
      expect(f.host.calls.at(-1)?.action).toBe('session/' + operation);
      if (operation === 'fork') {
        expect(f.host.calls.at(-1)?.input).toMatchObject({
          sessionId: f.source,
          atSeq: 4,
        });
      }

      const staleReceipt = await f.app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin, 'x-rdws-edit-session': oldLogin },
        payload: { commandId },
      });
      expect(staleReceipt.statusCode).toBe(401);
      expect(staleReceipt.body).not.toContain(child);
      const replay = await f.app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin, 'x-rdws-edit-session': current },
        payload: { commandId },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().sessionId).toBe(child);
      const legacy = await f.post(commandId, operation === 'fork');
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json().sessionId).toBe(child);
      expect(f.host.calls).toHaveLength(dispatches + 1);
    }
  } finally {
    await f.app.close();
  }
});
test('unknown Native result never dispatches again after retry or BFF restart', async () => {
  const f = await fixture();
  f.host.lost = true;
  const command = randomUUID();
  try {
    expect((await f.post(command)).json().status).toBe('unknown');
    expect((await f.post(command)).json().status).toBe('unknown');
    await f.app.close();
    const app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin: process.env.RDWS_ORIGIN!,
      nativeHost: f.host,
    });
    try {
      const retry = await app.inject({
        method: 'POST',
        url: `/api/requirements/${f.id}/sessions`,
        headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
        payload: { commandId: command },
      });
      expect(retry.json().status).toBe('unknown');
      expect(f.host.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
  }
});
test('fork cannot use somebody else, another requirement or a mismatched workspace', async () => {
  const f = await fixture();
  try {
    const other = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    await pool.query('update native_session set owner_id=$1 where id=$2', [
      other,
      f.source,
    ]);
    expect((await f.post(randomUUID(), true)).statusCode).toBe(403);
    await pool.query('update native_session set owner_id=$1 where id=$2', [
      owner,
      f.source,
    ]);
    f.host.wrongWorkspace = true;
    expect((await f.post(randomUUID(), true)).statusCode).toBe(409);
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('logout while Native is running retains evidence but does not map the new session', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.gate = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const pending = f.post(randomUUID());
    await ready;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    release();
    expect((await pending).statusCode).toBe(401);
    expect(
      (
        await pool.query(
          'select id from native_session where requirement_id=$1',
          [f.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          'select native_session_id from session_operation where requirement_id=$1',
          [f.id],
        )
      ).rows[0].native_session_id,
    ).toBeTruthy();
  } finally {
    release();
    await f.app.close();
  }
});
test('fork capability binds source and cut without giving browsers fork access', () => {
  const grant = {
    aud: 'test',
    purpose: 'fork',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'test',
    sourceSessionId: 's',
    atSeq: 4,
  } as unknown as Grant;
  const args = { request: { sessionId: 's', atSeq: 4, allowMigration: false } };
  expect(actionAllowed(grant, 'session/fork', args)).toBe(true);
  expect(
    actionAllowed(
      {
        ...grant,
        purpose: 'browser',
        readSessionIds: ['s'],
        ownSessionIds: ['s'],
      },
      'session/fork',
      args,
    ),
  ).toBe(false);
  for (const request of [
    { ...args.request, sessionId: 'other' },
    { ...args.request, atSeq: 5 },
    { ...args.request, cwd: '/wrong' },
  ])
    expect(actionAllowed(grant, 'session/fork', { request })).toBe(false);
});
test('passive replay returns a safe fixed-cut projection without activating Native', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      url: `/api/requirements/${f.id}/sessions/${f.source}/history?throughSeq=3`,
      headers: { cookie: f.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().cursor).toBe(3);
    expect(response.json().events.map((e: { type: string }) => e.type)).toEqual(
      ['turn/start', 'user/message', 'turn/end'],
    );
    // The Native time passes through so the trace can show it; a record
    // without one simply leaves the field out.
    expect(
      response.json().events.map((e: { time?: number }) => e.time),
    ).toEqual([undefined, 1_700_000_000_000, undefined]);
    expect(response.body).toContain('<b>history</b>');
    expect(response.body).not.toContain('principal');
    expect(response.body).not.toContain('internal');
    expect(response.json().events.at(-1).outcome).toBe('已中断');
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('a known child repairs mapping with its frozen cut after another BFF generation', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID(),
      child = 'session-' + randomUUID();
    const { digestOf } =
      await import('../../apps/server/src/modules/business.ts');
    await pool.query(
      'insert into session_operation(id,actor_id,requirement_id,operation,command_id,digest,status,generation,source_session_id,frozen,native_session_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        randomUUID(),
        owner,
        f.id,
        'fork',
        commandId,
        digestOf({ operation: 'fork', sourceSessionId: f.source }),
        'native-created',
        'old',
        f.source,
        { workspaceId: 'w', cwd: join(f.host.demandRoot, f.id), atSeq: 1 },
        child,
      ],
    );
    f.host.cursor = 500;
    const response = await f.post(commandId, true);
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBe(child);
    expect(
      (
        await pool.query(
          'select source_through_seq from native_session where id=$1',
          [child],
        )
      ).rows[0].source_through_seq,
    ).toBe(1);
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('a frozen dispatched operation from a lost process becomes unknown without redispatch', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID();
    const { digestOf } =
      await import('../../apps/server/src/modules/business.ts');
    await pool.query(
      'insert into session_operation(id,actor_id,requirement_id,operation,command_id,digest,status,generation,frozen) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        owner,
        f.id,
        'create',
        commandId,
        digestOf({ operation: 'create', sourceSessionId: null }),
        'dispatched',
        'old',
        { workspaceId: 'w', cwd: join(f.host.demandRoot, f.id) },
      ],
    );
    expect((await f.post(commandId)).json().status).toBe('unknown');
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('retry during an in-flight dispatch stays pending and cannot start another Native call', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.gate = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const commandId = randomUUID(),
      pending = f.post(commandId);
    await ready;
    const retry = await f.post(commandId);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().status).toBe('dispatched');
    expect(f.host.calls).toHaveLength(1);
    release();
    expect((await pending).statusCode).toBe(200);
    expect((await f.post(commandId)).json().status).toBe('mapped');
    expect(f.host.calls).toHaveLength(1);
  } finally {
    release();
    await f.app.close();
  }
});
test('a failed PG mapping keeps the known child and the frozen cut for a later repair', async () => {
  const f = await fixture();
  f.host.gate = async () => {
    await pool.query('revoke insert on native_session from rdws_test_app');
  };
  try {
    const commandId = randomUUID();
    expect((await f.post(commandId, true)).statusCode).toBe(500);
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    expect(record.status).toBe('native-created');
    expect(record.native_session_id).toBeTruthy();
    expect(record.frozen.atSeq).toBe(4);
    await pool.query('grant insert on native_session to rdws_test_app');
    f.host.cursor = 500;
    expect((await f.post(commandId, true)).json().sessionId).toBe(
      record.native_session_id,
    );
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant insert on native_session to rdws_test_app');
    await f.app.close();
  }
});
test('a failed Native-result write preserves a private orphan record and repairs without redispatch', async () => {
  const f = await fixture();
  f.host.gate = async () => {
    await pool.query('revoke update on session_operation from rdws_test_app');
  };
  try {
    const commandId = randomUUID(),
      first = await f.post(commandId);
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('unknown');
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    const file = join(
      f.host.runtimeHome,
      'state/exports',
      'session-operation-' + record.id + '.json',
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const { stat } = await import('node:fs/promises');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(saved.sessionId).toBeTruthy();
    await pool.query('grant update on session_operation to rdws_test_app');
    expect((await f.post(commandId)).json().sessionId).toBe(saved.sessionId);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant update on session_operation to rdws_test_app');
    await f.app.close();
  }
});
test('fork command cannot be replayed against another source or accept client-controlled settings', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID();
    expect((await f.post(commandId, true)).statusCode).toBe(200);
    const another = 'session-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [another, f.id, owner],
    );
    const changed = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions/${another}/fork`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId },
    });
    expect(changed.statusCode).toBe(409);
    const forged = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId: randomUUID(), actor: owner, agentPreset: 'unsafe' },
    });
    expect(forged.statusCode).toBe(400);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await f.app.close();
  }
});
test('a fork boundary can cross pages and stops before the next append input', async () => {
  const host = new Host();
  host.fetch = async (_path, _grant, init = {}) => {
    const rpc = JSON.parse(String(init.body));
    const before = rpc.payload.args.request.beforeSeq;
    const events =
      before === undefined
        ? [
            { seq: 4, type: 'user/message', surfaceOp: 'append', data: {} },
            { seq: 5, type: 'turn/start', data: {} },
            { seq: 6, type: 'step/start', data: {} },
          ]
        : [
            { seq: 0, type: 'turn/start', data: {} },
            {
              seq: 1,
              type: 'turn/end',
              data: { reason: { kind: 'completed' } },
            },
            { seq: 2, type: 'session/title', data: {} },
            { seq: 3, type: 'session/title', data: {} },
          ];
    return Response.json({
      rpcId: rpc.rpcId,
      result: {
        ok: true,
        value: {
          cursor: 6,
          hasMore: before === undefined,
          records: events.map((event) => ({ type: 'event', event })),
        },
      },
    });
  };
  const grant = { purpose: 'browser' as const, readSessionIds: ['s'] };
  expect(await forkBoundary(host, grant, 's')).toBe(3);
  host.fetch = async (_path, _grant, init = {}) =>
    Response.json({
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: { ok: true, value: { cursor: -1, hasMore: false, records: [] } },
    });
  expect(await forkBoundary(host, grant, 's')).toBeUndefined();
  host.fetch = async (_path, _grant, init = {}) =>
    Response.json({
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: { ok: true, value: { cursor: 6, hasMore: true, records: [] } },
    });
  await expect(forkBoundary(host, grant, 's')).rejects.toThrow('no progress');
});
test('legacy create without a request body remains supported', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBeTruthy();
  } finally {
    await f.app.close();
  }
});
test('an empty-source rejection is terminal and cannot later dispatch under the same key', async () => {
  const f = await fixture();
  try {
    const original = f.host.fetch.bind(f.host);
    f.host.fetch = async (path, grant, init = {}) =>
      path === '/api/session/events'
        ? Response.json({
            rpcId: JSON.parse(String(init.body)).rpcId,
            result: {
              ok: true,
              value: { cursor: -1, hasMore: false, records: [] },
            },
          })
        : original(path, grant, init);
    const commandId = randomUUID(),
      rejected = await f.post(commandId, true);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().status).toBe('rejected');
    f.host.fetch = original;
    expect((await f.post(commandId, true)).json().status).toBe('rejected');
    expect(f.host.calls).toHaveLength(0);
    expect((await f.post(randomUUID())).statusCode).toBe(200);
  } finally {
    await f.app.close();
  }
});
test('a known child in an attach error also survives a PG result-write failure', async () => {
  const f = await fixture();
  f.host.attachFailed = true;
  f.host.gate = async () => {
    await pool.query('revoke update on session_operation from rdws_test_app');
  };
  try {
    const commandId = randomUUID(),
      first = await f.post(commandId, true);
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('unknown');
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    const saved = JSON.parse(
      await readFile(
        join(
          f.host.runtimeHome,
          'state/exports',
          'session-operation-' + record.id + '.json',
        ),
        'utf8',
      ),
    );
    expect(saved.sessionId).toBeTruthy();
    await pool.query('grant update on session_operation to rdws_test_app');
    const retry = await f.post(commandId, true);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().sessionId).toBe(saved.sessionId);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant update on session_operation to rdws_test_app');
    await f.app.close();
  }
});
test('permission is checked again after the mapping notification wait', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.notify = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const pending = f.post(randomUUID());
    await ready;
    await pool.query('update auth_user set active=false where id=$1', [owner]);
    release();
    expect((await pending).statusCode).toBe(401);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    release();
    await pool.query('update auth_user set active=true where id=$1', [owner]);
    await f.app.close();
  }
});
