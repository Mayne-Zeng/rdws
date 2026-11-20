import { appendFile, readFile, writeFile } from 'node:fs/promises';

export const name = 'test-t13-passive-queue';
export const inject = ['sessionController', 'sessions'];

export function apply(ctx, { target, armed, checkpoint, observed }) {
  const record = (type, value) => {
    if (observed)
      void appendFile(observed, `${JSON.stringify({ type, ...value })}\n`, {
        mode: 0o600,
      }).catch(() => {});
  };
  ctx.on(
    'agent/created',
    ({ agent }) => {
      record('created', { sessionId: agent.session.id });
    },
    { global: true },
  );
  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message }) => {
      record('claimed', { sessionId: agent.session.id, messageId: message.id });
    },
    { global: true },
  );
  if (!target) return;

  async function hold({ sessionId, requestId }) {
    const result = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in result) throw new Error('Fixture Agent unavailable');
    const { agent } = result;
    await agent.runMaintenance(async (signal) => {
      const dispose = ctx.on(
        'agent/inbox/inserted',
        ({ agent: source, message }) => {
          if (source !== agent || message.source?.rpcId !== requestId) return;
          void (async () => {
            if (!(await ctx.sessions.flush(agent.session)))
              throw new Error('Fixture journal flush failed');
            if (!agent.inbox.nextTurn.some((value) => value.id === message.id))
              throw new Error('Fixture input was already consumed');
            await writeFile(
              checkpoint,
              JSON.stringify({ sessionId, messageId: message.id }),
              { mode: 0o600 },
            );
          })().catch(() => record('error', { sessionId }));
        },
        { global: true },
      );
      try {
        const stopped = new Promise((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
        await writeFile(armed, JSON.stringify({ sessionId }), { mode: 0o600 });
        await stopped;
      } finally {
        dispose();
      }
    });
  }

  ctx.effect(() => {
    let started = false;
    const timer = setInterval(async () => {
      if (started) return;
      const input = await readFile(target, 'utf8').catch(() => '');
      if (!input || started) return;
      started = true;
      clearInterval(timer);
      try {
        await hold(JSON.parse(input));
      } catch {
        record('error', {});
      }
    }, 30);
    return () => clearInterval(timer);
  });
}
