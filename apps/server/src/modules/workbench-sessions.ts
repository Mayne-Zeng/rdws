import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionCreate, SessionFork } from '@rdws/contracts';
import { sessionPage } from '@rdws/dsh/sessions';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import {
  sessionsPath,
  sessionHistoryPath,
  sessionForkPath,
} from './workbench-paths.ts';
import { fail, type WorkbenchRuntime } from './workbench-runtime.ts';

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
    grant,
    prepared,
    projects,
    ready,
    revoke,
    stale,
    worktreeReady,
  } = workbench;

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
