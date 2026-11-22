import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { schema } from '@rdws/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { businessError, digestOf, type Actor } from './business.ts';
import type { WorkbenchRuntime } from './workbench-runtime.ts';

const commandIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

type AllowlistReceipt = {
  commandId: string;
  provider: string;
  model: string;
  state: 'enabled' | 'disabled';
  changed: boolean;
};

// Project admins maintain the pilot model allowlist through the existing
// project configuration authorization surface. The command keeps the
// management transaction and original-key receipt conventions (§11.21,
// §11.16.52): same-key same-content replays read back the same final state,
// different content is a 409, repeated adds of enabled entries register a
// no-change terminal state, and removal only disables the row.
export function registerModelAllowlist(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { actor, assertResponse, db, responseScopes } = workbench;
  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/model-allowlist',
    {
      async preValidation(request, reply) {
        reply.header('cache-control', 'no-store');
        const raw: unknown = request.body;
        if (
          !isRecord(raw) ||
          !onlyKeys(raw, ['commandId', 'provider', 'model', 'enabled']) ||
          typeof raw.commandId !== 'string' ||
          !commandIdPattern.test(raw.commandId) ||
          typeof raw.provider !== 'string' ||
          !raw.provider ||
          raw.provider.length > 160 ||
          typeof raw.model !== 'string' ||
          !raw.model ||
          raw.model.length > 160 ||
          typeof raw.enabled !== 'boolean'
        )
          businessError(400, '项目允许集合参数不正确');
      },
    },
    async (request) => {
      const epoch = workbench.authorizationEpoch;
      const who: Actor = await actor(request.headers);
      const { projectId } = request.params;
      const input = request.body as {
        commandId: string;
        provider: string;
        model: string;
        enabled: boolean;
      };
      const scope = 'project:' + projectId;
      const key = {
        actorId: who.userId,
        scope,
        operation: 'project.model.allow',
        commandId: input.commandId,
        digest: digestOf({
          provider: input.provider,
          model: input.model,
          enabled: input.enabled,
        }),
      };
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout='3s'`);
        const [session] = await tx
          .select({
            expiresAt: schema.session.expiresAt,
            epoch: schema.session.authEpoch,
          })
          .from(schema.session)
          .where(
            and(
              eq(schema.session.id, who.authSessionId),
              eq(schema.session.userId, who.userId),
            ),
          )
          .for('share');
        if (!session) businessError(401, '登录已失效');
        const [actorRow] = await tx
          .select({ active: schema.user.active, epoch: schema.user.authEpoch })
          .from(schema.user)
          .where(eq(schema.user.id, who.userId))
          .for('update');
        if (
          !actorRow?.active ||
          actorRow.epoch !== session.epoch ||
          session.expiresAt <= new Date()
        )
          businessError(401, '登录已失效');
        const members = await tx
          .select({ role: schema.projectMember.role })
          .from(schema.projectMember)
          .where(
            and(
              eq(schema.projectMember.projectId, projectId),
              eq(schema.projectMember.userId, who.userId),
            ),
          )
          .orderBy(asc(schema.projectMember.role))
          .for('update');
        if (!members.some(({ role }) => role === 'project_admin'))
          businessError(403, '无权管理当前项目模型允许集合');
        const [project] = await tx
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(eq(schema.project.id, projectId))
          .for('share');
        if (!project) businessError(404, '项目不存在');
        const condition = and(
          eq(schema.commandReceipt.actorId, key.actorId),
          eq(schema.commandReceipt.scope, key.scope),
          eq(schema.commandReceipt.operation, key.operation),
          eq(schema.commandReceipt.commandId, key.commandId),
        );
        const reserved = await tx
          .insert(schema.commandReceipt)
          .values(key)
          .onConflictDoNothing()
          .returning({ commandId: schema.commandReceipt.commandId });
        if (!reserved.length) {
          const [receipt] = await tx
            .select({
              digest: schema.commandReceipt.digest,
              result: schema.commandReceipt.result,
            })
            .from(schema.commandReceipt)
            .where(condition);
          if (receipt && receipt.digest !== key.digest)
            businessError(409, '操作标识已用于不同内容，请核对原操作');
          const value = receipt?.result;
          if (
            !receipt ||
            !value ||
            typeof value !== 'object' ||
            typeof (value as AllowlistReceipt).state !== 'string'
          )
            businessError(503, '原允许集合操作尚未确认，请重试同一操作');
          return { ...(value as AllowlistReceipt), replayed: true };
        }
        const identity = {
          projectId,
          provider: input.provider,
          model: input.model,
        };
        const [row] = await tx
          .select({ state: schema.projectModelAllowlist.state })
          .from(schema.projectModelAllowlist)
          .where(
            and(
              eq(schema.projectModelAllowlist.projectId, identity.projectId),
              eq(schema.projectModelAllowlist.provider, identity.provider),
              eq(schema.projectModelAllowlist.model, identity.model),
            ),
          )
          .for('update');
        const target: AllowlistReceipt = {
          commandId: input.commandId,
          provider: input.provider,
          model: input.model,
          state: input.enabled ? 'enabled' : 'disabled',
          changed: false,
        };
        if (input.enabled) {
          if (row?.state === 'enabled') target.changed = false;
          else {
            await tx
              .insert(schema.projectModelAllowlist)
              .values({
                ...identity,
                state: 'enabled',
                revision: randomUUID(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [
                  schema.projectModelAllowlist.projectId,
                  schema.projectModelAllowlist.provider,
                  schema.projectModelAllowlist.model,
                ],
                set: {
                  state: 'enabled',
                  revision: randomUUID(),
                  updatedAt: new Date(),
                },
              });
            target.changed = true;
          }
        } else {
          const stopped = await tx
            .update(schema.projectModelAllowlist)
            .set({
              state: 'disabled',
              revision: randomUUID(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.projectModelAllowlist.projectId, identity.projectId),
                eq(schema.projectModelAllowlist.provider, identity.provider),
                eq(schema.projectModelAllowlist.model, identity.model),
                eq(schema.projectModelAllowlist.state, 'enabled'),
              ),
            )
            .returning({ state: schema.projectModelAllowlist.state });
          target.changed = stopped.length > 0;
        }
        await tx
          .update(schema.commandReceipt)
          .set({ result: target })
          .where(condition);
        if (session.expiresAt <= new Date()) businessError(401, '登录已失效');
        return { ...target, replayed: false };
      });
      responseScopes.set(request, {
        ...who,
        epoch,
        projectId,
        memberOnly: true,
      });
      assertResponse({ ...who, epoch, projectId });
      return result;
    },
  );
}
