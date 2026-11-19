import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  readDeepSeekFilesEvidence,
  readDeepSeekMessagesEvidence,
} from '../../apps/server/src/modules/model-attachment-evidence.ts';

const model = 'fixture-vision';
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fileName = 'dsh-0123456789abcdef-01234567.png';
const fileRef = 'synthetic-file-ref';
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

async function multipart(
  options: {
    expires?: string;
    name?: string;
    mediaType?: string;
    extra?: boolean;
    duplicate?: boolean;
    file?: Buffer;
  } = {},
) {
  const form = new FormData();
  form.set('expires_after[anchor]', 'created_at');
  form.set('expires_after[seconds]', options.expires ?? '3600');
  const blob = new Blob([Uint8Array.from(options.file ?? bytes)], {
    type: options.mediaType ?? 'image/png',
  });
  form.set('file', blob, options.name ?? fileName);
  if (options.extra) form.set('purpose', 'synthetic');
  if (options.duplicate) form.append('file', blob, fileName);
  const request = new Request('http://127.0.0.1/v1/files', {
    method: 'POST',
    body: form,
  });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    type: request.headers.get('content-type'),
  };
}

test('commits the exact bounded Native multipart request and the prepared image bytes', async () => {
  const { body, type } = await multipart();
  const evidence = readDeepSeekFilesEvidence(body, type);
  expect(evidence).toEqual({
    request: { bytes: body.length, sha256: sha(body) },
    expiresAfterSeconds: 3600,
    image: { mediaType: 'image/png', bytes: bytes.length, sha256: sha(bytes) },
  });
  expect(JSON.stringify(evidence)).not.toContain(fileName);
  const embeddedText = Buffer.from(type!.split('boundary=')[1]!);
  const withOrdinaryText = Buffer.from(body);
  const fileOffset = withOrdinaryText.indexOf(bytes);
  const embedded = Buffer.concat([
    withOrdinaryText.subarray(0, fileOffset),
    bytes,
    embeddedText,
    withOrdinaryText.subarray(fileOffset + bytes.length),
  ]);
  expect(readDeepSeekFilesEvidence(embedded, type)?.image.sha256).toBe(
    sha(Buffer.concat([bytes, embeddedText])),
  );

  for (const wire of [
    await multipart({ expires: '03599' }),
    await multipart({ expires: '2592001' }),
    await multipart({ name: '../synthetic.png' }),
    await multipart({ name: fileName.replace('.png', '.jpeg') }),
    await multipart({ mediaType: 'image/svg+xml' }),
    await multipart({ extra: true }),
    await multipart({ duplicate: true }),
    await multipart({ file: Buffer.alloc(0) }),
    await multipart({ file: Buffer.alloc(1024 * 1024) }),
    { body: Buffer.concat([Buffer.from('preamble\r\n'), body]), type },
    { body: Buffer.concat([body, Buffer.from('epilogue')]), type },
    { body: body.subarray(0, body.length - 2), type },
    {
      body: Buffer.concat([
        body.subarray(0, fileOffset),
        bytes,
        Buffer.from('\r\n--'),
        embeddedText,
        Buffer.from('--\r\n'),
        body.subarray(fileOffset + bytes.length),
      ]),
      type,
    },
    {
      body,
      type: 'multipart/form-data; boundary=----formdata-undici-000000000000',
    },
  ])
    expect(readDeepSeekFilesEvidence(wire.body, wire.type)).toBeUndefined();
});

const inline = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: bytes.toString('base64'),
  },
};
const ref = { type: 'image', source: { type: 'file', file_id: fileRef } };
const message = {
  model,
  stream: true,
  max_tokens: 64,
  thinking: { type: 'enabled' },
  output_config: { effort: 'high' },
  system: 'SYNTHETIC_PRIVATE_TEXT',
  tools: [],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'SYNTHETIC_PRIVATE_PATH' },
        inline,
        ref,
        ref,
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'SYNTHETIC_PRIVATE_THOUGHT',
          signature: 'synthetic',
        },
        { type: 'text', text: 'fixture' },
      ],
    },
  ],
};
const wireMessage = (value: unknown) => Buffer.from(JSON.stringify(value));

test('commits the exact Native Messages envelope and preserves ordered inline and cached image occurrences', () => {
  const body = wireMessage(message);
  const evidence = readDeepSeekMessagesEvidence(
    body,
    'application/json',
    model,
  );
  expect(evidence).toEqual({
    request: { bytes: body.length, sha256: sha(body) },
    images: [
      {
        kind: 'inline',
        messageIndex: 0,
        blockIndex: 1,
        image: {
          mediaType: 'image/png',
          bytes: bytes.length,
          sha256: sha(bytes),
        },
      },
      {
        kind: 'file',
        messageIndex: 0,
        blockIndex: 2,
        fileIdSha256: sha(fileRef),
      },
      {
        kind: 'file',
        messageIndex: 0,
        blockIndex: 3,
        fileIdSha256: sha(fileRef),
      },
    ],
  });
  expect(JSON.stringify(evidence)).not.toContain(fileRef);
  expect(JSON.stringify(evidence)).not.toContain('SYNTHETIC_PRIVATE');
  expect(JSON.stringify(evidence)).not.toContain(bytes.toString('base64'));
});

test('rejects ambiguous Messages bytes and unknown nested attachment routes', () => {
  const read = (body: Buffer) =>
    readDeepSeekMessagesEvidence(body, 'application/json', model);
  const onlyBlock = (block: unknown) =>
    wireMessage({ ...message, messages: [{ role: 'user', content: [block] }] });
  const body = wireMessage(message);
  for (const invalid of [
    Buffer.from('{"model":"fixture-vision",' + body.toString().slice(1)),
    Buffer.from(JSON.stringify(message, null, 2)),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]),
    Buffer.concat([Buffer.from([0xff]), body]),
    Buffer.alloc(1024 * 1024 + 1),
    wireMessage({ ...message, model: 'wrong' }),
    wireMessage({ ...message, stream: false }),
    wireMessage({ ...message, unknown_extension: { images: [inline] } }),
    wireMessage({ ...message, max_tokens: 0 }),
    wireMessage({ ...message, thinking: { type: 'disabled' } }),
    wireMessage({ ...message, tools: [{ name: 'synthetic' }] }),
    wireMessage({
      ...message,
      messages: [{ role: 'assistant', content: [inline] }],
    }),
    onlyBlock({ type: 'text', text: 'fixture', image: inline }),
    onlyBlock({ type: 'tool_result', content: [inline] }),
    onlyBlock({
      type: 'image',
      source: { type: 'url', url: 'https://example.invalid/image.png' },
    }),
    onlyBlock({ type: 'image', source: { ...inline.source, data: 'AB==' } }),
    onlyBlock({ type: 'image', source: { ...inline.source, data: '' } }),
    onlyBlock({
      type: 'image',
      source: { ...inline.source, media_type: 'image/svg+xml' },
    }),
    onlyBlock({ type: 'image', source: { ...ref.source, file_id: '\ud800' } }),
    onlyBlock({
      type: 'image',
      source: { ...ref.source, file_id: 'synthetic/invalid' },
    }),
    onlyBlock({
      type: 'image',
      source: { ...ref.source, data: bytes.toString('base64') },
    }),
  ])
    expect(read(invalid)).toBeUndefined();
  expect(
    readDeepSeekMessagesEvidence(body, 'text/plain', model),
  ).toBeUndefined();
});
