import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sessionId, correlation, mode] = process.argv.slice(2);
const callId = 'call-' + correlation;
const name = 'rdws_broker_fixture';
const installed = createRequire(resolve('dsh/package.json'));
const native = createRequire(
  installed.resolve('@deepseek-ai/dsh/package.json'),
);
const load = (id) =>
  import(pathToFileURL(native.resolve('@deepseek-ai/' + id)).href);
const { Context } = await load('cordis');
const llm = await load('dsh-llm');
const ctx = new Context();
let liveCall;
let followUp;

function send(message) {
  return new Promise((resolve, reject) =>
    process.send({ ...message, correlation }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

async function exchange(message, expected) {
  let timer;
  let onMessage;
  let onDisconnect;
  const response = new Promise((resolve, reject) => {
    onMessage = (value) => {
      if (value?.type === expected && value.correlation === correlation)
        resolve(value);
    };
    onDisconnect = () => reject(new Error('Fixture parent disconnected'));
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    timer = setTimeout(
      () => reject(new Error('Fixture parent response timed out')),
      12_000,
    );
  });
  try {
    const [, value] = await Promise.all([send(message), response]);
    return value;
  } finally {
    clearTimeout(timer);
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
  }
}

try {
  await ctx.plugin(llm.default);
  for (const id of ['dsh-session', 'dsh-session-projection'])
    await ctx.plugin((await load(id)).default);
  await ctx.plugin((await load('dsh-system-prompt')).default, {
    personaPrefix: '',
    personaSuffix: '',
  });
  await ctx.plugin((await load('dsh-tools')).default);
  await ctx.plugin(await load('dsh-tool-executor-native'));
  await ctx.plugin((await load('dsh-agent')).default);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  let requested = false;
  class FixtureAdapter extends llm.LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(options) {
      if (requested) {
        followUp = options.messages.find(
          (message) => message.role === 'tool' && message.toolCallId === callId,
        );
        const block = { type: 'text', text: 'Fixture completed' };
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: block.text };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      requested = true;
      await exchange(
        {
          type: 'declared',
          names: options.tools?.map((tool) => tool.name) ?? [],
        },
        'dispatch',
      );
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name,
        argumentsDelta: '{}',
      };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name, arguments: '{}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['synthetic'], new FixtureAdapter());
  ctx.on(
    'session/event',
    (session, event) => {
      if (session.id === sessionId && event.type === 'tool/call')
        liveCall = event;
    },
    { global: true },
  );
  ctx.tools.guard((exec) => {
    if (
      exec.name !== name ||
      exec.agent?.session.id !== sessionId ||
      liveCall?.data.callId !== exec.callId ||
      liveCall.data.turn !== 1 ||
      liveCall.data.step !== 1
    )
      return 'Fixture has no current Native tool call';
  });
  const { agent, dispose } = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'synthetic', model: 'broker-fixture' },
    setup(scope) {
      scope.tools.register(
        {
          name,
          description: 'Run the fixed parent Broker fixture',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute() {
            const call = {
              sessionId,
              callId: liveCall.data.callId,
              turn: liveCall.data.turn,
              step: liveCall.data.step,
              seq: liveCall.seq,
            };
            await send({ type: 'observed', call });
            const { outcome } = await exchange(
              {
                type: 'invoke',
                call:
                  mode === 'mismatch' ? { ...call, seq: call.seq + 1 } : call,
              },
              'outcome',
            );
            return JSON.stringify(outcome);
          },
        },
        { when: () => !requested },
      );
    },
  });
  try {
    agent.followup(
      llm.createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Execute the fixed fixture tool' }],
      }),
    );
    await agent.whenIdle();
    const result = agent.session
      .snapshotEvents()
      .find((event) => event.type === 'tool/result');
    await send({
      type: 'complete',
      cause: liveCall?.seq,
      refs: result?.sourceEventSeqs,
      message: result?.data.message,
      followUp,
    });
  } finally {
    await dispose();
  }
} finally {
  await ctx.fiber.dispose();
  if (process.connected) process.disconnect();
}
