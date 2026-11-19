import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RequirementImportInput,
  RequirementImportPreviewInput,
  importColumns,
  importLimits,
  type RequirementImportRow,
  type RequirementImportReceipt,
} from '@rdws/contracts';
import { businessError } from './business.ts';
import { inArray } from 'drizzle-orm';
import { schema } from '@rdws/db';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { importPreviewPath, importCommitPath } from './workbench-paths.ts';
import { type WorkbenchRuntime } from './workbench-runtime.ts';

export function registerRequirementImport(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const {
    actor,
    assertResponse,
    business,
    db,
    mirrors,
    requestDemandScope,
    responseScopes,
    verifyEditLogin,
    worktreesFor,
  } = workbench;

  const importRoute = {
    bodyLimit: importLimits.bytes,
    attachValidation: true,
    async onRequest(request: FastifyRequest, reply: FastifyReply) {
      reply.header('cache-control', 'no-store');
      const epoch = workbench.authorizationEpoch;
      const who = await actor(request.headers);
      verifyEditLogin(request, who.authSessionId);
      const { projectId } = request.params as { projectId: string };
      const scope = { ...who, projectId, epoch, importReply: [] as string[] };
      assertResponse(scope);
      await business.authorizeImport(who, projectId);
      assertResponse(scope);
      responseScopes.set(request, scope);
    },
    async preValidation(request: FastifyRequest, reply: FastifyReply) {
      const raw: unknown = request.body;
      const commit = request.routeOptions.url === importCommitPath;
      const columns = Object.keys(importColumns);
      if (
        !isRecord(raw) ||
        !onlyKeys(raw, commit ? ['commandId', 'rows'] : ['rows']) ||
        (commit && typeof raw.commandId !== 'string') ||
        !Array.isArray(raw.rows) ||
        raw.rows.length > importLimits.rows ||
        !raw.rows.every(
          (row) =>
            isRecord(row) &&
            onlyKeys(row, ['row', ...columns]) &&
            typeof row.row === 'number' &&
            columns.every(
              (field) =>
                typeof row[field] === 'string' &&
                !/[\0\p{Surrogate}]/u.test(row[field]),
            ),
        ) ||
        new Set(raw.rows.map((row) => row.row)).size !== raw.rows.length
      )
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
    },
  };

  app.post<{ Body: { rows: RequirementImportRow[] } }>(
    importPreviewPath,
    {
      ...importRoute,
      schema: { body: RequirementImportPreviewInput },
    },
    async (request, reply) => {
      if (request.validationError)
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
      const scope = requestDemandScope(request);
      return business.previewImport(scope, scope.projectId, request.body.rows);
    },
  );

  app.post<{ Body: RequirementImportInput }>(
    importCommitPath,
    {
      ...importRoute,
      schema: { body: RequirementImportInput },
    },
    async (request, reply) => {
      if (request.validationError)
        return reply.code(400).send({
          code: 'invalid-import',
          error: '导入行的编号、字段或文本格式不正确',
        });
      const scope = requestDemandScope(request);
      const input = request.body;
      let receipt = await business.findImportReceipt(
        scope,
        scope.projectId,
        input,
      );
      if (!receipt) {
        let baselines:
          Awaited<ReturnType<typeof mirrors.captureBaselines>> | undefined;
        try {
          baselines = await mirrors.captureBaselines(scope.projectId);
        } catch {
          receipt = await business.findImportReceipt(
            scope,
            scope.projectId,
            input,
          );
          if (!receipt) businessError(503, '暂未取得已验基线，请核对原批次');
        }
        if (!receipt && baselines) {
          assertResponse(scope);
          receipt = await business.commitImport(
            scope,
            scope.projectId,
            input,
            baselines,
            () => assertResponse(scope),
          );
        }
      }
      if (receipt === 'conflict')
        return reply.code(409).send({
          code: 'command-conflict',
          error: '操作标识已用于不同内容，请重新校验后提交',
        });
      if (!receipt) businessError(503, '导入结果待核对，请重试原批次');
      if (receipt.status === 'rejected') return receipt;
      const ids = receipt.rows.map((row) => row.id);
      const scoped = { ...scope, importReply: ids };
      responseScopes.set(request, scoped);
      await business.authorizeImport(scope, scope.projectId, ids);
      assertResponse(scoped);
      const registered = await db
        .select()
        .from(schema.requirementWorktreePlan)
        .where(inArray(schema.requirementWorktreePlan.requirementId, ids));
      const plans = new Map(
        registered.map((row) => [row.requirementId, row.repositories]),
      );
      const rows: Extract<
        RequirementImportReceipt,
        { status: 'created' }
      >['rows'] = [];
      for (let offset = 0; offset < receipt.rows.length; offset += 4) {
        assertResponse(scoped);
        rows.push(
          ...(await Promise.all(
            receipt.rows.slice(offset, offset + 4).map(async (row) => {
              const plan = plans.get(row.id);
              const workspaceState = plan
                ? (await worktreesFor(scope.projectId).ready(
                    scope.projectId,
                    row.id,
                    plan,
                  ))
                  ? 'ready'
                  : 'pending'
                : 'unconfigured';
              return { ...row, workspaceState } as const;
            }),
          )),
        );
      }
      return { ...receipt, rows };
    },
  );
}
