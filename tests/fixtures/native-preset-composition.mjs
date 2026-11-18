import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

export const name = 'test-native-preset-composition';
export const inject = [
  'agentPresets',
  'sessionController',
  'sessions',
  'workspaceRegistry',
];

export function apply(ctx, { checkpoint, live, ...fixture }) {
  ctx.effect(() => {
    const stop = new AbortController();
    const start = setImmediate(async () => {
      const result = await observe(ctx, fixture).catch((error) => ({
        error: String(error),
      }));
      await saveObservation(checkpoint, result);
      if (live && !result.error) {
        const updated = await registerLive(
          ctx,
          fixture,
          live,
          result,
          stop.signal,
        ).catch((error) => ({ error: String(error) }));
        if (!stop.signal.aborted)
          await saveObservation(live.checkpoint, updated);
      }
    });
    return () => {
      clearImmediate(start);
      stop.abort();
    };
  });
}

function saveObservation(checkpoint, result) {
  return writeFile(checkpoint, JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
}

async function registerLive(ctx, fixture, live, before, signal) {
  while (!existsSync(live.signal)) await pause(25, undefined, { signal });
  signal.throwIfAborted();
  const { next, duplicate, broken } = live;
  const unregisterNext = await ctx.agentPresets.register(next);
  ctx.effect(() => unregisterNext);
  let duplicateError;
  try {
    const unregister = await ctx.agentPresets.register(duplicate);
    ctx.effect(() => unregister);
  } catch (error) {
    duplicateError = error.message;
  }
  const retained = await ctx.agentPresets.readDocument(duplicate.id);
  const unregisterBroken = await ctx.agentPresets.register(broken);
  ctx.effect(() => unregisterBroken);
  const brokenPreset = await ctx.agentPresets.resolve(broken.id);
  let brokenError;
  try {
    await ctx.sessionController.create({
      workspaceId: before.workspaceId,
      agentPreset: broken.id,
    });
  } catch (error) {
    brokenError = error.code;
  }
  const updated = await observe(ctx, {
    ...fixture,
    create: [next.id],
    resume: before.sessionIds,
  });
  return {
    ...updated,
    duplicateError,
    retainedDefinition: retained.content,
    brokenError,
    invalidComposition: brokenPreset.broken,
  };
}

async function observe(ctx, { cwd, create, resume, unknownPreset, selection }) {
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
    if (selection) agent.model.select(selection);
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
    pid: process.pid,
    defaultPreset: ctx.agentPresets.defaultId,
    workspaceId: workspace.id,
    sessionIds: current.sessionIds,
    created,
    agents,
    unknownError,
  };
}
