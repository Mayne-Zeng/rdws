import {
  requireImageScope,
  readImageForCall,
  withHistoryText,
} from './history-text.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
  const {
    isAgentLoopRequest,
    requestImageHandleText,
    resolveImageAttachmentAccess,
  } = fromAgentLoop('@deepseek-ai/dsh-llm');
  if (typeof isAgentLoopRequest !== 'function')
    throw new Error('Native model identity unavailable');
  const routes = snapshotModelRoutes(configuredRoutes);
  const targets = new Map([...routes].map(([id, url]) => [url, id]));
  const channel = openModelCarrier(
    new Socket({ fd: 4, readable: true, writable: true }),
    generation,
  );
  const calls = new AsyncLocalStorage();
  const credentialKey = randomBytes(32);
  const attachmentRoutes =
    contextBinding.attachmentCallFor && new Set(['files', 'messages']);
  if (attachmentRoutes) {
    if (
      typeof requestImageHandleText !== 'function' ||
      typeof resolveImageAttachmentAccess !== 'function'
    )
      throw unavailable();
    const attachments = ctx.attachments;
    const descriptor = Object.getOwnPropertyDescriptor(
      attachments,
      'readImageRequest',
    );
    const read = attachments.readImageRequest;
    if (typeof read !== 'function') throw unavailable();
    const observe = async function (ref, ...args) {
      const scope = calls.getStore();
      const attachment = scope?.attachment;
      if (
        attachment &&
        (!attachment.active ||
          !attachment.origin.isCurrent() ||
          !attachment.origin.expected.some(
            (source) => source.attachmentId === ref.attachmentId,
          ))
      )
        throw unavailable();
      const result = await readImageForCall(read, this, ref, args);
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
          result.data.byteLength !== result.bytes ||
          !Number.isSafeInteger(result.width) ||
          result.width < 1 ||
          !Number.isSafeInteger(result.height) ||
          result.height < 1
        )
          throw unavailable();
        const variant = {
          sha256: createHash('sha256').update(result.data).digest('hex'),
          bytes: result.bytes,
          mediaType: result.mediaType,
          width: result.width,
          height: result.height,
          target: {
            width: args[0]?.width,
            height: args[0]?.height,
            maxBytes: args[0]?.maxBytes,
          },
        };
        const committed = scope.projection?.expectedAsset?.variant;
        if (committed && JSON.stringify(committed) !== JSON.stringify(variant))
          throw unavailable();
        const previous = attachment.variants.get(id);
        if (
          previous &&
          (previous.sha256 !== variant.sha256 ||
            previous.bytes !== variant.bytes ||
            previous.mediaType !== variant.mediaType ||
            previous.width !== variant.width ||
            previous.height !== variant.height)
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
    if (
      (calls.getStore()?.projection && !calls.getStore().projection.used) ||
      !attachment?.active ||
      !attachment.origin.isCurrent()
    )
      throw unavailable();
    request = new Request(request, {
      signal: AbortSignal.any([
        request.signal,
        attachment.origin.signal,
        attachment.stop.signal,
      ]),
    });
    if (!attachment.ready) {
      const images = attachment.origin.expected.map(
        ({ reference, ...source }) => {
          const variant = attachment.variants.get(source.attachmentId);
          if (!variant) throw unavailable();
          const access = resolveImageAttachmentAccess(
            ctx.attachments,
            (path) => ctx.get('fs')?.processPathFromHostPath(path),
            reference,
          );
          const handle = requestImageHandleText(reference, variant, access);
          return {
            ...source,
            bytes: variant.bytes,
            sha256: variant.sha256,
            mediaType: variant.mediaType,
            handleSha256: createHash('sha256')
              .update(JSON.stringify(handle))
              .digest('hex'),
          };
        },
      );
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
    const recipient = {
      provider: call.provider,
      model: call.model,
      routes: { files: routes.get('files'), messages: routes.get('messages') },
      credentialGeneration: ack.credentialGeneration,
      credential: createHmac('sha256', credentialKey)
        .update(
          JSON.stringify([
            request.headers.get('authorization'),
            request.headers.get('x-api-key'),
          ]),
        )
        .digest('hex'),
    };
    const expectedRecipient =
      calls.getStore()?.projection?.expectedAsset?.recipient;
    if (
      expectedRecipient &&
      JSON.stringify(expectedRecipient) !== JSON.stringify(recipient)
    )
      throw unavailable();
    const response = await channel.fetch(
      route,
      { ...call, attachmentGrant: ack.grant },
      request,
      () => attachment.active && attachment.origin.isCurrent(),
    );
    if (route === 'messages' && response.ok)
      attachment.origin.delivered?.(attachment.variants, recipient);
    return response;
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
      if (agentRequest && contextBinding.confirmModelFirstWrite)
        await contextBinding.confirmModelFirstWrite(options, call);
      const projection =
        agentRequest && contextBinding.historyTextFor?.(options, call);
      const origin =
        agentRequest &&
        contextBinding.attachmentCallFor?.(
          projection ? projection.projected : options,
          call,
        );
      if (
        contextBinding.historyTextFor &&
        agentRequest &&
        (!call.bindingId || !origin)
      )
        throw unavailable();
      requireImageScope(
        !!contextBinding.historyTextFor,
        options,
        agentRequest,
        call,
        origin,
      );
      if (
        projection?.expectedAsset &&
        (origin?.expected.length !== 1 ||
          origin.expected[0].reference !== projection.retainedRef)
      )
        throw unavailable();
      const attachment = origin && {
        origin,
        variants: new Map(),
        active: true,
        stop: new AbortController(),
      };
      const scope = { call, attachment, projection };
      const inScope = (fn) =>
        calls.run(scope, () => withHistoryText(projection, fn));
      let stream;
      try {
        stream = inScope(() => next()[Symbol.asyncIterator]());
        for (;;) {
          const item = await inScope(() => stream.next());
          if (item.done) return;
          yield item.value;
        }
      } finally {
        if (projection) projection.active = false;
        if (attachment) {
          attachment.active = false;
          attachment.stop.abort();
        }
        try {
          await inScope(() => stream?.return?.());
        } finally {
          if (attachment?.ready) await attachment.origin.close();
        }
      }
    },
    { global: true },
  );
}
