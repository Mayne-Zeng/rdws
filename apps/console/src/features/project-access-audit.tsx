import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  projectAccessAuditLabels,
  type ProjectAccessAuditCursor,
  type ProjectAccessAuditEvent,
  type ProjectAccessAuditPage,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api, roleLabels } from '../lib/ui.tsx';
import { downloadAuditCsv } from './requirement-audit.tsx';

type Scope = { projectId: string; userId: string; loginId: string };

const roleNames = (roles: ProjectAccessAuditEvent['beforeRoles']) =>
  roles.map((role) => roleLabels[role]).join(' / ') || '无';

export function ProjectAccessAudit(scope: Scope) {
  const [cursor, setCursor] = useState<ProjectAccessAuditCursor>();
  return (
    <AccessPage
      key={JSON.stringify(cursor) ?? 'latest'}
      scope={scope}
      cursor={cursor}
      onNavigate={setCursor}
    />
  );
}

function AccessPage({
  scope: { projectId, userId, loginId },
  cursor,
  onNavigate,
}: {
  scope: Scope;
  cursor?: ProjectAccessAuditCursor;
  onNavigate: (cursor?: ProjectAccessAuditCursor) => void;
}) {
  const parameters = cursor
    ? '?' +
      new URLSearchParams({
        beforeAt: cursor.at,
        beforeActorId: cursor.actorId,
        beforeKind: cursor.kind,
        beforeCommandId: cursor.commandId,
      }).toString()
    : '';
  const audit = useQuery({
    queryKey: ['project-access-audit', projectId, userId, loginId, parameters],
    queryFn: async ({ signal }) => {
      const page = await api<ProjectAccessAuditPage>(
        `/api/projects/${encodeURIComponent(projectId)}/access-audit${parameters}`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      );
      if (page.projectId !== projectId) throw new Error('审计范围已变化');
      return page;
    },
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
        <Alert theme="error" message="读取权限事件失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          重试读取权限事件
        </Button>
        {returnToLatest}
      </div>
    );
  if (!page) return <Loading text="正在读取权限事件" />;
  const next = page.next;
  return (
    <div className="document-section info-panel context-tasks">
      <div className="context-empty">
        {page.events.length ? (
          <ol className="history-events" aria-label="项目权限事件">
            {page.events.map((event) => (
              <li
                className="history-event"
                key={JSON.stringify([
                  event.actorId,
                  event.kind,
                  event.commandId,
                ])}
              >
                <details>
                  <summary>
                    {projectAccessAuditLabels[event.kind]} ·{' '}
                    {event.targetName ?? event.targetId}
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
                    <p>变更前角色 {roleNames(event.beforeRoles)}</p>
                    <p>变更后角色 {roleNames(event.afterRoles)}</p>
                    <p>操作标识 {event.commandId}</p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">没有项目权限变更记录。</p>
        )}
        <div className="list-toolbar">
          {page.events.length > 0 && (
            <Button
              tag="button"
              variant="outline"
              onClick={() => downloadAccessAudit(projectId, page.events)}
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
    </div>
  );
}

function downloadAccessAudit(
  projectId: string,
  events: ProjectAccessAuditEvent[],
) {
  downloadAuditCsv(`project-access-audit-${projectId}.csv`, [
    [
      '记录时间',
      '事件类型',
      '操作者',
      '操作者标识',
      '目标账号',
      '目标账号标识',
      '变更前角色',
      '变更后角色',
      '操作标识',
    ],
    ...events.map((event) => [
      event.recordedAt,
      projectAccessAuditLabels[event.kind],
      event.actorName,
      event.actorId,
      event.targetName,
      event.targetId,
      roleNames(event.beforeRoles),
      roleNames(event.afterRoles),
      event.commandId,
    ]),
  ]);
}
