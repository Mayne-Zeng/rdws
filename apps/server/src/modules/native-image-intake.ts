import { randomUUID } from 'node:crypto';
import {
  LEASE_MS,
  imagePromptHash,
  imageStageHash,
  isRecord,
  nativeImageType,
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

  const binding = { ...scope, requestId: randomUUID() };
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
      !/^sha256:[a-f0-9]{64}$/.test(receipt.attachmentId)
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
