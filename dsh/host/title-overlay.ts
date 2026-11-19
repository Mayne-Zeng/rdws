import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseDocument } from 'yaml';

const execute = promisify(execFile);
type Entry = {
  id?: string;
  name?: string;
  disabled?: unknown;
  config?: unknown;
  group?: boolean;
};
const sources = [
  {
    id: 'session-title',
    name: '@deepseek-ai/dsh-session-title',
    local: 'allowed-title-service.mjs',
  },
  {
    id: 'session-title-llm',
    name: '@deepseek-ai/dsh-session-title-first-prompt-llm',
    local: 'first-message-title.mjs',
  },
] as const;

function isTitleEntry(row: Entry) {
  return sources.some(
    ({ id, name }) =>
      row.id === id || row.id === 'rdws-' + id || row.name === name,
  );
}

function withoutDisabled(entry: Entry) {
  const { disabled, ...rest } = entry;
  return disabled === undefined || disabled === false ? rest : undefined;
}

export async function firstMessageTitleOverlay(
  nativePackage: string,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  try {
    const resolve = createRequire(nativePackage);
    const base = await readFile(
      join(
        dirname(resolve.resolve('@deepseek-ai/dsh-base/package.json')),
        'cordis.patch.yml',
      ),
      'utf8',
    );
    const defaults = parseDocument(base).toJS()[0]?.insert as
      Entry[] | undefined;
    if (!Array.isArray(defaults)) return [];
    const { stdout } = await execute(executable, [...args, '--dump-config'], {
      cwd,
      env,
      maxBuffer: 512 * 1024,
      timeout: 5000,
    });
    const document = parseDocument(stdout);
    if (document.errors.length) return [];
    const entries = document.toJS() as Entry[];
    if (!Array.isArray(entries)) return [];
    const anyNested = (rows: Entry[]): boolean =>
      rows.some(
        (row) =>
          isTitleEntry(row) ||
          (row.group === true &&
            Array.isArray(row.config) &&
            anyNested(row.config as Entry[])),
      );
    if (
      entries.some(
        (row) =>
          row.group === true &&
          Array.isArray(row.config) &&
          anyNested(row.config as Entry[]),
      )
    )
      return [];
    const plugins = [];
    const overrides = [];
    for (const source of sources) {
      const matches = entries.filter(
        ({ id, name }) =>
          id === source.id ||
          id === 'rdws-' + source.id ||
          name === source.name,
      );
      const expected = defaults.find(
        ({ id, name }) => id === source.id && name === source.name,
      );
      const [selected] = matches;
      if (
        matches.length !== 1 ||
        !selected ||
        !expected ||
        !withoutDisabled(selected) ||
        !isDeepStrictEqual(withoutDisabled(selected), withoutDisabled(expected))
      )
        return [];
      overrides.push({ id: source.id, name: source.name, disabled: true });
      plugins.push({
        id: 'rdws-' + source.id,
        name: fileURLToPath(
          new URL('../plugins/rdws-access/' + source.local, import.meta.url),
        ),
        config: expected.config,
      });
    }
    return [...overrides, { insert: plugins }];
  } catch {
    return [];
  }
}
