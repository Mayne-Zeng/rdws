import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyHash, signGrant, verifyGrant } from '@rdws/dsh/access';
import type { ModelCarrierRequest } from '@rdws/dsh/web';
import { expect, test, vi } from 'vitest';
import {
  createLoopbackAttachmentEgress,
  type AttachmentManifest,
} from '../../apps/server/src/modules/model-attachment-egress.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const imageA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageB = Buffer.concat([imageA, Buffer.from([0])]);
const mediaType = 'image/png';
const model = { provider: 'fixture', model: 'fixture-vision' };

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
) {
  const fixture = await supplierFixture();
  try {
    await run(fixture);
  } finally {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
    vi.useRealTimers();
  }
}

async function supplierFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rdws-attachment-https-'));
  const tls = await modelTlsCertificate(root);
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
  const server = createServer(
    { ...tls, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
    async (request, response) => {
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
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const rootUrl = `https://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const routes = { files: `${rootUrl}/files`, messages: `${rootUrl}/messages` };
  const key = randomUUID(),
    generation = randomUUID(),
    aud = 'rdws:bff:' + generation;
  const manifests = new Map<string, AttachmentManifest>();
  const lockReads: string[] = [];
  const runs = new ContextRuns(
    generation,
    (token) => verifyGrant(key, token, aud),
    async () => ({
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
    async (who, _requirementId, _sessionId, _related, write) => {
      lockReads.push(who.authSessionId);
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
  ) {
    const authSessionId = randomUUID(),
      requirementId = 'requirement-' + sessionId;
    const admission = runs.admit(
      { userId: 'synthetic-owner', authSessionId },
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
      projectId: 'fixture-project',
      requirementId,
      sessionId,
      bindingId,
      credentialGeneration,
      images: [{ mediaType, bytes: image.length, sha256: sha(image) }],
    });
    const callId = randomUUID();
    const request = (
      routeId: keyof typeof routes,
      body: { bytes: Buffer; type: string },
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
    root,
    server,
    routes,
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
