import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { businessError } from './business.ts';
import { type ProjectRuntime } from './native-projects.ts';
import { type RunBinding } from './runtime-context.ts';
import { actionAllowed, isRecord, targetSession } from '@rdws/dsh/access';
import {
  authorizeStreamFrame,
  createNativeStreamState,
  publicModelCatalogValue,
  publicNativeSessionResponse,
  publicNativeStreamFrame,
  withNativeEnvelope,
} from '@rdws/dsh/wire';
import {
  nativeBootstrapPath,
  nativeTransportPath,
  nativeMuxPath,
} from './workbench-paths.ts';
import {
  fail,
  PendingAuthority,
  type WorkbenchRuntime,
  type Access,
  type ReadyAccess,
} from './workbench-runtime.ts';

function publicModelCatalog(
  response: Response,
  rpcId: unknown,
  allowed: ProjectRuntime['catalogModel'],
) {
  const message = '模型目录暂不可用';
  return withNativeEnvelope(
    response,
    rpcId,
    (result) => {
      if (result.ok === false)
        return {
          ok: false,
          error: { code: 'gateway/internal', message, details: {} },
        };
      if (result.ok !== true) return;
      const catalog = publicModelCatalogValue(result.value);
      if (!catalog) return;
      if (!allowed) return { ok: true, value: catalog };
      const groups = catalog.groups.flatMap((group) => {
        if (
          group.id !== allowed.provider ||
          !catalog.routableProviders.includes(group.id)
        )
          return [];
        const models = group.models.filter(({ id }) => id === allowed.model);
        return models.length ? [{ ...group, models }] : [];
      });
      return {
        ok: true,
        value: {
          ...catalog,
          groups,
          routableProviders: groups.length ? [allowed.provider] : [],
          failures: catalog.failures.filter(
            ({ id }) => id === allowed.provider,
          ),
        },
      };
    },
    () => fail(503, message),
  );
}

export async function registerNativeTransport(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const {
    access,
    blocked,
    bridges,
    confirmAccess,
    expectedOrigin,
    grant,
    lease,
    loginBinding,
    nativeCarrier,
    readyAccess,
    revoke,
    stale,
    transfers,
    verifyEditLogin,
    verifyNativeLogin,
  } = workbench;

  async function confirmRunCancellation(
    runtime: ProjectRuntime,
    runId: string,
  ) {
    const result = await runtime.native.control('run.cancel', { runId });
    if (!isRecord(result) || result.cancelled !== true)
      fail(503, '原生运行的取消尚未确认，请稍后重试');
    runtime.abandonedRuns.delete(runId);
  }

  async function activeRunIds(native: ProjectRuntime['native']) {
    const result = await native.control('runs.active', {});
    if (
      !isRecord(result) ||
      !Array.isArray(result.runIds) ||
      !result.runIds.every(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
    )
      return;
    return new Set(result.runIds);
  }

  async function reconcileRuns(runtime: ProjectRuntime) {
    const candidates = runtime.runs.submittedIds();
    if (!candidates.length) return;
    const first = await activeRunIds(runtime.native);
    if (!first) return;
    const missing = candidates.filter((id) => !first.has(id));
    if (!missing.length) return;
    const second = await activeRunIds(runtime.native);
    if (!second) return;
    for (const id of runtime.runs.reconcile(missing, second))
      runtime.abandonedRuns.add(id);
  }

  async function retireRun(runtime: ProjectRuntime, runId: string) {
    runtime.runs.discard(runId);
    runtime.abandonedRuns.add(runId);
    try {
      await confirmRunCancellation(runtime, runId);
    } catch {
      return;
    }
  }

  app.get(nativeBootstrapPath, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requirementId = (request.params as { id: string }).id;
    const original = await access(request.headers, requirementId);
    verifyEditLogin(request, original.who.authSessionId, true);
    const scope = await readyAccess(request.headers, original);
    const response = await scope.runtime.native.fetch(
      '/api/rdws/bootstrap',
      grant(scope),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(503, '会话运行时暂不可用');
    }
    const data = await response.json();
    const fresh = await confirmAccess(request.headers, original);
    return {
      ...data,
      loginBinding: loginBinding(fresh),
      modelEgressPaused: scope.runtime.native.modelEgress === 'paused',
    };
  });

  async function allowedAsset(scope: ReadyAccess, path: string) {
    if (path.includes('..') || decodeURIComponent(path).includes('..'))
      return false;
    const response = await scope.runtime.native.fetch(
      '/api/rdws/bootstrap',
      grant(scope),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const data = (await response.json()) as {
      graph: {
        entries: { id: string; url: string }[];
        batches?: { url: string }[];
      };
    };
    if (
      [...data.graph.entries, ...(data.graph.batches ?? [])].some(
        (row) => '/' + row.url.replace(/^\//, '') === path,
      )
    )
      return true;
    return data.graph.entries.some((row) =>
      path.startsWith('/plugins/' + row.id + '/assets/'),
    );
  }

  app.route({
    method: ['GET', 'POST'],
    url: nativeTransportPath,
    handler: async (request, reply) => {
      const { id, '*': tail } = request.params as { id: string; '*': string };
      const original = await access(request.headers, id);
      const carrier =
        request.method === 'POST' ? nativeCarrier(request, false) : undefined;
      if (carrier) verifyNativeLogin(original, carrier.binding);
      const scope = await readyAccess(request.headers, original);
      const { native, runs, inFlightPrompts, acceptedPrompts, abandonedRuns } =
        scope.runtime;
      const path =
        '/' +
        tail +
        (request.method === 'GET'
          ? new URL(request.url, 'http://rdws.invalid').search
          : '');
      if (request.method === 'GET') {
        if (!(await allowedAsset(scope, path))) fail(403, '不允许读取该资源');
      } else {
        const action = tail.startsWith('api/') ? tail.slice(4) : '';
        const body = request.body;
        if (
          !isRecord(body) ||
          body.method !== action ||
          body.type !== 'client-request' ||
          !isRecord(body.payload) ||
          !isRecord(body.payload.args) ||
          !actionAllowed(
            {
              ...grant(scope),
              aud: native.audience,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 20000,
              nonce: 'bff',
            },
            action,
            body.payload.args,
          )
        )
          fail(403, '无权执行该会话操作');
        if (action === 'session/cancel') {
          const session = targetSession(body.payload.args);
          if (session) runs.cancelTitle(session);
        }
      }
      const transfer = {
        ...scope.who,
        requirementId: id,
        projectId: scope.item.projectId,
        controller: new AbortController(),
        revoked: false,
      };
      transfers.add(transfer);
      let pendingRun: RunBinding | undefined;
      let promptKey: string | undefined;
      try {
        const token = carrier ? lease(scope, carrier.generation) : grant(scope);
        if (
          request.method === 'POST' &&
          isRecord(request.body) &&
          request.body.method === 'session/prompt'
        ) {
          const args = (
            request.body.payload as {
              args: { request: { sessionId: string; requestId: string } };
            }
          ).args.request;
          const claims = native.claims(String(token));
          if (!claims || typeof args.requestId !== 'string')
            fail(403, '会话请求身份无效');
          if (native.modelEgress === 'paused') {
            if (
              !args.requestId ||
              args.requestId.length > 128 ||
              typeof request.body.rpcId !== 'string' ||
              !request.body.rpcId
            )
              fail(403, '会话请求身份无效');
            await confirmAccess(request.headers, original);
            if (
              transfer.revoked ||
              stale(original) ||
              claims.expiresAt <= Date.now()
            )
              fail(401, '授权已变化');
            return reply
              .code(503)
              .header('x-rdws-model-egress', 'paused')
              .header('cache-control', 'no-store')
              .send({ error: '模型发送已暂停，请在恢复后重试。' });
          }
          const key = JSON.stringify([args.sessionId, args.requestId]);
          if (inFlightPrompts.has(key))
            businessError(409, '原消息正在提交，请稍后核对');
          inFlightPrompts.add(key);
          promptKey = key;
          for (const [key, time] of acceptedPrompts)
            if (time < Date.now()) acceptedPrompts.delete(key);
          if (!acceptedPrompts.has(promptKey)) {
            await reconcileRuns(scope.runtime);
            for (const runId of abandonedRuns)
              await confirmRunCancellation(scope.runtime, runId);
            await confirmAccess(request.headers, original);
            if (transfer.revoked || stale(original)) fail(401, '授权已变化');
            pendingRun = runs.admit(
              scope.who,
              id,
              args.sessionId,
              args.requestId,
              claims.nonce,
            );
            await native.control('run', {
              ...pendingRun,
              authSessionId: scope.who.authSessionId,
            });
          }
          await confirmAccess(request.headers, original);
          if (transfer.revoked || stale(original)) fail(401, '授权已变化');
        }
        let response = await native.fetch(path, token, {
          method: request.method,
          signal: transfer.controller.signal,
          ...(request.method === 'POST'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request.body),
              }
            : {}),
        });
        if (request.method === 'POST') {
          const rpcId = (request.body as { rpcId?: unknown }).rpcId;
          response =
            path === '/api/session/modelCatalog'
              ? await publicModelCatalog(
                  response,
                  rpcId,
                  scope.runtime.catalogModel,
                )
              : await publicNativeSessionResponse(response, rpcId, path);
        }
        reply.code(response.status);
        for (const [key, value] of response.headers)
          if (
            ![
              'content-encoding',
              'content-length',
              'connection',
              'set-cookie',
              'transfer-encoding',
              'keep-alive',
              'upgrade',
              'te',
              'trailer',
            ].includes(key)
          )
            reply.header(key, value);
        const data = Buffer.from(await response.arrayBuffer());
        if (promptKey) {
          let accepted = false;
          try {
            const value = JSON.parse(data.toString());
            accepted =
              response.ok &&
              value.result?.ok === true &&
              value.result?.value?.accepted === true;
          } catch {
            accepted = false;
          }
          if (accepted) {
            acceptedPrompts.set(promptKey, Date.now() + 30 * 60 * 1000);
            if (acceptedPrompts.size > 4096)
              acceptedPrompts.delete(acceptedPrompts.keys().next().value!);
            if (pendingRun) {
              runs.submitted(pendingRun.runId);
              let seen = false;
              try {
                seen =
                  (
                    await native.control('run.status', {
                      runId: pendingRun.runId,
                    })
                  ).seen === true;
              } catch {
                seen = false;
              }
              if (!seen) await retireRun(scope.runtime, pendingRun.runId);
              pendingRun = undefined;
            }
          }
        }
        await confirmAccess(request.headers, original);
        if (transfer.revoked || stale(original)) fail(401, '授权已变化');
        return reply.send(data);
      } finally {
        try {
          if (pendingRun) await retireRun(scope.runtime, pendingRun.runId);
        } finally {
          if (promptKey) inFlightPrompts.delete(promptKey);
          transfers.delete(transfer);
        }
      }
    },
  });

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  const upgradeAccess = new WeakMap<
    FastifyRequest,
    { original: Access; generation: string }
  >();

  app.get(
    nativeMuxPath,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (
          Object.keys(request.headers).some((key) => key.startsWith('x-rdws-'))
        )
          return reply.code(403).send({ error: '身份头不受信任' });
        if (request.headers.origin !== expectedOrigin)
          return reply.code(403).send({ error: '请求来源不受信任' });
        let original: Access;
        try {
          original = await access(
            request.headers,
            (request.params as { id: string }).id,
          );
        } catch {
          return reply.code(403).send({ error: '无权连接会话' });
        }
        const { binding, generation } = nativeCarrier(request, true);
        verifyNativeLogin(original, binding);
        upgradeAccess.set(request, { original, generation });
      },
    },
    (browser, request) => {
      const { original, generation } = upgradeAccess.get(request)!;
      const requirementId = original.item.id;
      let stopped = false;
      let upstream: WebSocket | undefined;
      let hostSignal: AbortSignal | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let chain = Promise.resolve();
      const opened = createNativeStreamState();
      const close = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        hostSignal?.removeEventListener('abort', close);
        upstream?.close();
        browser.close(4001, 'access changed');
        bridges.delete(bridge);
      };
      const bridge = {
        authSessionId: original.who.authSessionId,
        userId: original.who.userId,
        requirementId,
        projectId: original.item.projectId,
        close,
      };
      const connection = (async () => {
        const scope = await readyAccess(request.headers, original);
        const { native } = scope.runtime;
        if (stopped) return;
        if (stale(original)) return close();
        bridges.add(bridge);
        hostSignal = native.signal;
        hostSignal.addEventListener('abort', close, { once: true });
        if (hostSignal.aborted) {
          close();
          return;
        }
        upstream = new WebSocket(native.socketUrl(), {
          agent: false,
          followRedirects: false,
          headers: {
            'x-rdws-delegation': lease(scope, generation),
            origin: new URL(native.socketUrl()).origin.replace('ws:', 'http:'),
          },
        });
        upstream.on('message', (data) => {
          if (
            stopped ||
            stale(original) ||
            browser.readyState !== WebSocket.OPEN
          )
            return;
          try {
            const frame = publicNativeStreamFrame(data.toString(), opened);
            if (frame !== undefined) browser.send(frame);
          } catch {
            close();
          }
        });
        upstream.on('close', close);
        upstream.on('error', close);
        timer = setInterval(() => {
          if (
            blocked(bridge.userId, bridge.projectId, undefined, requirementId)
          )
            return;
          void confirmAccess(request.headers, original).catch(async (error) => {
            if (
              error instanceof PendingAuthority ||
              blocked(bridge.userId, bridge.projectId, undefined, requirementId)
            )
              return;
            close();
            if (!stale(original))
              await revoke(
                bridge.authSessionId,
                requirementId,
                bridge.projectId,
              );
          });
        }, 1000);
        await new Promise<void>((resolve, reject) => {
          upstream!.once('open', resolve);
          upstream!.once('error', reject);
        });
        return scope.runtime;
      })();
      browser.on('message', (data) => {
        chain = chain
          .then(async () => {
            const runtime = await connection;
            if (stopped || !runtime) return;
            if (
              blocked(bridge.userId, bridge.projectId, undefined, requirementId)
            )
              return;
            const scope = await confirmAccess(request.headers, original);
            const frame = authorizeStreamFrame(
              data.toString(),
              {
                ...grant({ ...scope, runtime }),
                aud: runtime.native.audience,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 20000,
                nonce: 'bff',
              },
              opened,
            );
            if (frame === undefined) return;
            if (
              runtime.native.modelEgress === 'paused' &&
              frame.type === 'open' &&
              frame.endpoint === 'session/prompt'
            ) {
              close();
              return;
            }
            if (!stopped && !stale(original)) upstream!.send(data.toString());
          })
          .catch((error) => {
            if (!(error instanceof PendingAuthority)) close();
          });
      });
      browser.on('close', close);
      browser.on('error', close);
      void connection.catch(close);
    },
  );
}
