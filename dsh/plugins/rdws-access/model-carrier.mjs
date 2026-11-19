import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { titleCall } from './title-binding.mjs';
import {
  openModelCarrier,
  snapshotModelRoutes,
} from '../../bridge/model-carrier.ts';

export function installModelCarrier(
  ctx,
  generation,
  configuredRoutes,
  modelBindingFor,
) {
  const fromProfile = createRequire(import.meta.url);
  const fromNative = createRequire(
    fromProfile.resolve('@deepseek-ai/dsh/package.json'),
  );
  const fromAgentLoop = createRequire(
    fromNative.resolve('@deepseek-ai/dsh-agent-loop/package.json'),
  );
  const { isAgentLoopRequest } = fromAgentLoop('@deepseek-ai/dsh-llm');
  if (typeof isAgentLoopRequest !== 'function')
    throw new Error('Native model identity unavailable');
  const targets = new Map(
    [...snapshotModelRoutes(configuredRoutes)].map(([id, url]) => [url, id]),
  );
  const channel = openModelCarrier(
    new Socket({ fd: 4, readable: true, writable: true }),
    generation,
  );
  const calls = new AsyncLocalStorage();
  const original = globalThis.fetch;
  const fetchModel = async (input, init) => {
    const call = calls.getStore();
    if (!call) return original(input, init);
    let request;
    try {
      request = new Request(input, { ...init, duplex: 'half' });
    } catch {
      throw new Error('Native model route unavailable');
    }
    const route = targets.get(request.url);
    if (!route || request.method !== 'POST')
      throw new Error('Native model route unavailable');
    return channel.fetch(route, call, request);
  };
  globalThis.fetch = fetchModel;
  ctx.effect(() => () => {
    if (globalThis.fetch === fetchModel) globalThis.fetch = original;
    channel.close();
  });
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const title =
        options.purpose === 'session-title' ? titleCall(options) : undefined;
      const call = {
        id: title?.id ?? randomUUID(),
        provider: options.provider,
        model: options.model,
        sessionId: options.sessionId,
        purpose: options.purpose,
        bindingId:
          options.purpose === undefined && isAgentLoopRequest(options)
            ? modelBindingFor(options)
            : title?.bindingId,
      };
      const stream = calls.run(call, () => next()[Symbol.asyncIterator]());
      try {
        for (;;) {
          const item = await calls.run(call, () => stream.next());
          if (item.done) return;
          yield item.value;
        }
      } finally {
        await calls.run(call, () => stream.return?.());
      }
    },
    { global: true },
  );
}
