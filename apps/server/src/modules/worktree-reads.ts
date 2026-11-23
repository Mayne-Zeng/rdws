import { createHash, randomUUID } from 'node:crypto';
import { readMacosWorktree, maxSnapshotBytes } from '@rdws/dsh/execution';
import type { DemandRepositories, DemandWorktrees } from '@rdws/orchestrator';
import { businessError, digestOf } from './business.ts';
import type { WriteHandoffScope as Scope } from './write-handoff.ts';

type ReadRequest = { repositoryId: string; path: string } | { cursor: string };
type Access = { repositories: DemandRepositories; validBefore: number };

// §11.20.25 opt-in outbound carrier: when provided, every read page outbound
// is ordered through a checked authorization window and only returns with a
// coverage certificate; a lost certificate seals the attempt without retry.
export type WorktreeReadWindow = (input: {
  scope: Scope;
  repositoryId: string;
  snapshotId: string;
  sha256: string;
  body: Buffer;
}) => Promise<void>;
type Snapshot = {
  id: string;
  scope: Scope;
  repositoryId: string;
  repositoryPlan: string;
  expiresAt: number;
  bytes: Buffer;
  sha256: string;
  cursors: Map<number, string>;
};

const pageBytes = 16 * 1024;
const maxCachedBytes = 8 * maxSnapshotBytes;
const maxSnapshots = 32;
const maxReads = 8;
const readTime = 5000;
const snapshotLifetime = 60_000;

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
  const cursors = new Map<string, { snapshot: Snapshot; from: number }>();
  let cachedBytes = 0;
  let uncertain = 0;
  let stopping = false;
  let expiryTimer: NodeJS.Timeout | undefined;

  function drop(snapshot: Snapshot) {
    if (!snapshots.delete(snapshot.id)) return;
    cachedBytes -= snapshot.bytes.length;
    for (const cursor of snapshot.cursors.values()) cursors.delete(cursor);
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

  function page(snapshot: Snapshot, from: number) {
    const { bytes, id, sha256 } = snapshot;
    let through = Math.min(from + pageBytes, bytes.length);
    while (through < bytes.length && (bytes[through]! & 0xc0) === 0x80)
      through--;
    const truncated = through < bytes.length;
    let cursor = snapshot.cursors.get(through);
    if (truncated && !cursor) {
      cursor = randomUUID();
      snapshot.cursors.set(through, cursor);
      cursors.set(cursor, { snapshot, from: through });
    }
    return {
      snapshotId: id,
      sha256,
      from,
      through,
      totalBytes: bytes.length,
      text: bytes.subarray(from, through).toString('utf8'),
      truncated,
      ...(truncated && { cursor }),
    };
  }

  async function read(
    scope: Scope,
    request: ReadRequest,
    assertCurrent: () => void,
    signal?: AbortSignal,
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
      if (stopping || active.aborted || deadline <= Date.now())
        businessError(409, '当前读取已失效');
    };
    running.set(controller, scope);
    try {
      sweep();
      current();
      if (!request || typeof request !== 'object' || Array.isArray(request))
        businessError(400, '读取参数不正确');
      if ('cursor' in request) {
        if (
          typeof request.cursor !== 'string' ||
          Object.keys(request).length !== 1
        )
          businessError(400, '读取参数不正确');
        const next = cursors.get(request.cursor);
        if (!next || digestOf(next.snapshot.scope) !== digestOf(scope))
          businessError(403, '当前读取游标不可用');
        const { snapshot, from } = next;
        const access = await checkAccess(scope, snapshot.repositoryId, current);
        current();
        if (
          Math.min(access.validBefore, snapshot.expiresAt) <= Date.now() ||
          snapshots.get(snapshot.id) !== snapshot ||
          digestOf(access.repositories) !== snapshot.repositoryPlan
        )
          businessError(409, '当前读取游标已失效');
        const continuation = page(snapshot, from);
        if (windowed)
          await windowed({
            scope,
            repositoryId: snapshot.repositoryId,
            snapshotId: snapshot.id,
            sha256: snapshot.sha256,
            body: snapshot.bytes.subarray(from, continuation.through),
          });
        return continuation;
      }
      if (
        Object.keys(request).length !== 2 ||
        typeof request.repositoryId !== 'string' ||
        typeof request.path !== 'string'
      )
        businessError(400, '读取参数不正确');
      const access = await checkAccess(scope, request.repositoryId, current);
      const repositoryPlan = digestOf(access.repositories);
      function verified(latest: Access) {
        current();
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
          signal: active,
          async authorizeStart(start) {
            verified(await checkAccess(scope, request.repositoryId, current));
            start();
          },
        },
      );
      if (outcome.stop === 'unconfirmed') {
        uncertain++;
        businessError(503, '读取停稳状态尚待确认');
      }
      current();
      if (outcome.exitCode === 78) businessError(413, '文件超过读取大小上限');
      if (
        outcome.status !== 'ok' ||
        outcome.stop !== 'confirmed' ||
        !outcome.bytes
      )
        businessError(403, '当前文件不能读取');
      const latest = await checkAccess(scope, request.repositoryId, current);
      const snapshot: Snapshot = {
        id: randomUUID(),
        scope,
        repositoryId: request.repositoryId,
        repositoryPlan,
        expiresAt: Math.min(latest.validBefore, Date.now() + snapshotLifetime),
        bytes: outcome.bytes,
        sha256: createHash('sha256').update(outcome.bytes).digest('hex'),
        cursors: new Map(),
      };
      verified(latest);
      if (snapshot.bytes.length > pageBytes) {
        while (
          snapshots.size >= maxSnapshots ||
          cachedBytes + snapshot.bytes.length > maxCachedBytes
        )
          drop(snapshots.values().next().value!);
        snapshots.set(snapshot.id, snapshot);
        cachedBytes += snapshot.bytes.length;
        scheduleExpiry();
      }
      const outbound = page(snapshot, 0);
      if (windowed)
        await windowed({
          scope,
          repositoryId: snapshot.repositoryId,
          snapshotId: snapshot.id,
          sha256: snapshot.sha256,
          body: snapshot.bytes.subarray(0, outbound.through),
        });
      return outbound;
    } finally {
      clearTimeout(timer);
      running.delete(controller);
    }
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
    revoke,
    stop() {
      stopping = true;
      revoke(() => true);
    },
    stopped: () => running.size === 0 && uncertain === 0,
  };
}
