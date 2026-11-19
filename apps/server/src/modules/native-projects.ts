import {
  NativeWebHost,
  projectNativeConfiguration,
  validProjectId,
} from '@rdws/dsh/web';
import type { createBusiness } from './business.ts';
import { businessError } from './business.ts';
import { ContextRuns, contextSnapshot } from './runtime-context.ts';
import { createSessionOperations } from './session-operations.ts';

type Business = ReturnType<typeof createBusiness>;
type Database = Parameters<typeof createSessionOperations>[0];

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
) {
  const pending = new Map<string, Promise<ProjectRuntime>>();
  const live = new Map<string, ProjectRuntime>();
  let closing = false;
  let activeContextReads = 0;
  function register(native: NativeWebHost) {
    const project = native.projectId;
    const runtime = {
      native,
      sessions: createSessionOperations(db, business, native),
      runs: new ContextRuns(
        native.contextGeneration,
        (token) => native.verifyContext(token),
        async (who, id, sessionId, relatedActors) => {
          if (activeContextReads >= 4) businessError(503, '需求上下文暂时繁忙');
          activeContextReads++;
          try {
            const { detail, validBefore } = await business.readWithDeadline(
              who,
              id,
              sessionId,
              relatedActors,
            );
            if (detail.requirement.projectId !== project)
              businessError(403, '运行归属与项目不匹配');
            return { value: contextSnapshot(detail), validBefore };
          } finally {
            activeContextReads--;
          }
        },
        (id, userId, requirementId) =>
          closingLogin(id, userId, project, requirementId),
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
        (project === 'poc'
          ? testConfiguration
          : await projectNativeConfiguration(root, project).catch(
              () => undefined,
            ));
      if (project !== 'poc' && !configuration)
        businessError(503, '项目运行时尚未配置');
      if (closing) businessError(503, '项目运行时暂不可用');
      return register(new NativeWebHost(root, configuration, project));
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
      if (project === 'poc') return true;
      return projectNativeConfiguration(root, project).then(
        () => true,
        () => false,
      );
    },
  };
}
export interface ProjectRuntime {
  native: NativeWebHost;
  sessions: ReturnType<typeof createSessionOperations>;
  runs: ContextRuns;
  inFlightPrompts: Set<string>;
  acceptedPrompts: Map<string, number>;
  abandonedRuns: Set<string>;
}
