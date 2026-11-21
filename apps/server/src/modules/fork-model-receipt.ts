import { digestOf } from './command-digest.ts';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@rdws/db';
import { isRecord } from '@rdws/dsh/access';
import type { WriteTransaction } from './checked-write-transaction.ts';
import type { readForkModelPrefix } from './fork-model-evidence.ts';
import type { SavedSessionModel } from './session-model-selection.ts';

type Read = Pick<WriteTransaction, 'select'>;
export type ForkKey = {
  actorId: string;
  projectId: string;
  requirementId: string;
  sourceSessionId: string;
  cut: number;
  operationId: string;
  commandId: string;
};
const table = schema.commandReceipt;
export function soleSubmittedAttempt<T extends { state: string }>(
  attempts: T[],
) {
  if (attempts.length === 1 && attempts[0]?.state === 'submitted')
    return attempts[0];
}

export function intactForkReceipt(row: { digest: string; result: unknown }) {
  return isRecord(row.result) && row.digest === digestOf(row.result);
}
const sourceOp = 'model.fork-source';
const childOp = 'model.fork-child';
const scope = (id: string) => 'session:' + id;

export async function inheritedForkModel(
  tx: Read,
  actorId: string,
  sessionId: string,
): Promise<SavedSessionModel | undefined> {
  const n = schema.nativeSession;
  const [mapping] = await tx
    .select({
      source: n.sourceSessionId,
      cut: n.sourceThroughSeq,
      requirement: n.requirementId,
      project: schema.requirement.projectId,
    })
    .from(n)
    .innerJoin(schema.requirement, eq(schema.requirement.id, n.requirementId))
    .where(and(eq(n.id, sessionId), eq(n.ownerId, actorId)));
  if (!mapping?.source || mapping.cut === null) return;
  const children = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.actorId, actorId),
        eq(table.scope, scope(sessionId)),
        eq(table.operation, childOp),
      ),
    )
    .limit(2);
  if (children.length !== 1) return;
  const child = children[0]!;
  if (
    !intactForkReceipt(child) ||
    !isRecord(child.result) ||
    child.result.childId !== sessionId ||
    child.result.sourceId !== mapping.source ||
    child.result.cut !== mapping.cut
  )
    return;
  const [source] = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.actorId, actorId),
        eq(table.scope, scope(mapping.source)),
        eq(table.operation, sourceOp),
        eq(table.commandId, child.commandId),
      ),
    );
  if (
    !source ||
    !intactForkReceipt(source) ||
    child.result.sourceDigest !== source.digest ||
    !isRecord(source.result)
  )
    return;
  const { key, choice } = source.result;
  if (
    !isRecord(key) ||
    key.actorId !== actorId ||
    key.sourceSessionId !== mapping.source ||
    key.cut !== mapping.cut ||
    key.operationId !== child.commandId ||
    key.requirementId !== mapping.requirement ||
    key.projectId !== mapping.project ||
    !isRecord(choice) ||
    typeof choice.provider !== 'string' ||
    typeof choice.model !== 'string' ||
    typeof choice.revision !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(choice.revision)
  )
    return;
  return {
    provider: choice.provider,
    model: choice.model,
    revision: choice.revision,
  };
}

export async function recordForkSource(
  tx: WriteTransaction,
  key: ForkKey,
  prefix: Awaited<ReturnType<typeof readForkModelPrefix>>,
) {
  if (!prefix) return;
  const n = schema.nativeSession;
  const [parent] = await tx
    .select()
    .from(n)
    .where(
      and(
        eq(n.id, key.sourceSessionId),
        eq(n.ownerId, key.actorId),
        eq(n.requirementId, key.requirementId),
      ),
    );
  if (
    !parent ||
    parent.sourceThroughSeq !== prefix.inheritedThrough ||
    !!parent.sourceSessionId !== (prefix.inheritedThrough !== null)
  )
    return;
  const selections = schema.sessionModelSelection;
  const [saved] = await tx
    .select()
    .from(selections)
    .where(eq(selections.nativeSessionId, key.sourceSessionId));
  const d = schema.sessionPromptDispatch;
  const f = schema.sessionModelFirstWrite;
  let chosen: SavedSessionModel | undefined;
  let lastAttempt: string | undefined;
  if (prefix.uses.length) {
    const rows = await tx
      .select({ dispatch: d, write: f })
      .from(d)
      .innerJoin(
        f,
        and(
          eq(f.nativeSessionId, d.nativeSessionId),
          eq(f.selectionRequestId, d.requestId),
          eq(f.projectId, d.projectId),
          eq(f.requirementId, d.requirementId),
          eq(f.selectionRevision, d.selectionRevision),
          eq(f.hostGeneration, d.hostGeneration),
          eq(f.provider, d.provider),
          eq(f.model, d.model),
        ),
      )
      .where(
        and(
          eq(d.nativeSessionId, key.sourceSessionId),
          eq(d.actorId, key.actorId),
          eq(d.requirementId, key.requirementId),
          eq(d.projectId, key.projectId),
          eq(d.state, 'accepted'),
          inArray(
            d.requestId,
            prefix.uses.map((use) => use.requestId),
          ),
        ),
      )
      .limit(257);
    if (rows.length > 256) return;

    for (const use of prefix.uses) {
      const matches = rows.filter(
        ({ dispatch, write }) =>
          dispatch.requestId === use.requestId &&
          dispatch.peerNonce === use.nonce &&
          dispatch.acceptedMessageId === use.messageId &&
          dispatch.acceptedSeq === use.insertedAt &&
          dispatch.provider === use.provider &&
          dispatch.model === use.model &&
          write.turn === use.turn &&
          write.step === use.step &&
          write.stepSeq === use.stepSeq &&
          write.noteSeq === use.noteSeq,
      );
      const write = soleSubmittedAttempt(matches.map((match) => match.write));
      if (!write) return;
      chosen = {
        provider: use.provider,
        model: use.model,
        revision: write.selectionRevision,
      };
      lastAttempt = write.attemptId;
    }
    if (
      saved &&
      (saved.revision !== chosen?.revision ||
        saved.provider !== chosen.provider ||
        saved.model !== chosen.model)
    )
      return;
  } else if (parent.sourceSessionId && !saved) {
    chosen = await inheritedForkModel(tx, key.actorId, parent.id);
  }
  if (!chosen) return;
  const result = { key, choice: chosen, lastAttempt: lastAttempt ?? null };
  const digest = digestOf(result);
  await tx.insert(table).values({
    actorId: key.actorId,
    scope: scope(key.sourceSessionId),
    operation: sourceOp,
    commandId: key.operationId,
    digest,
    result,
  });
  return digest;
}

export async function recordForkChild(
  tx: WriteTransaction,
  key: ForkKey,
  childId: string,
  sourceDigest: string,
) {
  const [source] = await tx
    .select({ digest: table.digest })
    .from(table)
    .where(
      and(
        eq(table.actorId, key.actorId),
        eq(table.scope, scope(key.sourceSessionId)),
        eq(table.operation, sourceOp),
        eq(table.commandId, key.operationId),
      ),
    );
  if (source?.digest !== sourceDigest) return;
  const result = {
    childId,
    sourceId: key.sourceSessionId,
    cut: key.cut,
    sourceDigest,
  };
  await tx.insert(table).values({
    actorId: key.actorId,
    scope: scope(childId),
    operation: childOp,
    commandId: key.operationId,
    digest: digestOf(result),
    result,
  });
}
