import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RDWS_TOOL_GUARD_DENIAL } from '@rdws/dsh/access';
import {
  installReadToolProbe,
  readSegmentPath,
  readToolArguments,
  truncatedLines,
} from '../../dsh/plugins/rdws-access/read-probe.mjs';
import { toolGateDecision } from '../../dsh/plugins/rdws-access/tool-gate.mjs';

// §11.20.26 Host-side extension points on the real locked packages: the read
// definition is acquired inside the probe scope (managed provider + fixed
// working directory) and registered as the same object in the Agent scope
// with a step-time condition; the root guard dispatches by tool name; a
// Read-specific permit is requested before execution and gates it; the
// provider issues one metadata request per file and one page request per
// page. The FD3 transport itself is the B-segment joint chain: here the
// service is an in-memory stand-in with the same operations.

// The locked packages ship no TypeScript types for these test-scoped uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;
type Agent = { session: { id: string }; ctx: Ctx };

const installed = createRequire(resolve('dsh/package.json'));
const native = createRequire(
  installed.resolve('@deepseek-ai/dsh/package.json'),
);
const load = (name: string) =>
  import(pathToFileURL(native.resolve('@deepseek-ai/' + name)).href);

const files = new Map<string, string>();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pageSize = 16;

function serviceFixture(options: { permitDigest?: 'wrong' } = {}) {
  const log: string[] = [];
  const segments: { line: number; prefix: string; snapshotId: string }[] = [];
  const cursors = new Map<
    string,
    { text: string; cursor?: string; sha256: string }
  >();
  async function service(operation: string, body: Record<string, unknown>) {
    log.push(operation);
    if (operation === 'worktree-stat') {
      const text = files.get(String(body.path));
      if (text === undefined) throw new Error('not found');
      const digest = sha(text);
      const pages: string[] = [];
      for (let from = 0; from < text.length || from === 0; from += pageSize)
        pages.push(text.slice(from, from + pageSize));
      let cursor: string | undefined;
      for (const page of pages.reverse()) {
        const id = randomUUID();
        cursors.set(id, {
          text: page,
          sha256: digest,
          ...(cursor && { cursor }),
        });
        cursor = id;
      }
      return {
        type: 'file',
        size: Buffer.byteLength(text),
        sha256: digest,
        snapshotId: 'snapshot-k',
        cursor,
      };
    }
    if (operation === 'worktree-read') {
      const page = cursors.get(String(body.cursor));
      if (!page) throw new Error('unknown cursor');
      return { ...page, snapshotId: 'snapshot-k' };
    }
    if (operation === 'read-tool-permit')
      return {
        digest: options.permitDigest === 'wrong' ? 'forged' : bodyHashOf(body),
        expiresAt: Date.now() + 1500,
      };
    if (operation === 'read-segment-register') {
      segments.push({
        line: Number(body.line),
        prefix: String(body.prefix),
        snapshotId: String(body.snapshotId),
      });
      return {};
    }
    throw new Error('Unexpected read service operation: ' + operation);
  }
  return { service, log, segments };
}

// Stand-in for the FD3 body digest the parent checks.
function bodyHashOf(body: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

let ctx: Ctx;

let probe: ReturnType<typeof installReadToolProbe>;
let deps: ReturnType<typeof serviceFixture>;
// The probe keeps the service it was installed with; tests route it.
let route: (
  operation: string,
  body: Record<string, unknown>,
) => Promise<unknown>;
let run: Record<string, string>;
let armed = true;
const stepOf = new Map<Agent, Record<string, unknown>>();

function agentOf(id: string): Agent {
  const agent = { session: { id }, ctx: undefined } as Agent;
  return agent;
}

async function createAgent(id: string) {
  const agent = agentOf(id);
  const scope = await load('dsh-scope');
  const minted = scope.createScope(ctx, agent);
  agent.ctx = minted.ctx;
  stepOf.set(agent, {
    bindingId: 'binding-' + id,
    agent,
    runs: [run],
    body: {
      runId: run.runId,
      hostGeneration: run.hostGeneration,
      requirementId: run.requirementId,
      sessionId: run.sessionId,
      requestId: run.requestId,
      peerNonce: run.peerNonce,
      agentGeneration: 'agent',
      turn: 1,
      modelStep: {
        sequence: 1,
        step: 1,
        noteId: randomUUID(),
        provider: 'p',
        model: 'm',
      },
    },
  });
  ctx.emit('agent/created', { agent });
  return agent;
}

async function read(agent: Agent, args: Record<string, unknown>) {
  const signal = AbortSignal.timeout(10_000);
  const toolSet = await ctx.tools.resolve({ agent, signal });
  const callId = 'call-' + randomUUID();
  ctx.emit('session/event', agent.session, {
    type: 'tool/call',
    seq: 1,
    data: {
      name: 'read',
      callId,
      arguments: JSON.stringify(args),
      turn: 1,
      step: 1,
    },
  });
  const reply = await ctx.tools.execute({
    signal,
    agent,
    toolSet,
    calls: [
      {
        type: 'tool-call',
        id: callId,
        name: 'read',
        arguments: JSON.stringify(args),
      },
    ],
  });
  return {
    callId,
    ...(reply.results[0] as {
      result: {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
    }),
  };
}

let root: Ctx;

// A context that declares the tools injection, like the rdws-access plugin
// scope the probe is installed in on the real Host.
async function injected(target: Ctx) {
  const holder: { ctx?: Ctx } = {};
  await target.plugin({
    name: 'rdws-read-probe-harness',
    inject: ['tools'],
    apply: (scope: Ctx) => {
      holder.ctx = scope;
    },
  });
  return holder.ctx!;
}

beforeAll(async () => {
  const { Context } = await load('cordis');
  root = new Context();
  await root.plugin((await load('dsh-system-prompt')).default, {
    personaPrefix: '',
    personaSuffix: '',
  });
  await root.plugin((await load('dsh-tools')).default);
  await root.plugin(await load('dsh-tool-executor-native'));
  ctx = await injected(root);
  deps = serviceFixture();
  route = deps.service;
  run = {
    runId: randomUUID(),
    hostGeneration: 'generation',
    requirementId: 'demand',
    sessionId: 'session-1',
    requestId: 'prompt',
    peerNonce: 'peer',
    authSessionId: 'login',
  };
  probe = installReadToolProbe(ctx, {
    currentStep: (agent: Agent) => (armed ? stepOf.get(agent) : undefined),
    liveRun: (candidate: Record<string, string>) => candidate === run && armed,
    service: ((operation: string, body: Record<string, unknown>) =>
      route(operation, body)) as never,
    config: { readStreamMinSize: 64 },
  });
  await probe.ready;
  ctx.tools.guard((exec: unknown) =>
    toolGateDecision(exec as never, {
      readToolGate: probe.gate as never,
      fixtureToolGate: () => undefined,
    }),
  );
});

afterAll(async () => {
  await probe.dispose();
  await root.fiber.dispose();
});

describe('§11.20.26 Read probe: definition acquisition and root-guard dispatch', () => {
  test('B2-2: the enabled line only takes effect where fs exists; without it the probe scope is the only registration', async () => {
    const { Context } = await load('cordis');
    const toolFs = await load('dsh-tool-fs');
    const bare: Ctx = new Context();
    await bare.plugin((await load('dsh-system-prompt')).default, {
      personaPrefix: '',
      personaSuffix: '',
    });
    await bare.plugin((await load('dsh-tools')).default);
    const bareTools = await injected(bare);
    // Root scope without fs: the plugin's required injections never resolve.
    void bare.plugin(toolFs, {
      read: true,
      readImage: false,
      write: false,
      edit: false,
      applyPatch: false,
    });
    await delay(100);
    expect(bareTools.tools.get('read')).toBeUndefined();
    bare.provide('fs', {});
    bare.provide('workingDirectory', {});
    await delay(100);
    expect(bareTools.tools.get('read')).toBeDefined();
    await bare.fiber.dispose();
    // The Host root registry never sees a global read: only the Agent scope.
    expect(ctx.tools.get('read')).toBeUndefined();
    expect(probe.definition()).toMatchObject({ name: 'read' });
  });

  test('the read is declared only for the Agent that claimed the armed run in its step', async () => {
    const claimed = await createAgent('session-1');
    expect(probe.offer(run as never)).toBe(true);
    probe.claim(claimed, run as never, 1);
    const bystander = await createAgent('session-2');
    const signal = AbortSignal.timeout(10_000);
    const names = async (agent: Agent) =>
      ctx.tools
        .schemas(agent, await ctx.tools.resolve({ agent, signal }))
        .map((schema: { name: string }) => schema.name);
    expect(await names(claimed)).toEqual(['read']);
    expect(await names(bystander)).toEqual([]);
    expect(ctx.tools.executable('read', claimed)).toBeUndefined();
  });

  test('tool names dispatch: read goes to the Read gate, other names keep the constant-tool gate and the default denial', () => {
    const denial = toolGateDecision(
      { name: 'write' },
      { fixtureToolGate: () => undefined, readToolGate: () => 'allow' },
    );
    expect(denial).toEqual({
      reason: 'Tools are disabled in this RDWS stage',
      info: RDWS_TOOL_GUARD_DENIAL,
    });
    expect(
      toolGateDecision(
        { name: 'rdws_authority_probe' },
        { fixtureToolGate: () => 'allow', readToolGate: () => undefined },
      ),
    ).toBeUndefined();
    expect(
      toolGateDecision(
        { name: 'rdws_authority_probe' },
        { fixtureToolGate: () => 'invalidated' },
      ),
    ).toMatchObject({ reason: 'Fixture tool permit no longer current' });
    expect(
      toolGateDecision(
        { name: 'read' },
        { fixtureToolGate: () => 'allow', readToolGate: () => undefined },
      ),
    ).toMatchObject({ reason: 'Tools are disabled in this RDWS stage' });
    expect(
      toolGateDecision(
        { name: 'read' },
        { fixtureToolGate: () => 'allow', readToolGate: () => 'invalidated' },
      ),
    ).toMatchObject({ reason: 'Read tool permit no longer current' });
    expect(
      toolGateDecision({ name: 'read' }, { readToolGate: () => 'allow' }),
    ).toBeUndefined();
    expect(toolGateDecision({ name: 'read' }, {})).toMatchObject({
      reason: 'Tools are disabled in this RDWS stage',
    });
  });

  test('argument shape and truncated-line parsing', () => {
    const frozen = (value: unknown) => Object.freeze(value);
    expect(
      readToolArguments(frozen({ file_path: 'a.md', offset: 2, limit: 5 })),
    ).toEqual({ file_path: 'a.md', offset: 2, limit: 5 });
    expect(readToolArguments({ file_path: 'a.md' })).toBeUndefined();
    for (const bad of [
      { file_path: '/abs' },
      { file_path: '../x' },
      { file_path: 'a.md', offset: 0 },
      { file_path: 'a.md', limit: 2001 },
      { file_path: 'a.md', sessionId: 'x' },
      { file_path: readSegmentPath + 'nope' },
    ])
      expect(readToolArguments(frozen(bad))).toBeUndefined();
    expect(
      readToolArguments(frozen({ file_path: readSegmentPath + randomUUID() })),
    ).toBeDefined();
    const line = 'x'.repeat(2000) + 'é';
    expect(
      truncatedLines(
        '<content>\n1: short\n2: ' +
          line.slice(0, 2000) +
          '... (line truncated to 2000 chars)\n\n(End of file - total 2 lines)\n</content>',
      ),
    ).toEqual([{ line: 2, prefix: line.slice(0, 2000), chars: 2000 }]);
  });
});

describe('§11.20.26 Read probe: permit, metadata and pages', () => {
  const longLine = 'a'.repeat(1999) + '𝄞' + 'tail-of-the-line';
  const text = 'first\n' + longLine + '\nlast';

  test('a permitted read stats once, pages through the single snapshot and reports the truncated line', async () => {
    files.set('doc.txt', text);
    const agent = await createAgent('session-3');
    probe.claim(agent, run as never, 1);
    const before = probe.stats();
    const { result, callId } = await read(agent, { file_path: 'doc.txt' });
    expect(result.isError).not.toBe(true);
    const output = result.content[0]!.text!;
    expect(output).toContain('<path>/workspace/doc.txt</path>');
    expect(output).toContain('1: first');
    expect(output).toContain('... (line truncated to 2000 chars)');
    expect(output).toContain('3: last');
    const after = probe.stats();
    expect(after.stat - before.stat).toBe(1);
    expect(after.permits - before.permits).toBe(1);
    expect(after.executed - before.executed).toBe(1);
    expect(after.pages - before.pages).toBe(
      Math.ceil(Buffer.byteLength(text) / pageSize),
    );
    expect(deps.log.filter((op) => op === 'worktree-stat')).toHaveLength(1);
    // Long-line registration: the displayed prefix, reported over the new FD3 operation.
    ctx.emit('session/event', agent.session, {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          toolCallId: callId,
          isError: false,
          content: result.content,
        },
      },
    });
    await delay(20);
    expect(deps.segments.at(-1)).toEqual({
      line: 2,
      prefix: longLine.slice(0, 2000),
      snapshotId: 'snapshot-k',
    });
  });

  test('a file at or above the streaming threshold goes through streamText on the same cursor pages', async () => {
    const streamed = 'line\n'.repeat(40);
    files.set('stream.txt', streamed);
    const agent = await createAgent('session-4');
    probe.claim(agent, run as never, 1);
    const before = probe.stats();
    const { result } = await read(agent, {
      file_path: 'stream.txt',
      offset: 2,
      limit: 3,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain(
      '(Showing lines 2-4 of 40. Use offset=5 to continue.)',
    );
    expect(probe.stats().pages - before.pages).toBe(
      Math.ceil(Buffer.byteLength(streamed) / pageSize),
    );
    expect(probe.stats().stat - before.stat).toBe(1);
  });

  test('without a valid permit the root guard denies before any provider call', async () => {
    const agent = await createAgent('session-5');
    probe.claim(agent, run as never, 1);
    const forged = serviceFixture({ permitDigest: 'wrong' });
    const original = route;
    route = forged.service;
    try {
      const { result } = await read(agent, { file_path: 'doc.txt' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        'Tools are disabled in this RDWS stage',
      );
      expect(forged.log).toEqual(['read-tool-permit']);
    } finally {
      route = original;
    }
  });

  test('an argument outside the exact shape never reaches the permit or the provider', async () => {
    const agent = await createAgent('session-6');
    probe.claim(agent, run as never, 1);
    const before = probe.stats();
    // The locked schema rejects the unknown key before the permit request.
    const { result } = await read(agent, {
      file_path: 'doc.txt',
      sessionId: 'x',
    });
    expect(result.isError).toBe(true);
    expect(probe.stats()).toEqual(before);
  });

  test('an unclaimed step or an un-armed run declares nothing and executes nothing', async () => {
    const agent = await createAgent('session-7');
    const signal = AbortSignal.timeout(10_000);
    const names = ctx.tools
      .schemas(agent, await ctx.tools.resolve({ agent, signal }))
      .map((s: { name: string }) => s.name);
    expect(names).toEqual([]);
    const { result } = await read(agent, { file_path: 'doc.txt' });
    expect(result.isError).toBe(true);
    armed = false;
    try {
      const armedAgent = await createAgent('session-8');
      probe.claim(armedAgent, run as never, 1);
      expect(
        ctx.tools
          .schemas(
            armedAgent,
            await ctx.tools.resolve({ agent: armedAgent, signal }),
          )
          .map((s: { name: string }) => s.name),
      ).toEqual([]);
    } finally {
      armed = true;
    }
  });
});
