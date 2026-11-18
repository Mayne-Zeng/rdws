import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdDecompress } from 'node:zlib';
import { inspectStableJournal } from './trace-prefix.mjs';

const blockLimit = 128 * 1024;
const windowLog = 27;
const windowLimit = 2 ** windowLog;
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class InvalidJournal extends Error {}
class InputUnavailable extends Error {}
class CutoffLimit extends Error {}

async function readBytes(file, offset, length, budget) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    budget.check();
    const { bytesRead } = await file
      .read(buffer, filled, length - filled, offset + filled)
      .catch(() => {
        throw new InputUnavailable();
      });
    if (!bytesRead) throw new InputUnavailable();
    filled += bytesRead;
  }
  budget.check();
  return buffer;
}

async function* readSpan(file, start, end, budget) {
  while (start < end) {
    const length = Math.min(blockLimit, end - start);
    yield await readBytes(file, start, length, budget);
    start += length;
  }
}

function nativeBucket(cwd) {
  if (cwd === undefined) return '_no-cwd';
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0'))
    throw new InvalidJournal();
  const slug = cwd
    .replace(/[\\/:]+/g, '-')
    .replace(
      /[^A-Za-z0-9._-]/g,
      (unit) =>
        '~' + unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
    )
    .replace(/^-+/, '');
  return '--' + (slug || 'root').slice(0, 251) + '--';
}

function recordReader(source, maxLineBytes, budget) {
  let fragments = [],
    pending = 0,
    offset = 0,
    count = 0,
    cutoff = 0;
  function row(bytes) {
    let value;
    try {
      value = JSON.parse(utf8.decode(bytes));
    } catch {
      throw new InvalidJournal();
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.type !== 'string' ||
      !value.type
    )
      throw new InvalidJournal();
    if (count === 0) {
      if (
        value.type !== 'session' ||
        value.id !== source.sessionId ||
        value.version !== source.generation ||
        nativeBucket(value.cwd) !== source.bucket
      )
        throw new InvalidJournal();
    } else if (value.type === 'session') {
      throw new InvalidJournal();
    }
    count++;
  }

  return {
    get count() {
      return count;
    },
    get pending() {
      return pending;
    },
    get cutoff() {
      return cutoff;
    },
    write(bytes) {
      let start = 0;
      for (
        let newline = bytes.indexOf(10);
        newline !== -1;
        newline = bytes.indexOf(10, start)
      ) {
        budget.check();
        const line = bytes.subarray(start, newline);
        if (pending + line.length > maxLineBytes) throw new CutoffLimit();
        row(
          pending
            ? Buffer.concat([...fragments, line], pending + line.length)
            : line,
        );
        fragments = [];
        pending = 0;
        cutoff = offset + newline + 1;
        start = newline + 1;
      }
      if (start < bytes.length) {
        pending += bytes.length - start;
        if (pending <= maxLineBytes)
          fragments.push(Buffer.from(bytes.subarray(start)));
        else fragments = [];
      }
      offset += bytes.length;
    },
  };
}

function littleEndian(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--)
    value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

async function frameEnd(file, start, size, budget) {
  const prefix = await readBytes(
    file,
    start,
    Math.min(5, size - start),
    budget,
  );
  const bytesOfMagic = Math.min(4, prefix.length);
  if (!prefix.subarray(0, bytesOfMagic).equals(magic.subarray(0, bytesOfMagic)))
    throw new InvalidJournal();
  if (prefix.length < 5) return;
  const descriptor = prefix[4];
  if (descriptor & 0x1b) throw new InvalidJournal();
  const single = Boolean(descriptor & 0x20);
  const sizeFlag = descriptor >>> 6;
  const contentBytes = sizeFlag ? 1 << sizeFlag : Number(single);
  const headerBytes = Number(!single) + contentBytes;
  let offset = start + 5;
  const header = await readBytes(
    file,
    offset,
    Math.min(headerBytes, size - offset),
    budget,
  );
  let window;
  if (single) {
    const minimum = littleEndian(header) + (sizeFlag === 1 ? 256n : 0n);
    if (minimum > BigInt(windowLimit)) throw new CutoffLimit();
    window = Number(minimum);
  } else if (header.length) {
    const base = 2 ** (10 + (header[0] >>> 3));
    window = base + (base / 8) * (header[0] & 7);
    if (window > windowLimit) throw new CutoffLimit();
  }
  if (header.length !== headerBytes) return;
  offset += headerBytes;
  for (;;) {
    const block = await readBytes(
      file,
      offset,
      Math.min(3, size - offset),
      budget,
    );
    if (!block.length) return;
    const fields = Number(littleEndian(block));
    const kind = (fields >>> 1) & 3;
    const length = fields >>> 3;
    if (kind === 3 || length > Math.min(window, blockLimit))
      throw new InvalidJournal();
    if (block.length !== 3) return;
    if (kind === 2 && length < 2) throw new InvalidJournal();
    offset += 3;
    const stored = kind === 1 ? 1 : length;
    if (stored > size - offset) return;
    offset += stored;
    if (fields & 1) {
      const checksumBytes = descriptor & 4 ? 4 : 0;
      return checksumBytes <= size - offset
        ? offset + checksumBytes
        : undefined;
    }
  }
}

async function decodeFrame(file, start, end, budget, records) {
  const decoder = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: windowLog },
    ...(records === undefined ? { finishFlush: constants.ZSTD_e_flush } : {}),
  });
  try {
    await pipeline(
      readSpan(file, start, end, budget),
      decoder,
      async (chunks) => {
        for await (const chunk of chunks) {
          budget.check();
          records?.write(chunk);
        }
      },
      { signal: budget.signal },
    );
  } catch (error) {
    budget.check();
    if (error instanceof InputUnavailable || error instanceof CutoffLimit)
      throw error;
    throw new InvalidJournal();
  }
  if (decoder.bytesWritten !== end - start) throw new InvalidJournal();
}

async function zstdCutoff(file, size, records, budget) {
  let cursor = 0;
  while (cursor < size) {
    const end = await frameEnd(file, cursor, size, budget);
    if (end === undefined) {
      await decodeFrame(file, cursor, size, budget);
      break;
    }
    const before = records.count;
    await decodeFrame(file, cursor, end, budget, records);
    if (
      records.pending ||
      (cursor === 0 ? records.count !== 1 : records.count === before)
    )
      throw new InvalidJournal();
    cursor = end;
  }
  return cursor;
}

export async function inspectJournalCutoff(
  path,
  source,
  { budgetMs = 300_000, maxLineBytes = 64 * 1024 * 1024 } = {},
) {
  if (source.generation < 0 || source.generation > 4)
    return { status: 'invalid-journal' };
  const deadline = performance.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const budget = {
    signal,
    check() {
      if (signal.aborted || performance.now() >= deadline)
        throw new CutoffLimit();
    },
  };
  const result = await inspectStableJournal(
    path,
    { singleLink: true },
    async (file, physicalSize) => {
      try {
        budget.check();
        const size = Number(physicalSize);
        if (!Number.isSafeInteger(size)) throw new CutoffLimit();
        const records = recordReader(source, maxLineBytes, budget);
        let throughByte;
        if (source.compressed) {
          throughByte = await zstdCutoff(file, size, records, budget);
        } else {
          for await (const chunk of readSpan(file, 0, size, budget))
            records.write(chunk);
          throughByte = records.cutoff;
        }
        budget.check();
        if (!throughByte) return { status: 'cutoff-unavailable' };
        const digest = createHash('sha256');
        for await (const chunk of readSpan(file, 0, throughByte, budget))
          digest.update(chunk);
        budget.check();
        return {
          status: 'hashed',
          throughByte,
          sha256: digest.digest('hex'),
          ignoredTailBytes: size - throughByte,
        };
      } catch (error) {
        if (error instanceof CutoffLimit) return { status: 'cutoff-limit' };
        if (error instanceof InvalidJournal)
          return { status: 'invalid-journal' };
        throw error;
      }
    },
  );
  if (
    result.status === 'hashed' &&
    (signal.aborted || performance.now() >= deadline)
  )
    return { status: 'cutoff-limit' };
  return result;
}
