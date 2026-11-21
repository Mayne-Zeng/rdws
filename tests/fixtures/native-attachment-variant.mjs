import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

export const name = 'test-native-attachment-variant';
export const inject = ['attachments', 'llm', 'systemPrompt', 'sessionQuery'];

const image = {
  type: 'image',
  mediaType: 'image/png',
  name: 'rdws-synthetic-picture-a-first.png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPgidpCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAHy7aD0Nf3XZAAAAAElFTkSuQmCC',
};
const otherImage = {
  ...image,
  name: 'rdws-synthetic-picture-b.png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGMQKlpFU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULANkmuD10cOORAAAAAElFTkSuQmCC',
};
const sha = (data) => createHash('sha256').update(data).digest('hex');
const imageIds = ({ content }) =>
  content
    .filter((part) => part.type === 'image')
    .map(({ attachment }) => attachment.attachmentId);
const identity = (message) => ({
  id: message.id,
  requestId: message.source?.rpcId,
  userId: message.source?.principal?.userId,
  nonce: message.source?.principal?.nonce,
  images: imageIds(message),
});

export function apply(
  ctx,
  {
    accepted,
    late,
    evidencePath,
    readAttemptsPath,
    normalizeFollowUp,
    historyBarrier,
    repeatImages,
    file,
    runtimeNote,
    observeOnly,
    activationGate,
  },
) {
  if (runtimeNote)
    ctx.systemPrompt.context({
      name: 'fixture:retained-runtime',
      order: -1000,
      interpolate: false,
      text: () => runtimeNote,
    });
  const attachments = ctx.attachments;
  const scope = new AsyncLocalStorage();
  const inserted = new Map();
  const claimed = new Map();
  let firstRef;
  const marked = (message, text) =>
    message.content.some((part) => part.type === 'text' && part.text === text);

  function wrap(method, replacement, target = attachments) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);
    const original = target[method];
    const observed = replacement(original);
    Object.defineProperty(target, method, {
      configurable: true,
      writable: true,
      value: observed,
    });
    ctx.effect(() => () => {
      if (target[method] !== observed) return;
      if (descriptor) Object.defineProperty(target, method, descriptor);
      else delete target[method];
    });
  }

  if (activationGate) {
    let held = false;
    wrap(
      'observeSession',
      (original) =>
        async function (...args) {
          const pause = !held && existsSync(activationGate.arm);
          if (pause) {
            held = true;
            writeFileSync(activationGate.ready, '');
            const deadline = Date.now() + 5000;
            while (!existsSync(activationGate.release)) {
              if (Date.now() >= deadline)
                throw new Error('Synthetic activation gate expired');
              await wait(10);
            }
          }
          const result = await original.call(this, ...args);
          if (pause) writeFileSync(activationGate.resumed, '');
          return result;
        },
      ctx.sessionQuery,
    );
  }

  if (!observeOnly)
    wrap(
      'admitPromptContent',
      (original) =>
        async function (content, ...rest) {
          if (!firstRef && marked({ content }, accepted)) {
            const admitted = await original.call(
              this,
              [
                ...content,
                ...(repeatImages
                  ? [
                      image,
                      otherImage,
                      { ...image, name: 'rdws-synthetic-picture-a-last.png' },
                    ]
                  : [image]),
              ],
              ...rest,
            );
            firstRef = admitted.find(
              (part) => part.type === 'image',
            )?.attachment;
            return admitted;
          }
          return original.call(this, content, ...rest);
        },
    );

  ctx.on(
    'session/event',
    (session, event) => {
      if (event.type !== 'agent/inbox/spliced') return;
      const message = event.data.inserted.find(
        (item) => marked(item, accepted) || marked(item, late),
      );
      if (message && !inserted.has(session.id))
        inserted.set(session.id, { seq: event.seq, ...identity(message) });
    },
    { global: true },
  );
  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }) => {
      if (marked(message, accepted) || marked(message, late))
        claimed.set(agent.session.id, { turn, ...identity(message) });
    },
    { global: true },
  );
  ctx.on(
    'agent/pre-step',
    async (_event, next) => {
      const decision = await next();
      if (normalizeFollowUp && decision.kind === 'enter') {
        return {
          ...decision,
          messages: decision.messages.map((message) => {
            if (
              !message.content.some(
                (part) =>
                  part.type === 'text' &&
                  part.text.startsWith('Synthetic follow-up text at'),
              )
            )
              return message;
            return {
              ...message,
              content: message.content.map((part) =>
                part.type === 'text'
                  ? { ...part, text: part.text.trimEnd() }
                  : part,
              ),
            };
          }),
        };
      }
      if (
        decision.kind === 'enter' &&
        file &&
        decision.messages.some((message) => marked(message, file))
      ) {
        const attachment = await attachments.saveFile({
          data: Buffer.from('Synthetic file fixture'),
          name: 'rdws-synthetic-file.txt',
        });
        return {
          ...decision,
          messages: decision.messages.map((message) =>
            marked(message, file)
              ? {
                  ...message,
                  content: [...message.content, { type: 'file', attachment }],
                }
              : message,
          ),
        };
      }
      if (
        decision.kind !== 'enter' ||
        !firstRef ||
        !decision.messages.some((message) => marked(message, late))
      )
        return decision;
      return {
        ...decision,
        messages: decision.messages.map((message) =>
          marked(message, late)
            ? {
                ...message,
                content: [
                  ...message.content,
                  { type: 'image', attachment: firstRef },
                ],
              }
            : message,
        ),
      };
    },
    { global: true },
  );

  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (
        historyBarrier &&
        options.messages.some((m) =>
          m.content.some(
            (part) =>
              part.type === 'text' &&
              part.text.startsWith('Synthetic follow-up text at'),
          ),
        )
      ) {
        writeFileSync(historyBarrier + '.entered', 'entered');
        const deadline = Date.now() + 8000;
        while (
          !existsSync(historyBarrier + '.released') &&
          !options.signal?.aborted &&
          Date.now() < deadline
        )
          await wait(10);
      }
      const sessionId = options.sessionId;
      const claim = claimed.get(sessionId);
      const requested =
        claim && options.messages.find((message) => message.id === claim.id);
      const current = requested && {
        sessionId,
        inserted: inserted.get(sessionId),
        claimed: claim,
        requested: identity(requested),
      };
      const stream = scope.run(current, () => next()[Symbol.asyncIterator]());
      try {
        for (;;) {
          const item = await scope.run(current, () => stream.next());
          if (item.done) return;
          yield item.value;
        }
      } finally {
        await scope.run(current, () => stream.return?.());
      }
    },
    { global: true },
  );

  wrap(
    'readImageRequest',
    (original) =>
      async function (ref, target, signal) {
        if (readAttemptsPath)
          appendFileSync(
            readAttemptsPath,
            JSON.stringify(ref.attachmentId) + '\n',
          );
        const current = scope.getStore();
        const variant = await original.call(this, ref, target, signal);
        if (current) {
          const stored = await attachments.readImage(ref, signal);
          appendFileSync(
            evidencePath,
            JSON.stringify({
              ...current,
              attachmentId: ref.attachmentId,
              original: {
                width: ref.width,
                height: ref.height,
                sha256: sha(stored.data),
              },
              variant: {
                id: variant.variantId,
                width: variant.width,
                height: variant.height,
                image: {
                  bytes: variant.data.byteLength,
                  mediaType: variant.mediaType,
                  sha256: sha(variant.data),
                },
              },
            }) + '\n',
            { mode: 0o600 },
          );
        }
        return variant;
      },
  );
}
