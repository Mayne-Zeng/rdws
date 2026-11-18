import { readFile, writeFile } from 'node:fs/promises';

export const name = 'rdws-capability-fixture-observer';
export const inject = [
  'agentPresets',
  'sessionController',
  'sessionSkillCatalog',
  'sessionQuery',
  'sessions',
];

export function apply(ctx, { request, response }) {
  ctx.effect(() => {
    let previous;
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const text = await readFile(request, 'utf8');
        if (previous === text) return;
        previous = text;
        const { id, sessions, select } = JSON.parse(text);
        const values = [];
        for (const sessionId of sessions) {
          const result = await ctx.sessionController.resolveAgent(sessionId);
          if ('error' in result) {
            values.push({ sessionId, error: result.error.code });
            continue;
          }
          const { agent } = result;
          let selectionError;
          if (select?.sessionId === sessionId) {
            try {
              await ctx.agentPresets.select(agent, select.agentPreset);
            } catch (error) {
              selectionError = error.code;
            }
          }
          const observation = await ctx.sessionQuery.observeSession(sessionId);
          const headerPreset = observation.header.agentPreset;
          observation[Symbol.dispose]();
          const compositions = ctx.agentPresets.inspectCompositions(agent.ctx);
          const catalog = await ctx.sessionSkillCatalog.list(
            { sessionId },
            new AbortController().signal,
          );
          const flushed = await ctx.sessions.flush(agent.session);
          values.push({
            sessionId,
            headerPreset,
            selectionError,
            names: compositions.flatMap((composition) =>
              composition.modules.map((module) => module.moduleName),
            ),
            skills: catalog.skills.map(({ name }) => name),
            offlineMcp:
              ctx.agentPresets.serviceFor(agent, 'rdwsOfflineMcp') ?? null,
            tools: agent.ctx.tools.schemas().map(({ name }) => name),
            flushed,
          });
        }
        await writeFile(response, JSON.stringify({ id, values }));
      } catch {
        // The probe waits for the test to publish a request.
      } finally {
        running = false;
      }
    }, 30);
    return () => clearInterval(timer);
  });
}
