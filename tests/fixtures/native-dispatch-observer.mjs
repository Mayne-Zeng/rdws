import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const name = 'test-native-dispatch-observer';
export const inject = ['llm'];

export function apply(ctx, { origin }) {
  const dispatches = new AsyncLocalStorage();
  const fetch = globalThis.fetch;
  const post = (path, body, signal) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(2000),
    });
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const scope = { options, observation: undefined, dispatched: false };
      const iterator = dispatches.run(scope, () =>
        next()[Symbol.asyncIterator](),
      );
      try {
        for (;;) {
          const result = await dispatches.run(scope, () => iterator.next());
          if (result.done) return;
          yield result.value;
        }
      } finally {
        try {
          await dispatches.run(scope, () => iterator.return?.());
        } finally {
          if (scope.observation)
            await post('/dispatch-settled', { id: scope.observation.id });
        }
      }
    },
    { global: true },
  );
  ctx.on(
    'llm-pi-ai/request-headers',
    (request, _headers, next) => {
      if (new URL(request.baseURL).origin === origin) {
        const scope = dispatches.getStore();
        if (
          !scope ||
          scope.options.sessionId !== request.sessionId ||
          scope.options.provider !== request.provider ||
          scope.options.model !== request.model ||
          scope.options.purpose !== request.purpose
        )
          throw new Error('Fixture dispatch identity mismatch');
        scope.observation = {
          id: randomUUID(),
          sessionId: request.sessionId,
          provider: request.provider,
          model: request.model,
          purpose: request.purpose ?? null,
        };
      }
      return next();
    },
    { global: true },
  );
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === origin && url.pathname === '/v1/chat/completions') {
      const scope = dispatches.getStore();
      const observation = scope?.observation;
      if (!observation || scope.dispatched)
        throw new Error('Missing or used fixture dispatch identity');
      scope.dispatched = true;
      const decision = await post(
        '/dispatch',
        observation,
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
      );
      if (!decision.ok) throw new Error('Fixture dispatch declined');
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set('x-rdws-fixture-dispatch', observation.id);
      return fetch(input, { ...init, headers });
    }
    return fetch(input, init);
  };
  ctx.on('dispose', () => {
    globalThis.fetch = fetch;
  });
}
