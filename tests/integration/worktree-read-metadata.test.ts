import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

// §11.20.26 extension points of the trusted read service, driven at the
// handoff seam with the bounded snapshot worker replaced by in-memory files:
// the metadata (stat) operation and its single snapshot K, the long-line
// segment registration and its oracle, and the liveness every page hands to
// the window's armed callback.

const files = vi.hoisted(() => new Map<string, Buffer>());

vi.mock('@rdws/dsh/execution', async (original) => ({
  ...(await original<typeof import('@rdws/dsh/execution')>()),
  readMacosWorktree: async (
    _scope: () => Promise<unknown>,
    path: string,
    options: {
      signal?: AbortSignal;
      authorizeStart?: (start: () => void) => Promise<void>;
    },
  ) => {
    const bytes = files.get(path);
    const start = () => void bytes;
    if (options.signal?.aborted)
      return { runId: 'fixture', status: 'aborted', marker: 'none' };
    if (options.authorizeStart) await options.authorizeStart(start);
    if (!bytes) return { runId: 'fixture', status: 'rejected', marker: 'none' };
    return {
      runId: 'fixture',
      status: 'ok',
      stop: 'confirmed',
      exitCode: 0,
      bytes,
      marker: 'none',
    };
  },
}));

const { createWorktreeReads, readSegmentPrefix } =
  await import('../../apps/server/src/modules/worktree-reads.ts');
type Reads = ReturnType<typeof createWorktreeReads>;
type Scope = Parameters<Reads['read']>[0];
const { maxSnapshotBytes } = await import('@rdws/dsh/execution');

const pageBytes = 16 * 1024;
const repositories = [
  {
    repositoryId: 'app',
    baseCommit: '',
    baselineRef: '',
    sourceBinding: '',
    branch: '',
    worktreePath: '',
    gitStorePath: '',
  },
];
const scope: Scope = {
  projectId: 'poc',
  requirementId: 'demand',
  sessionId: 'session',
  who: { userId: 'user', authSessionId: 'login' },
};
const other: Scope = { ...scope, sessionId: 'other-session' };

function fixture() {
  let plan = repositories;
  let validBefore = Infinity;
  let authority: ((scope: Scope) => void) | undefined;
  const frames: {
    snapshotId: string;
    body: Buffer;
    expiresAt: number;
    aborted: boolean;
  }[] = [];
  const worktrees = {
    readExecutionScope: async () => ({ tree: '/tree' }),
  } as unknown as Parameters<typeof createWorktreeReads>[0];
  const reads = createWorktreeReads(
    worktrees,
    async () => ({ repositories: plan, validBefore }),
    (current) => authority?.(current),
    async (input) => {
      frames.push({
        snapshotId: input.snapshotId,
        body: input.body,
        expiresAt: input.expiresAt,
        aborted: input.live.signal.aborted,
      });
    },
  );
  return {
    reads,
    frames,
    setPlan: (next: typeof plan) => (plan = next),
    setValidBefore: (next: number) => (validBefore = next),
    setAuthority: (next: typeof authority) => (authority = next),
  };
}

const file = (name: string, text: string | Buffer) =>
  files.set(name, Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));

describe('§11.20.26 stat metadata operation: one snapshot K, zero pages', () => {
  test('a single-page file: stat sends no page, the one registered cursor returns the whole page once', async () => {
    file('one.txt', 'single page');
    const { reads, frames } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'one.txt',
    });
    expect(stat).toMatchObject({
      type: 'file',
      size: Buffer.byteLength('single page'),
      sha256: createHash('sha256').update('single page').digest('hex'),
    });
    expect(frames).toHaveLength(0);
    const page = await reads.read(scope, { cursor: stat.cursor });
    expect(page).toMatchObject({
      snapshotId: stat.snapshotId,
      sha256: stat.sha256,
      from: 0,
      through: Buffer.byteLength('single page'),
      truncated: false,
      text: 'single page',
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.snapshotId).toBe(stat.snapshotId);
    expect(frames[0]!.expiresAt).toBe(stat.expiresAt);
  });

  test('a two-page file: stat registers the only snapshot and each page leaves exactly once', async () => {
    const text = 'p'.repeat(pageBytes) + 'é'.repeat(100) + '\n';
    file('large.txt', text);
    const { reads, frames } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'large.txt',
    });
    const first = await reads.read(scope, { cursor: stat.cursor });
    expect(first).toMatchObject({
      from: 0,
      through: pageBytes,
      truncated: true,
    });
    const second = await reads.read(scope, { cursor: first.cursor! });
    expect(second).toMatchObject({
      from: pageBytes,
      through: Buffer.byteLength(text),
      truncated: false,
      text: 'é'.repeat(100) + '\n',
    });
    expect(new Set(frames.map((frame) => frame.snapshotId))).toEqual(
      new Set([stat.snapshotId]),
    );
    expect(frames.map((frame) => frame.body.toString())).toEqual([
      'p'.repeat(pageBytes),
      'é'.repeat(100) + '\n',
    ]);
  });

  test('red variant: the fixture-style stat (a whole read per stat and per readText) sends the first page twice under two snapshots', async () => {
    file('one.txt', 'single page');
    const { reads, frames } = fixture();
    // tests/helpers/native-worktree-read.ts: stat = readWorktree(path),
    // readText = readWorktree(path) again before consuming the first page.
    const stat = await reads.read(scope, {
      repositoryId: 'app',
      path: 'one.txt',
    });
    const text = await reads.read(scope, {
      repositoryId: 'app',
      path: 'one.txt',
    });
    expect(stat.text).toBe(text.text);
    // "每页一次" fails: two page frames for one page, two snapshots.
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((frame) => frame.snapshotId)).size).toBe(2);
  });

  test('stat retains a file within one page; the plain read keeps nothing for it', async () => {
    file('one.txt', 'abc');
    const { reads } = fixture();
    const plain = await reads.read(scope, {
      repositoryId: 'app',
      path: 'one.txt',
    });
    expect(plain.cursor).toBeUndefined();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'one.txt',
    });
    expect(stat.cursor).toBeTruthy();
  });

  test('stat rejects the same shapes as the page read and sends nothing for them', async () => {
    file('one.txt', 'abc');
    const { reads, frames } = fixture();
    for (const request of [
      null,
      'one.txt',
      { repositoryId: 'app' },
      { repositoryId: 'app', path: 'one.txt', extra: 1 },
      { repositoryId: 'app', path: 7 },
      { repositoryId: 'app', path: 'missing.txt' },
    ])
      await expect(
        reads.stat(scope, request as { repositoryId: string; path: string }),
      ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(frames).toHaveLength(0);
  });
});

describe('§11.20.26 long-line segment registration', () => {
  const longLine = 'a'.repeat(2000);
  test('the first dropped character of 1, 2, 3 and 4 bytes: the segment starts at that byte and ends at the line end', async () => {
    const tails = ['b', 'é', '€', '𝄞'];
    const text =
      tails.map((tail) => longLine + tail + ' end').join('\n') + '\nlast';
    file('lines.txt', text);
    for (const [index, tail] of tails.entries()) {
      const { reads, frames } = fixture();
      const stat = await reads.stat(scope, {
        repositoryId: 'app',
        path: 'lines.txt',
      });
      const segment = await reads.segment(scope, {
        snapshotId: stat.snapshotId,
        line: index + 1,
        prefix: longLine,
      });
      expect(segment.segment.startsWith(readSegmentPrefix)).toBe(true);
      const line = longLine + tail + ' end';
      const lineStart = Buffer.byteLength(
        tails
          .slice(0, index)
          .map((item) => longLine + item + ' end')
          .join('\n') + (index ? '\n' : ''),
      );
      expect(segment).toMatchObject({
        from: lineStart + 2000,
        through: lineStart + Buffer.byteLength(line),
        expiresAt: stat.expiresAt,
      });
      const page = await reads.read(scope, {
        cursor: segment.segment.slice(readSegmentPrefix.length),
      });
      expect(page).toMatchObject({
        snapshotId: stat.snapshotId,
        from: lineStart + 2000,
        through: lineStart + Buffer.byteLength(line),
        truncated: false,
        text: tail + ' end',
      });
      expect(frames).toHaveLength(1);
    }
  });

  test('a displayed prefix ending in a lone high surrogate leaves the whole code point to the segment', async () => {
    const line = 'a'.repeat(1999) + '𝄞' + 'tail';
    file('surrogate.txt', line + '\n');
    const { reads } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'surrogate.txt',
    });
    // The locked read truncates at 2000 UTF-16 code units.
    const displayed = line.slice(0, 2000);
    expect(displayed.endsWith('\ud834')).toBe(true);
    const segment = await reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: displayed,
    });
    expect(segment.from).toBe(1999);
    expect(segment.through).toBe(Buffer.byteLength(line));
    expect(
      await reads.read(scope, {
        cursor: segment.segment.slice(readSegmentPrefix.length),
      }),
    ).toMatchObject({
      text: '𝄞tail',
      truncated: false,
    });
  });

  test('CRLF: the line range excludes the terminator and the CR the locked read strips; an unterminated last line ends at the file end', async () => {
    file('crlf.txt', 'first\r\nsecond,last');
    const { reads } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'crlf.txt',
    });
    const first = await reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: 'fir',
    });
    expect(first).toMatchObject({ from: 3, through: 5 });
    expect(
      (
        await reads.read(scope, {
          cursor: first.segment.slice(readSegmentPrefix.length),
        })
      ).text,
    ).toBe('st');
    const second = await reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 2,
      prefix: 'second',
    });
    expect(second).toMatchObject({ from: 13, through: 18 });
    expect(
      (
        await reads.read(scope, {
          cursor: second.segment.slice(readSegmentPrefix.length),
        })
      ).text,
    ).toBe(',last');
  });

  test('BOM bytes belong to the first line and count towards the prefix', async () => {
    file(
      'bom.txt',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc\n')]),
    );
    const { reads } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'bom.txt',
    });
    const segment = await reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: '\ufeffab',
    });
    expect(segment).toMatchObject({ from: 5, through: 6 });
    expect(
      (
        await reads.read(scope, {
          cursor: segment.segment.slice(readSegmentPrefix.length),
        })
      ).text,
    ).toBe('c');
  });

  test('a segment longer than a page continues on 16 KiB UTF-8 boundaries and the parts rejoin the line tail byte for byte', async () => {
    const tail = 'é'.repeat(10_000);
    const line = 'a'.repeat(2001) + tail;
    file('huge.txt', line + '\nafter');
    const { reads, frames } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'huge.txt',
    });
    const segment = await reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: 'a'.repeat(2000),
    });
    let cursor: string | undefined = segment.segment.slice(
      readSegmentPrefix.length,
    );
    const parts: string[] = [];
    const froms: number[] = [];
    for (;;) {
      const page = await reads.read(scope, { cursor: cursor! });
      froms.push(page.from);
      parts.push(page.text);
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    expect(parts.join('')).toBe('a' + tail);
    expect(froms).toEqual([2000, 2000 + pageBytes - 1]);
    expect(frames.every((frame) => frame.snapshotId === stat.snapshotId)).toBe(
      true,
    );
  });

  test('a segment shares the snapshot lifetime and revocation: expired or revoked segments fail and a new grant never revives them', async () => {
    file('lines.txt', longLine + 'tail\n');
    const lab = fixture();
    const stat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    const segment = await lab.reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: longLine,
    });
    const cursor = segment.segment.slice(readSegmentPrefix.length);
    lab.reads.revoke(() => true);
    await expect(lab.reads.read(scope, { cursor })).rejects.toMatchObject({
      statusCode: 403,
    });
    const again = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    expect(again.snapshotId).not.toBe(stat.snapshotId);
    await expect(lab.reads.read(scope, { cursor })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      lab.reads.segment(scope, {
        snapshotId: stat.snapshotId,
        line: 1,
        prefix: longLine,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const fresh = await lab.reads.segment(scope, {
      snapshotId: again.snapshotId,
      line: 1,
      prefix: longLine,
    });
    lab.setValidBefore(Date.now() - 1);
    await expect(
      lab.reads.read(scope, {
        cursor: fresh.segment.slice(readSegmentPrefix.length),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('the segment is bound to the original call, login and own session', async () => {
    file('lines.txt', longLine + 'tail\n');
    const lab = fixture();
    const stat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    const segment = await lab.reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: longLine,
    });
    const cursor = segment.segment.slice(readSegmentPrefix.length);
    await expect(lab.reads.read(other, { cursor })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      lab.reads.segment(other, {
        snapshotId: stat.snapshotId,
        line: 1,
        prefix: longLine,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      lab.reads.read(
        { ...scope, who: { ...scope.who, authSessionId: 'other-login' } },
        { cursor },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    lab.setPlan([{ ...repositories[0]!, repositoryId: 'other' }]);
    await expect(lab.reads.read(scope, { cursor })).rejects.toMatchObject({
      statusCode: 409,
    });
    lab.setPlan(repositories);
    lab.setAuthority(() => {
      throw Object.assign(new Error('revoked'), { statusCode: 403 });
    });
    await expect(lab.reads.read(scope, { cursor })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test('shape, unknown snapshot and a prefix past the line end are refused', async () => {
    file('lines.txt', longLine + 'tail\n');
    const { reads } = fixture();
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    for (const request of [
      null,
      { snapshotId: stat.snapshotId, line: 1 },
      { snapshotId: stat.snapshotId, line: 0, prefix: '' },
      { snapshotId: stat.snapshotId, line: 1.5, prefix: '' },
      { snapshotId: stat.snapshotId, line: 1, prefix: 5 },
      { snapshotId: stat.snapshotId, line: 9, prefix: '' },
    ])
      await expect(
        reads.segment(
          scope,
          request as { snapshotId: string; line: number; prefix: string },
        ),
      ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(
      reads.segment(scope, { snapshotId: randomId(), line: 1, prefix: '' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // The whole line is already displayed: nothing remains to continue.
    await expect(
      reads.segment(scope, {
        snapshotId: stat.snapshotId,
        line: 1,
        prefix: longLine + 'tail',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

function randomId() {
  return '00000000-0000-4000-8000-000000000000';
}

describe('§11.20.26 every page hands its liveness to the window', () => {
  test('the first page, a continuation and a segment all carry the abort signal and snapshot expiry', async () => {
    file('large.txt', 'p'.repeat(pageBytes + 10));
    const { reads, frames } = fixture();
    const controller = new AbortController();
    const first = await reads.read(
      scope,
      { repositoryId: 'app', path: 'large.txt' },
      () => {},
      controller.signal,
    );
    const stat = await reads.stat(scope, {
      repositoryId: 'app',
      path: 'large.txt',
    });
    const page = await reads.read(
      scope,
      { cursor: stat.cursor },
      () => {},
      controller.signal,
    );
    expect(page.from).toBe(0);
    expect(frames).toHaveLength(2);
    // Live while the pages left: the signal had not been aborted yet.
    expect(frames.every((frame) => frame.aborted)).toBe(false);
    controller.abort();
    await expect(
      reads.read(scope, { cursor: page.cursor! }, () => {}, controller.signal),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(frames).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(maxSnapshotBytes).toBe(256 * 1024);
  });
});

describe('§11.20.26 segment liveness and segment paths', () => {
  test('only registered long-line segments of the same scope are live; a page-bottom cursor is no segment and a segment path states the same snapshot', async () => {
    const line = 'a'.repeat(2000);
    file('large.txt', 'p'.repeat(pageBytes + 10));
    file('lines.txt', line + 'tail\n');
    const lab = fixture();
    const stat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'large.txt',
    });
    const page = await lab.reads.read(scope, { cursor: stat.cursor });
    expect(lab.reads.registered(scope, stat.cursor)).toBe(false);
    expect(lab.reads.registered(scope, page.cursor!)).toBe(false);
    const lineStat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    const segment = await lab.reads.segment(scope, {
      snapshotId: lineStat.snapshotId,
      line: 1,
      prefix: line,
    });
    const id = segment.segment.slice(readSegmentPrefix.length);
    expect(lab.reads.registered(scope, id)).toBe(true);
    expect(lab.reads.registered(other, id)).toBe(false);
    lab.reads.revoke(() => true);
    expect(lab.reads.registered(scope, id)).toBe(false);
  });

  test('a segment path states the same snapshot and cursor without a new file read; a segment of a segment continues it', async () => {
    const tail = 'x'.repeat(2000) + 'end';
    file('lines.txt', 'a'.repeat(2000) + tail + '\n');
    const lab = fixture();
    const stat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'lines.txt',
    });
    const first = await lab.reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: 'a'.repeat(2000),
    });
    const id = first.segment.slice(readSegmentPrefix.length);
    const before = files.get('lines.txt');
    files.set('lines.txt', Buffer.from('changed after the snapshot'));
    const stated = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: first.segment,
    });
    expect(stated).toMatchObject({
      type: 'file',
      snapshotId: stat.snapshotId,
      cursor: id,
      size: Buffer.byteLength(tail),
      sha256: createHash('sha256').update(before!).digest('hex'),
    });
    const continued = await lab.reads.segment(scope, {
      snapshotId: stat.snapshotId,
      line: 1,
      prefix: 'x'.repeat(2000),
      segment: id,
    });
    expect(continued).toMatchObject({ from: 4000, through: 4003 });
    expect(
      (
        await lab.reads.read(scope, {
          cursor: continued.segment.slice(readSegmentPrefix.length),
        })
      ).text,
    ).toBe('end');
  });
});

describe('§11.20.26 FD3 reply cap judged before a page leaves', () => {
  test('a page whose JSON reply would exceed the 48 KiB cap fails with 413 and sends no frame', async () => {
    // Every control byte escapes to six JSON characters: 16 KiB of 0x01 is
    // about 96 KiB encoded.
    file('ctrl.bin', '\u0001'.repeat(16 * 1024 + 10));
    const lab = fixture();
    const stat = await lab.reads.stat(scope, {
      repositoryId: 'app',
      path: 'ctrl.bin',
    });
    expect(lab.frames).toHaveLength(0);
    await expect(
      lab.reads.read(scope, { cursor: stat.cursor }),
    ).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(lab.frames).toHaveLength(0);
  });
});
