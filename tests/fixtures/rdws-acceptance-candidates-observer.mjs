import { readFile, writeFile } from 'node:fs/promises';

export const name = 'rdws-acceptance-candidates-observer';
export const inject = [
  'agentPresets',
  'sessionController',
  'sessionSkillCatalog',
  'systemPrompt',
  'skills',
];
const skillName = 'requirement-acceptance-checklist';

export function apply(ctx, { request, response }) {
  let previous;
  let running = false;
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const text = await readFile(request, 'utf8').catch(() => '');
        if (!text || text === previous) return;
        previous = text;
        const { id, sessions } = JSON.parse(text);
        const values = await Promise.all(
          sessions.map(async ({ sessionId, cwd }) => {
            const result = await ctx.sessionController.resolveAgent(sessionId);
            if ('error' in result) return { error: result.error.code };
            const { agent } = result;
            const signal = AbortSignal.timeout(2000);
            const prompt = await ctx.systemPrompt.assemble({
              agent,
              scope: agent,
              signal,
            });
            const catalog = await ctx.sessionSkillCatalog.list(
              { sessionId },
              signal,
            );
            const skill = await ctx.skills.get(skillName, {
              scope: agent,
              cwd,
              signal,
            });
            return {
              guidance: prompt.sections
                .filter(
                  ({ name }) => name === 'rdws-acceptance-session-guidance',
                )
                .map(({ text }) => text),
              userCatalog: catalog.skills
                .filter(({ name }) => name === skillName)
                .map(({ name, description, modelInvocable }) => ({
                  name,
                  description,
                  modelInvocable,
                })),
              modelPromptListsSkill: [
                ...prompt.sections,
                ...prompt.contexts,
              ].some(({ text }) => text.includes(skillName)),
              skill: skill
                ? { invocation: skill.invocation, content: skill.content }
                : null,
              offlineMcp:
                ctx.agentPresets.serviceFor(agent, 'rdwsOfflineMcp') ?? null,
              tools: agent.ctx.tools.schemas().map(({ name }) => name),
            };
          }),
        ).catch(() => [{ error: 'Native acceptance observation failed' }]);
        await writeFile(response, JSON.stringify({ id, values }));
      } finally {
        running = false;
      }
    }, 30);
    return () => clearInterval(timer);
  });
}
