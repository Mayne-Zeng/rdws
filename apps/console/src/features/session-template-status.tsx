import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type { SessionTemplateStatus } from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';

type Scope = { id: string; projectId: string; userId: string; loginId: string };
type SessionEntry = { id: string; own: boolean; sourceSessionId?: string };

export function SessionTemplateStatusPanel(scope: Scope) {
  const { id, projectId, userId, loginId } = scope;
  const [selection, setSelection] = useState('');
  const directory = useQuery({
    queryKey: ['template-status-sessions', projectId, id, userId, loginId],
    queryFn: ({ signal }) =>
      api<{ sessions: SessionEntry[] }>(
        `/api/requirements/${encodeURIComponent(id)}/sessions`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      ),
    refetchOnMount: 'always',
    refetchInterval: WORKBENCH_POLL_INTERVAL_MS,
  });
  const sessions =
    directory.isFetchedAfterMount && !directory.isError
      ? directory.data?.sessions
      : undefined;
  const selected = sessions?.find((row) => row.id === selection);
  useEffect(() => {
    if (directory.isError || (sessions && !selected)) setSelection('');
  }, [directory.isError, sessions, selected]);

  return (
    <section
      className="document-section info-panel context-tasks"
      aria-labelledby="session-template-heading"
    >
      <div className="panel-heading">
        <h2 id="session-template-heading">会话模板版本</h2>
      </div>
      <div className="context-empty">
        {directory.isError ? (
          <div className="inline-feedback">
            <Alert theme="error" message="读取会话列表失败，请重试。" />
            <Button
              tag="button"
              variant="outline"
              loading={directory.isFetching}
              onClick={() => void directory.refetch()}
            >
              重试读取会话列表
            </Button>
          </div>
        ) : !sessions ? (
          <Loading text="正在读取会话列表" />
        ) : sessions.length === 0 ? (
          <p className="muted">当前需求暂无会话。</p>
        ) : (
          <>
            <div className="list-toolbar">
              <label htmlFor="session-template-selection">选择会话</label>
              <select
                id="session-template-selection"
                value={selected?.id ?? ''}
                onChange={(event) => setSelection(event.target.value)}
              >
                <option value="">请选择</option>
                {sessions.map((row, index) => (
                  <option key={row.id} value={row.id}>
                    会话 {index + 1}
                    {row.own ? ' · 本人' : ''}
                    {row.sourceSessionId ? ' · 派生' : ''}
                  </option>
                ))}
              </select>
            </div>
            {selected && (
              <TemplateVersion
                key={selected.id}
                scope={scope}
                target={selected.id}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TemplateVersion({ scope, target }: { scope: Scope; target: string }) {
  const { id, projectId, userId, loginId } = scope;
  const version = useQuery({
    queryKey: [
      'session-template-status',
      projectId,
      id,
      userId,
      loginId,
      target,
    ],
    queryFn: ({ signal }) =>
      api<SessionTemplateStatus>(
        `/api/requirements/${encodeURIComponent(id)}/sessions/${encodeURIComponent(target)}/capability-template`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      ),
    refetchOnMount: 'always',
  });
  const value =
    version.isFetchedAfterMount && !version.isError ? version.data : undefined;
  if (
    version.isError ||
    (version.isFetchedAfterMount &&
      value?.status !== 'recorded' &&
      value?.status !== 'unbound')
  ) {
    return (
      <div className="inline-feedback">
        <Alert theme="warning" message="暂无法核实会话模板版本。" />
        <Button
          tag="button"
          variant="outline"
          loading={version.isFetching}
          onClick={() => void version.refetch()}
        >
          重试核实版本
        </Button>
      </div>
    );
  }
  if (!version.isFetchedAfterMount)
    return <Loading text="正在核实会话模板版本" />;
  return value?.status === 'recorded' ? (
    <p className="prose-text" role="status">
      <strong>{value.name}</strong> · 第 {value.revision} 版
    </p>
  ) : (
    <p className="muted" role="status">
      此会话未采用需求模板。
    </p>
  );
}
