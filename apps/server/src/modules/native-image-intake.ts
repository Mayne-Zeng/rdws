import { randomUUID } from 'node:crypto';
import {
  LEASE_MS,
  imagePromptHash,
  imageStageHash,
  isRecord,
  nativeImageType,
  matchesNativeImageType,
  type NativeImageType,
} from '@rdws/dsh/access';
import { sessionRpc } from '@rdws/dsh/sessions';
import type { NativeWebHost } from '@rdws/dsh/web';
import type { Actor } from './business.ts';
import type { ContextRuns } from './runtime-context.ts';

type Scope = Actor & {
  requirementId: string;
  sessionId: string;
  workspaceId: string;
  cwd: string;
};

const unavailable = () => new Error('Native image intake unavailable');

export function prepareNativeImagePrompt(
  native: NativeWebHost,
  runs: ContextRuns,
  scope: Scope,
  input: { text: string; mediaType: NativeImageType; bytes: Uint8Array },
) {
  return prepareImage(native, runs, scope, input, randomUUID());
}

function prepareImage(
  native: NativeWebHost,
  runs: ContextRuns,
  scope: Scope,
  input: { text: string; mediaType: NativeImageType; bytes: Uint8Array },
  key: string,
  expected?: string,
) {
  if (
    !native.imageIntake ||
    native.contextGeneration !== runs.generation ||
    typeof input.text !== 'string' ||
    !input.text.trim() ||
    input.text.length > 8000 ||
    input.text.trimStart().startsWith('/') ||
    !nativeImageType(input.mediaType) ||
    !input.bytes.byteLength
  )
    throw unavailable();

  const binding = { ...scope, requestId: key };
  const { sessionId, requirementId, requestId, ...actor } = binding;
  const delegation = {
    ...actor,
    requirementId,
    requestId,
    ownSessionIds: [sessionId],
    readSessionIds: [sessionId],
  };
  const { text, mediaType } = input;
  const preparedUntil = Date.now() + LEASE_MS;
  let preparedBytes: Uint8Array<ArrayBuffer> | undefined = Uint8Array.from(
    input.bytes,
  );
  let submission: ReturnType<typeof dispatch> | undefined;

  async function authorize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    native.signal.throwIfAborted();
    const validBefore = await runs.authorizeImageIntake(
      binding,
      native.projectId,
      requirementId,
      sessionId,
    );
    signal?.throwIfAborted();
    native.signal.throwIfAborted();
    return Math.min(preparedUntil, validBefore);
  }

  async function dispatch(signal?: AbortSignal) {
    const bytes = preparedBytes;
    preparedBytes = undefined;
    if (!bytes) throw unavailable();
    await native.start();
    const staging = native.ticket(
      {
        ...delegation,
        purpose: 'service',
        operation: 'image.stage',
        ...(expected && { previousImage: true as const }),
        bodyHash: imageStageHash(mediaType, bytes),
      },
      await authorize(signal),
    );
    const stage = await native.fetch('/_rdws/image.stage', staging, {
      method: 'POST',
      headers: { 'content-type': mediaType },
      body: bytes,
      signal,
    });
    if (!stage.ok) {
      await stage.body?.cancel();
      throw unavailable();
    }
    const receipt: unknown = await stage.json();
    if (
      !isRecord(receipt) ||
      typeof receipt.receiptId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        receipt.receiptId,
      ) ||
      typeof receipt.attachmentId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.attachmentId) ||
      (expected &&
        (receipt.attachmentId !== expected ||
          receipt.mediaType !== mediaType ||
          receipt.bytes !== bytes.byteLength))
    )
      throw unavailable();

    const request = {
      sessionId,
      requestId,
      mode: 'queue',
      content: [
        { type: 'text', text },
        { type: 'file', receiptId: receipt.receiptId },
      ],
    };
    const prompt = native.ticket(
      {
        ...delegation,
        purpose: 'image-prompt',
        ...(expected && { previousImage: true as const }),
        bodyHash: imagePromptHash(request),
      },
      await authorize(signal),
    );
    const peerNonce = native.claims(prompt)?.nonce;
    if (!peerNonce) throw unavailable();
    const run = runs.admit(
      binding,
      requirementId,
      sessionId,
      requestId,
      peerNonce,
    );
    try {
      const opened = await native.control('run', {
        ...run,
        authSessionId: binding.authSessionId,
      });
      if (opened.authorized !== true) throw unavailable();
      await authorize(signal);
      const result = await sessionRpc(
        native,
        prompt,
        'session/prompt',
        request,
        signal,
      );
      if (!isRecord(result) || result.accepted !== true) throw unavailable();
      const observed = await native.control('image.status', {
        ...binding,
        peerNonce,
      });
      if (observed.accepted !== true) throw unavailable();
      runs.submitted(run.runId);
      return { requestId, attachmentId: receipt.attachmentId };
    } catch (error) {
      runs.discard(run.runId);
      await native.control('run.cancel', { runId: run.runId }).catch(() => {});
      throw error;
    }
  }

  return {
    requestId,
    async submit(signal?: AbortSignal) {
      await authorize(signal);
      submission ??= dispatch(signal);
      const result = await submission;
      await authorize(signal);
      return result;
    },
  };
}

export async function selectPreviousNativeImage(
  native: NativeWebHost,
  runs: ContextRuns,
  selected: Scope,
) {
  const scoped = { ...selected };
  let until = Date.now() + LEASE_MS;
  let target:
    | Awaited<ReturnType<ContextRuns['authorizePreviousImage']>>['target']
    | undefined;
  function identity(actor: Scope) {
    if (
      actor.userId !== scoped.userId ||
      actor.authSessionId !== scoped.authSessionId ||
      actor.requirementId !== scoped.requirementId ||
      actor.sessionId !== scoped.sessionId ||
      actor.workspaceId !== scoped.workspaceId ||
      actor.cwd !== scoped.cwd ||
      !native.imageIntake ||
      native.contextGeneration !== runs.generation ||
      native.signal.aborted ||
      Date.now() >= until
    )
      throw unavailable();
  }
  async function authorize(actor: Scope) {
    identity(actor);
    const policy = await runs.authorizePreviousImage(
      actor,
      native.projectId,
      actor.requirementId,
      actor.sessionId,
    );
    identity(actor);
    if (target && JSON.stringify(target) !== JSON.stringify(policy.target))
      throw unavailable();
    target ??= policy.target;
    const deadline = Math.min(until, policy.validBefore);
    if (deadline <= Date.now()) throw unavailable();
    return deadline;
  }
  const deadline = await authorize(scoped);
  until = deadline;
  const result = await native.control('image.history.select', {
    scope: scoped,
    target,
    deadline,
  });
  const requestId =
    typeof result.requestId === 'string' ? result.requestId : '';
  if (
    typeof requestId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)
  )
    throw unavailable();
  await authorize(scoped);
  let removed = false;
  let submitted:
    Promise<{ requestId: string; attachmentId: string }> | undefined;
  let frozenText: string | undefined;
  async function control(op: string, actor: Scope) {
    const limit = await authorize(actor);
    const reply = await native.control('image.history.' + op, {
      scope: scoped,
      target,
      requestId,
      deadline: limit,
    });
    await authorize(actor);
    return reply;
  }
  async function send(actor: Scope, text: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const original = await control('take', actor);
    signal?.throwIfAborted();
    if (
      typeof original.data !== 'string' ||
      original.data.length > 4 * Math.ceil((1024 * 1024) / 3) ||
      !nativeImageType(original.mediaType) ||
      typeof original.attachmentId !== 'string'
    )
      throw unavailable();
    const bytes = Buffer.from(original.data, 'base64');
    if (
      !bytes.length ||
      bytes.byteLength !== original.bytes ||
      bytes.toString('base64') !== original.data ||
      !matchesNativeImageType(original.mediaType, bytes)
    )
      throw unavailable();
    return prepareImage(
      native,
      runs,
      scoped,
      { text, mediaType: original.mediaType, bytes },
      requestId,
      original.attachmentId,
    ).submit(signal);
  }
  return {
    requestId,
    async preview(actor: Scope) {
      identity(actor);
      if (removed || submitted) throw unavailable();
      const r = await control('preview', actor);
      if (
        removed ||
        submitted ||
        typeof r.data !== 'string' ||
        r.data.length > 4 * Math.ceil(65536 / 3) ||
        !nativeImageType(r.mediaType) ||
        typeof r.width !== 'number' ||
        typeof r.height !== 'number' ||
        !Number.isSafeInteger(r.width) ||
        !Number.isSafeInteger(r.height) ||
        r.width < 1 ||
        r.height < 1 ||
        r.width > 128 ||
        r.height > 128
      )
        throw unavailable();
      const bytes = Buffer.from(r.data, 'base64');
      if (
        !bytes.length ||
        bytes.byteLength > 65536 ||
        bytes.toString('base64') !== r.data ||
        !matchesNativeImageType(r.mediaType, bytes)
      )
        throw unavailable();
      return {
        bytes,
        mediaType: r.mediaType,
        width: r.width,
        height: r.height,
      };
    },
    async remove(actor: Scope) {
      identity(actor);
      if (submitted) throw unavailable();
      removed = true;
      await control('remove', actor);
    },
    async submit(actor: Scope, text: string, signal?: AbortSignal) {
      identity(actor);
      if (
        removed ||
        !text.trim() ||
        text.trimStart().startsWith('/') ||
        text.length > 8000 ||
        (submitted && text !== frozenText)
      )
        throw unavailable();
      if (!submitted) {
        frozenText = text;
        submitted = send({ ...actor }, text, signal);
        void submitted.catch(() => {});
      }
      await authorize(actor);
      const sent = await submitted;
      await authorize(actor);
      return sent;
    },
  };
}
