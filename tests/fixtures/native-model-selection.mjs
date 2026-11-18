export const name = 'test-native-model-selection';
export const inject = ['sessionController', 'llm'];

export async function apply(ctx, { sessionId, selection }) {
  const result = await ctx.sessionController.resolveAgent(sessionId);
  if ('error' in result) throw result.error;
  await ctx.llm.resolveCallConfig(selection);
  result.agent.model.select(selection);
}
