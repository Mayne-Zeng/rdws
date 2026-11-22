import { randomUUID, createHash } from 'node:crypto';
import {
  bodyHash,
  LEASE_MS,
  nativeImageType,
  matchesNativeImageType,
} from '../../bridge/access.ts';

const unavailable = () => new Error('Native previous image unavailable');
const maxOriginal = 1024 * 1024;
const maxPreview = 64 * 1024;
const scopeKey = (s) =>
  JSON.stringify([
    s.userId,
    s.authSessionId,
    s.requirementId,
    s.sessionId,
    s.workspaceId,
    s.cwd,
  ]);

export function localImagePosition(session, message, identity) {
  const events = session.snapshotEvents();
  if (events.length > 8192) return;
  const same = (m) =>
    m?.id === message.id &&
    identity(m) === identity(message) &&
    bodyHash(m.content) === bodyHash(message.content);
  const messages = events.filter(
    (e) => e.type === 'user/message' && e.data.id === message.id,
  );
  const inserts = events.flatMap((e) =>
    e.type === 'agent/inbox/spliced' && Array.isArray(e.data.inserted)
      ? e.data.inserted.flatMap((m) =>
          m.id === message.id ? [{ message: m, seq: e.seq }] : [],
        )
      : [],
  );
  if (
    messages.length !== 1 ||
    inserts.length !== 1 ||
    messages[0].surfaceOp !== 'append' ||
    !same(messages[0].data) ||
    !same(inserts[0].message) ||
    inserts[0].seq >= messages[0].seq
  )
    return;
  return {
    userSeq: messages[0].seq,
    inboxSeq: inserts[0].seq,
    identity: identity(message),
  };
}

export function sameImagePosition(first, second) {
  return (
    !!first &&
    !!second &&
    first.userSeq === second.userSeq &&
    first.inboxSeq === second.inboxSeq &&
    first.identity === second.identity
  );
}

export function installHistoryChoices(
  ctx,
  route,
  images,
  sessionWorkspace,
  identity,
) {
  const slots = new Map();
  let expiry;
  function prune() {
    for (const [key, slot] of slots)
      if (slot.deadline <= Date.now()) slots.delete(key);
  }
  function schedule() {
    clearTimeout(expiry);
    if (slots.size)
      expiry = setTimeout(
        () => {
          prune();
          schedule();
        },
        Math.max(
          1,
          Math.min(...[...slots.values()].map((s) => s.deadline)) - Date.now(),
        ),
      ).unref();
  }
  function sameTarget(target, recipient) {
    return (
      target &&
      recipient &&
      target.provider === recipient.provider &&
      target.model === recipient.model &&
      target.credentialGeneration === recipient.credentialGeneration &&
      target.routes?.files === recipient.routes?.files &&
      target.routes?.messages === recipient.routes?.messages
    );
  }
  function live(input) {
    const { scope, deadline } = input;
    if (
      !scope ||
      [
        'userId',
        'authSessionId',
        'requirementId',
        'sessionId',
        'workspaceId',
        'cwd',
      ].some((key) => typeof scope[key] !== 'string' || !scope[key]) ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now() ||
      deadline > Date.now() + LEASE_MS
    )
      throw unavailable();
    const session = ctx.get('sessions')?.get(scope.sessionId);
    if (!session || session.header.isSeeded || session.header.cwd !== scope.cwd)
      throw unavailable();
    const workspace = sessionWorkspace(scope);
    if (workspace.id !== scope.workspaceId || workspace.path !== scope.cwd)
      throw unavailable();
    return session;
  }
  function resolveSource(session, scope, chosenId) {
    const observed = session.snapshotEvents();
    if (observed.length > 8192) throw unavailable();
    let candidate;
    let candidateSeq;
    if (!chosenId) {
      for (const event of observed.toReversed()) {
        const rows =
          event.type === 'agent/inbox/spliced'
            ? event.data.inserted
            : event.type === 'user/message'
              ? [event.data]
              : [];
        candidate = rows?.findLast(
          (row) =>
            Array.isArray(row?.content) &&
            row.content.some((part) => part.type === 'image'),
        );
        if (candidate) {
          candidateSeq = event.seq;
          break;
        }
      }
    }
    const id = chosenId ?? candidate?.id;
    const entry = images.get(session)?.get(id);
    const matches = session.deriveMessages().filter((m) => m.id === id);
    const message = matches.length === 1 ? matches[0] : undefined;
    if (
      !entry?.completed ||
      !entry.asset ||
      !message ||
      !entry.asset.position ||
      identity(message) !== entry.asset.position.identity ||
      (candidate &&
        (identity(candidate) !== entry.asset.position.identity ||
          ![
            entry.asset.position.userSeq,
            entry.asset.position.inboxSeq,
          ].includes(candidateSeq))) ||
      entry.userId !== scope.userId ||
      entry.requirementId !== scope.requirementId ||
      entry.contentDigest !== bodyHash(message.content)
    )
      throw unavailable();
    if (
      !sameImagePosition(
        entry.asset.position,
        localImagePosition(session, message, identity),
      )
    )
      throw unavailable();
    const block = message.content[entry.asset.index];
    if (
      block?.type !== 'image' ||
      block.offloaded ||
      block.attachment?.attachmentId !== entry.asset.id ||
      entry.asset.bytes > maxOriginal
    )
      throw unavailable();
    return { id, entry, ref: block.attachment };
  }
  route('image.history.select', async (input) => {
    prune();
    const session = live(input);
    if (slots.size >= 64) throw unavailable();
    const { id, entry } = resolveSource(session, input.scope);
    if (!sameTarget(input.target, entry.asset.recipient)) throw unavailable();
    const requestId = randomUUID();
    slots.set(requestId, {
      session,
      id,
      entry,
      scope: scopeKey(input.scope),
      login: input.scope.authSessionId,
      deadline: input.deadline,
      consumed: false,
    });
    schedule();
    return { requestId };
  });
  function check(input) {
    prune();
    const session = live(input);
    const slot = slots.get(input.requestId);
    if (
      !slot ||
      slot.session !== session ||
      slot.scope !== scopeKey(input.scope) ||
      slot.deadline <= Date.now()
    )
      throw unavailable();
    const source = resolveSource(session, input.scope, slot.id);
    if (
      source.entry !== slot.entry ||
      !sameTarget(input.target, source.entry.asset.recipient)
    )
      throw unavailable();
    return { slot, ...source };
  }
  route('image.history.preview', async (input) => {
    const { slot, ref } = check(input);
    if (slot.consumed || slot.previewing) throw unavailable();
    slot.previewing = true;
    try {
      const media = await ctx
        .get('attachments')
        .readImageRequest(
          ref,
          { width: 128, height: 128, maxBytes: maxPreview },
          AbortSignal.timeout(3000),
        );
      check(input);
      if (
        slot.consumed ||
        media.attachment?.attachmentId !== ref.attachmentId ||
        !nativeImageType(media.mediaType) ||
        !Number.isSafeInteger(media.width) ||
        !Number.isSafeInteger(media.height) ||
        media.width < 1 ||
        media.height < 1 ||
        media.width > 128 ||
        media.height > 128 ||
        !(media.data instanceof Uint8Array) ||
        !matchesNativeImageType(media.mediaType, media.data) ||
        media.bytes !== media.data.byteLength ||
        media.bytes < 1 ||
        media.bytes > maxPreview
      )
        throw unavailable();
      return {
        mediaType: media.mediaType,
        width: media.width,
        height: media.height,
        data: Buffer.from(media.data).toString('base64'),
      };
    } finally {
      slot.previewing = false;
    }
  });
  route('image.history.remove', (input) => {
    const { slot } = check(input);
    if (slot.consumed) throw unavailable();
    slots.delete(input.requestId);
    return { removed: true };
  });
  route('image.history.take', async (input) => {
    const { slot, ref } = check(input);
    if (slot.consumed) throw unavailable();
    slot.consumed = true;
    const original = await ctx
      .get('attachments')
      .readImage(ref, AbortSignal.timeout(3000));
    check(input);
    if (
      !nativeImageType(ref.mediaType) ||
      original.ref.attachmentId !== ref.attachmentId ||
      original.ref.mediaType !== ref.mediaType ||
      original.ref.bytes !== ref.bytes ||
      !(original.data instanceof Uint8Array) ||
      original.data.byteLength !== ref.bytes ||
      ref.bytes > maxOriginal ||
      'sha256:' + createHash('sha256').update(original.data).digest('hex') !==
        ref.attachmentId
    )
      throw unavailable();
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      data: Buffer.from(original.data).toString('base64'),
    };
  });
  ctx.effect(() => () => {
    clearTimeout(expiry);
    slots.clear();
  });
  function staged(cap, sessionId, image) {
    prune();
    const slot = slots.get(cap.requestId);
    if (!slot && !cap.previousImage) return;
    if (!slot || cap.previousImage !== true) throw unavailable();
    const scope = {
      userId: cap.userId,
      authSessionId: cap.authSessionId,
      requirementId: cap.requirementId,
      sessionId,
      workspaceId: cap.workspaceId,
      cwd: cap.cwd,
    };
    if (
      !slot.consumed ||
      slot.claimed ||
      slot.scope !== scopeKey(scope) ||
      (image &&
        (slot.entry.asset.id !== image.attachmentId ||
          slot.entry.asset.bytes !== image.bytes ||
          slot.entry.asset.mediaType !== image.mediaType))
    )
      throw unavailable();
    const session = live({
      scope,
      deadline: Math.min(slot.deadline, cap.expiresAt),
    });
    if (
      session !== slot.session ||
      resolveSource(session, scope, slot.id).entry !== slot.entry
    )
      throw unavailable();
    return slot;
  }
  return {
    validateStage: staged,
    claim(cap, sessionId, image) {
      const slot = staged(cap, sessionId, image);
      if (!slot) return;
      slot.claimed = true;
      return { ...slot.entry, deadline: slot.deadline };
    },
    revoke(authSessionId, requirementId) {
      for (const [key, slot] of slots)
        if (
          slot.login === authSessionId &&
          (!requirementId || slot.entry.requirementId === requirementId)
        )
          slots.delete(key);
    },
  };
}
