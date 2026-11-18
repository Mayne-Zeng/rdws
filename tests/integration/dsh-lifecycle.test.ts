import { test, expect } from 'vitest';
import {
  mkdtemp,
  open,
  readFile,
  writeFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeOwner, acquireInstanceLock } from '@rdws/dsh/web';
test('runtime ownership updates remain parseable without sparse-file padding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-owner-'));
  const file = join(root, 'owner');
  const fd = await open(file, 'wx', 0o600);
  try {
    await writeOwner(fd, { pid: process.pid, mode: 'web' });
    await writeOwner(fd, {
      pid: process.pid,
      childPid: process.pid,
      mode: 'web',
    });
    const contents = await readFile(file, 'utf8');
    expect(contents.includes('\0')).toBe(false);
    expect(JSON.parse(contents).childPid).toBe(process.pid);
  } finally {
    await fd.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('only confirmed stopped parent and child permit ownership recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rdws-recover-'));
  const file = join(root, 'owner');
  try {
    await writeFile(
      file,
      JSON.stringify({ pid: 99999999, childPid: 99999998 }),
    );
    const fd = await acquireInstanceLock(file);
    await writeOwner(fd, { pid: process.pid, childPid: process.pid });
    await expect(acquireInstanceLock(file)).rejects.toThrow();
    await fd.close();
    await unlink(file);
    await writeFile(file, JSON.stringify({ pid: 99999999 }));
    await expect(acquireInstanceLock(file)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
