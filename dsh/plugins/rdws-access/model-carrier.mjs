import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import {
  openModelCarrier,
  snapshotModelRoutes,
} from '../../bridge/model-carrier.ts';

export function installModelCarrier(ctx, generation, configuredRoutes) {
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
      const call = {
        id: randomUUID(),
        provider: options.provider,
        model: options.model,
        sessionId: options.sessionId,
        purpose: options.purpose,
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
