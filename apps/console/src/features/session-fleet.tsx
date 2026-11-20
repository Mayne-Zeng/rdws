import { useEffect, useLayoutEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type { RequirementWriteAuthority } from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';
import { SessionHistory } from './session-history.tsx';
import { FleetWriteCommands } from './fleet-write-commands.tsx';
import './session-fleet.css';

type FleetSession = {
  id: string;
  own: boolean;
  sourceSessionId: string | null;
  sourceThroughSeq: number | null;
};

export function SessionFleet({
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
  const loginChanged =
    userId !== observedLogin.userId || sessionId !== observedLogin.sessionId;
  const directory = useQuery({
    queryKey: ['fleet-sessions', projectId, requirementId, userId, sessionId],
    queryFn: async ({ signal }) => {
      const result = await api<{ sessions: FleetSession[] }>(
        `/api/requirements/${encodeURIComponent(requirementId)}/sessions`,
        {
          cache: 'no-store',
          headers: { [OBSERVED_LOGIN_HEADER]: observedLogin.sessionId },
          signal,
        },
      );
      if (!Array.isArray(result?.sessions))
        throw new Error('会话列表格式不正确');
      return result.sessions;
    },
    enabled: !loginChanged,
    refetchOnMount: 'always',
    refetchInterval: WORKBENCH_POLL_INTERVAL_MS,
  });
  const sessions = directory.data ?? [];
  const hasSelection = sessions.some(({ id }) => id === selected);
  const showStatus =
    !loginChanged &&
    !accessLost &&
    directory.isSuccess &&
    directory.isFetchedAfterMount;
  useEffect(() => {
    if (directory.isError || (directory.isFetchedAfterMount && !hasSelection))
      setSelected('');
  }, [directory.isError, directory.isFetchedAfterMount, hasSelection]);

  async function recheck() {
    if ((await directory.refetch()).isSuccess) setAccessLost(false);
  }
  function loseAccess() {
    setSelected('');
    setAccessLost(true);
  }

  return (
    <section aria-labelledby="fleet-heading">
      <div className="page-heading core-page-heading">
        <h1 id="fleet-heading">编队</h1>
        {showStatus && (
          <FleetWriteStatus
            projectId={projectId}
            requirementId={requirementId}
            userId={userId}
            loginId={observedLogin.sessionId}
            sessions={sessions}
            onAccessLost={loseAccess}
          />
        )}
      </div>
      {loginChanged ? (
        <div className="inline-feedback" role="alert">
          <Alert theme="warning" message="登录已变化，请重新打开编队。" />
          <Button tag="button" onClick={() => window.location.reload()}>
            重新打开编队
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
        <ul className="fleet-sessions" role="list" aria-label="编队会话列表">
          {sessions.map(
            ({ id, own, sourceSessionId, sourceThroughSeq }, index) => {
              const position = index + 1;
              const expanded = id === selected;
              const source = sessions.findIndex(
                (item) => item.id === sourceSessionId,
              );
              const replayId = 'fleet-replay-' + position;
              return (
                <li key={id}>
                  <div className="fleet-session-row">
                    <div>
                      <h2>会话 {position}</h2>
                      <p className="muted">
                        {own ? '本人' : '其他成员'} ·{' '}
                        {sourceSessionId ? '派生会话' : '原始会话'}
                        {sourceSessionId &&
                          source >= 0 &&
                          ` · 源会话 ${source + 1}`}
                        {sourceThroughSeq != null &&
                          ` · 源事件 ${sourceThroughSeq}`}
                      </p>
                    </div>
                    <Button
                      tag="button"
                      variant="outline"
                      aria-label={`回放会话 ${position}`}
                      aria-expanded={expanded}
                      aria-controls={replayId}
                      onClick={() => setSelected(expanded ? '' : id)}
                    >
                      {expanded ? '收起回放' : '回放'}
                    </Button>
                  </div>
                  <div
                    className="fleet-replay"
                    id={replayId}
                    hidden={!expanded}
                  >
                    {expanded && (
                      <SessionHistory
                        key={id}
                        id={id}
                        requirementId={requirementId}
                        observedLoginId={observedLogin.sessionId}
                        onAccessLost={loseAccess}
                      />
                    )}
                  </div>
                </li>
              );
            },
          )}
        </ul>
      ) : (
        <p className="muted">当前需求暂无会话。</p>
      )}
    </section>
  );
}

const writeStatusLabels = {
  idle: '暂无写会话',
  held: '写权已占用',
  stopping: '写任务停止中',
  unconfirmed: '写权状态待确认',
};

function FleetWriteStatus({
  projectId,
  requirementId,
  userId,
  loginId,
  sessions,
  onAccessLost,
}: {
  projectId: string;
  requirementId: string;
  userId: string;
  loginId: string;
  sessions: FleetSession[];
  onAccessLost: () => void;
}) {
  const requirementPath = `/api/requirements/${encodeURIComponent(requirementId)}`;
  const writeStatus = useQuery({
    queryKey: ['fleet-write-status', projectId, requirementId, userId, loginId],
    queryFn: ({ signal }) =>
      api<RequirementWriteAuthority>(requirementPath + '/write-authority', {
        cache: 'no-store',
        headers: { [OBSERVED_LOGIN_HEADER]: loginId },
        signal,
      }),
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.state === 'unavailable'
        ? false
        : WORKBENCH_POLL_INTERVAL_MS,
  });
  const status =
    writeStatus.isSuccess && writeStatus.isFetchedAfterMount
      ? writeStatus.data
      : undefined;
  const failure = writeStatus.isFetchedAfterMount ? writeStatus.error : null;
  useLayoutEffect(() => {
    const code = (failure as { status?: number } | null)?.status;
    if (code === 401 || code === 403 || code === 404) onAccessLost();
  }, [failure, onAccessLost]);
  const holder = status?.state === 'held' ? status.holder : undefined;
  const [elapsed, setElapsed] = useState<number>();
  const expiresAt = (holder ?? status?.releaseTarget)?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined || expiresAt <= Date.now()) return;
    const timer = window.setTimeout(
      () => setElapsed(expiresAt),
      expiresAt - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const expired =
    expiresAt !== undefined &&
    (expiresAt <= Date.now() || elapsed === expiresAt);
  const ownPosition =
    holder && !expired
      ? sessions.findIndex(({ id, own }) => own && id === holder.sessionId) + 1
      : 0;
  const state = expired ? 'unconfirmed' : status?.state;
  const label = failure
    ? '写权状态暂不可查询'
    : state && state !== 'unavailable'
      ? writeStatusLabels[state]
      : undefined;
  return label ? (
    <div className="fleet-write-panel">
      <p
        className="muted fleet-write-status"
        role="status"
        aria-label="写权状态"
      >
        {label}
        {ownPosition > 0 && ` · 本人会话 ${ownPosition}`}
      </p>
      {writeStatus.data?.actionsEnabled && (
        <FleetWriteCommands
          keyScope={[projectId, requirementId, userId, loginId]}
          loginId={loginId}
          requirementPath={requirementPath}
          status={expired && status ? { state: 'unconfirmed' } : status}
          sessions={sessions}
          onAccessLost={onAccessLost}
          refreshStatus={() => void writeStatus.refetch()}
        />
      )}
    </div>
  ) : null;
}
