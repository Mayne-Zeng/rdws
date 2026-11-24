import { createHash, randomUUID } from 'node:crypto';
import {
  maxOutputBudgetBytes,
  maxSnapshotBytes,
  readMacosWorktree,
} from '@rdws/dsh/execution';
import type { DemandRepositories, DemandWorktrees } from '@rdws/orchestrator';
import { businessError, digestOf } from './business.ts';
import { readReplyLimit } from '@rdws/dsh/read-tool-arguments';
import type { WriteHandoffScope as Scope } from './write-handoff.ts';

type ReadRequest = { repositoryId: string; path: string } | { cursor: string };
// §11.20.26 metadata request: registers one whole-file snapshot and returns
// its kind, byte size, SHA-256 and snapshot identity without any page.
type StatRequest = { repositoryId: string; path: string };
// §11.20.26 segment registration: the Host probe reports the line the locked
// read annotated as truncated together with the prefix it actually displayed.
// A segment of a segment (a continuation that the locked read truncated
// again) names the segment it continues; otherwise it continues a line.
type SegmentRequest = {
  snapshotId: string;
  line: number;
  prefix: string;
  segment?: string;
};
type Access = { repositories: DemandRepositories; validBefore: number };

// §11.20.25 opt-in outbound carrier: when provided, every read page outbound
// is ordered through a checked authorization window and only returns with a
// coverage certificate; a lost certificate seals the attempt without retry.
type WorktreeReadWindow = (input: {
  scope: Scope;
  repositoryId: string;
  snapshotId: string;
  sha256: string;
  body: Buffer;
  // §11.20.26 A-05: liveness of the read that owns this page. The armed
  // callback re-checks it in the same event-loop turn before the first write.
  expiresAt: number;
  live: {
    signal: AbortSignal;
    validBefore: number;
    // The FD3 request's run is still current (a cancelled or released run
    // makes the armed callback return not-sent).
    live?: () => boolean;
  };
}) => Promise<void>;
// One registered continuation: a page-bottom cursor carries only its start
// offset; a first-page or long-line segment cursor also carries its end.
type Cursor = { snapshot: Snapshot; from: number; through?: number };
type Snapshot = {
  id: string;
  scope: Scope;
  repositoryId: string;
  repositoryPlan: string;
  expiresAt: number;
  bytes: Buffer;
  sha256: string;
  // Every cursor issued for this snapshot; dropped together with it.
  cursors: Map<string, Cursor>;
  // Page-bottom cursors deduplicated by byte offset.
  positions: Map<number, string>;
};

// Model-facing path prefix of a registered long-line segment identifier.
export const readSegmentPrefix = '.rdws-read/';

const pageBytes = 16 * 1024;
const maxCachedBytes = 8 * maxSnapshotBytes;
const maxSnapshots = 32;
const maxReads = 8;
const readTime = 5000;
const snapshotLifetime = 60_000;

function keys(value: object, expected: string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length && expected.every((key) => key in value)
  );
}

export function createWorktreeReads(
  worktrees: DemandWorktrees,
  checkAccess: (
    scope: Scope,
    repositoryId: string,
    current: () => void,
  ) => Promise<Access>,
  assertAuthority: (scope: Scope) => void,
  windowed?: WorktreeReadWindow,
) {
  const running = new Map<AbortController, Scope>();
  const snapshots = new Map<string, Snapshot>();
  const cursors = new Map<string, Cursor>();
  let cachedBytes = 0;
  let uncertain = 0;
  let stopping = false;
  let expiryTimer: NodeJS.Timeout | undefined;

  function drop(snapshot: Snapshot) {
    if (!snapshots.delete(snapshot.id)) return;
    cachedBytes -= snapshot.bytes.length;
    for (const cursor of snapshot.cursors.keys()) cursors.delete(cursor);
  }

  function retain(snapshot: Snapshot) {
    while (
      snapshots.size >= maxSnapshots ||
      cachedBytes + snapshot.bytes.length > maxCachedBytes
    )
      drop(snapshots.values().next().value!);
    snapshots.set(snapshot.id, snapshot);
    cachedBytes += snapshot.bytes.length;
    scheduleExpiry();
  }

  function sweep() {
    const now = Date.now();
    for (const snapshot of snapshots.values())
      if (snapshot.expiresAt <= now) drop(snapshot);
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (stopping || !snapshots.size) return;
    const expiresAt = Math.min(
      ...Array.from(snapshots.values(), (snapshot) => snapshot.expiresAt),
    );
    expiryTimer = setTimeout(
      () => {
        sweep();
        scheduleExpiry();
      },
      Math.max(1, expiresAt - Date.now()),
    ).unref();
  }

  function issue(
    snapshot: Snapshot,
    from: number,
    through?: number,
    position?: number,
  ) {
    if (position !== undefined) {
      const existing = snapshot.positions.get(position);
      if (existing) return existing;
    }
    const cursor = randomUUID();
    const entry: Cursor = {
      snapshot,
      from,
      ...(through !== undefined && { through }),
    };
    snapshot.cursors.set(cursor, entry);
    cursors.set(cursor, entry);
    if (position !== undefined) snapshot.positions.set(position, cursor);
    return cursor;
  }

  // A page ends at the next 16 KiB UTF-8 boundary or at the cursor's own end
  // (a long-line segment stops at its line end). Splitting never breaks a
  // multi-byte sequence; the locked read's own line truncation is unrelated.
  function page({ snapshot, from, through }: Cursor) {
    const { bytes, id, sha256 } = snapshot;
    const limit = through ?? bytes.length;
    let end = Math.min(from + pageBytes, limit);
    while (end > from && end < limit && (bytes[end]! & 0xc0) === 0x80) end--;
    const truncated = end < limit;
    const cursor = truncated
      ? issue(snapshot, end, through, through === undefined ? end : undefined)
      : undefined;
    return {
      snapshotId: id,
      sha256,
      from,
      through: end,
      totalBytes: bytes.length,
      text: bytes.subarray(from, end).toString('utf8'),
      truncated,
      ...(truncated && { cursor }),
    };
  }

  // §11.20.26 oracle: the longest prefix of the snapshot line whose complete
  // code points equal the displayed prefix, as a byte offset. A displayed
  // prefix ending in a lone high surrogate never equals the snapshot's full
  // surrogate pair, so that code point as a whole joins the continuation.
  // The line's byte range excludes its terminator and the CR the locked read
  // strips; BOM bytes belong to the first line and stay in the prefix.
  function segmentRange(
    snapshot: Snapshot,
    line: number,
    prefix: string,
    base?: Cursor,
  ) {
    const { bytes } = snapshot;
    let start = 0;
    let end: number;
    if (base) {
      // The displayed text is the earlier segment itself, which never
      // contains a line terminator; it has exactly one line.
      if (line !== 1) return undefined;
      start = base.from;
      end = base.through!;
    } else {
      for (let index = 1; index < line; index++) {
        const next = bytes.indexOf(0x0a, start);
        if (next < 0) return undefined;
        start = next + 1;
      }
      const eol = bytes.indexOf(0x0a, start);
      end = eol < 0 ? bytes.length : eol;
      if (end > start && bytes[end - 1] === 0x0d) end--;
    }
    const shown = Array.from(prefix);
    let matched = 0;
    let offset = 0;
    for (const point of bytes.subarray(start, end).toString('utf8')) {
      if (matched === shown.length || shown[matched] !== point) break;
      matched++;
      offset += Buffer.byteLength(point);
    }
    return { from: start + offset, through: end, matched };
  }

  // One running read: bounded lifetime, revocable, counted against the
  // admission limit, and validated before and after every await.
  // A page reply that would exceed the FD3 envelope cap fails before the
  // page leaves, so no frame is sent for it.
  function bounded<T extends object>(reply: T): T {
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > readReplyLimit)
      businessError(413, '读取回包超过上限');
    return reply;
  }

  async function withRead<T>(
    scope: Scope,
    assertCurrent: () => void,
    signal: AbortSignal | undefined,
    liveness: (() => boolean) | undefined,
    work: (live: {
      deadline: number;
      active: AbortSignal;
      current: () => void;
    }) => Promise<T>,
  ) {
    const deadline = Date.now() + readTime;
    assertAuthority(scope);
    if (stopping || running.size + uncertain >= maxReads)
      businessError(503, '当前读取暂不可用');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), readTime).unref();
    const active = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const current = () => {
      assertAuthority(scope);
      assertCurrent();
      if (
        stopping ||
        active.aborted ||
        deadline <= Date.now() ||
        (liveness && !liveness())
      )
        businessError(409, '当前读取已失效');
    };
    running.set(controller, scope);
    try {
      sweep();
      current();
      return await work({ deadline, active, current });
    } finally {
      clearTimeout(timer);
      running.delete(controller);
    }
  }

  // Access re-check shared by every cursor consumer: the plan digest and the
  // login, snapshot and read deadlines bound the continuation.
  async function continuing(
    snapshot: Snapshot,
    scope: Scope,
    live: { current: () => void },
  ) {
    const access = await checkAccess(
      scope,
      snapshot.repositoryId,
      live.current,
    );
    live.current();
    if (
      Math.min(access.validBefore, snapshot.expiresAt) <= Date.now() ||
      snapshots.get(snapshot.id) !== snapshot ||
      digestOf(access.repositories) !== snapshot.repositoryPlan
    )
      businessError(409, '当前读取游标已失效');
    return access;
  }

  // One whole managed read: the bounded snapshot worker runs under the
  // verified execution scope, its result is hashed, and the page-boundary
  // snapshot is retained only by the caller that needs continuations.
  async function load(
    scope: Scope,
    request: { repositoryId: string; path: string },
    live: { active: AbortSignal; current: () => void },
  ) {
    const access = await checkAccess(scope, request.repositoryId, live.current);
    const repositoryPlan = digestOf(access.repositories);
    function verified(latest: Access) {
      live.current();
      if (
        latest.validBefore <= Date.now() ||
        digestOf(latest.repositories) !== repositoryPlan
      )
        businessError(409, '当前读取范围已变化');
    }
    const outcome = await readMacosWorktree(
      () =>
        worktrees.readExecutionScope(
          scope.projectId,
          scope.requirementId,
          access.repositories,
          request.repositoryId,
        ),
      request.path,
      {
        signal: live.active,
        async authorizeStart(start) {
          verified(
            await checkAccess(scope, request.repositoryId, live.current),
          );
          start();
        },
      },
    );
    if (outcome.stop === 'unconfirmed') {
      uncertain++;
      businessError(503, '读取停稳状态尚待确认');
    }
    live.current();
    if (outcome.exitCode === 78) businessError(413, '文件超过读取大小上限');
    if (
      outcome.status !== 'ok' ||
      outcome.stop !== 'confirmed' ||
      !outcome.bytes
    )
      businessError(403, '当前文件不能读取');
    const latest = await checkAccess(scope, request.repositoryId, live.current);
    const snapshot: Snapshot = {
      id: randomUUID(),
      scope,
      repositoryId: request.repositoryId,
      repositoryPlan,
      expiresAt: Math.min(latest.validBefore, Date.now() + snapshotLifetime),
      bytes: outcome.bytes,
      sha256: createHash('sha256').update(outcome.bytes).digest('hex'),
      cursors: new Map(),
      positions: new Map(),
    };
    verified(latest);
    return snapshot;
  }

  async function read(
    scope: Scope,
    request: ReadRequest,
    assertCurrent: () => void = () => {},
    signal?: AbortSignal,
    liveness?: () => boolean,
  ) {
    return withRead(scope, assertCurrent, signal, liveness, async (live) => {
      const emit = (cursor: Cursor, through: number) =>
        windowed?.({
          scope,
          repositoryId: cursor.snapshot.repositoryId,
          snapshotId: cursor.snapshot.id,
          sha256: cursor.snapshot.sha256,
          body: cursor.snapshot.bytes.subarray(cursor.from, through),
          expiresAt: cursor.snapshot.expiresAt,
          live: {
            signal: live.active,
            validBefore: live.deadline,
            ...(liveness && { live: liveness }),
          },
        });
      if (!request || typeof request !== 'object' || Array.isArray(request))
        businessError(400, '读取参数不正确');
      if ('cursor' in request) {
        if (!keys(request, ['cursor']) || typeof request.cursor !== 'string')
          businessError(400, '读取参数不正确');
        const next = cursors.get(request.cursor);
        if (!next || digestOf(next.snapshot.scope) !== digestOf(scope))
          businessError(403, '当前读取游标不可用');
        await continuing(next.snapshot, scope, live);
        const continuation = bounded(page(next));
        if (windowed) await emit(next, continuation.through);
        return continuation;
      }
      if (
        !keys(request, ['repositoryId', 'path']) ||
        typeof request.repositoryId !== 'string' ||
        typeof request.path !== 'string'
      )
        businessError(400, '读取参数不正确');
      const snapshot = await load(scope, request, live);
      // A file within one page has no continuation to keep.
      if (snapshot.bytes.length > pageBytes) retain(snapshot);
      const first: Cursor = { snapshot, from: 0 };
      const outbound = bounded(page(first));
      if (windowed) await emit(first, outbound.through);
      return outbound;
    });
  }

  // §11.20.26 metadata operation: exactly one managed whole-file read per
  // file. It registers the snapshot — the only one the call ever uses (K) —
  // and the first-page cursor; no page leaves, no window opens.
  async function stat(
    scope: Scope,
    request: StatRequest,
    assertCurrent: () => void = () => {},
    signal?: AbortSignal,
    liveness?: () => boolean,
  ) {
    return withRead(scope, assertCurrent, signal, liveness, async (live) => {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !keys(request, ['repositoryId', 'path']) ||
        typeof request.repositoryId !== 'string' ||
        typeof request.path !== 'string'
      )
        businessError(400, '读取参数不正确');
      // A segment path names an already registered long-line segment of
      // this scope: no new file read, the same snapshot K and its cursor.
      if (request.path.startsWith(readSegmentPrefix)) {
        const cursor = request.path.slice(readSegmentPrefix.length);
        const next = registered(scope, cursor) && cursors.get(cursor);
        if (!next) businessError(403, '当前读取游标不可用');
        return {
          type: 'file' as const,
          size: next.through! - next.from,
          sha256: next.snapshot.sha256,
          snapshotId: next.snapshot.id,
          expiresAt: next.snapshot.expiresAt,
          cursor,
        };
      }
      const snapshot = await load(scope, request, live);
      // Files within one page are retained too: continuations always come
      // from the snapshot registered here.
      retain(snapshot);
      return bounded({
        type: 'file' as const,
        size: snapshot.bytes.length,
        sha256: snapshot.sha256,
        snapshotId: snapshot.id,
        expiresAt: snapshot.expiresAt,
        cursor: issue(snapshot, 0),
      });
    });
  }

  // §11.20.27 B-4: the parent's own managed read of one whole file — the
  // command set of a write generation reads package.json with it. Same
  // verified read-only worker and access checks as stat; no page, no
  // cursor and no window egress, the bytes go to the parent only and the
  // snapshot is not retained.
  async function bytes(
    scope: Scope,
    request: { repositoryId: string; path: string },
    assertCurrent: () => void = () => {},
    signal?: AbortSignal,
    liveness?: () => boolean,
  ) {
    return withRead(scope, assertCurrent, signal, liveness, async (live) => {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !keys(request, ['repositoryId', 'path']) ||
        typeof request.repositoryId !== 'string' ||
        typeof request.path !== 'string' ||
        request.path.startsWith(readSegmentPrefix)
      )
        businessError(400, '读取参数不正确');
      const snapshot = await load(scope, request, live);
      return { sha256: snapshot.sha256, bytes: snapshot.bytes };
    });
  }

  // §11.20.27 W10: the snapshot of a Shell output after content handling,
  // bound to the scope of the job that produced it. The identifier the
  // model reads on is a cursor from the end of the directly given head to
  // the end, so the first page continues exactly where the head stopped.
  // Same retention as every snapshot: 60 seconds, the shared byte budget,
  // earliest first.
  async function register(
    scope: Scope,
    repositoryId: string,
    bytes: Buffer,
    from: number,
    assertCurrent: () => void = () => {},
  ) {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > maxOutputBudgetBytes ||
      !Number.isSafeInteger(from) ||
      from < 1 ||
      from >= bytes.length
    )
      businessError(400, '输出快照不正确');
    const access = await checkAccess(scope, repositoryId, assertCurrent);
    const snapshot: Snapshot = {
      id: randomUUID(),
      scope,
      repositoryId,
      repositoryPlan: digestOf(access.repositories),
      expiresAt: Math.min(access.validBefore, Date.now() + snapshotLifetime),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cursors: new Map(),
      positions: new Map(),
    };
    retain(snapshot);
    return readSegmentPrefix + issue(snapshot, from, bytes.length);
  }

  // §11.20.26 long-line continuation registration: resolves the displayed
  // prefix against the registered snapshot, then issues a cursor from that
  // byte offset to the line end. The segment shares the snapshot's lifetime
  // and is dropped with it; a later grant never revives it.
  async function segment(
    scope: Scope,
    request: SegmentRequest,
    assertCurrent: () => void = () => {},
    signal?: AbortSignal,
    liveness?: () => boolean,
  ) {
    return withRead(scope, assertCurrent, signal, liveness, async (live) => {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        // Exactly {snapshotId, line, prefix} plus an optional segment.
        !['snapshotId', 'line', 'prefix'].every((key) => key in request) ||
        Object.keys(request).some(
          (key) => !['snapshotId', 'line', 'prefix', 'segment'].includes(key),
        ) ||
        ('segment' in request && typeof request.segment !== 'string') ||
        typeof request.snapshotId !== 'string' ||
        !Number.isSafeInteger(request.line) ||
        Number(request.line) < 1 ||
        typeof request.prefix !== 'string'
      )
        businessError(400, '续段参数不正确');
      const snapshot = snapshots.get(request.snapshotId);
      if (!snapshot || digestOf(snapshot.scope) !== digestOf(scope))
        businessError(403, '当前读取游标不可用');
      await continuing(snapshot, scope, live);
      // A continued segment must itself be a live registered segment of
      // this scope on the same snapshot (never a page-bottom cursor).
      const base =
        typeof request.segment === 'string' &&
        registered(scope, request.segment)
          ? cursors.get(request.segment)
          : undefined;
      if ('segment' in request && (!base || base.snapshot !== snapshot))
        businessError(403, '当前读取游标不可用');
      const range = segmentRange(
        snapshot,
        Number(request.line),
        request.prefix,
        base,
      );
      // A prefix that matches nothing is not a continuation of this line.
      if (!range || range.matched === 0 || range.from >= range.through)
        businessError(409, '当前续段前缀不匹配');
      const cursor = issue(snapshot, range.from, range.through);
      return bounded({
        snapshotId: snapshot.id,
        segment: readSegmentPrefix + cursor,
        from: range.from,
        through: range.through,
        expiresAt: snapshot.expiresAt,
      });
    });
  }

  // §11.20.26: whether a long-line segment identifier is registered for this
  // scope right now; the permit treats it like a registered path.
  function registered(scope: Scope, cursor: string) {
    const next = cursors.get(cursor);
    return (
      next?.through !== undefined &&
      digestOf(next.snapshot.scope) === digestOf(scope) &&
      snapshots.get(next.snapshot.id) === next.snapshot
    );
  }

  function revoke(matches: (scope: Scope) => boolean) {
    for (const [controller, scope] of running)
      if (matches(scope)) controller.abort();
    for (const snapshot of snapshots.values())
      if (matches(snapshot.scope)) drop(snapshot);
    scheduleExpiry();
  }

  return {
    read,
    stat,
    bytes,
    register,
    segment,
    registered,
    revoke,
    stop() {
      stopping = true;
      revoke(() => true);
    },
    stopped: () => running.size === 0 && uncertain === 0,
  };
}
