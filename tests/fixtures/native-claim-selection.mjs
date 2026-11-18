export const name = 'test-native-claim-selection';
export const inject = ['llm'];

export function apply(ctx, { requestIds, selection }) {
  const selected = new Set(requestIds);
  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message }) => {
      if (selected.has(message.source?.rpcId)) agent.model.select(selection);
    },
    { global: true },
  );
}
