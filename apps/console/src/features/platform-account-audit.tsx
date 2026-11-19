import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type {
  PlatformAccountAuditCursor,
  PlatformAccountAuditEvent,
  PlatformAccountAuditPage,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { downloadAuditCsv } from './requirement-audit.tsx';

type Scope = { userId: string; loginId: string };
const stateLabel = (active: boolean) => (active ? '有效' : '已停用');
const eventLabel = (event: PlatformAccountAuditEvent) =>
  event.afterActive ? '恢复账号' : '停用账号';

export function PlatformAccountAudit(scope: Scope) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<PlatformAccountAuditCursor>();
  return (
    <div className="info-panel context-tasks">
      <div className="context-empty">
        <details onToggle={({ currentTarget }) => setOpen(currentTarget.open)}>
          <summary>账号状态记录</summary>
          {open && (
            <AccountAuditPage
              key={JSON.stringify(cursor) ?? 'latest'}
              {...scope}
              cursor={cursor}
              onNavigate={setCursor}
            />
          )}
        </details>
      </div>
    </div>
  );
}

function AccountAuditPage({
  userId,
  loginId,
  cursor,
  onNavigate,
}: Scope & {
  cursor?: PlatformAccountAuditCursor;
  onNavigate: (cursor?: PlatformAccountAuditCursor) => void;
}) {
  const query = cursor
    ? '?' +
      new URLSearchParams({
        beforeAt: cursor.at,
        beforeActorId: cursor.actorId,
        beforeCommandId: cursor.commandId,
      }).toString()
    : '';
  const audit = useQuery({
    queryKey: [
      'administration',
      'platform-account-audit',
      userId,
      loginId,
      query,
    ],
    queryFn: ({ signal }) =>
      api<PlatformAccountAuditPage>(
        `/api/management/platform/account-audit${query}`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      ),
    refetchOnMount: 'always',
  });
  const page =
    audit.isFetchedAfterMount && !audit.isError && !audit.isFetching
      ? audit.data
      : undefined;
  const returnToLatest = cursor && (
    <Button tag="button" variant="text" onClick={() => onNavigate()}>
      返回最新记录
    </Button>
  );
  if (audit.isError)
    return (
      <div className="inline-feedback">
        <Alert theme="error" message="读取账号状态记录失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          重试读取账号状态记录
        </Button>
        {returnToLatest}
      </div>
    );
  if (!page) return <Loading text="正在读取账号状态记录" />;
  const next = page.next;
  return (
    <div>
      {page.events.length ? (
        <ol className="history-events" aria-label="账号状态审计事件">
          {page.events.map((event) => (
            <li
              className="history-event"
              key={JSON.stringify([event.actorId, event.commandId])}
            >
              <details>
                <summary>
                  {eventLabel(event)} · {event.targetName ?? event.targetId}
                </summary>
                <div className="trace-event-detail">
                  <p>
                    记录时间{' '}
                    <time dateTime={event.recordedAt}>
                      {new Date(event.recordedAt).toLocaleString()}
                    </time>
                  </p>
                  <p>操作者 {event.actorName ?? event.actorId}</p>
                  <p>目标账号 {event.targetName ?? event.targetId}</p>
                  <p>变更前状态 {stateLabel(event.beforeActive)}</p>
                  <p>变更后状态 {stateLabel(event.afterActive)}</p>
                  <p>操作标识 {event.commandId}</p>
                </div>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">没有账号状态变更记录。</p>
      )}
      <div className="list-toolbar">
        {page.events.length > 0 && (
          <Button
            tag="button"
            variant="outline"
            onClick={() => downloadAccountAudit(page.events)}
          >
            导出当前页 CSV
          </Button>
        )}
        {next && (
          <Button
            tag="button"
            variant="outline"
            onClick={() => onNavigate(next)}
          >
            下一页
          </Button>
        )}
        {returnToLatest}
      </div>
    </div>
  );
}

function downloadAccountAudit(events: PlatformAccountAuditEvent[]) {
  downloadAuditCsv('platform-account-audit.csv', [
    [
      '记录时间',
      '事件类型',
      '操作者',
      '操作者标识',
      '目标账号',
      '目标账号标识',
      '变更前状态',
      '变更后状态',
      '操作标识',
    ],
    ...events.map((event) => [
      event.recordedAt,
      eventLabel(event),
      event.actorName,
      event.actorId,
      event.targetName,
      event.targetId,
      stateLabel(event.beforeActive),
      stateLabel(event.afterActive),
      event.commandId,
    ]),
  ]);
}
