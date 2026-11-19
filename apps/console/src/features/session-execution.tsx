import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  sessionExecutionLabels,
  type SessionExecutionPage,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { downloadAuditCsv } from './requirement-audit.tsx';

type Cursor = NonNullable<SessionExecutionPage['next']>;
type Scope = {
  projectId: string;
  requirementId: string;
  sessionId: string;
  userId: string;
  loginId: string;
};
const originLabels = {
  session: '会话逻辑记录',
  inherited: '派生继承',
  unknown: '来源不明',
} as const;

export function SessionExecution({
  onAccessLost,
  ...scope
}: Scope & { onAccessLost: () => void }) {
  const [position, setPosition] = useState<Cursor>();
  return (
    <section className="history-panel" aria-label="会话执行事件">
      <div className="conversation-title">
        <strong>会话执行事件</strong>
      </div>
      <p className="muted">
        来自 Native 逻辑历史，可能包含中断后的恢复补齐。会话归属用于定位记录。
      </p>
      <ExecutionPage
        key={JSON.stringify(position) ?? 'latest'}
        {...scope}
        position={position}
        onNavigate={setPosition}
        onAccessLost={onAccessLost}
      />
    </section>
  );
}

function ExecutionPage({
  projectId,
  requirementId,
  sessionId,
  userId,
  loginId,
  position,
  onNavigate,
  onAccessLost,
}: Scope & {
  position?: Cursor;
  onNavigate: (next?: Cursor) => void;
  onAccessLost: () => void;
}) {
  const query = position
    ? '?' +
      new URLSearchParams({
        throughSeq: String(position.throughSeq),
        beforeSeq: String(position.beforeSeq),
      }).toString()
    : '';
  const execution = useQuery({
    queryKey: [
      'session-execution',
      projectId,
      requirementId,
      sessionId,
      userId,
      loginId,
      query,
    ],
    queryFn: async ({ signal }) => {
      const page = await api<SessionExecutionPage>(
        `/api/requirements/${encodeURIComponent(requirementId)}/sessions/${encodeURIComponent(sessionId)}/execution${query}`,
        {
          signal,
          cache: 'no-store',
          headers: { [OBSERVED_LOGIN_HEADER]: loginId },
        },
      );
      if (
        page.projectId !== projectId ||
        page.requirementId !== requirementId ||
        page.sessionId !== sessionId ||
        (position &&
          (page.throughSeq !== position.throughSeq ||
            page.events.some(({ seq }) => seq >= position.beforeSeq))) ||
        (page.next &&
          (page.next.throughSeq !== page.throughSeq ||
            !Number.isSafeInteger(page.next.beforeSeq) ||
            page.next.beforeSeq < 1 ||
            page.next.beforeSeq > page.throughSeq ||
            (position && page.next.beforeSeq >= position.beforeSeq)))
      )
        throw new Error('执行事件范围或分页位置已变化');
      return page;
    },
    refetchOnMount: 'always',
  });
  const status = (execution.error as { status?: number } | null)?.status;
  const lost = status === 401 || status === 403 || status === 404;
  useEffect(() => {
    if (lost) onAccessLost();
  }, [lost, onAccessLost]);
  const latest = position && (
    <Button tag="button" variant="text" onClick={() => onNavigate()}>
      返回最新执行事件
    </Button>
  );
  if (lost) return null;
  if (execution.isError)
    return (
      <div className="inline-feedback">
        <Alert theme="error" message="读取执行事件失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={execution.isFetching}
          onClick={() => void execution.refetch()}
        >
          重试读取执行事件
        </Button>
        {latest}
      </div>
    );
  const page =
    execution.isFetchedAfterMount && !execution.isFetching
      ? execution.data
      : undefined;
  if (!page) return <Loading text="正在读取执行事件" />;
  const next = page.next;
  return (
    <>
      <p className="muted">
        {page.throughSeq >= 0
          ? `逻辑范围固定至事件 #${page.throughSeq}`
          : '当前会话暂无历史记录'}
      </p>
      {page.events.length ? (
        <ol className="history-events" aria-label="执行事件列表">
          {page.events.map((event) => (
            <li className="history-event" key={event.seq}>
              <details>
                <summary>
                  <span className="muted">#{event.seq}</span>{' '}
                  <strong>{sessionExecutionLabels[event.status]}</strong>
                </summary>
                <div className="trace-event-detail">
                  <p>来源 {originLabels[event.origin]}</p>
                  <p>
                    轮次 {event.turn} · 步骤 {event.step}
                  </p>
                  {event.sourceSeq !== undefined && (
                    <p>Native 来源 #{event.sourceSeq}</p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">此页暂无可展示的执行事件。</p>
      )}
      <div className="session-actions">
        {page.events.length > 0 && (
          <Button
            tag="button"
            variant="outline"
            onClick={() =>
              downloadAuditCsv(`execution-${sessionId}.csv`, [
                [
                  '项目标识',
                  '需求标识',
                  '会话标识',
                  '会话归属标识',
                  '逻辑截止序号',
                  '事件序号',
                  '状态',
                  '轮次',
                  '步骤',
                  '来源',
                  'Native 来源序号',
                ],
                ...page.events.map((event) => [
                  projectId,
                  requirementId,
                  sessionId,
                  page.sessionOwnerId,
                  page.throughSeq,
                  event.seq,
                  sessionExecutionLabels[event.status],
                  event.turn,
                  event.step,
                  originLabels[event.origin],
                  event.sourceSeq ?? null,
                ]),
              ])
            }
          >
            导出当前页执行事件 CSV
          </Button>
        )}
        {next && (
          <Button
            tag="button"
            variant="outline"
            onClick={() => onNavigate(next)}
          >
            下一页执行事件
          </Button>
        )}
        {latest}
      </div>
    </>
  );
}
