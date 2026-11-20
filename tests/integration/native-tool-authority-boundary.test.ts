import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { bodyHash, isRecord, signGrant } from '@rdws/dsh/access';
import { expect, test, vi } from 'vitest';
import {
  ContextRuns,
  type RunBinding,
} from '../../apps/server/src/modules/runtime-context.ts';

const toolName = 'rdws_boundary_probe';
const toolDefinition = String.raw`
const toolName = 'rdws_boundary_probe';
function constantTool(execute) {
  return {
    name: toolName,
    description: 'Return a constant for a synthetic Native tool boundary test',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) { execute(exec); return 'Synthetic tool result'; },
  };
}
`;
const hostProbe = String.raw`
import { appendFileSync } from 'node:fs';
${toolDefinition}
export const inject = ['tools'];

export function apply(ctx, { expectedRequest, tracePath }) {
  const eligible = new WeakSet();
  const record = (agent, phase, extra = {}) => appendFileSync(tracePath,
    JSON.stringify({ sessionId: String(agent.session.id), phase, ...extra }) + '\n', { mode: 0o600 });
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.register(constantTool(() => record(agent, 'execute')), {
      when({ agent: actual }) {
        const result = actual === agent && eligible.has(agent);
        record(agent, 'when', { eligible: result });
        return result;
      },
    });
  }, { global: true });
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const source = message.source;
    if (source.kind === 'user' && source.principal?.kind === 'rdws' && source.rpcId === expectedRequest)
      eligible.add(agent);
    record(agent, 'claimed');
  }, { global: true });
  ctx.on('agent/pre-step', ({ agent, step }, next) => {
    eligible.delete(agent);
    record(agent, 'pre-step', { step });
    return next();
  }, { global: true });
  ctx.on('tools/pre-execute', (execution, next) => {
    if (execution.name !== toolName || !execution.agent || !execution.callId.startsWith('call-rdws-probe-'))
      return next();
    record(execution.agent, 'pre-execute', { callId: execution.callId });
    return { kind: 'allow' };
  }, { global: true, prepend: true });
}
`;

type ToolEvent = {
  type: string;
  seq: number;
  sourceEventSeqs?: number[];
  data: {
    turn?: number;
    step?: number;
    callId?: string;
    reason?: { kind: string };
    message?: {
      toolCallId?: string;
      isError?: boolean;
      content?: { text?: string }[];
    };
  };
};

test('the formal Host rejects actual model tool calls even when an Agent-scoped declaration is present', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-native-tool-boundary-'),
  );
  const config = join(root, 'config/projects/tool-boundary/dsh');
  const profile = join(config, 'profiles/rdws');
  const marker = join(root, 'tool-probe.jsonl');
  const requirementId = randomUUID();
  const authSessionId = randomUUID();
  const expectedRequest = randomUUID();
  const provider = 'rdws-glm';
  const model = 'fixture-tool-model';
  const wire: {
    tools?: { function: { name: string } }[];
    messages: { role: string; tool_call_id?: string; content?: unknown }[];
  }[] = [];
  const supplier = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as (typeof wire)[number];
      wire.push(input);
      const continuation = input.messages.some(({ role }) => role === 'tool');
      const callId =
        'call-rdws-probe-' +
        (JSON.stringify(input.messages).includes(
          'Synthetic authorized declaration',
        )
          ? 'declared'
          : 'missing');
      const [delta, finish] = continuation
        ? [{ role: 'assistant', content: 'Synthetic follow-up' }, 'stop']
        : [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: { name: toolName, arguments: '{}' },
                },
              ],
            },
            'tool_calls',
          ];
      const frame = {
        id: 'tool-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model,
      };
      const first = { index: 0, delta, finish_reason: null };
      const last = { index: 0, delta: {}, finish_reason: finish };
      response
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(
          [first, last]
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
  });
  const host = new NativeWebHost(root, config, 'tool-boundary');
  const runs = new ContextRuns(
    host.contextGeneration,
    (token) => host.verifyContext(token),
    async () => ({
      value: {
        snapshot: { requirementId, contextVersion: 1 },
        digest: 'tool-fixture-context',
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
    const baseURL =
      'http://127.0.0.1:' +
      (supplier.address() as { port: number }).port +
      '/v1';
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const module = join(profile, 'native-tool-probe.mjs');
    await writeFile(module, hostProbe, { mode: 0o600 });
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: 'synthetic-tool-only' },
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
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: model }],
              },
            },
          },
        },
        {
          insert: [
            {
              id: 'native-tool-probe',
              name: module,
              config: { expectedRequest, tracePath: marker },
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );
    const workspace = await host.workspace(
      requirementId,
      'Synthetic tool boundary',
    );
    const identity = {
      userId: randomUUID(),
      requirementId,
      authSessionId,
      ...workspace,
    };
    for (const [text, requestId, mode] of [
      ['Synthetic authorized declaration', expectedRequest, 'declared'],
      ['Synthetic unqualified declaration', randomUUID(), 'missing'],
    ]) {
      const offset = wire.length;
      const { sessionId } = (await sessionRpc(
        host,
        { ...identity, purpose: 'create' },
        'session/create',
        { workspaceId: workspace.workspaceId },
      )) as { sessionId: string };
      const browser = {
        ...identity,
        purpose: 'browser' as const,
        readSessionIds: [sessionId],
        ownSessionIds: [sessionId],
      };
      const ticket = host.ticket(browser);
      await host.control('run', {
        ...runs.admit(
          identity,
          requirementId,
          sessionId,
          requestId!,
          host.claims(ticket)!.nonce,
        ),
        authSessionId,
      });
      expect(
        await sessionRpc(host, ticket, 'session/prompt', {
          sessionId,
          requestId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }),
      ).toEqual({ accepted: true });
      const read = async () =>
        (
          (await sessionRpc(host, browser, 'session/events', {
            address: { kind: 'session', sessionId },
          })) as { records: { event: ToolEvent }[] }
        ).records.map(({ event }) => event);
      await expect
        .poll(
          async () =>
            (await read()).find(({ type }) => type === 'turn/end')?.data.reason
              ?.kind,
        )
        .toBe('completed');
      const raw = await read();
      const calls = raw.filter(({ type }) => type === 'tool/call');
      const results = raw.filter(({ type }) => type === 'tool/result');
      const callId = 'call-rdws-probe-' + mode;
      expect(calls).toMatchObject([
        { data: { callId, name: toolName, turn: 1, step: 1 } },
      ]);
      expect(results).toMatchObject([
        {
          sourceEventSeqs: [calls[0]!.seq],
          data: {
            turn: 1,
            step: 1,
            message: { toolCallId: callId, isError: true },
            error: { name: 'RdwsToolGuardError', code: 'RDWS_TOOLS_DISABLED' },
          },
        },
      ]);
      expect(JSON.stringify(results)).toContain(
        'Tools are disabled in this RDWS stage',
      );
      expect(wire.slice(offset)).toHaveLength(2);
      expect(
        (wire[offset]?.tools ?? []).map(({ function: spec }) => spec.name),
      ).toEqual(mode === 'declared' ? [toolName] : []);
      expect(
        wire[offset + 1]?.messages.filter(({ role }) => role === 'tool'),
      ).toMatchObject([{ tool_call_id: callId }]);
      const trace = (await readFile(marker, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              sessionId: string;
              phase: string;
              eligible?: boolean;
              callId?: string;
              step?: number;
            },
        )
        .filter((row) => row.sessionId === sessionId);
      expect(trace.slice(0, 3)).toMatchObject([
        { phase: 'claimed' },
        { phase: 'when', eligible: mode === 'declared' },
        { phase: 'pre-step', step: 1 },
      ]);
      expect(
        trace
          .filter(({ phase }) => phase === 'pre-execute')
          .map((row) => row.callId),
      ).toEqual([callId]);
      expect(trace.filter(({ phase }) => phase === 'execute')).toHaveLength(0);
    }
  } finally {
    try {
      await host.close();
    } finally {
      supplier.closeAllConnections();
      await new Promise<void>((resolve) => supplier.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 35_000);

test
  .skipIf(process.platform !== 'darwin')
  .each([
    'allow',
    'cancel',
    'other-guard',
    'reroute',
    'rebind',
    'mutable-args',
    'raw-args',
    'expired',
    'queued',
    'mixed',
    'no-offer',
  ] as const)(
  'the formal mediated Host enforces a fixture tool permit for %s',
  async (mode) => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-host-permit-'),
    );
    const project = 'fixture-permit';
    const config = join(root, 'config');
    const profile = join(config, 'profiles/rdws');
    const model = 'fixture-tool';
    const provider = 'rdws-glm';
    const fixtureName = 'rdws_authority_probe';
    const callId = 'call-same-for-both-sessions';
    const routes = { pi: 'https://fixture-tool.invalid/v1/chat/completions' };
    const requestId = randomUUID();
    const requirementId = randomUUID();
    let firstPermitBody: Record<string, unknown> | undefined;
    let checkedOldStep = false;
    let additionalPrompt: (() => Promise<unknown>) | undefined;
    const extraText = 'Synthetic subsequent input without tool authority';
    async function fixtureToken(body: Record<string, unknown>) {
      const key = await readFile(
        join(root, 'secrets', 'dsh-bff-key-' + project),
        'utf8',
      );
      return signGrant(key.trim(), {
        aud: 'rdws:bff:' + host.contextGeneration,
        purpose: 'service',
        operation: 'fixture-tool-permit',
        runId: String(body.runId),
        hostGeneration: host.contextGeneration,
        bodyHash: bodyHash(body),
      });
    }
    const wire: {
      sessionId?: string;
      tools?: { function: { name: string } }[];
      messages: { role: string; tool_call_id?: string; content?: unknown }[];
    }[] = [];
    const host: NativeWebHost = new NativeWebHost(
      root,
      config,
      project,
      undefined,
      'mediated',
      {
        routes,
        async handle(request): Promise<Response> {
          const body = (await new Response(
            request.body,
          ).json()) as (typeof wire)[number];
          wire.push({ ...body, sessionId: request.call.sessionId });
          const continuation = body.messages.some(
            ({ role }) => role === 'tool',
          );
          if (request.call.sessionId === probe?.sessionId && additionalPrompt) {
            const enqueue = additionalPrompt;
            additionalPrompt = undefined;
            expect(await enqueue()).toEqual({ accepted: true });
          }
          if (
            request.call.sessionId === probe?.sessionId &&
            continuation &&
            firstPermitBody
          ) {
            const old = { ...firstPermitBody, deadline: Date.now() + 1500 };
            expect(request.call.bindingId).not.toBe(
              firstPermitBody.modelBindingId,
            );
            await expect(
              runs.handle(old, await fixtureToken(old), undefined, probe),
            ).rejects.toMatchObject({ statusCode: 403 });
            checkedOldStep = true;
          }
          const [delta, finish] = continuation
            ? [{ role: 'assistant', content: 'Synthetic follow-up' }, 'stop']
            : [
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: callId,
                      type: 'function',
                      function: {
                        name: fixtureName,
                        arguments:
                          mode === 'raw-args' ? '{"extra":true}' : '{}',
                      },
                    },
                  ],
                },
                'tool_calls',
              ];
          return runs.authorizeModelAttempt(
            request,
            () =>
              new Response(
                [
                  { index: 0, delta, finish_reason: null },
                  { index: 0, delta: {}, finish_reason: finish },
                ]
                  .map(
                    (choice) =>
                      'data: ' +
                      JSON.stringify({
                        id: 'fixture-tool',
                        object: 'chat.completion.chunk',
                        created: 1,
                        model,
                        choices: [choice],
                      }) +
                      '\n\n',
                  )
                  .join('') + 'data: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              ),
          );
        },
      },
    );
    const runs: ContextRuns = new ContextRuns(
      host.contextGeneration,
      (token) => host.verifyContext(token),
      async () => ({
        value: {
          snapshot: { requirementId, contextVersion: 1 },
          digest: 'fixture',
        },
        validBefore: Date.now() + 10_000,
      }),
      () => false,
      async () => ({
        provider,
        model,
        revision: 'fixture',
        routes,
        isCurrent: () => true,
      }),
    );
    let probe: RunBinding | undefined;
    let approvals = 0;
    let ipcResponseSentAfterCancel = false;
    host.configureContext(async (body, token, reply) => {
      if (host.verifyContext(token)?.operation !== 'fixture-tool-permit')
        return runs.handle(body, token, reply);
      expect(isRecord(body)).toBe(true);
      const caller = body as Record<string, unknown>;
      await expect(runs.handle(body, token)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        runs.handle(
          { ...caller, toolCallSeq: Number(caller.toolCallSeq) + 1 },
          token,
          undefined,
          probe,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      const fresh = await fixtureToken(caller);
      const [original, repeated] = await Promise.allSettled([
        runs.handle(body, token, undefined, probe),
        runs.handle(body, fresh, undefined, probe),
      ]);
      expect(original.status).toBe('fulfilled');
      expect(repeated).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 403 },
      });
      if (original.status !== 'fulfilled') throw original.reason;
      const permit = original.value as { expiresAt: number };
      firstPermitBody = caller;
      approvals++;
      await expect(
        runs.handle(body, token, undefined, probe),
      ).rejects.toMatchObject({ statusCode: 403 });
      if (mode === 'cancel') {
        expect(
          await host.control('run.cancel', { runId: probe!.runId }),
        ).toEqual({ cancelled: true });
        ipcResponseSentAfterCancel = permit.expiresAt > Date.now();
      }
      reply(permit, permit.expiresAt);
      return permit;
    });
    try {
      vi.stubEnv('RDWS_MODE', 'development');
      expect(() => host.enableFixtureToolProbe()).toThrow('mediated test Host');
      vi.stubEnv('RDWS_MODE', 'test');
      host.enableFixtureToolProbe();
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const fixturePlugin = join(profile, 'tool-policy.mjs');
      await writeFile(
        fixturePlugin,
        String.raw`
export const inject = ['tools'];
export function apply(ctx, { mode }) {
  if (mode === 'other-guard')
    ctx.tools.guard((exec) => exec.name === 'rdws_authority_probe' ? 'Independent fixture denial' : undefined);
  if (mode === 'reroute') ctx.on('tools/execute', async (exec, next) => {
    exec.name = 'fixture_wrong_target';
    return next();
  }, { global: true });
  if (mode === 'rebind') ctx.on('tools/pre-execute', async (exec, next) => {
    const outcome = await next();
    if (exec.name === 'rdws_authority_probe') exec.callId = 'fixture_wrong_call';
    return outcome;
  }, { global: true, prepend: true });
  if (mode === 'mutable-args') {
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'rdws_authority_probe') exec.arguments = {};
      return next();
    }, { global: true, prepend: true });
    ctx.on('tools/execute', (exec, next) => {
      exec.arguments.unexpected = true;
      return next();
    }, { global: true });
  }
  if (mode === 'raw-args') ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'rdws_authority_probe') exec.arguments = Object.freeze({});
    return next();
  }, { global: true, prepend: true });
  if (mode === 'expired') ctx.on('tools/execute', async (_exec, next) => {
    await new Promise((resolve) => setTimeout(resolve, 2100));
    return next();
  }, { global: true });
}
`,
        { mode: 0o600 },
      );
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: 'synthetic-only' },
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
                  baseURL: 'https://fixture-tool.invalid/v1',
                  apiKeyEnv: 'FIXTURE_MODEL',
                  models: [{ id: model }],
                },
              },
            },
          },
          {
            insert: [
              {
                id: 'tool-policy-fixture',
                name: fixturePlugin,
                config: { mode },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      const workspace = await host.workspace(
        requirementId,
        'Synthetic tool permission',
      );
      const who = { userId: randomUUID(), authSessionId: randomUUID() };
      const identity = { ...who, ...workspace, requirementId };
      const sessions = [];
      for (const offered of mode === 'no-offer' ? [false] : [true, false]) {
        const { sessionId } = (await sessionRpc(
          host,
          { ...identity, purpose: 'create' },
          'session/create',
          { workspaceId: workspace.workspaceId },
        )) as { sessionId: string };
        const browser = {
          ...identity,
          purpose: 'browser' as const,
          readSessionIds: [sessionId],
          ownSessionIds: [sessionId],
        };
        const ticket = host.ticket(browser);
        const run = runs.admit(
          who,
          requirementId,
          sessionId,
          requestId,
          host.claims(ticket)!.nonce,
        );
        if (offered) probe = run;
        await host.control('run', {
          ...run,
          authSessionId: who.authSessionId,
          fixtureTool: offered,
        });
        sessions.unshift({ sessionId, ticket, browser, offered });
      }
      for (const { sessionId, ticket, browser, offered } of sessions) {
        if (offered && (mode === 'queued' || mode === 'mixed')) {
          additionalPrompt = async () => {
            const extraRequest = randomUUID();
            await host.control('run', {
              ...runs.admit(
                who,
                requirementId,
                sessionId,
                extraRequest,
                host.claims(ticket)!.nonce,
              ),
              authSessionId: who.authSessionId,
            });
            return sessionRpc(host, ticket, 'session/prompt', {
              sessionId,
              requestId: extraRequest,
              mode: mode === 'queued' ? 'queue' : 'steer',
              content: [{ type: 'text', text: extraText }],
            });
          };
        }
        expect(
          await sessionRpc(host, ticket, 'session/prompt', {
            sessionId,
            requestId,
            mode: 'queue',
            content: [{ type: 'text', text: 'Synthetic tool request' }],
          }),
        ).toEqual({ accepted: true });
        const events = async () =>
          (
            (await sessionRpc(host, browser, 'session/events', {
              address: { kind: 'session', sessionId },
            })) as { records: { event: ToolEvent }[] }
          ).records.map(({ event }) => event);
        await expect
          .poll(
            async () =>
              (await events()).filter(({ type }) => type === 'turn/end').length,
            { timeout: 10_000 },
          )
          .toBe(offered && mode === 'queued' ? 2 : 1);
        const all = await events();
        if (mode === 'no-offer')
          expect(
            all.find(({ type }) => type === 'turn/end')?.data.reason?.kind,
          ).toBe('completed');
        const call = all.find(({ type }) => type === 'tool/call');
        const result = all.find(({ type }) => type === 'tool/result');
        expect(call?.data.callId).toBe(callId);
        const success = offered && ['allow', 'queued', 'mixed'].includes(mode);
        expect(result).toMatchObject({
          sourceEventSeqs: [call!.seq],
          data: { message: { toolCallId: callId, isError: !success } },
        });
        expect(JSON.stringify(result)).toContain(
          success ? 'RDWS fixture tool completed' : 'Error',
        );
        if (offered && mode === 'cancel')
          expect(JSON.stringify(result)).toContain(
            'Fixture tool permit no longer current',
          );
        if (offered && mode === 'other-guard')
          expect(JSON.stringify(result)).toContain(
            'Independent fixture denial',
          );
        if (offered && mode === 'reroute')
          expect(JSON.stringify(result)).toContain('read only property');
        if (offered && mode === 'rebind')
          expect(JSON.stringify(result)).toContain(
            'Fixture tool permit no longer current',
          );
        if (offered && mode === 'expired')
          expect(JSON.stringify(result)).toContain(
            'Fixture tool permit expired',
          );
        const requests = wire.filter((row) => row.sessionId === sessionId);
        expect(
          (requests[0]?.tools ?? []).map(({ function: spec }) => spec.name),
        ).toEqual(offered ? [fixtureName] : []);
        if (success)
          expect(requests[1]?.messages).toContainEqual(
            expect.objectContaining({
              tool_call_id: callId,
              content: 'RDWS fixture tool completed',
            }),
          );
        if (!offered) expect(approvals).toBe(0);
        if (offered && (mode === 'queued' || mode === 'mixed')) {
          const following = requests.find((item) =>
            item.messages.some(({ content }) => content === extraText),
          );
          expect(following).toBeDefined();
          expect(following?.tools ?? []).toEqual([]);
        }
      }
      expect(approvals).toBe(
        ['mutable-args', 'raw-args', 'no-offer'].includes(mode) ? 0 : 1,
      );
      if (mode === 'allow') expect(checkedOldStep).toBe(true);
      if (mode === 'cancel') expect(ipcResponseSentAfterCancel).toBe(true);
    } finally {
      try {
        await host.close();
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

const independentProbe = String.raw`
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
${toolDefinition}
const installed = createRequire(resolve('dsh/package.json'));
const native = createRequire(installed.resolve('@deepseek-ai/dsh/package.json'));
const load = name => import(pathToFileURL(native.resolve('@deepseek-ai/' + name)).href);
const { Context } = await load('cordis');
const llm = await load('dsh-llm');
const ctx = new Context();
const states = new Map();
try {
  await ctx.plugin(llm.default);
  await ctx.plugin((await load('dsh-session')).default);
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin((await load('dsh-system-prompt')).default, { personaPrefix: '', personaSuffix: '' });
  await ctx.plugin((await load('dsh-tools')).default);
  await ctx.plugin(await load('dsh-tool-executor-native'));
  await ctx.plugin((await load('dsh-agent')).default);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  class SyntheticAdapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(options) {
      const current = states.get(options.sessionId);
      const names = options.tools?.map(({name}) => name) ?? [];
      current.requests.push(names);
      if (current.requests.length > 1) {
        current.history = options.messages.some(m => m.role === 'tool' && m.toolCallId === current.callId);
        const block = { type: 'text', text: 'Synthetic completion' };
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: block.text };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      current.entered.resolve(names);
      await current.release.promise;
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: current.callId, name: toolName, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: current.callId, name: toolName, arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['synthetic'], new SyntheticAdapter());
  ctx.on('session/event', (session, event) => {
    const state = states.get(session.id);
    if (state && event.type === 'tool/call') state.liveCall = event;
  }, { global: true });
  ctx.tools.guard((exec) => {
    const state = states.get(exec.agent?.session.id);
    const call = state?.liveCall;
    if (!state || exec.agent !== state.agent || call?.data.callId !== exec.callId || call.data.turn !== 1 || call.data.step !== 1)
      return 'Missing synthetic live call';
    state.guards.push({ id: exec.callId, allowed: state.authority });
    if (!state.authority) return 'Synthetic fixture permission expired';
  });
  const observations = [];
  for (const mode of ['allowed', 'revoked', 'inactive']) {
    const sessionId = 'session-' + mode;
    const state = {
      callId: 'call-' + mode, authority: true, requests: [], guards: [], body: [],
      entered: Promise.withResolvers(), release: Promise.withResolvers(),
    };
    states.set(sessionId, state);
    const { agent, dispose } = await ctx.agents.create({ sessionId,
      agentOptions: { provider: 'synthetic', model: 'probe' },
      setup(scope, agent) {
        state.agent = agent;
        scope.tools.register(constantTool(exec => state.body.push(exec.callId)), {
          when: ({ agent: actual }) => actual === agent && state.requests.length === 0 && state.authority && mode !== 'inactive',
        });
      },
    });
    try {
      agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: mode }] }));
      const declared = await state.entered.promise;
      if (mode === 'revoked') state.authority = false;
      state.release.resolve();
      await agent.whenIdle();
      const call = state.liveCall;
      const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result');
      observations.push({ mode, declared, history: state.history, body: state.body, guards: state.guards,
        call: { seq: call?.seq, id: call?.data.callId, turn: call?.data.turn, step: call?.data.step },
        result: { refs: result?.sourceEventSeqs, message: result?.data.message, error: result?.data.error } });
    } finally {
      state.release.resolve();
      await dispose();
    }
  }
  process.stdout.write(JSON.stringify(observations));
} finally {
  await ctx.fiber.dispose();
}
`;

test('the locked Native executor distinguishes permission at declaration from permission at dispatch', async () => {
  const execute = promisify(execFile);
  const { stdout } = await execute(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', independentProbe],
    { timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  const results = JSON.parse(stdout) as {
    mode: string;
    call: { seq: number };
    result: { refs: number[] };
  }[];
  expect(results).toMatchObject([
    {
      mode: 'allowed',
      declared: [toolName],
      history: true,
      body: ['call-allowed'],
      guards: [{ id: 'call-allowed', allowed: true }],
      call: { id: 'call-allowed', turn: 1, step: 1 },
      result: {
        message: {
          toolCallId: 'call-allowed',
          isError: false,
          content: [{ type: 'text', text: 'Synthetic tool result' }],
        },
      },
    },
    {
      mode: 'revoked',
      declared: [toolName],
      history: true,
      body: [],
      guards: [{ id: 'call-revoked', allowed: false }],
      call: { id: 'call-revoked', turn: 1, step: 1 },
      result: {
        message: {
          toolCallId: 'call-revoked',
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Error: Synthetic fixture permission expired',
            },
          ],
        },
      },
    },
    {
      mode: 'inactive',
      declared: [],
      history: true,
      body: [],
      guards: [{ id: 'call-inactive', allowed: true }],
      call: { id: 'call-inactive', turn: 1, step: 1 },
      result: {
        message: { toolCallId: 'call-inactive', isError: true },
        error: { code: 'UNKNOWN_TOOL' },
      },
    },
  ]);
  for (const { call, result } of results)
    expect(result.refs).toEqual([call.seq]);
});
