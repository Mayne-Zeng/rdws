import { imageStageHash, nativeImageType } from '../../bridge/access.ts';

const stagePath = '/_rdws/image.stage';
const maxSlots = 64;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = () => new Error('Native image intake unavailable');

export function intakeImageMatches(message, image) {
  if (!image) return false;
  const attachments = message.content.filter((block) => block.type === 'image');
  if (attachments.length !== 1) return false;
  const ref = attachments[0].attachment;
  return (
    ref?.attachmentId === image.attachmentId &&
    ref.mediaType === image.mediaType &&
    ref.bytes === image.bytes
  );
}

export function installImageIntake(
  ctx,
  {
    authenticate,
    register,
    inspectSession,
    assertActivation,
    ensurePreset,
    bindIntake,
  },
) {
  const slots = new Map();
  const key = (sessionId, requestId) => JSON.stringify([sessionId, requestId]);
  const scope = (cap, sessionId) => ({
    sessionId,
    requestId: cap.requestId,
    requirementId: cap.requirementId,
    userId: cap.userId,
    authSessionId: cap.authSessionId,
    workspaceId: cap.workspaceId,
    cwd: cap.cwd,
  });
  const sameScope = (expected, actual) =>
    Object.entries(expected).every(([key, value]) => actual[key] === value);

  register({
    kind: 'exact',
    path: stagePath,
    async handler(request, response) {
      const answer = (status, data) => {
        if (response.destroyed) return;
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(data === undefined ? undefined : JSON.stringify(data));
      };
      const { host, origin } = request.headers;
      const mediaType = request.headers['content-type'];
      if (
        request.url !== stagePath ||
        request.method !== 'POST' ||
        typeof host !== 'string' ||
        !/^127\.0\.0\.1:\d+$/.test(host) ||
        origin !== 'http://' + host ||
        request.headers['content-encoding'] !== undefined ||
        !nativeImageType(mediaType)
      )
        return answer(403);

      const record = authenticate(request);
      const cap = record?.cap;
      const sessionId = cap?.ownSessionIds?.[0];
      if (
        cap?.purpose !== 'service' ||
        cap.operation !== 'image.stage' ||
        cap.ownSessionIds?.length !== 1 ||
        cap.readSessionIds?.length !== 1 ||
        cap.readSessionIds[0] !== sessionId ||
        typeof cap.requestId !== 'string' ||
        !uuid.test(cap.requestId) ||
        typeof cap.bodyHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(cap.bodyHash)
      )
        return answer(403);
      const binding = scope(cap, sessionId);
      if (
        Object.values(binding).some(
          (value) => typeof value !== 'string' || !value,
        )
      )
        return answer(403);

      const now = Date.now();
      for (const [id, slot] of slots)
        if (slot.retired && slot.expiresAt <= now) slots.delete(id);
      const id = key(sessionId, cap.requestId);
      if (slots.has(id) || slots.size >= maxSlots) return answer(409);
      const slot = { binding, expiresAt: cap.expiresAt };
      slots.set(id, slot);

      const controller = new AbortController();
      let reading = true;
      let storing = false;
      const abort = () => {
        controller.abort();
        if (reading) request.destroy();
      };
      request.once('aborted', abort);
      response.once('close', abort);
      record.peer.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, cap.expiresAt - now));
      try {
        assertActivation(record, controller.signal);
        const workspace = await inspectSession(
          {
            requirementId: cap.requirementId,
            sessionId,
          },
          true,
        );
        if (
          workspace.workspaceId !== cap.workspaceId ||
          workspace.cwd !== cap.cwd
        )
          throw unavailable();
        assertActivation(record, controller.signal);
        await ensurePreset(workspace.agentPreset, cap.requirementId);
        assertActivation(record, controller.signal);
        const limits = ctx.get('attachments')?.imageLimits;
        const upload = ctx.get('fileUploads');
        if (!limits || !upload || !limits.mediaTypes.includes(mediaType))
          throw unavailable();
        const limit = Math.min(
          limits.maxImageBytes,
          limits.maxMessageImageBytes,
        );
        if (!Number.isSafeInteger(limit) || limit < 1) throw unavailable();
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          assertActivation(record, controller.signal);
          length += chunk.length;
          if (length > limit) throw unavailable();
          chunks.push(chunk);
        }
        reading = false;
        if (
          !length ||
          imageStageHash(mediaType, Buffer.concat(chunks, length)) !==
            cap.bodyHash
        )
          throw unavailable();
        assertActivation(record, controller.signal);
        storing = true;
        const { receiptId, image } = await upload.uploadImageStream({
          sessionId,
          mediaType,
          data: chunks,
          signal: controller.signal,
        });
        assertActivation(record, controller.signal);
        if (
          typeof receiptId !== 'string' ||
          !uuid.test(receiptId) ||
          !image ||
          typeof image.attachmentId !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(image.attachmentId) ||
          !nativeImageType(image.mediaType) ||
          !Number.isSafeInteger(image.bytes) ||
          image.bytes < 1
        )
          throw unavailable();
        slot.receiptId = receiptId;
        slot.image = {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
        };
        answer(200, { receiptId, attachmentId: image.attachmentId });
      } catch {
        if (!storing) slot.retired = true;
        answer(503);
      } finally {
        clearTimeout(timer);
        request.off('aborted', abort);
        response.off('close', abort);
        record.peer.signal.removeEventListener('abort', abort);
      }
    },
  });

  ctx.on(
    'session/event',
    (session, event) => {
      const observe = (message, retire) => {
        const source = message.source;
        if (source?.kind !== 'user' || source.principal?.kind !== 'rdws')
          return;
        const slot = slots.get(key(String(session.id), source.rpcId));
        if (
          !slot?.promptNonce ||
          source.principal.nonce !== slot.promptNonce ||
          source.principal.userId !== slot.binding.userId ||
          !intakeImageMatches(message, slot.image)
        )
          return;
        if (retire) {
          if (slot.admitted) slot.retired = true;
        } else slot.admitted = true;
      };
      if (event.type === 'agent/inbox/spliced')
        for (const message of event.data.inserted) observe(message, false);
      if (event.type === 'user/message') observe(event.data, true);
    },
    { global: true },
  );

  return {
    consume(record, request, signal) {
      assertActivation(record, signal);
      const { cap } = record;
      const slot = slots.get(key(request.sessionId, request.requestId));
      const receipt = request.content.find(({ type }) => type === 'file');
      if (
        !slot?.receiptId ||
        slot.expiresAt <= Date.now() ||
        slot.promptNonce ||
        slot.retired ||
        !sameScope(slot.binding, scope(cap, request.sessionId)) ||
        receipt?.receiptId !== slot.receiptId
      )
        throw unavailable();
      bindIntake(cap, request.sessionId, slot.image);
      slot.promptNonce = cap.nonce;
    },
    accepted(input) {
      const slot = slots.get(key(input.sessionId, input.requestId));
      return {
        accepted: Boolean(
          slot?.admitted &&
          slot.expiresAt > Date.now() &&
          slot.promptNonce === input.peerNonce &&
          sameScope(slot.binding, input),
        ),
      };
    },
  };
}
