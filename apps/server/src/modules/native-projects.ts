import { createHash } from 'node:crypto';
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
import {
  ContextRuns,
  contextSnapshot,
  type RunBinding,
} from './runtime-context.ts';
import {
  NativeFixtureToolJob,
  type FixtureToolAssembly,
} from './native-fixture-tool-job.ts';
import { createSessionOperations } from './session-operations.ts';
import {
  prepareMainModelBody,
  prepareTitleModelBody,
  type MainModelPolicy,
} from './model-egress-policy.ts';

type Business = ReturnType<typeof createBusiness>;
type Database = Parameters<typeof createSessionOperations>[0];
const MAX_CONTEXT_READS = 4;

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
) {
  const pending = new Map<string, Promise<ProjectRuntime>>();
  const live = new Map<string, ProjectRuntime>();
  let closing = false;
  const readContext = createProjectContextReader(business);
  function register(native: NativeWebHost, policy?: MainModelPolicy) {
    const project = native.projectId;
    let offered: { run: RunBinding; job: NativeFixtureToolJob } | undefined;
    if (fixture && policy) native.enableFixtureToolProbe();
    const runtime: ProjectRuntime = {
      native,
      catalogModel: policy && {
        provider: policy.provider,
        model: policy.model,
      },
      sessions: createSessionOperations(db, business, native),
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
      ),
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
    };
    native.configureContext((input, token, reply) => {
      if (closing) businessError(403, '原生项目正在停止');
      return runtime.runs.handle(
        input,
        token,
        (result, validBefore) => {
          if (!closing) reply(result, validBefore);
        },
        offered?.run,
        offered?.job,
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
            const normalized = prepareMainModelBody(
              body,
              mainPolicy.model,
              proof?.projection,
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
        [...live.values()].map(async ({ native, runs, closeFixture }) => {
          runs.clear();
          try {
            await closeFixture?.();
          } finally {
            await native.close();
          }
        }),
      );
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
  catalogModel?: Pick<MainModelPolicy, 'provider' | 'model'>;
  sessions: ReturnType<typeof createSessionOperations>;
  runs: ContextRuns;
  inFlightPrompts: Set<string>;
  acceptedPrompts: Map<string, number>;
  abandonedRuns: Set<string>;
  offerFixtureTool?(run: RunBinding, who: Actor): boolean;
  closeFixture?(): Promise<void>;
}
