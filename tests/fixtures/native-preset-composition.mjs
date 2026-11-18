import { writeFile } from 'node:fs/promises';

export const name = 'test-native-preset-composition';
export const inject = [
  'agentPresets',
  'sessionController',
  'sessions',
  'workspaceRegistry',
];

export function apply(ctx, { checkpoint, ...fixture }) {
  ctx.effect(() => {
    const start = setImmediate(async () => {
      const result = await observe(ctx, fixture).catch((error) => ({
        error: String(error),
      }));
      await writeFile(checkpoint, JSON.stringify(result), {
        flag: 'wx',
        mode: 0o600,
      });
    });
    return () => clearImmediate(start);
  });
}

async function observe(ctx, { cwd, create, resume, unknownPreset }) {
  const workspace = await ctx.workspaceRegistry.create(cwd, 'Preset fixture');
  const created = [];
  for (const agentPreset of create)
    created.push(
      await ctx.sessionController.create({
        workspaceId: workspace.id,
        agentPreset,
      }),
    );
  const agents = [];
  for (const sessionId of [...resume, ...created.map((row) => row.sessionId)]) {
    const result = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in result) {
      agents.push({
        sessionId,
        error: result.error.code,
        message: result.error.message,
      });
      continue;
    }
    const { agent } = result;
    const compositions = ctx.agentPresets.inspectCompositions(agent.ctx);
    if (!(await ctx.sessions.flush(agent.session)))
      throw new Error('Fixture did not receive a durable session checkpoint');
    agents.push({
      sessionId,
      recordedPreset: ctx.agentPresets.presetForSession(agent.session),
      compositions: compositions.map((composition) => ({
        id: composition.id,
        modules: composition.modules.map((module) => module.moduleName),
        leakedServices: composition.leakedServices,
      })),
    });
  }
  let unknownError;
  try {
    await ctx.sessionController.create({
      workspaceId: workspace.id,
      agentPreset: unknownPreset,
    });
  } catch (error) {
    unknownError = error.code;
  }
  const current = ctx.workspaceRegistry
    .list()
    .find((row) => row.id === workspace.id);
  return {
    workspaceId: workspace.id,
    sessionIds: current.sessionIds,
    created,
    agents,
    unknownError,
  };
}
