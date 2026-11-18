import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function nativeReady(root: string, project = 'poc') {
  return JSON.parse(
    await readFile(
      join(root, 'runtime', 'instances', 'project-' + project + '.ready.json'),
      'utf8',
    ),
  ) as {
    port: number;
    generation: string;
    pid: number;
  };
}
