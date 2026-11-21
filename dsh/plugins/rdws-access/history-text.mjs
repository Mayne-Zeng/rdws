import { bodyHash } from '../../bridge/access.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

const historyTextCalls = new AsyncLocalStorage();

export function withHistoryText(plan, work) {
  return historyTextCalls.run(plan, work);
}

export function readImageForCall(read, owner, ref, args) {
  if (historyTextCalls.getStore())
    throw new Error('Native attachment evidence unavailable');
  return read.call(owner, ref, ...args);
}

export function consumeHistoryText(options) {
  const plan = historyTextCalls.getStore();
  if (!plan) return options;
  if (!plan.active || plan.used || options !== plan.original || !plan.current())
    throw new Error('Native history projection unavailable');
  plan.used = true;
  return plan.projected;
}

export function textWitness(message, identity) {
  if (
    !identity ||
    message?.role !== 'user' ||
    message.source?.kind !== 'user' ||
    typeof message.id !== 'string' ||
    !Array.isArray(message.content) ||
    !message.content.length ||
    !message.content.every(
      (part) => part.type === 'text' && typeof part.text === 'string',
    )
  )
    return;
  return { id: message.id, identity, digest: bodyHash(message.content) };
}

export function matchesText(witness, message, identity) {
  const actual = textWitness(message, identity);
  return (
    !!witness &&
    !!actual &&
    actual.id === witness.id &&
    actual.identity === witness.identity &&
    actual.digest === witness.digest
  );
}

export function currentTextPosition(messages, witness, sourceKey) {
  let position = -1;
  for (const [index, message] of messages.entries()) {
    const identity = sourceKey(message);
    if (message.id === witness.id || identity === witness.identity) {
      if (position !== -1 || !matchesText(witness, message, identity))
        return -1;
      position = index;
    } else if (
      position !== -1 &&
      (message.source?.kind === 'user' || message.source?.kind === 'retry')
    )
      return -1;
  }
  return position;
}

export function requireImageScope(
  enabled,
  options,
  agentRequest,
  call,
  origin,
) {
  if (
    enabled &&
    options.messages.some((message) =>
      message.content.some((part) => part.type === 'image'),
    ) &&
    (!agentRequest || !call.bindingId || !origin || !origin.isCurrent())
  )
    throw new Error('Native attachment evidence unavailable');
}
