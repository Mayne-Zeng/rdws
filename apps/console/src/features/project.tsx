import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  stageLabels,
  type RequirementSummary,
  type ProjectList,
} from '@rdws/contracts';
import { Icon, api, roleLabels } from '../lib/ui.tsx';
import { RequirementForm } from './requirement-form.tsx';
import { RequirementImport } from './requirement-import.tsx';
import { RequirementPage } from './requirement.tsx';
import { MembersPage } from './administration.tsx';
import { RepositoriesPage } from './repositories.tsx';
import { CapabilityTemplates } from './capability-templates.tsx';
import { SessionTrace } from './session-trace.tsx';
import { ProjectAudit } from './project-audit.tsx';
import type { NativeTab } from './conversation.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';
export type View =
  | 'requirements'
  | 'overview'
  | 'chat'
  | 'trace'
  | 'context'
  | 'create'
  | 'repos'
  | 'members'
  | 'capabilities'
  | 'audit'
  | 'platform'
  | 'design';
export type Project = ProjectList['projects'][number];
export function ProjectWorkspace({
  projects,
  userId,
  sessionId,
  nativeTab,
  platformAdmin,
  username,
  logout,
  logoutBusy,
  error,
}: {
  projects: Project[];
  userId: string;
  sessionId: string;
  nativeTab: NativeTab;
  platformAdmin: boolean;
  username: string;
  logout: () => void;
  logoutBusy: boolean;
  error: string;
}) {
  const [search, setSearch] = useSearchParams();
  const requestedProject = search.get('project');
  const project =
    projects.find((p) => p.id === requestedProject) ?? projects[0]!;
  const projectMatches =
    requestedProject === null || requestedProject === project.id;
  const selected = search.get('requirement') ?? '';
  const current = search.get('view');
  const view: View = [
    'overview',
    'chat',
    'trace',
    'context',
    'create',
    'repos',
    'members',
    'capabilities',
    'audit',
  ].includes(current ?? '')
    ? (current as View)
    : 'requirements';
  const importing = view === 'requirements' && search.get('panel') === 'import';
  const [mobile, setMobile] = useState(false),
    [filter, setFilter] = useState(''),
    [protectedForm, setProtectedForm] = useState(false),
    [smallScreen, setSmallScreen] = useState(
      () => window.matchMedia('(max-width: 620px)').matches,
    );
  const rail = useRef<HTMLElement>(null),
    menu = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 620px)');
    const update = () => {
      setSmallScreen(query.matches);
      if (!query.matches) setMobile(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile || !smallScreen) return;
    const element = rail.current!;
    const controls = () =>
      [
        ...element.querySelectorAll<HTMLElement>(
          'a[href], button, input, select',
        ),
      ].filter(
        (el) =>
          !el.matches(':disabled, [aria-disabled="true"]') &&
          el.getClientRects().length,
      );
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobile(false);
      } else if (event.key === 'Tab') {
        const items = controls(),
          first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    element.addEventListener('keydown', keydown);
    return () => {
      element.removeEventListener('keydown', keydown);
      if (window.matchMedia('(max-width: 620px)').matches)
        menu.current?.focus();
      else element.querySelector<HTMLElement>('.nav-item')?.focus();
    };
  }, [mobile, smallScreen]);
  const client = useQueryClient();
  const requirements = useQuery({
    queryKey: ['requirements', project.id, userId, sessionId],
    queryFn: ({ signal }) =>
      api<{ requirements: RequirementSummary[]; canCreate: boolean }>(
        `/api/projects/${project.id}/requirements`,
        { signal },
      ),
    refetchInterval: WORKBENCH_POLL_INTERVAL_MS,
    enabled: projectMatches,
  });
  const requirementListStatus = (
    requirements.error as { status?: number } | null
  )?.status;
  const importAuthorized =
    !!requirements.data?.canCreate &&
    requirementListStatus !== 401 &&
    requirementListStatus !== 403 &&
    requirementListStatus !== 404;
  function navigate(next: View, id = selected) {
    if (protectedForm) return;
    const panel = search.get('panel');
    setSearch({
      project: project.id,
      view: next,
      ...(id ? { requirement: id } : {}),
      ...(next === 'trace' &&
        view === 'trace' &&
        (panel === 'anchors' || panel === 'execution') && { panel }),
    });
    setMobile(false);
  }
  const summary = requirements.data?.requirements.find(
    (r) => r.id === selected,
  );
  const filtered =
    requirements.data?.requirements.filter((r) =>
      r.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];
  const demandView =
    !!selected &&
    view !== 'create' &&
    !importing &&
    view !== 'repos' &&
    view !== 'members' &&
    view !== 'capabilities' &&
    view !== 'audit';
  const traceAccessFailed = view === 'trace' && requirements.isError;
  const showTabs =
    demandView && projectMatches && !!summary && !traceAccessFailed;
  const sessionView = view === 'chat' || view === 'trace';
  const scopeLabel = sessionView ? '会话视图' : '需求级';
  const activeView = view === 'requirements' ? 'overview' : view;
  const tabs = [
    { view: 'chat', label: '对话', icon: 'chat' },
    { view: 'trace', label: '轨迹', icon: 'clock' },
    { view: 'overview', label: '需求档案', icon: 'grid' },
    { view: 'context', label: '上下文', icon: 'layers' },
  ] as const;
  const projectCard = (
    <div className="project-card">
      <span className="project-mark">
        <Icon name="folder" />
      </span>
      <div>
        <strong>{project.name}</strong>
        <span>{project.roles.map((r) => roleLabels[r] ?? r).join(' / ')}</span>
      </div>
      {projects.length > 1 && (
        <select
          disabled={protectedForm}
          aria-label="切换项目"
          title={project.name}
          value={project.id}
          onChange={(e) => {
            setSearch({
              project: e.target.value,
              view: view === 'audit' ? 'audit' : 'requirements',
            });
            setMobile(false);
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <div className="project-metrics">
        <span>
          <strong>{requirements.data?.requirements.length ?? '—'}</strong>需求
        </span>
        <span>
          <strong>
            {requirements.data?.requirements.filter(
              (item) => item.stage === 'assignment',
            ).length ?? '—'}
          </strong>
          指派阶段
        </span>
        <span>
          <strong>{project.roles.length}</strong>我的角色
        </span>
      </div>
    </div>
  );
  if (!projectMatches)
    return (
      <main className="shell centered">
        <h1>无法访问指定项目</h1>
        <p className="muted">请核对项目链接或切换到有权访问的项目。</p>
        <Button tag="button" onClick={() => navigate('requirements', '')}>
          返回可访问项目
        </Button>
      </main>
    );
  return (
    <main className={'shell workspace-shell' + (mobile ? ' rail-open' : '')}>
      <aside
        ref={rail}
        id="project-rail"
        className="rail"
        aria-label="项目侧栏"
        inert={smallScreen && !mobile}
      >
        <div className="rail-head">
          <a
            href="/"
            className="brand"
            aria-label="RDWS 首页"
            aria-disabled={protectedForm || undefined}
            onClick={(event) => {
              if (protectedForm) event.preventDefault();
            }}
          >
            <span className="brand-mark">
              <Icon name="layers" />
            </span>
            <strong>RDWS</strong>
            <span>产研一体化工作区</span>
          </a>
          {requirements.data?.canCreate && (
            <Button
              tag="button"
              block
              aria-label="新建需求"
              disabled={protectedForm}
              onClick={() => navigate('create', '')}
            >
              <Icon name="plus" />
              <span>新建需求</span>
            </Button>
          )}
          <button
            className="rail-close icon-button"
            aria-label="关闭导航"
            onClick={() => setMobile(false)}
          >
            <Icon name="menu" />
          </button>
        </div>
        {projectCard}
        <nav aria-label="项目导航" className="rail-nav">
          <p className="nav-heading">项目管理</p>
          <button
            aria-label="需求管理"
            disabled={protectedForm}
            className={'nav-item' + (view === 'requirements' ? ' active' : '')}
            onClick={() => navigate('requirements', '')}
          >
            <Icon name="grid" />
            <span>需求管理</span>
            <span className="count">
              {requirements.data?.requirements.length ?? '—'}
            </span>
          </button>
          <button
            aria-label="仓库与环境"
            aria-current={view === 'repos' ? 'page' : undefined}
            disabled={protectedForm}
            className={'nav-item' + (view === 'repos' ? ' active' : '')}
            onClick={() => navigate('repos', '')}
          >
            <Icon name="folder" />
            <span>仓库与环境</span>
          </button>
          {project.roles.includes('project_admin') && (
            <button
              aria-label="成员与权限"
              disabled={protectedForm}
              className={'nav-item' + (view === 'members' ? ' active' : '')}
              onClick={() => navigate('members', '')}
            >
              <Icon name="layers" />
              <span>成员与权限</span>
            </button>
          )}
          <button
            aria-label="能力模板"
            title="能力模板"
            aria-current={view === 'capabilities' ? 'page' : undefined}
            disabled={protectedForm}
            className={'nav-item' + (view === 'capabilities' ? ' active' : '')}
            style={{ minHeight: 'var(--control-h)' }}
            onClick={() => navigate('capabilities', '')}
          >
            <Icon name="file" />
            <span>能力模板</span>
          </button>
          <button
            aria-label="审计中心"
            title="审计中心"
            aria-current={view === 'audit' ? 'page' : undefined}
            disabled={protectedForm}
            className={'nav-item' + (view === 'audit' ? ' active' : '')}
            onClick={() => navigate('audit', '')}
          >
            <Icon name="shield" />
            <span>审计中心</span>
          </button>
          {platformAdmin && (
            <button
              aria-label="平台设置"
              disabled={protectedForm}
              className="nav-item"
              onClick={() => navigate('platform', '')}
            >
              <Icon name="grid" />
              <span>平台设置</span>
            </button>
          )}
          <button
            aria-label="设计系统"
            title="设计系统"
            disabled={protectedForm}
            className="nav-item design-nav"
            onClick={() => navigate('design', '')}
          >
            <Icon name="eye" />
            <span>设计系统</span>
          </button>
        </nav>
        <div className="tree-heading">
          <span>需求 / 工作区</span>
          {requirements.data?.canCreate ? (
            <button
              className="tree-create icon-button"
              aria-label="新建需求"
              title="新建需求"
              disabled={protectedForm}
              onClick={() => navigate('create', '')}
            >
              <Icon name="plus" />
            </button>
          ) : (
            <span>{requirements.data?.requirements.length ?? '—'}</span>
          )}
        </div>
        <label className="tree-search">
          <span className="sr-only">搜索需求</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索需求…"
          />
        </label>
        <div className="rail-scroll">
          {filtered.length > 0 && (
            <div className="tree-group">
              <span className="status-dot" />
              可访问需求<span>{filtered.length}</span>
            </div>
          )}
          {filtered.map((r) => (
            <button
              key={r.id}
              disabled={protectedForm}
              aria-current={showTabs && r.id === selected ? 'page' : undefined}
              aria-label={r.title}
              className={
                'demand-item' +
                (r.id === selected && view !== 'create' ? ' active' : '')
              }
              onClick={() => navigate(sessionView ? view : 'overview', r.id)}
            >
              <span className="demand-icon">
                <Icon name="file" />
              </span>
              <span className="demand-text">
                <strong>{r.title}</strong>
                <small>{stageLabels[r.stage]}</small>
              </span>
            </button>
          ))}
          {requirements.isPending && (
            <p className="rail-empty" role="status">
              正在读取需求…
            </p>
          )}
          {requirements.isError && (
            <p className="rail-empty">需求列表暂不可用，请在工作区重试。</p>
          )}
          {!filtered.length && requirements.isSuccess && (
            <p className="rail-empty">
              {filter ? '没有匹配的需求' : '暂无可访问需求'}
            </p>
          )}
        </div>
        {error && mobile && smallScreen && (
          <Alert theme="error" message={error} />
        )}
        <div className="rail-foot">
          <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{username}</strong>
            <small>
              {project.roles.map((r) => roleLabels[r] ?? r).join(' / ')}
            </small>
          </div>
          <Button
            tag="button"
            variant="text"
            size="small"
            onClick={logout}
            loading={logoutBusy}
            aria-label="退出登录"
            title="退出登录"
          >
            <span className="logout-icon">
              <Icon name="arrow" />
            </span>
            <span className="logout-label">退出登录</span>
          </Button>
        </div>
      </aside>
      {mobile && (
        <div
          className="rail-scrim"
          aria-hidden="true"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="workspace-main" inert={mobile && smallScreen}>
        <header className="topbar">
          <button
            ref={menu}
            className="mobile-menu icon-button"
            aria-label="打开导航"
            aria-expanded={mobile}
            aria-controls="project-rail"
            onClick={() => setMobile(!mobile)}
          >
            <Icon name="menu" />
          </button>
          <div className="top-context">
            <div className="crumb">
              <Icon name="folder" />
              <span>{project.name}</span>
              <span>/</span>
              <span>
                {summary
                  ? '需求工作区'
                  : view === 'create'
                    ? '新建需求'
                    : '项目空间'}
              </span>
            </div>
            <div className="top-title">
              {view === 'members'
                ? '成员与权限'
                : view === 'capabilities'
                  ? '能力模板'
                  : view === 'repos'
                    ? '仓库与环境'
                    : view === 'audit'
                      ? '审计中心'
                      : importing
                        ? '批量导入需求'
                        : view === 'create'
                          ? '新建需求'
                          : (summary?.title ?? '需求管理')}
            </div>
          </div>
          <span className="pill local-badge">
            <span className="status-dot" />
            本地 PoC
          </span>
        </header>
        {showTabs && (
          <div className="workspace-scope">
            <Icon name="eye" />
            <strong>{scopeLabel}</strong>
            <span>当前需求下的会话为只读分析</span>
            {sessionView ? (
              <button onClick={() => navigate('overview')}>
                查看档案与阶段操作
              </button>
            ) : view === 'context' ? (
              <button onClick={() => navigate('overview')}>查看需求档案</button>
            ) : (
              <button onClick={() => navigate('context')}>查看上下文</button>
            )}
          </div>
        )}
        {showTabs && (
          <div className="workspace-tabs">
            <div
              role="tablist"
              aria-label="工作区视图"
              onKeyDown={(event) => {
                const focused = (event.target as HTMLElement).closest(
                  '[role="tab"]',
                )?.id;
                const index = tabs.findIndex(
                  (tab) => 'view-' + tab.view === focused,
                );
                if (index < 0) return;
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : event.key === 'ArrowRight'
                        ? (index + 1) % tabs.length
                        : event.key === 'ArrowLeft'
                          ? (index + tabs.length - 1) % tabs.length
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                navigate(tabs[next]!.view);
                document.getElementById('view-' + tabs[next]!.view)?.focus();
              }}
            >
              {tabs.map((tab) => (
                <Fragment key={tab.view}>
                  {tab.view === 'overview' && (
                    <span className="tab-divider" aria-hidden="true" />
                  )}
                  <button
                    id={'view-' + tab.view}
                    role="tab"
                    aria-selected={activeView === tab.view}
                    aria-controls="workspace-panel"
                    tabIndex={activeView === tab.view ? 0 : -1}
                    onClick={() => navigate(tab.view)}
                  >
                    <Icon name={tab.icon} />
                    {tab.label}
                  </button>
                </Fragment>
              ))}
            </div>
            <span className="scope-label">{scopeLabel}</span>
          </div>
        )}
        <div className="workspace-scroll">
          {error && !(mobile && smallScreen) && (
            <Alert theme="error" message={error} />
          )}
          <div
            className="content-width"
            id="workspace-panel"
            role={showTabs ? 'tabpanel' : undefined}
            aria-labelledby={showTabs ? 'view-' + activeView : undefined}
            tabIndex={showTabs ? 0 : undefined}
          >
            {view !== 'repos' &&
              view !== 'capabilities' &&
              view !== 'audit' &&
              requirements.isError && (
                <div className="inline-feedback" role="alert">
                  <Alert theme="error" message={requirements.error.message} />
                  <Button
                    tag="button"
                    variant="outline"
                    loading={requirements.isFetching}
                    onClick={() => void requirements.refetch()}
                  >
                    重试读取需求列表
                  </Button>
                </div>
              )}
            {view === 'members' ? (
              <MembersPage
                key={project.id + userId}
                projectId={project.id}
                userId={userId}
              />
            ) : view === 'capabilities' ? (
              <CapabilityTemplates
                key={project.id + userId}
                projectId={project.id}
              />
            ) : view === 'repos' ? (
              <RepositoriesPage key={project.id} projectId={project.id} />
            ) : view === 'audit' ? (
              <ProjectAudit
                key={JSON.stringify([
                  project.id,
                  userId,
                  sessionId,
                  project.roles.includes('project_admin'),
                ])}
                projectId={project.id}
                userId={userId}
                loginId={sessionId}
                canReadAccessAudit={project.roles.includes('project_admin')}
                crossProjectLoginId={
                  nativeTab.login.userId === userId &&
                  nativeTab.login.sessionId === sessionId
                    ? nativeTab.login.sessionId
                    : undefined
                }
              />
            ) : importing ? (
              requirements.isPending ? (
                <Loading text="正在核对导入权限" />
              ) : importAuthorized ? (
                <RequirementImport
                  key={JSON.stringify([sessionId, userId, project.id])}
                  projectId={project.id}
                  userId={userId}
                  sessionId={sessionId}
                  onProtectedChange={setProtectedForm}
                  onClose={() => navigate('requirements', '')}
                  onOpen={(id) => navigate('overview', id)}
                  onCreated={() =>
                    void client.invalidateQueries({
                      queryKey: ['requirements', project.id],
                    })
                  }
                />
              ) : (
                <Alert
                  theme="warning"
                  message="当前项目权限不可用，请核对后再批量导入。"
                />
              )
            ) : view === 'create' ? (
              <RequirementForm
                key={project.id + ':' + userId}
                project={project}
                userId={userId}
                onProtectedChange={setProtectedForm}
                onClose={() => navigate('requirements', '')}
                onCreated={async (id) => {
                  void client.invalidateQueries({
                    queryKey: ['requirements', project.id],
                  });
                  setProtectedForm(false);
                  setSearch({
                    project: project.id,
                    view: 'overview',
                    requirement: id,
                  });
                  setMobile(false);
                }}
              />
            ) : demandView ? (
              showTabs ? (
                view === 'trace' ? (
                  <SessionTrace
                    key={`${userId}:${sessionId}:${project.id}:${selected}`}
                    userId={userId}
                    sessionId={sessionId}
                    observedLogin={nativeTab.login}
                    projectId={project.id}
                    requirementId={selected}
                  />
                ) : (
                  <RequirementPage
                    key={selected}
                    id={selected}
                    view={view}
                    userId={userId}
                    sessionId={sessionId}
                    projectId={project.id}
                    nativeTab={nativeTab}
                  />
                )
              ) : requirements.isPending ? (
                <Loading text="正在核对需求归属" />
              ) : (
                !traceAccessFailed && (
                  <div className="inline-feedback">
                    <Alert
                      theme="warning"
                      message="无法在当前项目打开此需求，请核对项目与需求权限。"
                    />
                    <Button
                      tag="button"
                      onClick={() => navigate('requirements', '')}
                    >
                      返回需求列表
                    </Button>
                  </div>
                )
              )
            ) : (
              <>
                <div className="page-heading core-page-heading">
                  <div>
                    <h1>需求管理</h1>
                    <p className="muted">
                      {project.name} · 按需求查看进展、分派与会话。
                    </p>
                  </div>
                  {requirements.data?.canCreate && (
                    <div className="form-actions">
                      <Button
                        tag="button"
                        variant="outline"
                        onClick={() => {
                          if (protectedForm) return;
                          setSearch({
                            project: project.id,
                            view: 'requirements',
                            panel: 'import',
                          });
                          setMobile(false);
                        }}
                      >
                        批量导入
                      </Button>
                      <Button
                        tag="button"
                        onClick={() => navigate('create', '')}
                      >
                        <Icon name="plus" />
                        创建需求
                      </Button>
                    </div>
                  )}
                </div>
                <div className="list-toolbar">
                  <label htmlFor="requirement-filter">筛选需求列表</label>
                  <input
                    id="requirement-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="按需求标题筛选"
                  />
                  {filter && (
                    <Button
                      tag="button"
                      variant="text"
                      onClick={() => setFilter('')}
                    >
                      清除筛选
                    </Button>
                  )}
                </div>
                <section className="list-panel">
                  <div className="panel-heading">
                    <h2>需求列表</h2>
                    <span className="muted">
                      {requirements.data
                        ? `${filtered.length} / ${requirements.data.requirements.length} 项`
                        : '—'}
                    </span>
                  </div>
                  {requirements.isPending ? (
                    <Loading text="正在读取需求" />
                  ) : requirements.isError ? null : filtered.length ? (
                    <table className="requirement-table" aria-label="需求列表">
                      <colgroup>
                        <col className="requirement-id-column" />
                        <col />
                        <col className="requirement-stage-column" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col">编号</th>
                          <th scope="col">需求</th>
                          <th scope="col">阶段</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((r) => (
                          <tr key={r.id} className="requirement-row">
                            <td>
                              <code className="record-id" title={r.id}>
                                {r.id.slice(0, 8)}
                              </code>
                            </td>
                            <td>
                              <button
                                className="requirement-open"
                                aria-label={'查看需求 ' + r.title}
                                onClick={() => navigate('overview', r.id)}
                              >
                                <Icon name="file" />
                                <span>
                                  <strong>{r.title}</strong>
                                  <small>
                                    {r.description || '尚未填写需求说明'}
                                  </small>
                                </span>
                              </button>
                            </td>
                            <td>
                              <span className="pill brand-pill">
                                {stageLabels[r.stage]}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="empty-state">
                      <Icon name="folder" />
                      <h3>{filter ? '没有匹配的需求' : '从一个需求开始'}</h3>
                      <p>
                        {filter
                          ? '调整或清除筛选条件，查看其他需求。'
                          : '需求创建后，子任务、分派和会话会集中在这里。'}
                      </p>
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
        <footer className="statusbar">
          <span>
            <Icon name="folder" />
            {project.name}
          </span>
          <span>
            <Icon name="eye" />
            只读分析 · 本地功能验证
          </span>
        </footer>
      </div>
    </main>
  );
}
