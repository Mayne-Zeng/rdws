export const name = 'rdws-requirement-acceptance-checklist';
export const inject = ['skills'];

export function apply(ctx) {
  ctx.skills.register({
    name: 'requirement-acceptance-checklist',
    description:
      '需求验收清单。按当前需求的验收标准和用户提供的测试证据整理草稿。',
    content: [
      '按当前需求的验收标准逐条整理清单草稿。',
      '每条列出验收标准、用户提供的测试证据及出处、已验证结果或待验证事项。',
      '标准或证据缺失时标为待验证，写明需要补充的材料或验证步骤，交由用户确认。',
    ].join('\n'),
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  });
}
