import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

export const name = 'test-native-model-carrier';
export const inject = ['llm', 'webServer', 'credentials', 'attachments'];

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
);

export function apply(ctx, { port }) {
  let firstChunk = false;
  let firstWaiterAborted = false;
  let addWaiter;
  async function generate(
    provider,
    model,
    sessionId,
    attachment,
    cancel,
    controller = new AbortController(),
  ) {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(5000),
    ]);
    let text = '',
      finish,
      diagnostic;
    try {
      for await (const item of ctx.llm.stream({
        provider,
        model,
        sessionId,
        ...(sessionId === 'concurrent' ? { purpose: 'session-title' } : {}),
        signal,
        messages: [
          {
            id: randomUUID(),
            role: 'user',
            source: { kind: 'user' },
            content: [
              { type: 'text', text: `Synthetic carrier ${sessionId}` },
              ...(attachment ? [{ type: 'image', attachment }] : []),
            ],
          },
        ],
      })) {
        if (item.type === 'text-delta') {
          text += item.text;
          if (sessionId === 'pi') firstChunk = true;
          if (cancel) controller.abort();
        }
        if (item.type === 'finish') {
          finish = item.reason.kind;
          diagnostic = item.reason.failure?.message;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      finish = 'aborted';
    }
    return { text, finish, diagnostic };
  }

  async function probe(sharedUpload) {
    const deadline = Date.now() + 2000;
    while (!(await ctx.credentials.resolve('FIXTURE_MODEL'))) {
      if (Date.now() >= deadline)
        throw new Error('Fixture credentials unavailable');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const tcp = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error) => resolve(error.code));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve('timeout');
      });
    });
    const outside = await generate(
      'fixture-unapproved',
      'fixture-other',
      'unapproved',
    );
    const denied = await generate('rdws-glm', 'fixture-pi', 'denied');
    const pi = await generate('rdws-glm', 'fixture-pi', 'pi');
    const attachment = await ctx.attachments.saveImage({
      data: png,
      mediaType: 'image/png',
    });
    const allDenied = await generate(
      'deepseek-official',
      'fixture-vision',
      'deepseek-denied',
      attachment,
    );
    const fallback = await generate(
      'deepseek-official',
      'fixture-vision',
      'deepseek-inline',
      attachment,
    );
    let firstWaiter, deepseek;
    if (sharedUpload) {
      const secondReady = new Promise((resolve) => {
        addWaiter = resolve;
      });
      const firstController = new AbortController();
      const first = generate(
        'deepseek-official',
        'fixture-vision',
        'shared-first',
        attachment,
        false,
        firstController,
      );
      await secondReady;
      const second = generate(
        'deepseek-official',
        'fixture-vision',
        'deepseek',
        attachment,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      firstController.abort();
      firstWaiter = await first;
      firstWaiterAborted = firstWaiter.finish === 'aborted';
      deepseek = await second;
    } else
      deepseek = await generate(
        'deepseek-official',
        'fixture-vision',
        'deepseek',
        attachment,
      );
    const [canceled, concurrent] = await Promise.all([
      generate('rdws-glm', 'fixture-pi', 'cancel', undefined, true),
      generate('rdws-glm', 'fixture-pi', 'concurrent'),
    ]);
    return {
      pid: process.pid,
      tcp,
      outside,
      denied,
      pi,
      deepseek,
      firstWaiter,
      allDenied,
      fallback,
      canceled,
      concurrent,
    };
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__fixture_model_carrier',
      auth: 'anonymous',
      async handler(request, response) {
        try {
          const shared = new URL(
            request.url ?? '/',
            'http://127.0.0.1',
          ).searchParams.has('shared');
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(await probe(shared)));
        } catch {
          response.writeHead(500).end('Fixture failed');
        }
      },
    }),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__fixture_model_progress',
      auth: 'anonymous',
      handler(_request, response) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ firstChunk, firstWaiterAborted }));
      },
    }),
  );
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__fixture_model_waiter',
      auth: 'anonymous',
      handler(_request, response) {
        addWaiter?.();
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
      },
    }),
  );
}
