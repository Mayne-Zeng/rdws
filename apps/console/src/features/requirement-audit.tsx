import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  businessAuditLabels,
  stageLabels,
  taskStatusLabels,
  type BusinessAuditEvent,
  type BusinessAuditPage,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { detailFieldLabels } from './requirement-details-editor.tsx';

type Scope = { id: string; projectId: string; userId: string; loginId: string };
type Position = {
  throughVersion: number;
  before: NonNullable<BusinessAuditPage['next']>;
};

const sourceName = (event: BusinessAuditEvent) =>
  event.source === 'migration' ? '历史初始化' : '工作台';
const actorName = (event: BusinessAuditEvent) =>
  event.actorName ?? (event.source === 'migration' ? '初始化' : '成员');

function csvCell(value: string | number | null) {
  let content = String(value ?? '');
  if (
    /^[=+\-@＝＋－＠]/u.test(content.trimStart()) ||
    /^[\t\r\n]/u.test(content)
  )
    content = "'" + content;
  return '"' + content.replaceAll('"', '""') + '"';
}

export function downloadBusinessAudit(
  scopeId: string,
  events: (BusinessAuditEvent & {
    requirementId: string;
    projectId?: string;
    projectName?: string;
  })[],
  crossProject = false,
) {
  const rows = [
    [
      ...(crossProject ? ['项目标识', '项目名称'] : []),
      '需求标识',
      '事件标识',
      '发生时间',
      '事件类型',
      '操作者',
      '操作者标识',
      '来源',
      '任务标识',
      '需求版本',
    ],
    ...events.map((event) => [
      ...(crossProject
        ? [event.projectId ?? null, event.projectName ?? null]
        : []),
      event.requirementId,
      event.id,
      event.createdAt,
      businessAuditLabels[event.kind],
      actorName(event),
      event.actorId,
      sourceName(event),
      event.taskId,
      event.version,
    ]),
  ];
  downloadAuditCsv(
    crossProject
      ? 'cross-project-business-audit.csv'
      : `business-audit-${scopeId}.csv`,
    rows,
  );
}

export function downloadAuditCsv(
  filename: string,
  rows: (string | number | null)[][],
) {
  const url = URL.createObjectURL(
    new Blob(
      [
        '\ufeff',
        rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
      ],
      {
        type: 'text/csv;charset=utf-8',
      },
    ),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RequirementAudit({ scope }: { scope: Scope }) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="document-section info-panel context-tasks"
      aria-labelledby="business-audit-heading"
    >
      <div className="context-empty">
        <details onToggle={({ currentTarget }) => setOpen(currentTarget.open)}>
          <summary id="business-audit-heading">业务审计</summary>
          {open && <AuditPages scope={scope} />}
        </details>
      </div>
    </section>
  );
}

function AuditPages({ scope }: { scope: Scope }) {
  const [position, setPosition] = useState<Position>();
  return (
    <AuditPage
      key={JSON.stringify(position) ?? 'latest'}
      scope={scope}
      position={position}
      onNavigate={setPosition}
    />
  );
}

function AuditPage({
  scope,
  position,
  onNavigate,
}: {
  scope: Scope;
  position?: Position;
  onNavigate: (next?: Position) => void;
}) {
  const { id, projectId, userId, loginId } = scope;
  const parameters = position
    ? '?' +
      new URLSearchParams({
        throughVersion: String(position.throughVersion),
        beforeVersion: String(position.before.version),
        beforeId: position.before.id,
      }).toString()
    : '';
  const audit = useQuery({
    queryKey: ['requirement-audit', projectId, id, userId, loginId, parameters],
    queryFn: async ({ signal }) => {
      const page = await api<BusinessAuditPage>(
        `/api/requirements/${encodeURIComponent(id)}/business-audit${parameters}`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      );
      if (
        page.requirementId !== id ||
        (position && position.throughVersion !== page.throughVersion)
      )
        throw new Error('审计范围已变化');
      return page;
    },
    refetchOnMount: 'always',
  });
  const page =
    audit.isFetchedAfterMount && !audit.isError ? audit.data : undefined;
  if (audit.isError)
    return (
      <div className="inline-feedback">
        <Alert theme="error" message="读取业务审计失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          重试读取业务审计
        </Button>
        {position && (
          <Button tag="button" variant="text" onClick={() => onNavigate()}>
            返回最新记录
          </Button>
        )}
      </div>
    );
  if (!page) return <Loading text="正在读取业务审计" />;
  const next = page.next;
  return (
    <>
      {page.events.length ? (
        <BusinessAuditEvents
          events={page.events}
          traceScope={{ projectId, requirementId: id }}
        />
      ) : (
        <p className="muted">此页没有业务审计事件。</p>
      )}
      <div className="list-toolbar">
        {page.events.length > 0 && (
          <Button
            tag="button"
            variant="outline"
            onClick={() =>
              downloadBusinessAudit(
                page.requirementId,
                page.events.map((event) => ({
                  ...event,
                  requirementId: page.requirementId,
                })),
              )
            }
          >
            导出当前页 CSV
          </Button>
        )}
        {next && (
          <Button
            tag="button"
            variant="outline"
            onClick={() =>
              onNavigate({ throughVersion: page.throughVersion, before: next })
            }
          >
            下一页
          </Button>
        )}
        {position && (
          <Button tag="button" variant="text" onClick={() => onNavigate()}>
            返回最新记录
          </Button>
        )}
      </div>
    </>
  );
}

export function BusinessAuditEvents({
  events,
  traceScope,
}: {
  events: (BusinessAuditEvent & {
    requirementId?: string;
    requirementTitle?: string;
    projectId?: string;
    projectName?: string;
  })[];
  traceScope: { projectId: string; requirementId?: string };
}) {
  return (
    <ol className="history-events" aria-label="业务审计事件">
      {events.map((event) => {
        const project = event.projectId ?? traceScope.projectId;
        const requirement = event.requirementId ?? traceScope.requirementId;
        return (
          <li className="history-event" key={event.id}>
            <details>
              <summary>
                <strong>{businessAuditLabels[event.kind]}</strong> ·{' '}
                {event.projectName && <>{event.projectName} · </>}
                {event.requirementTitle && <>{event.requirementTitle} · </>}
                {actorName(event)} ·{' '}
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString('zh-CN')}
                </time>
              </summary>
              <div className="trace-event-detail">
                <p>
                  来源 {sourceName(event)} · 需求版本 {event.version}
                </p>
                <p>事件标识 {event.id}</p>
                {event.projectId && <p>项目标识 {event.projectId}</p>}
                {event.requirementId && <p>需求标识 {event.requirementId}</p>}
                <p>操作者标识 {event.actorId}</p>
                {event.taskId && <p>任务标识 {event.taskId}</p>}
                {event.stage && (
                  <p>
                    阶段 {stageLabels[event.stage.before]} →{' '}
                    {stageLabels[event.stage.after]}
                  </p>
                )}
                {event.taskStatus && (
                  <p>
                    任务状态{' '}
                    {event.taskStatus.before
                      ? taskStatusLabels[event.taskStatus.before] + ' → '
                      : ''}
                    {taskStatusLabels[event.taskStatus.after]}
                  </p>
                )}
                {!!event.changedFields?.length && (
                  <p>
                    变更字段{' '}
                    {event.changedFields
                      .map((field) => detailFieldLabels[field])
                      .join('、')}
                  </p>
                )}
                {requirement && (
                  <p>
                    <Link
                      to={`/?${new URLSearchParams({ project, requirement, view: 'trace', panel: 'anchors' })}`}
                    >
                      查看物理锚点
                    </Link>
                  </p>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
