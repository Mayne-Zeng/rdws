import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  SessionCreate,
  SessionFork,
  type SessionAnchorPage,
  type SessionExecutionPage,
  type SessionTemplateStatus,
} from '@rdws/contracts';
import { schema } from '@rdws/db';
import { and, eq, sql } from 'drizzle-orm';
import { projectSessionExecution, sessionPage } from '@rdws/dsh/sessions';
import { readPilotModelOptions } from './native-projects.ts';
import { isDemandPreset } from '@rdws/dsh/web';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import {
  sessionsPath,
  sessionHistoryPath,
  sessionForkPath,
  sessionTemplatePath,
  sessionAnchorsPath,
  sessionExecutionPath,
  sessionModelSelectionPath,
  promptReceiptPath,
} from './workbench-paths.ts';
import { digestOf } from './business.ts';
import { fail, type WorkbenchRuntime } from './workbench-runtime.ts';
import { isMicrosecondTimestamp } from './workbench-audit.ts';

const anchorPageSize = 25;
const anchorId = /^[a-f0-9]{64}$/;
const executionPageSize = 50;

function executionPosition(value: unknown) {
  return typeof value === 'string' &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
}

export function registerSessions(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const {
    access,
    bridges,
    business,
    closingSessions,
    confirmAccess,
    db,
    grant,
    modelSelection,
    prepared,
    projects,
    ready,
    readyAccess,
    requestDemandScope,
    revoke,
    stale,
    verifyEditLogin,
    worktreeReady,
  } = workbench;

  if (modelSelection) {
    const { policy, store } = modelSelection;
    async function selectionScope(request: FastifyRequest) {
      const { id, sessionId } = request.params as {
        id: string;
        sessionId: string;
      };
      const original = await access(request.headers, id);
      if (original.item.projectId !== policy.projectId)
        fail(404, '会话选模暂不可用');
      verifyEditLogin(request, original.who.authSessionId, true);
      const current = () => {
        if (stale(original)) fail(401, '授权已变化');
      };
      return {
        original,
        current,
        scope: {
          who: original.who,
          projectId: policy.projectId,
          requirementId: id,
          sessionId,
        },
      };
    }
    app.get(
      sessionModelSelectionPath,
      { exposeHeadRoute: false },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const { original, current, scope } = await selectionScope(request);
        const result = await store.read(scope, current);
        await confirmAccess(request.headers, original);
        return result;
      },
    );
    app.post(promptReceiptPath, async (request, reply) => {
      const { original, current, scope } = await selectionScope(request);
      const input = request.body;
      if (
        !isRecord(input) ||
        !onlyKeys(input, [
          'requestId',
          'sessionId',
          'content',
          'mode',
          'clientTimeZone',
        ]) ||
        input.sessionId !== scope.sessionId ||
        typeof input.requestId !== 'string' ||
        !input.requestId ||
        input.requestId.length > 128 ||
        input.mode !== 'queue' ||
        !Array.isArray(input.content) ||
        input.content.length !== 1 ||
        !isRecord(input.content[0]) ||
        !onlyKeys(input.content[0], ['type', 'text']) ||
        input.content[0].type !== 'text' ||
        typeof input.content[0].text !== 'string' ||
        (input.clientTimeZone !== undefined &&
          typeof input.clientTimeZone !== 'string')
      )
        fail(400, '原消息核对参数无效');
      const row = await store.lookupPrompt(
        scope,
        { requestId: input.requestId, inputDigest: digestOf(input) },
        current,
      );
      await confirmAccess(request.headers, original);
      return reply.header('cache-control', 'no-store').send({
        requestId: input.requestId,
        state: row?.state === 'accepted' ? 'accepted' : 'unknown',
      });
    });
    app.post(sessionModelSelectionPath, async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const data = request.body;
      if (
        !isRecord(data) ||
        !onlyKeys(data, ['commandId', 'provider', 'model', 'supersedes']) ||
        typeof data.commandId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.commandId) ||
        typeof data.provider !== 'string' ||
        !data.provider ||
        data.provider.length > 160 ||
        typeof data.model !== 'string' ||
        !data.model ||
        data.model.length > 160
      )
        fail(400, '会话选模命令格式不正确');
      const { original, current, scope } = await selectionScope(request);
      const saved = await store.save(
        scope,
        {
          commandId: data.commandId,
          provider: data.provider,
          model: data.model,
          supersedes: data.supersedes,
        },
        current,
        async () => {
          const preparedScope = await readyAccess(request.headers, original);
          return readPilotModelOptions(
            preparedScope.runtime,
            grant(preparedScope),
          );
        },
      );
      await confirmAccess(request.headers, original);
      return reply
        .header('x-rdws-model-command', data.commandId)
        .send({ selection: saved });
    });
  }

  app.get(sessionsPath, async (request) => {
    const scope = await access(
      request.headers,
      (request.params as { id: string }).id,
    );
    return {
      sessions: scope.sessions.map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        own: row.ownerId === scope.who.userId,
        sourceSessionId: row.sourceSessionId,
        sourceThroughSeq: row.sourceThroughSeq,
      })),
    };
  });

  app.get<{ Params: { id: string; sessionId: string } }>(
    sessionAnchorsPath,
    { exposeHeadRoute: false },
    async (request): Promise<SessionAnchorPage> => {
      const scope = requestDemandScope(request);
      const { id, sessionId } = request.params;
      if (scope.requirementId !== id) fail(404, '需求不存在');
      await business.authorizeRequirement(
        scope,
        id,
        scope.projectId,
        'reader',
        undefined,
        sessionId,
      );
      const query = request.query;
      if (!isRecord(query) || !onlyKeys(query, ['beforeAt', 'beforeId']))
        fail(400, '锚点读取参数不正确');
      const { beforeAt, beforeId } = query;
      if (
        (beforeAt !== undefined || beforeId !== undefined) &&
        (!isMicrosecondTimestamp(beforeAt) ||
          typeof beforeId !== 'string' ||
          !anchorId.test(beforeId))
      )
        fail(400, '锚点分页位置不正确');
      const page = await db
        .execute<{
          anchor_id: string;
          recorded_at: string;
          through_byte: string;
          sha256: string;
        }>(
          sql`select anchor_id, recorded_at, through_byte, sha256
        from public.read_session_log_anchors(${scope.projectId}, ${id}, ${sessionId},
          ${scope.userId}, ${scope.authSessionId}, ${beforeAt ?? null}::timestamptz, ${beforeId ?? null})
        order by recorded_at collate "C" desc, anchor_id collate "C" desc`,
        )
        .catch((error: unknown) => {
          const failure = error as { code?: string; cause?: { code?: string } };
          const code = failure.cause?.code ?? failure.code;
          if (code === '42883' || code === '42501')
            fail(503, '锚点读取暂不可用');
          throw error;
        });
      const items = page.rows.slice(0, anchorPageSize).map((row) => ({
        id: row.anchor_id,
        recordedAt: row.recorded_at,
        throughByte: Number(row.through_byte),
        sha256: row.sha256,
      }));
      const tail = items.at(-1);
      return {
        projectId: scope.projectId,
        requirementId: id,
        sessionId,
        items,
        next:
          tail && page.rows.length > anchorPageSize
            ? { id: tail.id, recordedAt: tail.recordedAt }
            : null,
      };
    },
  );

  app.get<{ Params: { id: string; sessionId: string } }>(
    sessionExecutionPath,
    { exposeHeadRoute: false },
    async (request): Promise<SessionExecutionPage> => {
      const original = requestDemandScope(request);
      const { id, sessionId } = request.params;
      if (original.requirementId !== id) fail(404, '需求不存在');
      await business.authorizeRequirement(
        original,
        id,
        original.projectId,
        'reader',
        undefined,
        sessionId,
      );
      const query = request.query;
      if (!isRecord(query) || !onlyKeys(query, ['throughSeq', 'beforeSeq']))
        fail(400, '执行事件读取参数不正确');
      const throughSeq = executionPosition(query.throughSeq);
      const beforeSeq = executionPosition(query.beforeSeq);
      if (
        (query.throughSeq !== undefined || query.beforeSeq !== undefined) &&
        (throughSeq === undefined ||
          beforeSeq === undefined ||
          beforeSeq < 1 ||
          beforeSeq > throughSeq)
      )
        fail(400, '执行事件分页位置不正确');
      const scope = await access(request.headers, id);
      if (
        scope.who.userId !== original.userId ||
        scope.who.authSessionId !== original.authSessionId ||
        scope.item.projectId !== original.projectId
      )
        fail(401, '授权已变化');
      const session = scope.sessions.find((row) => row.id === sessionId);
      if (!session) fail(403, '无权读取该会话执行事件');
      if (!scope.item.nativeWorkspaceId) fail(503, '执行事件暂不可用');
      const runtime = await projects.get(original.projectId);
      const delegation = {
        ...grant({ ...scope, runtime, epoch: original.epoch }),
        readSessionIds: [sessionId],
        ownSessionIds: [],
      };
      const page = await sessionPage(
        runtime.native,
        delegation,
        sessionId,
        throughSeq,
        beforeSeq,
      ).catch(() => fail(503, '执行事件暂不可用'));
      if (
        beforeSeq !== undefined &&
        page.records.some(({ event }) => event.seq >= beforeSeq)
      )
        fail(503, '执行事件分页位置已变化');
      const retained = page.records.slice(-executionPageSize);
      const leading = retained[0];
      return {
        projectId: original.projectId,
        requirementId: id,
        sessionId,
        sessionOwnerId: session.ownerId,
        throughSeq: page.cursor,
        next:
          leading && (page.hasMore || retained.length < page.records.length)
            ? { throughSeq: page.cursor, beforeSeq: leading.event.seq }
            : null,
        events: projectSessionExecution(retained, session),
      };
    },
  );

  app.get<{ Params: { id: string; sessionId: string } }>(
    sessionTemplatePath,
    async (request): Promise<SessionTemplateStatus> => {
      const { id, sessionId } = request.params;
      const scope = await access(request.headers, id);
      if (!scope.sessions.some((row) => row.id === sessionId))
        fail(403, '无权读取该会话模板');
      const { projectId, nativeWorkspaceId } = scope.item;
      let status: SessionTemplateStatus = { status: 'unavailable' };
      const runtime = nativeWorkspaceId
        ? await projects.get(projectId).catch(() => undefined)
        : undefined;
      if (runtime) {
        const { native } = runtime;
        const identity = await native
          .start()
          .then(() =>
            native.control('session.preset', { requirementId: id, sessionId }),
          )
          .catch(() => undefined);
        if (
          identity?.workspaceId === nativeWorkspaceId &&
          identity?.cwd === join(native.demandRoot, id)
        ) {
          const preset = identity.agentPreset;
          if (isDemandPreset(preset)) {
            const definition = await native.presets
              .read(preset, id)
              .catch(() => undefined);
            if (definition && definition.revision <= 2147483647) {
              const { templateId, revision } = definition;
              const versions = schema.capabilityTemplateRevision;
              const [version] = await db
                .select({ name: versions.name })
                .from(versions)
                .where(
                  and(
                    eq(versions.projectId, projectId),
                    eq(versions.templateId, templateId),
                    eq(versions.revision, revision),
                  ),
                );
              if (version)
                status = {
                  status: 'recorded',
                  templateId,
                  revision,
                  name: version.name,
                };
            }
          } else if (
            preset === null ||
            (typeof preset === 'string' &&
              /^[a-zA-Z0-9._-]{1,128}$/.test(preset) &&
              !preset.startsWith('rdws-demand-'))
          ) {
            status = { status: 'unbound' };
          }
        }
      }
      const fresh = await confirmAccess(request.headers, scope);
      if (!fresh.sessions.some((row) => row.id === sessionId))
        fail(403, '无权读取该会话模板');
      return fresh.item.nativeWorkspaceId === nativeWorkspaceId
        ? status
        : { status: 'unavailable' };
    },
  );

  async function sessionOperation(
    request: FastifyRequest,
    sourceSessionId?: string,
  ) {
    const requirementId = (request.params as { id: string }).id;
    const scope = await access(request.headers, requirementId);
    const assertOpen = () => {
      if (stale(scope)) fail(401, '授权已变化');
    };
    await worktreeReady(scope);
    const runtime = await projects.get(scope.item.projectId);
    return runtime.sessions.execute(
      scope.who,
      requirementId,
      (request.body as { commandId?: string })?.commandId ?? randomUUID(),
      sourceSessionId,
      {
        assertOpen,
        current: async () => {
          assertOpen();
          await access(request.headers, requirementId);
          assertOpen();
        },
        prepare: async () => {
          const fresh = await ready(request.headers, requirementId);
          assertOpen();
          return {
            workspaceId: fresh.item.nativeWorkspaceId!,
            cwd: join(fresh.runtime.native.demandRoot, requirementId),
            grant: grant(fresh),
          };
        },
        mapped: async () => {
          const groups = new Set([
            scope.who.authSessionId,
            ...[...bridges]
              .filter((item) => item.requirementId === requirementId)
              .map((item) => item.authSessionId),
          ]);
          for (const group of groups)
            await revoke(
              group,
              requirementId,
              scope.item.projectId,
              Date.now(),
              false,
            );
        },
        validateReturn: async () => {
          await access(request.headers, requirementId);
          await business.sessionTransaction(
            scope.who,
            requirementId,
            scope.item.projectId,
            sourceSessionId,
            async () => {
              if (closingSessions.has(scope.who.authSessionId))
                fail(401, '登录已失效');
            },
          );
        },
      },
    );
  }

  const validateSessionBody = async (request: FastifyRequest) => {
    if (!onlyKeys(request.body, ['commandId']))
      fail(400, '会话参数由服务器确定');
  };

  app.post(
    sessionsPath,
    {
      schema: { body: SessionCreate },
      preValidation: async (request) => {
        request.body ??= {};
        await validateSessionBody(request);
      },
    },
    async (request, reply) => {
      const result = await sessionOperation(request);
      return reply
        .code(
          result.status === 'mapped'
            ? 200
            : result.status === 'rejected'
              ? 409
              : 202,
        )
        .send(result);
    },
  );

  app.post(
    sessionForkPath,
    { schema: { body: SessionFork }, preValidation: validateSessionBody },
    async (request, reply) => {
      const result = await sessionOperation(
        request,
        (request.params as { sessionId: string }).sessionId,
      );
      return reply
        .code(
          result.status === 'mapped'
            ? 200
            : result.status === 'rejected'
              ? 409
              : 202,
        )
        .send(result);
    },
  );

  app.get<{ Params: { id: string; sessionId: string } }>(
    sessionHistoryPath,
    async (request) => {
      const { id, sessionId } = request.params;
      const scope = await access(request.headers, id);
      if (!scope.sessions.some((s) => s.id === sessionId))
        fail(403, '无权读取该会话历史');
      const query = request.query as Record<string, string>;
      if (!onlyKeys(query, ['throughSeq', 'beforeSeq', 'pageSize']))
        fail(400, '回放参数不正确');
      function position(key: string, min: number) {
        const value = query[key];
        if (value === undefined) return undefined;
        if (
          !/^-?\d+$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < min
        )
          fail(400, '回放位置不正确');
        return Number(value);
      }
      const runtime = await prepared(scope);
      const pageSize = position('pageSize', 1) ?? 20;
      if (pageSize > 50) fail(400, '回放每页最多读取 50 条消息');
      const page = await sessionPage(
        runtime.native,
        grant({ ...scope, runtime }),
        sessionId,
        position('throughSeq', -1),
        position('beforeSeq', 0),
        pageSize,
      );
      const fresh = await confirmAccess(request.headers, scope);
      if (!fresh.sessions.some((s) => s.id === sessionId))
        fail(403, '无权读取该会话历史');
      const labels: Record<string, string> = {
        'turn/start': '轮次开始',
        'turn/end': '轮次结束',
        'user/message': '用户消息',
        'assistant/message': '助手回复',
        'agent/error': '本轮发生错误',
      };
      const events = page.records.flatMap(({ event }) => {
        if (!Object.hasOwn(labels, event.type)) return [];
        const label = labels[event.type];
        let text: string | undefined;
        if (['user/message', 'assistant/message'].includes(event.type)) {
          if (
            event.type === 'user/message' &&
            (!isRecord(event.data.source) ||
              !['user', 'retry'].includes(String(event.data.source.kind)))
          )
            return [];
          const message = isRecord(event.data.message)
            ? event.data.message
            : {};
          const content = message.content ?? event.data.content;
          text =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (p) =>
                        isRecord(p) &&
                        p.type === 'text' &&
                        typeof p.text === 'string',
                    )
                    .map((p) => p.text)
                    .join('')
                : '';
        }
        const reason = isRecord(event.data.reason)
          ? event.data.reason.kind
          : undefined;
        const outcomes: Record<string, string> = {
          completed: '已完成',
          interrupted: '已中断',
          forked: '派生时结束',
          cancelled: '已取消',
          blocked: '已阻止',
          failed: '执行失败',
        };
        return [
          {
            seq: event.seq,
            type: event.type,
            label,
            ...(text === undefined ? {} : { text }),
            ...(event.type === 'turn/end'
              ? { outcome: outcomes[String(reason)] ?? '已结束' }
              : {}),
          },
        ];
      });
      return {
        cursor: page.cursor,
        beforeSeq: page.records[0]?.event.seq ?? 0,
        hasMore: page.hasMore,
        events,
      };
    },
  );
}
