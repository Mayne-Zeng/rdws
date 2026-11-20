import { createHash } from 'node:crypto';
import { isRecord, onlyKeys } from '@rdws/dsh/access';

const bodyLimit = 1024 * 1024;
const imageLimit = 600;
const directoryEditLimit = 64;
const multipartType =
  /^multipart\/form-data; boundary=(----formdata-undici-[0-9]{12})$/;
const fileHeader =
  /^dsh-[a-f0-9]{16}-[a-f0-9]{8}\.(png|jpeg|webp|gif)"\r\nContent-Type: (image\/(png|jpeg|webp|gif))$/;
const fileId = /^[a-zA-Z0-9_-]{1,256}$/;
const messageKeys = [
  'model',
  'stream',
  'max_tokens',
  'thinking',
  'output_config',
  'system',
  'temperature',
  'stop_sequences',
  'tools',
  'messages',
];
const roleNames = ['user', 'assistant', 'system'];
const efforts = ['low', 'high', 'max'];

type MediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type Commitment = { bytes: number; sha256: string };
type ImageCommitment = Commitment & { mediaType: MediaType };
type ImagePosition = { messageIndex: number; blockIndex: number };
type ImageEvidence = ImagePosition &
  (
    | { kind: 'inline'; image: ImageCommitment }
    | { kind: 'file'; fileIdSha256: string }
  );

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const commit = (body: Buffer): Commitment => ({
  bytes: body.length,
  sha256: digest(body),
});

function knownMedia(value: unknown): value is MediaType {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/webp' ||
    value === 'image/gif'
  );
}

export function readDeepSeekFilesEvidence(
  body: Buffer,
  contentType: string | null | undefined,
) {
  if (
    !body.length ||
    body.length > bodyLimit ||
    typeof contentType !== 'string'
  )
    return;
  const boundary = multipartType.exec(contentType)?.[1];
  if (!boundary) return;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="expires_after[anchor]"\r\n\r\ncreated_at\r\n--${boundary}\r\nContent-Disposition: form-data; name="expires_after[seconds]"\r\n\r\n`,
  );
  const beforeFile = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`,
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  if (
    !body.subarray(0, preamble.length).equals(preamble) ||
    !body.subarray(-ending.length).equals(ending)
  )
    return;
  const expiryEnd = body.indexOf('\r\n', preamble.length);
  if (
    expiryEnd < preamble.length ||
    expiryEnd - preamble.length > 7 ||
    !body.subarray(expiryEnd, expiryEnd + beforeFile.length).equals(beforeFile)
  )
    return;
  const expiry = body.subarray(preamble.length, expiryEnd).toString('latin1');
  const expiresAfterSeconds = Number(expiry);
  if (
    !/^[1-9][0-9]{3,6}$/.test(expiry) ||
    expiresAfterSeconds < 3600 ||
    expiresAfterSeconds > 2592000
  )
    return;
  const headerStart = expiryEnd + beforeFile.length;
  const headerEnd = body.indexOf('\r\n\r\n', headerStart);
  if (headerEnd < headerStart || headerEnd - headerStart > 100) return;
  const fields = fileHeader.exec(
    body.subarray(headerStart, headerEnd).toString('latin1'),
  );
  const mediaType = fields?.[2];
  if (!knownMedia(mediaType) || fields?.[1] !== fields?.[3]) return;
  const image = body.subarray(headerEnd + 4, body.length - ending.length);
  const delimiter = Buffer.from(`--${boundary}`);
  if (
    !image.length ||
    image.subarray(0, delimiter.length).equals(delimiter) ||
    image.includes(`\r\n--${boundary}`)
  )
    return;
  return {
    request: commit(body),
    expiresAfterSeconds,
    image: { ...commit(image), mediaType },
  };
}

function validThinking(thinking: unknown, output: unknown) {
  if (!isRecord(thinking) || !onlyKeys(thinking, ['type'])) return false;
  if (thinking.type === 'disabled') return output === undefined;
  return (
    thinking.type === 'enabled' &&
    isRecord(output) &&
    onlyKeys(output, ['effort']) &&
    typeof output.effort === 'string' &&
    efforts.includes(output.effort)
  );
}

function readImage(
  source: unknown,
  at: ImagePosition,
): ImageEvidence | undefined {
  if (!isRecord(source)) return;
  if (
    source.type === 'file' &&
    onlyKeys(source, ['type', 'file_id']) &&
    typeof source.file_id === 'string' &&
    fileId.test(source.file_id)
  )
    return { ...at, kind: 'file', fileIdSha256: digest(source.file_id) };
  if (
    source.type !== 'base64' ||
    !onlyKeys(source, ['type', 'media_type', 'data']) ||
    !knownMedia(source.media_type) ||
    typeof source.data !== 'string'
  )
    return;
  const image = Buffer.from(source.data, 'base64');
  if (!image.length || image.toString('base64') !== source.data) return;
  return {
    ...at,
    kind: 'inline',
    image: { ...commit(image), mediaType: source.media_type },
  };
}

function inspectDeepSeekMessages(
  body: Buffer,
  contentType: string | null | undefined,
  model: string,
) {
  if (
    !body.length ||
    body.length > bodyLimit ||
    contentType !== 'application/json' ||
    !model ||
    model.length > 160
  )
    return;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return;
  }
  if (
    !isRecord(value) ||
    !onlyKeys(value, messageKeys) ||
    value.model !== model ||
    value.stream !== true ||
    typeof value.max_tokens !== 'number' ||
    !Number.isSafeInteger(value.max_tokens) ||
    value.max_tokens < 1 ||
    value.max_tokens > 256000 ||
    !validThinking(value.thinking, value.output_config) ||
    (value.system !== undefined && typeof value.system !== 'string') ||
    (value.temperature !== undefined &&
      (typeof value.temperature !== 'number' ||
        !Number.isFinite(value.temperature))) ||
    (value.stop_sequences !== undefined &&
      (!Array.isArray(value.stop_sequences) ||
        value.stop_sequences.some((stop) => typeof stop !== 'string'))) ||
    (value.tools !== undefined &&
      (!Array.isArray(value.tools) || value.tools.length !== 0)) ||
    !Array.isArray(value.messages) ||
    !value.messages.length
  )
    return;

  const images: ImageEvidence[] = [];
  for (const [messageIndex, message] of value.messages.entries()) {
    if (
      !isRecord(message) ||
      !onlyKeys(message, ['role', 'content']) ||
      typeof message.role !== 'string' ||
      !roleNames.includes(message.role) ||
      !Array.isArray(message.content) ||
      !message.content.length
    )
      return;
    for (const [blockIndex, block] of message.content.entries()) {
      if (!isRecord(block)) return;
      if (
        block.type === 'text' &&
        onlyKeys(block, ['type', 'text']) &&
        typeof block.text === 'string'
      )
        continue;
      if (
        message.role === 'assistant' &&
        block.type === 'thinking' &&
        onlyKeys(block, ['type', 'thinking', 'signature']) &&
        typeof block.thinking === 'string' &&
        (block.signature === undefined || typeof block.signature === 'string')
      )
        continue;
      if (
        message.role !== 'user' ||
        block.type !== 'image' ||
        !onlyKeys(block, ['type', 'source']) ||
        images.length >= imageLimit
      )
        return;
      const image = readImage(block.source, { messageIndex, blockIndex });
      if (!image) return;
      images.push(image);
    }
  }
  if (!body.equals(Buffer.from(JSON.stringify(value)))) return;
  return {
    value,
    messages: value.messages as Array<{
      role: string;
      content: Record<string, unknown>[];
    }>,
    evidence: { request: commit(body), images },
  };
}

export function readDeepSeekMessagesEvidence(
  body: Buffer,
  contentType: string | null | undefined,
  model: string,
) {
  return inspectDeepSeekMessages(body, contentType, model)?.evidence;
}

export type WorkingDirectoryEdit = Readonly<{
  index: number;
  start: number;
  end: number;
}>;

export function readWorkingDirectoryEdits(value: unknown) {
  if (!Array.isArray(value) || value.length > directoryEditLimit) return;
  const bounded = (position: unknown): position is number =>
    typeof position === 'number' &&
    Number.isSafeInteger(position) &&
    position >= 0 &&
    position <= bodyLimit;
  const edits: WorkingDirectoryEdit[] = [];
  let previous = -1;
  for (const edit of value) {
    if (
      !isRecord(edit) ||
      !onlyKeys(edit, ['index', 'start', 'end']) ||
      !bounded(edit.index) ||
      !bounded(edit.start) ||
      !bounded(edit.end) ||
      edit.index <= previous ||
      edit.end <= edit.start
    )
      return;
    edits.push(
      Object.freeze({ index: edit.index, start: edit.start, end: edit.end }),
    );
    previous = edit.index;
  }
  return Object.freeze(edits);
}

function userContentDigest(blocks: readonly Record<string, unknown>[]) {
  return digest(
    JSON.stringify(
      blocks.map(({ type, text }) =>
        type === 'text' ? ['text', text] : ['image'],
      ),
    ),
  );
}

export function projectDeepSeekMessages(
  body: Buffer,
  contentType: string,
  model: string,
  proof: {
    imageHandleDigests: readonly string[];
    userContentSha256: string;
    workingDirectoryEdits: readonly WorkingDirectoryEdit[];
    projectedUserContentSha256: string;
  },
) {
  const parsed = inspectDeepSeekMessages(body, contentType, model);
  if (
    !parsed ||
    parsed.evidence.images.length !== proof.imageHandleDigests.length
  )
    return;
  const removals = new Map<number, Set<number>>();
  for (const [
    occurrence,
    { messageIndex, blockIndex },
  ] of parsed.evidence.images.entries()) {
    const index = blockIndex - 1;
    const handle = parsed.messages[messageIndex]?.content[index];
    if (
      handle?.type !== 'text' ||
      typeof handle.text !== 'string' ||
      digest(JSON.stringify(handle.text)) !==
        proof.imageHandleDigests[occurrence]
    )
      return;
    const removed = removals.get(messageIndex) ?? new Set();
    removed.add(index);
    removals.set(messageIndex, removed);
  }
  const messages = parsed.messages.map((message, index) => {
    const removed = removals.get(index);
    return removed
      ? {
          ...message,
          content: message.content.filter((_, block) => !removed.has(block)),
        }
      : message;
  });
  const userBlocks = messages
    .filter(({ role }) => role === 'user')
    .flatMap(({ content }) => content);
  if (userContentDigest(userBlocks) !== proof.userContentSha256) return;
  const edits = readWorkingDirectoryEdits(proof.workingDirectoryEdits);
  if (!edits) return;
  for (const { index, start, end } of edits) {
    const block = userBlocks[index];
    if (
      block?.type !== 'text' ||
      typeof block.text !== 'string' ||
      end > block.text.length ||
      end - start < 3 ||
      block.text[start] !== '"' ||
      block.text[end - 1] !== '"'
    )
      return;
    block.text = block.text.slice(0, start) + '"."' + block.text.slice(end);
  }
  if (userContentDigest(userBlocks) !== proof.projectedUserContentSha256)
    return;
  return {
    evidence: parsed.evidence,
    body:
      removals.size || edits.length
        ? Buffer.from(JSON.stringify({ ...parsed.value, messages }))
        : body,
  };
}
