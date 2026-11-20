import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { taskAssignmentMaterial } from '@rdws/contracts';
import { NativeWebHost } from '@rdws/dsh/web';
import { bodyHash, isRecord, signGrant } from '@rdws/dsh/access';
import { sessionRpc } from '@rdws/dsh/sessions';
import { DemandWorktrees } from '@rdws/orchestrator';
import { buildApp } from '@rdws/server';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { Client, Pool, type PoolClient } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import { checkedWriteTransaction } from '../../apps/server/src/modules/checked-write-transaction.ts';
import { NativeFixtureToolJob } from '../../apps/server/src/modules/native-fixture-tool-job.ts';
import { ContextRuns } from '../../apps/server/src/modules/runtime-context.ts';
import { connectDatabase, schema } from '@rdws/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import WebSocket from 'ws';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

afterEach(() => vi.unstubAllEnvs());

test.skipIf(process.platform !== 'darwin')(
  'the formal Native Host drives a single real broker execution through short controls',
  async () => {
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
    const lab = await authorityDatabase();
    const projectId = 'poc';
    const requirementId = randomUUID();
    const who = { userId: randomUUID(), authSessionId: randomUUID() };
    const authorityTicket = randomBytes(32).toString('hex');
    let source: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    let failedCleanup: PromiseRejectedResult | undefined;
    const hosts: NativeWebHost[] = [];
    const work = new Set<NativeFixtureToolJob>();
    try {
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Tool control fixture')",
        [projectId],
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values ($1,'Tool owner','tool@fixture.invalid','fixturetool',true)",
        [who.userId],
      );
      await lab.owner.query(
        "insert into auth_session(id,user_id,token,auth_epoch,expires_at) values ($1,$2,$3,0,now()+interval '10 minutes')",
        [who.authSessionId, who.userId, randomUUID()],
      );
      await lab.owner.query(
        "insert into project_member values($1,$2,'developer')",
        [projectId, who.userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,context_version) values($1,$2,'Tools','','',$3,$3,2)",
        [requirementId, projectId, who.userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, who.userId],
      );
      source = await httpsGitFixture(projectId);
      const root = source.root;
      mirrors = new RepositoryMirrors(root);
      trees = new DemandWorktrees(root, mirrors);
      await writeFile(join(source.work, 'sample.txt'), 'baseline');
      await fixtureGit(['-C', source.work, 'add', '--', 'sample.txt']);
      await source.commit();
      await source.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
        ...entry,
        branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
        worktreePath: 'worktrees/' + entry.repositoryId,
        gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
      }));
      await trees.prepare(projectId, requirementId, plan);
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [requirementId, JSON.stringify(plan)],
      );
      const checkout = await trees.executionScope(
        projectId,
        requirementId,
        plan,
        'app',
      );
      const file = join(checkout.tree, 'sample.txt');
      const configuration = join(root, 'tool-control-profile');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { TOOL_CONTROL: 'synthetic-only' },
        }),
        { mode: 0o600 },
      );
      const provider = 'rdws-glm';
      const model = 'tool-control';
      const base = 'https://tool-control.invalid/v1';
      const routes = { pi: base + '/chat/completions' };
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                [provider]: {
                  api: 'openai-completions',
                  baseURL: base,
                  apiKeyEnv: 'TOOL_CONTROL',
                  models: [{ id: model }],
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      const modes = [
        'once',
        'stale',
        'deadline',
        'prestart-cancel',
        'cancel',
        'close',
        'disconnect',
      ] as const;
      const fixtures = [];
      type ContextHandler = Parameters<NativeWebHost['configureContext']>[0];
      for (const mode of modes) {
        const hostRoot = join(root, 'control-host-' + mode);
        const callId = 'fixture-call-' + mode;
        type Message = {
          role: string;
          tool_call_id?: string;
          content?: unknown;
        };
        const modelResults: Message[] = [];
        const host = new NativeWebHost(
          hostRoot,
          configuration,
          projectId,
          undefined,
          'mediated',
          {
            routes,
            async handle(request): Promise<Response> {
              const input = (await new Response(request.body).json()) as {
                messages: Message[];
                tools?: { function: { name: string } }[];
              };
              const result = input.messages.find(
                (message) => message.tool_call_id === callId,
              );
              if (result) modelResults.push(result);
              else
                expect(
                  input.tools?.map(({ function: spec }) => spec.name),
                ).toEqual(['rdws_authority_probe']);
              const [delta, finish] = result
                ? [{ role: 'assistant', content: 'Fixture finished' }, 'stop']
                : [
                    {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: callId,
                          type: 'function',
                          function: {
                            name: 'rdws_authority_probe',
                            arguments: '{}',
                          },
                        },
                      ],
                    },
                    'tool_calls',
                  ];
              return runs.authorizeModelAttempt(
                request,
                () =>
                  new Response(
                    [
                      { index: 0, delta, finish_reason: null },
                      { index: 0, delta: {}, finish_reason: finish },
                    ]
                      .map(
                        (choice) =>
                          'data: ' +
                          JSON.stringify({
                            id: 'tool-control',
                            object: 'chat.completion.chunk',
                            created: 1,
                            model,
                            choices: [choice],
                          }) +
                          '\n\n',
                      )
                      .join('') + 'data: [DONE]\n\n',
                    { headers: { 'content-type': 'text/event-stream' } },
                  ),
              );
            },
          },
        );
        hosts.push(host);
        host.enableFixtureToolProbe();
        let reads = 0;
        let beforeNextRead: (() => Promise<void>) | undefined;
        const runs: ContextRuns = new ContextRuns(
          host.contextGeneration,
          (token) => host.verifyContext(token),
          async (actor, demand, session) => {
            const pause = beforeNextRead;
            beforeNextRead = undefined;
            const {
              rows: [row],
            } = await lab.owner.query<{ version: number; expires_at: Date }>(
              `select r.context_version as version, a.expires_at
                from requirement r join native_session n on n.requirement_id=r.id
                join auth_session a on a.user_id=n.owner_id
                where r.id=$1 and n.id=$2 and a.id=$3 and n.owner_id=$4`,
              [demand, session, actor.authSessionId, actor.userId],
            );
            await pause?.();
            if (!row) throw new Error('Fixture original login missing');
            reads++;
            return {
              value: {
                snapshot: {
                  requirementId,
                  contextVersion:
                    mode === 'stale' && reads === 1 ? 1 : row.version,
                },
                digest: 'tool-control-fixture',
              },
              validBefore: row.expires_at.getTime(),
            };
          },
          () => false,
          async () => ({
            provider,
            model,
            revision: 'fixture',
            routes,
            isCurrent: () => !host.signal.aborted,
          }),
        );
        let contextHandler: ContextHandler | undefined;
        host.configureContext((...args) => {
          if (!contextHandler)
            throw new Error('Fixture control handler is not ready');
          return contextHandler(...args);
        });
        const workspace = await host.workspace(
          requirementId,
          'Tool control workspace',
        );
        const identity = { ...who, requirementId, ...workspace };
        const { sessionId } = (await sessionRpc(
          host,
          { ...identity, purpose: 'create' },
          'session/create',
          {
            workspaceId: workspace.workspaceId,
          },
        )) as { sessionId: string };
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
          [sessionId, requirementId, who.userId],
        );
        const browser = host.ticket({
          ...identity,
          purpose: 'browser',
          readSessionIds: [sessionId],
          ownSessionIds: [sessionId],
        });
        fixtures.push({
          host,
          hostRoot,
          runs,
          mode,
          sessionId,
          browser,
          modelResults,
          callId,
          setContextHandler(handler: ContextHandler) {
            contextHandler = handler;
          },
          pauseNextRead(pause: () => Promise<void>) {
            beforeNextRead = pause;
          },
        });
      }
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(authorityTicket).digest('hex')],
      );
      const bff = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin: lab.childEnv.RDWS_ORIGIN!,
        authorityTicket,
        repositoryHome: root,
        nativeRuntimeRoot: root,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      });
      app = bff;
      await bff.ready();
      const broker = bff.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      const owner = async () =>
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation;
      const generation = await owner();
      expect(generation).toBeTruthy();
      const lease = async () =>
        (
          await lab.owner.query(
            'select phase,generation,run_id from requirement_write_lease where requirement_id=$1',
            [requirementId],
          )
        ).rows[0];
      const receipt = async (id: string) =>
        (
          await lab.owner.query(
            'select result from command_receipt where command_id=$1',
            [id],
          )
        ).rows[0]?.result;
      for (const {
        host,
        hostRoot,
        runs,
        mode,
        sessionId,
        browser,
        modelResults,
        callId,
        setContextHandler,
        pauseNextRead,
      } of fixtures) {
        const scope = { who, projectId, requirementId, sessionId };
        const grant = await broker.acquire(scope, randomUUID());
        expect(grant.contextVersion).toBe(2);
        const requestId = randomUUID();
        const run = runs.admit(
          who,
          requirementId,
          sessionId,
          requestId,
          host.claims(browser)!.nonce,
        );
        await host.control('run', {
          ...run,
          authSessionId: who.authSessionId,
          fixtureTool: true,
        });
        let output = '';
        const job = new NativeFixtureToolJob({
          scope,
          grant,
          broker,
          hostSignal: host.signal,
          repositoryId: 'app',
          request: {
            tool: 'shell',
            script: ['cancel', 'close', 'disconnect'].includes(mode)
              ? 'printf "started:%s\\n" "$$"; while :; do :; done'
              : "printf '|real-fd3' >> sample.txt; printf 'ran'",
          },
          onOutput: ({ stream, chunk }) => {
            if (stream === 'stdout') output += chunk.toString();
          },
        });
        work.add(job);
        const controls: string[] = [];
        let expiresAt = 0;
        let lostAcknowledgment = false;
        let staleDenied = false;
        const heldStatus = mode === 'cancel' ? latch() : undefined;
        const releaseStatus = mode === 'cancel' ? latch() : undefined;
        const releaseNativeSteps =
          mode === 'cancel' || mode === 'prestart-cancel' ? latch() : undefined;
        let cancelAccepted = false;
        let pendingStatusInput: unknown;
        const key = (
          await readFile(join(hostRoot, 'secrets', 'dsh-bff-key'), 'utf8')
        ).trim();
        const sign = (op: string, input: unknown) =>
          signGrant(key, {
            aud: 'rdws:bff:' + host.contextGeneration,
            purpose: 'service',
            operation: op,
            runId: run.runId,
            hostGeneration: host.contextGeneration,
            bodyHash: bodyHash(input),
          });
        let statusHeld = false;
        let selected = 0;
        const pauseStart =
          mode === 'deadline' || mode === 'prestart-cancel'
            ? holdCheckoutResult(
                (sql) =>
                  sql.includes('from "requirement_write_lease"') &&
                  sql.endsWith('for update') &&
                  ++selected === 2,
              )
            : undefined;
        let pauseSettlement: ReturnType<typeof holdCheckoutResult> | undefined;
        const handleContext: ContextHandler = async (body, token, reply) => {
          const cap = host.verifyContext(token);
          const operation = cap?.operation ?? '';
          if (operation.startsWith('fixture-tool-')) controls.push(operation);
          try {
            if (
              heldStatus &&
              releaseStatus &&
              operation === 'fixture-tool-status' &&
              !statusHeld
            ) {
              statusHeld = true;
              pendingStatusInput = body;
              pauseNextRead(async () => {
                heldStatus.resolve();
                await releaseStatus.promise;
              });
            }
            if (
              releaseNativeSteps &&
              (operation === 'model-step-release' ||
                operation === 'context-release')
            )
              await releaseNativeSteps.promise;
            if (operation === 'fixture-tool-permit') {
              const result = (await runs.handle(
                body,
                token,
                undefined,
                run,
                job,
              )) as { expiresAt: number };
              expiresAt = result.expiresAt;
              reply(result, expiresAt);
              return result;
            }
            if (
              mode === 'once' &&
              operation === 'fixture-tool-begin' &&
              !lostAcknowledgment
            ) {
              const result = await runs.handle(
                body,
                token,
                undefined,
                run,
                job,
              );
              lostAcknowledgment = true;
              const wrong = {
                ...(body as Record<string, unknown>),
                jobId: randomUUID(),
              };
              await expect(
                runs.handle(
                  wrong,
                  sign('fixture-tool-status', wrong),
                  undefined,
                  run,
                  job,
                ),
              ).rejects.toMatchObject({ statusCode: 403 });
              expect(
                await runs.handle(
                  body,
                  sign(operation, body),
                  undefined,
                  run,
                  job,
                ),
              ).toEqual({ accepted: true });
              return result;
            }
            const result = await runs.handle(body, token, reply, run, job);
            if (operation === 'fixture-tool-cancel') cancelAccepted = true;
            return result;
          } catch (error) {
            if (
              mode === 'stale' &&
              operation === 'fixture-tool-permit' &&
              (error as { statusCode?: number }).statusCode === 403
            )
              staleDenied = true;
            throw error;
          }
        };
        setContextHandler(handleContext);
        try {
          expect(
            await sessionRpc(host, browser, 'session/prompt', {
              sessionId,
              requestId,
              mode: 'queue',
              content: [
                { type: 'text', text: 'Run the exact tool-control fixture' },
              ],
            }),
          ).toEqual({ accepted: true });
          const events = async () =>
            (
              (await sessionRpc(host, browser, 'session/events', {
                address: { kind: 'session', sessionId },
              })) as {
                records: {
                  event: {
                    type: string;
                    seq: number;
                    sourceEventSeqs?: number[];
                    data: unknown;
                  };
                }[];
              }
            ).records.map(({ event }) => event);
          if (pauseStart) {
            await pauseStart.persisted.wait();
            expect((await receipt(job.commandId))?.status).toBe('reserved');
            expect(controls).toContain('fixture-tool-begin');
            if (mode === 'prestart-cancel') {
              await sessionRpc(host, browser, 'session/cancel', { sessionId });
              await expect.poll(() => cancelAccepted).toBe(true);
            } else {
              await delay(Math.max(0, expiresAt - Date.now()) + 10);
              expect(Date.now()).toBeGreaterThan(expiresAt);
            }
            pauseStart.finish.resolve();
          }
          if (mode === 'cancel' || mode === 'close' || mode === 'disconnect') {
            await expect.poll(() => output).toMatch(/started:[1-9][0-9]*\n/);
            const pid = Number(/started:([1-9][0-9]*)\n/.exec(output)![1]);
            expect(pid).toBeGreaterThan(1);
            const ids = execFileSync(
              '/bin/ps',
              ['-o', 'ppid=', '-o', 'pgid=', '-p', String(pid)],
              { encoding: 'utf8' },
            )
              .trim()
              .split(/\s+/)
              .map(Number);
            expect(ids).toEqual([process.pid, pid]);
            if (mode === 'cancel') {
              await heldStatus!.wait();
              await expect(
                runs.handle(
                  pendingStatusInput,
                  sign('fixture-tool-status', pendingStatusInput),
                  undefined,
                  run,
                  job,
                ),
              ).rejects.toMatchObject({ statusCode: 403 });
              await sessionRpc(host, browser, 'session/cancel', { sessionId });
              await expect.poll(() => cancelAccepted).toBe(true);
            } else if (mode === 'close') {
              await host.close();
              await job.close();
              expect(await owner()).toBe(generation);
            } else {
              const activeLease = await lease();
              expect(activeLease.run_id).toBeTruthy();
              pauseSettlement = holdCheckoutResult(
                (sql, params) =>
                  sql.startsWith('update "command_receipt"') &&
                  params.some(
                    (entry) =>
                      Array.isArray(entry) && entry.includes(job.commandId),
                  ) &&
                  params.some(
                    (entry) =>
                      Array.isArray(entry) &&
                      entry.some(
                        (value) =>
                          typeof value === 'string' &&
                          value.includes('"stop":"confirmed"'),
                      ),
                  ),
              );
              const child = Reflect.get(host, 'process') as ChildProcess;
              expect(child.connected).toBe(true);
              child.disconnect();
              await pauseSettlement.persisted.wait();
              expect(host.signal.aborted).toBe(true);
              const closed = (async () => {
                await host.close();
                await job.close();
                await bff.close();
              })();
              void closed.catch(() => {});
              expect(await owner()).toBe(generation);
              expect(await lease()).toMatchObject({
                run_id: activeLease.run_id,
              });
              expect(() => process.kill(-pid, 0)).toThrow(
                expect.objectContaining({ code: 'ESRCH' }),
              );
              pauseSettlement.finish.resolve();
              await closed;
              expect(await owner()).toBeNull();
              app = undefined;
            }
            await expect
              .poll(async () => (await receipt(job.commandId))?.status)
              .toBe('finished');
            expect(await receipt(job.commandId), mode).toMatchObject({
              status: 'finished',
              result: { status: 'aborted', stop: 'confirmed' },
            });
            for (const target of [pid, -pid])
              expect(() => process.kill(target, 0)).toThrow(
                expect.objectContaining({ code: 'ESRCH' }),
              );
            releaseStatus?.resolve();
          }
          if (mode === 'once') {
            await expect
              .poll(() => modelResults.length, { timeout: 10_000 })
              .toBe(1);
            expect(lostAcknowledgment).toBe(true);
            expect(await receipt(job.commandId)).toMatchObject({
              status: 'finished',
              result: { status: 'ok', stop: 'confirmed' },
            });
            expect(modelResults).toEqual([
              expect.objectContaining({
                role: 'tool',
                tool_call_id: callId,
                content: 'RDWS fixture worktree state: ok',
              }),
            ]);
            expect(
              controls.filter(
                (operation) => operation === 'fixture-tool-begin',
              ),
            ).toHaveLength(1);
            expect(controls).toContain('fixture-tool-status');
            const all = await events();
            const call = all.find(({ type }) => type === 'tool/call');
            expect(
              all.find(({ type }) => type === 'tool/result'),
            ).toMatchObject({
              sourceEventSeqs: [call?.seq],
              data: { message: { toolCallId: callId } },
            });
          }
          if (mode === 'stale') {
            await expect.poll(() => staleDenied).toBe(true);
            expect(controls).not.toContain('fixture-tool-begin');
            expect(await receipt(job.commandId)).toBeUndefined();
          }
          if (mode === 'deadline' || mode === 'prestart-cancel') {
            await expect
              .poll(async () => (await receipt(job.commandId))?.status)
              .toBe('finished');
            expect(await receipt(job.commandId)).toMatchObject({
              status: 'finished',
              result: { status: 'aborted', stop: 'not-started' },
            });
            expect(output).toBe('');
            if (mode === 'deadline')
              await expect
                .poll(
                  async () =>
                    (await events()).find(({ type }) => type === 'tool/result')
                      ?.data,
                )
                .toMatchObject({
                  message: { toolCallId: callId, isError: true },
                });
          }
          releaseNativeSteps?.resolve();
          expect(await readFile(file, 'utf8')).toBe('baseline|real-fd3');
          if (mode !== 'disconnect') {
            await host.close();
            await job.close();
            expect(await lease()).toMatchObject({
              phase: 'held',
              generation: grant.generation,
              run_id: null,
            });
            expect(
              await broker.release(scope, grant.generation, randomUUID()),
            ).toBe('released');
          }
          work.delete(job);
        } finally {
          releaseStatus?.resolve();
          releaseNativeSteps?.resolve();
          for (const paused of [pauseStart, pauseSettlement]) {
            paused?.finish.resolve();
            paused?.restore();
          }
        }
      }
    } finally {
      const hostsClosed = await Promise.allSettled(
        hosts.map((host) => host.close()),
      );
      const jobsClosed = await Promise.allSettled(
        [...work].map((job) => job.close()),
      );
      failedCleanup = [...hostsClosed, ...jobsClosed].find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      try {
        if (!failedCleanup) await app?.close();
      } finally {
        await trees?.close();
        await mirrors?.close();
        await source?.close();
        await lab.close();
      }
    }
    if (failedCleanup) throw failedCleanup.reason;
  },
  90_000,
);

function latch() {
  let resolve!: () => void;
  let opened = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      opened = true;
      done();
    };
  });
  return { promise, resolve, wait: () => expect.poll(() => opened).toBe(true) };
}

type BrokerResult = Awaited<ReturnType<OwnedWriteHandoff['execute']>>;
type NativeOutcome = BrokerResult | { status: 'rejected'; code: number };

async function nativeBrokerTool(
  sessionId: string,
  invoke: () => Promise<NativeOutcome>,
  beforeDispatch: () => Promise<unknown> = async () => {},
  mismatch = false,
) {
  const correlation = randomUUID();
  const callId = 'call-' + correlation;
  const child = fork(
    new URL('../fixtures/native-parent-broker-tool.mjs', import.meta.url),
    [sessionId, correlation, mismatch ? 'mismatch' : 'normal'],
    {
      execArgv: [],
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  let fail!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  const timer = setTimeout(
    () => fail(new Error('Native Broker fixture did not finish')),
    15_000,
  );
  let queue = Promise.resolve();
  let admitting = true;
  let phase = 'declared';
  let observed: unknown;
  let seq: number | undefined;
  let outcome: NativeOutcome | undefined;
  child.on('error', fail);
  child.once('disconnect', () => {
    admitting = false;
  });
  function reply(type: string, value?: NativeOutcome) {
    return new Promise<void>((resolve, reject) => {
      child.send({ correlation, type, outcome: value }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  child.on('message', (message: unknown) => {
    if (!admitting) return;
    queue = queue.then(async () => {
      if (
        !isRecord(message) ||
        message.correlation !== correlation ||
        message.type !== phase ||
        Buffer.byteLength(JSON.stringify(message)) > 4096
      )
        throw new Error('Unexpected Native Broker fixture message');
      switch (message.type) {
        case 'declared':
          expect(message.names).toEqual(['rdws_broker_fixture']);
          phase = 'observed';
          await beforeDispatch();
          await reply('dispatch');
          return;
        case 'observed':
          if (
            !isRecord(message.call) ||
            !Number.isSafeInteger(message.call.seq)
          )
            throw new Error('Native did not observe an actual tool call');
          seq = message.call.seq as number;
          expect(seq).toBeGreaterThan(0);
          expect(message.call).toEqual({
            sessionId,
            callId,
            seq,
            turn: 1,
            step: 1,
          });
          observed = message.call;
          phase = 'invoke';
          return;
        case 'invoke': {
          if (!admitting) return;
          phase = 'complete';
          const matches =
            JSON.stringify(message.call) === JSON.stringify(observed);
          outcome = matches
            ? await invoke()
            : { status: 'rejected', code: 400 };
          await reply('outcome', outcome);
          return;
        }
        case 'complete': {
          const content = [{ type: 'text', text: JSON.stringify(outcome) }];
          expect(message.cause).toBe(seq);
          expect(message.refs).toContain(seq);
          expect(message.message).toMatchObject({
            toolCallId: callId,
            content,
          });
          expect(message.followUp).toMatchObject({
            toolCallId: callId,
            content,
          });
          phase = 'closed';
        }
      }
    });
    void queue.catch(fail);
  });
  try {
    const completed = closed.then(async (code) => {
      if (code === 0) await queue;
      return code;
    });
    expect(await Promise.race([completed, failure])).toBe(0);
    expect(phase).toBe('closed');
    return outcome;
  } finally {
    admitting = false;
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanupDeadline = new Promise<never>((_resolve, reject) => {
      cleanupTimer = setTimeout(
        () =>
          reject(new Error('Native Broker fixture cleanup was not confirmed')),
        4_000,
      );
    });
    try {
      await Promise.race([
        Promise.all([closed, Promise.allSettled([queue])]),
        cleanupDeadline,
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}

function holdGuardedCommit(
  scope: string,
  outcome: 'delay' | 'lose' | 'rollback' = 'delay',
) {
  let release!: () => void;
  let entered = false;
  let command: string | undefined;
  let originalBackend: number | undefined;
  const receiptBackends: number[] = [];
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient & { processID: number }) => {
      const query = client.query;
      let marked = false;
      client.query = ((...parameters: unknown[]) => {
        const config = parameters[0] as
          string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof config === 'string'
            ? []
            : config.values;
        if (values?.includes('write.authority:' + scope)) {
          if (text?.startsWith('insert into "command_receipt"') && !entered) {
            marked = true;
            originalBackend = client.processID;
          }
          if (
            text?.startsWith('select "digest" from "command_receipt"') &&
            entered
          )
            receiptBackends.push(client.processID);
        }
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (text === 'commit' && marked && !entered)
          return (async () => {
            if (outcome === 'rollback')
              await Reflect.apply(query, client, ['select 1 / 0']).catch(
                () => {},
              );
            const result = await Reflect.apply(query, client, parameters);
            command = result.command;
            entered = true;
            if (outcome === 'lose')
              throw new Error(
                'Synthetic guarded transaction acknowledgement failure',
              );
            if (outcome === 'delay') await wait;
            return result;
          })();
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    get entered() {
      return entered;
    },
    expectIndependentReceipt(expected: 'COMMIT' | 'ROLLBACK') {
      expect(command).toBe(expected);
      expect(originalBackend).toEqual(expect.any(Number));
      expect(receiptBackends.length).toBeGreaterThan(0);
      expect(receiptBackends).not.toContain(originalBackend);
    },
    release,
    restore: () => spy.mockRestore(),
  };
}

function holdCheckoutResult(
  matches: (sql: string, parameters: unknown[]) => boolean,
) {
  const persisted = latch();
  const finish = latch();
  const rolledBack = latch();
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      let held = false;
      client.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as string | { text: string };
        const sql = typeof input === 'string' ? input : input.text;
        const response = Reflect.apply(query, client, parameters);
        if (sql === 'rollback' || sql === 'commit') {
          client.query = query;
          if (held && sql === 'rollback') rolledBack.resolve();
        }
        if (matches(sql, parameters)) {
          held = true;
          return response.then(async (result: unknown) => {
            persisted.resolve();
            await finish.promise;
            return result;
          });
        }
        return response;
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return { persisted, finish, rolledBack, restore: () => spy.mockRestore() };
}

function refuseGuardedRead(scope: string, foreign: AsyncLocalStorage<boolean>) {
  let foreignReads = 0;
  let attempts = 0;
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      client.query = ((...parameters: unknown[]) => {
        const config = parameters[0] as
          string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof config === 'string'
            ? []
            : config.values;
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (
          text?.startsWith('select "digest" from "command_receipt"') &&
          values?.includes('write.authority:' + scope)
        ) {
          attempts++;
          if (foreign.getStore()) foreignReads++;
          return Promise.reject(
            new Error('Synthetic write authority proof unavailable'),
          );
        }
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    get foreignReads() {
      return foreignReads;
    },
    get attempts() {
      return attempts;
    },
    restore: () => spy.mockRestore(),
  };
}

test('a guarded transaction discards a pooled connection with an unfinished transaction', async () => {
  const lab = await authorityDatabase();
  const pool = new Pool({ connectionString: lab.databaseUrl, max: 1 });
  try {
    await lab.admin.query(
      "alter role rdws_test_app set synchronous_commit='off'",
    );
    const configured = connectDatabase(
      lab.databaseUrl,
      undefined,
      undefined,
      true,
    ).pool;
    try {
      const [first, second] = await Promise.all([
        configured.connect(),
        configured.connect(),
      ]);
      try {
        const settings = await Promise.all(
          [first, second].map((client) =>
            client.query('show synchronous_commit'),
          ),
        );
        expect(settings.map(({ rows }) => rows[0]?.synchronous_commit)).toEqual(
          ['on', 'on'],
        );
      } finally {
        first.release();
        second.release();
      }
    } finally {
      await configured.end();
    }
    const stale = await pool.connect();
    try {
      await stale.query('begin');
      await stale.query(
        "insert into project(id,name) values('uncommitted','Synthetic unfinished operation')",
      );
    } finally {
      stale.release();
    }
    const guarded = checkedWriteTransaction(pool);
    const read = (tx: Parameters<Parameters<typeof guarded>[0]>[0]) =>
      tx
        .select()
        .from(schema.project)
        .where(eq(schema.project.id, 'uncommitted'));
    await expect(guarded(read)).rejects.toThrow('connection is not idle');
    expect(await guarded(read)).toEqual([]);
    const bounded = connectDatabase(lab.databaseUrl, undefined, 250, true).pool;
    try {
      const timed = await bounded.connect();
      let previousBackend: number | undefined;
      try {
        previousBackend = (
          await timed.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]?.pid;
        await timed.query('begin');
        await timed.query(
          "insert into project(id,name) values('timed','Synthetic timed operation')",
        );
        await expect(timed.query('select pg_sleep(2)')).rejects.toThrow(
          'Query read timeout',
        );
      } finally {
        timed.release();
      }
      expect(
        (await bounded.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid,
      ).not.toBe(previousBackend);
      expect(
        (await bounded.query("select id from project where id='timed'")).rows,
      ).toEqual([]);
      const beforeBegin = await bounded.connect();
      const query = beforeBegin.query;
      let opened = false;
      beforeBegin.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as string | { text: string };
        const text = typeof input === 'string' ? input : input.text;
        if (!opened && text?.startsWith('begin')) {
          opened = true;
          return Reflect.apply(query, beforeBegin, ['select pg_sleep(2)']);
        }
        return Reflect.apply(query, beforeBegin, parameters);
      }) as typeof query;
      beforeBegin.release();
      await expect(
        drizzle(bounded).transaction(async () => true),
      ).rejects.toMatchObject({ cause: { message: 'Query read timeout' } });
      expect(opened).toBe(true);
      expect(bounded.totalCount).toBe(0);
    } finally {
      await bounded.end();
    }
  } finally {
    await pool.end();
    await lab.close();
  }
});

test('a rejected ordinary BEGIN discards that real PostgreSQL checkout', async () => {
  const lab = await authorityDatabase();
  const { db, pool } = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const original = await pool.connect();
  try {
    const pid = (
      await original.query<{ pid: number }>('select pg_backend_pid() as pid')
    ).rows[0]!.pid;
    original.release();
    const entered = vi.fn(async () => true);
    await expect(
      db.transaction(entered, {
        isolationLevel: 'invalid isolation fixture' as 'read committed',
      }),
    ).rejects.toMatchObject({ cause: { code: '42601' } });
    expect(entered).not.toHaveBeenCalled();
    expect(pool.totalCount).toBe(0);
    expect(
      (await pool.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid,
    ).not.toBe(pid);
  } finally {
    if (pool.totalCount > pool.idleCount) original.release(true);
    await pool.end();
    await lab.close();
  }
});

test('a borrowed PostgreSQL backend can disconnect and a saturated pool recovers', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const clients: PoolClient[] = [];
  try {
    const broken = await database.pool.connect();
    try {
      const pid = (
        await broken.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0]!.pid;
      expect(
        (
          await lab.admin.query('select pg_terminate_backend($1) as stopped', [
            pid,
          ])
        ).rows[0]?.stopped,
      ).toBe(true);
      await expect.poll(() => database.pool.totalCount).toBe(0);
      await expect(broken.query('select 1')).rejects.toThrow();
      expect(
        (
          await database.pool.query<{ pid: number }>(
            'select pg_backend_pid() as pid',
          )
        ).rows[0]!.pid,
      ).not.toBe(pid);
    } finally {
      broken.release();
    }
    for (let index = 0; index < database.pool.options.max!; index++)
      clients.push(await database.pool.connect());
    await expect(database.pool.connect()).rejects.toThrow('timeout');
    expect(database.pool.waitingCount).toBe(0);
    clients.pop()!.release();
    expect((await database.pool.query('select 1 as ready')).rows).toEqual([
      { ready: 1 },
    ]);
  } finally {
    for (const client of clients) client.release();
    await database.close();
    await lab.close();
  }
});

test('a late real BEGIN never enters business logic and remains in the shutdown drain', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const acknowledgedBegin = latch();
  const finishBegin = latch();
  const client = await database.pool.connect();
  const [{ pid }] = (
    await client.query<{ pid: number }>('select pg_backend_pid() as pid')
  ).rows as [{ pid: number }];
  const query = client.query;
  client.query = ((...parameters: unknown[]) => {
    const input = parameters[0] as string | { text: string };
    const sql = typeof input === 'string' ? input : input.text;
    const result = Reflect.apply(query, client, parameters);
    return /^begin\b/i.test(sql)
      ? result.then(async (value: unknown) => {
          acknowledgedBegin.resolve();
          await finishBegin.promise;
          return value;
        })
      : result;
  }) as typeof query;
  client.release();
  const checked = checkedWriteTransaction(database.pool);
  const work = vi.fn(async () => true);
  const rejected = expect(checked(work)).rejects.toThrow(
    'transaction timed out',
  );
  try {
    await acknowledgedBegin.promise;
    expect(client.getTransactionStatus()).toBe('T');
    expect(
      (
        await lab.admin.query(
          'select state from pg_stat_activity where pid=$1',
          [pid],
        )
      ).rows[0]?.state,
    ).toBe('idle in transaction');
    await rejected;
    const drained = vi.fn();
    const draining = checked.drain().then(drained);
    await expect.poll(() => database.pool.totalCount).toBe(0);
    await expect
      .poll(
        async () =>
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
      )
      .toBe(0);
    expect(drained).not.toHaveBeenCalled();
    finishBegin.resolve();
    await draining;
    expect(work).not.toHaveBeenCalled();
  } finally {
    finishBegin.resolve();
    await checked.drain();
    await database.close();
    await lab.close();
  }
});

test('database shutdown waits for the real connection end after the pool removes it', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const client = await database.pool.connect();
  const pid = (
    await client.query<{ pid: number }>('select pg_backend_pid() as pid')
  ).rows[0]!.pid;
  const finish = latch();
  const end = Client.prototype.end;
  const closeClient = vi
    .spyOn(Client.prototype, 'end')
    .mockImplementation(function (this: Client, ...args: unknown[]) {
      return this === (client as unknown)
        ? finish.promise.then(() => Reflect.apply(end, this, args))
        : Reflect.apply(end, this, args);
    } as typeof end);
  const returned = vi.fn();
  client.release(true);
  const closing = database.close().then(returned);
  try {
    await expect.poll(() => database.pool.totalCount).toBe(0);
    expect(
      (
        await lab.admin.query('select pid from pg_stat_activity where pid=$1', [
          pid,
        ])
      ).rowCount,
    ).toBe(1);
    expect(returned).not.toHaveBeenCalled();
    finish.resolve();
    await closing;
    await expect
      .poll(
        async () =>
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
      )
      .toBe(0);
  } finally {
    finish.resolve();
    closeClient.mockRestore();
    await closing;
    await lab.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'shutdown retains its owner when a committed qualification command still cannot be read back',
  async () => {
    const lab = await authorityDatabase();
    const userId = randomUUID();
    const requirementId = randomUUID();
    const taskId = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      await lab.owner.query(
        "insert into project(id,name) values('poc','Proof fixture')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username) values($1,'Fixture','proof@fixture.invalid','proof')",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Proof fixture','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into task(id,requirement_id,title,assignee_id,created_by) values($1,$2,'Proof task',$3,$3)",
        [taskId, requirementId, userId],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      const bff = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin,
        nativeRuntimeRoot: lab.root,
        repositoryHome: lab.root,
        authorityTicket: ticket,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      });
      app = bff;
      await bff.ready();
      const login = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'proof', password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies
        .map(({ name, value }) => name + '=' + value)
        .join('; ');
      const authority = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      const readFailure = refuseGuardedRead(
        'requirement:' + requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        const outcome = await bff.inject({
          method: 'POST',
          url: `/api/requirements/${requirementId}/commands`,
          headers: { cookie, origin },
          payload: {
            type: 'task.update',
            commandId: randomUUID(),
            taskId,
            patch: { status: 'done' },
          },
        });
        expect(outcome.statusCode, outcome.body).toBe(503);
        expect(
          (
            await lab.owner.query('select status from task where id=$1', [
              taskId,
            ])
          ).rows[0]?.status,
        ).toBe('done');
        expect(readFailure.attempts).toBeGreaterThan(0);
        await expect(bff.close()).rejects.toThrow('shutdown was not confirmed');
        app = undefined;
        expect(
          (
            await lab.owner.query(
              'select generation from rdws_authority.owner where singleton',
            )
          ).rows[0]?.generation,
        ).toBe(authority);
      } finally {
        readFailure.restore();
      }
    } finally {
      await app?.close().catch(() => {});
      await lab.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the BFF shares one owner and stops a real write when a guarded route removes its authority',
  async () => {
    const lab = await authorityDatabase();
    const projectId = 'poc';
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const taskId = randomUUID();
    const secondTask = randomUUID();
    let fixture: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Shared writer')",
        [projectId],
      );
      const encrypted = await hashPassword(password);
      async function account(username: string, role: string, admin = false) {
        const userId = randomUUID();
        await lab.owner.query(
          'insert into auth_user (id,name,email,username,active,platform_admin) values ($1,$2,$3,$2,true,$4)',
          [userId, username, username + '@fixture.invalid', admin],
        );
        await lab.owner.query('insert into project_member values ($1,$2,$3)', [
          projectId,
          userId,
          role,
        ]);
        await lab.owner.query(
          "insert into auth_account (id,account_id,provider_id,user_id,password) values ($1,$2,'credential',$2,$3)",
          [randomUUID(), userId, encrypted],
        );
        return { userId, username };
      }
      const lead = await account('shared_lead', 'developer');
      const assigned = await account('shared_worker', 'developer');
      const manager = await account('shared_manager', 'project_admin', true);

      fixture = await httpsGitFixture(projectId);
      mirrors = new RepositoryMirrors(fixture.root);
      trees = new DemandWorktrees(fixture.root, mirrors);
      await writeFile(join(fixture.work, 'sample.txt'), 'baseline');
      await fixtureGit(['-C', fixture.work, 'add', '--', 'sample.txt']);
      await fixture.commit();
      await fixture.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const baselines = await mirrors.captureBaselines(projectId);
      async function demand(ownerId: string) {
        const id = randomUUID();
        const sessionId = randomUUID();
        await lab.owner.query(
          "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by) values ($1,$2,'Fixture','','',$3,$4)",
          [id, projectId, lead.userId, lead.userId],
        );
        for (const member of [lead, assigned])
          await lab.owner.query(
            "insert into requirement_participant values ($1,$2,'developer')",
            [id, member.userId],
          );
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values ($1,$2,$3)',
          [sessionId, id, ownerId],
        );
        const plan = baselines.map((entry) => ({
          ...entry,
          branch: `rdws/${id}/${entry.repositoryId}`,
          worktreePath: 'worktrees/' + entry.repositoryId,
          gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
        }));
        await trees!.prepare(projectId, id, plan);
        await lab.owner.query(
          'insert into requirement_worktree_plan values ($1,$2)',
          [id, JSON.stringify(plan)],
        );
        const scope = await trees!.executionScope(projectId, id, plan, 'app');
        return {
          requirementId: id,
          sessionId,
          tree: scope.tree,
          control: scope.control,
        };
      }
      const work = await demand(assigned.userId);
      const other = await demand(lead.userId);
      const forFailedClose = await demand(lead.userId);
      const nativeWork = await demand(lead.userId);
      const nextNativeSession = randomUUID();
      await lab.owner.query(
        'insert into native_session(id,requirement_id,owner_id) values ($1,$2,$3)',
        [nextNativeSession, nativeWork.requirementId, lead.userId],
      );
      await lab.owner.query(
        "insert into task (id,requirement_id,title,assignee_id,created_by,status) values ($1,$2,'Assignment',$3,$4,'in_progress')",
        [taskId, work.requirementId, assigned.userId, lead.userId],
      );
      await lab.owner.query(
        "insert into task (id,requirement_id,title,assignee_id,created_by,status) values ($1,$2,'Second assignment',$3,$4,'todo')",
        [secondTask, work.requirementId, assigned.userId, lead.userId],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      const profile = join(fixture.root, 'config/projects/poc/dsh');
      await mkdir(join(profile, 'profiles/rdws'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(profile, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_WRITE: 'synthetic-local-only' },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'profiles/rdws/cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                'rdws-glm': {
                  api: 'openai-completions',
                  baseURL: 'http://127.0.0.1:1/v1',
                  apiKeyEnv: 'FIXTURE_WRITE',
                  models: [{ id: 'synthetic-test' }],
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      const config = {
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        nativeRuntimeRoot: fixture.root,
        repositoryHome: fixture.root,
        nativeProfiles: new Map([[projectId, profile]]),
        authorityTicket: ticket,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      };
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      expect(() => buildApp(config)).toThrow('managed macOS test BFF');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      let pathReads = 0;
      const halfStarted = buildApp({
        ...config,
        isolatedWrite: {
          get gitPath() {
            if (++pathReads > 1)
              throw new Error('Synthetic failure after owner admission');
            return config.isolatedWrite.gitPath;
          },
        },
      });
      await expect(halfStarted.ready()).rejects.toThrow(
        'Synthetic failure after owner admission',
      );
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBeNull();
      await halfStarted.close().catch(() => {});
      async function refreshTicket() {
        config.authorityTicket = randomBytes(32).toString('hex');
        await lab.owner.query(
          'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
          [createHash('sha256').update(config.authorityTicket).digest('hex')],
        );
      }
      await refreshTicket();
      const inStartup = buildApp(config);
      const admission = holdCheckoutResult((sql) =>
        sql.startsWith('select rdws_authority.admit_owner'),
      );
      const starting = Promise.resolve(inStartup.ready()).catch(
        (error: unknown) => error,
      );
      try {
        await admission.persisted.wait();
        const shutdown = inStartup.close().catch((error: unknown) => error);
        admission.finish.resolve();
        expect(await starting).toMatchObject({
          message: 'Write handoff closed during startup',
        });
        await shutdown;
        expect(
          inStartup.getDecorator<() => OwnedWriteHandoff | undefined>(
            'isolatedWriteHandoff',
          )(),
        ).toBeUndefined();
        expect(
          (
            await lab.owner.query(
              'select generation from rdws_authority.owner where singleton',
            )
          ).rows[0]?.generation,
        ).toBeNull();
      } finally {
        admission.finish.resolve();
        admission.restore();
        await inStartup.close().catch(() => {});
      }
      await refreshTicket();
      const shared = buildApp(config);
      app = shared;
      await shared.ready();
      const broker = shared.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      expect(broker).toBeDefined();
      const originalGeneration = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      expect(originalGeneration).toBeTruthy();
      const competing = buildApp(config);
      await expect(competing.ready()).rejects.toThrow();
      await competing.close().catch(() => {});
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBe(originalGeneration);

      async function login(
        account: { username: string; userId: string },
        instance = shared,
      ) {
        const loggedIn = await instance.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin },
          payload: { username: account.username, password },
        });
        expect(loggedIn.statusCode, loggedIn.body).toBe(200);
        const cookie = loggedIn.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        return {
          cookie,
          userId: account.userId,
          authSessionId: await observedLogin(instance, cookie),
        };
      }
      const developer = await login(assigned);
      const maintainer = await login(lead);
      const administrator = await login(manager);
      const rows = async (id: string) =>
        (
          await lab.owner.query(
            'select generation,phase,run_id from requirement_write_lease where requirement_id=$1',
            [id],
          )
        ).rows[0];
      {
        const scope = {
          who: {
            userId: maintainer.userId,
            authSessionId: maintainer.authSessionId,
          },
          projectId,
          requirementId: nativeWork.requirementId,
          sessionId: nativeWork.sessionId,
        };
        const nextScope = { ...scope, sessionId: nextNativeSession };
        const file = join(nativeWork.tree, 'sample.txt');
        const readReceipt = async (commandId: string) =>
          (
            await lab.owner.query(
              'select result from command_receipt where command_id=$1',
              [commandId],
            )
          ).rows;
        const initialGrant = await broker.acquire(scope, randomUUID());
        const request = {
          generation: initialGrant.generation,
          commandId: randomUUID(),
          repositoryId: 'app',
          request: {
            tool: 'shell' as const,
            script:
              "printf '|native-once' >> sample.txt; printf 'fixture-started'",
          },
        };
        const started = vi.fn();
        const completed = await nativeBrokerTool(scope.sessionId, () =>
          broker.execute(scope, request, started),
        );
        expect(completed).toMatchObject({
          status: 'finished',
          result: { status: 'ok', stop: 'confirmed' },
        });
        expect(await readReceipt(request.commandId)).toEqual([
          { result: completed },
        ]);
        expect(started).toHaveBeenCalledTimes(1);
        expect(await broker.execute(scope, request, started)).toEqual(
          completed,
        );
        expect(started).toHaveBeenCalledTimes(1);
        expect(await readFile(file, 'utf8')).toBe('baseline|native-once');

        const unsolicited = vi.fn(() => broker.execute(scope, request));
        await expect(
          nativeBrokerTool(scope.sessionId, unsolicited, undefined, true),
        ).resolves.toEqual({ status: 'rejected', code: 400 });
        expect(unsolicited).not.toHaveBeenCalled();

        const staleCommandId = randomUUID();
        const stale = vi.fn();
        const denied = await nativeBrokerTool(
          scope.sessionId,
          () =>
            broker
              .execute(scope, { ...request, commandId: staleCommandId }, stale)
              .catch((error: unknown) => {
                const code = (error as { statusCode?: number }).statusCode;
                if (code === undefined) throw error;
                return { status: 'rejected', code } as const;
              }),
          () => broker.release(scope, initialGrant.generation, randomUUID()),
        );
        expect(denied).toEqual({ status: 'rejected', code: 409 });
        expect(stale).not.toHaveBeenCalled();
        expect(await readReceipt(staleCommandId)).toEqual([]);
        expect(await broker.execute(scope, request, started)).toEqual(
          completed,
        );
        expect(started).toHaveBeenCalledTimes(1);
        expect(await readFile(file, 'utf8')).toBe('baseline|native-once');

        const runningGrant = await broker.acquire(scope, randomUUID());
        const runningCommandId = randomUUID();
        let output = '';
        const runningTool = nativeBrokerTool(scope.sessionId, () =>
          broker.execute(
            scope,
            {
              ...request,
              generation: runningGrant.generation,
              commandId: runningCommandId,
              request: {
                tool: 'shell',
                script:
                  'printf "|old-active" >> sample.txt; printf "started:%s\\n" "$$"; while :; do :; done',
              },
            },
            ({ stream, chunk }) => {
              if (stream === 'stdout') output += chunk.toString();
            },
          ),
        );
        void runningTool.catch(() => {});
        await expect.poll(() => output).toMatch(/started:[1-9][0-9]*\n/);
        const pid = Number(/started:([1-9][0-9]*)\n/.exec(output)![1]);
        const [parent, group] = execFileSync(
          '/bin/ps',
          ['-o', 'ppid=', '-o', 'pgid=', '-p', String(pid)],
          {
            encoding: 'utf8',
          },
        )
          .trim()
          .split(/\s+/)
          .map(Number);
        expect(parent).toBe(process.pid);
        expect(group).toBe(pid);
        expect(pid).toBeGreaterThan(1);
        const targetGroup = -pid;
        expect(process.kill(pid, 0)).toBe(true);
        const attempt = randomUUID();
        await expect(broker.acquire(nextScope, attempt)).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(await rows(scope.requirementId)).toMatchObject({
          phase: 'held',
          generation: runningGrant.generation,
        });

        const stopRequested = latch();
        const signal = process.kill.bind(process);
        let intercepted = false;
        let stopError: unknown;
        const pauseStop = vi
          .spyOn(process, 'kill')
          .mockImplementation((pid, method) => {
            if (pid === targetGroup && method === 'SIGKILL') {
              intercepted = true;
              stopRequested.resolve();
              return true;
            }
            return signal(pid, method);
          });
        const release = broker.release(
          scope,
          runningGrant.generation,
          randomUUID(),
        );
        void release.catch(() => {});
        try {
          await stopRequested.wait();
          expect(signal(targetGroup, 0)).toBe(true);
          expect(await rows(scope.requirementId)).toMatchObject({
            phase: 'draining',
            generation: runningGrant.generation,
          });
          await expect(
            broker.acquire(nextScope, attempt),
          ).rejects.toMatchObject({ statusCode: 409 });
        } finally {
          pauseStop.mockRestore();
          if (intercepted) {
            try {
              signal(targetGroup, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                stopError = error;
            }
          }
        }
        if (stopError) throw stopError;
        expect(await release).toBe('released');
        const stopped = await runningTool;
        expect(stopped).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed' },
        });
        expect(() => signal(pid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        expect(() => signal(targetGroup, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        expect(await rows(scope.requirementId)).toMatchObject({
          phase: 'released',
          generation: runningGrant.generation,
          run_id: null,
        });
        expect(await readReceipt(runningCommandId)).toEqual([
          { result: stopped },
        ]);
        const nextGrant = await broker.acquire(nextScope, attempt);
        expect(nextGrant.generation).not.toBe(runningGrant.generation);
        await expect(
          nativeBrokerTool(nextScope.sessionId, () =>
            broker.execute(nextScope, {
              ...request,
              generation: nextGrant.generation,
              commandId: randomUUID(),
              request: {
                tool: 'shell',
                script: "printf '|new-active' >> sample.txt",
              },
            }),
          ),
        ).resolves.toMatchObject({
          status: 'finished',
          result: { status: 'ok' },
        });
        expect(await readFile(file, 'utf8')).toBe(
          'baseline|native-once|old-active|new-active',
        );
        expect(
          await broker.release(nextScope, nextGrant.generation, randomUUID()),
        ).toBe('released');
      }
      async function launch(
        who: typeof developer,
        target: typeof work,
        text: string,
      ) {
        const scope = {
          who: { userId: who.userId, authSessionId: who.authSessionId },
          projectId,
          requirementId: target.requirementId,
          sessionId: target.sessionId,
        };
        const grant = await broker.acquire(scope, randomUUID());
        let running = false;
        const stop = new AbortController();
        const result = broker.execute(
          scope,
          {
            generation: grant.generation,
            commandId: randomUUID(),
            repositoryId: 'app',
            request: {
              tool: 'shell',
              script: `printf '%s' '${text}' > sample.txt; printf running; while :; do :; done`,
            },
          },
          () => {
            running = true;
          },
          stop.signal,
        );
        void result.catch(() => {});
        await expect.poll(() => running).toBe(true);
        return { scope, grant, result, stop: () => stop.abort() };
      }
      const idle = await launch(maintainer, other, 'other demand');
      const running = await launch(developer, work, 'old worker');
      const task = (
        person: typeof developer,
        status: 'done' | 'in_progress',
        id = taskId,
        commandId = randomUUID(),
      ) =>
        shared.inject({
          method: 'POST',
          url: `/api/requirements/${work.requirementId}/commands`,
          headers: { origin, cookie: person.cookie },
          payload: {
            type: 'task.update',
            commandId,
            taskId: id,
            patch: { status },
          },
        });
      const rejected = await task(developer, 'done', randomUUID());
      expect(rejected.statusCode).toBe(404);
      expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
      const nonAuthority = refuseGuardedRead(
        'requirement:' + work.requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        const updated = await shared.inject({
          method: 'POST',
          url: `/api/requirements/${work.requirementId}/commands`,
          headers: { origin, cookie: maintainer.cookie },
          payload: {
            type: 'task.update',
            commandId: randomUUID(),
            taskId,
            patch: { description: 'Context only' },
          },
        });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(nonAuthority.attempts).toBe(0);
      } finally {
        nonAuthority.restore();
      }
      const anotherTaskProof = refuseGuardedRead(
        'requirement:' + work.requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        expect((await task(developer, 'done', secondTask)).statusCode).toBe(
          503,
        );
        expect(anotherTaskProof.attempts).toBeGreaterThan(0);
      } finally {
        anotherTaskProof.restore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await rows(work.requirementId)).toMatchObject({
        generation: running.grant.generation,
        phase: 'held',
      });
      expect((await rows(work.requirementId))?.run_id).toBeTruthy();
      const rollback = holdGuardedCommit(
        'requirement:' + work.requirementId,
        'rollback',
      );
      try {
        expect((await task(developer, 'done')).statusCode).toBe(500);
        expect(rollback.entered).toBe(true);
        rollback.expectIndependentReceipt('ROLLBACK');
        expect(
          (
            await lab.owner.query('select status from task where id=$1', [
              taskId,
            ])
          ).rows[0]?.status,
        ).toBe('in_progress');
        expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
      } finally {
        rollback.release();
        rollback.restore();
      }
      const commitGate = holdGuardedCommit('requirement:' + work.requirementId);
      const complete = task(developer, 'done');
      let reopening: ReturnType<typeof task> | undefined;
      try {
        await expect.poll(() => commitGate.entered).toBe(true);
        reopening = task(maintainer, 'in_progress');
        await expect
          .poll(
            async () =>
              (
                await lab.owner.query('select status from task where id=$1', [
                  taskId,
                ])
              ).rows[0]?.status,
          )
          .toBe('done');
        expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
        commitGate.release();
        const completed = await complete;
        expect(completed.statusCode, completed.body).toBe(200);
        commitGate.expectIndependentReceipt('COMMIT');
      } finally {
        commitGate.release();
        commitGate.restore();
      }
      expect(await rows(work.requirementId)).toMatchObject({
        phase: 'held',
        generation: running.grant.generation,
        run_id: expect.any(String),
      });
      running.stop();
      expect(await running.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      await broker.release(
        running.scope,
        running.grant.generation,
        randomUUID(),
      );
      expect(await rows(work.requirementId)).toMatchObject({
        phase: 'released',
        run_id: null,
      });
      expect(await rows(other.requirementId)).toMatchObject({ phase: 'held' });
      expect(await readFile(join(other.tree, 'sample.txt'), 'utf8')).toBe(
        'other demand',
      );
      const reopened = await reopening!;
      expect(reopened.statusCode, reopened.body).toBe(200);
      const beforeLost = await launch(
        developer,
        work,
        'before lost acknowledgement',
      );
      const lost = holdGuardedCommit(
        'requirement:' + work.requirementId,
        'lose',
      );
      const originalCommand = randomUUID();
      try {
        expect(
          (await task(developer, 'done', taskId, originalCommand)).statusCode,
        ).toBe(500);
        expect(lost.entered).toBe(true);
        lost.expectIndependentReceipt('COMMIT');
        expect(await rows(work.requirementId)).toMatchObject({
          phase: 'held',
          generation: beforeLost.grant.generation,
          run_id: expect.any(String),
        });
        expect(
          (await task(developer, 'done', taskId, originalCommand)).statusCode,
        ).toBe(200);
        expect(
          (
            await lab.owner.query(
              'select id from requirement_event where command_id=$1',
              [originalCommand],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        lost.release();
        lost.restore();
      }
      beforeLost.stop();
      expect(await beforeLost.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      await broker.release(
        beforeLost.scope,
        beforeLost.grant.generation,
        randomUUID(),
      );
      expect((await task(maintainer, 'in_progress')).statusCode).toBe(200);
      const alternate = await login(assigned);
      const beforeUnreadable = await launch(
        developer,
        work,
        'before unreadable receipt',
      );
      const foreign = new AsyncLocalStorage<boolean>();
      const unavailableProof = refuseGuardedRead(
        'requirement:' + work.requirementId,
        foreign,
      );
      const unreadableCommand = randomUUID();
      try {
        const unresolved = await task(
          developer,
          'done',
          taskId,
          unreadableCommand,
        );
        expect(unresolved.statusCode, unresolved.body).toBe(503);
        expect(unavailableProof.attempts).toBeGreaterThan(0);
        expect(await beforeUnreadable.result).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed' },
        });
        const differentLogin = await foreign.run(true, () =>
          task(alternate, 'done', taskId, unreadableCommand),
        );
        expect(differentLogin.statusCode).toBe(503);
        expect(unavailableProof.foreignReads).toBe(0);
      } finally {
        unavailableProof.restore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await rows(work.requirementId)).toMatchObject({
        phase: 'held',
        run_id: null,
      });
      await broker.release(
        beforeUnreadable.scope,
        beforeUnreadable.grant.generation,
        randomUUID(),
      );
      expect(
        (await task(developer, 'done', taskId, unreadableCommand)).statusCode,
      ).toBe(200);
      expect(
        (
          await lab.owner.query(
            'select id from requirement_event where command_id=$1',
            [unreadableCommand],
          )
        ).rows,
      ).toHaveLength(1);
      expect((await task(maintainer, 'in_progress')).statusCode).toBe(200);
      const forRoles = await launch(developer, work, 'before role change');
      expect(forRoles.grant.generation).not.toBe(running.grant.generation);
      const roles = (list: string[]) =>
        shared.inject({
          method: 'POST',
          url: '/api/management/commands',
          headers: { origin, cookie: administrator.cookie },
          payload: {
            kind: 'project.roles',
            projectId,
            username: assigned.username,
            roles: list,
            commandId: randomUUID(),
          },
        });
      await bootstrapNative(shared, developer.cookie, work.requirementId);
      const roleProof = refuseGuardedRead(
        projectId,
        new AsyncLocalStorage<boolean>(),
      );
      const nativeRevoke = NativeWebHost.prototype.revoke;
      let notified = false;
      const observeRevocation = vi
        .spyOn(NativeWebHost.prototype, 'revoke')
        .mockImplementation(function (this: NativeWebHost, ...args) {
          if (args[0] === developer.authSessionId) notified = true;
          return nativeRevoke.apply(this, args);
        });
      try {
        const removed = await roles([]);
        expect(removed.statusCode, removed.body).toBe(503);
        expect(roleProof.attempts).toBeGreaterThan(0);
        expect(notified).toBe(true);
      } finally {
        roleProof.restore();
        observeRevocation.mockRestore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await forRoles.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect((await roles(['developer'])).statusCode).toBe(200);

      const logout = () =>
        shared.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: {
            origin,
            cookie: maintainer.cookie,
            'x-rdws-edit-session': maintainer.authSessionId,
          },
        });
      const blocker = await lab.owner.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          'select id from auth_session where id=$1 for update',
          [maintainer.authSessionId],
        );
        const pending = await logout();
        expect(pending.statusCode).toBe(503);
        expect(pending.cookies).toHaveLength(0);
        expect(
          (
            await lab.owner.query('select id from auth_session where id=$1', [
              maintainer.authSessionId,
            ])
          ).rowCount,
        ).toBe(1);
        await expect(
          broker.acquire(idle.scope, randomUUID()),
        ).rejects.toMatchObject({ statusCode: 401 });
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      const loggedOut = await logout();
      expect(loggedOut.statusCode, loggedOut.body).toBe(200);
      expect(await idle.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect(await rows(other.requirementId)).toMatchObject({
        phase: 'released',
      });
      await expect(
        broker.acquire(idle.scope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(await readFile(join(work.tree, 'sample.txt'), 'utf8')).toBe(
        'before role change',
      );
      const reloggedLead = await login(lead);
      const beforePersonnel = await launch(reloggedLead, other, 'former lead');
      const replacement = await shared.inject({
        method: 'POST',
        url: `/api/requirements/${other.requirementId}/personnel`,
        headers: {
          origin,
          cookie: administrator.cookie,
          'x-rdws-edit-session': administrator.authSessionId,
        },
        payload: {
          commandId: randomUUID(),
          previewLeadId: lead.userId,
          leadId: assigned.userId,
          add: [],
          remove: [],
          taskDigest: createHash('sha256')
            .update(taskAssignmentMaterial([]))
            .digest('hex'),
          handoffs: [],
          overrides: [],
        },
      });
      expect(replacement.statusCode, replacement.body).toBe(200);
      expect(await rows(other.requirementId)).toMatchObject({
        phase: 'held',
        generation: beforePersonnel.grant.generation,
        run_id: expect.any(String),
      });
      beforePersonnel.stop();
      expect(await beforePersonnel.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect(
        (
          await lab.owner.query(
            'select role from requirement_participant where requirement_id=$1 and user_id=$2',
            [other.requirementId, lead.userId],
          )
        ).rows,
      ).toEqual([{ role: 'developer' }]);
      await broker.release(
        beforePersonnel.scope,
        beforePersonnel.grant.generation,
        randomUUID(),
      );
      const stillDeveloper = await broker.acquire(
        beforePersonnel.scope,
        randomUUID(),
      );
      expect(stillDeveloper.generation).not.toBe(
        beforePersonnel.grant.generation,
      );
      await broker.release(
        beforePersonnel.scope,
        stillDeveloper.generation,
        randomUUID(),
      );

      for (const stale of [
        {
          url: '/api/management/commands',
          payload: {
            kind: 'account.active',
            username: assigned.username,
            active: false,
          },
          target: developer,
          demandId: work.requirementId,
        },
        {
          url: `/api/requirements/${other.requirementId}/personnel`,
          payload: {
            previewLeadId: assigned.userId,
            leadId: assigned.userId,
            add: [],
            remove: [{ userId: lead.userId, role: 'developer' }],
            taskDigest: createHash('sha256')
              .update(taskAssignmentMaterial([]))
              .digest('hex'),
            handoffs: [],
            overrides: [],
          },
          target: reloggedLead,
          demandId: other.requirementId,
        },
      ]) {
        const commandId = randomUUID();
        const late = holdCheckoutResult(
          (sql, parameters) =>
            sql.startsWith('update "command_receipt"') &&
            Array.isArray(parameters[1]) &&
            parameters[1].includes(commandId),
        );
        const pending = shared
          .inject({
            method: 'POST',
            url: stale.url,
            headers: {
              origin,
              cookie: administrator.cookie,
              ...(stale.url.endsWith('/personnel') && {
                'x-rdws-edit-session': administrator.authSessionId,
              }),
            },
            payload: { ...stale.payload, commandId },
          })
          .then((response) => response);
        try {
          await expect(
            Promise.race([
              late.persisted.promise.then(() => ({ held: true })),
              pending.then(({ statusCode, body }) => ({ statusCode, body })),
            ]),
          ).resolves.toEqual({ held: true });
          expect((await pending).statusCode).toBe(500);
          expect(
            (
              await lab.owner.query(
                'select 1 from command_receipt where command_id=$1',
                [commandId],
              )
            ).rowCount,
          ).toBe(0);
          late.finish.resolve();
          await late.rolledBack.wait();
          const readable = await shared.inject({
            url: `/api/requirements/${stale.demandId}`,
            headers: { cookie: stale.target.cookie },
          });
          expect(readable.statusCode, readable.body).toBe(200);
        } finally {
          late.finish.resolve();
          late.restore();
          await pending;
        }
      }

      const beforeAccount = await launch(
        developer,
        work,
        'before account stop',
      );
      const inactive = await shared.inject({
        method: 'POST',
        url: '/api/management/commands',
        headers: { origin, cookie: administrator.cookie },
        payload: {
          kind: 'account.active',
          username: assigned.username,
          active: false,
          commandId: randomUUID(),
        },
      });
      expect(inactive.statusCode, inactive.body).toBe(200);
      expect(await beforeAccount.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      await expect(
        broker.acquire(beforeAccount.scope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 401 });
      const drainingUser = await login(lead);
      const binding = await bootstrapNative(
        shared,
        drainingUser.cookie,
        other.requirementId,
      );
      const address = await shared.listen({ host: '127.0.0.1', port: 0 });
      const bootstrapEntered = latch();
      const workspaceEntered = latch();
      const finishBootstrap = latch();
      const finishWorkspace = latch();
      const auditEntered = latch();
      const finishAudit = latch();
      const physicalEntered = latch();
      const finishPhysical = latch();
      const fetchNative = NativeWebHost.prototype.fetch;
      const workspace = NativeWebHost.prototype.workspace;
      const holdBootstrap = vi
        .spyOn(NativeWebHost.prototype, 'fetch')
        .mockImplementation(async function (this: NativeWebHost, ...args) {
          const response = await fetchNative.apply(this, args);
          if (args[0] !== '/api/rdws/bootstrap') return response;
          const body = await response.arrayBuffer();
          expect(response.ok).toBe(true);
          bootstrapEntered.resolve();
          await finishBootstrap.promise;
          return new Response(body, response);
        });
      const browserRequest = httpRequest(
        address + `/api/dsh/${other.requirementId}/bootstrap`,
        {
          headers: {
            cookie: drainingUser.cookie,
            'x-rdws-edit-session': drainingUser.authSessionId,
          },
        },
      );
      browserRequest.on('error', () => {});
      const disconnectedHttp = once(browserRequest, 'close').catch(() => {});
      const poolQuery = Pool.prototype.query;
      const holdAudit = vi
        .spyOn(Pool.prototype, 'query')
        .mockImplementation(function (this: Pool, ...args: unknown[]) {
          const input = args[0] as string | { text: string };
          const sql = typeof input === 'string' ? input : input.text;
          const result = Reflect.apply(poolQuery, this, args);
          if (
            sql.includes('select count(*)::integer') &&
            sql.includes('from "auth_session" inner join') &&
            sql.includes('project_member')
          )
            return result.then(async (rows: unknown) => {
              auditEntered.resolve();
              await finishAudit.promise;
              return rows;
            });
          return result;
        } as typeof poolQuery);
      const auditRequest = httpRequest(
        address + `/api/projects/${projectId}/business-audit`,
        {
          headers: {
            cookie: administrator.cookie,
            'x-rdws-edit-session': administrator.authSessionId,
          },
        },
      );
      auditRequest.on('error', () => {});
      const disconnectedAudit = once(auditRequest, 'close').catch(() => {});
      let browser: WebSocket | undefined;
      let closing: Promise<undefined> | undefined;
      let holdWorkspace: { mockRestore(): void } | undefined;
      let holdPhysical: { mockRestore(): void } | undefined;
      const ownerGeneration = async () =>
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation;
      try {
        browserRequest.end();
        auditRequest.end();
        await expect.poll(() => holdBootstrap.mock.calls.length).toBe(1);
        await bootstrapEntered.wait();
        await auditEntered.wait();
        holdWorkspace = vi
          .spyOn(NativeWebHost.prototype, 'workspace')
          .mockImplementation(async function (this: NativeWebHost, ...args) {
            const result = await workspace.apply(this, args);
            workspaceEntered.resolve();
            await finishWorkspace.promise;
            return result;
          });
        browser = new WebSocket(
          address.replace('http:', 'ws:') +
            `/api/dsh/${other.requirementId}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
          { headers: { origin, cookie: drainingUser.cookie } },
        );
        await once(browser, 'open');
        await workspaceEntered.wait();
        const disconnectedWs = once(browser, 'close');
        browser.close();
        browserRequest.destroy();
        auditRequest.destroy();
        await Promise.all([
          disconnectedHttp,
          disconnectedWs,
          disconnectedAudit,
        ]);
        const pid = (
          await lab.admin.query<{ pid: number }>(
            "select pid from pg_stat_activity where datname=current_database() and usename='rdws_test_app' and state='idle' limit 1",
          )
        ).rows[0]!.pid;
        const end = Client.prototype.end;
        holdPhysical = vi
          .spyOn(Client.prototype, 'end')
          .mockImplementation(function (
            this: Client & { processID: number },
            ...args: unknown[]
          ) {
            if (this.processID !== pid) return Reflect.apply(end, this, args);
            physicalEntered.resolve();
            return finishPhysical.promise.then(() =>
              Reflect.apply(end, this, args),
            );
          } as typeof end);
        closing = shared.close();
        expect(shared.close()).toBe(closing);
        const stoppedCommand = randomUUID();
        await expect(
          broker.release(
            beforePersonnel.scope,
            beforePersonnel.grant.generation,
            stoppedCommand,
          ),
        ).rejects.toMatchObject({ statusCode: 503 });
        expect(
          (
            await lab.owner.query(
              'select 1 from command_receipt where command_id=$1',
              [stoppedCommand],
            )
          ).rowCount,
        ).toBe(0);
        await expect.poll(() => shared.server.listening).toBe(false);
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishBootstrap.resolve();
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishWorkspace.resolve();
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishAudit.resolve();
        await physicalEntered.wait();
        expect(await ownerGeneration()).toBe(originalGeneration);
        expect(
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
        ).toBe(1);
        finishPhysical.resolve();
        await closing;
        expect(await ownerGeneration()).toBeNull();
      } finally {
        browser?.terminate();
        browserRequest.destroy();
        auditRequest.destroy();
        finishBootstrap.resolve();
        finishWorkspace.resolve();
        finishAudit.resolve();
        finishPhysical.resolve();
        holdPhysical?.mockRestore();
        holdAudit.mockRestore();
        holdWorkspace?.mockRestore();
        holdBootstrap.mockRestore();
        await closing;
      }
      app = undefined;
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBeNull();

      const nextTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
            [createHash('sha256').update(nextTicket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      const broken = buildApp({ ...config, authorityTicket: nextTicket });
      app = broken;
      await broken.ready();
      const blockedBroker = broken.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      const lastLogin = await login(lead, broken);
      const forStop = {
        who: { userId: lead.userId, authSessionId: lastLogin.authSessionId },
        projectId,
        requirementId: forFailedClose.requirementId,
        sessionId: forFailedClose.sessionId,
      };
      const lastGrant = await blockedBroker.acquire(forStop, randomUUID());
      await mkdir(join(forFailedClose.control, 'isolated-execution'), {
        mode: 0o700,
      });
      expect(
        await blockedBroker.execute(forStop, {
          generation: lastGrant.generation,
          commandId: randomUUID(),
          repositoryId: 'app',
          request: {
            tool: 'file',
            operation: 'write',
            path: 'sample.txt',
            text: 'must not apply',
          },
        }),
      ).toMatchObject({
        status: 'unknown',
        result: { marker: 'retained', stop: 'not-started' },
      });
      expect(
        await readFile(join(forFailedClose.tree, 'sample.txt'), 'utf8'),
      ).toBe('baseline');
      const failedGeneration = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      const failure = broken.close();
      expect(broken.close()).toBe(failure);
      await expect(failure).rejects.toThrow('shutdown was not confirmed');
      app = undefined;
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBe(failedGeneration);
      const deniedOwner = buildApp({ ...config, authorityTicket: nextTicket });
      await expect(deniedOwner.ready()).rejects.toThrow();
      await deniedOwner.close().catch(() => {});
    } finally {
      try {
        await app?.close();
      } finally {
        await trees?.close();
        await mirrors?.close();
        await fixture?.close();
        await lab.close();
      }
    }
  },
  60_000,
);
