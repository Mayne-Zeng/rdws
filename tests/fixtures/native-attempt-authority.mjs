export const name = 'test-native-attempt-authority';
export const inject = ['llm'];

export function apply(ctx) {
  let observed = false;
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (
        !observed &&
        options.messages.some(
          (message) => message.source?.kind === 'rdws-context',
        )
      ) {
        observed = true;
        await Array.fromAsync(ctx.llm.stream({ ...options }));
      }
      yield* next();
    },
    { global: true, prepend: true },
  );
}
