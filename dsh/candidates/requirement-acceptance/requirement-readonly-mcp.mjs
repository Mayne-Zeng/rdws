export const name = 'rdws-requirement-readonly-mcp';

const definition = Object.freeze({
  name,
  title: '需求资料只读',
  protocol: 'mcp',
  transport: null,
  source: Object.freeze({
    method: 'GET',
    route: '/api/requirements/:id',
    scope: 'current-requirement',
    responseKey: 'requirement',
    fields: Object.freeze(['title', 'description', 'acceptance']),
  }),
});

export function apply(ctx) {
  ctx.isolate('rdwsOfflineMcp').provide('rdwsOfflineMcp', definition);
}
