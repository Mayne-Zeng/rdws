import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function pathUnavailable(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
}

async function journalAt(path) {
  try {
    const entry = await lstat(path, { bigint: true });
    if (entry.isFile() && (await realpath(path)) === path) return entry;
    return null;
  } catch (error) {
    if (pathUnavailable(error)) return undefined;
    throw error;
  }
}

function sameVersion(expected, observed) {
  return (
    observed?.isFile() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

async function hashBytes(file, throughByte) {
  const buffer = Buffer.allocUnsafe(Math.min(throughByte, 128 * 1024));
  const digest = createHash('sha256');
  let offset = 0;
  while (offset < throughByte) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, throughByte - offset),
      offset,
    );
    if (!bytesRead) return undefined;
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest('hex');
}

export async function inspectStableJournal(
  path,
  { singleLink, throughByte },
  inspect,
) {
  const failure = (status) =>
    throughByte === undefined ? { status } : { status, throughByte };
  try {
    const initial = await journalAt(path);
    if (!initial)
      return failure(
        initial === null ? 'invalid-source' : 'source-unavailable',
      );
    if (singleLink && initial.nlink !== 1n) return failure('invalid-source');
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if (pathUnavailable(error)) return undefined;
      throw error;
    });
    if (!file) return failure('source-changed');
    try {
      const before = await file.stat({ bigint: true });
      if (!sameVersion(initial, before)) return failure('source-changed');
      const result = await inspect(file, before.size).catch(() =>
        failure('source-unavailable'),
      );
      const after = await file.stat({ bigint: true });
      const current = await journalAt(path);
      if (!sameVersion(initial, after) || !sameVersion(initial, current))
        return failure('source-changed');
      return result;
    } finally {
      await file.close();
    }
  } catch {
    return failure('source-unavailable');
  }
}

/** @param {string} path @param {number} throughByte @param {string} [expected] */
export async function inspectJournalPrefix(
  path,
  throughByte,
  expected,
  { singleLink = false } = {},
) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes('\0') ||
    !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(basename(path)) ||
    !Number.isSafeInteger(throughByte) ||
    throughByte <= 0 ||
    (expected !== undefined && !/^[0-9a-f]{64}$/i.test(expected))
  )
    return { status: 'invalid-input' };
  return inspectStableJournal(
    path,
    { singleLink, throughByte },
    async (file, size) => {
      if (size < BigInt(throughByte))
        return {
          status: expected === undefined ? 'cutoff-unavailable' : 'truncated',
          throughByte,
        };
      const sha256 = await hashBytes(file, throughByte);
      if (!sha256) return { status: 'source-unavailable', throughByte };
      if (expected === undefined)
        return { status: 'hashed', throughByte, sha256 };
      return {
        status: sha256 === expected.toLowerCase() ? 'matched' : 'mismatch',
        throughByte,
      };
    },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, path, cutoff, expected, ...extra] = process.argv.slice(2);
  const valid =
    path &&
    /^[1-9]\d*$/.test(cutoff ?? '') &&
    !extra.length &&
    ((action === 'hash' && expected === undefined) ||
      (action === 'verify' && expected !== undefined));
  const result = valid
    ? await inspectJournalPrefix(path, Number(cutoff), expected)
    : { status: 'invalid-input' };
  console.log(JSON.stringify(result));
  process.exitCode = ['hashed', 'matched'].includes(result.status)
    ? 0
    : ['mismatch', 'truncated'].includes(result.status)
      ? 1
      : 2;
}
