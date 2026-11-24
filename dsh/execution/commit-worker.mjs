// §11.23 C3/C4: the fixed restricted commit script of the T06 Git commit
// operation. The parent composes every input; the model cannot inject
// code, arguments or a message here. The worker runs inside the Seatbelt
// profile whose only added write surface is the private repository
// (git-dir admin and store) and whose only executable children are this
// worker's node and the resolved Git. Everything is one structured
// protocol on stdout:
//   {stage:'refused', reason, ...}  -> definite zero-commit refusal,
//                                     non-zero exit, the index state of
//                                     the list is restored first;
//   {stage:'uncertain', reason}     -> the commit may have landed, no
//                                     success confirmation, exit 5;
//   {stage:'committed', ...}        -> the three post-commit checks of
//                                     C4 all passed, exit 0.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const maxQueryBytes = 1024 * 1024;
const hashPattern = /^[0-9a-f]{40}$/;

const refuse = (reason, extra = {}) => {
  console.log(JSON.stringify({ stage: 'refused', reason, ...extra }));
  process.exit(3);
};
const uncertain = (reason, extra = {}) => {
  console.log(JSON.stringify({ stage: 'uncertain', reason, ...extra }));
  process.exit(5);
};

// argv (a -e worker): [node, admin, tree, gitExecutable] — the fixed
// values start at 1 because the worker source is loaded through -e.
const [admin, tree, gitExecutable] = process.argv.slice(1);
if (!admin || !tree || !gitExecutable || process.argv.length !== 4)
  refuse('invalid-worker-invocation');
let job;
try {
  job = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  refuse('invalid-job');
}
if (typeof job !== 'object' || job === null) refuse('invalid-job');
const { paths, message, name, email } = job;
if (
  !Array.isArray(paths) ||
  paths.length === 0 ||
  paths.length > 512 ||
  paths.some((p) => typeof p !== 'string' || p.length === 0) ||
  typeof message !== 'string' ||
  typeof name !== 'string' ||
  name.length === 0 ||
  typeof email !== 'string' ||
  email.length === 0
)
  refuse('invalid-job');

const git = (args, options = {}) =>
  spawnSync(
    gitExecutable,
    [
      '--no-pager',
      '--no-optional-locks',
      '--git-dir=' + admin,
      '--work-tree=' + tree,
      '-c',
      'core.bare=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'credential.helper=',
      '-c',
      'maintenance.auto=false',
      ...args,
    ],
    {
      input: options.input ?? '',
      encoding: 'utf8',
      maxBuffer: maxQueryBytes,
      ...(options.env && { env: { ...process.env, ...options.env } }),
    },
  );

// §11.23 C3: the fixed read-only pre-checks — no filter driver and no
// hooksPath definition in the repository configuration (B3/N9: fail
// closed), and the frozen list must be well formed against the tree.
{
  // Fail closed: a configuration read that cannot run is a refusal,
  // never a silent pass.
  const filters = git([
    'config',
    '--local',
    '--name-only',
    '--get-regexp',
    '^filter\\.',
  ]);
  if (filters.status === null)
    refuse('filter-check-unavailable', {
      err: String(filters.error ?? '').slice(0, 120),
    });
  if (filters.status === 0 && filters.stdout.trim() !== '')
    refuse('filter-driver-defined', {
      entries: filters.stdout.trim().split('\n').length,
    });
  const hooks = git(['config', '--local', 'core.hooksPath']);
  if (hooks.status === null)
    refuse('hooks-check-unavailable', {
      err: String(hooks.error ?? '').slice(0, 120),
    });
  if (hooks.status === 0 && hooks.stdout.trim() !== '')
    refuse('hooks-path-defined');
  for (const path of paths) {
    const info = await lstat(join(tree, path)).then(
      (s) => ({ ok: s.isFile() || s.isDirectory() }),
      () => ({ ok: true }),
    );
    if (!info.ok) refuse('path-not-regular', { path });
  }
  // The repo-wide attributes check: a .gitattributes (root or any
  // bounded subdirectory) or info/attributes declaring a filter is a
  // refusal, whatever paths the list names (B3/N9 fail-closed).
  {
    const roots = [tree, join(admin, '..', '..', 'info')];
    const pending = roots.map((root) => ({ root, depth: 0 }));
    let visited = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item) break;
      const { root, depth } = item;
      if (visited++ > 2048 || depth > 8) refuse('attributes-unscannable');
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git')
            pending.push({ root: path, depth: depth + 1 });
          continue;
        }
        if (entry.name !== '.gitattributes' && entry.name !== 'attributes')
          continue;
        let text = '';
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          refuse('attributes-unreadable', { path });
        }
        if (/(^|[\s,"'])filter[ =]/.test(text))
          refuse('attribute-filter', { path });
      }
    }
  }

  const attributes = git(['check-attr', '--stdin', '-z', 'filter', '--'], {
    input: paths.join('\0') + '\0',
  });
  if (attributes.status !== 0)
    refuse(
      'attribute-check-failed|status=' +
        String(attributes.status) +
        '|err=' +
        String(attributes.error ?? '').slice(0, 120) +
        '|out=' +
        String(attributes.stderr ?? '').slice(0, 120),
    );
  const values = attributes.stdout.split('\0');
  for (let i = 0; i + 2 < values.length; i += 3)
    if (values[i + 2] && values[i + 2] !== 'unspecified')
      refuse('attribute-filter', { path: values[i], value: values[i + 2] });
}

const statusLines = () => {
  const status = git(['status', '--porcelain=v1', '--ignore-submodules=all']);
  if (status.status !== 0)
    uncertain('status-failed', { stderr: status.stderr.slice(0, 200) });
  return status.stdout.split('\n').filter((line) => line.length >= 3);
};
// One porcelain v1 entry: two status columns, a space, then the path (a
// rename reports 'old -> new'). A C-quoted path is not judged here: the
// fence refuses it closed instead of comparing quoted forms.
const entryPaths = (line) => {
  const body = line.slice(3);
  if (body.startsWith('"')) return undefined;
  if (body.includes(' -> ')) return body.split(' -> ');
  return [body];
};

const headBefore = git(['rev-parse', '--verify', 'HEAD^{commit}']);
if (headBefore.status !== 0 || !hashPattern.test(headBefore.stdout.trim()))
  refuse('head-unavailable', { stderr: headBefore.stderr.slice(0, 200) });
const parent = headBefore.stdout.trim();

const added = git(['add', '--', ...paths]);
if (added.status !== 0)
  refuse('add-failed', { stderr: added.stderr.slice(0, 200) });

// §11.23 C4: the staged set must equal the frozen list as a path set.
{
  // §11.23 C4: the staged set is the set of index entries relative to
  // HEAD — every porcelain entry whose FIRST status column is not a
  // space counts, whatever its second column says (an 'AM' entry is
  // staged and modified again; its staged half is exactly what a commit
  // would take). Untracked ('??') entries are not in the index and do
  // not count. A C-quoted path stays a fail-closed refusal.
  const staged = [];
  let judgeable = true;
  for (const line of statusLines()) {
    const first = line.charAt(0);
    if (first === ' ' || first === '?') continue;
    const found = entryPaths(line);
    if (!found) {
      judgeable = false;
      break;
    }
    staged.push(...found);
  }
  const equal =
    judgeable &&
    staged.length === paths.length &&
    [...staged].sort().join('\n') === [...paths].sort().join('\n');
  if (!equal) {
    const reset = git(['reset', '-q', '--', ...paths]);
    refuse('staged-set-mismatch', {
      staged: judgeable ? staged : undefined,
      ...(reset.status !== 0 && { resetFailed: true }),
    });
  }
}

const messageFile = join(admin, 'commit-message.tmp');
writeFileSync(messageFile, message, { mode: 0o600 });
const identity = {
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
};
const committed = git(['commit', '--no-verify', '-F', messageFile], {
  env: identity,
});
unlinkSync(messageFile);
if (committed.status !== 0) {
  const reset = git(['reset', '-q', '--', ...paths]);
  refuse('commit-failed', {
    stderr: committed.stderr.slice(0, 200),
    ...(reset.status !== 0 && { resetFailed: true }),
  });
}

// §11.23 C4: the three post-commit checks. Any failure is 'uncertain':
// the commit may exist, so the parent answers by the original key.
const headAfter = git(['rev-parse', '--verify', 'HEAD^{commit}']);
if (headAfter.status !== 0 || !hashPattern.test(headAfter.stdout.trim()))
  uncertain('head-unresolved');
const commitHash = headAfter.stdout.trim();
if (commitHash === parent) uncertain('head-did-not-advance');
const parentOf = git(['rev-parse', '--verify', 'HEAD^']);
if (parentOf.status !== 0 || parentOf.stdout.trim() !== parent)
  uncertain('parent-mismatch', {
    ...(parentOf.status === 0 && { parent: parentOf.stdout.trim() }),
  });
for (const line of statusLines()) {
  const found = entryPaths(line);
  if (found && found.some((p) => paths.includes(p)))
    uncertain('path-still-dirty', {
      path: found.find((p) => paths.includes(p)),
    });
}
const diff = git([
  'diff',
  '--name-status',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=all',
  parent,
  'HEAD',
  '--',
  ...paths,
]);
if (diff.status !== 0)
  uncertain('diff-failed', { stderr: diff.stderr.slice(0, 200) });
const recorded = [];
{
  const diffPaths = new Set();
  const types = new Map();
  for (const line of diff.stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) uncertain('diff-line-unjudgeable', { line });
    const type = line.slice(0, tab);
    const body = line.slice(tab + 1);
    const found = body.startsWith('"') ? undefined : body.split(' -> ');
    if (!found) uncertain('diff-path-unjudgeable', { line });
    for (const path of found) {
      diffPaths.add(path);
      types.set(path, type.charAt(0));
    }
  }
  if (diffPaths.size !== paths.length || !paths.every((p) => diffPaths.has(p)))
    uncertain('diff-set-mismatch', {
      diff: [...diffPaths].sort(),
    });
  for (const path of paths) {
    const type = types.get(path);
    let digest = null;
    if (type !== 'D') {
      try {
        const bytes = readFileSync(join(tree, path));
        digest = createHash('sha256').update(bytes).digest('hex');
      } catch {
        uncertain('digest-unavailable', { path });
      }
    }
    recorded.push({ path, type, digest });
  }
}

console.log(
  JSON.stringify({
    stage: 'committed',
    head: commitHash,
    parent,
    messageSha256: createHash('sha256').update(message, 'utf8').digest('hex'),
    paths: recorded,
  }),
);
