import { createHash } from 'node:crypto';
import { isRecord } from '@rdws/dsh/access';
import { schema, type connectDatabase } from '@rdws/db';
import { and, eq } from 'drizzle-orm';
import { sessionRpc } from '@rdws/dsh/sessions';
import { publicModelCatalogValue } from '@rdws/dsh/wire';
import {
  LEGACY_POC_PROJECT_ID,
  NativeWebHost,
  createModelHttpsRelay,
  projectNativeConfiguration,
  validProjectId,
  type ModelCarrierRequest,
  type NativeModelEgress,
} from '@rdws/dsh/web';
import type { createBusiness } from './business.ts';
import { businessError, type Actor } from './business.ts';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';
import {
  ContextRuns,
  contextSnapshot,
  type ReadToolBinding,
  type ReadToolOperation,
  type RunBinding,
  type WriteToolBinding,
} from './runtime-context.ts';
import {
  NativeWriteToolJob,
  type WriteFileRequest,
} from './native-write-tool-job.ts';
import {
  NativeShellToolJob,
  type ShellRequest,
} from './native-shell-tool-job.ts';
import type { WriteCommands } from './write-tool-commands.ts';
import { outputPolicy, type OutputPolicy } from './shell-output-handling.ts';
import { userInfo } from 'node:os';
import {
  NativeFixtureToolJob,
  type FixtureToolAssembly,
} from './native-fixture-tool-job.ts';
import { createSessionOperations } from './session-operations.ts';
import type {
  SessionModelOptions,
  SessionModelPilot,
} from './session-model-selection.ts';
import type { CheckedWriteTransaction } from './checked-write-transaction.ts';
import { createModelFirstWriteReceipts } from './model-first-write.ts';
import {
  prepareMainModelBody,
  prepareTitleModelBody,
  type MainModelPolicy,
} from './model-egress-policy.ts';

type Business = ReturnType<typeof createBusiness>;
type Database = Parameters<typeof createSessionOperations>[0];
type PilotDatabase = ReturnType<typeof connectDatabase>['db'];
const MAX_CONTEXT_READS = 4;

// §11.20.26 Read loopback assembly (isolated, opt-in): one armed Workbench
// Prompt request binds the only run the Read probe may declare for. The
// FD3 read service of hop 4 runs on the armed broker with the scope
// re-derived from the signed run binding by ContextRuns.
export type ReadToolArm = {
  scope: WriteHandoffScope;
  requestId: string;
  repositoryId: string;
  broker: ReturnType<typeof createOwnedWriteHandoff>;
};
// §11.20.27 step 0 (B-1): arming is a table keyed by request id, bounded
// and first-in first-out, so one BFF carries the several armed runs of the
// two-developer journey; an entry is accepted only for the run whose key it
// names.
export const maxArmedRequests = 32;
export type ReadToolAssembly = {
  arms?: Map<string, ReadToolArm>;
  readStreamMinSize?: number;
  offered?: Map<string, RunBinding>;
};

// §11.20.27 write loopback assembly (isolated, opt-in): the armed Prompt
// requests of the writable sessions, the repository they write and the
// command set registry of their write generations. shellGit arms the
// Shell and Git tools beside the file tools.
export type WriteToolArm = {
  scope: WriteHandoffScope;
  requestId: string;
  repositoryId: string;
  broker: ReturnType<typeof createOwnedWriteHandoff>;
};
export type WriteToolAssembly = {
  arms?: Map<string, WriteToolArm>;
  shellGit?: boolean;
  commands?: WriteCommands;
  // Live sizes of the runtime's tables, for the evidence that they stay
  // bounded (filled in by the project runtime).
  stats?: () => { jobs: number };
  offered?: Map<
    string,
    {
      run: RunBinding;
      generation: string;
      contextVersion: number;
      // The prefix policy of the output handling, once known.
      policy?: OutputPolicy;
      redactions: number;
    }
  >;
};
// Ownership of a write job. The owner's table holds the job from the
// moment it is offered to the Host until it settles. An offer the parent
// refuses (a lease that moved between the permit and the offer) cancels and
// releases the job at once: it is neither executed nor kept.
export function ownWriteJob<
  T extends {
    offer: (...args: never[]) => string;
    cancel(): void;
  },
>(make: (onSettled: () => void) => T, table: Set<T>): T {
  const job = make(() => table.delete(job));
  const offered: (...args: unknown[]) => string = job.offer.bind(job) as never;
  job.offer = ((...args: unknown[]) => {
    table.add(job);
    try {
      return offered(...args);
    } catch (error) {
      // cancel() settles a job that never began, which releases it and
      // tells the owner; a job already settled is gone already.
      job.cancel();
      throw error;
    }
  }) as T['offer'];
  return job;
}

// Closing the write jobs of a runtime. A job whose stop could not be
// confirmed is not swallowed: the shutdown fails and the normal hand-over
// is refused, as for the fixture job (§11.20.9, §11.20.22).
export async function closeWriteJobs(
  jobs: Iterable<NativeWriteToolJob | NativeShellToolJob>,
) {
  const results = await Promise.allSettled([...jobs].map((job) => job.close()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed && failed.status === 'rejected') throw failed.reason;
}

// The size of the armed tables of an assembly, for the evidence that they
// stay bounded across many runs.
export function armedSizes(read: ReadToolAssembly, write: WriteToolAssembly) {
  return {
    readArms: read.arms?.size ?? 0,
    readOffered: read.offered?.size ?? 0,
    writeArms: write.arms?.size ?? 0,
    writeOffered: write.offered?.size ?? 0,
    registered: write.commands?.size() ?? 0,
  };
}

// The bounded insert of the arming tables: one entry per armed request
// key, the oldest evicted first past the limit.
export function armRequest<T>(table: Map<string, T>, key: string, value: T) {
  if (table.has(key)) throw new Error('Isolated tool request already armed');
  while (table.size >= maxArmedRequests)
    table.delete(table.keys().next().value!);
  table.set(key, value);
}

// The pilot allowlist only converges inside the frozen strategy provider; rows
// for other providers never change the projection (platform lock stays intact).
async function readEnabledAllowlistModels(
  database: PilotDatabase,
  projectId: string,
  provider: string,
): Promise<ReadonlySet<string>> {
  const rows = await database
    .select({ model: schema.projectModelAllowlist.model })
    .from(schema.projectModelAllowlist)
    .where(
      and(
        eq(schema.projectModelAllowlist.projectId, projectId),
        eq(schema.projectModelAllowlist.provider, provider),
        eq(schema.projectModelAllowlist.state, 'enabled'),
      ),
    );
  return new Set(rows.map(({ model }) => model));
}

export async function readPilotModelOptions(
  runtime: ProjectRuntime,
  grant: Parameters<typeof sessionRpc>[1],
  database?: PilotDatabase,
): Promise<SessionModelOptions> {
  const { native, modelPilot: policy } = runtime;
  if (!policy || native.signal.aborted)
    businessError(503, '会话模型目录暂不可用');
  const catalog = await sessionRpc(
    native,
    grant,
    'session/modelCatalog',
    undefined,
    AbortSignal.any([native.signal, AbortSignal.timeout(2000)]),
  )
    .then(publicModelCatalogValue)
    .catch(() => undefined);
  if (!catalog || catalog.failures.some(({ id }) => id === policy.provider))
    businessError(503, '会话模型目录暂不可用');
  let models = catalog.routableProviders.includes(policy.provider)
    ? (catalog.groups
        .find(({ id }) => id === policy.provider)
        ?.models.filter(({ id }) => policy.models.has(id))
        .map(({ id }) => id) ?? [])
    : [];
  if (database) {
    // Without enabled rows the projection falls back to the accepted
    // 「Native 目录 ∩ 冻结策略」 behavior; enabled rows only converge it.
    const allowed = await readEnabledAllowlistModels(
      database,
      policy.projectId,
      policy.provider,
    );
    if (allowed.size) models = models.filter((id) => allowed.has(id));
  }
  return {
    provider: policy.provider,
    models: new Set(models),
    isCurrent: () => !native.signal.aborted,
  };
}

export function createProjectContextReader(
  business: Pick<Business, 'readWithDeadline'>,
) {
  let activeReads = 0;
  return async (
    project: string,
    ...args: Parameters<Business['readWithDeadline']>
  ) => {
    if (activeReads >= MAX_CONTEXT_READS)
      businessError(503, '需求上下文暂时繁忙');
    activeReads++;
    try {
      const { detail, validBefore } = await business.readWithDeadline(...args);
      if (detail.requirement.projectId !== project)
        businessError(403, '运行归属与项目不匹配');
      return { value: contextSnapshot(detail), validBefore };
    } finally {
      activeReads--;
    }
  };
}

export function createProjectRuntimes(
  root: string,
  testConfiguration: string | undefined,
  provided: NativeWebHost | undefined,
  db: Database,
  business: Business,
  closingLogin: (
    id: string,
    userId: string,
    projectId: string,
    requirementId: string,
  ) => boolean,
  nativeProfiles?: ReadonlyMap<string, string>,
  modelEgress: NativeModelEgress = 'direct',
  mainPolicy?: MainModelPolicy,
  fixture?: FixtureToolAssembly,
  sessionModelPilot?: SessionModelPilot,
  pilotTransaction?: CheckedWriteTransaction,
  readTool?: ReadToolAssembly,
  writeTool?: WriteToolAssembly,
) {
  if (sessionModelPilot && !pilotTransaction)
    throw new Error('Session model pilot requires a checked model authority');
  const firstWrites = sessionModelPilot
    ? createModelFirstWriteReceipts(pilotTransaction!)
    : undefined;
  const pending = new Map<string, Promise<ProjectRuntime>>();
  const live = new Map<string, ProjectRuntime>();
  let closing = false;
  const readContext = createProjectContextReader(business);
  function register(native: NativeWebHost, policy?: MainModelPolicy) {
    const project = native.projectId;
    const pilot =
      policy && sessionModelPilot?.projectId === project
        ? sessionModelPilot
        : undefined;
    let offered: { run: RunBinding; job: NativeFixtureToolJob } | undefined;
    if (fixture && policy) native.enableFixtureToolProbe();
    if (readTool && policy)
      native.enableReadToolProbe(readTool.readStreamMinSize);
    if (writeTool && policy) native.enableWriteToolProbe();
    const runtime: ProjectRuntime = {
      native,
      catalogModel: policy && {
        provider: policy.provider,
        models: pilot?.models ?? new Set([policy.model]),
      },
      modelPilot: pilot,
      sessions: createSessionOperations(db, business, native, !!pilot),
      runs: new ContextRuns(
        native.contextGeneration,
        (token) => native.verifyContext(token),
        (...args) => readContext(project, ...args),
        (id, userId, requirementId) =>
          closingLogin(id, userId, project, requirementId),
        policy
          ? async () => ({
              provider: policy.provider,
              model: policy.model,
              revision: native.contextGeneration,
              routes: { main: policy.destination },
              isCurrent: () => !closing && !native.signal.aborted,
            })
          : undefined,
        policy
          ? (who, requirementId, sessionId, relatedActors, write, writeLease) =>
              business.withModelAuthority(
                who,
                project,
                requirementId,
                sessionId,
                relatedActors,
                write,
                writeLease,
              )
          : undefined,
        policy?.firstMessageTitle === true,
        undefined,
        pilot && policy
          ? {
              ...pilot,
              destination: policy.destination,
              isCurrent: () => !closing && !native.signal.aborted,
              firstWrites: firstWrites!,
              lock: (rows, write, sourceThroughSeq) => {
                const [first, ...related] = rows;
                if (!first) businessError(403, '原消息的模型派发绑定已失效');
                const who = (row: typeof first) => ({
                  userId: row.actorId,
                  authSessionId: row.authSessionId,
                });
                return business.withModelAuthority(
                  who(first),
                  project,
                  first.requirementId,
                  first.nativeSessionId,
                  related.map(who),
                  write,
                  undefined,
                  {
                    checked: pilotTransaction!,
                    dispatches: rows,
                    sourceThroughSeq,
                  },
                );
              },
            }
          : undefined,
      ),
      writeShellGit: writeTool?.shellGit === true && !!policy,
      inFlightPrompts: new Set<string>(),
      acceptedPrompts: new Map<string, number>(),
      abandonedRuns: new Set<string>(),
      ...(fixture &&
        policy && {
          offerFixtureTool(run: RunBinding, who: Actor) {
            const arm = fixture.arm;
            if (
              offered ||
              !arm ||
              arm.scope.projectId !== project ||
              arm.scope.requirementId !== run.requirementId ||
              arm.scope.sessionId !== run.sessionId ||
              arm.requestId !== run.requestId ||
              arm.scope.who.userId !== who.userId ||
              arm.scope.who.authSessionId !== who.authSessionId
            )
              return false;
            arm.broker.assertWireLease(
              arm.scope,
              arm.grant.generation,
              arm.grant.contextVersion,
            );
            offered = {
              run,
              job: new NativeFixtureToolJob({
                ...arm,
                hostSignal: native.signal,
                repositoryId: 'app',
                wire: true,
                request: {
                  tool: 'shell',
                  script: "printf '|workbench-tool' >> sample.txt",
                },
              }),
            };
            return true;
          },
          closeFixture: async () => offered?.job.close(),
        }),
      ...(readTool &&
        policy && {
          // The armed Prompt request of this run key binds the run the Read
          // probe may declare for; the run control message then carries
          // readTool.
          offerReadTool(run: RunBinding, who: Actor) {
            const arm = readTool.arms?.get(run.requestId);
            if (
              !readTool.offered ||
              readTool.offered.has(run.requestId) ||
              !arm ||
              arm.scope.projectId !== project ||
              arm.scope.requirementId !== run.requirementId ||
              arm.scope.sessionId !== run.sessionId ||
              arm.requestId !== run.requestId ||
              arm.scope.who.userId !== who.userId ||
              arm.scope.who.authSessionId !== who.authSessionId
            )
              return false;
            armRequest(readTool.offered, run.requestId, run);
            return true;
          },
        }),
      ...(writeTool &&
        policy && {
          // The run declares the write tools only when the own session
          // holds the write generation at this moment (hop 1 and 2).
          offerWriteTools(run: RunBinding, who: Actor) {
            const arm = writeTool.arms?.get(run.requestId);
            if (
              !writeTool.offered ||
              writeTool.offered.has(run.requestId) ||
              !arm ||
              !writeTool.commands ||
              arm.scope.projectId !== project ||
              arm.scope.requirementId !== run.requirementId ||
              arm.scope.sessionId !== run.sessionId ||
              arm.requestId !== run.requestId ||
              arm.scope.who.userId !== who.userId ||
              arm.scope.who.authSessionId !== who.authSessionId
            )
              return false;
            const holding = arm.broker.writeHolding(arm.scope);
            if (!holding) return false;
            const entry: {
              run: RunBinding;
              generation: string;
              contextVersion: number;
              policy?: OutputPolicy;
              redactions: number;
            } = {
              run,
              generation: holding.generation,
              contextVersion: holding.contextVersion,
              redactions: 0,
            };
            armRequest(writeTool.offered, run.requestId, entry);
            // The prefixes of this execution for the output handling and
            // the FD4 backstop, resolved once per armed request.
            void arm.broker
              .executionLocations(arm.scope, arm.repositoryId)
              .then((locations) => {
                entry.policy = outputPolicy({
                  tree: locations.tree,
                  runtimeRoot: locations.runtimeRoot,
                  home: userInfo().homedir,
                  node: process.execPath,
                });
              })
              .catch(() => {});
            // Registered when the generation became the holding; a BFF
            // armed afterwards registers it now, before the first permit.
            void writeTool.commands.confirm(
              structuredClone(arm.scope),
              holding.generation,
              arm.repositoryId,
            );
            return true;
          },
          closeWrite: () => closeWriteJobs(writeJobs),
        }),
    };
    const writeJobs = new Set<NativeWriteToolJob | NativeShellToolJob>();
    runtime.writeJobCount = () => writeJobs.size;
    if (writeTool) writeTool.stats = () => ({ jobs: writeJobs.size });
    function track<T extends NativeWriteToolJob | NativeShellToolJob>(
      make: (onSettled: () => void) => T,
    ): T {
      return ownWriteJob<T>(make, writeJobs as Set<T>);
    }
    // The armed entry of a run, by request id then run id: an FD3 request
    // names its run, and only the entry bound to that very run answers.
    function armedRun<T>(
      table: Map<string, T> | undefined,
      runOf: (entry: T) => RunBinding,
      runId: unknown,
    ) {
      if (!table || typeof runId !== 'string') return undefined;
      for (const [requestId, entry] of table)
        if (runOf(entry).runId === runId)
          return { requestId, entry, run: runOf(entry) };
      return undefined;
    }
    // The Read binding handed to every FD3 request of the armed run (hop 3
    // and hop 4): resolved per request, the scope re-derived by ContextRuns
    // from the signed binding, never taken from the request body.
    const readBindingFor = (runId: unknown): ReadToolBinding | undefined => {
      const armed = armedRun(readTool?.offered, (run) => run, runId);
      const arm = armed && readTool?.arms?.get(armed.requestId);
      if (!readTool || !arm || !armed) return undefined;
      return {
        run: armed.run,
        projectId: project,
        segment: (_input: Record<string, unknown>, id: string) =>
          arm.broker.readWorktreeSegmentLive(arm.scope, id),
        service: async (
          operation: ReadToolOperation,
          scope: WriteHandoffScope,
          input: Record<string, unknown>,
          expiresAt: number,
          live: () => boolean,
        ) => {
          // The FD3 request deadline bounds the read through an abort
          // signal the armed callback re-checks; the run's liveness
          // (cancel, release) reaches the same re-check.
          const current = () => {
            if (Date.now() > expiresAt || !live())
              businessError(409, '当前读取已失效');
          };
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(0, expiresAt - Date.now()),
          );
          timer.unref?.();
          try {
            if (operation === 'worktree-stat')
              return await arm.broker.readWorktreeStat(
                scope,
                { repositoryId: arm.repositoryId, path: String(input.path) },
                current,
                controller.signal,
                live,
              );
            if (operation === 'worktree-read')
              return await arm.broker.readWorktree(
                scope,
                { cursor: String(input.cursor) },
                current,
                controller.signal,
                live,
              );
            return await arm.broker.readWorktreeSegment(
              scope,
              {
                snapshotId: String(input.snapshotId),
                line: Number(input.line),
                prefix: String(input.prefix),
                ...(input.segment !== undefined && {
                  segment: String(input.segment),
                }),
              },
              current,
              controller.signal,
              live,
            );
          } finally {
            clearTimeout(timer);
          }
        },
      };
    };
    // The write binding handed to every FD3 write tool request of the
    // armed run: the generation is the one read when the run was offered,
    // re-read from the Broker on every permit and every begin.
    const writeBindingFor = (runId: unknown): WriteToolBinding | undefined => {
      const armed = armedRun(writeTool?.offered, ({ run }) => run, runId);
      const arm = armed && writeTool?.arms?.get(armed.requestId);
      if (!writeTool || !arm || !armed || !writeTool.commands) return undefined;
      const entry = armed.entry;
      const shellGit = writeTool.shellGit === true;
      return {
        run: armed.run,
        projectId: project,
        repositoryId: arm.repositoryId,
        tools: shellGit ? ['edit', 'write', 'bash', 'git'] : ['edit', 'write'],
        holding: () => {
          const holding = arm.broker.writeHolding(arm.scope);
          return holding?.generation === entry.generation ? holding : undefined;
        },
        assertLease: () =>
          arm.broker.assertWireLease(
            arm.scope,
            entry.generation,
            entry.contextVersion,
          ),
        registered: (command, assertCurrent, signal) =>
          writeTool
            .commands!.verify(
              arm.scope,
              entry.generation,
              arm.repositoryId,
              assertCurrent,
              signal,
            )
            .then((found) => found?.command === command),
        registeredCommand: (command: string) =>
          writeTool.commands!.registered(entry.generation)?.command === command,
        // §11.23 C3: the commit identity is the write-generation
        // holder's own account identity, read from the platform record.
        identity: async () => {
          const [holder] = await db
            .select({ name: schema.user.name, email: schema.user.email })
            .from(schema.user)
            .where(eq(schema.user.id, arm.scope.who.userId));
          return holder
            ? { name: holder.name, email: holder.email }
            : undefined;
        },
        redaction: () => entry.policy,
        countRedaction: () => {
          entry.redactions++;
        },
        redactionCount: () => entry.redactions,
        job: (
          request: WriteFileRequest,
          generation: { generation: string; contextVersion: number },
        ) =>
          track(
            (onSettled) =>
              new NativeWriteToolJob({
                scope: arm.scope,
                grant: generation,
                broker: arm.broker,
                repositoryId: arm.repositoryId,
                request,
                hostSignal: native.signal,
                onSettled,
              }),
          ),
        ...(shellGit && {
          shell: (
            request: ShellRequest,
            generation: { generation: string; contextVersion: number },
          ) =>
            track(
              (onSettled) =>
                new NativeShellToolJob({
                  scope: arm.scope,
                  grant: generation,
                  broker: arm.broker,
                  repositoryId: arm.repositoryId,
                  request,
                  hostSignal: native.signal,
                  onSettled,
                  // §11.23 S1: a confirmed commit records its immutable
                  // snapshot row before the result is a success.
                  onCommit: (input) =>
                    arm.broker.recordDeliverySnapshot(input.scope, {
                      repositoryId: input.repositoryId,
                      generation: input.generation,
                      commitHash: input.commit.head,
                      parentHead: input.commit.parent,
                      paths: input.commit.paths,
                      messageSha256: input.commit.messageSha256,
                      commandId: input.commandId,
                    }),
                }),
            ),
        }),
      };
    };
    native.configureContext((input, token, reply) => {
      if (closing) businessError(403, '原生项目正在停止');
      const runId = isRecord(input) ? input.runId : undefined;
      return runtime.runs.handle(
        input,
        token,
        (result, validBefore) => {
          if (!closing) reply(result, validBefore);
        },
        offered?.run,
        offered?.job,
        readBindingFor(runId),
        writeBindingFor(runId),
      );
    });
    live.set(project, runtime);
    return runtime;
  }
  if (provided) register(provided);
  function get(project: string) {
    if (closing || !validProjectId(project))
      businessError(503, '项目运行时暂不可用');
    const current = live.get(project);
    if (current) return Promise.resolve(current);
    const starting = pending.get(project);
    if (starting) return starting;
    const registration = (async () => {
      const configuration =
        nativeProfiles?.get(project) ??
        (project === LEGACY_POC_PROJECT_ID && mainPolicy?.projectId !== project
          ? testConfiguration
          : await projectNativeConfiguration(root, project).catch(
              () => undefined,
            ));
      if (project !== LEGACY_POC_PROJECT_ID && !configuration)
        businessError(503, '项目运行时尚未配置');
      if (closing) businessError(503, '项目运行时暂不可用');
      if (mainPolicy?.projectId === project) {
        if (!configuration) businessError(503, '项目运行时尚未配置');
        const projections = new WeakMap<
          ModelCarrierRequest,
          {
            proof: NonNullable<ReturnType<ContextRuns['fixtureWire']>>;
            digest: string;
          }
        >();
        const relay = createModelHttpsRelay(
          mainPolicy.destination,
          undefined,
          (body, request) => {
            const proof = runtime.runs.fixtureWire(request);
            const model = runtime.modelPilot
              ? runtime.runs.pilotWireModel(request)
              : mainPolicy.model;
            if (!model) return;
            const normalized = prepareMainModelBody(
              body,
              model,
              proof?.projection,
              runtime.runs.readWire(request),
              runtime.runs.writeWire(request),
            );
            if (normalized && proof)
              projections.set(request, {
                proof,
                digest: createHash('sha256').update(normalized).digest('hex'),
              });
            return normalized;
          },
        );
        const titleRelay = mainPolicy.firstMessageTitle
          ? createModelHttpsRelay(
              mainPolicy.destination,
              undefined,
              (body) => prepareTitleModelBody(body, mainPolicy.model),
              'session-title',
            )
          : undefined;
        const native = new NativeWebHost(
          root,
          configuration,
          project,
          undefined,
          'mediated',
          {
            routes: { main: mainPolicy.destination },
            firstMessageTitle: mainPolicy.firstMessageTitle,
            sessionModelPilot: sessionModelPilot?.projectId === project,
            handle: (request) =>
              (request.call.purpose === 'session-title' && titleRelay
                ? titleRelay
                : relay)(request, (write, digest) => {
                const projected = projections.get(request);
                if (projected && projected.digest !== digest)
                  return Promise.reject(
                    new Error('Model body projection changed'),
                  );
                return runtime.runs.authorizeModelWireAttempt(
                  request,
                  write,
                  projected?.proof,
                );
              }),
          },
        );
        const runtime: ProjectRuntime = register(native, mainPolicy);
        return runtime;
      }
      return register(
        new NativeWebHost(
          root,
          configuration,
          project,
          undefined,
          modelEgress === 'mediated' ? 'paused' : modelEgress,
        ),
      );
    })().finally(() => pending.delete(project));
    pending.set(project, registration);
    return registration;
  }
  return {
    get,
    peek: (project: string) => live.get(project),
    all: () => [...live.values()],
    stopAdmission() {
      closing = true;
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending.values()]);
      const results = await Promise.allSettled(
        [...live.values()].map(
          async ({ native, runs, closeFixture, closeWrite }) => {
            runs.clear();
            try {
              await closeFixture?.();
              await closeWrite?.();
            } finally {
              await native.close();
            }
          },
        ),
      );
      await firstWrites?.drain();
      if (results.some((result) => result.status === 'rejected'))
        throw new Error(
          'Some project Native instances could not be confirmed stopped',
        );
    },
    async configured(project: string) {
      if (live.has(project)) return true;
      if (
        project === LEGACY_POC_PROJECT_ID &&
        mainPolicy?.projectId !== project
      )
        return true;
      return projectNativeConfiguration(root, project).then(
        () => true,
        () => false,
      );
    },
  };
}
export interface ProjectRuntime {
  native: NativeWebHost;
  catalogModel?: { provider: string; models: ReadonlySet<string> };
  modelPilot?: SessionModelPilot;
  sessions: ReturnType<typeof createSessionOperations>;
  runs: ContextRuns;
  inFlightPrompts: Set<string>;
  acceptedPrompts: Map<string, number>;
  abandonedRuns: Set<string>;
  offerFixtureTool?(run: RunBinding, who: Actor): boolean;
  closeFixture?(): Promise<void>;
  offerReadTool?(run: RunBinding, who: Actor): boolean;
  offerWriteTools?(run: RunBinding, who: Actor): boolean;
  // Whether the armed write tools of this runtime include Shell and Git.
  writeShellGit?: boolean;
  // Write jobs still owned (not yet settled); for the evidence.
  writeJobCount?(): number;
  closeWrite?(): Promise<void>;
}
