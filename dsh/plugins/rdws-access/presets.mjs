import { registerHooks } from 'node:module';
import { DemandPresets, isDemandPreset } from '../../host/presets.ts';
import { onlyKeys } from '../../bridge/access.ts';

export function installPresets(ctx, config, route) {
  const store = new DemandPresets(
    config.presetRuntimeHome,
    config.projectId,
    config.releasedCapabilities,
  );
  const loaded = new Map();
  const pending = new Map();
  const releaseSources = new Map();
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (releaseSources.has(context.parentURL))
        throw new Error('Released capability must be self-contained');
      return next(specifier, context);
    },
    load(url, context, next) {
      const source = releaseSources.get(url);
      return source
        ? { format: 'module', source, shortCircuit: true }
        : next(url, context);
    },
  });
  ctx.effect(() => () => hooks.deregister());
  async function register(definition) {
    const { id, requirementId } = definition;
    const plugins = (await store.plugins(definition)).map(
      ({ id, name, source }) => {
        releaseSources.set(name, source);
        return { id, name };
      },
    );
    const unregister = await ctx.agentPresets.register({ id, plugins });
    try {
      const resolved = await ctx.agentPresets.resolve(id);
      const matches = ctx.agentPresets
        .inspectCompositions()
        .filter((row) => row.id === id);
      const active = matches[0];
      if (
        resolved.id !== id ||
        resolved.broken !== undefined ||
        matches.length !== 1 ||
        active.leakedServices.length !== 0 ||
        active.modules.length !== plugins.length ||
        plugins.some(
          (plugin, index) => active.modules[index]?.moduleName !== plugin.name,
        )
      )
        throw new Error('Native preset composition differs from the release');
      ctx.effect(() => unregister);
      loaded.set(id, requirementId);
    } catch (error) {
      await unregister();
      throw error;
    }
  }
  async function ensure(id, requirementId) {
    const definition = await store.read(id, requirementId);
    if (!loaded.has(id)) {
      let loading = pending.get(id);
      if (!loading) {
        loading = register(definition);
        pending.set(id, loading);
      }
      try {
        await loading;
      } finally {
        if (pending.get(id) === loading) pending.delete(id);
      }
    }
    if (loaded.get(id) !== definition.requirementId)
      throw new Error('Native preset scope differs');
    return { id };
  }
  route('preset.ensure', (input) => {
    if (
      !onlyKeys(input, ['id', 'requirementId']) ||
      !isDemandPreset(input.id) ||
      typeof input.requirementId !== 'string'
    )
      throw new Error('Invalid preset request');
    return ensure(input.id, input.requirementId);
  });
  return {
    ensure,
    loaded: (id, requirementId) => loaded.get(id) === requirementId,
  };
}
