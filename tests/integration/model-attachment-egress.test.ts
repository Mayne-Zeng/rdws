import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import {
  connect,
  createServer as createTcpServer,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { bodyHash, signGrant, verifyGrant } from '@rdws/dsh/access';
import type { ModelCarrierRequest } from '@rdws/dsh/web';
import { expect, test, vi } from 'vitest';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import {
  createLoopbackAttachmentEgress,
  type AttachmentManifest,
} from '../../apps/server/src/modules/model-attachment-egress.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { createProjectContextReader } from '../../apps/server/src/modules/native-projects.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const imageA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageB = Buffer.concat([imageA, Buffer.from([0])]);
const mediaType = 'image/png';
const filesBeta = 'files-api-2025-04-14';
const model = { provider: 'fixture', model: 'fixture-vision' };

type DatabaseAuthority = {
  projectId: string;
  business: Pick<
    ReturnType<typeof createBusiness>,
    'readWithDeadline' | 'withModelAuthority'
  >;
};
type SessionAuthority = {
  userId: string;
  authSessionId: string;
  requirementId: string;
};

async function uploadBody(image: Buffer) {
  const data = new FormData();
  data.set('expires_after[anchor]', 'created_at');
  data.set('expires_after[seconds]', '3600');
  data.set(
    'file',
    new Blob([Uint8Array.from(image)], { type: mediaType }),
    'dsh-0123456789abcdef-01234567.png',
  );
  const body = new Response(data);
  return {
    bytes: Buffer.from(await body.arrayBuffer()),
    type: body.headers.get('content-type')!,
    usesFiles: true,
  };
}

function messageBody(
  source:
    | { type: 'file'; file_id: string }
    | { type: 'base64'; media_type: string; data: string },
) {
  return {
    bytes: Buffer.from(
      JSON.stringify({
        model: model.model,
        stream: true,
        max_tokens: 64,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: [{ type: 'image', source }] }],
      }),
    ),
    type: 'application/json',
    usesFiles: source.type === 'file',
  };
}

const reference = (id: string) => messageBody({ type: 'file', file_id: id });
const inline = (image: Buffer) =>
  messageBody({
    type: 'base64',
    media_type: mediaType,
    data: image.toString('base64'),
  });

async function withSupplier(
  run: (fixture: Awaited<ReturnType<typeof supplierFixture>>) => Promise<void>,
  authority?: DatabaseAuthority,
) {
  const fixture = await supplierFixture(authority);
  try {
    await run(fixture);
  } finally {
    try {
      await fixture.close();
    } finally {
      vi.useRealTimers();
    }
  }
}

async function supplierFixture(authority?: DatabaseAuthority) {
  const root = await mkdtemp(join(tmpdir(), 'rdws-attachment-https-'));
  const tls = await modelTlsCertificate(root).catch(async (error: unknown) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  const state = {
    fileId: 'synthetic-first',
    bytes: imageA.length,
    receipt: 'valid' as 'valid' | 'truncated' | 'wrong-type',
    revoked: false,
    loseCommit: false,
    lostSubmitted: false,
    beforeWrite: undefined as (() => void) | undefined,
  };
  const arrivals: { route: string; sha256: string }[] = [];
  const httpEntries: string[] = [];
  const applicationBytes: number[] = [];
  const server = createServer(
    { ...tls, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
    async (request, response) => {
      httpEntries.push(request.url!);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        arrivals.push({
          route: request.url!,
          sha256: sha(Buffer.concat(chunks)),
        });
        const reply =
          request.url === '/v1/files'
            ? JSON.stringify({
                id: state.fileId,
                type: 'file',
                size_bytes: state.bytes,
                created_at: new Date().toISOString(),
                filename: 'fixture.png',
                mime_type:
                  state.receipt === 'wrong-type' ? 'image/jpeg' : mediaType,
              })
            : '{"fixture":"message accepted"}';
        const truncated =
          request.url === '/v1/files' && state.receipt === 'truncated';
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(reply) + Number(truncated),
        });
        response.end(reply);
      } catch {
        response.destroy();
      }
    },
  );
  server.on('secureConnection', (socket) => {
    const index = applicationBytes.push(0) - 1;
    socket.on('data', (bytes: Buffer) => {
      applicationBytes[index]! += bytes.length;
    });
  });
  const sockets = new Set<Socket>();
  const transmissions: { counting: boolean; bytes: number; closed: boolean }[] =
    [];
  let supplierPort = 0;
  const proxy =
    authority &&
    createTcpServer((client) => {
      const upstream = connect(supplierPort, '127.0.0.1');
      const attempt = { counting: false, bytes: 0, closed: false };
      transmissions.push(attempt);
      sockets.add(client).add(upstream);
      client.on('data', (bytes: Buffer) => {
        if (attempt.counting) attempt.bytes += bytes.length;
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.once('close', () => {
        attempt.closed = true;
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.once('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.pipe(upstream).pipe(client);
    });
  async function close() {
    try {
      for (const socket of sockets) socket.destroy();
      if (proxy?.listening)
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
    } finally {
      try {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    supplierPort = (server.address() as { port: number }).port;
    if (proxy) {
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
    }
  } catch (error) {
    await close();
    throw error;
  }
  const port = proxy
    ? (proxy.address() as { port: number }).port
    : supplierPort;
  const rootUrl = 'https://127.0.0.1:' + port + '/v1';
  const routes = { files: `${rootUrl}/files`, messages: `${rootUrl}/messages` };
  const key = randomUUID(),
    generation = randomUUID(),
    aud = 'rdws:bff:' + generation;
  const manifests = new Map<string, AttachmentManifest>();
  const lockReads: string[] = [];
  const firstWrites: { authSessionId: string; outcome?: string }[] = [];
  const authorityFailures: {
    authSessionId: string;
    statusCode?: number;
    publicMessage?: string;
  }[] = [];
  const projectId = authority?.projectId ?? 'fixture-project';
  const readContext =
    authority && createProjectContextReader(authority.business);
  const runs = new ContextRuns(
    generation,
    (token) => verifyGrant(key, token, aud),
    (who, requirementId, sessionId, related) =>
      readContext
        ? readContext(projectId, who, requirementId, sessionId, related)
        : Promise.resolve({
            value: { snapshot: {}, digest: 'fixture' },
            validBefore: Date.now() + 10000,
          }),
    () => false,
    async () => ({
      ...model,
      revision: 'fixture-revision',
      routes,
      isCurrent: () => true,
    }),
    async (who, requirementId, sessionId, related, write) => {
      lockReads.push(who.authSessionId);
      if (authority) {
        const attempt = transmissions.at(-1);
        if (!attempt || attempt.counting)
          throw new Error('Missing new TLS attempt');
        attempt.counting = true;
        try {
          return await authority.business.withModelAuthority(
            who,
            projectId,
            requirementId,
            sessionId,
            related,
            (deadline) => {
              const observed: (typeof firstWrites)[number] = {
                authSessionId: who.authSessionId,
              };
              firstWrites.push(observed);
              const result = write(deadline);
              observed.outcome = (result as { outcome?: string }).outcome;
              return result;
            },
          );
        } catch (error) {
          const { statusCode, publicMessage } = error as {
            statusCode?: number;
            publicMessage?: string;
          };
          authorityFailures.push({
            authSessionId: who.authSessionId,
            statusCode,
            publicMessage,
          });
          throw error;
        }
      }
      state.beforeWrite?.();
      const result = write(Date.now() + (state.revoked ? -1 : 5000));
      if (
        state.loseCommit &&
        (result as { outcome?: string }).outcome === 'submitted'
      ) {
        state.lostSubmitted = true;
        throw new Error('Synthetic lock transaction result lost');
      }
      return result;
    },
  );
  const egress = createLoopbackAttachmentEgress(
    routes,
    tls.cert,
    runs,
    (request) => manifests.get(request.call.bindingId!),
  );
  let sequence = 0;
  async function open(
    sessionId: string,
    image = imageA,
    credentialGeneration = 'fixture-credential-generation',
    scope: SessionAuthority = {
      userId: 'synthetic-owner',
      authSessionId: randomUUID(),
      requirementId: 'requirement-' + sessionId,
    },
  ) {
    const { userId, authSessionId, requirementId } = scope;
    const admission = runs.admit(
      { userId, authSessionId },
      requirementId,
      sessionId,
      randomUUID(),
      randomUUID(),
    );
    const step = ++sequence;
    const input = {
      ...admission,
      agentGeneration: 'agent-' + sessionId,
      turn: 1,
      modelStep: { sequence, step, noteId: randomUUID(), ...model },
    };
    const ready = (await runs.handle(
      input,
      signGrant(key, {
        aud,
        purpose: 'service',
        operation: 'context-read',
        hostGeneration: generation,
        runId: input.runId,
        bodyHash: bodyHash(input),
      }),
    )) as { modelBindingId: string };
    const bindingId = ready.modelBindingId;
    manifests.set(bindingId, {
      projectId,
      requirementId,
      sessionId,
      bindingId,
      credentialGeneration,
      images: [{ mediaType, bytes: image.length, sha256: sha(image) }],
    });
    const callId = randomUUID();
    const request = (
      routeId: keyof typeof routes,
      body: { bytes: Buffer; type: string; usesFiles: boolean },
      {
        attemptId = randomUUID(),
        credential = 'synthetic-model-credential',
      }: { attemptId?: string; credential?: string } = {},
    ): ModelCarrierRequest => ({
      routeId,
      destination: routes[routeId],
      attemptId,
      call: { id: callId, sessionId, bindingId, ...model },
      headers: new Headers({
        authorization: `Bearer ${credential}`,
        'content-type': body.type,
        'anthropic-version': '2023-06-01',
        ...(body.usesFiles ? { 'anthropic-beta': filesBeta } : {}),
        ...(routeId === 'messages' ? { accept: 'text/event-stream' } : {}),
      }),
      body: new Response(Uint8Array.from(body.bytes)).body!,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    return { request, authSessionId };
  }
  const forget = (request: ModelCarrierRequest) =>
    manifests.delete(request.call.bindingId!);
  return {
    close,
    routes,
    httpEntries,
    applicationBytes,
    transmissions,
    firstWrites,
    authorityFailures,
    egress,
    open,
    arrivals,
    lockReads,
    state,
    forget,
  };
}

test.skipIf(process.platform !== 'darwin')(
  'Files and Messages perform independent same-step first writes with a scoped receipt',
  async () => {
    await withSupplier(async ({ egress, open, arrivals, lockReads }) => {
      const step = await open('first');
      const file = await uploadBody(imageA);
      const upload = step.request('files', file);
      const receipt = await egress(upload);
      expect(receipt.status).toBe(200);
      expect(await receipt.json()).toMatchObject({ id: 'synthetic-first' });
      const cached = reference('synthetic-first');
      const unadvertisedReference = step.request('messages', cached);
      unadvertisedReference.headers.delete('anthropic-beta');
      await expect(egress(unadvertisedReference)).rejects.toThrow(
        'Attachment egress unavailable',
      );
      await expect(
        egress(
          step.request('messages', cached, { attemptId: upload.attemptId }),
        ),
      ).rejects.toThrow();
      await expect(
        egress(
          step.request('messages', cached, {
            credential: 'different-synthetic-credential',
          }),
        ),
      ).rejects.toThrow();
      const another = await open('another');
      await expect(
        egress(another.request('messages', cached)),
      ).rejects.toThrow();
      const wrongRoute = step.request('messages', cached);
      wrongRoute.destination = wrongRoute.destination.replace(
        '/v1/',
        '/other/',
      );
      await expect(egress(wrongRoute)).rejects.toThrow();
      expect(arrivals).toEqual([
        { route: '/v1/files', sha256: sha(file.bytes) },
      ]);
      expect(
        await (await egress(step.request('messages', cached))).json(),
      ).toEqual({ fixture: 'message accepted' });
      expect(arrivals.at(-1)).toEqual({
        route: '/v1/messages',
        sha256: sha(cached.bytes),
      });
      expect(lockReads).toEqual([step.authSessionId, step.authSessionId]);

      const reauthorized = await open('first');
      await (await egress(reauthorized.request('messages', cached))).text();
      expect(lockReads.at(-1)).toBe(reauthorized.authSessionId);
      const rotated = await open('first', imageA, 'new-credential-generation');
      await expect(
        egress(rotated.request('messages', cached)),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(3);
      vi.setSystemTime(new Date(Date.now() + 3600001));
      const expired = await open('first');
      await expect(
        egress(expired.request('messages', cached)),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(3);
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'verified zero write releases Files while truncated or unconfirmed submits cannot be retried',
  async () => {
    await withSupplier(async ({ egress, open, arrivals, state }) => {
      const first = await open('truncated');
      const file = await uploadBody(imageA);
      state.revoked = true;
      await expect(egress(first.request('files', file))).rejects.toThrow();
      expect(arrivals).toEqual([]);
      state.revoked = false;
      state.receipt = 'truncated';
      await expect(egress(first.request('files', file))).rejects.toThrow();
      expect(arrivals).toEqual([
        { route: '/v1/files', sha256: sha(file.bytes) },
      ]);
      const refreshed = await open('truncated', imageA, 'refreshed-generation');
      state.receipt = 'valid';
      await expect(
        egress(
          refreshed.request('files', file, {
            credential: 'another-synthetic-credential',
          }),
        ),
      ).rejects.toThrow();
      await expect(
        egress(refreshed.request('messages', reference(state.fileId))),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(1);
      await (
        await egress(refreshed.request('messages', inline(imageA)))
      ).text();
      expect(arrivals.map(({ route }) => route)).toEqual([
        '/v1/files',
        '/v1/messages',
      ]);

      const missingCommit = await open('lost-commit');
      state.loseCommit = true;
      await expect(
        egress(missingCommit.request('files', file)),
      ).rejects.toThrow();
      expect(state.lostSubmitted).toBe(true);
      state.loseCommit = false;
      const count = arrivals.length;
      const retried = await open('lost-commit');
      await expect(egress(retried.request('files', file))).rejects.toThrow();
      await expect(
        egress(retried.request('messages', reference(state.fileId))),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(count);
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'a duplicate file identifier invalidates the older receipt even with mismatched metadata',
  async () => {
    await withSupplier(async ({ egress, open, arrivals, state }) => {
      const old = await open('previous-file');
      await (
        await egress(old.request('files', await uploadBody(imageA)))
      ).json();
      const other = await open('new-file', imageB, 'new-credential-generation');
      state.bytes = imageB.length;
      state.receipt = 'wrong-type';
      await expect(
        egress(other.request('files', await uploadBody(imageB))),
      ).rejects.toThrow();
      expect(arrivals.map(({ route }) => route)).toEqual([
        '/v1/files',
        '/v1/files',
      ]);
      await expect(
        egress(old.request('messages', reference(state.fileId))),
      ).rejects.toThrow();
      await expect(
        egress(other.request('messages', reference(state.fileId))),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(2);
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'Messages rechecks the image manifest inside the original write lock',
  async () => {
    await withSupplier(async ({ egress, open, arrivals, state, forget }) => {
      const step = await open('manifest');
      await (
        await egress(step.request('files', await uploadBody(imageA)))
      ).json();
      const prepared = step.request('messages', reference(state.fileId));
      state.beforeWrite = () => {
        forget(prepared);
      };
      await expect(egress(prepared)).rejects.toThrow();
      state.beforeWrite = undefined;
      expect(arrivals.map(({ route }) => route)).toEqual(['/v1/files']);
      const different = await open('manifest', imageB);
      await expect(
        egress(different.request('messages', reference(state.fileId))),
      ).rejects.toThrow();
      expect(arrivals).toHaveLength(1);
      await (
        await egress(different.request('messages', inline(imageB)))
      ).text();
      expect(arrivals.map(({ route }) => route)).toEqual([
        '/v1/files',
        '/v1/messages',
      ]);
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the attachment relay rejects invalid protocol fields before authorizing a write',
  async () => {
    await withSupplier(async ({ egress, open, lockReads, arrivals }) => {
      const step = await open('header-check');
      const file = await uploadBody(imageA);
      const cases = [
        ['files', file, 'anthropic-version', null],
        ['files', file, 'anthropic-version', '2023-06-01, 2023-06-01'],
        ['files', file, 'anthropic-beta', null],
        ['files', file, 'anthropic-beta', filesBeta + ', another-beta'],
        ['files', file, 'accept', 'text/event-stream'],
        ['files', file, 'accept-encoding', 'gzip'],
        ['files', file, 'authorization', 'Bearer synthetic, Bearer other'],
        ['files', file, 'x-api-key', 'synthetic-second-credential'],
        ['files', file, 'x-fixture-only', 'synthetic-field'],
        ['messages', inline(imageA), 'accept', 'application/json'],
        ['messages', inline(imageA), 'anthropic-beta', filesBeta],
      ] as const;
      for (const [route, body, name, value] of cases) {
        const request = step.request(route, body);
        if (value === null) request.headers.delete(name);
        else request.headers.set(name, value);
        await expect(egress(request)).rejects.toThrow(
          'Attachment egress unavailable',
        );
      }
      expect(lockReads).toEqual([]);
      expect(arrivals).toEqual([]);

      await (await egress(step.request('messages', inline(imageA)))).text();
      expect(lockReads).toEqual([step.authSessionId]);
      expect(arrivals).toHaveLength(1);
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'database revocation precedes both attachment first writes on the observed connection',
  async () => {
    const lab = await authorityDatabase();
    const projectId = 'attachment-authority';
    const userId = randomUUID();
    const requirementId = randomUUID();
    const receiptSession = randomUUID();
    const newFileSession = randomUUID();
    const active = randomUUID();
    const revokeFiles = randomUUID();
    const revokeMessages = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    const applicationName = 'rdws-attachment-authorization-fixture';
    const connection = new URL(lab.databaseUrl);
    connection.searchParams.set('application_name', applicationName);
    const { db, pool } = connectDatabase(
      connection.href,
      randomBytes(32).toString('hex'),
    );
    let ownerGeneration: string | null = null;
    try {
      await lab.owner.query('insert into project(id,name) values($1,$2)', [
        projectId,
        'Synthetic attachment project',
      ]);
      await lab.owner.query(
        'insert into auth_user(id,name,email) values($1,$2,$3)',
        [userId, 'Synthetic developer', 'attachment-developer@fixture.invalid'],
      );
      await lab.owner.query(
        "insert into project_member values($1,$2,'developer')",
        [projectId, userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Synthetic attachment requirement','','',$3,$3)",
        [requirementId, projectId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      for (const id of [receiptSession, newFileSession])
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
          [id, requirementId, userId],
        );
      for (const id of [active, revokeFiles, revokeMessages])
        await lab.owner.query(
          "insert into auth_session(id,token,user_id,expires_at) values($1,$2,$3,now()+interval '5 minutes')",
          [id, randomUUID(), userId],
        );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [sha(Buffer.from(ticket))],
      );
      ownerGeneration = await acquireAuthority(pool, true, ticket);
      expect(ownerGeneration).not.toBeNull();
      await lab.admin.query('select 1');

      await withSupplier(
        async (fixture) => {
          const {
            open,
            egress,
            firstWrites,
            authorityFailures,
            transmissions,
            applicationBytes,
            httpEntries,
            arrivals,
            lockReads,
            state,
          } = fixture;
          const scope = (authSessionId: string) => ({
            userId,
            requirementId,
            authSessionId,
          });
          const firstFile = await uploadBody(imageA);
          const secondFile = await uploadBody(imageB);
          const allowed = await open(
            receiptSession,
            imageA,
            undefined,
            scope(active),
          );
          expect(
            await (await egress(allowed.request('files', firstFile))).json(),
          ).toMatchObject({ id: 'synthetic-first' });
          const cached = reference('synthetic-first');
          expect(
            await (await egress(allowed.request('messages', cached))).json(),
          ).toEqual({ fixture: 'message accepted' });

          async function revokeWhileWaiting(
            request: ModelCarrierRequest,
            authSessionId: string,
          ) {
            const remover = await pool.connect();
            const stop = new AbortController();
            const start = {
              transport: transmissions.length,
              tls: applicationBytes.length,
              writes: firstWrites.length,
              http: httpEntries.length,
              body: arrivals.length,
            };
            let inTransaction = false;
            let settled:
              Promise<{ response: Response } | { error: unknown }> | undefined;
            try {
              await remover.query('begin');
              inTransaction = true;
              const backend = await remover.query<{ pid: number }>(
                'select pg_backend_pid() as pid',
              );
              const removed = await remover.query<{ id: string }>(
                'delete from auth_session where id=$1 returning id',
                [authSessionId],
              );
              expect(removed.rows).toEqual([{ id: authSessionId }]);
              settled = egress({ ...request, signal: stop.signal }).then(
                (response) => ({ response }),
                (error: unknown) => ({ error }),
              );
              await expect
                .poll(
                  async () =>
                    (
                      await lab.admin.query<{ waiting: boolean }>(
                        "select exists(select 1 from pg_stat_activity where datname=current_database() and usename='rdws_test_app' and application_name=$1 and state='active' and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid)) and query ~* 'from \"auth_session\".*for share') as waiting",
                        [applicationName, backend.rows[0]!.pid],
                      )
                    ).rows[0]?.waiting,
                  { timeout: 2500, interval: 15 },
                )
                .toBe(true);
              const beforeCommit = {
                writes: firstWrites.length,
                http: httpEntries.length,
                bytes: transmissions[start.transport]?.bytes,
              };
              const commit = await remover.query('commit');
              inTransaction = false;
              expect(commit.command).toBe('COMMIT');
              expect(beforeCommit).toEqual({
                writes: start.writes,
                http: start.http,
                bytes: 0,
              });

              expect(await settled).toMatchObject({
                error: { message: 'Model HTTPS transport unavailable' },
              });
              const live = await lab.owner.query(
                'select id from auth_session where id=$1',
                [authSessionId],
              );
              expect(live.rows).toEqual([]);
              expect(authorityFailures.at(-1)).toEqual({
                authSessionId,
                statusCode: 401,
                publicMessage: '登录已失效，请重新登录',
              });
              await expect
                .poll(() => transmissions[start.transport]?.closed)
                .toBe(true);
              expect(transmissions.slice(start.transport)).toEqual([
                { counting: true, bytes: 0, closed: true },
              ]);
              expect(applicationBytes.slice(start.tls)).toEqual([0]);
              expect(firstWrites).toHaveLength(start.writes);
              expect(httpEntries).toHaveLength(start.http);
              expect(arrivals).toHaveLength(start.body);
            } finally {
              stop.abort();
              try {
                if (inTransaction) await remover.query('rollback');
              } finally {
                remover.release();
                const outcome = await settled;
                if (outcome && 'response' in outcome)
                  await outcome.response.body?.cancel();
              }
            }
          }

          const deniedReference = await open(
            receiptSession,
            imageA,
            undefined,
            scope(revokeMessages),
          );
          await revokeWhileWaiting(
            deniedReference.request('messages', cached),
            revokeMessages,
          );
          const deniedUpload = await open(
            newFileSession,
            imageB,
            undefined,
            scope(revokeFiles),
          );
          await revokeWhileWaiting(
            deniedUpload.request('files', secondFile),
            revokeFiles,
          );

          const validReference = await open(
            receiptSession,
            imageA,
            undefined,
            scope(active),
          );
          await (
            await egress(validReference.request('messages', cached))
          ).json();
          const validUpload = await open(
            newFileSession,
            imageB,
            undefined,
            scope(active),
          );
          state.fileId = 'synthetic-second';
          state.bytes = imageB.length;
          expect(
            await (
              await egress(validUpload.request('files', secondFile))
            ).json(),
          ).toMatchObject({ id: 'synthetic-second' });
          const secondReference = reference('synthetic-second');
          await (
            await egress(validUpload.request('messages', secondReference))
          ).json();
          expect(lockReads).toEqual([
            active,
            active,
            revokeMessages,
            revokeFiles,
            active,
            active,
            active,
          ]);
          expect(firstWrites).toEqual(
            Array.from({ length: 5 }, () => ({
              authSessionId: active,
              outcome: 'submitted',
            })),
          );
          expect(
            authorityFailures.map(({ authSessionId }) => authSessionId),
          ).toEqual([revokeMessages, revokeFiles]);
          const expected = [
            { route: '/v1/files', sha256: sha(firstFile.bytes) },
            { route: '/v1/messages', sha256: sha(cached.bytes) },
            { route: '/v1/messages', sha256: sha(cached.bytes) },
            { route: '/v1/files', sha256: sha(secondFile.bytes) },
            { route: '/v1/messages', sha256: sha(secondReference.bytes) },
          ];
          expect(httpEntries).toEqual(expected.map(({ route }) => route));
          expect(arrivals).toEqual(expected);
          expect(applicationBytes.map((bytes) => bytes > 0)).toEqual([
            true,
            true,
            false,
            false,
            true,
            true,
            true,
          ]);
          expect(
            transmissions.map(({ counting, bytes }) => counting && bytes > 0),
          ).toEqual([true, true, false, false, true, true, true]);
        },
        { projectId, business: createBusiness(db) },
      );
    } finally {
      try {
        if (ownerGeneration) {
          await releaseAuthority(pool, ownerGeneration);
          const readback = await lab.owner.query<{ generation: string | null }>(
            'select generation from rdws_authority.owner where singleton',
          );
          expect(readback.rows).toEqual([{ generation: null }]);
        }
      } finally {
        try {
          await pool.end();
        } finally {
          await lab.close();
        }
      }
    }
  },
  60000,
);
