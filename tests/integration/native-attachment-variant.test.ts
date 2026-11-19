import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test } from 'vitest';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import {
  readDeepSeekFilesEvidence,
  readDeepSeekMessagesEvidence,
} from '../../apps/server/src/modules/model-attachment-evidence.ts';

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
  variant: { id: string; width: number; height: number; image: Image };
};
type Attempt = {
  route: string;
  attemptId: string;
  callId: string;
  bindingId?: string;
  sessionId: string;
  image: Image;
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

test.skipIf(process.platform !== 'darwin')(
  'Native variant bytes can be witnessed against their original claimed input',
  async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-attachment-variant-'),
    );
    const config = join(root, 'config');
    const profile = join(config, 'profiles', 'rdws');
    const evidencePath = join(root, 'synthetic-evidence.jsonl');
    const project = 'attachment-variant';
    const provider = 'deepseek-official';
    const model = 'fixture-vision';
    const base = 'http://127.0.0.1:1/v1';
    const routes = { files: `${base}/files`, messages: `${base}/messages` };
    const accepted = 'Synthetic image admitted with original run';
    const late = 'Synthetic original text with later variation';
    const attempts: Attempt[] = [];
    const originals = new Map<
      string,
      { userId: string; nonce: string; requestId: string }
    >();
    const contextReads: {
      userId: string;
      authSessionId: string;
      requirementId: string;
      sessionId: string;
    }[] = [];
    let replies = 0;
    const host = new NativeWebHost(
      root,
      config,
      project,
      undefined,
      'mediated',
      {
        routes,
        async handle(request) {
          const wire = Buffer.from(
            await new Response(request.body).arrayBuffer(),
          );
          const type = request.headers.get('content-type');
          const messages =
            request.routeId === 'messages'
              ? readDeepSeekMessagesEvidence(wire, type, model)
              : undefined;
          const inline = messages?.images[0];
          const image =
            request.routeId === 'files'
              ? readDeepSeekFilesEvidence(wire, type)?.image
              : messages?.images.length === 1 && inline?.kind === 'inline'
                ? inline.image
                : undefined;
          const evidence = (await readFile(evidencePath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Witness);
          const candidates = evidence.filter(
            (entry) => entry.sessionId === request.call.sessionId,
          );
          if (!image || candidates.length !== 1)
            throw new Error('Missing request variant evidence');
          const witness = candidates[0]!;
          const original = originals.get(witness.sessionId);
          const hasOriginalImage = await runs.authorizeModelAttempt(
            request,
            () =>
              Boolean(
                original &&
                [witness.inserted, witness.claimed, witness.requested].every(
                  (entry) =>
                    entry?.userId === original.userId &&
                    entry?.nonce === original.nonce &&
                    entry?.requestId === original.requestId,
                ),
              ) &&
              witness.inserted?.id === witness.claimed.id &&
              witness.claimed.id === witness.requested.id &&
              witness.inserted.images.includes(witness.attachmentId) &&
              witness.claimed.images.includes(witness.attachmentId) &&
              witness.requested.images.includes(witness.attachmentId) &&
              witness.variant.image.sha256 === image.sha256 &&
              witness.variant.image.bytes === image.bytes &&
              witness.variant.image.mediaType === image.mediaType,
          );
          attempts.push({
            route: request.routeId,
            attemptId: request.attemptId,
            callId: request.call.id,
            bindingId: request.call.bindingId,
            sessionId: witness.sessionId,
            image,
            witness,
            hasOriginalImage,
          });
          if (!hasOriginalImage || request.routeId === 'files')
            return new Response(null, { status: 403 });
          replies++;
          return syntheticMessages(model);
        },
      },
    );
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
    );
    host.configureContext((input, token, reply) =>
      runs.handle(input, token, reply),
    );
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_MODEL: 'synthetic-variant-only' },
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
        originals.set(sessionId, { userId: identity.userId, requestId, nonce });
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
        await expect
          .poll(
            () =>
              attempts
                .filter((attempt) => attempt.sessionId === sessionId)
                .map((attempt) => attempt.route),
            { timeout: 10000 },
          )
          .toEqual(['files', 'messages']);
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
        expect(new Set(pair.map(({ attemptId }) => attemptId)).size).toBe(2);
        expect(new Set(pair.map(({ callId }) => callId)).size).toBe(1);
        expect(pair[0]!.bindingId).toMatch(/^[a-f0-9-]{36}$/);
        expect(pair[1]!.bindingId).toBe(pair[0]!.bindingId);
        expect(contextReads).toContainEqual({
          userId: identity.userId,
          authSessionId: identity.authSessionId,
          requirementId,
          sessionId,
        });
        for (const { witness, image } of pair) {
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
          expect(witness.variant.image).toEqual(image);
        }
        return pair;
      }

      const positive = await send(accepted, true);
      expect(replies).toBe(1);
      expect(positive.map(({ hasOriginalImage }) => hasOriginalImage)).toEqual([
        true,
        true,
      ]);
      expect(positive[0]!.witness.inserted.images).toEqual([
        positive[0]!.witness.attachmentId,
      ]);
      const negative = await send(late);
      expect(negative.map(({ hasOriginalImage }) => hasOriginalImage)).toEqual([
        false,
        false,
      ]);
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
    } finally {
      try {
        await host.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  45000,
);
