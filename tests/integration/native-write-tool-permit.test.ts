import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  createWriteCommands,
  parseTestCommand,
} from '../../apps/server/src/modules/write-tool-commands.ts';
import { judgeWriteReceipts } from '../../apps/server/src/modules/native-write-tool-job.ts';
import {
  prepareMainModelBody,
  toolDefinitions,
  type ToolDefinition,
  type WriteToolProjection,
} from '../../apps/server/src/modules/model-egress-policy.ts';
import {
  editStringLimit,
  literalEdit,
  protectedWritePath,
  shellCommandPattern,
  writeContentLimit,
  writePermitEnvelopeBytes,
  writeToolArguments,
  writeToolPath,
  writeToolNames,
} from '@rdws/dsh/write-tool-arguments';
import { readSegmentPath } from '@rdws/dsh/read-tool-arguments';

// §11.20.27 A segment, W1 permit shape and the shape counterexamples of R7,
// R8 and R13, judged by the one shared function the Host probe, the parent
// permit and the FD4 body policy call: a tool is permitted only when its
// name, key set, path rule, byte limits, registered command and operation
// enum are all exact. File byte arithmetic (zero match, over-limit targets,
// receipts) is exercised against the real T06 executor in
// local-execution.test.ts; here the argument shape is the subject.
const registered = (command: string) => command === 'node sum.test.mjs';

test('§11.20.27 W1 the four write tools are permitted only in their exact shape', () => {
  expect(writeToolNames).toEqual(['edit', 'write', 'bash', 'git']);
  expect(
    writeToolArguments('edit', {
      file_path: 'src/sum.mjs',
      old_string: 'return a + b',
      new_string: 'return a - b',
    }),
  ).toBe(true);
  expect(
    writeToolArguments('edit', {
      file_path: 'src/sum.mjs',
      old_string: 'x',
      new_string: '',
      replace_all: true,
    }),
  ).toBe(true);
  expect(
    writeToolArguments('write', {
      file_path: 'sum.test.mjs',
      content: "import test from 'node:test';\n",
    }),
  ).toBe(true);
  // An empty content is a legitimate write of an empty file.
  expect(
    writeToolArguments('write', { file_path: 'empty.txt', content: '' }),
  ).toBe(true);
  expect(
    writeToolArguments(
      'bash',
      { command: 'node sum.test.mjs', description: 'Run the sum test' },
      registered,
    ),
  ).toBe(true);
  expect(writeToolArguments('git', { operation: 'status' })).toBe(true);
  expect(writeToolArguments('git', { operation: 'diff' })).toBe(true);
  // The byte limits of the plan.
  expect(
    writeToolArguments('edit', {
      file_path: 'a.mjs',
      old_string: 'a'.repeat(editStringLimit),
      new_string: 'b',
    }),
  ).toBe(true);
  expect(
    writeToolArguments('edit', {
      file_path: 'a.mjs',
      old_string: 'a'.repeat(editStringLimit + 1),
      new_string: 'b',
    }),
  ).toBe(false);
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: 'c'.repeat(writeContentLimit),
    }),
  ).toBe(true);
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: 'c'.repeat(writeContentLimit + 1),
    }),
  ).toBe(false);
  // Limits are UTF-8 bytes, not characters.
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: '汉'.repeat(writeContentLimit / 3),
    }),
  ).toBe(true);
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: '汉'.repeat(writeContentLimit / 3 + 1),
    }),
  ).toBe(false);
});

test('§11.20.27 R7 Edit refuses traversal, absolute paths, .git, segments, protected locations and no-op edits', () => {
  const edit = (file_path: string, extra: Record<string, unknown> = {}) =>
    writeToolArguments('edit', {
      file_path,
      old_string: 'a',
      new_string: 'b',
      ...extra,
    });
  for (const path of [
    '../outside.mjs',
    'src/../sum.mjs',
    './sum.mjs',
    '/abs/sum.mjs',
    'src//sum.mjs',
    'src/sum.mjs/',
    '.git/config',
    'src/.GIT/config',
    '.Git/HEAD',
    readSegmentPath + '0f0e0d0c-0b0a-4988-8776-655443322110',
    '.env',
    'cfg/.env.production',
    'deploy/.Env.LOCAL',
    'deploy/Model.ENV',
    'model.env',
    'secrets/.credentials.yml',
    'certs/.credentials.yaml',
    'keys/server.pem',
    'keys/server.KEY',
    'id_rsa.key',
    '.ssh/id_ed25519',
    'home/.netrc',
    'home/.npmrc',
    'home/.git-credentials',
    '.gnupg/secring.gpg',
    'a\\b',
    'a\u0000b',
    'a\nb',
    'a\u007fb',
    // Unicode Cf: zero-width space and bidi mark (the T06 rule).
    'a\u200bb',
    'a\u202eb',
    'x'.repeat(1025),
    '   ',
    '',
  ])
    expect(edit(path), path).toBe(false);
  // A legitimate path that merely contains a protected-looking affix.
  expect(edit('src/environment.mjs')).toBe(true);
  expect(edit('docs/keys.md')).toBe(true);
  expect(edit('a.test.mjs/child')).toBe(true);
  // old_string must be non-empty and differ from new_string.
  expect(edit('a.mjs', { old_string: '' })).toBe(false);
  expect(edit('a.mjs', { new_string: 'a' })).toBe(false);
  expect(edit('a.mjs', { replace_all: 'yes' })).toBe(false);
  // A present key must carry a boolean; an explicit undefined is not JSON.
  expect(edit('a.mjs', { replace_all: undefined })).toBe(false);
  expect(edit('a.mjs', { replace_all: false })).toBe(true);
  expect(edit('a.mjs', { content: 'x' })).toBe(false);
  expect(protectedWritePath('X/.ENV.local')).toBe(true);
  expect(protectedWritePath('X/config.json')).toBe(false);
});

test('§11.20.27 R8 Write refuses protected locations, over-limit content and extra keys', () => {
  const write = (file_path: string, content = 'x') =>
    writeToolArguments('write', { file_path, content });
  for (const path of [
    '.env',
    '.env.local',
    'cfg/model.env',
    'a/.credentials.yml',
  ])
    expect(write(path), path).toBe(false);
  expect(write('a.txt', 'x'.repeat(writeContentLimit + 1))).toBe(false);
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: 'x',
      old_string: 'y',
    }),
  ).toBe(false);
  expect(writeToolArguments('write', { file_path: 'a.txt' })).toBe(false);
  expect(writeToolArguments('write', { content: 'x', file_path: '' })).toBe(
    false,
  );
});

test('§11.20.27 R13 FD3 and FD4 shape counterexamples: extra keys, wrong tool name, unregistered command, free operation', () => {
  // Extra keys, including the ones the locked bash definition knows.
  for (const extra of [
    { timeoutMs: 1000 },
    { workdir: 'src' },
    { run_in_background: true },
    { sandbox_permissions: 'danger-full-access' },
    { justification: 'x' },
    { file_path: 'x' },
  ])
    expect(
      writeToolArguments(
        'bash',
        { command: 'node sum.test.mjs', description: 'Run', ...extra },
        registered,
      ),
      JSON.stringify(extra),
    ).toBe(false);
  // Only the character-identical registered command.
  expect(shellCommandPattern.test('node sum.test.mjs')).toBe(true);
  for (const command of [
    'node other.test.mjs',
    'node ./sum.test.mjs',
    'node a/sum.test.mjs',
    'node --test sum.test.mjs',
    'node sum.test.mjs --verbose',
    'node sum.test.mjs | cat',
    'node sum.test.mjs > out',
    'cd x && node sum.test.mjs',
    'pnpm test',
    'git status',
    ' node sum.test.mjs',
    'node sum.test.mjs ',
    'node sum.test.mjs\n',
  ])
    expect(
      writeToolArguments('bash', { command, description: 'Run' }, registered),
      command,
    ).toBe(false);
  // Without a registration nothing is registered.
  expect(
    writeToolArguments('bash', {
      command: 'node sum.test.mjs',
      description: 'Run',
    }),
  ).toBe(false);
  expect(
    writeToolArguments('bash', {
      command: 'node sum.test.mjs',
      description: '   ',
    }),
  ).toBe(false);
  // Git has no free parameter and no other operation.
  for (const operation of [
    'head',
    'add',
    'commit',
    'status --porcelain=v1',
    'STATUS',
    '',
  ])
    expect(writeToolArguments('git', { operation }), operation).toBe(false);
  expect(writeToolArguments('git', { operation: 'diff', path: '.' })).toBe(
    false,
  );
  expect(writeToolArguments('git', ['status'])).toBe(false);
  // Wrong or undeclared tool names, non-objects and arrays.
  for (const name of [
    'read',
    'apply_patch',
    'Edit',
    'WRITE',
    'rdws_authority_probe',
    undefined,
    '',
  ])
    expect(
      writeToolArguments(name, { file_path: 'a', content: 'b' }),
      String(name),
    ).toBe(false);
  expect(writeToolArguments('write', 'x')).toBe(false);
  expect(writeToolArguments('write', ['a'])).toBe(false);
  expect(writeToolArguments('write', null)).toBe(false);
  expect(writeToolPath(undefined)).toBe(false);
  expect(writeToolPath(7)).toBe(false);
  // A-5: a lone surrogate in any text argument is refused by the shared
  // shape, before a permit; a well-formed pair is not.
  expect(writeToolPath('a\ud800b')).toBe(false);
  expect(
    writeToolArguments('write', { file_path: 'a.txt', content: 'x\ud800' }),
  ).toBe(false);
  expect(
    writeToolArguments('write', {
      file_path: 'a.txt',
      content: 'x\ud834\udd1e',
    }),
  ).toBe(true);
  expect(
    writeToolArguments('edit', {
      file_path: 'a.txt',
      old_string: '\udfff',
      new_string: 'b',
    }),
  ).toBe(false);
  expect(
    writeToolArguments('bash', {
      command: 'node a\ud800.test.mjs',
      description: 'Run',
    }),
  ).toBe(false);
  expect(
    writeToolArguments('bash', {
      command: 'node a.test.mjs',
      description: 'Run \ud800',
    }),
  ).toBe(false);
});

const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const line = (value: unknown) => JSON.stringify(value) + '\n';

test('§11.20.27 W5 the parent judges the two receipts against its own derivation of the after bytes', () => {
  const first = Buffer.from('export const sum = (a, b) => a - b;\n');
  const second = Buffer.from('export const sum = (a, b) => a + b;\n');
  const write = (text: string) =>
    ({
      tool: 'file',
      operation: 'write',
      path: 'sum.mjs',
      text,
      receipt: true,
    }) as const;
  const applied = (
    status: string,
    exitCode: number | null,
    stop = 'confirmed',
  ) => ({ status, exitCode, stop });
  // Write of a new file.
  expect(
    judgeWriteReceipts(
      write(second.toString()),
      applied('ok', 0),
      Buffer.from(
        line({ kind: 'before', existed: false, size: 0, bytes: '' }) +
          line({
            kind: 'after',
            existed: false,
            created: true,
            size: second.length,
            sha256: sha(second),
          }),
      ),
    ),
  ).toEqual({
    kind: 'applied',
    existed: false,
    created: true,
    before: null,
    after: second,
  });
  // Write over an existing file.
  expect(
    judgeWriteReceipts(
      write(second.toString()),
      applied('ok', 0),
      Buffer.from(
        line({
          kind: 'before',
          existed: true,
          size: first.length,
          sha256: sha(first),
          bytes: first.toString('base64'),
        }) +
          line({
            kind: 'after',
            existed: true,
            created: false,
            size: second.length,
            sha256: sha(second),
          }),
      ),
    ),
  ).toMatchObject({
    kind: 'applied',
    existed: true,
    created: false,
    before: first,
    after: second,
  });
  // Edit: the after bytes come from the bytes before and the arguments,
  // never from the worker; the replacement count must agree.
  const edit = {
    tool: 'file',
    operation: 'edit',
    path: 'sum.mjs',
    old_string: 'a - b',
    new_string: 'Number(a) - Number(b)',
    replace_all: false,
  } as const;
  const edited = Buffer.from(
    first.toString().replace('a - b', 'Number(a) - Number(b)'),
  );
  const editReceipts = (replacements: unknown, after: Buffer = edited) =>
    Buffer.from(
      line({
        kind: 'before',
        existed: true,
        size: first.length,
        sha256: sha(first),
        bytes: first.toString('base64'),
      }) +
        line({
          kind: 'after',
          existed: true,
          created: false,
          size: after.length,
          sha256: sha(after),
          replacements,
        }),
    );
  expect(
    judgeWriteReceipts(edit, applied('ok', 0), editReceipts(1)),
  ).toMatchObject({
    kind: 'applied',
    existed: true,
    replacements: 1,
    before: first,
    after: edited,
  });
  expect(
    judgeWriteReceipts(edit, applied('ok', 0), editReceipts(2)),
  ).toMatchObject({ kind: 'unknown' });
  // A digest that differs from the derivation is never a success.
  expect(
    judgeWriteReceipts(edit, applied('ok', 0), editReceipts(1, second)),
  ).toMatchObject({ kind: 'unknown' });
  expect(
    judgeWriteReceipts(
      write(second.toString()),
      applied('ok', 0),
      Buffer.from(
        line({
          kind: 'before',
          existed: true,
          size: first.length,
          sha256: sha(second),
          bytes: first.toString('base64'),
        }) +
          line({
            kind: 'after',
            existed: true,
            created: false,
            size: second.length,
            sha256: sha(second),
          }),
      ),
    ),
  ).toMatchObject({ kind: 'unknown' });
  expect(
    judgeWriteReceipts(
      write(second.toString()),
      applied('ok', 0),
      Buffer.from(
        line({
          kind: 'before',
          existed: true,
          size: first.length + 1,
          sha256: sha(first),
          bytes: first.toString('base64'),
        }) +
          line({
            kind: 'after',
            existed: true,
            created: false,
            size: second.length,
            sha256: sha(second),
          }),
      ),
    ),
  ).toMatchObject({ kind: 'unknown' });
});

test('§11.20.27 R20 a missing receipt after the rename is an unknown result, never a success', () => {
  const write = {
    tool: 'file',
    operation: 'write',
    path: 'sum.mjs',
    text: 'x',
    receipt: true,
  } as const;
  const before = line({
    kind: 'before',
    existed: true,
    size: 1,
    sha256: sha('y'),
    bytes: Buffer.from('y').toString('base64'),
  });
  for (const result of [
    { status: 'ok', exitCode: 0, stop: 'confirmed' },
    { status: 'failed', exitCode: 1, stop: 'confirmed' },
  ])
    expect(
      judgeWriteReceipts(write, result, Buffer.from(before)),
      JSON.stringify(result),
    ).toEqual({
      kind: 'unknown',
      reason: 'the receipt after the write is missing',
    });
  // Any outcome that is not a confirmed, receipt-backed success is unknown:
  // a success without receipts, a malformed receipt, an aborted, timed-out
  // or output-limited run, and a run whose stop is unconfirmed.
  expect(
    judgeWriteReceipts(
      write,
      { status: 'ok', exitCode: 0, stop: 'confirmed' },
      Buffer.alloc(0),
    ),
  ).toMatchObject({ kind: 'unknown' });
  expect(
    judgeWriteReceipts(
      write,
      { status: 'ok', exitCode: 0, stop: 'confirmed' },
      Buffer.from('not json\n'),
    ),
  ).toMatchObject({ kind: 'unknown' });
  // A-4: a run the platform stopped with the stop confirmed and no first
  // receipt wrote nothing — a definite refusal; other endings stay unknown.
  for (const status of ['aborted', 'timeout'])
    expect(
      judgeWriteReceipts(
        write,
        { status, exitCode: null, stop: 'confirmed' },
        Buffer.alloc(0),
      ),
      status,
    ).toEqual({ kind: 'refused', reason: 'aborted', exitCode: null });
  for (const status of ['output-limit', 'unavailable'])
    expect(
      judgeWriteReceipts(
        write,
        { status, exitCode: null, stop: 'confirmed' },
        Buffer.alloc(0),
      ),
      status,
    ).toMatchObject({ kind: 'unknown' });
  expect(
    judgeWriteReceipts(
      write,
      { status: 'ok', exitCode: 0, stop: 'unconfirmed' },
      Buffer.alloc(0),
    ),
  ).toMatchObject({ kind: 'unknown' });
  // Three receipts are not a success either.
  expect(
    judgeWriteReceipts(
      write,
      { status: 'ok', exitCode: 0, stop: 'confirmed' },
      Buffer.from(before + before + before),
    ),
  ).toMatchObject({ kind: 'unknown' });
});

test('§11.20.27 W5 a refusal before the first receipt is a definite zero write; otherwise it is unknown', () => {
  const edit = {
    tool: 'file',
    operation: 'edit',
    path: 'sum.mjs',
    old_string: 'a',
    new_string: 'b',
    replace_all: false,
  } as const;
  // No receipt and a nonzero exit: the worker never reached its rename.
  for (const [exitCode, reason] of [
    [3, 'limit'],
    [4, 'not-utf8'],
    [5, 'not-found'],
    [6, 'ambiguous'],
    [7, 'invalid'],
    [1, 'file'],
  ] as const)
    expect(
      judgeWriteReceipts(
        edit,
        { status: 'failed', exitCode, stop: 'confirmed' },
        Buffer.alloc(0),
      ),
      String(exitCode),
    ).toEqual({
      kind: 'refused',
      reason,
      exitCode,
    });
  expect(
    judgeWriteReceipts(
      edit,
      { status: 'rejected', exitCode: null, stop: 'not-started' },
      Buffer.alloc(0),
    ),
  ).toEqual({
    kind: 'refused',
    reason: 'rejected',
    exitCode: null,
  });
  expect(
    judgeWriteReceipts(
      edit,
      { status: 'aborted', exitCode: null, stop: 'not-started' },
      Buffer.alloc(0),
    ),
  ).toEqual({
    kind: 'refused',
    reason: 'not-started',
    exitCode: null,
  });
});

test('§11.20.27 the literal edit arithmetic does not overlap and is the same on both sides', () => {
  expect(literalEdit('aaa', { old_string: 'aa', new_string: 'b' })).toEqual({
    count: 1,
    after: 'ba',
  });
  expect(literalEdit('abab', { old_string: 'ab', new_string: 'ba' })).toEqual({
    count: 2,
    after: 'baba',
  });
  expect(literalEdit('汉汉', { old_string: '汉', new_string: '' })).toEqual({
    count: 2,
    after: '',
  });
  expect(
    literalEdit('a\r\nb', { old_string: 'a\nb', new_string: 'x' }),
  ).toEqual({ count: 0, after: 'a\r\nb' });
});

test('§11.20.27 W6 the command set is registered per write generation and compared with the current package.json', async () => {
  const packageJson = {
    'sum.test.mjs': JSON.stringify({ scripts: { test: 'node sum.test.mjs' } }),
  };
  let text = packageJson['sum.test.mjs']!;
  let fail = false;
  const broker = {
    readWorktreeBytes: async () => {
      if (fail) throw new Error('unreadable');
      return { sha256: sha(text), bytes: Buffer.from(text) };
    },
  };
  const commands = createWriteCommands(broker as never);
  const scope = {
    projectId: 'poc',
    requirementId: 'r',
    sessionId: 's',
    who: { userId: 'u', authSessionId: 'a' },
  };
  // Nothing is registered for a generation before its confirmation.
  expect(await commands.verify(scope, 'g1', 'app')).toBeUndefined();
  expect(
    parseTestCommand('{"scripts":{"test":"node --test x.test.mjs"}}'),
  ).toBeUndefined();
  expect(
    parseTestCommand('{"scripts":{"test":"node a/b.test.mjs"}}'),
  ).toBeUndefined();
  expect(
    parseTestCommand('{"scripts":{"test":"node sum.test.mjs --verbose"}}'),
  ).toBeUndefined();
  expect(
    parseTestCommand('{"scripts":{"test":"node ./sum.test.mjs"}}'),
  ).toBeUndefined();
  expect(parseTestCommand('{"scripts":{"test":"pnpm test"}}')).toBeUndefined();
  expect(parseTestCommand('{"scripts":{}}')).toBeUndefined();
  expect(parseTestCommand('not json')).toBeUndefined();
  await commands.confirm(scope, 'g1', 'app');
  expect(commands.registered('g1')).toEqual({
    command: 'node sum.test.mjs',
    sha256: sha(text),
    repositoryId: 'app',
  });
  expect(await commands.verify(scope, 'g1', 'app')).toMatchObject({
    command: 'node sum.test.mjs',
  });
  // Another repository is not this registration.
  expect(await commands.verify(scope, 'g1', 'second')).toBeUndefined();
  // R17: the file changes within the generation (even to another matching
  // name): the digest differs, zero permit.
  text = JSON.stringify({ scripts: { test: 'node other.test.mjs' } });
  expect(await commands.verify(scope, 'g1', 'app')).toBeUndefined();
  // A new generation registers again, against the file as it is now.
  await commands.confirm(scope, 'g2', 'app');
  expect(await commands.verify(scope, 'g2', 'app')).toMatchObject({
    command: 'node other.test.mjs',
    sha256: sha(text),
  });
  // The old registration never carries over.
  expect(await commands.verify(scope, 'g1', 'app')).toBeUndefined();
  // A form outside the whitelist registers nothing for any generation.
  text = JSON.stringify({ scripts: { test: 'node --test x.test.mjs' } });
  await commands.confirm(scope, 'g3', 'app');
  expect(commands.registered('g3')).toBeUndefined();
  expect(await commands.verify(scope, 'g3', 'app')).toBeUndefined();
  // An unreadable file at confirmation or at verification is zero permit.
  text = packageJson['sum.test.mjs']!;
  fail = true;
  await commands.confirm(scope, 'g4', 'app');
  expect(commands.registered('g4')).toBeUndefined();
  fail = false;
  await commands.confirm(scope, 'g5', 'app');
  fail = true;
  expect(await commands.verify(scope, 'g5', 'app')).toBeUndefined();
  fail = false;
  // The verification read is bounded by the permit: its liveness ends it.
  let live = true;
  expect(
    await commands.verify(scope, 'g5', 'app', () => {
      if (!live) throw new Error('expired');
    }),
  ).toMatchObject({ command: 'node sum.test.mjs' });
  live = false;
  expect(
    await commands.verify(scope, 'g5', 'app', () => {
      if (!live) throw new Error('expired');
    }),
  ).toBeUndefined();
});

const editDefinition: ToolDefinition = {
  name: 'edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
};
const readDefinition: ToolDefinition = {
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
};
const writeDefinition: ToolDefinition = {
  name: 'write',
  description: 'Create or fully replace a UTF-8 text file.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
};

test('§11.20.27 W9 the FD4 projection accepts exactly the registered declarations and adjacent single-call exchanges', () => {
  // The definitions must be the armed set, in the order the Host
  // serializes it (by name), whatever order they arrive in.
  expect(
    toolDefinitions(
      [editDefinition, readDefinition, writeDefinition],
      ['read', 'edit', 'write'],
    ),
  ).toEqual([editDefinition, readDefinition, writeDefinition]);
  expect(
    toolDefinitions(
      [readDefinition, editDefinition, writeDefinition],
      ['read', 'edit', 'write'],
    ),
  ).toBeUndefined();
  expect(
    toolDefinitions(
      [editDefinition, readDefinition],
      ['read', 'edit', 'write'],
    ),
  ).toBeUndefined();
  expect(
    toolDefinitions(
      [editDefinition, editDefinition, writeDefinition],
      ['read', 'edit', 'write'],
    ),
  ).toBeUndefined();
  expect(
    toolDefinitions([{ ...editDefinition, execute() {} }], ['edit']),
  ).toBeUndefined();
  expect(
    toolDefinitions(
      [{ ...editDefinition, description: 'x'.repeat(20_000) }],
      ['edit'],
    ),
  ).toBeUndefined();
  const projection = {
    kind: 'tools' as const,
    tools: [editDefinition, readDefinition, writeDefinition],
    segment: () => false,
    redaction: { prefixes: [] },
    redactions: 0,
  };
  const declaration = (definition: ToolDefinition) => ({
    type: 'function',
    function: definition,
  });
  const call = (id: string, name: string, args: unknown) => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const result = (id: string, content: string) => ({
    role: 'tool',
    tool_call_id: id,
    content,
  });
  const body = (tools: unknown, messages: unknown[]) =>
    Buffer.from(JSON.stringify({ model: 'm', messages, stream: true, tools }));
  const accepted = (
    tools: unknown,
    messages: unknown[],
    policy: WriteToolProjection = projection,
  ) =>
    prepareMainModelBody(
      body(tools, messages),
      'm',
      undefined,
      undefined,
      policy,
    );
  const tools = [editDefinition, readDefinition, writeDefinition].map(
    declaration,
  );
  // The journey: text, one call, its own result, one call, its own result.
  const journey = [
    { role: 'user', content: 'run' },
    call('a', 'write', { file_path: 'greet.mjs', content: 'x' }),
    result('a', 'Created file'),
    call('b', 'edit', {
      file_path: 'greet.mjs',
      old_string: 'x',
      new_string: 'y',
    }),
    result('b', 'updated'),
    { role: 'assistant', content: 'done' },
  ];
  expect(accepted(tools, journey)).toBeDefined();
  // An armed run always carries its declared set; without it the body is
  // refused (the same plain body is fine for a run without write tools).
  expect(
    accepted(undefined, [{ role: 'user', content: 'run' }]),
  ).toBeUndefined();
  expect(
    prepareMainModelBody(
      body(undefined, [{ role: 'user', content: 'run' }]),
      'm',
    ),
  ).toBeDefined();
  // R13: every shape counterexample is refused before a connection opens.
  const refused = (messages: unknown[]) =>
    expect(accepted(tools, messages)).toBeUndefined();
  // A word-for-word different declaration.
  expect(
    prepareMainModelBody(
      body(
        [
          declaration({ ...editDefinition, description: 'Edit.' }),
          declaration(readDefinition),
          declaration(writeDefinition),
        ],
        journey,
      ),
      'm',
      undefined,
      undefined,
      projection,
    ),
  ).toBeUndefined();
  expect(
    prepareMainModelBody(
      body([...tools, declaration(writeDefinition)], journey),
      'm',
      undefined,
      undefined,
      projection,
    ),
  ).toBeUndefined();
  // An extra key in a history call, a wrong tool name, an undeclared name.
  refused([
    { role: 'user', content: 'run' },
    call('a', 'write', {
      file_path: 'greet.mjs',
      content: 'x',
      old_string: 'y',
    }),
    result('a', 'Created file'),
  ]);
  refused([
    { role: 'user', content: 'run' },
    call('a', 'Write', { file_path: 'greet.mjs', content: 'x' }),
    result('a', 'Created file'),
  ]);
  refused([
    { role: 'user', content: 'run' },
    call('a', 'apply_patch', { input: 'x' }),
    result('a', 'ok'),
  ]);
  // A session that lost the write generation: its later run declares read
  // alone, yet the history of its earlier write calls — the projection of
  // results that already happened — is still accepted by exact shape.
  const lostGeneration = {
    ...projection,
    tools: [readDefinition],
  };
  expect(
    prepareMainModelBody(
      body([declaration(readDefinition)], journey),
      'm',
      undefined,
      undefined,
      lostGeneration,
    ),
  ).toBeDefined();
  // A bash call in that history is judged by its closed form only.
  expect(
    prepareMainModelBody(
      body(
        [declaration(readDefinition)],
        [
          { role: 'user', content: 'run' },
          call('a', 'bash', {
            command: 'node sum.test.mjs',
            description: 'Run',
          }),
          result('a', 'ok 1'),
        ],
      ),
      'm',
      undefined,
      undefined,
      lostGeneration,
    ),
  ).toBeDefined();
  refused([
    { role: 'user', content: 'run' },
    call('a', 'bash', {
      command: 'node sum.test.mjs | cat',
      description: 'Run',
    }),
    result('a', 'ok 1'),
  ]);
  refused([
    { role: 'user', content: 'run' },
    call('a', 'write', { file_path: '../x', content: 'x' }),
    result('a', 'Created file'),
  ]);
  // Rewritten body: a result that does not belong to the preceding call.
  refused([
    { role: 'user', content: 'run' },
    call('a', 'write', { file_path: 'greet.mjs', content: 'x' }),
    result('b', 'Created file'),
  ]);
  // A non-adjacent result.
  refused([
    { role: 'user', content: 'run' },
    call('a', 'write', { file_path: 'greet.mjs', content: 'x' }),
    { role: 'user', content: 'in between' },
    result('a', 'Created file'),
  ]);
  // Two calls in one assistant message (parallel calls).
  refused([
    { role: 'user', content: 'run' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        ...call('a', 'write', { file_path: 'greet.mjs', content: 'x' })
          .tool_calls!,
        ...call('b', 'edit', {
          file_path: 'greet.mjs',
          old_string: 'x',
          new_string: 'y',
        }).tool_calls!,
      ],
    },
    result('a', 'Created file'),
    result('b', 'updated'),
  ]);
  // A segment read in the history is judged by its shape: a well-formed
  // identifier is the projection of a result the session received (its
  // registration may have expired), a malformed one is refused.
  expect(
    accepted(tools, [
      { role: 'user', content: 'run' },
      call('a', 'read', {
        file_path: '.rdws-read/0f0e0d0c-0b0a-4988-8776-655443322110',
      }),
      result('a', 'x'),
    ]),
  ).toBeDefined();
  refused([
    { role: 'user', content: 'run' },
    call('a', 'read', { file_path: '.rdws-read/not-a-segment' }),
    result('a', 'x'),
  ]);
  // Without the write projection the same body is not a Read-only body.
  expect(prepareMainModelBody(body(tools, journey), 'm')).toBeUndefined();
  // A-3: the positive control of the backstop. A tool result that carries a
  // host path and a credential shape despite the parent's handling is
  // masked in the outgoing body and counted; nothing of it leaves.
  const home = '/Users/dev';
  const leaky = {
    ...projection,
    redaction: { prefixes: [{ value: home, replacement: '<home>' }] },
    countRedaction: () => {
      counted++;
    },
  };
  let counted = 0;
  const withLeak = [
    { role: 'user', content: 'run' },
    call('a', 'bash', { command: 'node sum.test.mjs', description: 'Run' }),
    result('a', 'location: ' + home + '/tree/x.test.mjs\npassword=hunter2\n'),
  ];
  const masked = accepted(tools, withLeak, leaky);
  expect(masked).toBeDefined();
  const maskedText = masked!.toString('utf8');
  expect(maskedText).not.toContain(home);
  expect(maskedText).not.toContain('hunter2');
  expect(maskedText).toContain('location: <home>/tree/x.test.mjs');
  expect(maskedText).toContain('password=[redacted]');
  expect(counted).toBe(1);
  // A projection without a policy never lets a tool result through
  // unscanned: the body is refused instead.
  expect(
    accepted(tools, withLeak, { ...projection, redaction: undefined as never }),
  ).toBeUndefined();
  // With nothing to mask the count stays at zero and the body is intact.
  counted = 0;
  expect(accepted(tools, journey, leaky)).toBeDefined();
  expect(counted).toBe(0);
});

test('§11.20.27 the permit body is judged in its actual JSON encoding', () => {
  const plain = writePermitEnvelopeBytes('write', {
    file_path: 'a.txt',
    content: 'a'.repeat(1000),
  });
  const control = writePermitEnvelopeBytes('write', {
    file_path: 'a.txt',
    content: '\u0000'.repeat(1000),
  });
  // A control character takes six bytes once encoded.
  expect(control - plain).toBe(5000);
  expect(plain).toBeLessThan(64 * 1024);
});
