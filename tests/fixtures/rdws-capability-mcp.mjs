export const name = 'rdws-capability-fixture-mcp';
const definition = Object.freeze({
  name: 'rdws-offline-mcp-fixture',
  protocol: 'mcp',
  transport: null,
});
export function apply(ctx) {
  ctx.isolate('rdwsOfflineMcp').provide('rdwsOfflineMcp', definition);
}
