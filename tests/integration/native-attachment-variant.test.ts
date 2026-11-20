import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { isRecord } from '@rdws/dsh/access';
import { sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';
import {
  createLoopbackAttachmentEgress,
  type AttachmentManifest,
} from '../../apps/server/src/modules/model-attachment-egress.ts';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import { createProjectContextReader } from '../../apps/server/src/modules/native-projects.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import {
  readDeepSeekFilesEvidence,
  readDeepSeekMessagesEvidence,
} from '../../apps/server/src/modules/model-attachment-evidence.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

const fixtureCredential = 'synthetic-variant-only';
const receiptId = 'synthetic-native-variant';
const authoredPath = '/fixture-user/explicit-attachment-context';
const credentialGeneration = 'native-variant-fixture';
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
  messageImages: NonNullable<
    ReturnType<typeof readDeepSeekMessagesEvidence>
  >['images'];
  manifest?: AttachmentManifest;
  destination: string;
  protocolHeaders: Record<string, string | null>;
  headerNames: string[];
  call: { provider: string; model: string; purpose?: string };
  current: boolean;
  wireSha256: string;
  projectedSha256: string;
  contentType: string | null;
  attribution: string[];
  fixtureCredentialPresent: boolean;
  witness: Witness;
  hasOriginalImage: boolean;
};

function observeMessages(
  wire: Buffer,
  contentType: string | null,
  model: string,
) {
  const request = readDeepSeekMessagesEvidence(wire, contentType, model);
  if (!request) throw new Error('Expected locked Native Messages');
  const decoded = JSON.parse(wire.toString('utf8')) as {
    messages: { role: string; content: { type: string; text?: string }[] }[];
  };
  const handles = request.images.map(({ messageIndex, blockIndex }) => {
    const text = decoded.messages[messageIndex]?.content[blockIndex - 1];
    if (text?.type !== 'text' || !text.text)
      throw new Error('Expected a generated description before each image');
    return text.text;
  });
  for (const image of [...request.images].reverse())
    decoded.messages[image.messageIndex]!.content.splice(
      image.blockIndex - 1,
      1,
    );
  const userContent = decoded.messages
    .filter(({ role }) => role === 'user')
    .flatMap(({ content }) =>
      content.map(({ type, text }) =>
        type === 'text' ? ['text', text] : ['image'],
      ),
    );
  return {
    handles,
    imageHandleDigests: handles.map((handle) => sha(JSON.stringify(handle))),
    userContentSha256: sha(JSON.stringify(userContent)),
    projectedSha256: sha(JSON.stringify(decoded)),
  };
}

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
  .each([
    'inline',
    'TLS receipt',
    'native receipt',
    'native inline',
    'native lost ACK',
    'native revoked',
    'native offload mixed',
    'native offload all',
  ] as const)(
  'Native variant evidence follows the original claimed input with %s',
  async (transport) => {
    const useTls = transport !== 'inline';
    const nativeManifest = transport.startsWith('native ');
    const nativeInline = transport === 'native inline';
    const loseAck = transport === 'native lost ACK';
    const revokeBeforeCarrier = transport === 'native revoked';
    const offload =
      transport === 'native offload mixed' ||
      transport === 'native offload all';
    const denied = loseAck || revokeBeforeCarrier || offload;
    let retryFirstMessage = transport === 'native receipt';
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-attachment-variant-'),
    );
    const config = join(root, 'config');
    const profile = join(config, 'profiles', 'rdws');
    const evidencePath = join(root, 'synthetic-evidence.jsonl');
    const project = 'attachment-variant';
    const attachmentObjects = join(
      root,
      'runtime',
      'dsh',
      'project-' + project,
      'attachments',
      'v1',
      'objects',
    );
    const provider = 'deepseek-official';
    const model = 'fixture-vision';
    const accepted =
      'Synthetic image admitted with original run at ' + authoredPath;
    const late = 'Synthetic original text with later variation';
    const file = 'Synthetic typed file rejection';
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
    const receivedImages: Attempt['messageImages'][] = [];
    const receivedTextBoundaries: boolean[] = [];
    const wireGrants = new Set<string>();
    const visibleGrants: boolean[] = [];
    const httpEntries: string[] = [];
    const uploadedImages: Image[] = [];
    const arrivals: {
      path: string;
      method: string | undefined;
      wireSha256: string;
      contentType: string | null;
      accept: string | undefined;
      version: string | undefined;
      beta: string | undefined;
      encoding: string | undefined;
      attribution: string[];
      fixtureCredentialPresent: boolean;
    }[] = [];
    const attemptScope = new AsyncLocalStorage<
      Pick<Attempt, 'route' | 'attemptId' | 'bindingId'>
    >();
    const nativeAttempts: (Pick<
      Attempt,
      'route' | 'attemptId' | 'bindingId' | 'callId'
    > & {
      manifest?: AttachmentManifest;
      wireSha256?: string;
      projectedSha256?: string;
      projection?: ReturnType<typeof observeMessages>;
      contentType: string | null;
    })[] = [];
    const registrations: {
      operation: string;
      callId: unknown;
      bindingId: unknown;
    }[] = [];
    const lockReads: ((typeof contextReads)[number] & {
      attemptId: string;
      route: string;
      bindingId: string | undefined;
      outcome?: string;
    })[] = [];
    const carrierEntries: string[] = [];
    const historicalInputs = new Map<string, Witness>();
    let tlsConnections = 0;
    const applicationBytes: number[] = [];
    let tcpConnections = 0;
    let authorityEntries = 0;
    const authorityFailures: { route: string; statusCode?: number }[] = [];
    let server: Server | undefined;
    let startedHost: NativeWebHost | undefined;
    let lab: Awaited<ReturnType<typeof authorityDatabase>> | undefined;
    let database: ReturnType<typeof connectDatabase> | undefined;
    let ownerGeneration: string | null = null;
    try {
      if (nativeManifest) {
        lab = await authorityDatabase();
        const startup = randomBytes(32).toString('hex');
        database = connectDatabase(
          lab.databaseUrl,
          randomBytes(32).toString('hex'),
        );
        await lab.owner.query('insert into project(id,name) values($1,$2)', [
          project,
          'Synthetic attachment project',
        ]);
        await lab.owner.query(
          'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
          [sha(startup)],
        );
        ownerGeneration = await acquireAuthority(database.pool, true, startup);
        if (!ownerGeneration) throw new Error('Missing test authority owner');
      }
      const business = database && createBusiness(database.db);
      const readContext = business && createProjectContextReader(business);
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
              if (nativeManifest)
                visibleGrants.push(
                  [...wireGrants].some(
                    (grant) =>
                      JSON.stringify(headers).includes(grant) ||
                      wire.includes(grant),
                  ),
                );
              arrivals.push({
                path,
                method: request.method,
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
                  id: nativeManifest
                    ? receiptId + '-' + uploadedImages.length
                    : receiptId,
                  type: 'file',
                  size_bytes: image.size,
                  created_at: new Date().toISOString(),
                  filename: image.name,
                  mime_type: image.type,
                });
                response.writeHead(nativeInline ? 403 : 200, {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(receipt),
                });
                response.end(receipt);
              } else if (path === '/v1/messages') {
                receivedTextBoundaries.push(
                  !wire.includes(attachmentObjects) &&
                    !wire.includes('rdws-synthetic-picture-') &&
                    wire.includes(authoredPath),
                );
                receivedImages.push(
                  readDeepSeekMessagesEvidence(
                    wire,
                    headers['content-type'] ?? null,
                    model,
                  )?.images ?? [],
                );
                if (retryFirstMessage) {
                  retryFirstMessage = false;
                  response.writeHead(429, { 'content-length': '0' }).end();
                  return;
                }
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
        server.on('connection', () => tcpConnections++);
        server.on('secureConnection', (socket) => {
          const index = tlsConnections++;
          applicationBytes.push(0);
          socket.on('data', (bytes: Buffer) => {
            applicationBytes[index]! += bytes.length;
          });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        base =
          'https://127.0.0.1:' +
          (server.address() as { port: number }).port +
          '/v1';
      }
      const routes = { files: base + '/files', messages: base + '/messages' };
      function makeHost() {
        const manifests = new Map<string, AttachmentManifest>();
        const host = new NativeWebHost(
          root,
          config,
          project,
          undefined,
          'mediated',
          {
            routes,
            attachmentManifests: nativeManifest,
            async handle(request): Promise<Response> {
              carrierEntries.push(request.routeId);
              if (nativeManifest) {
                if (request.call.attachmentGrant)
                  wireGrants.add(request.call.attachmentGrant);
                const attempt: (typeof nativeAttempts)[number] = {
                  route: request.routeId,
                  attemptId: request.attemptId,
                  callId: request.call.id,
                  bindingId: request.call.bindingId,
                  manifest: runs.attachmentManifestFor(request),
                  contentType: request.headers.get('content-type'),
                };
                nativeAttempts.push(attempt);
                const [body, observation] = request.body.tee();
                const [response] = await Promise.all([
                  attemptScope.run(attempt, () =>
                    egress!({ ...request, body }),
                  ),
                  new Response(observation).arrayBuffer().then((value) => {
                    const wire = Buffer.from(value);
                    attempt.wireSha256 = sha(wire);
                    if (request.routeId === 'messages') {
                      attempt.projection = observeMessages(
                        wire,
                        attempt.contentType,
                        request.call.model,
                      );
                      attempt.projectedSha256 =
                        attempt.projection.projectedSha256;
                    } else attempt.projectedSha256 = attempt.wireSha256;
                  }),
                ]);
                return response;
              }
              const wire = Buffer.from(
                await new Response(request.body).arrayBuffer(),
              );
              const type = request.headers.get('content-type');
              const projection =
                useTls && request.routeId === 'messages'
                  ? observeMessages(wire, type, request.call.model)
                  : undefined;
              const messages =
                request.routeId === 'messages'
                  ? readDeepSeekMessagesEvidence(wire, type, request.call.model)
                  : undefined;
              const part = messages?.images[0];
              const image =
                request.routeId === 'files'
                  ? readDeepSeekFilesEvidence(wire, type)?.image
                  : part?.kind === 'inline'
                    ? part.image
                    : undefined;
              const original = request.call.sessionId
                ? originals.get(request.call.sessionId)
                : undefined;
              if (!original) throw new Error('Missing signed admission');
              const evidence = (await readFile(evidencePath, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Witness);
              const candidates = evidence.filter(
                (entry) =>
                  entry.sessionId === request.call.sessionId &&
                  entry.inserted.requestId === original.requestId,
              );
              const bindingId = request.call.bindingId;
              if (
                (!image && !(useTls && part?.kind === 'file')) ||
                candidates.length !== 1 ||
                !bindingId
              )
                throw new Error('Missing request variant evidence');
              const witness = candidates[0]!;
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
                messageImages: messages?.images ?? [],
                destination: request.destination,
                headerNames: [...request.headers.keys()],
                call: {
                  provider: request.call.provider,
                  model: request.call.model,
                  purpose: request.call.purpose,
                },
                current: request.isCurrent() && !request.signal.aborted,
                protocolHeaders: Object.fromEntries(
                  [
                    'accept',
                    'accept-encoding',
                    'anthropic-version',
                    'anthropic-beta',
                  ].map((name) => [name, request.headers.get(name)]),
                ),
                wireSha256: sha(wire),
                projectedSha256: projection?.projectedSha256 ?? sha(wire),
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
                const previous = historicalInputs.get(witness.sessionId);
                const images = hasOriginalImage
                  ? [
                      ...(previous ? [previous.variant.image] : []),
                      witness.variant.image,
                    ]
                  : [];
                const manifest: AttachmentManifest = {
                  projectId: project,
                  requirementId: original.requirementId,
                  sessionId: witness.sessionId,
                  bindingId,
                  credentialGeneration,
                  images,
                  imageHandleDigests:
                    projection && hasOriginalImage
                      ? projection.imageHandleDigests
                      : images.map(() => sha('Legacy Files fixture')),
                  userContentSha256: projection?.userContentSha256 ?? sha('[]'),
                };
                attempt.manifest = manifest;
                attempts.push(attempt);
                manifests.set(bindingId, manifest);
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
          async (who, requirementId, sessionId, related) => {
            contextReads.push({
              userId: who.userId,
              authSessionId: who.authSessionId,
              requirementId,
              sessionId,
            });
            if (readContext)
              return readContext(
                project,
                who,
                requirementId,
                sessionId,
                related,
              );
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
            ? async (who, requirementId, sessionId, related, write) => {
                authorityEntries++;
                const attempt = attemptScope.getStore();
                if (!attempt)
                  throw new Error('Missing attempt at fixture authority');
                const submit = (deadline: number) => {
                  const result = write(deadline);
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
                };
                if (!business) return submit(Date.now() + 5000);
                try {
                  return await business.withModelAuthority(
                    who,
                    project,
                    requirementId,
                    sessionId,
                    related,
                    submit,
                  );
                } catch (error) {
                  authorityFailures.push({
                    route: attempt.route,
                    statusCode: (error as { statusCode?: number }).statusCode,
                  });
                  throw error;
                }
              }
            : undefined,
          false,
          nativeManifest
            ? { projectId: project, credentialGeneration }
            : undefined,
        );
        const egress =
          tls &&
          createLoopbackAttachmentEgress(routes, tls.cert, runs, (request) =>
            nativeManifest
              ? runs.attachmentManifestFor(request)
              : manifests.get(request.call.bindingId!),
          );
        host.configureContext(async (input, token, reply) => {
          const capability = host.verifyContext(token);
          const operation = capability?.operation;
          if (
            nativeManifest &&
            isRecord(input) &&
            (operation === 'model-attachment-prepare' ||
              operation === 'model-attachment-release')
          ) {
            const prepare = operation === 'model-attachment-prepare';
            const result = await runs.handle(
              input,
              token,
              denied && prepare ? undefined : reply,
            );
            if (prepare && revokeBeforeCarrier) {
              const image = Array.isArray(input.images) && input.images[0];
              if (!isRecord(image) || !database || !capability)
                throw new Error('Missing original login at revoke checkpoint');
              const deleted = await database.pool.query(
                'delete from auth_session where id=$1 returning id',
                [image.authSessionId],
              );
              if (deleted.rowCount !== 1)
                throw new Error('Original login was not revoked');
              reply(result, capability.expiresAt);
            }
            registrations.push({
              operation,
              callId: input.callId,
              bindingId: input.bindingId,
            });
            return result;
          }
          return runs.handle(input, token, reply);
        });
        return { host, runs };
      }
      let { host, runs } = makeHost();
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
              ...(transport === 'native offload mixed'
                ? { maxImagesPerRequest: 1, imageOffloadCountQuantum: 1 }
                : transport === 'native offload all'
                  ? { maxRequestFilesBytes: 1, imageOffloadByteQuantum: 1 }
                  : {}),
              models: [
                {
                  id: model,
                  inputModalities: ['text', 'image'],
                  imagePixelBudget: 64,
                },
              ],
              retryPolicy: {
                mode: 'normal',
                maxRetries: transport === 'native receipt' ? 1 : 0,
              },
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
                config: {
                  accepted,
                  late,
                  evidencePath,
                  repeatImages: nativeManifest,
                  file,
                },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );

      async function send(
        text: string,
        checkPublicRejection = false,
        reopened?: {
          sessionId: string;
          identity: Awaited<ReturnType<NativeWebHost['workspace']>> & {
            requirementId: string;
            userId: string;
            authSessionId: string;
          };
        },
      ) {
        const requirementId = reopened?.identity.requirementId ?? randomUUID();
        const requestId = randomUUID();
        const workspace = await host.workspace(
          requirementId,
          'Synthetic attachment verification',
          reopened !== undefined,
        );
        if (reopened)
          expect(workspace).toEqual({
            workspaceId: reopened.identity.workspaceId,
            cwd: reopened.identity.cwd,
          });
        const identity = reopened?.identity ?? {
          ...workspace,
          requirementId,
          userId: randomUUID(),
          authSessionId: randomUUID(),
        };
        const { sessionId } =
          reopened ??
          ((await sessionRpc(
            host,
            { ...identity, purpose: 'create' },
            'session/create',
            {
              workspaceId: workspace.workspaceId,
            },
          )) as { sessionId: string });
        if (database) {
          const { pool } = database;
          const { userId, authSessionId } = identity;
          await pool.query(
            'insert into auth_user(id,name,email) values($1,$2,$3)',
            [userId, 'Synthetic vision user', userId + '@fixture.invalid'],
          );
          await pool.query(
            "insert into project_member values($1,$2,'developer')",
            [project, userId],
          );
          await pool.query(
            "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Synthetic vision request','','',$3,$3)",
            [requirementId, project, userId],
          );
          await pool.query(
            "insert into requirement_participant values($1,$2,'developer')",
            [requirementId, userId],
          );
          await pool.query(
            'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
            [sessionId, requirementId, userId],
          );
          await pool.query(
            "insert into auth_session(id,token,user_id,expires_at) values($1,$2,$3,now()+interval '5 minutes')",
            [authSessionId, randomUUID(), userId],
          );
        }
        const browser = {
          ...identity,
          purpose: 'browser' as const,
          ownSessionIds: [sessionId],
          readSessionIds: [sessionId],
        };
        const ticket = host.ticket(browser);
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
        const previousEvents = reopened ? await events() : [];
        const sequenceFloor = Math.max(
          0,
          ...previousEvents.map(({ seq }) => seq),
        );
        const firstAttempt = attempts.length;
        const newAttempts = () => attempts.slice(firstAttempt);
        const currentEvents = async () =>
          (await events()).filter(({ seq }) => seq > sequenceFloor);

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
        if (nativeManifest) {
          const currentTurn = async () =>
            (await currentEvents()).find(
              ({ type, data }) => type === 'turn/end' && data.turn === 1,
            );
          await expect
            .poll(async () => Boolean(await currentTurn()), { timeout: 15000 })
            .toBe(true);
          const completed = checkPublicRejection && !denied;
          expect((await currentTurn())?.data.reason).toMatchObject({
            kind: completed ? 'completed' : 'error',
          });
          const observed = await currentEvents();
          const replies = observed.filter(
            ({ type }) => type === 'assistant/message',
          );
          const offloadCount = observed
            .filter(({ type }) => type === 'image/offload')
            .flatMap(({ data }) => {
              if (!Array.isArray(data.targets))
                throw new Error('Missing offload targets');
              return data.targets;
            })
            .reduce((sum, target) => {
              if (!isRecord(target) || !Array.isArray(target.imageIndexes))
                throw new Error('Missing image indexes');
              return sum + target.imageIndexes.length;
            }, 0);
          const typedFile = observed.some(
            ({ type, data }) =>
              type === 'user/message' &&
              Array.isArray(data.content) &&
              data.content.some(
                (part) => isRecord(part) && part.type === 'file',
              ),
          );
          if (completed)
            expect(JSON.stringify(replies)).toContain(
              'synthetic accepted variant',
            );
          else expect(replies).toHaveLength(0);
          return {
            pair: [],
            identity,
            sessionId,
            previousEvents,
            offloadCount,
            typedFile,
          };
        }
        const expectedRoutes =
          useTls && !checkPublicRejection
            ? ['messages']
            : ['files', 'messages'];
        await expect
          .poll(() => newAttempts().map((attempt) => attempt.route), {
            timeout: 10000,
          })
          .toEqual(expectedRoutes);
        const turn = newAttempts()[0]!.witness.claimed.turn;
        if (!reopened) expect(turn).toBe(1);
        const isTurnEnd = ({
          type,
          data,
        }: Awaited<ReturnType<typeof events>>[number]) =>
          type === 'turn/end' && data.turn === turn;
        await expect
          .poll(async () => (await currentEvents()).some(isTurnEnd), {
            timeout: 10000,
          })
          .toBe(true);
        const observed = await currentEvents();
        const turnEnd = observed.find(isTurnEnd);
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
          if (reopened)
            expect(turnEnd?.data.reason).toMatchObject({ kind: 'error' });
        }
        const pair = newAttempts();
        expect(pair.every((attempt) => attempt.sessionId === sessionId)).toBe(
          true,
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
        for (const { witness, image, messageImages, route } of pair) {
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
            turn,
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
          if (image) {
            expect(witness.variant.image).toEqual(image);
            expect(messageImages).toHaveLength(route === 'messages' ? 1 : 0);
          } else
            expect(messageImages).toEqual(
              Array.from({ length: reopened ? 2 : 1 }, () =>
                expect.objectContaining({
                  kind: 'file',
                  fileIdSha256: sha(receiptId),
                }),
              ),
            );
        }
        return {
          pair,
          identity,
          sessionId,
          previousEvents,
          offloadCount: 0,
          typedFile: false,
        };
      }

      const warm = await send(accepted, true);
      if (nativeManifest) {
        const origin = {
          userId: warm.identity.userId,
          authSessionId: warm.identity.authSessionId,
          requirementId: warm.identity.requirementId,
          sessionId: warm.sessionId,
        };
        expect(contextReads).toContainEqual(origin);
        const witnesses = (await readFile(evidencePath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Witness);
        const derived = new Map(
          witnesses.map((witness) => [
            witness.attachmentId,
            witness.variant.image,
          ]),
        );
        const first = witnesses[0]!.inserted;
        const appearances = first.images;
        const admission = originals.get(warm.sessionId)!;
        const source = {
          id: first.id,
          requestId: admission.requestId,
          userId: admission.userId,
          nonce: admission.nonce,
          images: appearances,
        };
        for (const witness of witnesses)
          expect(witness).toMatchObject({
            sessionId: warm.sessionId,
            inserted: source,
            claimed: { ...source, turn: 1 },
            requested: source,
            variant: { width: 8, height: 8 },
          });
        expect(derived.size).toBe(2);
        expect(appearances).toHaveLength(3);
        expect(appearances[0]).toBe(appearances[2]);
        expect(appearances[0]).not.toBe(appearances[1]);
        const evidence = appearances.map((id) => derived.get(id)!);
        expect(evidence[0]!.sha256).not.toBe(evidence[1]!.sha256);
        const expectedRoutes =
          loseAck || offload
            ? []
            : nativeInline || revokeBeforeCarrier
              ? ['files', 'messages']
              : ['files', 'files', 'messages', 'messages'];
        const expectedHttp = denied
          ? []
          : expectedRoutes.map((route) => '/v1/' + route);
        expect(carrierEntries).toEqual(expectedRoutes);
        expect(httpEntries).toEqual(expectedHttp);
        expect(nativeAttempts.map(({ route }) => route)).toEqual(
          expectedRoutes,
        );
        expect(authorityEntries).toBe(expectedRoutes.length);
        expect(
          new Set(nativeAttempts.map(({ attemptId }) => attemptId)).size,
        ).toBe(nativeAttempts.length);
        expect(arrivals).toEqual(
          denied
            ? []
            : nativeAttempts.map(({ route, projectedSha256, contentType }) => ({
                path: '/v1/' + route,
                method: 'POST',
                wireSha256: projectedSha256,
                contentType,
                accept: route === 'messages' ? 'text/event-stream' : undefined,
                version: '2023-06-01',
                beta:
                  route === 'files' || !nativeInline
                    ? 'files-api-2025-04-14'
                    : undefined,
                encoding: 'identity',
                attribution: [],
                fixtureCredentialPresent: true,
              })),
        );
        expect(visibleGrants).toEqual(expectedHttp.map(() => false));
        expect(lockReads).toEqual(
          denied
            ? []
            : nativeAttempts.map(({ route, attemptId, bindingId }) => ({
                ...origin,
                route,
                attemptId,
                bindingId,
                outcome: 'submitted',
              })),
        );
        for (const attempt of nativeAttempts)
          expect(attempt.manifest).toMatchObject({
            projectId: project,
            requirementId: origin.requirementId,
            sessionId: origin.sessionId,
            bindingId: attempt.bindingId,
            credentialGeneration,
            images: evidence,
          });
        const messages = nativeAttempts.filter(
          ({ route }) => route === 'messages',
        );
        for (const attempt of messages) {
          const projection = attempt.projection!;
          expect(projection.handles).toHaveLength(3);
          for (const handle of projection.handles)
            expect(handle.includes(attachmentObjects)).toBe(true);
          expect(
            projection.handles.map(
              (handle) =>
                /rdws-synthetic-picture-[a-z-]+\.png/.exec(handle)?.[0],
            ),
          ).toEqual([
            'rdws-synthetic-picture-a-first.png',
            'rdws-synthetic-picture-b.png',
            'rdws-synthetic-picture-a-last.png',
          ]);
          expect(projection.imageHandleDigests[0]).not.toBe(
            projection.imageHandleDigests[2],
          );
          expect(attempt.manifest).toMatchObject({
            imageHandleDigests: projection.imageHandleDigests,
            userContentSha256: projection.userContentSha256,
          });
          expect(attempt.wireSha256).not.toBe(attempt.projectedSha256);
        }
        expect(receivedTextBoundaries).toEqual(
          expectedHttp
            .filter((path) => path === '/v1/messages')
            .map(() => true),
        );

        const prepared = registrations.filter(
          ({ operation }) => operation === 'model-attachment-prepare',
        );
        const expectedCalls = offload ? 0 : !denied && !nativeInline ? 2 : 1;
        expect(prepared).toHaveLength(expectedCalls);
        expect(new Set(prepared.map(({ callId }) => callId)).size).toBe(
          expectedCalls,
        );
        expect(new Set(prepared.map(({ bindingId }) => bindingId)).size).toBe(
          offload ? 0 : 1,
        );
        expect(warm.offloadCount).toBe(
          transport === 'native offload mixed' ? 2 : offload ? 3 : 0,
        );
        expect(registrations).toEqual(
          prepared.flatMap((event) => [
            event,
            { ...event, operation: 'model-attachment-release' },
          ]),
        );
        if (nativeInline) {
          expect(uploadedImages).toEqual([evidence[0]]);
          expect(receivedImages).toEqual([
            evidence.map((image) =>
              expect.objectContaining({ kind: 'inline', image }),
            ),
          ]);
        } else if (!denied) {
          expect(uploadedImages).toEqual(evidence.slice(0, 2));
          const expectedReferences = [1, 2, 1].map((index) =>
            expect.objectContaining({
              kind: 'file',
              fileIdSha256: sha(receiptId + '-' + index),
            }),
          );
          expect(receivedImages).toEqual([
            expectedReferences,
            expectedReferences,
          ]);
          expect(nativeAttempts.map(({ callId }) => callId)).toEqual([
            prepared[0]!.callId,
            prepared[0]!.callId,
            prepared[0]!.callId,
            prepared[1]!.callId,
          ]);
        }
        expect(replies).toBe(denied ? 0 : 1);

        expect(authorityFailures).toEqual(
          revokeBeforeCarrier
            ? [
                { route: 'files', statusCode: 401 },
                { route: 'messages', statusCode: 401 },
              ]
            : [],
        );
        await send(late);
        if (nativeInline) expect((await send(file)).typedFile).toBe(true);
        await host.close();
        expect(carrierEntries).toEqual(expectedRoutes);
        expect(tcpConnections).toBe(expectedRoutes.length);
        expect(tlsConnections).toBe(expectedRoutes.length);
        expect(httpEntries).toEqual(expectedHttp);
        expect(authorityEntries).toBe(expectedRoutes.length);
        expect(registrations).toHaveLength(expectedCalls * 2);
        expect(wireGrants.size).toBe(loseAck ? 0 : expectedCalls);
        expect(applicationBytes.map((bytes) => bytes > 0)).toEqual(
          expectedRoutes.map(() => !denied),
        );
        expect(replies).toBe(denied ? 0 : 1);
        return;
      }
      const positive = warm.pair;
      expect(replies).toBe(1);
      expect(positive.every(({ hasOriginalImage }) => hasOriginalImage)).toBe(
        true,
      );
      expect(positive[0]!.witness.inserted.images).toEqual([
        positive[0]!.witness.attachmentId,
      ]);
      const { pair: negative } = await send(late);
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
        expect(tlsConnections).toBe(2);
        expect(tcpConnections).toBe(2);
        expect(lockReads).toHaveLength(2);
        expect(uploadedImages).toEqual([positive[0]!.witness.variant.image]);
        expect(positive[1]!.contentType).toBe('application/json');
        expect(positive[0]!.attribution).toEqual(['user-agent']);
        expect(positive[1]!.attribution).toEqual(attributionHeaders);
        expect(
          [...positive, ...negative].every(
            ({ fixtureCredentialPresent }) => fixtureCredentialPresent,
          ),
        ).toBe(true);
        expect(arrivals).toEqual(
          positive.map(({ route, projectedSha256, contentType }) => ({
            path: '/v1/' + route,
            method: 'POST',
            wireSha256: projectedSha256,
            contentType,
            accept: route === 'messages' ? 'text/event-stream' : undefined,
            version: '2023-06-01',
            beta: 'files-api-2025-04-14',
            encoding: 'identity',
            attribution: [],
            fixtureCredentialPresent: true,
          })),
        );

        const readyPath = join(
          root,
          'runtime',
          'instances',
          'project-' + project + '.ready.json',
        );
        const ready = async () =>
          JSON.parse(await readFile(readyPath, 'utf8')) as {
            pid: number;
            generation: string;
          };
        const warmReady = await ready();
        expect(warmReady.generation).toBe(host.contextGeneration);
        const cachePath = join(
          root,
          'runtime',
          'dsh',
          'project-' + project,
          'llm-deepseek',
          'files-v3.json',
        );
        const contents = await readFile(cachePath, 'utf8');
        const cache = JSON.parse(contents) as {
          formatVersion: number;
          records: {
            attachmentId: string;
            variantId: string;
            fileId: string;
          }[];
        };
        const warmWitness = positive[0]!.witness;
        expect(cache.formatVersion).toBe(3);
        expect(
          cache.records.map(({ attachmentId, variantId, fileId }) => ({
            attachmentId,
            variantId,
            fileIdSha256: sha(fileId),
          })),
        ).toEqual([
          {
            attachmentId: warmWitness.attachmentId,
            variantId: warmWitness.variant.id,
            fileIdSha256: sha(receiptId),
          },
        ]);
        historicalInputs.set(warm.sessionId, warmWitness);
        const before = {
          carrier: carrierEntries.length,
          tls: tlsConnections,
          tcp: tcpConnections,
          reads: contextReads.length,
        };

        await host.close();
        expect(await readFile(cachePath, 'utf8')).toBe(contents);
        ({ host, runs } = makeHost());
        const cold = await send(accepted, false, warm);
        const coldReady = await ready();
        expect(coldReady.generation).toBe(host.contextGeneration);
        expect(coldReady.generation).not.toBe(warmReady.generation);
        expect(coldReady.pid).not.toBe(warmReady.pid);
        expect(cold.previousEvents).toContainEqual(
          expect.objectContaining({
            type: 'agent/inbox/spliced',
            seq: warmWitness.inserted.seq,
            data: expect.objectContaining({
              inserted: expect.arrayContaining([
                expect.objectContaining({
                  id: warmWitness.inserted.id,
                  source: expect.objectContaining({
                    rpcId: warmWitness.inserted.requestId,
                  }),
                  content: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'image',
                      attachment: expect.objectContaining({
                        attachmentId: warmWitness.attachmentId,
                      }),
                    }),
                  ]),
                }),
              ]),
            }),
          }),
        );
        expect(cold.previousEvents).toContainEqual(
          expect.objectContaining({
            type: 'turn/end',
            data: expect.objectContaining({
              turn: warmWitness.claimed.turn,
              reason: expect.objectContaining({ kind: 'completed' }),
            }),
          }),
        );
        const [attempt] = cold.pair;
        const warmMessage = positive[1]!;
        expect(attempt?.witness.inserted.id).not.toBe(warmWitness.inserted.id);
        expect(attempt?.witness.inserted.requestId).not.toBe(
          warmWitness.inserted.requestId,
        );
        expect(attempt?.witness.variant).toEqual(warmWitness.variant);
        expect(attempt?.witness.attachmentId).toBe(warmWitness.attachmentId);
        expect(attempt?.attemptId).not.toBe(warmMessage.attemptId);
        expect(attempt?.callId).not.toBe(warmMessage.callId);
        expect(attempt?.bindingId).not.toBe(warmMessage.bindingId);
        expect(attempt).toMatchObject({
          hasOriginalImage: true,
          destination: warmMessage.destination,
          protocolHeaders: warmMessage.protocolHeaders,
          headerNames: warmMessage.headerNames,
          call: warmMessage.call,
          current: true,
          contentType: warmMessage.contentType,
          fixtureCredentialPresent: true,
          manifest: {
            projectId: warmMessage.manifest?.projectId,
            requirementId: warmMessage.manifest?.requirementId,
            sessionId: warmMessage.manifest?.sessionId,
            credentialGeneration: warmMessage.manifest?.credentialGeneration,
            bindingId: attempt!.bindingId,
            images: [warmWitness.variant.image, attempt!.witness.variant.image],
          },
        });
        expect(attempt!.messageImages[0]!.messageIndex).toBeLessThan(
          attempt!.messageImages[1]!.messageIndex,
        );
        expect(contextReads.slice(before.reads)).toContainEqual({
          userId: warm.identity.userId,
          authSessionId: warm.identity.authSessionId,
          requirementId: warm.identity.requirementId,
          sessionId: warm.sessionId,
        });

        await host.close();
        expect(carrierEntries.slice(before.carrier)).toEqual(['messages']);
        expect(authorityEntries).toBe(2);
        expect(tlsConnections).toBe(before.tls);
        expect(tcpConnections).toBe(before.tcp);
        expect(httpEntries).toEqual(['/v1/files', '/v1/messages']);
        expect(arrivals).toHaveLength(2);
        expect(lockReads).toHaveLength(2);
        expect(replies).toBe(1);
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
          try {
            if (database && ownerGeneration)
              await releaseAuthority(database.pool, ownerGeneration);
          } finally {
            try {
              await database?.pool.end();
            } finally {
              try {
                await lab?.close();
              } finally {
                await rm(root, { recursive: true, force: true });
              }
            }
          }
        }
      }
    }
  },
  60000,
);
