export const name = 'rdws-acceptance-session-guidance';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  ctx.systemPrompt.section({
    name,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    interpolate: false,
    text: '验收会话提示\n需要准备验收时，按当前需求的验收标准逐项列出已提供的验证证据及出处，并标出待验证项。以实际证据判断已验证结果，整理可供人工确认的草稿。',
  });
}
