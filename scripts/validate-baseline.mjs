import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inputFiles = [
  'docs/00-decision-ledger.html',
  'docs/02-directory-and-engineering-design.html',
  'docs/03-design-crosscheck-report.html',
  'docs/04-design-baseline.html',
  'docs/05-development-backlog.md',
  'demo/rdws-workbench.html',
  'apps/console/src/features/project.tsx',
  'docs/baseline-trace-index.json',
];
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const textOf = (value) =>
  value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const rowsOf = (html) =>
  [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)]
    .filter((m) => /<td\b/.test(m[2]))
    .map((m) => ({
      attributes: m[1],
      cells: [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        textOf(c[1]),
      ),
      html: m[0],
    }));
const attribute = (row, name) =>
  row.attributes.match(new RegExp(name + '="([^"]+)"'))?.[1];
const tableOf = (html, id) => {
  const table = html.match(
    new RegExp('<table\\b[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/table>'),
  );
  ensure(table, 'Missing table: ' + id);
  return table[1];
};
function idsOf(value) {
  const expanded = value.replace(
    /([DTF])(\d+)[–-](?:[DTF])?(\d+)/g,
    (_, prefix, start, end) =>
      Array.from(
        { length: Number(end) - Number(start) + 1 },
        (_, i) =>
          prefix +
          (prefix === 'D'
            ? String(Number(start) + i)
            : String(Number(start) + i).padStart(2, '0')),
      ).join(' '),
  );
  return expanded.match(/\b(?:D-DB|D\d+|I\d+(?:-[A-Z]+)?|Q\d+)\b/g) ?? [];
}
function taskIds(value) {
  const expanded = value.replace(
    /([TF])(\d{2})[–-](?:[TF])?(\d{2})/g,
    (_, prefix, start, end) =>
      Array.from(
        { length: Number(end) - Number(start) + 1 },
        (_, i) => prefix + String(Number(start) + i).padStart(2, '0'),
      ).join(' '),
  );
  return [...new Set(expanded.match(/\b[TF]\d{2}\b/g) ?? [])];
}
function equalSets(actual, expected, label) {
  const missing = [...expected].filter((x) => !actual.has(x)),
    extra = [...actual].filter((x) => !expected.has(x));
  ensure(
    !missing.length && !extra.length,
    label + ': missing=' + missing.join(',') + ' extra=' + extra.join(','),
  );
}
export function validateBaseline(data) {
  const [
    ledger,
    engineering,
    crosscheck,
    design,
    backlog,
    demo,
    project,
    indexText,
  ] = inputFiles.map((file) => data[file]);
  const index = JSON.parse(indexText);
  ensure(index.version === 1, 'Unsupported baseline index version');
  const definitions = new Map();
  const sourceFiles = new Set([
    'docs/00-decision-ledger.html',
    'docs/03-design-crosscheck-report.html',
  ]);
  for (const point of index.points) {
    ensure(
      typeof point.id === 'string' && !definitions.has(point.id),
      'Duplicate/missing indexed point',
    );
    ensure(
      sourceFiles.has(point.evidence.file) &&
        textOf(data[point.evidence.file]).includes(point.evidence.text),
      'Missing indexed source evidence: ' + point.id,
    );
    ensure(
      point.evidence.text.length > 0 && point.sources.length > 0,
      'Empty indexed source evidence: ' + point.id,
    );
    definitions.set(point.id, point);
  }
  const recordSet = (name) => {
    const entries = index[name];
    ensure(
      Array.isArray(entries) && entries.length > 0,
      'Missing indexed records: ' + name,
    );
    const unique = new Set(entries);
    ensure(
      unique.size === entries.length,
      'Duplicate indexed records: ' + name,
    );
    return unique;
  };
  const interfaceIds = recordSet('interfaces'),
    capabilityIds = recordSet('nativeCapabilities'),
    gapIds = recordSet('gaps');
  const taskMatches = [
    ...backlog.matchAll(/^- \[[ x]\] \*\*([TF]\d{2}) ·[^\n]+/gm),
  ];
  const tasks = new Set(taskMatches.map((m) => m[1]));
  ensure(tasks.size === taskMatches.length, 'Duplicate task id');
  const dependencies = new Map();
  for (const [index, match] of taskMatches.entries()) {
    const section = backlog.slice(
      match.index,
      taskMatches[index + 1]?.index ?? backlog.length,
    );
    let prerequisite = section.match(/^  - 前置：([^\n]+)/m)?.[1];
    ensure(prerequisite !== undefined, 'Missing prerequisite: ' + match[1]);
    prerequisite = prerequisite
      .split('。')[0]
      .split(/；(?:无需等待|不要求)/)[0];
    const deps = taskIds(prerequisite);
    for (const dep of deps)
      ensure(tasks.has(dep), 'Unknown dependency: ' + dep);
    dependencies.set(match[1], deps);
  }
  const visiting = new Set(),
    visited = new Set();
  function visit(id) {
    ensure(!visiting.has(id), 'Dependency cycle: ' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of dependencies.get(id)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks) visit(id);
  const expected = new Set();
  for (const row of rowsOf(ledger))
    if (/^(D\d|D-DB|I\d)/.test(row.cells[0]))
      for (const id of idsOf(row.cells[0])) expected.add(id);
  for (const row of rowsOf(crosscheck))
    if (/^Q\d+\b/.test(row.cells[0]))
      for (const id of idsOf(row.cells[0])) expected.add(id);
  const execution = ledger.match(/<h3>1\.5[\s\S]*?(?=<h2 id="s2")/);
  ensure(execution, 'Missing execution source');
  for (const match of execution[0].matchAll(
    /<li><strong>([\s\S]*?)<\/strong>/g,
  ))
    expected.add('EXEC:' + textOf(match[1]).replace(/\s+/g, '-'));
  for (const id of ['R-A', 'R-B', 'C1']) {
    ensure(ledger.includes(id), 'Missing residual source: ' + id);
    expected.add(id);
  }
  equalSets(
    new Set([...definitions.values()].flatMap((point) => point.sources)),
    expected,
    'Catalog source coverage',
  );
  const traced = new Set(),
    atomicPoints = new Set(),
    points = new Set(),
    traceRows = rowsOf(tableOf(engineering, 't00-trace'));
  for (const row of traceRows) {
    const sources = attribute(row, 'data-source')?.split(' ') ?? [],
      owner = attribute(row, 'data-owner');
    ensure(
      owner && /^[TF]\d{2}$/.test(owner),
      'Expected one owner: ' + row.cells[0],
    );
    ensure(tasks.has(owner), 'Unknown owner: ' + owner);
    ensure(row.cells[1] === owner, 'Visible owner mismatch: ' + row.cells[0]);
    ensure(!points.has(row.cells[0]), 'Duplicate trace point: ' + row.cells[0]);
    points.add(row.cells[0]);
    ensure(sources.length > 0, 'Missing trace source');
    for (const id of sources) {
      ensure(expected.has(id), 'Unknown source: ' + id);
      traced.add(id);
    }
    const pointId = attribute(row, 'data-point');
    ensure(definitions.has(pointId), 'Unknown atomic point: ' + pointId);
    ensure(!atomicPoints.has(pointId), 'Duplicate atomic point: ' + pointId);
    atomicPoints.add(pointId);
    equalSets(
      new Set(sources),
      new Set(definitions.get(pointId).sources),
      'Atomic source mapping: ' + pointId,
    );
    for (const related of taskIds(row.cells.slice(2).join(' ')))
      ensure(tasks.has(related), 'Unknown related task: ' + related);
  }
  equalSets(traced, expected, 'Source coverage');
  equalSets(atomicPoints, new Set(definitions.keys()), 'Atomic point coverage');
  const viewSection = design.match(
    /<h3>1\.5[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/,
  );
  ensure(viewSection, 'Missing design views');
  const designViews = new Set(
    rowsOf(viewSection[1]).map((row) => row.cells[0]),
  );
  const demoSection = demo.slice(
    demo.indexOf('const MENU='),
    demo.indexOf('const ALLVIEWS='),
  );
  const demoViews = new Set(
    [
      ...demoSection.matchAll(/\bv:'([a-z]+)'|\[\['([a-z]+)'|,\['([a-z]+)'/g),
    ].map((m) => m[1] ?? m[2] ?? m[3]),
  );
  equalSets(demoViews, designViews, 'Demo/design views');
  const mappedViews = new Set(),
    viewRows = backlog.split('## 16 视图覆盖')[1]?.split('## 单独保留')[0];
  ensure(viewRows, 'Missing view mapping');
  const viewType = project.match(/export type View\s*=\s*([\s\S]*?);/);
  ensure(viewType, 'Missing application View type');
  const aliases = { requirements: 'demands', create: 'demands' };
  const routedViews = new Set(
    [...viewType[1].matchAll(/'([a-z]+)'/g)].map((m) => aliases[m[1]] ?? m[1]),
  );
  for (const view of routedViews)
    ensure(designViews.has(view), 'Unknown application view: ' + view);
  for (const line of viewRows.split('\n')) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (!/^[a-z]+$/.test(cells[0] ?? '')) continue;
    ensure(!mappedViews.has(cells[0]), 'Duplicate view: ' + cells[0]);
    mappedViews.add(cells[0]);
    ensure(
      /^[TF]\d{2}$/.test(cells[2]) && tasks.has(cells[2]),
      'Expected one view owner: ' + cells[0],
    );
    for (const id of taskIds(cells[3]))
      ensure(tasks.has(id), 'Unknown view task: ' + id);
    ensure(cells[4]?.length > 0, 'Missing current view state: ' + cells[0]);
    ensure(
      cells[4].startsWith('部分：') === routedViews.has(cells[0]),
      'View route/state mismatch: ' + cells[0],
    );
  }
  equalSets(mappedViews, designViews, 'View coverage');
  const ownership = {};
  for (const table of ['t00-interfaces', 't00-native-apis']) {
    const names = new Set(),
      ids = new Set(),
      entries = rowsOf(tableOf(engineering, table));
    ensure(entries.length > 0, 'Missing ownership records: ' + table);
    for (const row of entries) {
      ensure(
        !names.has(row.cells[0]),
        'Duplicate ownership domain: ' + row.cells[0],
      );
      names.add(row.cells[0]);
      const id = attribute(
        row,
        table === 't00-interfaces' ? 'data-interface' : 'data-capability',
      );
      ensure(id && !ids.has(id), 'Duplicate/missing interface/API identity');
      ids.add(id);
      ensure(
        /^[TF]\d{2}$/.test(row.cells[1]) && tasks.has(row.cells[1]),
        'Unknown interface/API owner: ' + row.cells[1],
      );
    }
    equalSets(
      ids,
      table === 't00-interfaces' ? interfaceIds : capabilityIds,
      table === 't00-interfaces'
        ? 'Interface coverage'
        : 'Native capability coverage',
    );
    ownership[table] = entries.length;
  }
  const gapRows = rowsOf(tableOf(engineering, 't00-gaps')),
    gaps = new Set();
  ensure(gapRows.length > 0, 'Missing gap records');
  for (const row of gapRows) {
    const id = attribute(row, 'data-gap'),
      owner = attribute(row, 'data-owner');
    ensure(id && !gaps.has(id), 'Duplicate/missing gap id');
    gaps.add(id);
    ensure(row.cells[0].startsWith(id + ' /'), 'Visible gap id mismatch');
    ensure(
      tasks.has(owner) && row.cells[1] === owner,
      'Unknown/mismatched gap owner: ' + owner,
    );
    ensure(
      row.cells.length === 5 && row.cells.every(Boolean),
      'Incomplete gap: ' + id,
    );
  }
  equalSets(gaps, gapIds, 'Gap coverage');
  return {
    tasks: tasks.size,
    sourceClauses: expected.size,
    tracePoints: points.size,
    views: mappedViews.size,
    gaps: gaps.size,
    interfaceDomains: ownership['t00-interfaces'],
    nativeCapabilities: ownership['t00-native-apis'],
  };
}
export async function readBaseline(root) {
  return Object.fromEntries(
    await Promise.all(
      inputFiles.map(async (file) => [
        file,
        await readFile(resolve(root, file), 'utf8'),
      ]),
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root =
      process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
    console.log(
      JSON.stringify({
        status: 'passed',
        ...validateBaseline(await readBaseline(root)),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
