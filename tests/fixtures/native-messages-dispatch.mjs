import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const name = 'test-native-messages-dispatch';
export const inject = ['llm', 'attachments', 'deepseekLlmApiExtensions'];

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
);

function requestImage(body) {
  return body.messages
    .flatMap((message) => message.content)
    .find((part) => part.type === 'image')?.source;
}

export function apply(ctx, { origin, model }) {
  const calls = new AsyncLocalStorage();
  const fetch = globalThis.fetch;
  const post = (route, data, signal = AbortSignal.timeout(5000)) =>
    fetch(origin + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
  ctx.deepseekLlmApiExtensions.register('rdws_fixture_only', {
    async prepare(request) {
      const call = calls.getStore();
      if (!call) return;
      const image = requestImage(request.body);
      const response = await post(
        '/extension',
        {
          id: call.id,
          sessionId: request.sessionId,
          purpose: request.purpose,
          model: request.body.model,
          imageSource: image?.type,
        },
        request.signal,
      );
      if (!response.ok) throw new Error('Fixture extension rejected');
      return { value: 'fixture-field' };
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.origin !== origin ||
      !['/v1/files', '/v1/messages'].includes(url.pathname)
    )
      return fetch(input, init);
    const call = calls.getStore();
    if (!call) throw new Error('Missing fixture call identity');
    const id = randomUUID();
    const image =
      url.pathname === '/v1/messages'
        ? requestImage(JSON.parse(init.body))
        : undefined;
    const decision = await post(
      '/dispatch',
      {
        id,
        call: call.id,
        path: url.pathname,
        imageSource: image?.type,
        fileId: image?.file_id,
      },
      init?.signal ?? (input instanceof Request ? input.signal : undefined),
    );
    if (!decision.ok) throw new Error('Fixture dispatch declined');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('x-rdws-fixture-dispatch', id);
    return fetch(input, { ...init, headers });
  };
  ctx.on('dispose', () => {
    globalThis.fetch = fetch;
  });

  async function probe() {
    const begin = await post('/begin', {}, AbortSignal.timeout(10_000));
    if (!begin.ok) throw new Error('Fixture did not start');
    const attachment = await ctx.attachments.saveImage({
      data: png,
      mediaType: 'image/png',
    });
    for (const id of ['revoked', 'extension-error', 'cached-file']) {
      await calls.run({ id }, async () => {
        let text = '';
        let finish;
        for await (const chunk of ctx.llm.stream({
          provider: 'deepseek-official',
          model,
          sessionId: 'fixture-' + id,
          messages: [
            {
              id: randomUUID(),
              role: 'user',
              source: { kind: 'user' },
              content: [
                { type: 'text', text: 'Isolated image fixture' },
                { type: 'image', attachment },
              ],
            },
          ],
          signal: AbortSignal.timeout(5000),
        })) {
          if (chunk.type === 'finish') finish = chunk.reason.kind;
          if (chunk.type === 'text-delta') text += chunk.text;
        }
        await post('/settled', { id, finish, text });
      });
    }
  }
  void probe()
    .catch(async (error) => {
      await post('/fixture-error', { message: String(error) });
    })
    .catch(() => {});
}
