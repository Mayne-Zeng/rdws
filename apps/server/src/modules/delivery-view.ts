import { and, desc, eq } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import { protectedWritePath } from '@rdws/dsh/write-tool-arguments';
import { businessError } from './business.ts';
import { verifyDeliveryAnchor } from './delivery-snapshot.ts';
import { diffNamesProtectedPath } from './shell-output-handling.ts';

type Database = ReturnType<typeof connectDatabase>;

// §11.23 B 段: the changes view of one requirement repository — the
// current candidate (real status + diff sampled under one pinned head,
// D2/D3) with the diff paginated at 16 KiB (D4) and the whole-no-body
// rule extended to status output (D5), and the historical candidate list
// joined with its execution evidence (E1) and merge records (S5). The
// projection outputs evidence fields only — never committed or delivered
// booleans (E2) — and a candidate exists only as a snapshot row, so a
// reservation or an in-flight execution never reads as committed (E3).

export type StatusEntry = { path: string; code: string };
export type GitSample = {
  stdout: string;
  status: string;
  exitCode: number | null;
};
export type GitQuery = (
  operation: 'status' | 'diff' | 'head',
  signal?: AbortSignal,
) => Promise<GitSample>;

export const deliveryPageSize = 16 * 1024;
const cacheTtlMs = 60_000;
const cacheTotalBytes = 2 * 1024 * 1024;

const ok = (sample: GitSample) => {
  if (sample.status !== 'ok' || sample.exitCode !== 0)
    businessError(502, '只读 Git 查询未能完成');
  return sample.stdout;
};

// One porcelain v1 entry: two status columns, a space, then the path (a
// rename reports 'old -> new'). A C-quoted path is unescaped
// conservatively for the protected-name judgment; a form this view cannot
// judge closes the whole body (D5).
export function statusEntries(stdout: string) {
  const entries: StatusEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const body = line.slice(3);
    const paths = body.includes(' -> ') ? body.split(' -> ') : [body];
    for (const raw of paths) {
      const path = unquote(raw);
      if (path === null) return { judgeable: false as const };
      entries.push({ path, code });
    }
  }
  return { judgeable: true as const, entries };
}

function unquote(raw: string) {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const inner = raw.slice(1, -1);
  if (/\\[^\\"tnr]/.test(inner)) return null;
  return inner
    .replace(/\\\\/g, '\u0000')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replaceAll('\u0000', '\\');
}

export type CurrentCandidates = {
  repositoryId: string;
  head: string;
  status: { entries: StatusEntry[] } | { omitted: 'protected' };
  diff:
    { text: string; total: number; next?: string } | { omitted: 'protected' };
};

// The bounded cache of one sampled diff, keyed by the pinned head: a
// cursor reads the very bytes that were sampled, never a re-run.
const sampled = new Map<
  string,
  { head: string; repositoryId: string; text: string; at: number }
>();

function remember(head: string, repositoryId: string, text: string) {
  const now = Date.now();
  for (const [key, value] of sampled)
    if (now - value.at > cacheTtlMs) sampled.delete(key);
  while (
    [...sampled.values()].reduce((n, v) => n + v.text.length, 0) + text.length >
      cacheTotalBytes ||
    sampled.size >= 8
  ) {
    const oldest = sampled.keys().next().value;
    if (oldest === undefined) break;
    sampled.delete(oldest);
  }
  sampled.set(head + ':' + repositoryId, { head, repositoryId, text, at: now });
}

export async function sampleCurrentCandidates(
  git: GitQuery,
  repositoryId: string,
  page?: { cursor?: string },
): Promise<CurrentCandidates> {
  // D4: a cursor continues the sampled diff of one pinned head.
  if (page?.cursor) {
    const [head, repository, offset] = page.cursor.split(':');
    const entry =
      head && repository && offset
        ? sampled.get(head + ':' + repository)
        : undefined;
    if (
      !entry ||
      entry.head !== head ||
      entry.repositoryId !== repository ||
      Date.now() - entry.at > cacheTtlMs
    )
      businessError(410, '采样已过期，请重新读取变更');
    const from = Number(offset);
    if (!Number.isSafeInteger(from) || from < 0 || from > entry.text.length)
      businessError(400, '续读位置不正确');
    const text = entry.text.slice(from, from + deliveryPageSize);
    return {
      repositoryId: entry.repositoryId,
      head: entry.head,
      status: { entries: [] },
      diff: {
        text,
        total: entry.text.length,
        ...(from + text.length < entry.text.length && {
          next:
            entry.head + ':' + entry.repositoryId + ':' + (from + text.length),
        }),
      },
    };
  }
  // D3: one head pins the sample; the head is re-read after status and
  // diff, and any movement in between refuses the whole answer (N1) —
  // the projection binds to the sampled head, it never ages silently.
  const head = ok(await git('head')).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) businessError(502, 'HEAD 无法解析');
  const status = ok(await git('status'));
  const diff = ok(await git('diff'));
  const headAgain = ok(await git('head')).trim();
  if (headAgain !== head) businessError(409, '读取中变更，请重试');
  // D5: a protected location in a status path or a diff header closes
  // that whole body — no omission stands in for it, and the rule covers
  // status exactly as it covers diff (较 §11.20.27 W8 扩及 status 输出).
  const judged = statusEntries(status);
  const statusView = judged.judgeable
    ? judged.entries.some(({ path }) => protectedWritePath(path))
      ? ({ omitted: 'protected' } as const)
      : ({ entries: judged.entries } as const)
    : ({ omitted: 'protected' } as const);
  const diffView = diffNamesProtectedPath(diff, protectedWritePath)
    ? ({ omitted: 'protected' } as const)
    : ((): CurrentCandidates['diff'] => {
        remember(head, repositoryId, diff);
        const text = diff.slice(0, deliveryPageSize);
        return {
          text,
          total: diff.length,
          ...(text.length < diff.length && {
            next: head + ':' + repositoryId + ':' + text.length,
          }),
        };
      })();
  return { repositoryId, head, status: statusView, diff: diffView };
}

export type HistoricalCandidate = {
  snapshotSeq: number;
  commitHash: string;
  parentHead: string;
  baseCommit: string;
  paths: { path: string; type: string; digest: string | null }[];
  contentDigest: string;
  messageSha256: string;
  commandId: string;
  committedBy: string;
  recordedAt: string;
  anchor: { digest: string; matches: boolean };
  receipt: { commandId: string; state: string } | null;
  merges: {
    environment: string;
    cherryPickCommit: string;
    mergeCommit: string | null;
  }[];
};

// §11.23 S5/E1: the historical candidates come from the snapshot rows
// alone; each row joins its own write.execute receipt (the execution
// evidence) and its merge records. A receipt that is missing, reserved
// or unknown stays an open evidence gap in the projection — never a
// committed or delivered claim (E2/E3).
export async function historicalCandidates(
  db: Database['db'],
  repositoryId: string,
  requirementId: string,
): Promise<{ repositoryId: string; candidates: HistoricalCandidate[] }> {
  const rows = await db
    .select()
    .from(schema.requirementDeliverySnapshot)
    .where(
      and(
        eq(schema.requirementDeliverySnapshot.requirementId, requirementId),
        eq(schema.requirementDeliverySnapshot.repositoryId, repositoryId),
      ),
    )
    .orderBy(desc(schema.requirementDeliverySnapshot.snapshotSeq));
  const candidates: HistoricalCandidate[] = [];
  for (const row of rows) {
    const [receipt] = await db
      .select()
      .from(schema.commandReceipt)
      .where(
        and(
          eq(schema.commandReceipt.operation, 'write.execute'),
          eq(schema.commandReceipt.scope, 'requirement:' + requirementId),
          eq(schema.commandReceipt.commandId, row.commandId),
        ),
      );
    const merges = await db
      .select()
      .from(schema.requirementDeliveryMerge)
      .where(
        and(
          eq(schema.requirementDeliveryMerge.requirementId, requirementId),
          eq(schema.requirementDeliveryMerge.repositoryId, repositoryId),
          eq(schema.requirementDeliveryMerge.snapshotSeq, row.snapshotSeq),
        ),
      );
    candidates.push({
      snapshotSeq: row.snapshotSeq,
      commitHash: row.commitHash,
      parentHead: row.parentHead,
      baseCommit: row.baseCommit,
      paths: row.paths,
      contentDigest: row.contentDigest,
      messageSha256: row.messageSha256,
      commandId: row.commandId,
      committedBy: row.committedBy,
      recordedAt: row.recordedAt.toISOString(),
      anchor: verifyDeliveryAnchor(row),
      receipt: receipt
        ? {
            commandId: receipt.commandId,
            state:
              (receipt.result as { status?: string } | null)?.status ??
              'unknown',
          }
        : null,
      merges: merges.map((merge) => ({
        environment: merge.environment,
        cherryPickCommit: merge.cherryPickCommit,
        mergeCommit: merge.mergeCommit,
      })),
    });
  }
  return { repositoryId, candidates };
}
