import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { titleCall } from './title-binding.mjs';
import {
  openModelCarrier,
  snapshotModelRoutes,
} from '../../bridge/model-carrier.ts';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error('Native attachment evidence unavailable');

export function installModelCarrier(
  ctx,
  generation,
  configuredRoutes,
  contextBinding,
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
  const attachmentRoutes =
    contextBinding.attachmentCallFor && new Set(['files', 'messages']);
  if (attachmentRoutes) {
    const attachments = ctx.attachments;
    const descriptor = Object.getOwnPropertyDescriptor(
      attachments,
      'readImageRequest',
    );
    const read = attachments.readImageRequest;
    if (typeof read !== 'function') throw unavailable();
    const observe = async function (ref, ...args) {
      const attachment = calls.getStore()?.attachment;
      const result = await read.call(this, ref, ...args);
      if (attachment) {
        const id = ref.attachmentId;
        if (
          !attachment.active ||
          !attachment.origin.isCurrent() ||
          !attachment.origin.expected.some(
            (source) => source.attachmentId === id,
          ) ||
          result.attachment?.attachmentId !== id ||
          !(result.data instanceof Uint8Array) ||
          result.data.byteLength !== result.bytes
        )
          throw unavailable();
        const variant = {
          sha256: createHash('sha256').update(result.data).digest('hex'),
          bytes: result.bytes,
          mediaType: result.mediaType,
        };
        const previous = attachment.variants.get(id);
        if (
          previous &&
          (previous.sha256 !== variant.sha256 ||
            previous.bytes !== variant.bytes ||
            previous.mediaType !== variant.mediaType)
        )
          throw unavailable();
        attachment.variants.set(id, variant);
      }
      return result;
    };
    Object.defineProperty(attachments, 'readImageRequest', {
      value: observe,
      writable: true,
      configurable: true,
    });
    ctx.effect(() => () => {
      if (attachments.readImageRequest !== observe) return;
      if (descriptor)
        Object.defineProperty(attachments, 'readImageRequest', descriptor);
      else delete attachments.readImageRequest;
    });
  }
  const original = globalThis.fetch;
  const fetchModel = async (input, init) => {
    const scope = calls.getStore();
    if (!scope) return original(input, init);
    const { call, attachment } = scope;
    let request;
    try {
      request = new Request(input, { ...init, duplex: 'half' });
    } catch {
      throw new Error('Native model route unavailable');
    }
    const route = targets.get(request.url);
    if (!route || request.method !== 'POST')
      throw new Error('Native model route unavailable');
    if (!attachmentRoutes?.has(route))
      return channel.fetch(route, call, request);
    if (!attachment?.active || !attachment.origin.isCurrent())
      throw unavailable();
    request = new Request(request, {
      signal: AbortSignal.any([
        request.signal,
        attachment.origin.signal,
        attachment.stop.signal,
      ]),
    });
    if (!attachment.ready) {
      const images = attachment.origin.expected.map((source) => {
        const variant = attachment.variants.get(source.attachmentId);
        if (!variant) throw unavailable();
        return { ...source, ...variant };
      });
      attachment.ready = attachment.origin.prepare(images, request.signal);
    }
    const ack = await attachment.ready;
    if (
      !attachment.active ||
      !attachment.origin.isCurrent() ||
      request.signal.aborted ||
      ack?.bindingId !== call.bindingId ||
      ack?.callId !== call.id ||
      typeof ack?.grant !== 'string' ||
      !uuid.test(ack.grant)
    )
      throw unavailable();
    return channel.fetch(
      route,
      { ...call, attachmentGrant: ack.grant },
      request,
      () => attachment.active && attachment.origin.isCurrent(),
    );
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
      const agentRequest =
        options.purpose === undefined && isAgentLoopRequest(options);
      const call = {
        id: title?.id ?? randomUUID(),
        provider: options.provider,
        model: options.model,
        sessionId: options.sessionId,
        purpose: options.purpose,
        bindingId: agentRequest
          ? contextBinding.modelBindingFor(options)
          : title?.bindingId,
      };
      const origin =
        agentRequest && contextBinding.attachmentCallFor?.(options, call);
      const attachment = origin && {
        origin,
        variants: new Map(),
        active: true,
        stop: new AbortController(),
      };
      const scope = { call, attachment };
      let stream;
      try {
        stream = calls.run(scope, () => next()[Symbol.asyncIterator]());
        for (;;) {
          const item = await calls.run(scope, () => stream.next());
          if (item.done) return;
          yield item.value;
        }
      } finally {
        if (attachment) {
          attachment.active = false;
          attachment.stop.abort();
        }
        try {
          await calls.run(scope, () => stream?.return?.());
        } finally {
          if (attachment?.ready) await attachment.origin.close();
        }
      }
    },
    { global: true },
  );
}
