export const name = 'test-native-queued-checkpoint';
export const inject = ['sessionController', 'sessions'];

export function apply(ctx, { origin, requestId, queue }) {
  const post = async (path, value, timeout = 5000) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error('Checkpoint fixture request failed');
    return response;
  };
  const reportError = (error) =>
    post('/fixture-error', { message: String(error) }).catch(() => {});
  void (async () => {
    const { sessionId } = await (await post('/target', {}, 10_000)).json();
    const target = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in target) throw target.error;
    const agent = target.agent;
    await agent.runMaintenance(async (signal) => {
      const detach = ctx.on(
        'agent/inbox/inserted',
        ({ agent: source, message }) => {
          if (source !== agent || message.source?.rpcId !== requestId) return;
          void (async () => {
            if (!(await ctx.sessions.flush(agent.session)))
              throw new Error('Native persistence did not acknowledge flush');
            const pending =
              queue === 'next-step'
                ? agent.inbox.nextStep
                : agent.inbox.nextTurn;
            const queued = pending.filter((item) => item.id === message.id);
            if (queued.length !== 1) throw new Error('Input already claimed');
            await post('/checkpoint', {
              sessionId,
              requestId,
              messageId: message.id,
            });
          })().catch(reportError);
        },
        { global: true },
      );
      try {
        const terminated = new Promise((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
        await post('/armed', { sessionId });
        await terminated;
      } finally {
        detach();
      }
    });
  })().catch(reportError);
}
