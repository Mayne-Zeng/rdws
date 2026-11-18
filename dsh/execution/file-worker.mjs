import { randomUUID } from 'node:crypto';
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

const [operation, path, limit] = process.argv.slice(1);
const max = Number(limit);
const parent = dirname(resolve(path));
const readFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function inspect(file) {
  const stat = fstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid file');
  return stat;
}

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
  } else {
    const content = readFileSync(0);
    if (content.length > max) throw new Error('File exceeds the limit');
    let mode = 0o600;
    try {
      const file = openSync(path, readFlags);
      try {
        mode = inspect(file).mode & 0o777;
      } finally {
        closeSync(file);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const stage = resolve(parent, '.rdws-write-' + randomUUID());
    const temp = openSync(stage, 'wx', mode);
    try {
      try {
        writeFileSync(temp, content);
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
} catch (error) {
  process.stderr.write(`${error.code ?? 'FILE'}: ${error.message}\n`);
  process.exitCode = 1;
}
