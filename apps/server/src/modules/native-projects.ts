import {
  LEGACY_POC_PROJECT_ID,
  NativeWebHost,
  createModelHttpsRelay,
  projectNativeConfiguration,
  validProjectId,
  type NativeModelEgress,
} from '@rdws/dsh/web';
import type { createBusiness } from './business.ts';
import { businessError } from './business.ts';
import { ContextRuns, contextSnapshot } from './runtime-context.ts';
import { createSessionOperations } from './session-operations.ts';
import {
  prepareMainModelBody,
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
) {
  const pending = new Map<string, Promise<ProjectRuntime>>();
  const live = new Map<string, ProjectRuntime>();
  let closing = false;
  const readContext = createProjectContextReader(business);
  function register(native: NativeWebHost, policy?: MainModelPolicy) {
    const project = native.projectId;
    const runtime = {
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
          ? (who, requirementId, sessionId, relatedActors, write) =>
              business.withModelAuthority(
                who,
                project,
                requirementId,
                sessionId,
                relatedActors,
                write,
              )
          : undefined,
      ),
      inFlightPrompts: new Set<string>(),
      acceptedPrompts: new Map<string, number>(),
      abandonedRuns: new Set<string>(),
    };
    native.configureContext((input, token, reply) => {
      if (closing) businessError(403, '原生项目正在停止');
      return runtime.runs.handle(input, token, (result, validBefore) => {
        if (!closing) reply(result, validBefore);
      });
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
        const relay = createModelHttpsRelay(
          mainPolicy.destination,
          undefined,
          (body) => prepareMainModelBody(body, mainPolicy.model),
        );
        const native = new NativeWebHost(
          root,
          configuration,
          project,
          undefined,
          'mediated',
          {
            routes: { main: mainPolicy.destination },
            handle: (request) =>
              relay(request, (write) =>
                runtime.runs.authorizeModelWireAttempt(request, write),
              ),
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
        [...live.values()].map(async ({ native, runs }) => {
          runs.clear();
          await native.close();
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
}
