import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { Alert, Button, Loading } from 'tdesign-react';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { SessionHistory } from './session-history.tsx';
import { SessionAnchors } from './session-anchors.tsx';
import { SessionExecution } from './session-execution.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';

export function SessionTrace({
  userId,
  sessionId,
  observedLogin,
  projectId,
  requirementId,
}: {
  userId: string;
  sessionId: string;
  observedLogin: { userId: string; sessionId: string };
  projectId: string;
  requirementId: string;
}) {
  const [selected, setSelected] = useState('');
  const [accessLost, setAccessLost] = useState(false);
  const [route] = useSearchParams();
  const anchorsOnly = route.get('panel') === 'anchors';
  const executionOnly = route.get('panel') === 'execution';
  const traceScope = {
    project: projectId,
    requirement: requirementId,
    view: 'trace',
  };
  const loginChanged =
    userId !== observedLogin.userId || sessionId !== observedLogin.sessionId;
  const directory = useQuery({
    queryKey: ['trace-sessions', userId, sessionId, projectId, requirementId],
    queryFn: ({ signal }) =>
      api<{
        sessions: { id: string; own: boolean; sourceSessionId?: string }[];
      }>(`/api/requirements/${encodeURIComponent(requirementId)}/sessions`, {
        cache: 'no-store',
        headers: { [OBSERVED_LOGIN_HEADER]: observedLogin.sessionId },
        signal,
      }),
    enabled: !loginChanged,
    refetchOnMount: 'always',
    refetchInterval: WORKBENCH_POLL_INTERVAL_MS,
  });
  const sessions = directory.data?.sessions ?? [];
  const session = sessions.find((item) => item.id === selected);
  useEffect(() => {
    if (directory.isError || (directory.isFetchedAfterMount && !session))
      setSelected('');
  }, [directory.isError, directory.isFetchedAfterMount, session]);
  async function recheck() {
    const refreshed = await directory.refetch();
    if (refreshed.isSuccess) setAccessLost(false);
  }
  function loseAccess() {
    setSelected('');
    setAccessLost(true);
  }
  return (
    <section className="session-trace" aria-labelledby="trace-heading">
      <div className="page-heading core-page-heading">
        <h1 id="trace-heading">会话轨迹</h1>
        {!loginChanged && (
          <nav className="list-toolbar" aria-label="轨迹模式">
            {(anchorsOnly || executionOnly) && (
              <Link to={`/?${new URLSearchParams(traceScope)}`}>
                打开逻辑轨迹
              </Link>
            )}
            {!executionOnly && (
              <Link
                to={`/?${new URLSearchParams({ ...traceScope, panel: 'execution' })}`}
              >
                查看执行事件
              </Link>
            )}
            {!anchorsOnly && (
              <Link
                to={`/?${new URLSearchParams({ ...traceScope, panel: 'anchors' })}`}
              >
                查看物理锚点
              </Link>
            )}
          </nav>
        )}
      </div>
      {loginChanged ? (
        <div className="inline-feedback" role="alert">
          <Alert theme="warning" message="登录已变化，请重新打开需求会话。" />
          <Button tag="button" onClick={() => window.location.reload()}>
            重新打开需求会话
          </Button>
        </div>
      ) : accessLost || directory.isError ? (
        <div className="inline-feedback" role="alert">
          <Alert
            theme="error"
            message={
              accessLost
                ? '会话访问已变化，请重新读取会话列表。'
                : '读取会话列表失败，请重试。'
            }
          />
          <Button
            tag="button"
            variant="outline"
            loading={directory.isFetching}
            onClick={() => void recheck()}
          >
            重试读取会话列表
          </Button>
        </div>
      ) : !directory.isFetchedAfterMount || directory.isPending ? (
        <Loading text="正在读取会话列表" />
      ) : sessions.length ? (
        <>
          <div className="list-toolbar">
            <label htmlFor="trace-session">选择会话</label>
            <select
              id="trace-session"
              value={session?.id ?? ''}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">请选择</option>
              {sessions.map((item, index) => (
                <option key={item.id} value={item.id}>
                  会话 {index + 1}
                  {item.own ? ' · 本人' : ''}
                  {item.sourceSessionId ? ' · 派生' : ''}
                </option>
              ))}
            </select>
          </div>
          {session &&
            (anchorsOnly ? (
              <SessionAnchors
                key={session.id}
                projectId={projectId}
                requirementId={requirementId}
                sessionId={session.id}
                userId={userId}
                loginId={observedLogin.sessionId}
                onAccessLost={loseAccess}
              />
            ) : executionOnly ? (
              <SessionExecution
                key={session.id}
                projectId={projectId}
                requirementId={requirementId}
                sessionId={session.id}
                userId={userId}
                loginId={observedLogin.sessionId}
                onAccessLost={loseAccess}
              />
            ) : (
              <SessionHistory
                key={session.id}
                id={session.id}
                requirementId={requirementId}
                observedLoginId={observedLogin.sessionId}
                mode="trace"
                onAccessLost={loseAccess}
              />
            ))}
        </>
      ) : (
        <p className="muted">当前需求暂无会话。</p>
      )}
    </section>
  );
}
