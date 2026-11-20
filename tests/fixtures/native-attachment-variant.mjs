import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export const name = 'test-native-attachment-variant';
export const inject = ['attachments', 'llm'];

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
  { accepted, late, evidencePath, repeatImages, file },
) {
  const attachments = ctx.attachments;
  const scope = new AsyncLocalStorage();
  const inserted = new Map();
  const claimed = new Map();
  let firstRef;
  const marked = (message, text) =>
    message.content.some((part) => part.type === 'text' && part.text === text);

  function wrap(method, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(attachments, method);
    const original = attachments[method];
    const observed = replacement(original);
    Object.defineProperty(attachments, method, {
      configurable: true,
      writable: true,
      value: observed,
    });
    ctx.effect(() => () => {
      if (attachments[method] !== observed) return;
      if (descriptor) Object.defineProperty(attachments, method, descriptor);
      else delete attachments[method];
    });
  }

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
          firstRef = admitted.find((part) => part.type === 'image')?.attachment;
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
