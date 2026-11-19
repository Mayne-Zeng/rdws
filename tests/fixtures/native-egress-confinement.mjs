import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

export const name = 'test-native-egress-confinement';
export const inject = ['llm', 'webServer', 'credentials', 'attachments'];

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
);

function connect(origin) {
  const { hostname: host, port } = new URL(origin);
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error) => resolve(error.code));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve('timeout');
    });
  });
}

export function apply(ctx, { callback, relay, supplier, allowDirect }) {
  const report = async (path, evidence) => {
    const response = await fetch(callback + path, {
      method: 'POST',
      body: JSON.stringify({ pid: process.pid, ...evidence }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Fixture callback rejected');
  };
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__fixture_egress_ready',
      auth: 'anonymous',
      handler: (_request, response) => response.end(String(process.pid)),
    }),
  );

  async function model(provider, modelId, marker, attachment) {
    let text = '';
    let reason;
    for await (const chunk of ctx.llm.stream({
      provider,
      model: modelId,
      sessionId: 'egress-fixture-session',
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: marker },
            ...(attachment ? [{ type: 'image', attachment }] : []),
          ],
        },
      ],
      signal: AbortSignal.timeout(3000),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish') reason = chunk.reason;
    }
    return {
      marker,
      text,
      finish: reason?.kind,
      failure: reason?.failure?.message,
    };
  }

  async function probe() {
    const readyBy = Date.now() + 8000;
    while (
      !ctx.webServer.port ||
      !(await ctx.credentials.resolve('FIXTURE_MODEL'))
    ) {
      if (Date.now() >= readyBy)
        throw new Error('Fixture services did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const direct = await connect(supplier);
    const directModel = await model(
      'fixture-direct',
      'direct-model',
      'Synthetic direct fixture',
    );
    const findings = { direct, directModel, port: ctx.webServer.port };
    if (allowDirect) return report('/finish', findings);

    const pi = await model(
      'fixture-relay',
      'relay-model',
      'Synthetic PiAi relay fixture',
    );
    const attachment = await ctx.attachments.saveImage({
      data: png,
      mediaType: 'image/png',
    });
    const deepseek = await model(
      'deepseek-official',
      'fixture-vision',
      'Synthetic Messages fixture',
      attachment,
    );
    await report('/close-relay', {});
    const closed = await connect(relay);
    const afterClose = await model(
      'fixture-relay',
      'relay-model',
      'Synthetic request after close',
    );
    await report('/finish', { ...findings, pi, deepseek, closed, afterClose });
  }

  void probe()
    .catch((error) => report('/fail', { message: String(error) }))
    .catch(() => {});
}
