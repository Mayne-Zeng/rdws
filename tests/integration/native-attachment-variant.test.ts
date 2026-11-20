import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';
import {
  createLoopbackAttachmentEgress,
  type AttachmentManifest,
} from '../../apps/server/src/modules/model-attachment-egress.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import {
  readDeepSeekFilesEvidence,
  readDeepSeekMessagesEvidence,
} from '../../apps/server/src/modules/model-attachment-evidence.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

const fixtureCredential = 'synthetic-variant-only';
const receiptId = 'synthetic-native-variant';
const sha = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const attributionHeaders = [
  'user-agent',
  'x-deepseek-harness-user-id',
  'x-deepseek-harness-session-id',
];

type Identity = {
  id: string;
  requestId: string;
  userId: string;
  nonce: string;
  images: string[];
};
type Image = { bytes: number; mediaType: string; sha256: string };
type Witness = {
  sessionId: string;
  inserted: Identity & { seq: number };
  claimed: Identity & { turn: number };
  requested: Identity;
  attachmentId: string;
  original: { width: number; height: number; sha256: string };
  variant: {
    id: string;
    width: number;
    height: number;
    image: AttachmentManifest['images'][number];
  };
};
type Attempt = {
  route: string;
  attemptId: string;
  callId: string;
  bindingId?: string;
  sessionId: string;
  image?: Image;
  fileIdSha256?: string;
  wireSha256: string;
  contentType: string | null;
  attribution: string[];
  fixtureCredentialPresent: boolean;
  witness: Witness;
  hasOriginalImage: boolean;
};

function syntheticMessages(model: string) {
  const frames = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        model,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'synthetic accepted variant' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

test
  .skipIf(process.platform !== 'darwin')
  .each(['inline', 'TLS receipt'] as const)(
  'Native variant evidence follows the original claimed input with %s',
  async (transport) => {
    const useTls = transport === 'TLS receipt';
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-attachment-variant-'),
    );
    const config = join(root, 'config');
    const profile = join(config, 'profiles', 'rdws');
    const evidencePath = join(root, 'synthetic-evidence.jsonl');
    const project = 'attachment-variant';
    const provider = 'deepseek-official';
    const model = 'fixture-vision';
    const accepted = 'Synthetic image admitted with original run';
    const late = 'Synthetic original text with later variation';
    const attempts: Attempt[] = [];
    const originals = new Map<
      string,
      {
        userId: string;
        nonce: string;
        requestId: string;
        requirementId: string;
      }
    >();
    const contextReads: {
      userId: string;
      authSessionId: string;
      requirementId: string;
      sessionId: string;
    }[] = [];
    let replies = 0;
    const httpEntries: string[] = [];
    const uploadedImages: Image[] = [];
    const arrivals: {
      path: string;
      wireSha256: string;
      contentType: string | null;
      accept: string | undefined;
      version: string | undefined;
      beta: string | undefined;
      encoding: string | undefined;
      attribution: string[];
      fixtureCredentialPresent: boolean;
    }[] = [];
    const attemptScope = new AsyncLocalStorage<Attempt>();
    const lockReads: ((typeof contextReads)[number] & {
      attemptId: string;
      route: string;
      bindingId: string | undefined;
      outcome?: string;
    })[] = [];
    const manifests = new Map<string, AttachmentManifest>();
    let server: Server | undefined;
    let startedHost: NativeWebHost | undefined;
    try {
      let base = 'http://127.0.0.1:1/v1';
      const tls = useTls ? await modelTlsCertificate(root) : undefined;
      if (tls) {
        server = createServer(
          { ...tls, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
          async (request, response) => {
            const path = request.url!;
            httpEntries.push(path);
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of request)
                chunks.push(Buffer.from(chunk));
              const wire = Buffer.concat(chunks);
              const { headers } = request;
              arrivals.push({
                path,
                wireSha256: sha(wire),
                contentType: headers['content-type'] ?? null,
                accept: headers.accept,
                version: headers['anthropic-version'] as string | undefined,
                beta: headers['anthropic-beta'] as string | undefined,
                encoding: headers['accept-encoding'],
                attribution: attributionHeaders.filter(
                  (name) => name in headers,
                ),
                fixtureCredentialPresent:
                  headers['x-api-key'] === fixtureCredential &&
                  headers.authorization === undefined,
              });

              if (path === '/v1/files') {
                const body = await new Response(Uint8Array.from(wire), {
                  headers: { 'content-type': headers['content-type'] ?? '' },
                }).formData();
                const image = body.get('file');
                if (!(image instanceof File))
                  throw new Error('Missing TLS upload evidence');
                uploadedImages.push({
                  bytes: image.size,
                  mediaType: image.type,
                  sha256: sha(Buffer.from(await image.arrayBuffer())),
                });
                const receipt = JSON.stringify({
                  id: receiptId,
                  type: 'file',
                  size_bytes: image.size,
                  created_at: new Date().toISOString(),
                  filename: image.name,
                  mime_type: image.type,
                });
                response.writeHead(200, {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(receipt),
                });
                response.end(receipt);
              } else if (path === '/v1/messages') {
                const reply = await syntheticMessages(model).text();
                response.writeHead(200, {
                  'content-type': 'text/event-stream',
                  'content-length': Buffer.byteLength(reply),
                });
                response.end(reply);
                replies++;
              } else {
                response.writeHead(404).end();
              }
            } catch {
              response.destroy();
            }
          },
        );
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base =
          'https://127.0.0.1:' +
          (server.address() as { port: number }).port +
          '/v1';
      }
      const routes = { files: base + '/files', messages: base + '/messages' };
      const host = new NativeWebHost(
        root,
        config,
        project,
        undefined,
        'mediated',
        {
          routes,
          async handle(request): Promise<Response> {
            const wire = Buffer.from(
              await new Response(request.body).arrayBuffer(),
            );
            const type = request.headers.get('content-type');
            const messages =
              request.routeId === 'messages'
                ? readDeepSeekMessagesEvidence(wire, type, model)
                : undefined;
            const part =
              messages?.images.length === 1 ? messages.images[0] : undefined;
            const image =
              request.routeId === 'files'
                ? readDeepSeekFilesEvidence(wire, type)?.image
                : part?.kind === 'inline'
                  ? part.image
                  : undefined;
            const fileIdSha256 =
              part?.kind === 'file' ? part.fileIdSha256 : undefined;
            const evidence = (await readFile(evidencePath, 'utf8'))
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as Witness);
            const candidates = evidence.filter(
              (entry) => entry.sessionId === request.call.sessionId,
            );
            const bindingId = request.call.bindingId;
            if (
              (!image && !(useTls && fileIdSha256)) ||
              candidates.length !== 1 ||
              !bindingId
            )
              throw new Error('Missing request variant evidence');
            const witness = candidates[0]!;
            const original = originals.get(witness.sessionId);
            if (!original) throw new Error('Missing signed admission');
            const hasOriginalImage =
              [witness.inserted, witness.claimed, witness.requested].every(
                (entry) =>
                  entry.userId === original.userId &&
                  entry.nonce === original.nonce &&
                  entry.requestId === original.requestId &&
                  entry.images.includes(witness.attachmentId),
              ) &&
              witness.inserted.id === witness.claimed.id &&
              witness.claimed.id === witness.requested.id;
            const attempt: Attempt = {
              route: request.routeId,
              attemptId: request.attemptId,
              callId: request.call.id,
              bindingId,
              sessionId: witness.sessionId,
              image,
              fileIdSha256,
              wireSha256: sha(wire),
              contentType: type,
              attribution: attributionHeaders.filter((name) =>
                request.headers.has(name),
              ),
              fixtureCredentialPresent:
                request.headers.get('x-api-key') === fixtureCredential &&
                !request.headers.has('authorization'),
              witness,
              hasOriginalImage,
            };
            if (egress) {
              attempts.push(attempt);
              manifests.set(bindingId, {
                projectId: project,
                requirementId: original.requirementId,
                sessionId: witness.sessionId,
                bindingId,
                credentialGeneration: 'native-variant-fixture',
                images: hasOriginalImage ? [witness.variant.image] : [],
              });
              try {
                return await attemptScope.run(attempt, () =>
                  egress({
                    ...request,
                    body: new Response(Uint8Array.from(wire)).body!,
                  }),
                );
              } finally {
                manifests.delete(bindingId);
              }
            }
            const allowed = await runs.authorizeModelAttempt(
              request,
              () =>
                hasOriginalImage &&
                image?.sha256 === witness.variant.image.sha256 &&
                image.bytes === witness.variant.image.bytes &&
                image.mediaType === witness.variant.image.mediaType,
            );
            attempts.push({ ...attempt, hasOriginalImage: allowed });
            if (!allowed || request.routeId === 'files')
              return new Response(null, { status: 403 });
            replies++;
            return syntheticMessages(model);
          },
        },
      );
      startedHost = host;
      const runs = new ContextRuns(
        host.contextGeneration,
        (token) => host.verifyContext(token),
        async (who, requirementId, sessionId) => {
          contextReads.push({
            userId: who.userId,
            authSessionId: who.authSessionId,
            requirementId,
            sessionId,
          });
          return {
            value: {
              snapshot: { requirementId, contextVersion: 1 },
              digest: 'fixture',
            },
            validBefore: Date.now() + 30000,
          };
        },
        () => false,
        async () => ({
          provider,
          model,
          revision: 'fixture',
          routes,
          isCurrent: () => true,
        }),
        useTls
          ? async (who, requirementId, sessionId, _related, write) => {
              const attempt = attemptScope.getStore();
              if (!attempt)
                throw new Error('Missing attempt at fixture authority');
              const result = write(Date.now() + 5000);
              lockReads.push({
                userId: who.userId,
                authSessionId: who.authSessionId,
                requirementId,
                sessionId,
                route: attempt.route,
                attemptId: attempt.attemptId,
                bindingId: attempt.bindingId,
                outcome: (result as { outcome?: string }).outcome,
              });
              return result;
            }
          : undefined,
      );
      const egress =
        tls &&
        createLoopbackAttachmentEgress(routes, tls.cert, runs, (request) =>
          manifests.get(request.call.bindingId!),
        );
      host.configureContext((input, token, reply) =>
        runs.handle(input, token, reply),
      );
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: fixtureCredential },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                'rdws-glm': {
                  api: 'openai-completions',
                  apiKeyEnv: 'FIXTURE_MODEL',
                  baseURL: base,
                  models: [{ id: 'fixture-unused' }],
                },
              },
            },
          },
          { id: 'agent-default-model', config: { provider, model } },
          {
            id: 'llm-deepseek',
            config: {
              apiKeyEnv: 'FIXTURE_MODEL',
              baseURL: base,
              models: [
                {
                  id: model,
                  inputModalities: ['text', 'image'],
                  imagePixelBudget: 64,
                },
              ],
              retryPolicy: { mode: 'normal', maxRetries: 0 },
            },
          },
          {
            insert: [
              {
                id: 'test-attachment-variant',
                name: fileURLToPath(
                  new URL(
                    '../fixtures/native-attachment-variant.mjs',
                    import.meta.url,
                  ),
                ),
                config: { accepted, late, evidencePath },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );

      async function send(text: string, checkPublicRejection = false) {
        const requirementId = randomUUID();
        const requestId = randomUUID();
        const workspace = await host.workspace(
          requirementId,
          'Synthetic attachment verification',
        );
        const identity = {
          ...workspace,
          requirementId,
          userId: randomUUID(),
          authSessionId: randomUUID(),
        };
        const { sessionId } = (await sessionRpc(
          host,
          { ...identity, purpose: 'create' },
          'session/create',
          {
            workspaceId: workspace.workspaceId,
          },
        )) as { sessionId: string };
        const browser = {
          ...identity,
          purpose: 'browser' as const,
          ownSessionIds: [sessionId],
          readSessionIds: [sessionId],
        };
        const ticket = host.ticket(browser);
        const nonce = host.claims(ticket)!.nonce;
        originals.set(sessionId, {
          userId: identity.userId,
          requestId,
          requirementId,
          nonce,
        });
        await host.control('run', {
          ...runs.admit(identity, requirementId, sessionId, requestId, nonce),
          authSessionId: identity.authSessionId,
        });
        const prompt = {
          sessionId,
          requestId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        };
        if (checkPublicRejection) {
          const rejected = await host.fetch('/api/session/prompt', ticket, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/prompt',
              payload: {
                args: {
                  request: {
                    ...prompt,
                    content: [
                      ...prompt.content,
                      {
                        type: 'image',
                        mediaType: 'image/png',
                        data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPgidpCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAHy7aD0Nf3XZAAAAAElFTkSuQmCC',
                      },
                    ],
                  },
                },
              },
            }),
          });
          expect(rejected.status).toBe(503);
        }
        expect(
          await sessionRpc(host, ticket, 'session/prompt', prompt),
        ).toEqual({ accepted: true });
        const events = async () =>
          (
            (await sessionRpc(host, ticket, 'session/events', {
              address: { kind: 'session', sessionId },
            })) as {
              records: {
                event: {
                  seq: number;
                  type: string;
                  data: Record<string, unknown>;
                };
              }[];
            }
          ).records.map(({ event }) => event);
        const expectedRoutes =
          useTls && !checkPublicRejection
            ? ['messages']
            : ['files', 'messages'];
        await expect
          .poll(
            () =>
              attempts
                .filter((attempt) => attempt.sessionId === sessionId)
                .map((attempt) => attempt.route),
            { timeout: 10000 },
          )
          .toEqual(expectedRoutes);
        await expect
          .poll(
            async () =>
              (await events()).some((event) => event.type === 'turn/end'),
            { timeout: 10000 },
          )
          .toBe(true);
        const observed = await events();
        const turnEnd = observed.findLast(({ type }) => type === 'turn/end');
        const assistantMessages = observed.filter(
          ({ type }) => type === 'assistant/message',
        );
        if (checkPublicRejection) {
          expect(turnEnd?.data.reason).toMatchObject({ kind: 'completed' });
          expect(JSON.stringify(assistantMessages)).toContain(
            'synthetic accepted variant',
          );
        } else {
          expect(assistantMessages).toHaveLength(0);
        }
        const pair = attempts.filter(
          (attempt) => attempt.sessionId === sessionId,
        );
        expect(pair.map(({ route }) => route)).toEqual(expectedRoutes);
        expect(new Set(pair.map(({ attemptId }) => attemptId)).size).toBe(
          pair.length,
        );
        expect(new Set(pair.map(({ callId }) => callId)).size).toBe(1);
        expect(pair[0]!.bindingId).toMatch(/^[a-f0-9-]{36}$/);
        expect(new Set(pair.map(({ bindingId }) => bindingId)).size).toBe(1);
        const origin = {
          userId: identity.userId,
          authSessionId: identity.authSessionId,
          requirementId,
          sessionId,
        };
        expect(contextReads).toContainEqual(origin);
        if (useTls && checkPublicRejection) {
          expect(lockReads).toEqual(
            pair.map(({ route, attemptId, bindingId }) => ({
              ...origin,
              route,
              attemptId,
              bindingId,
              outcome: 'submitted',
            })),
          );
        }
        for (const { witness, image, fileIdSha256 } of pair) {
          const inserted = witness.inserted;
          expect(inserted).toMatchObject({
            requestId,
            nonce,
            userId: identity.userId,
          });
          expect(witness.claimed).toMatchObject({
            id: inserted.id,
            requestId,
            nonce,
            userId: identity.userId,
            turn: 1,
            images: inserted.images,
          });
          expect(witness.requested).toMatchObject({
            id: inserted.id,
            requestId,
            nonce,
            userId: identity.userId,
            images: [witness.attachmentId],
          });
          const splice = observed.find((event) => event.seq === inserted.seq);
          expect(splice).toMatchObject({
            type: 'agent/inbox/spliced',
            data: {
              inserted: [
                expect.objectContaining({
                  id: inserted.id,
                  source: expect.objectContaining({
                    rpcId: requestId,
                    principal: { kind: 'rdws', userId: identity.userId, nonce },
                  }),
                }),
              ],
            },
          });
          const entries = splice?.data.inserted as {
            id: string;
            content: { type: string; attachment?: { attachmentId: string } }[];
          }[];
          const originalMessage = entries.find(({ id }) => id === inserted.id);
          expect(
            originalMessage?.content
              .filter(({ type }) => type === 'image')
              .map(({ attachment }) => attachment?.attachmentId),
          ).toEqual(inserted.images);
          expect(witness.original).toMatchObject({ width: 32, height: 32 });
          expect(witness.variant).toMatchObject({ width: 8, height: 8 });
          expect(witness.variant.image.sha256).not.toBe(
            witness.original.sha256,
          );
          if (image) expect(witness.variant.image).toEqual(image);
          else expect(fileIdSha256).toBe(sha(receiptId));
        }
        return pair;
      }

      const positive = await send(accepted, true);
      expect(replies).toBe(1);
      expect(positive.every(({ hasOriginalImage }) => hasOriginalImage)).toBe(
        true,
      );
      expect(positive[0]!.witness.inserted.images).toEqual([
        positive[0]!.witness.attachmentId,
      ]);
      const negative = await send(late);
      expect(negative.every(({ hasOriginalImage }) => !hasOriginalImage)).toBe(
        true,
      );
      expect(negative[0]!.witness.claimed.images).toEqual([]);
      expect(negative[0]!.witness.attachmentId).toBe(
        positive[0]!.witness.attachmentId,
      );
      expect(negative[0]!.witness.inserted.images).toEqual([]);
      expect(negative[0]!.sessionId).not.toBe(positive[0]!.sessionId);
      expect(negative[0]!.bindingId).not.toBe(positive[0]!.bindingId);
      expect(negative[0]!.witness.inserted.nonce).not.toBe(
        positive[0]!.witness.inserted.nonce,
      );
      expect(negative[0]!.witness.variant).toEqual(
        positive[0]!.witness.variant,
      );
      expect(replies).toBe(1);
      if (useTls) {
        expect(httpEntries).toEqual(['/v1/files', '/v1/messages']);
        expect(lockReads).toHaveLength(2);
        expect(uploadedImages).toEqual([positive[0]!.witness.variant.image]);
        expect(positive[1]!.fileIdSha256).toBe(sha(receiptId));
        expect(positive[1]!.contentType).toBe('application/json');
        expect(negative[0]!.fileIdSha256).toBe(positive[1]!.fileIdSha256);
        expect(positive[0]!.attribution).toEqual(['user-agent']);
        expect(positive[1]!.attribution).toEqual(attributionHeaders);
        expect(
          [...positive, ...negative].every(
            ({ fixtureCredentialPresent }) => fixtureCredentialPresent,
          ),
        ).toBe(true);
        expect(arrivals).toEqual(
          positive.map(({ route, wireSha256, contentType }) => ({
            path: '/v1/' + route,
            wireSha256,
            contentType,
            accept: route === 'messages' ? 'text/event-stream' : undefined,
            version: '2023-06-01',
            beta: 'files-api-2025-04-14',
            encoding: 'identity',
            attribution: [],
            fixtureCredentialPresent: true,
          })),
        );
      }
    } finally {
      try {
        await startedHost?.close();
      } finally {
        try {
          if (server?.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve) =>
              server!.close(() => resolve()),
            );
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
  45000,
);
