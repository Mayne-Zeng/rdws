import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import { businessError } from './business.ts';

// The write-transaction shape the broker hands to its recorders: the
// query methods of the database, no raw client.
type Tx = Pick<ReturnType<typeof connectDatabase>['db'], 'select' | 'insert'>;

// §11.23 S1/S3: the immutable historical candidate of one controlled
// commit. The row is append-only (the application role loses UPDATE and
// DELETE in the db-migrate guard); corrections are new rows, never
// rewrites. The content anchor is the SHA-256 over the canonical path
// list of the snapshot: the same list the commit recorded, so the anchor
// can be recomputed read-only from the stored row alone and compared.

export type DeliverySnapshotPath = {
  path: string;
  type: string;
  digest: string | null;
};

// The canonical form: sorted by path, digests lowercase or null (a
// deleted path has no content).
export function canonicalDeliveryPaths(paths: DeliverySnapshotPath[]) {
  return [...paths]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, type, digest }) => ({
      path,
      type,
      digest: digest === null ? null : digest.toLowerCase(),
    }));
}

export function deliveryContentDigest(paths: DeliverySnapshotPath[]) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalDeliveryPaths(paths)))
    .digest('hex');
}

// §11.23 S3: the anchor check is read-only. It recomputes the content
// digest from the stored row and never writes back; the caller may add
// the per-file worktree comparison on top (the managed read of every
// listed path), whose result is reported, not persisted.
export function verifyDeliveryAnchor(row: {
  paths: DeliverySnapshotPath[];
  contentDigest: string;
}) {
  const digest = deliveryContentDigest(row.paths);
  return { digest, matches: digest === row.contentDigest };
}

export type DeliverySnapshotRow =
  typeof schema.requirementDeliverySnapshot.$inferSelect;

// The single append-only write of one recorded commit. Idempotent by the
// (repositoryId, commitHash) key: a replay of the same commit answers
// with the original row (原键回查), a different command under the same
// commit is a conflict, and the sequence advances per requirement and
// repository.
export async function recordDeliverySnapshotRow(
  tx: Tx,
  input: {
    requirementId: string;
    repositoryId: string;
    commitHash: string;
    parentHead: string;
    baseCommit: string;
    paths: DeliverySnapshotPath[];
    messageSha256: string;
    commandId: string;
    committedBy: string;
    generation: string;
  },
) {
  if (input.paths.length === 0) businessError(400, '快照路径清单为空');
  const contentDigest = deliveryContentDigest(input.paths);
  const [existing] = await tx
    .select()
    .from(schema.requirementDeliverySnapshot)
    .where(
      and(
        eq(schema.requirementDeliverySnapshot.repositoryId, input.repositoryId),
        eq(schema.requirementDeliverySnapshot.commitHash, input.commitHash),
      ),
    );
  if (existing) {
    if (
      existing.requirementId !== input.requirementId ||
      existing.commandId !== input.commandId ||
      existing.contentDigest !== contentDigest
    )
      businessError(409, '提交哈希已记录为其他快照');
    return { snapshot: existing, replay: true as const };
  }
  const [latest] = await tx
    .select({
      next: sql<number>`coalesce(max(${schema.requirementDeliverySnapshot.snapshotSeq}), 0) + 1`,
    })
    .from(schema.requirementDeliverySnapshot)
    .where(
      eq(schema.requirementDeliverySnapshot.requirementId, input.requirementId),
    );
  const next = Number(latest?.next ?? 1);
  const [row] = await tx
    .insert(schema.requirementDeliverySnapshot)
    .values({
      requirementId: input.requirementId,
      repositoryId: input.repositoryId,
      snapshotSeq: Number(next),
      commitHash: input.commitHash,
      parentHead: input.parentHead,
      baseCommit: input.baseCommit,
      paths: canonicalDeliveryPaths(input.paths),
      contentDigest,
      messageSha256: input.messageSha256,
      commandId: input.commandId,
      committedBy: input.committedBy,
      generation: input.generation,
    })
    .returning();
  if (!row) businessError(500, '快照写入未能确认');
  return { snapshot: row, replay: false as const };
}
