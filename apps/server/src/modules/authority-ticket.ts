import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function readAuthorityTicket(path: string) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        (stat.size !== 64 && stat.size !== 65)
      )
        throw new Error();
      const bytes = Buffer.alloc(66);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, bytesRead).toString('utf8');
      if (!/^[0-9a-f]{64}\n?$/.test(value)) throw new Error();
      return value.slice(0, 64);
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Database authority ticket file is not usable');
  }
}
