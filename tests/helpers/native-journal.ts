import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export function decodeJournal(bytes: Buffer) {
  let offset = 0,
    text = '';
  while (offset < bytes.length) {
    const result = zstdDecompressSync(bytes.subarray(offset), {
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (result.engine.bytesWritten <= 0)
      throw new Error('Journal decoder made no progress');
    offset += result.engine.bytesWritten;
    text += result.buffer.toString();
  }
  return text
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
}
export async function journal(root: string, sessionId: string) {
  const base = join(root, 'runtime/dsh/project-poc/sessions');
  const files = await readdir(base, { recursive: true });
  const file = files.find(
    (p) => p.split('/').includes(sessionId) && p.endsWith('.jsonl.zstd'),
  );
  if (!file) throw new Error('Native journal not persisted');
  const bytes = await readFile(join(base, file));
  const rows = decodeJournal(bytes);
  return {
    bytes,
    header: rows[0],
    events: rows.filter((r) => Number.isSafeInteger(r.seq)),
  };
}
