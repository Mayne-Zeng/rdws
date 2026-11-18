import { createHash } from 'node:crypto';
import {
  appendFile,
  link,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { inspectJournalCutoff } from '../../scripts/trace-cutoff.mjs';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

const sessionId = 'session-cutoff-fixture';
const source = {
  sessionId,
  generation: 4,
  bucket: '--work--',
  compressed: true,
};
const header = (version = 4, cwd = '/work') =>
  JSON.stringify({
    type: 'session',
    id: sessionId,
    version,
    createdAt: 1,
    delegationDepth: 0,
    cwd,
  }) + '\n';
const row = (text = 'fixture') =>
  JSON.stringify({ type: 'assistant/message', text }) + '\n';
const frame = (text: string) =>
  zstdCompressSync(Buffer.from(text), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
const complete = (bytes: Buffer, ignoredTailBytes = 0) => ({
  status: 'hashed',
  throughByte: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ignoredTailBytes,
});
let root: string;
let path: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'rdws-cutoff-'));
  path = join(root, 'journal');
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  await rm(root, { recursive: true, force: true });
});

test('legacy JSONL uses physical byte offsets across chunks and excludes a nonterminated tail', async () => {
  const prefix = Buffer.from(
    header(0, 'C:\\work\\需求🧪') + row('é'.repeat(70_000)),
  );
  const tail = Buffer.from([0xff, 0xfe, 0x01]);
  await writeFile(path, Buffer.concat([prefix, tail]));
  expect(
    await inspectJournalCutoff(path, {
      ...source,
      generation: 0,
      bucket: '--C-work-~9700~6C42~D83E~DDEA--',
      compressed: false,
    }),
  ).toEqual(complete(prefix, tail.length));
  expect(
    await inspectJournalCutoff(path, {
      ...source,
      generation: 5,
      compressed: false,
    }),
  ).toEqual({ status: 'invalid-journal' });
});

test('Zstandard selects the last whole checksummed frame across multiple blocks', async () => {
  const headerFrame = frame(header());
  const messages = frame(row('大'.repeat(100_000)) + row('another'));
  const completeFrames = Buffer.concat([
    headerFrame,
    messages,
    frame(row('last')),
  ]);
  const unfinished = frame(row('uncommitted'));
  for (const tail of [
    unfinished.subarray(0, 1),
    unfinished.subarray(0, 3),
    unfinished.subarray(0, unfinished.length - 1),
  ]) {
    await writeFile(path, Buffer.concat([completeFrames, tail]));
    expect(await inspectJournalCutoff(path, source)).toEqual(
      complete(completeFrames, tail.length),
    );
  }
});

test('standard raw and RLE blocks preserve one physical frame boundary', async () => {
  const start = Buffer.from('{"type":"user/message","text":"');
  const end = Buffer.from('"}\n');
  const repeats = 40;
  const block = (kind: number, length: number, final = false) => {
    const bytes = Buffer.alloc(3);
    bytes.writeUIntLE(length * 8 + 2 * kind + Number(final), 0, 3);
    return bytes;
  };
  const mixed = Buffer.concat([
    Buffer.from([
      0x28,
      0xb5,
      0x2f,
      0xfd,
      0x20,
      start.length + repeats + end.length,
    ]),
    block(0, start.length),
    start,
    block(1, repeats),
    Buffer.from('x'),
    block(0, end.length, true),
    end,
  ]);
  expect(zstdDecompressSync(mixed).toString()).toBe(
    start.toString() + 'x'.repeat(repeats) + end.toString(),
  );
  const bytes = Buffer.concat([frame(header()), mixed]);
  await writeFile(path, bytes);
  expect(await inspectJournalCutoff(path, source)).toEqual(complete(bytes));
});

test('malformed complete or partial frames fail closed instead of lowering the cutoff', async () => {
  const good = frame(header());
  const wrongChecksum = frame(row());
  wrongChecksum[wrongChecksum.length - 1]! ^= 0x01;
  const magic = [0x28, 0xb5, 0x2f, 0xfd];
  for (const extra of [
    Buffer.from([0x28, 0x00]),
    Buffer.from('junk'),
    Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]),
    Buffer.from([...magic, 0x08]),
    Buffer.from([...magic, 0x01]),
    Buffer.from([...magic, 0x00, 0x00, 7]),
    Buffer.from([...magic, 0x00, 0x00, 0xf9, 0xff]),
    Buffer.from([...magic, 0x00, 0x38, 9, 0, 16]),
    wrongChecksum,
    frame(row().slice(0, -1)),
    frame(header()),
    frame(''),
  ]) {
    await writeFile(path, Buffer.concat([good, extra]));
    expect(await inspectJournalCutoff(path, source)).toEqual({
      status: 'invalid-journal',
    });
  }
  await writeFile(
    path,
    Buffer.concat([good, Buffer.from([...magic, 0x00, 144])]),
  );
  expect(await inspectJournalCutoff(path, source)).toEqual({
    status: 'cutoff-limit',
  });
  await writeFile(path, good.subarray(0, good.length - 1));
  expect(await inspectJournalCutoff(path, source)).toEqual({
    status: 'cutoff-unavailable',
  });
});

test('a torn frame excludes its bytes and still rejects provably corrupt blocks', async () => {
  const good = frame(header());
  const magic = [0x28, 0xb5, 0x2f, 0xfd];
  const unfinished = frame(row()).subarray(0, -1);
  await writeFile(path, Buffer.concat([good, unfinished]));
  expect(await inspectJournalCutoff(path, source)).toEqual(
    complete(good, unfinished.length),
  );
  const emptyBlock = Buffer.from([...magic, 0, 0, 20, 0, 0, 0, 0]);
  await writeFile(path, Buffer.concat([good, emptyBlock]));
  expect(await inspectJournalCutoff(path, source)).toEqual(
    complete(good, emptyBlock.length),
  );
  for (const rejected of [
    Buffer.from([...magic, 0, 0, 4, 0, 0]),
    Buffer.from([...magic, 0, 0, 12, 0, 0, 0]),
    Buffer.from([...magic, 4, 0, 13, 0, 0, 0]),
    Buffer.from([...magic, 0, 0, 20, 0, 0, 0xff, 0xff]),
  ]) {
    await writeFile(path, Buffer.concat([good, rejected]));
    expect(await inspectJournalCutoff(path, source)).toEqual({
      status: 'invalid-journal',
    });
  }
});

test('complete records must match the journal coordinates and be valid UTF-8 objects', async () => {
  for (const data of [
    Buffer.from(header(3) + row()),
    Buffer.from(header(4, '/another') + row()),
    Buffer.from(header().replace(sessionId, 'session-other') + row()),
    Buffer.from(header() + '[]\n'),
    Buffer.from(header() + 'false\n'),
    Buffer.from(header() + row() + header()),
    Buffer.concat([Buffer.from(header()), Buffer.from([0xff, 10])]),
  ]) {
    await writeFile(path, data);
    expect(
      await inspectJournalCutoff(path, { ...source, compressed: false }),
    ).toEqual({ status: 'invalid-journal' });
  }
  const good = Buffer.from(header());
  const excess = Buffer.alloc(400, 90);
  await writeFile(path, Buffer.concat([good, excess]));
  expect(
    await inspectJournalCutoff(
      path,
      { ...source, compressed: false },
      { maxLineBytes: 128 },
    ),
  ).toEqual(complete(good, excess.length));
  await appendFile(path, '\n');
  expect(
    await inspectJournalCutoff(
      path,
      { ...source, compressed: false },
      { maxLineBytes: 128 },
    ),
  ).toEqual({ status: 'cutoff-limit' });
  expect(
    await inspectJournalCutoff(
      path,
      { ...source, compressed: false },
      { budgetMs: 0 },
    ),
  ).toEqual({ status: 'cutoff-limit' });
});

test('a path alias or hard link cannot supply a cutoff', async () => {
  await writeFile(path, frame(header()));
  const alias = join(root, 'alias');
  await symlink(path, alias);
  expect(await inspectJournalCutoff(alias, source)).toEqual({
    status: 'invalid-source',
  });
  await link(path, join(root, 'hard-link'));
  expect(await inspectJournalCutoff(path, source)).toEqual({
    status: 'invalid-source',
  });
});

test('an early read EOF is unavailable and a detected mutation takes precedence', async () => {
  await writeFile(path, frame(header()));
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    vi.spyOn(file, 'read').mockResolvedValue({
      bytesRead: 0,
      buffer: Buffer.alloc(0),
    });
    return file;
  });
  expect(await inspectJournalCutoff(path, source)).toEqual({
    status: 'source-unavailable',
  });
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    vi.spyOn(file, 'read').mockImplementationOnce(async () => {
      await appendFile(path, 'concurrent change');
      return { bytesRead: 0, buffer: Buffer.alloc(0) };
    });
    return file;
  });
  expect(await inspectJournalCutoff(path, source)).toEqual({
    status: 'source-changed',
  });
});

test('a stable read cannot return a cutoff after its final identity check exceeds the budget', async () => {
  await writeFile(path, header() + row());
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  let comparedAfter = false;
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    const stat = file.stat.bind(file);
    vi.spyOn(file, 'stat')
      .mockImplementationOnce((...options) =>
        Reflect.apply(stat, undefined, options),
      )
      .mockImplementationOnce(async (...options) => {
        comparedAfter = true;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return Reflect.apply(stat, undefined, options);
      });
    return file;
  });
  expect(
    await inspectJournalCutoff(
      path,
      { ...source, compressed: false },
      { budgetMs: 200 },
    ),
  ).toEqual({ status: 'cutoff-limit' });
  expect(comparedAfter).toBe(true);
});
