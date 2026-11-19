import AllowedTitleService from './allowed-title-service.mjs';
import {
  bindTitleCall,
  cancelTitleOrigins,
  loadNativeTitlePackage,
  setTitleReady,
  titleUnavailable,
} from './title-binding.mjs';

const stock = await loadNativeTitlePackage(
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
);
export const name = 'rdws-first-message-title';
export const inject = ['sessionTitle', 'llm', 'sessions'];
export const Config = stock.Config;

export async function apply(ctx, config) {
  if (!(ctx.sessionTitle instanceof AllowedTitleService))
    throw titleUnavailable();
  const events = new WeakMap();
  ctx.on(
    'session/event',
    (session, event) => {
      if (event.type === 'session/title-llm-request')
        events.set(session, event);
    },
    { global: true },
  );
  const original = ctx.llm;
  const scope = ctx.isolate('llm');
  scope.provide('llm', {
    async prepareCall(...args) {
      try {
        const prepared = await original.prepareCall(...args);
        return {
          ...prepared,
          async *stream(options) {
            try {
              const session = ctx.sessions.get(options.sessionId);
              const event = session && events.get(session);
              if (!session || !event) throw titleUnavailable();
              events.delete(session);
              const request = await bindTitleCall(options, event, () =>
                ctx.sessions.flush(session),
              );
              for await (const chunk of prepared.stream(request)) {
                if (
                  chunk.type === 'finish' &&
                  (chunk.reason.kind === 'error' ||
                    chunk.reason.kind === 'aborted')
                )
                  throw titleUnavailable();
                yield chunk;
              }
            } catch {
              throw titleUnavailable();
            }
          },
        };
      } catch {
        throw titleUnavailable();
      }
    },
  });
  await scope.plugin(stock, config);
  setTitleReady(true);
  ctx.effect(() => () => {
    setTitleReady(false);
    cancelTitleOrigins(() => true);
  });
}
