import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkBoundary, sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';

const promptObservationProbe = String.raw`
import { readFile, unlink, writeFile } from 'node:fs/promises';

export const inject = ['agents', 'sessions', 'sessionQuery', 'workspaceRegistry'];

export function apply(ctx, { commandPath, resultPath }) {
  const creates = new Map();
  ctx.on('agent/created', ({ agent }) => {
    const id = String(agent.session.id);
    creates.set(id, (creates.get(id) ?? 0) + 1);
  }, { global: true });

  async function observe(input) {
    const observation = await ctx.sessionQuery.observeSession(input.sessionId, { projectionMode: 'none' });
    try {
      if (observation.header.cwd !== input.cwd) throw new Error('Workspace mismatch');
      const seen = new Set();
      let first, inherited = 0;
      for (const event of observation.events) {
        const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
          : event.type === 'user/message' ? [event.data] : [];
        for (const message of messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          const source = message.source;
          if (source.kind !== 'user' || source.rpcId !== input.requestId
            || source.principal?.kind !== 'rdws' || source.principal.userId !== input.userId
            || source.principal.nonce !== input.nonce) continue;
          if (event.seq < observation.inheritedEventCount) {
            inherited++;
            continue;
          }
          if (event.type === 'agent/inbox/spliced' && !first)
            first = { seq: event.seq, messageId: message.id };
        }
      }
      return { source: observation.source, cursor: observation.cursor, first, inherited };
    } finally {
      observation[Symbol.dispose]();
    }
  }

  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const raw = await readFile(commandPath, 'utf8').catch(() => undefined);
      if (raw === undefined) return;
      await unlink(commandPath);
      const input = JSON.parse(raw);
      const workspace = ctx.workspaceRegistry.list().find(({ path, sessionIds }) =>
        path === input.cwd && sessionIds.includes(input.sessionId));
      if (!workspace) throw new Error('Unbound workspace');
      const activeBefore = Boolean(ctx.agents.get(input.sessionId));
      const createsBefore = creates.get(input.sessionId) ?? 0;
      let view = await observe(input);
      let flushed = false;
      if (input.flush && view.first && view.source === 'live') {
        const session = ctx.sessions.get(input.sessionId);
        if (!session || !(await ctx.sessions.flush(session))) throw new Error('Flush unconfirmed');
        const confirmed = await observe(input);
        if (confirmed.first?.seq !== view.first.seq || confirmed.first?.messageId !== view.first.messageId)
          throw new Error('Original position changed');
        flushed = true;
        view = confirmed;
      }
      await writeFile(resultPath, JSON.stringify({ outcome: view.first ? 'known' : 'unknown', ...view,
        activeBefore, activeAfter: Boolean(ctx.agents.get(input.sessionId)),
        createdDuringRead: (creates.get(input.sessionId) ?? 0) - createsBefore, flushed }));
    } catch {
      await writeFile(resultPath, '{"outcome":"unavailable"}');
    } finally {
      running = false;
    }
  }, 20).unref();
  ctx.effect(() => () => clearInterval(interval));
}
`;

type Observation = {
  outcome: 'known' | 'unknown' | 'unavailable';
  source?: 'live' | 'prepared';
  cursor?: number;
  first?: { seq: number; messageId: string };
  inherited?: number;
  activeBefore?: boolean;
  activeAfter?: boolean;
  createdDuringRead?: number;
  flushed?: boolean;
};

test('Native accepts an exact original prompt and can later witness it without waking the Agent', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-native-receipt-'),
  );
  const project = 'receipt';
  const config = join(root, 'config/projects', project, 'dsh');
  const profile = join(config, 'profiles/rdws');
  const sessionRoot = join(
    root,
    'runtime/dsh',
    'project-' + project,
    'sessions',
  );
  const commandPath = join(root, 'receipt-command.json');
  const resultPath = join(root, 'receipt-result.json');
  const requirementId = randomUUID();
  const userId = randomUUID();
  const authSessionId = randomUUID();
  const requestId = randomUUID();
  const text = 'Synthetic original accepted prompt';
  let requests = 0;
  let storedBody = '';
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const supplier = createServer(async (request, response) => {
    requests++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      storedBody = Buffer.concat(chunks).toString();
      await hold;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        {
          delta: { role: 'assistant', content: 'Synthetic accepted response' },
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
              model: 'fixture-model',
              choices: [{ index: 0, ...choice }],
            }) +
            '\n\n',
        );
      response.end('data: [DONE]\n\n');
    } catch {
      response.destroy();
    }
  });

  let host: NativeWebHost | undefined;
  function createHost() {
    const native = new NativeWebHost(root, config, project);
    const runs = new ContextRuns(
      native.contextGeneration,
      (token) => native.verifyContext(token),
      async () => ({
        value: {
          snapshot: { requirementId, contextVersion: 1 },
          digest: 'receipt-fixture',
        },
        validBefore: Infinity,
      }),
      () => false,
    );
    native.configureContext((input, token, reply) =>
      runs.handle(input, token, reply),
    );
    host = native;
    return { native, runs };
  }

  try {
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const baseURL =
      'http://127.0.0.1:' +
      (supplier.address() as { port: number }).port +
      '/v1';
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const probe = join(profile, 'prompt-observation-probe.mjs');
    await writeFile(probe, promptObservationProbe, { mode: 0o600 });
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: 'synthetic-receipt-only' },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        {
          id: 'session-persistence-jsonl',
          config: { root: sessionRoot, compression: 'none' },
        },
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                baseURL,
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: 'fixture-model' }],
              },
            },
          },
        },
        {
          insert: [
            {
              id: 'fixture-prompt-observation',
              name: probe,
              config: { commandPath, resultPath },
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );

    const initial = createHost();
    const { native, runs } = initial;
    const workspace = await native.workspace(
      requirementId,
      'Synthetic original session',
    );
    const identity = { userId, authSessionId, requirementId, ...workspace };
    const { sessionId } = (await sessionRpc(
      native,
      { ...identity, purpose: 'create' },
      'session/create',
      {
        workspaceId: workspace.workspaceId,
      },
    )) as { sessionId: string };
    const browser = {
      ...identity,
      purpose: 'browser' as const,
      readSessionIds: [sessionId],
      ownSessionIds: [sessionId],
    };
    const ticket = native.ticket(browser);
    const nonce = native.claims(ticket)!.nonce;
    await native.control('run', {
      ...runs.admit(identity, requirementId, sessionId, requestId, nonce),
      authSessionId,
    });
    expect(
      await sessionRpc(native, ticket, 'session/prompt', {
        sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }),
    ).toEqual({ accepted: true });
    await expect.poll(() => storedBody.includes(text)).toBe(true);
    expect(requests).toBe(1);

    async function observe(
      id: string,
      overrides: {
        requestId?: string;
        userId?: string;
        nonce?: string;
        flush?: boolean;
      } = {},
    ) {
      await rm(resultPath, { force: true });
      await writeFile(
        commandPath + '.tmp',
        JSON.stringify({
          sessionId: id,
          cwd: workspace.cwd,
          requestId,
          userId,
          nonce,
          ...overrides,
        }),
        { mode: 0o600 },
      );
      await rename(commandPath + '.tmp', commandPath);
      let observed: Observation | undefined;
      await expect
        .poll(async () => {
          const value = await readFile(resultPath, 'utf8').catch(
            () => undefined,
          );
          if (value) {
            try {
              observed = JSON.parse(value) as Observation;
            } catch {
              return false;
            }
          }
          return Boolean(observed);
        })
        .toBe(true);
      return observed!;
    }
    async function journal(id: string) {
      const path = (await readdir(sessionRoot, { recursive: true })).find(
        (name) => name.split('/').at(-2) === id && name.endsWith('.jsonl'),
      );
      if (!path) throw new Error('Expected physical Native journal');
      return readFile(join(sessionRoot, path));
    }
    function fingerprint(raw: Buffer) {
      return createHash('sha256').update(raw).digest('hex');
    }

    const live = await observe(sessionId);
    expect(live).toMatchObject({
      outcome: 'known',
      source: 'live',
      first: { seq: expect.any(Number), messageId: expect.any(String) },
      activeBefore: true,
      activeAfter: true,
      createdDuringRead: 0,
      flushed: false,
    });
    for (const overrides of [
      { requestId: randomUUID() },
      { userId: randomUUID() },
      { nonce: randomUUID() },
    ]) {
      const unknown = await observe(sessionId, overrides);
      expect(unknown).toMatchObject({
        outcome: 'unknown',
        source: 'live',
        cursor: live.cursor,
        createdDuringRead: 0,
      });
      expect(unknown.first).toBeUndefined();
    }
    const flushed = await observe(sessionId, { flush: true });
    expect(flushed).toMatchObject({
      outcome: 'known',
      source: 'live',
      first: live.first,
      flushed: true,
    });
    const stored = (await journal(sessionId))
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line));
    expect(stored).toContainEqual(
      expect.objectContaining({
        type: 'agent/inbox/spliced',
        seq: flushed.first?.seq,
        data: expect.objectContaining({
          inserted: expect.arrayContaining([
            expect.objectContaining({
              id: flushed.first?.messageId,
              source: expect.objectContaining({
                rpcId: requestId,
                principal: { kind: 'rdws', userId, nonce },
              }),
            }),
          ]),
        }),
      }),
    );

    release();
    await expect
      .poll(() => forkBoundary(native, browser, sessionId))
      .toEqual(expect.any(Number));
    const atSeq = (await forkBoundary(native, browser, sessionId))!;
    const { sessionId: child } = (await sessionRpc(
      native,
      { ...browser, purpose: 'fork', sourceSessionId: sessionId, atSeq },
      'session/fork',
      { sessionId, atSeq, allowMigration: false },
    )) as { sessionId: string };
    const inherited = await observe(child);
    expect(inherited).toMatchObject({
      outcome: 'unknown',
      inherited: 1,
      createdDuringRead: 0,
    });
    expect(inherited.first).toBeUndefined();
    expect(requests).toBe(1);

    await native.close();
    const locked = new Map([
      [sessionId, fingerprint(await journal(sessionId))],
      [child, fingerprint(await journal(child))],
    ]);
    const restarted = createHost().native;
    await restarted.start();
    const cold = await observe(sessionId);
    expect(cold).toMatchObject({
      outcome: 'known',
      source: 'prepared',
      first: live.first,
      activeBefore: false,
      activeAfter: false,
      createdDuringRead: 0,
      flushed: false,
    });
    expect(await observe(sessionId, { requestId: randomUUID() })).toMatchObject(
      {
        outcome: 'unknown',
        source: 'prepared',
        cursor: cold.cursor,
        activeBefore: false,
        activeAfter: false,
        createdDuringRead: 0,
      },
    );
    expect(await observe(child)).toMatchObject({
      outcome: 'unknown',
      source: 'prepared',
      inherited: 1,
      activeBefore: false,
      activeAfter: false,
      createdDuringRead: 0,
    });
    for (const [id, before] of locked)
      expect(fingerprint(await journal(id))).toBe(before);
    expect(requests).toBe(1);
  } finally {
    release();
    try {
      await host?.close();
    } finally {
      supplier.closeAllConnections();
      await new Promise<void>((resolve) => supplier.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 38_000);
