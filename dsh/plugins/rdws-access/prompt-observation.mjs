import { onlyKeys } from '../../bridge/access.ts';

const fields = [
  'requirementId',
  'sessionId',
  'workspaceId',
  'userId',
  'requestId',
  'peerNonce',
];

export async function observePrompt(ctx, input, workspace) {
  if (
    !onlyKeys(input, fields) ||
    fields.some(
      (field) =>
        typeof input[field] !== 'string' ||
        !input[field] ||
        input[field].length > 128,
    ) ||
    workspace.id !== input.workspaceId
  )
    throw new Error('Prompt observation scope mismatch');

  async function locate() {
    const view = await ctx.sessionQuery.observeSession(input.sessionId, {
      projectionMode: 'none',
    });
    try {
      if (
        view.header.id !== input.sessionId ||
        view.header.cwd !== workspace.path
      )
        throw new Error('Prompt observation session mismatch');
      const seen = new Set();
      for (const event of view.events) {
        const messages =
          event.type === 'agent/inbox/spliced'
            ? event.data.inserted
            : event.type === 'user/message'
              ? [event.data]
              : [];
        for (const message of messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          const source = message.source;
          if (
            event.seq >= view.inheritedEventCount &&
            event.type === 'agent/inbox/spliced' &&
            source?.kind === 'user' &&
            source.rpcId === input.requestId &&
            source.principal?.kind === 'rdws' &&
            source.principal.userId === input.userId &&
            source.principal.nonce === input.peerNonce
          )
            return {
              source: view.source,
              sequence: event.seq,
              messageId: message.id,
            };
        }
      }
    } finally {
      view[Symbol.dispose]();
    }
  }

  const agentBefore = Boolean(ctx.agents.get(input.sessionId));
  const first = await locate();
  if (!first || !['live', 'prepared'].includes(first.source))
    return { accepted: false };
  if (first.source === 'live') {
    const session = ctx.sessions.get(input.sessionId);
    if (!session || !(await ctx.sessions.flush(session)))
      return { accepted: false };
    const appeared = await locate();
    if (
      appeared?.sequence !== first.sequence ||
      appeared.messageId !== first.messageId
    )
      return { accepted: false };
  }
  return {
    accepted: true,
    sequence: first.sequence,
    messageId: first.messageId,
    source: first.source,
    agentBefore,
    agentAfter: Boolean(ctx.agents.get(input.sessionId)),
  };
}
