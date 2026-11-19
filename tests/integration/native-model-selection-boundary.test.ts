import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';

const selectionProbe = String.raw`
export function apply(ctx, { provider, picks }) {
  const pending = new WeakMap();
  const completed = new WeakMap();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') pending.delete(session);
    if (event.type !== 'agent/inbox/spliced') return;
    const { outcome, removedCount, inserted } = event.data;
    if (outcome || !removedCount || inserted.length) return;
    const batch = pending.get(session) ?? { count: 0, messages: [] };
    batch.count += removedCount;
    pending.set(session, batch);
  }, { global: true });
  ctx.on('agent/inbox/claimed', ({ agent, turn, message }) => {
    const batch = pending.get(agent.session);
    if (!batch) return;
    batch.messages.push(message);
    if (batch.messages.length !== batch.count) return;
    pending.delete(agent.session);
    const requestIds = batch.messages.map(({ source }) =>
      source.kind === 'user' && source.principal?.kind === 'rdws' ? source.rpcId : undefined,
    );
    const selected = requestIds.map(id => Object.hasOwn(picks, id) ? picks[id] : undefined);
    const pick = selected[0];
    const consistent = requestIds.every(Boolean)
      && selected.every(choice => choice?.revision === pick?.revision && choice?.model === pick?.model);
    completed.set(agent, { turn, requestIds, consistent, pick });
    if (consistent && pick) agent.model.select({ provider, model: pick.model });
  }, { global: true });
  ctx.on('agent/pre-step', async ({ agent, messages, turn, modelSelection }, next) => {
    if (!messages.length) return next();
    const batch = completed.get(agent);
    completed.delete(agent);
    if (!batch?.consistent || batch.turn !== turn || batch.requestIds.length !== messages.length
      || messages.some(({ source }, i) => source.rpcId !== batch.requestIds[i])
      || (batch.pick && (modelSelection.provider !== provider || modelSelection.model !== batch.pick.model)))
      return { kind: 'reject' };
    return next();
  }, { global: true });
}
`;

type Event = {
  type: string;
  seq: number;
  data: {
    turn?: number;
    step?: number;
    model?: string;
    target?: string;
    inserted?: { source?: { rpcId?: string } }[];
    source?: { rpcId?: string };
    removedCount?: number;
    outcome?: string;
    reason?: { kind: string };
  };
};

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { release, wait };
}

test('complete Native inbox claims fix one model before an actual step and reject competing revisions', async () => {
  const provider = 'rdws-glm';
  const originalModel = 'fixture-base-model';
  const selectedModel = 'fixture-selected-model';
  const positive = {
    start: 'Synthetic accepted first step',
    steer: ['Synthetic accepted steer one', 'Synthetic accepted steer two'],
  };
  const negative = {
    start: 'Synthetic rejected first step',
    steer: ['Synthetic rejected steer one', 'Synthetic rejected steer two'],
  };
  const sameValue = {
    start: 'Synthetic same-value first step',
    steer: ['Synthetic same-value steer one', 'Synthetic same-value steer two'],
  };
  const positiveIds = [randomUUID(), randomUUID()];
  const conflicts = [
    {
      scenario: negative,
      ids: [randomUUID(), randomUUID()],
      secondModel: originalModel,
    },
    {
      scenario: sameValue,
      ids: [randomUUID(), randomUUID()],
      secondModel: selectedModel,
    },
  ];
  const picks = Object.fromEntries([
    ...positiveIds.map((id) => [
      id,
      { revision: 'shared', model: selectedModel },
    ]),
    ...conflicts.flatMap(({ ids, secondModel }) => [
      [ids[0], { revision: 'first', model: selectedModel }],
      [ids[1], { revision: 'second', model: secondModel }],
    ]),
  ]);
  const holds = new Map(
    [positive, ...conflicts.map(({ scenario }) => scenario)].map(
      ({ start }) => [start, latch()],
    ),
  );
  const arrivals: { model: string; text: string }[] = [];
  let requests = 0;
  const supplier = createServer(async (request, response) => {
    requests++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const { model } = JSON.parse(text) as { model: string };
      arrivals.push({ text, model });
      for (const [start, hold] of holds)
        if (text.includes(start)) await hold.wait;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        {
          delta: { role: 'assistant', content: 'Synthetic inference reply' },
          finish_reason: null,
        },
        { delta: {}, finish_reason: 'stop' },
      ])
        response.write(
          'data: ' +
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion.chunk',
              created: 1,
              model,
              choices: [{ index: 0, ...choice }],
            }) +
            '\n\n',
        );
      response.end('data: [DONE]\n\n');
    } catch {
      response.destroy();
    }
  });
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-native-selection-'),
  );
  const config = join(root, 'config/projects/selection/dsh');
  const profile = join(config, 'profiles/rdws');
  const host = new NativeWebHost(root, config, 'selection');
  const requirementId = randomUUID();
  const userId = randomUUID();
  const authSessionId = randomUUID();
  const runs = new ContextRuns(
    host.contextGeneration,
    (token) => host.verifyContext(token),
    async () => ({
      value: {
        snapshot: { requirementId, contextVersion: 1 },
        digest: 'synthetic-context',
      },
      validBefore: Infinity,
    }),
    () => false,
  );
  host.configureContext((input, token, reply) =>
    runs.handle(input, token, reply),
  );
  try {
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const address = supplier.address() as { port: number };
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const adapter = join(profile, 'selection-probe.mjs');
    await writeFile(adapter, selectionProbe, { mode: 0o600 });
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: 'synthetic-selection-only' },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        {
          id: 'agent-default-model',
          config: { provider, model: originalModel },
        },
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              [provider]: {
                api: 'openai-completions',
                baseURL: 'http://127.0.0.1:' + address.port + '/v1',
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: originalModel }, { id: selectedModel }],
              },
            },
          },
        },
        {
          insert: [
            {
              id: 'fixture-selection-boundary',
              name: adapter,
              config: { provider, picks },
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );

    await host.start();
    const workspace = await host.workspace(
      requirementId,
      'Synthetic selection',
    );
    const identity = { userId, authSessionId, requirementId, ...workspace };
    const grant = (sessionId: string) => ({
      ...identity,
      purpose: 'browser' as const,
      readSessionIds: [sessionId],
      ownSessionIds: [sessionId],
    });
    async function rpc<T>(method: string, args: object, ticket: string) {
      const response = await host.fetch('/api/' + method, ticket, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args },
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()).result as {
        ok: boolean;
        value: T;
      };
      expect(result.ok).toBe(true);
      return result.value;
    }
    const create = async () =>
      (
        await rpc<{ sessionId: string }>(
          'session/create',
          { request: { workspaceId: workspace.workspaceId } },
          host.ticket({ ...identity, purpose: 'create' }),
        )
      ).sessionId;
    async function send(
      sessionId: string,
      text: string,
      mode: 'queue' | 'steer' = 'queue',
      requestId: string = randomUUID(),
    ) {
      const ticket = host.ticket(grant(sessionId));
      const binding = runs.admit(
        identity,
        requirementId,
        sessionId,
        requestId,
        host.claims(ticket)!.nonce,
      );
      await host.control('run', { ...binding, authSessionId });
      expect(
        await rpc(
          'session/prompt',
          {
            request: {
              sessionId,
              content: [{ type: 'text', text }],
              mode,
              requestId,
            },
          },
          ticket,
        ),
      ).toMatchObject({ accepted: true });
    }
    async function records(sessionId: string) {
      const result = await rpc<{ records: { event: Event }[] }>(
        'session/events',
        { request: { address: { kind: 'session', sessionId } } },
        host.ticket(grant(sessionId)),
      );
      return result.records.map(({ event }) => event);
    }

    async function startPair(
      sessionId: string,
      scenario: typeof positive,
      ids: string[],
    ) {
      const offset = arrivals.length;
      const requestsBefore = requests;
      await send(sessionId, scenario.start);
      await expect.poll(() => arrivals.length).toBe(offset + 1);
      expect(arrivals[offset]).toMatchObject({
        model: originalModel,
        text: expect.stringContaining(scenario.start),
      });
      for (const [index, text] of scenario.steer.entries())
        await send(sessionId, text, 'steer', ids[index]);
      const inBox = (await records(sessionId)).filter(
        ({ type, data }) =>
          type === 'agent/inbox/spliced' && data.target === 'next-step',
      );
      expect(
        inBox
          .flatMap(({ data }) => data.inserted ?? [])
          .map(({ source }) => source?.rpcId),
      ).toEqual(ids);
      expect(requests - requestsBefore).toBe(1);
      holds.get(scenario.start)!.release();
      return { offset, requestsBefore };
    }
    async function endPair(sessionId: string, reason: 'completed' | 'blocked') {
      await expect
        .poll(
          async () =>
            (await records(sessionId)).find(({ type }) => type === 'turn/end')
              ?.data.reason?.kind,
        )
        .toBe(reason);
      const history = await records(sessionId);
      expect(
        history
          .filter(
            ({ type, data }) =>
              type === 'agent/inbox/spliced' &&
              data.target === 'next-step' &&
              data.removedCount,
          )
          .map(({ data }) => ({
            count: data.removedCount,
            outcome: data.outcome,
          })),
      ).toEqual([{ count: 2, outcome: undefined }]);
      return history;
    }

    const accepted = await create();
    const acceptedRun = await startPair(accepted, positive, positiveIds);
    await expect.poll(() => arrivals.length).toBe(acceptedRun.offset + 2);
    const acceptedHistory = await endPair(accepted, 'completed');
    expect(requests - acceptedRun.requestsBefore).toBe(2);
    const second = arrivals[acceptedRun.offset + 1]!;
    expect(second.model).toBe(selectedModel);
    for (const phrase of positive.steer) expect(second.text).toContain(phrase);
    const starts = acceptedHistory.filter(({ type }) => type === 'step/start');
    expect(
      starts.map(({ data }) => ({ turn: data.turn, step: data.step })),
    ).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 2 },
    ]);
    const changes = acceptedHistory.filter(
      ({ type }) => type === 'model/selection',
    );
    expect(changes).toMatchObject([
      { data: { provider, model: selectedModel } },
    ]);
    expect(changes[0]!.seq).toBeGreaterThan(starts[0]!.seq);
    expect(changes[0]!.seq).toBeLessThan(starts[1]!.seq);

    for (const { scenario, ids } of conflicts) {
      const rejected = await create();
      const rejectedRun = await startPair(rejected, scenario, ids);
      const rejectedHistory = await endPair(rejected, 'blocked');
      expect(requests - rejectedRun.requestsBefore).toBe(1);
      expect(arrivals.slice(rejectedRun.offset)).toHaveLength(1);
      expect(
        rejectedHistory.filter(({ type }) => type === 'model/selection'),
      ).toHaveLength(0);
      expect(
        rejectedHistory.filter(({ type }) => type === 'step/start'),
      ).toHaveLength(1);
    }

    const other = await create();
    const otherOffset = arrivals.length;
    await send(other, 'Synthetic same-project neighbor');
    await expect.poll(() => arrivals.length).toBe(otherOffset + 1);
    expect(arrivals[otherOffset]).toMatchObject({
      model: originalModel,
      text: expect.stringContaining('Synthetic same-project neighbor'),
    });
    const catalog = await rpc<{ default: { provider: string; model: string } }>(
      'session/modelCatalog',
      {},
      host.ticket(grant(other)),
    );
    expect(catalog.default).toEqual({ provider, model: originalModel });
  } finally {
    for (const hold of holds.values()) hold.release();
    try {
      await host.close();
    } finally {
      supplier.closeAllConnections();
      await new Promise<void>((resolve) => supplier.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 35_000);
