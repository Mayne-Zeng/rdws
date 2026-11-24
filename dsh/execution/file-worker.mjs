import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

// Operations (argv: operation, path, limit[, mode, existingLimit]):
//   read                               the whole file, at most limit bytes
//   write                              stdin (at most limit bytes) to the path
//   write … receipt existingLimit      the write-tool channel: a first
//                                      receipt (existed flag and the base64
//                                      of the bytes before the write) on
//                                      stdout before anything is written, an
//                                      existing target of at most
//                                      existingLimit, then the second receipt
//                                      after the rename
//   edit targetLimit resultLimit       stdin is the JSON edit; the same two
//                                      receipts, the target at most
//                                      targetLimit and the result at most
//                                      resultLimit, both refused before any
//                                      write
// Exit codes: 0 ok, 1 file error, 2 invalid input, 3 over a limit, 4 not
// UTF-8, 5 no match, 6 ambiguous match, 7 not a regular single-link file.
// A nonzero exit before the first receipt leaves no written file; after
// the first receipt the parent judges by the receipts (the file may have
// changed, the result is then unknown).
// edit: the fourth argument is the result limit; write: the fourth is
// the literal "receipt" and the fifth the limit of an existing target.
const [operation, path, limit, fourth, fifth] = process.argv.slice(1);
const max = Number(limit);
const existingLimit = Number(fifth);
const resultLimit = Number(fourth);
const parent = dirname(resolve(path));
const readFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (code, message) => {
  process.stderr.write(message + '\n');
  process.exitCode = code;
};

function inspect(file) {
  const stat = fstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1)
    throw Object.assign(new Error('Invalid file'), { code: 'INVALID' });
  return stat;
}

function openExisting() {
  try {
    const file = openSync(path, readFlags);
    try {
      const stat = inspect(file);
      return { file, stat };
    } catch (error) {
      closeSync(file);
      throw error;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Reads at most limit bytes through the open descriptor; one byte more
// means the file is over the limit.
function readWithin(file, limit) {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  for (;;) {
    const bytes = readSync(file, buffer, total, buffer.length - total);
    if (bytes === 0) break;
    total += bytes;
    if (total > limit) return undefined;
  }
  return buffer.subarray(0, total);
}

function receipt(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

// The temporary file and the target stay in the same directory; the
// rename is the only moment the target changes.
function replace(bytes, mode) {
  const stage = resolve(parent, '.rdws-write-' + randomUUID());
  const temp = openSync(stage, 'wx', mode);
  try {
    try {
      writeFileSync(temp, bytes);
    } finally {
      closeSync(temp);
    }
    renameSync(stage, path);
  } finally {
    try {
      unlinkSync(stage);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// Left-to-right, non-overlapping literal replacement: the same arithmetic
// on both sides (the count and the replacement advance past every match).
function applyEdit(before, edit) {
  const { old_string, new_string, replace_all } = edit;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = before.indexOf(old_string, index);
    if (found === -1) break;
    count++;
    index = found + old_string.length;
  }
  return {
    count,
    after: before.split(old_string).join(new_string),
    replace_all,
  };
}

const wellFormed = (value) => typeof value === 'string' && value.isWellFormed();

try {
  if (realpathSync(parent) !== parent) throw new Error('Invalid parent');
  if (operation === 'read') {
    const file = openSync(path, readFlags);
    try {
      if (inspect(file).size > max) throw new Error('File exceeds the limit');
      const buffer = Buffer.alloc(max + 1);
      const bytes = readSync(file, buffer);
      if (bytes > max) throw new Error('File exceeds the limit');
      process.stdout.write(buffer.subarray(0, bytes));
    } finally {
      closeSync(file);
    }
  } else if (operation === 'write' && fourth === 'receipt') {
    const content = readFileSync(0);
    if (content.length > max) throw new Error('File exceeds the limit');
    const existing = openExisting();
    let before;
    let mode_bits = 0o600;
    if (existing) {
      try {
        mode_bits = existing.stat.mode & 0o777;
        before = readWithin(existing.file, existingLimit);
      } finally {
        closeSync(existing.file);
      }
      if (!before) {
        fail(3, 'LIMIT: existing file over the limit');
      } else {
        // First receipt: before anything reaches the disk.
        receipt({
          kind: 'before',
          existed: true,
          size: before.length,
          sha256: sha256(before),
          bytes: before.toString('base64'),
        });
        replace(content, mode_bits);
        receipt({
          kind: 'after',
          existed: true,
          created: false,
          size: content.length,
          sha256: sha256(content),
        });
      }
    } else {
      receipt({ kind: 'before', existed: false, size: 0, bytes: '' });
      replace(content, mode_bits);
      receipt({
        kind: 'after',
        existed: false,
        created: true,
        size: content.length,
        sha256: sha256(content),
      });
    }
  } else if (operation === 'edit') {
    const input = readFileSync(0);
    let edit;
    try {
      edit = JSON.parse(input.toString('utf8'));
    } catch {
      edit = undefined;
    }
    if (
      !edit ||
      typeof edit !== 'object' ||
      typeof edit.replace_all !== 'boolean' ||
      Object.keys(edit).some(
        (key) => !['old_string', 'new_string', 'replace_all'].includes(key),
      ) ||
      !wellFormed(edit.old_string) ||
      !wellFormed(edit.new_string) ||
      edit.old_string.length === 0 ||
      edit.old_string === edit.new_string
    )
      fail(2, 'INPUT: invalid edit');
    else {
      const existing = openExisting();
      if (!existing) fail(5, 'NOT_FOUND: no such file');
      else {
        let raw;
        let mode_bits;
        try {
          mode_bits = existing.stat.mode & 0o777;
          raw = readWithin(existing.file, max);
        } finally {
          closeSync(existing.file);
        }
        if (!raw) fail(3, 'LIMIT: target over the limit');
        else {
          let text;
          try {
            // Validation only: the BOM is kept and the text below is the
            // raw decoding, so a valid file round-trips byte for byte.
            utf8.decode(raw);
            text = raw.toString('utf8');
          } catch {
            fail(4, 'NOT_UTF8: the target is not UTF-8');
          }
          if (text !== undefined) {
            const { count, after } = applyEdit(text, edit);
            if (count === 0) fail(5, 'NOT_FOUND: old_string not found');
            else if (count > 1 && !edit.replace_all)
              fail(6, 'AMBIGUOUS: old_string matched ' + count + ' times');
            else {
              // The limit of the result is judged before the first receipt:
              // a refused edit emits nothing at all.
              const bytes = Buffer.from(after, 'utf8');
              if (bytes.length > resultLimit)
                fail(3, 'LIMIT: result over the limit');
              else {
                receipt({
                  kind: 'before',
                  existed: true,
                  size: raw.length,
                  sha256: sha256(raw),
                  bytes: raw.toString('base64'),
                });
                replace(bytes, mode_bits);
                receipt({
                  kind: 'after',
                  existed: true,
                  created: false,
                  size: bytes.length,
                  sha256: sha256(bytes),
                  replacements: count,
                });
              }
            }
          }
        }
      }
    }
  } else if (operation === 'write') {
    const content = readFileSync(0);
    if (content.length > max) throw new Error('File exceeds the limit');
    let mode_bits = 0o600;
    const existing = openExisting();
    if (existing) {
      try {
        mode_bits = existing.stat.mode & 0o777;
      } finally {
        closeSync(existing.file);
      }
    }
    replace(content, mode_bits);
  } else throw new Error('Unknown operation');
} catch (error) {
  if ((error.code ?? 'FILE') === 'INVALID') process.exitCode = 7;
  process.stderr.write(`${error.code ?? 'FILE'}: ${error.message}\n`);
  process.exitCode = process.exitCode || 1;
}
