import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import {
  createLoopbackAttachmentHttpsRelay,
  type ModelCarrierRequest,
} from '@rdws/dsh/web';
import type { ContextRuns } from './runtime-context.ts';
import {
  projectDeepSeekMessages,
  readDeepSeekFilesEvidence,
  type readDeepSeekMessagesEvidence,
  type WorkingDirectoryEdit,
} from './model-attachment-evidence.ts';

type FilesEvidence = NonNullable<ReturnType<typeof readDeepSeekFilesEvidence>>;
type MessagesEvidence = NonNullable<
  ReturnType<typeof readDeepSeekMessagesEvidence>
>;
type Image = FilesEvidence['image'];
type Routes = Readonly<{ files: string; messages: string }>;

export type AttachmentManifest = Readonly<{
  projectId: string;
  requirementId: string;
  sessionId: string;
  bindingId: string;
  credentialGeneration: string;
  images: readonly Readonly<Image>[];
  imageHandleDigests: readonly string[];
  userContentSha256: string;
  workingDirectoryEdits: readonly WorkingDirectoryEdit[];
  projectedUserContentSha256: string;
}>;

type UploadScope = {
  bindingId: string;
  identity: string;
  credential: string;
  credentialGeneration: string;
  image: Image;
};
type Upload = UploadScope &
  (
    | { state: 'pending' }
    | { state: 'unknown'; ambiguousId?: string }
    | { state: 'confirmed'; fileId: string; expiresAt: number }
  );

const maxUploads = 128;
const bodyLimit = 1024 * 1024;
const responseLimit = 64 * 1024;
const attemptDeadlineMs = 10000;
const messagesVersion = '2023-06-01';
const filesBeta = 'files-api-2025-04-14';
const sse = 'text/event-stream';
const allowedIncomingHeaders = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'accept-encoding',
  'user-agent',
  'x-deepseek-harness-user-id',
  'x-deepseek-harness-session-id',
]);
const fileId = /^[a-zA-Z0-9_-]{1,256}$/;
const responseFields = [
  'id',
  'type',
  'size_bytes',
  'created_at',
  'filename',
  'mime_type',
];
const invalid = () => new Error('Attachment egress unavailable');

const sameImage = (a: Image, b: Image) =>
  a.bytes === b.bytes && a.sha256 === b.sha256 && a.mediaType === b.mediaType;
const imageKey = (image: Image) => [image.mediaType, image.bytes, image.sha256];
const identityKey = (scope: AttachmentManifest) =>
  JSON.stringify([scope.projectId, scope.requirementId, scope.sessionId]);
const manifestKey = (scope: AttachmentManifest) =>
  JSON.stringify([
    identityKey(scope),
    scope.bindingId,
    scope.credentialGeneration,
    scope.images.map(imageKey),
    scope.imageHandleDigests,
    scope.userContentSha256,
    scope.workingDirectoryEdits.map(({ index, start, end }) => [
      index,
      start,
      end,
    ]),
    scope.projectedUserContentSha256,
  ]);

async function readBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
) {
  if (!stream) throw invalid();
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) {
        complete = true;
        return Buffer.concat(chunks, bytes);
      }
      bytes += result.value.byteLength;
      if (bytes > limit) throw invalid();
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

async function readReceipt(
  response: Response,
  evidence: FilesEvidence,
  submittedAt: number,
  signal: AbortSignal,
  observeId: (id: string) => void,
) {
  if (
    (response.status !== 200 && response.status !== 201) ||
    response.headers.get('content-type') !== 'application/json'
  ) {
    await response.body?.cancel();
    throw invalid();
  }
  const bytes = await readBytes(response.body, responseLimit, signal);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  if (
    !isRecord(value) ||
    value.type !== 'file' ||
    typeof value.id !== 'string' ||
    !fileId.test(value.id) ||
    !bytes.equals(Buffer.from(JSON.stringify(value)))
  )
    throw invalid();
  const id = createHash('sha256').update(value.id).digest('hex');
  observeId(id);
  if (
    !onlyKeys(value, responseFields) ||
    value.size_bytes !== evidence.image.bytes ||
    value.mime_type !== evidence.image.mediaType ||
    typeof value.filename !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.filename) ||
    typeof value.created_at !== 'string'
  )
    throw invalid();
  const created = Date.parse(value.created_at);
  if (
    !Number.isFinite(created) ||
    new Date(created).toISOString() !== value.created_at ||
    created < submittedAt - 1000 ||
    created > Date.now()
  )
    throw invalid();
  return {
    fileId: id,
    expiresAt:
      Math.min(created, submittedAt) + evidence.expiresAfterSeconds * 1000,
    response: Response.json(value, { status: response.status }),
  };
}

export function createLoopbackAttachmentEgress(
  routes: Routes,
  ca: Buffer,
  runs: Pick<
    ContextRuns,
    'authorizeModelFileWireAttempt' | 'authorizeModelWireAttempt'
  >,
  manifestFor: (request: ModelCarrierRequest) => AttachmentManifest | undefined,
) {
  const files = createLoopbackAttachmentHttpsRelay(routes.files, ca, 'files');
  const messages = createLoopbackAttachmentHttpsRelay(
    routes.messages,
    ca,
    'messages',
  );
  if (routes.messages !== new URL('messages', routes.files).href)
    throw invalid();
  routes = Object.freeze({ ...routes });
  const credentialKey = randomBytes(32);
  const uploads = new Map<string, Upload>();

  function messageDeadline(
    evidence: MessagesEvidence,
    manifest: AttachmentManifest,
    identity: string,
    credential: string,
  ) {
    if (evidence.images.length !== manifest.images.length) return;
    const now = Date.now();
    let deadline = Infinity;
    for (const [index, image] of evidence.images.entries()) {
      const expected = manifest.images[index]!;
      if (image.kind === 'inline') {
        if (!sameImage(image.image, expected)) return;
        continue;
      }
      const receipt = [...uploads.values()].find(
        (upload) =>
          upload.state === 'confirmed' &&
          upload.identity === identity &&
          upload.credential === credential &&
          upload.credentialGeneration === manifest.credentialGeneration &&
          upload.fileId === image.fileIdSha256 &&
          upload.expiresAt > now &&
          sameImage(upload.image, expected),
      );
      if (receipt?.state !== 'confirmed') return;
      deadline = Math.min(deadline, receipt.expiresAt);
    }
    return deadline;
  }

  return async (request: ModelCarrierRequest): Promise<Response> => {
    const { routeId, signal, call } = request;
    if (
      (routeId !== 'files' && routeId !== 'messages') ||
      request.destination !== routes[routeId]
    )
      throw invalid();
    const incoming = request.headers;
    const bearer = incoming.get('authorization');
    const apiKey = incoming.get('x-api-key');
    const contentType = incoming.get('content-type');
    const beta = incoming.get('anthropic-beta');
    const encoding = incoming.get('accept-encoding');
    if (
      [...incoming.keys()].some((name) => !allowedIncomingHeaders.has(name)) ||
      (bearer === null) === (apiKey === null) ||
      (bearer !== null && !/^Bearer [\x21-\x2b\x2d-\x7e]+$/.test(bearer)) ||
      (apiKey !== null && !/^[\x21-\x2b\x2d-\x7e]+$/.test(apiKey)) ||
      !contentType ||
      incoming.get('anthropic-version') !== messagesVersion ||
      incoming.get('accept') !== (routeId === 'messages' ? sse : null) ||
      (encoding !== null && encoding !== 'identity') ||
      (routeId === 'files'
        ? beta !== filesBeta
        : beta !== null && beta !== filesBeta)
    )
      throw invalid();
    const headers = new Headers({
      'content-type': contentType,
      'anthropic-version': messagesVersion,
    });
    if (bearer !== null) headers.set('authorization', bearer);
    if (apiKey !== null) headers.set('x-api-key', apiKey);
    if (routeId === 'messages') headers.set('accept', sse);
    if (beta !== null) headers.set('anthropic-beta', filesBeta);

    const trusted = manifestFor(request);
    if (
      !trusted ||
      trusted.sessionId !== call.sessionId ||
      trusted.bindingId !== call.bindingId ||
      !trusted.credentialGeneration ||
      trusted.images.length > 600 ||
      trusted.images.length !== trusted.imageHandleDigests.length ||
      !request.isCurrent()
    )
      throw invalid();
    const manifest = {
      ...trusted,
      images: trusted.images.map((image) => ({ ...image })),
      imageHandleDigests: [...trusted.imageHandleDigests],
      workingDirectoryEdits: trusted.workingDirectoryEdits.map((edit) => ({
        ...edit,
      })),
    };
    const bound = manifestKey(manifest);
    const identity = identityKey(manifest);
    const credential = createHmac('sha256', credentialKey)
      .update(JSON.stringify([bearer, apiKey]))
      .digest('hex');
    const preparationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(attemptDeadlineMs),
    ]);
    const attemptSignal = routeId === 'files' ? preparationSignal : signal;
    const current = () => {
      if (attemptSignal.aborted || !request.isCurrent()) return false;
      const latest = manifestFor(request);
      return (
        latest !== undefined &&
        latest.images.length <= 600 &&
        manifestKey(latest) === bound
      );
    };
    const bytes = await readBytes(request.body, bodyLimit, preparationSignal);
    const prepare = (body: Buffer) => ({
      ...request,
      call: { ...call },
      headers,
      body: new Response(Uint8Array.from(body)).body!,
      signal: attemptSignal,
      isCurrent: current,
    });
    if (routeId === 'messages') {
      const projected = projectDeepSeekMessages(
        bytes,
        contentType,
        call.model,
        manifest,
      );
      if (!projected) throw invalid();
      const { evidence } = projected;
      if (
        (beta !== null) !==
          evidence.images.some(({ kind }) => kind === 'file') ||
        messageDeadline(evidence, manifest, identity, credential) === undefined
      )
        throw invalid();
      const prepared = prepare(projected.body);
      return messages(prepared, (write) =>
        runs.authorizeModelWireAttempt(prepared, (validBefore) => {
          const deadline = messageDeadline(
            evidence,
            manifest,
            identity,
            credential,
          );
          return current() && deadline !== undefined
            ? write(Math.min(validBefore, deadline))
            : 'not-sent';
        }),
      );
    }

    const evidence = readDeepSeekFilesEvidence(bytes, contentType);
    const prepared = prepare(bytes);
    if (
      !evidence ||
      !manifest.images.some((image) => sameImage(image, evidence.image))
    )
      throw invalid();
    const uploadKey = JSON.stringify([identity, imageKey(evidence.image)]);
    if (
      uploads.size >= maxUploads ||
      uploads.has(uploadKey) ||
      [...uploads.values()].some(
        (upload) =>
          upload.state === 'pending' && upload.bindingId === manifest.bindingId,
      )
    )
      throw invalid();
    const base = {
      bindingId: manifest.bindingId,
      identity,
      credential,
      credentialGeneration: manifest.credentialGeneration,
      image: evidence.image,
    };
    uploads.set(uploadKey, { ...base, state: 'pending' });
    let mayHaveWritten = false;
    let submittedAt: number | undefined;
    let ambiguousId: string | undefined;
    try {
      const response = await files(prepared, (write) =>
        runs.authorizeModelFileWireAttempt(prepared, (validBefore) => {
          if (!current()) return 'not-sent';
          const startedAt = Date.now();
          mayHaveWritten = true;
          const outcome = write(validBefore);
          if (outcome === 'not-sent') mayHaveWritten = false;
          if (outcome === 'submitted') submittedAt = startedAt;
          return outcome;
        }),
      );
      if (submittedAt === undefined || !current()) {
        await response.body?.cancel();
        throw invalid();
      }
      const receipt = await readReceipt(
        response,
        evidence,
        submittedAt,
        attemptSignal,
        (id) => {
          for (const [key, other] of uploads) {
            if (other.credential !== credential) continue;
            if (
              (other.state === 'confirmed' && other.fileId === id) ||
              (other.state === 'unknown' && other.ambiguousId === id)
            ) {
              ambiguousId = id;
              const {
                bindingId,
                identity,
                credential,
                credentialGeneration,
                image,
              } = other;
              uploads.set(key, {
                bindingId,
                identity,
                credential,
                credentialGeneration,
                image,
                state: 'unknown',
                ambiguousId,
              });
            }
          }
        },
      );
      if (ambiguousId || !current() || receipt.expiresAt <= Date.now())
        throw invalid();
      uploads.set(uploadKey, {
        ...base,
        state: 'confirmed',
        fileId: receipt.fileId,
        expiresAt: receipt.expiresAt,
      });
      return receipt.response;
    } finally {
      if (!mayHaveWritten) uploads.delete(uploadKey);
      else if (uploads.get(uploadKey)?.state === 'pending')
        uploads.set(uploadKey, { ...base, state: 'unknown', ambiguousId });
    }
  };
}
