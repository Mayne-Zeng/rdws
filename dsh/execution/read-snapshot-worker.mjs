import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';

const [rootDevice, rootInode, name, limit] = process.argv.slice(2);
const max = Number(limit);
const uid = BigInt(process.getuid());
const noFollow =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function safe(stat, directory) {
  return (
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) &&
    stat.uid === uid &&
    (stat.mode & 0o022n) === 0n &&
    String(stat.dev) === rootDevice
  );
}

function same(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function unchanged(first, second) {
  return (
    same(first, second) &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function snapshot() {
  const root = openSync('.', noFollow | constants.O_DIRECTORY);
  try {
    const rootStat = fstatSync(root, { bigint: true });
    if (!safe(rootStat, true) || String(rootStat.ino) !== rootInode)
      throw new Error();
    const parts = name.split('/');
    const chain = [{ path: '.', info: rootStat }];
    let parent = '.';
    for (const component of parts.slice(0, -1)) {
      parent = join(parent, component);
      const info = lstatSync(parent, { bigint: true });
      if (!safe(info, true)) throw new Error();
      chain.push({ path: parent, info });
    }
    const leaf = lstatSync(name, { bigint: true });
    if (!safe(leaf, false)) throw new Error();
    const fd = openSync(name, noFollow);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!safe(before, false) || !unchanged(leaf, before)) throw new Error();
      if (before.size > BigInt(max)) {
        process.exitCode = 78;
        return;
      }
      const bytes = Buffer.alloc(Number(before.size));
      let loaded = 0;
      while (loaded < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          loaded,
          bytes.length - loaded,
          loaded,
        );
        if (count === 0) throw new Error();
        loaded += count;
      }
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(name, { bigint: true });
      if (
        !safe(after, false) ||
        !safe(current, false) ||
        !unchanged(before, after) ||
        !unchanged(after, current)
      )
        throw new Error();
      for (const directory of chain) {
        const latest = lstatSync(directory.path, { bigint: true });
        if (!safe(latest, true) || !same(directory.info, latest))
          throw new Error();
      }
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.includes(0)) throw new Error();
      process.stdout.write(bytes);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(root);
  }
}

try {
  snapshot();
} catch {
  process.exitCode = 1;
}
