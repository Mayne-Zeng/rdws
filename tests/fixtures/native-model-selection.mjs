import { writeFile } from 'node:fs/promises';

export const name = 'test-native-model-selection';
export const inject = ['sessionController', 'llm', 'sessions'];

export async function apply(ctx, { sessionId, selection, checkpoint }) {
  const result = await ctx.sessionController.resolveAgent(sessionId);
  if ('error' in result) throw result.error;
  await ctx.llm.resolveCallConfig(selection);
  await result.agent.runMaintenance(async (signal) => {
    signal.throwIfAborted();
    result.agent.model.select(selection);
    if (!(await ctx.sessions.flush(result.agent.session)))
      throw new Error('Fixture did not receive a durable session checkpoint');
    await writeFile(checkpoint, JSON.stringify(result.agent.model.current()), {
      mode: 0o600,
      flag: 'wx',
    });
  });
}
