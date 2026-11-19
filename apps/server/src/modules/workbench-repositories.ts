import type { FastifyInstance } from 'fastify';
import { RepositorySyncInput, type ProjectRepositories } from '@rdws/contracts';
import { businessError } from './business.ts';
import { MirrorRequestError } from '@rdws/syncer/mirror';
import { MirrorConfigError } from '@rdws/syncer/config';
import { type WorkbenchRuntime } from './workbench-runtime.ts';

export function registerRepositories(
  app: FastifyInstance,
  workbench: WorkbenchRuntime,
) {
  const { actor, business, closingSessions, mirrors, projectRoles } = workbench;

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/repositories',
    async (request): Promise<ProjectRepositories> => {
      const { projectId } = request.params;
      const who = await actor(request.headers);
      // Fast check before the slow mirror scan, then re-verify after it (TOCTOU guard).
      const ensureProjectRoles = async () => {
        await actor(request.headers);
        const roles = await projectRoles(who.userId, projectId);
        if (!roles.length) businessError(403, '无权访问当前项目');
        return roles;
      };
      await ensureProjectRoles();
      let repositories;
      try {
        repositories = await mirrors.list(projectId);
      } catch (error) {
        if (error instanceof MirrorConfigError || error instanceof SyntaxError)
          businessError(409, '仓库配置无效，请联系运行维护者核对');
        throw error;
      }
      const roles = await ensureProjectRoles();
      return { repositories, canSync: roles.includes('project_admin') };
    },
  );

  app.post<{
    Params: { projectId: string; repositoryId: string };
    Body: { commandId: string };
  }>(
    '/api/projects/:projectId/repositories/:repositoryId/sync',
    {
      schema: { body: RepositorySyncInput },
      preValidation: async (request) => {
        if (Object.keys(request.body ?? {}).some((key) => key !== 'commandId'))
          businessError(400, '同步仅接受命令标识');
      },
    },
    async (request) => {
      const { projectId, repositoryId } = request.params;
      const who = await actor(request.headers);
      if (
        !(await projectRoles(who.userId, projectId)).includes('project_admin')
      )
        businessError(403, '无权同步项目仓库');
      try {
        const result = await mirrors.sync(
          projectId,
          repositoryId,
          who.userId,
          request.body.commandId,
          (publish) =>
            business.publishRepository(
              who,
              projectId,
              () => closingSessions.has(who.authSessionId),
              publish,
            ),
        );
        await actor(request.headers);
        if (
          !(await projectRoles(who.userId, projectId)).includes('project_admin')
        )
          businessError(403, '无权同步项目仓库');
        return result;
      } catch (error) {
        if (error instanceof MirrorRequestError) {
          if (error.reason === 'missing') businessError(404, '仓库未登记');
          if (error.reason === 'busy')
            businessError(409, '仓库正在同步或有待核对的锁，请先刷新状态');
          businessError(409, '镜像状态需要维护者核对');
        }
        if (error instanceof MirrorConfigError || error instanceof SyntaxError)
          businessError(409, '仓库配置无效，请联系运行维护者核对');
        throw error;
      }
    },
  );
}
