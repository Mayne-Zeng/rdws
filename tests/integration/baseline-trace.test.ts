import { test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inputFiles } from '../../scripts/validate-baseline.mjs';
let root: string;
const original: Record<string, string> = {};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rdws-baseline-'));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  for (const file of inputFiles)
    original[file] = await readFile(join(repository, file), 'utf8');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function run(mutate: (files: Record<string, string>) => void = () => {}) {
  const files = { ...original };
  mutate(files);
  const fixture = await mkdtemp(join(root, 'case-'));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(fixture, file)), { recursive: true });
    await writeFile(join(fixture, file), text);
  }
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../scripts/validate-baseline.mjs', import.meta.url),
      ),
      fixture,
    ],
    { encoding: 'utf8' },
  );
}
test('the real source set has complete trace, view and dependency coverage', async () => {
  const result = await run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'passed',
    tasks: 30,
    views: 16,
    tracePoints: 62,
    interfaceDomains: 17,
    nativeCapabilities: 5,
    gaps: 11,
  });
});
test('the independent atomic index must cite actual approved source text', async () => {
  const result = await run((files) => {
    const file = 'docs/baseline-trace-index.json';
    const index = JSON.parse(files[file]!);
    index.points.find(
      (point: { id: string }) => point.id === 'usage.quota',
    ).evidence.text = 'This sentence is not in the approved source';
    files[file] = JSON.stringify(index);
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing indexed source evidence');
});
test('a missing decision mapping fails against the source ledger', async () => {
  const result = await run((files) => {
    files['docs/02-directory-and-engineering-design.html'] = files[
      'docs/02-directory-and-engineering-design.html'
    ]!.replace(/\s*<tr data-source="I5-RUN D-DB"[\s\S]*?<\/tr>/, '');
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Source coverage');
});
test('unknown and multiple owners are rejected', async () => {
  for (const replacement of ['T99', 'T22 T03']) {
    const result = await run((files) => {
      files['docs/02-directory-and-engineering-design.html'] = files[
        'docs/02-directory-and-engineering-design.html'
      ]!.replace('data-owner="T22"', 'data-owner="' + replacement + '"');
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/owner/);
  }
});
test('duplicate trace points cannot hide behind complete source coverage', async () => {
  const result = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    const row = files[file]!.match(/<tr data-source="I2 D1"[\s\S]*?<\/tr>/)![0];
    files[file] = files[file]!.replace(row, row + row);
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Duplicate trace point');
});
test('a missing formal view mapping fails against design and Demo', async () => {
  const result = await run((files) => {
    const file = 'docs/05-development-backlog.md';
    files[file] = files[file]!.replace(/^\| stats[^\n]+\n/m, '');
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('View coverage');
});
test('an unknown source and a dependency cycle both fail', async () => {
  const unknown = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    files[file] = files[file]!.replace(
      'data-source="I2 D1"',
      'data-source="D999"',
    );
  });
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('Unknown source');
  const cycle = await run((files) => {
    const file = 'docs/05-development-backlog.md';
    const text = files[file]!,
      start = text.indexOf('**T03 ·'),
      end = text.indexOf('**T04 ·');
    files[file] =
      text.slice(0, start) +
      text.slice(start, end).replace(/- 前置：[^\n]+/, '- 前置：T03。') +
      text.slice(end);
  });
  expect(cycle.status).toBe(1);
  expect(cycle.stderr).toContain('Dependency cycle');
});
test('new application routes require an updated formal-view state', async () => {
  const result = await run((files) => {
    const file = 'apps/console/src/features/project.tsx';
    files[file] = files[file]!.replace(
      /export type View\s*=\s*([^;]+);/,
      "export type View = $1 | 'models';",
    );
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('View route/state mismatch');
});
test('gap records cannot be silently removed or lose ownership', async () => {
  const empty = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    files[file] = files[file]!.replace(
      /(<table id="t00-gaps">)[\s\S]*?<\/table>/,
      '$1</table>',
    );
  });
  expect(empty.status).toBe(1);
  expect(empty.stderr).toContain('Missing gap records');
  const unknown = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    files[file] = files[file]!.replace(
      'data-gap="T00-G1" data-owner="T04"',
      'data-gap="T00-G1" data-owner="T99"',
    );
  });
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain('gap owner');
});
test('shared interfaces and native capability ownership reference real tasks', async () => {
  for (const id of ['t00-interfaces', 't00-native-apis']) {
    const result = await run((files) => {
      const file = 'docs/02-directory-and-engineering-design.html';
      const text = files[file]!,
        start = text.indexOf('<table id="' + id + '">'),
        end = text.indexOf('</table>', start);
      files[file] =
        text.slice(0, start) +
        text.slice(start, end).replace(/>T\d{2}<\/a>/, '>T99</a>') +
        text.slice(end);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown interface/API owner');
  }
});
test('removing one atomic point cannot hide behind another point with the same source', async () => {
  const result = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    files[file] = files[file]!.replace(
      /<tr(?=[^>]*data-source="D19")(?=[^>]*data-owner="T15")[^>]*>[\s\S]*?<\/tr>/,
      '',
    );
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Atomic point coverage');
});
test('renaming a copied atomic point cannot give it a second owner', async () => {
  const result = await run((files) => {
    const file = 'docs/02-directory-and-engineering-design.html';
    const row = files[file]!.match(
      /<tr(?=[^>]*data-source="D19")(?=[^>]*data-owner="T15")[^>]*>[\s\S]*?<\/tr>/,
    )![0];
    const copied = row
      .replace('用量与配额', '用量与配额副本')
      .replace('data-owner="T15"', 'data-owner="T13"')
      .replace('>T15</a>', '>T13</a>');
    files[file] = files[file]!.replace(row, row + copied);
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Duplicate atomic point');
});
test('individual interface, native capability and gap records cannot disappear', async () => {
  for (const [pattern, message] of [
    [/<tr[^>]*><td>写资格／停止交接<\/td>[\s\S]*?<\/tr>/, 'Interface coverage'],
    [
      /<tr[^>]*><td>配置与凭据<\/td>[\s\S]*?<\/tr>/,
      'Native capability coverage',
    ],
    [/<tr data-gap="T00-G2"[\s\S]*?<\/tr>/, 'Gap coverage'],
  ] as const) {
    const result = await run((files) => {
      const file = 'docs/02-directory-and-engineering-design.html';
      files[file] = files[file]!.replace(pattern, '');
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  }
});
