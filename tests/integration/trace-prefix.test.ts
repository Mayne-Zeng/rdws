import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { inspectJournalPrefix } from '../../scripts/trace-prefix.mjs';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

const exec = promisify(execFile);
let root: string;
let path: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'rdws-trace-prefix-'));
  path = join(root, 'session.v4.jsonl.zstd');
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  await rm(root, { recursive: true, force: true });
});

async function run(expectedCode: number, ...args: string[]) {
  let result: { stdout: string; stderr: string; code?: number };
  try {
    result = await exec('pnpm', ['--silent', 'trace:prefix', ...args]);
  } catch (error) {
    const failure = error as typeof result;
    if (typeof failure.code !== 'number') throw error;
    result = failure;
  }
  expect(result.code ?? 0).toBe(expectedCode);
  expect(result.stderr).toBe('');
  const summary: unknown = JSON.parse(result.stdout);
  expect(result.stdout).toBe(JSON.stringify(summary) + '\n');
  expect(result.stdout).not.toContain(root);
  return summary;
}

test('the public command hashes only a fixed raw byte range and distinguishes append, differences and short files', async () => {
  const prefix = Buffer.concat([
    Buffer.from('会话日志样本'),
    Buffer.alloc(128 * 1024 + 19, 0xff),
  ]);
  const byteLength = String(prefix.length);
  const sha256 = createHash('sha256').update(prefix).digest('hex');
  const log = Buffer.concat([prefix, Buffer.from('already-written suffix')]);
  await writeFile(path, log);
  expect(await run(0, 'hash', path, byteLength)).toEqual({
    status: 'hashed',
    throughByte: prefix.length,
    sha256,
  });
  expect(await readFile(path)).toEqual(log);
  const suffix = Buffer.from('more bytes after the cutoff');
  await appendFile(path, suffix);
  expect(
    await run(0, 'verify', path, byteLength, sha256.toUpperCase()),
  ).toEqual({
    status: 'matched',
    throughByte: prefix.length,
  });
  const changed = Buffer.concat([log, suffix]);
  changed[0] = changed[0]! ^ 1;
  await writeFile(path, changed);
  expect((await readFile(path)).byteLength).toBe(log.length + suffix.length);
  expect(await run(1, 'verify', path, byteLength, sha256)).toEqual({
    status: 'mismatch',
    throughByte: prefix.length,
  });
  await truncate(path, prefix.length - 1);
  expect(await run(1, 'verify', path, byteLength, sha256)).toEqual({
    status: 'truncated',
    throughByte: prefix.length,
  });
  expect(await run(2, 'hash', path, byteLength)).toEqual({
    status: 'cutoff-unavailable',
    throughByte: prefix.length,
  });
});

test('bad parameters, missing logs and file aliases are rejected without disclosure', async () => {
  expect(await run(2, 'hash', path, '1e3')).toEqual({
    status: 'invalid-input',
  });
  expect(
    await run(2, 'verify', path, '9007199254740992', '0'.repeat(64)),
  ).toEqual({
    status: 'invalid-input',
  });
  expect(await run(2, 'verify', path, '1', 'z'.repeat(64))).toEqual({
    status: 'invalid-input',
  });
  expect(await run(2, 'hash', path, '1')).toEqual({
    status: 'source-unavailable',
    throughByte: 1,
  });
  const target = join(root, 'session.jsonl');
  await writeFile(target, 'synthetic');
  await symlink(target, path);
  expect(await inspectJournalPrefix(path, 1)).toEqual({
    status: 'invalid-source',
    throughByte: 1,
  });
  const nested = join(root, 'real');
  await mkdir(nested);
  await writeFile(join(nested, 'session.jsonl'), 'synthetic');
  const alias = join(root, 'alias');
  await symlink(nested, alias);
  expect(await inspectJournalPrefix(join(alias, 'session.jsonl'), 1)).toEqual({
    status: 'invalid-source',
    throughByte: 1,
  });
  const fifo = join(root, 'session.v1.jsonl');
  await exec('mkfifo', [fifo]);
  expect(await inspectJournalPrefix(fifo, 1)).toEqual({
    status: 'invalid-source',
    throughByte: 1,
  });
});

test.each(['append', 'replace', 'truncate'])(
  'a concurrent %s yields unavailable evidence before comparing the digest',
  async (change) => {
    const bytes = Buffer.alloc(128 * 1024 + 33, 65);
    await writeFile(path, bytes);
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementationOnce(async (...parameters) => {
        const chunk = await Reflect.apply(read, undefined, parameters);
        if (change === 'append') await appendFile(path, 'new suffix');
        if (change === 'truncate') await truncate(path, 1);
        if (change === 'replace') {
          const replacement = join(root, 'replacement');
          await writeFile(replacement, bytes);
          await rename(replacement, path);
        }
        return chunk;
      });
      return file;
    });
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(await inspectJournalPrefix(path, bytes.length, expected)).toEqual({
      status: 'source-changed',
      throughByte: bytes.length,
    });
  },
);

test.each(['ENOENT', 'ENOTDIR', 'ELOOP'])(
  'a path that disappears or changes during open (%s) differs from initial absence',
  async (code) => {
    await writeFile(path, 'payload');
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error('open failed'), { code }),
    );
    expect(await inspectJournalPrefix(path, 2)).toEqual({
      status: 'source-changed',
      throughByte: 2,
    });
  },
);

test('an incomplete read that contradicts the observed size is not reported as truncation', async () => {
  await writeFile(path, 'payload');
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
  expect(await inspectJournalPrefix(path, 2, '0'.repeat(64))).toEqual({
    status: 'source-unavailable',
    throughByte: 2,
  });
});
