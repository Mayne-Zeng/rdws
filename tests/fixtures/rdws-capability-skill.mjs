export const name = 'rdws-capability-fixture-skill';
export const inject = ['skills'];
export function apply(ctx) {
  ctx.skills.register({
    name: 'rdws-review-example',
    description: 'A released fixture for reviewing a work item.',
    content: 'Check the stated acceptance conditions against the evidence.',
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  });
}
