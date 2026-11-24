import { expect, test } from 'vitest';
import {
  renderGitOutput,
  shellRefusalMessage,
} from '../../dsh/plugins/rdws-access/write-probe.mjs';
import {
  armRequest,
  maxArmedRequests,
} from '../../apps/server/src/modules/native-projects.ts';
import { createWriteCommands } from '../../apps/server/src/modules/write-tool-commands.ts';
import {
  diffNamesProtectedPath,
  outputHead,
  outputPolicy,
  scanOutput,
  scrubOutput,
} from '../../apps/server/src/modules/shell-output-handling.ts';
import { protectedWritePath } from '@rdws/dsh/write-tool-arguments';

// §11.20.27 B segment, the content handling of a write tool output (W18)
// judged on its own: the parent applies it to the whole reassembled output
// before anything is paged, stored or projected; the FD4 projection scans
// every tool result once more with the same function. The shapes are a
// finite heuristic list; the first layer (the Shell profile) is the main
// defence and is judged against the real Seatbelt process in
// local-execution.test.ts and native-shell-git-loopback.test.ts.
const tree = '/Users/dev/runtime/rdws/projects/poc/demands/d/worktrees/app';
const policy = outputPolicy({
  tree,
  runtimeRoot: '/Users/dev/runtime/rdws',
  home: '/Users/dev',
  node: '/opt/node/bin/node',
});

test('§11.20.27 W18 known prefixes are rewritten, the longest first, file:// URLs too', () => {
  const text = [
    'tree=' + tree,
    'file=' + tree + '/sum.test.mjs',
    'url=file://' + tree + '/sum.mjs',
    'runtime=/Users/dev/runtime/rdws/other',
    'home=/Users/dev/.zshrc',
    'node=/opt/node/bin/node',
    'plain=/usr/bin/env',
  ].join('\n');
  const scrubbed = scrubOutput(text, policy);
  expect(scrubbed.text).toBe(
    [
      'tree=.',
      'file=sum.test.mjs',
      'url=file://sum.mjs',
      'runtime=<runtime>/other',
      'home=<home>/.zshrc',
      'node=<node>',
      'plain=/usr/bin/env',
    ].join('\n'),
  );
  expect(scrubbed.prefixes).toBe(6);
  expect(scrubbed.credentials).toBe(0);
  // Nothing of the original prefixes remains, and the scan agrees.
  expect(scanOutput(scrubbed.text, policy)).toEqual({
    prefixes: 0,
    credentials: 0,
  });
  for (const secret of [
    tree,
    '/Users/dev/runtime/rdws',
    '/Users/dev',
    '/opt/node/bin/node',
  ])
    expect(scrubbed.text).not.toContain(secret);
  // The order is longest first: the tree (under the runtime root under the
  // home) is rewritten once, as the tree.
  // Longest first: the tree, the runtime root, the node executable, the
  // home (the shortest).
  expect(policy.prefixes.map(({ value }) => value)).toEqual([
    tree + '/',
    tree,
    '/Users/dev/runtime/rdws',
    '/opt/node/bin/node',
    '/Users/dev',
  ]);
});

test('§11.20.27 W18 credential shapes are masked whole or in their value part; ordinary lines stay', () => {
  const text = [
    'password=hunter2',
    'export API_KEY="sk-0123456789"',
    'private.key: /tmp/id',
    'my_token = abc',
    'credential-provider: none',
    'https://user:pass@example.invalid/x',
    'Authorization: Bearer abc.def.ghi',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIabc',
    '-----END RSA PRIVATE KEY-----',
    'not ok 1 - token refreshes',
    '# Subtest: secret management',
    '  expected: 5',
    'location: ./sum.test.mjs:13:1',
  ].join('\n');
  const scrubbed = scrubOutput(text, policy);
  expect(scrubbed.text).toBe(
    [
      'password=[redacted]',
      'export API_KEY=[redacted]',
      'private.key: [redacted]',
      'my_token = [redacted]',
      'credential-provider: [redacted]',
      'https://[redacted]@example.invalid/x',
      'Authorization: Bearer [redacted]',
      '[redacted private key]',
      'not ok 1 - token refreshes',
      '# Subtest: secret management',
      '  expected: 5',
      'location: ./sum.test.mjs:13:1',
    ].join('\n'),
  );
  expect(scrubbed.credentials).toBe(8);
  for (const secret of [
    'hunter2',
    'sk-0123456789',
    '/tmp/id',
    'user:pass',
    'abc.def.ghi',
    'MIIabc',
  ])
    expect(scrubbed.text).not.toContain(secret);
});

test('§11.20.27 W10 the head of a long output ends at a line end inside the limit, or on a UTF-8 boundary', () => {
  const short = 'ok 1\n';
  expect(outputHead(short, 16)).toEqual({ text: short, from: 5 });
  const lines = 'ab\n'.repeat(10);
  const head = outputHead(lines, 16);
  expect(head.text).toBe('ab\n'.repeat(5));
  expect(head.from).toBe(15);
  expect(lines.slice(head.from)).toBe('ab\n'.repeat(5));
  // One line of multi-byte characters longer than the limit: the cut
  // never breaks a character and the continuation starts at the boundary.
  const wide = '汉'.repeat(20);
  const cut = outputHead(wide, 16);
  expect(Buffer.from(cut.text).length).toBe(15);
  expect(cut.from).toBe(15);
  // The continuation is the rest of the line, byte for byte.
  // Five characters (15 bytes) are the head; the continuation is the
  // other fifteen characters, and the two make the line again.
  expect(cut.text).toBe('汉'.repeat(5));
  expect(wide.slice(cut.text.length)).toBe('汉'.repeat(15));
});

test('§11.20.27 W8 a diff that names a protected location is recognised by its headers', () => {
  expect(
    diffNamesProtectedPath(
      'diff --git a/sum.mjs b/sum.mjs\n--- a/sum.mjs\n+++ b/sum.mjs\n',
      protectedWritePath,
    ),
  ).toBe(false);
  expect(
    diffNamesProtectedPath(
      'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n',
      protectedWritePath,
    ),
  ).toBe(true);
  expect(
    diffNamesProtectedPath(
      'diff --git a/certs/server.pem b/certs/server.pem\n',
      protectedWritePath,
    ),
  ).toBe(true);
  expect(
    diffNamesProtectedPath(
      'diff --git a/cfg/.env.local b/cfg/.env.local\n',
      protectedWritePath,
    ),
  ).toBe(true);
  expect(
    diffNamesProtectedPath(
      'rename from keys/deploy.key\nrename to keys/deploy.key.bak\n',
      protectedWritePath,
    ),
  ).toBe(true);
  // A body line that merely mentions the name is not a header.
  expect(
    diffNamesProtectedPath(
      "diff --git a/sum.mjs b/sum.mjs\n+ readFileSync('.env')\n",
      protectedWritePath,
    ),
  ).toBe(false);
});

test('§11.20.27 the platform git result renders with the locked bash vocabulary: exit 0 has no exit marker', () => {
  const base = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 10000,
    stopped: undefined,
  };
  expect(
    renderGitOutput({
      ...base,
      stdout: { text: ' M sum.mjs\n', truncated: false },
      stderr: { text: '', truncated: false },
    }),
  ).toBe(' M sum.mjs\n');
  expect(
    renderGitOutput({
      ...base,
      exitCode: 1,
      stdout: { text: 'fatal: x\n', truncated: false },
      stderr: { text: '', truncated: false },
    }),
  ).toBe('fatal: x\n[exit code: 1]');
  expect(
    renderGitOutput({
      ...base,
      stdout: { text: '', truncated: false },
      stderr: { text: 'warning: y\n', truncated: false },
    }),
  ).toBe('[stderr]\nwarning: y\n');
  expect(
    renderGitOutput({
      ...base,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }),
  ).toBe('(no output)');
  expect(
    renderGitOutput({
      ...base,
      exitCode: 1,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    }),
  ).toBe('out\n[stderr]\nerr\n[exit code: 1]');
  expect(
    renderGitOutput({
      ...base,
      timedOut: true,
      exitCode: null,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }),
  ).toBe('(no output)\n[timed out after 10000ms]');
});

// §11.20.27 repair round 3: the wording, and the bounds, that the journey
// cannot tell apart on its own scale.
test('§11.20.27 A-2 a refused Shell call is worded by what happened, never as not-executed when the command ran', () => {
  expect(
    shellRefusalMessage('bash', {
      outcome: 'refused',
      reason: 'output-policy-unavailable',
      state: 'failed',
    }),
  ).toBe(
    'RDWS bash: the command ran, but its result cannot be given (output-policy-unavailable)',
  );
  expect(
    shellRefusalMessage('bash', {
      outcome: 'unknown',
      state: 'unknown',
      reason: 'the execution could not be confirmed',
    }),
  ).toBe(
    'RDWS bash: the command may have run; its result could not be confirmed (the execution could not be confirmed)',
  );
  expect(
    shellRefusalMessage('git', {
      outcome: 'refused',
      reason: 'protected-diff',
      state: 'failed',
    }),
  ).toBe('RDWS git: the call was not executed (protected-diff)');
  expect(
    shellRefusalMessage('bash', {
      outcome: 'refused',
      state: 'aborted',
      reason: 'not-started',
    }),
  ).toBe('RDWS bash: the call was not executed (not-started)');
});

test('§11.20.27 B-4 the arming tables and the command registry stay at their limits past them', () => {
  const table = new Map<string, number>();
  for (let index = 0; index < maxArmedRequests + 1; index++)
    armRequest(table, 'request-' + index, index);
  expect(table.size).toBe(maxArmedRequests);
  expect(table.has('request-0')).toBe(false);
  expect(table.has('request-32')).toBe(true);
  expect(() => armRequest(table, 'request-32', 0)).toThrow('already armed');
  // The command registry: a registration per write generation, the oldest
  // gone past 64.
  const packageJson = Buffer.from(
    JSON.stringify({ scripts: { test: 'node x.test.mjs' } }),
  );
  const commands = createWriteCommands({
    readWorktreeBytes: async () => ({ sha256: 'sha', bytes: packageJson }),
  } as never);
  const scope = {
    projectId: 'p',
    requirementId: 'r',
    sessionId: 's',
    who: { userId: 'u', authSessionId: 'a' },
  };
  for (let index = 0; index < 65; index++)
    void commands.confirm(scope, 'generation-' + index, 'app');
  return Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      commands.confirm(scope, 'generation-' + index, 'app'),
    ),
  ).then(() => {
    expect(commands.size()).toBe(64);
    expect(commands.registered('generation-0')).toBeUndefined();
    expect(commands.registered('generation-64')).toMatchObject({
      command: 'node x.test.mjs',
    });
  });
});
