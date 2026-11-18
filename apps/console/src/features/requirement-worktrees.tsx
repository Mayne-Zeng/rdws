import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type { RequirementWorkspace } from '@rdws/contracts';
import { authClient } from '../lib/auth.ts';
import { api } from '../lib/ui.tsx';

export function RequirementWorktrees({ id }: { id: string }) {
  const userId = authClient.useSession().data?.user.id;
  const path = '/api/requirements/' + encodeURIComponent(id) + '/worktrees';
  const query = useQuery({
    queryKey: ['requirement-worktrees', userId, id],
    queryFn: ({ signal }) => api<RequirementWorkspace>(path, { signal }),
    enabled: !!userId,
    refetchOnMount: 'always',
  });
  const prepare = useMutation({
    mutationFn: () =>
      api<{ state: 'ready' | 'pending' }>(path, { method: 'POST' }),
    onSettled: () => query.refetch(),
  });
  if (query.data?.state === 'unconfigured' && !query.isError) return null;
  return (
    <section
      className="document-section info-panel"
      aria-labelledby="requirement-worktrees"
    >
      <div className="panel-heading">
        <h2 id="requirement-worktrees">需求工作树</h2>
        {query.data && !query.isError && (
          <span className="pill">
            {query.data.state === 'ready' ? '已就绪' : '待准备'}
          </span>
        )}
      </div>
      {query.isError ? (
        <div className="inline-feedback">
          <Alert theme="error" message="无法读取工作树状态，请重试。" />
          <Button
            tag="button"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试读取工作树
          </Button>
        </div>
      ) : query.isPending ? (
        <Loading text="正在读取工作树状态" />
      ) : (
        <>
          {query.data.state === 'pending' && (
            <div className="inline-feedback">
              <p>冻结基线已保存。工作树就绪后可打开会话。</p>
              {prepare.isError && (
                <Alert
                  theme="error"
                  message="准备请求未完成，请刷新状态后重试。"
                />
              )}
              {query.data.canPrepare && (
                <Button
                  tag="button"
                  loading={prepare.isPending}
                  onClick={() => prepare.mutate()}
                >
                  重试准备工作树
                </Button>
              )}
            </div>
          )}
          {query.data.repositories.map((repo) => (
            <dl className="detail-grid" key={repo.repositoryId}>
              <dt>仓库</dt>
              <dd>{repo.repositoryId}</dd>
              <dt>冻结基线</dt>
              <dd className="prose-text">
                <code>{repo.baseCommit}</code>
              </dd>
              <dt>分支</dt>
              <dd className="prose-text">
                <code>{repo.branch}</code>
              </dd>
              <dt>工作树</dt>
              <dd className="prose-text">
                <code>{repo.worktreePath}</code>
              </dd>
            </dl>
          ))}
        </>
      )}
    </section>
  );
}
