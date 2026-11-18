import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  verifyGrant,
  signGrant,
  resourceRoles,
  bodyHash,
  LEASE_MS,
  actionAllowed,
  isRecord,
  onlyKeys,
} from '../../bridge/access.ts';
import { bootInjections } from '@deepseek-ai/dsh-client-modules';
import { RemoteStreamMuxServer } from '@deepseek-ai/dsh-api-gateway/src/stream-server.ts';
import { installContext } from './context.mjs';
export const name = 'rdws-access';
export const inject = [
  'connection',
  'remoteAccess',
  'webServer',
  'clientModules',
  'workspaceRegistry',
  'typertGateway',
  'tools',
  'sessionQuery',
];
export function apply(ctx, config) {
  if (process.send)
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  ctx.tools.guard(() => 'Tools are disabled in this RDWS stage');
  ctx.on(
    'agent/created',
    ({ agent }) => {
      agent.ctx.tools.restrict({ allow: [] });
    },
    { global: true },
  );
  const key = readFileSync(config.keyFile, 'utf8').trim();
  const peers = new Map();
  const revoked = new Map();
  const metrics = { accepted: 0, expired: 0, revoked: 0 };
  const group = (cap) => `${cap.authSessionId}:${cap.requirementId ?? '*'}`;
  const outdated = (cap) =>
    cap.issuedAt <= (revoked.get(cap.authSessionId + ':*') ?? 0) ||
    cap.issuedAt <= (revoked.get(group(cap)) ?? 0);
  function stop(record, reason) {
    if (!record.active) return;
    record.active = false;
    metrics[reason]++;
    for (const socket of record.sockets) socket.destroy();
    void record.peer.dispose().catch(() => {});
    peers.delete(record.cap.nonce);
  }
  function authenticate(request) {
    const cap = verifyGrant(
      key,
      request.headers['x-rdws-delegation'],
      config.audience,
    );
    if (
      !cap ||
      cap.hostGeneration !== config.contextGeneration ||
      outdated(cap)
    )
      return;
    if (
      cap.purpose === 'fork' &&
      !ctx.workspaceRegistry
        .list()
        .some(
          (workspace) =>
            workspace.id === cap.workspaceId &&
            workspace.path === cap.cwd &&
            cap.cwd === resolve(config.demandRoot, String(cap.requirementId)) &&
            workspace.sessionIds.includes(cap.sourceSessionId),
        )
    )
      return;
    let record = peers.get(cap.nonce);
    if (!record) {
      const peer = ctx.connection.createPeer({
        principal: {
          kind: 'rdws',
          nonce: cap.nonce,
          userId: cap.userId ?? 'service',
        },
        interactions: 'answer',
      });
      record = { cap, peer, active: true, sockets: new Set() };
      peers.set(cap.nonce, record);
      metrics.accepted++;
      const timer = setTimeout(
        () => stop(record, 'expired'),
        Math.max(1, cap.expiresAt - Date.now()),
      );
      timer.unref();
      peer.ctx.effect(() => () => clearTimeout(timer));
    }
    return record;
  }
  ctx.remoteAccess.registerPolicy('rdws', {
    bindings(principal) {
      const record = peers.get(principal.nonce);
      return record?.active && !outdated(record.cap)
        ? resourceRoles(record.cap)
        : [];
    },
    explain() {
      return 'rdws-scope';
    },
  });
  async function body(request) {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 64000) throw new Error('Request too large');
    }
    return text;
  }
  function register(route) {
    ctx.effect(() => ctx.webServer.register(route));
  }
  function route(operation, handler) {
    register({
      kind: 'exact',
      path: '/_rdws/' + operation,
      async handler(request, response) {
        try {
          const record = authenticate(request);
          const input = JSON.parse((await body(request)) || '{}');
          if (
            !record ||
            record.cap.purpose !== 'service' ||
            record.cap.operation !== operation ||
            record.cap.bodyHash !== bodyHash(input)
          ) {
            response.writeHead(401);
            response.end();
            return;
          }
          const answer = await handler(input);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer));
        } catch {
          response.writeHead(400);
          response.end(JSON.stringify({ error: 'invalid control request' }));
        }
      },
    });
  }
  const revokeContext = installContext(ctx, config, key, route);
  route('health', () => ({
    ready: true,
    metrics,
    proof: signGrant(key, {
      aud: 'rdws:ready:' + config.contextGeneration,
      purpose: 'service',
      hostGeneration: config.contextGeneration,
      bodyHash: bodyHash({ port: ctx.webServer.port }),
    }),
  }));
  if (process.send) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (!ctx.webServer.port || !process.connected) return;
        clearInterval(timer);
        process.send(
          {
            type: 'rdws-ready',
            generation: config.contextGeneration,
            port: ctx.webServer.port,
          },
          () => {},
        );
      }, 25);
      timer.unref();
      return () => clearInterval(timer);
    });
  }
  route('session.inspect', async (input) => {
    const workspace = ctx.workspaceRegistry
      .list()
      .find(
        (w) =>
          w.path === resolve(config.demandRoot, String(input.requirementId)) &&
          w.sessionIds.includes(input.sessionId),
      );
    if (!workspace) throw new Error('Session workspace mismatch');
    const observation = await ctx.sessionQuery.observeSession(input.sessionId);
    try {
      if (observation.header.cwd !== workspace.path)
        throw new Error('Session cwd mismatch');
      return { workspaceId: workspace.id, cwd: observation.header.cwd };
    } finally {
      observation[Symbol.dispose]();
    }
  });
  route('workspace', async (input) => {
    const path = resolve(input.cwd);
    if (
      !path.startsWith(resolve(config.demandRoot) + sep) ||
      !/^[a-f0-9-]{36}$/.test(input.requirementId) ||
      path !== resolve(config.demandRoot, input.requirementId) ||
      (await realpath(path)) !== path
    )
      throw new Error('Invalid workspace');
    const workspace = await ctx.workspaceRegistry.create(path, input.title);
    return { workspaceId: workspace.id };
  });
  route('revoke', (input) => {
    if (
      typeof input.authSessionId !== 'string' ||
      !Number.isFinite(input.before) ||
      input.before > Date.now() + 1000
    )
      throw new Error('Invalid revocation');
    const id = input.authSessionId + ':' + (input.requirementId ?? '*');
    const cutoff = Math.max(revoked.get(id) ?? 0, input.before);
    revoked.set(id, cutoff);
    if (input.invalidateRuns !== false)
      revokeContext(input.authSessionId, input.requirementId, cutoff);
    const timer = setTimeout(() => {
      if (revoked.get(id) === cutoff) revoked.delete(id);
    }, LEASE_MS + 2000);
    timer.unref();
    for (const record of [...peers.values()])
      if (outdated(record.cap)) stop(record, 'revoked');
    ctx.remoteAccess.invalidate();
    return { revoked: true };
  });
  register({
    kind: 'exact',
    path: '/_rdws/bootstrap',
    handler(request, response) {
      const record = authenticate(request);
      if (!record || record.cap.purpose !== 'browser') {
        response.writeHead(401);
        response.end();
        return;
      }
      const graph = ctx.clientModules.graph();
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({ graph, injections: bootInjections(graph) }),
      );
    },
  });
  const handler = ctx.connection.createSharedFetchHandler('/api');
  register({
    kind: 'prefix',
    path: '/_rdws/api',
    async handler(request, response) {
      const record = authenticate(request);
      if (!record) {
        response.writeHead(401);
        response.end();
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once('aborted', abort);
      record.peer.signal.addEventListener('abort', abort, { once: true });
      try {
        const text = await body(request);
        const url = new URL(request.url, 'http://rdws.invalid');
        if (['fork', 'create'].includes(record.cap.purpose)) {
          const action = 'session/' + record.cap.purpose;
          let envelope;
          try {
            envelope = JSON.parse(text);
          } catch {
            envelope = undefined;
          }
          if (
            url.pathname !== '/_rdws/api/' + action ||
            !onlyKeys(envelope, ['type', 'rpcId', 'method', 'payload']) ||
            envelope.type !== 'client-request' ||
            typeof envelope.rpcId !== 'string' ||
            envelope.method !== action ||
            !onlyKeys(envelope.payload, ['args']) ||
            !isRecord(envelope.payload.args) ||
            !actionAllowed(record.cap, action, envelope.payload.args)
          ) {
            response.writeHead(403);
            response.end();
            return;
          }
        }
        const canonical = new Request(
          'http://rdws.invalid' +
            url.pathname.slice('/_rdws'.length) +
            url.search,
          {
            method: request.method,
            headers: { 'content-type': 'application/json' },
            ...(text ? { body: text } : {}),
            signal: controller.signal,
          },
        );
        const answer = await handler.fetch(canonical, record.peer);

        const bytes = Buffer.from(await answer.arrayBuffer());
        if (
          !record.active ||
          record.peer.signal.aborted ||
          outdated(record.cap) ||
          record.cap.expiresAt <= Date.now()
        ) {
          response.end();
          return;
        }
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(bytes);
      } catch {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      } finally {
        record.peer.signal.removeEventListener('abort', abort);
      }
    },
  });
  const wire = ctx.typertGateway.wireStream;
  const mux = new RemoteStreamMuxServer(
    (endpoint, payload, uplink, peer, control) =>
      wire.open(endpoint, payload, uplink, peer, control.signal),
    wire.failure,
    { heartbeatIntervalMs: 5000, streamInboxBytes: 262144, compression: false },
  );
  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: '/_rdws/remote.mux',
      handler(request, socket, head) {
        const record = authenticate(request);
        if (!record || record.cap.purpose !== 'browser') {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return;
        }
        record.sockets.add(socket);
        socket.once('close', () => record.sockets.delete(socket));
        mux.handleUpgrade(request, socket, head, record.peer);
      },
    }),
  );
  ctx.effect(() => async () => {
    for (const record of [...peers.values()]) stop(record, 'revoked');
    await mux.close();
  });
}
