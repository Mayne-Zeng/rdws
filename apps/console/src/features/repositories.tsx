import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type {
  ProjectRepositories,
  RepositorySummary,
  RepositorySyncIssue,
  RepositorySyncResult,
} from '@rdws/contracts';
import { api, Icon } from '../lib/ui.tsx';

const states: Record<RepositorySyncResult['status'], string> = {
  running: '同步中',
  succeeded: '同步成功',
  failed: '同步失败',
  unknown: '结果待核对',
};

const issues: Record<RepositorySyncIssue, string> = {
  credentials: '只读凭据不可用，请联系运行维护者核对登记。',
  connection: '无法读取基线分支，请核对连接、读取权限和分支。',
  target: '无法读取目标分支，请核对连接、读取权限和分支。',
  signature: '基线签名未通过可信校验，请联系仓库维护者。',
  history: '远端基线无法从已发布提交快进，请核对分支历史。',
  configuration_changed: '登记或信任材料已变更，请刷新后重新同步。',
  authorization: '发布时登录或管理员权限已失效。',
  storage: '镜像或收据不可用，请联系运行维护者核对。',
  timeout: 'Git 操作超时，请先核对当前基线。',
  stopped: '同步已停止，请先核对当前基线。',
};

function RepositoryCard({
  row,
  base,
  canSync,
  projectId,
}: {
  row: RepositorySummary;
  base: string;
  canSync: boolean;
  projectId: string;
}) {
  const client = useQueryClient();
  const command = useRef<string | undefined>(undefined);
  const active = useRef(false);
  const uncertain = useRef(false);
  const sync = useMutation<RepositorySyncResult, Error, boolean>({
    mutationFn: (fresh = false) => {
      if (fresh) {
        command.current = undefined;
        uncertain.current = false;
      }
      command.current ??= crypto.randomUUID();
      return api<RepositorySyncResult>(
        base + '/' + encodeURIComponent(row.id) + '/sync',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: command.current }),
        },
      );
    },
    onSuccess: (result) => {
      uncertain.current =
        result.status === 'running' || result.status === 'unknown';
      if (!uncertain.current) command.current = undefined;
    },
    onError: (error) => {
      uncertain.current ||= !!(error as Error & { resultUnknown?: boolean })
        .resultUnknown;
      if (!uncertain.current) command.current = undefined;
    },
    onSettled: async () => {
      try {
        await client.invalidateQueries({
          queryKey: ['repositories', projectId],
        });
      } finally {
        active.current = false;
      }
    },
  });
  const reply = sync.data;
  const result =
    reply &&
    (!row.lastSync ||
      reply.startedAt > row.lastSync.startedAt ||
      (row.lastSync.commandId === reply.commandId &&
        row.lastSync.status === 'running'))
      ? reply
      : row.lastSync;
  const launch = (fresh = false) => {
    if (active.current) return;
    active.current = true;
    sync.mutate(fresh);
  };
  const recovering = !!command.current && uncertain.current;
  const newSync =
    result?.status === 'unknown' || sync.data?.status === 'unknown';
  return (
    <section className="document-section">
      <div className="section-heading">
        <h2>{row.name}</h2>
        {canSync && (
          <div className="form-actions">
            <Button
              tag="button"
              loading={sync.isPending}
              disabled={
                recovering
                  ? false
                  : !!row.stateIssue || result?.status === 'running'
              }
              onClick={() => launch()}
            >
              {recovering ? '核对原同步' : newSync ? '发起新同步' : '同步基线'}
            </Button>
            {recovering && newSync && !row.stateIssue && (
              <Button
                tag="button"
                variant="outline"
                disabled={sync.isPending}
                onClick={() => launch(true)}
              >
                发起新同步
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="info-panel">
        <dl className="detail-grid">
          <dt>基线分支</dt>
          <dd>
            <code>{row.baselineRef}</code>
          </dd>
          <dt>目标环境</dt>
          <dd>
            {row.targetName} · <code>{row.targetRef}</code>
          </dd>
          <dt>已发布基线</dt>
          <dd>
            <code>{row.publishedCommit ?? '尚未发布'}</code>
          </dd>
          <dt>同步状态</dt>
          <dd role="status">
            {sync.isPending
              ? '正在同步…'
              : result
                ? states[result.status]
                : '尚未同步'}
          </dd>
          {result && (
            <>
              <dt>同步时间</dt>
              <dd>
                {new Date(result.finishedAt ?? result.startedAt).toLocaleString(
                  'zh-CN',
                )}
              </dd>
              <dt>同步标识</dt>
              <dd>
                <code>{result.commandId}</code>
              </dd>
              {result.candidateCommit && (
                <>
                  <dt>候选提交</dt>
                  <dd>
                    <code>{result.candidateCommit}</code>
                  </dd>
                </>
              )}
              {result.targetCommit && (
                <>
                  <dt>目标观测</dt>
                  <dd>
                    <code>{result.targetCommit}</code>
                  </dd>
                </>
              )}
              {result.signerFingerprint && (
                <>
                  <dt>签名指纹</dt>
                  <dd>
                    <code>{result.signerFingerprint}</code>
                  </dd>
                </>
              )}
            </>
          )}
        </dl>
      </div>
      {row.stateIssue && (
        <Alert theme="warning" message="镜像状态需要运行维护者核对。" />
      )}
      {result?.issue && (
        <Alert theme="warning" message={issues[result.issue]} />
      )}
      {sync.error && (
        <Alert
          theme="error"
          message={
            recovering
              ? '响应未确认，已刷新仓库状态。可核对原同步。'
              : sync.error.message
          }
        />
      )}
    </section>
  );
}

export function RepositoriesPage({ projectId }: { projectId: string }) {
  const base =
    '/api/projects/' + encodeURIComponent(projectId) + '/repositories';
  const query = useQuery({
    queryKey: ['repositories', projectId],
    queryFn: ({ signal }) => api<ProjectRepositories>(base, { signal }),
    refetchInterval: (current) =>
      current.state.data?.repositories.some(
        (row) => row.lastSync?.status === 'running',
      )
        ? 1500
        : false,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>仓库与环境</h1>
          <p className="muted">
            查看 GitLab 基线、本地只读镜像和非生产目标分支。
          </p>
        </div>
        <Button
          tag="button"
          variant="outline"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新状态
        </Button>
      </div>
      {query.isError && <Alert theme="error" message={query.error.message} />}
      {query.isPending ? (
        <Loading text="正在读取仓库" />
      ) : !query.data ||
        (query.isError &&
          !(query.error as Error & { resultUnknown?: boolean })
            .resultUnknown) ? null : query.data.repositories.length ? (
        query.data.repositories.map((row) => (
          <RepositoryCard
            key={row.id}
            row={row}
            base={base}
            canSync={query.data.canSync}
            projectId={projectId}
          />
        ))
      ) : (
        <div className="empty-state info-panel">
          <Icon name="folder" />
          <h2>尚未登记仓库</h2>
          <p>请联系运行维护者登记当前项目的 GitLab 仓库、基线和目标环境。</p>
        </div>
      )}
    </>
  );
}
