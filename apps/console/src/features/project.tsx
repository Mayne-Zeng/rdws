import { useState } from 'react';
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
import { RequirementPage } from './requirement.tsx';
export type View = 'requirements' | 'overview' | 'chat' | 'context' | 'create';
export type Project = ProjectList['projects'][number];
export function ProjectWorkspace({
  projects,
  username,
  logout,
  logoutBusy,
  error,
}: {
  projects: Project[];
  username: string;
  logout: () => void;
  logoutBusy: boolean;
  error: string;
}) {
  const [search, setSearch] = useSearchParams();
  const project =
    projects.find((p) => p.id === search.get('project')) ?? projects[0]!;
  const selected = search.get('requirement') ?? '';
  const current = search.get('view');
  const view: View = ['overview', 'chat', 'context', 'create'].includes(
    current ?? '',
  )
    ? (current as View)
    : 'requirements';
  const [mobile, setMobile] = useState(false),
    [filter, setFilter] = useState('');
  const client = useQueryClient();
  const requirements = useQuery({
    queryKey: ['requirements', project.id],
    queryFn: ({ signal }) =>
      api<{ requirements: RequirementSummary[]; canCreate: boolean }>(
        `/api/projects/${project.id}/requirements`,
        { signal },
      ),
    refetchInterval: 2000,
  });
  function navigate(next: View, id = selected) {
    setSearch({
      project: project.id,
      view: next,
      ...(id ? { requirement: id } : {}),
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
  return (
    <main className={'shell workspace-shell' + (mobile ? ' rail-open' : '')}>
      <aside className="rail">
        <div className="rail-head">
          <a href="/" className="brand">
            <span className="brand-mark">
              <Icon name="layers" />
            </span>
            <strong>RDWS</strong>
            <span>研发工作台</span>
          </a>
          {requirements.data?.canCreate && (
            <Button block onClick={() => navigate('create', '')}>
              <Icon name="plus" />
              <span>新建需求</span>
            </Button>
          )}
        </div>
        <nav aria-label="项目导航" className="rail-nav">
          <button
            className={'nav-item' + (view === 'requirements' ? ' active' : '')}
            onClick={() => navigate('requirements', '')}
          >
            <Icon name="grid" />
            <span>需求管理</span>
            <span className="count">
              {requirements.data?.requirements.length ?? 0}
            </span>
          </button>
        </nav>
        <div className="project-card">
          <Icon name="folder" />
          <div>
            <strong>{project.name}</strong>
            <span>
              {project.roles.map((r) => roleLabels[r] ?? r).join(' / ')}
            </span>
          </div>
          {projects.length > 1 && (
            <select
              aria-label="切换项目"
              value={project.id}
              onChange={(e) => {
                setSearch({ project: e.target.value, view: 'requirements' });
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
        </div>
        <div className="tree-heading">
          <span>当前需求</span>
          <span>{requirements.data?.requirements.length ?? 0}</span>
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
          {filtered.map((r, i) => (
            <button
              key={r.id}
              aria-label={r.title}
              className={
                'demand-item' +
                (r.id === selected && view !== 'create' ? ' active' : '')
              }
              onClick={() =>
                navigate(view === 'chat' ? 'chat' : 'overview', r.id)
              }
            >
              <span className="demand-icon">
                <Icon name="file" />
              </span>
              <span className="demand-text">
                <strong>{r.title}</strong>
                <small>
                  {stageLabels[r.stage]}
                  <span className="tree-dot">·</span>需求 {i + 1}
                </small>
              </span>
            </button>
          ))}
          {!filtered.length && !requirements.isPending && (
            <p className="rail-empty">
              {filter ? '没有匹配的需求' : '暂无可访问需求'}
            </p>
          )}
        </div>
        <div className="rail-foot">
          <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{username}</strong>
            <small>
              {project.roles.map((r) => roleLabels[r] ?? r).join(' / ')}
            </small>
          </div>
          <Button
            variant="text"
            size="small"
            onClick={logout}
            loading={logoutBusy}
            aria-label="退出登录"
          >
            退出登录
          </Button>
        </div>
      </aside>
      {mobile && (
        <button
          className="rail-scrim"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="workspace-main">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="打开导航"
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
            <div className="top-title">{summary?.title ?? '需求管理'}</div>
          </div>
          <span className="pill local-badge">
            <span className="status-dot" />
            本地 PoC
          </span>
        </header>
        {selected && view !== 'create' && (
          <div className="workspace-tabs">
            <div role="tablist" aria-label="工作区视图">
              <button
                role="tab"
                aria-selected={view === 'chat'}
                onClick={() => navigate('chat')}
              >
                <Icon name="chat" />
                对话
              </button>
              <span className="tab-divider" />
              <button
                role="tab"
                aria-selected={view === 'overview'}
                onClick={() => navigate('overview')}
              >
                <Icon name="grid" />
                需求档案
              </button>
              <button
                role="tab"
                aria-selected={view === 'context'}
                onClick={() => navigate('context')}
              >
                <Icon name="layers" />
                上下文
              </button>
            </div>
            <span className="scope-label">
              {view === 'chat' ? '会话视图' : '需求级'}
            </span>
          </div>
        )}
        <div className="workspace-scroll">
          {error && <Alert theme="error" message={error} />}
          <div className="content-width">
            {requirements.isError && (
              <Alert theme="error" message={requirements.error.message} />
            )}
            {view === 'create' ? (
              <RequirementForm
                key={project.id}
                project={project}
                onClose={() => navigate('requirements', '')}
                onCreated={async (id) => {
                  void client.invalidateQueries({
                    queryKey: ['requirements', project.id],
                  });
                  navigate('overview', id);
                }}
              />
            ) : selected ? (
              <RequirementPage
                key={selected}
                id={selected}
                view={view}
                onView={navigate}
              />
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{project.name}</h1>
                    <p className="muted">
                      按需求组织研发进展，让每次协作都有清楚的上下文。
                    </p>
                  </div>
                  {requirements.data?.canCreate && (
                    <Button
                      variant="outline"
                      onClick={() => navigate('create', '')}
                    >
                      创建需求
                    </Button>
                  )}
                </div>
                <section className="list-panel">
                  <div className="panel-heading">
                    <h2>需求列表</h2>
                    <span className="muted">
                      {requirements.data?.requirements.length ?? 0} 项
                    </span>
                  </div>
                  {requirements.isPending ? (
                    <Loading text="正在读取需求" />
                  ) : filtered.length ? (
                    <div className="requirement-rows">
                      {filtered.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => navigate('overview', r.id)}
                          className="requirement-row"
                        >
                          <Icon name="file" />
                          <span>
                            <strong>{r.title}</strong>
                            <small>{r.description || '尚未填写需求说明'}</small>
                          </span>
                          <span className="pill brand-pill">
                            {stageLabels[r.stage]}
                          </span>
                          <Icon name="arrow" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Icon name="folder" />
                      <h3>从一个需求开始</h3>
                      <p>需求创建后，子任务、分派和会话会集中在这里。</p>
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
