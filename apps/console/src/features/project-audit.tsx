import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  businessAuditLabels,
  type ProjectBusinessAuditPage,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { ProjectAccessAudit } from './project-access-audit.tsx';
import {
  BusinessAuditEvents,
  downloadBusinessAudit,
} from './requirement-audit.tsx';

type Scope = { projectId: string; userId: string; loginId: string };
type Filters = { q: string; kind: string };
type Cursor = NonNullable<ProjectBusinessAuditPage['next']>;

export function ProjectAudit({
  canReadAccessAudit,
  ...scope
}: Scope & { canReadAccessAudit: boolean }) {
  const [showAccess, setShowAccess] = useState(false);
  const access = canReadAccessAudit && showAccess;
  return (
    <section aria-labelledby="project-audit-heading">
      <div className="page-heading core-page-heading">
        <h1 id="project-audit-heading">审计中心</h1>
        <p className="muted">
          {access
            ? '查看当前项目的角色和管理员席位变更。'
            : '检索当前项目内有权查看的需求业务事件。'}
        </p>
      </div>
      {canReadAccessAudit && (
        <div className="list-toolbar" role="group" aria-label="审计范围">
          <Button
            tag="button"
            variant="outline"
            aria-pressed={!access}
            onClick={() => setShowAccess(false)}
          >
            业务事件
          </Button>
          <Button
            tag="button"
            variant="outline"
            aria-pressed={access}
            onClick={() => setShowAccess(true)}
          >
            权限事件
          </Button>
        </div>
      )}
      {access ? (
        <ProjectAccessAudit {...scope} />
      ) : (
        <ProjectBusinessAudit {...scope} />
      )}
    </section>
  );
}

function ProjectBusinessAudit(scope: Scope) {
  const [q, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState({ q: '', kind: '', revision: 0 });
  const [cursor, setCursor] = useState<Cursor>();
  return (
    <>
      <form
        className="list-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setCursor(undefined);
          setSearch((current) => ({
            q: q.trim(),
            kind,
            revision: current.revision + 1,
          }));
        }}
      >
        <div className="detail-edit-field">
          <label htmlFor="project-audit-query">搜索需求或操作者</label>
          <input
            id="project-audit-query"
            type="search"
            value={q}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="detail-edit-field">
          <label htmlFor="project-audit-kind">事件类型</label>
          <select
            id="project-audit-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">全部业务事件</option>
            {Object.entries(businessAuditLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button tag="button" type="submit" style={{ alignSelf: 'flex-end' }}>
          搜索
        </Button>
      </form>
      <AuditResults
        key={JSON.stringify([search, cursor])}
        scope={scope}
        filters={search}
        cursor={cursor}
        onNavigate={setCursor}
      />
    </>
  );
}

function AuditResults({
  scope,
  filters,
  cursor,
  onNavigate,
}: {
  scope: Scope;
  filters: Filters;
  cursor?: Cursor;
  onNavigate: (next?: Cursor) => void;
}) {
  const { projectId, userId, loginId } = scope;
  const parameters = new URLSearchParams();
  if (filters.q) parameters.set('q', filters.q);
  if (filters.kind) parameters.set('kind', filters.kind);
  if (cursor) {
    parameters.set('beforeAt', cursor.at);
    parameters.set('beforeId', cursor.id);
  }
  const query = parameters.toString();
  const audit = useQuery({
    queryKey: ['project-audit', projectId, userId, loginId, query],
    queryFn: async ({ signal }) => {
      const page = await api<ProjectBusinessAuditPage>(
        `/api/projects/${encodeURIComponent(projectId)}/business-audit${query ? '?' + query : ''}`,
        { signal, headers: { [OBSERVED_LOGIN_HEADER]: loginId } },
      );
      if (page.projectId !== projectId) throw new Error('审计范围已变化');
      return page;
    },
    refetchOnMount: 'always',
  });
  if (audit.isError)
    return (
      <div className="inline-feedback">
        <Alert theme="error" message="读取项目审计失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          重试读取项目审计
        </Button>
        {cursor && (
          <Button tag="button" variant="text" onClick={() => onNavigate()}>
            返回最新记录
          </Button>
        )}
      </div>
    );
  const page = audit.isFetchedAfterMount ? audit.data : undefined;
  if (!page) return <Loading text="正在读取项目审计" />;
  const next = page.next;
  return (
    <div className="document-section info-panel context-tasks">
      <div className="context-empty">
        {page.events.length ? (
          <BusinessAuditEvents events={page.events} />
        ) : (
          <p className="muted">没有匹配的业务事件。</p>
        )}
        <div className="list-toolbar">
          {page.events.length > 0 && (
            <Button
              tag="button"
              variant="outline"
              onClick={() => downloadBusinessAudit(projectId, page.events)}
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
          {cursor && (
            <Button tag="button" variant="text" onClick={() => onNavigate()}>
              返回最新记录
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
