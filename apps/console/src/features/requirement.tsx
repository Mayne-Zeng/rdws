import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  stageLabels,
  taskStatusLabels,
  type Stage,
  type TaskStatus,
  type RequirementDetail,
  type BusinessCommand,
  type TaskRecord,
} from '@rdws/contracts';
import { Icon, api, roleLabels } from '../lib/ui.tsx';
import { Conversation } from './conversation.tsx';
import { RequirementWorktrees } from './requirement-worktrees.tsx';
import { RequirementTemplate } from './requirement-template.tsx';
import type { View } from './project.tsx';
const stages = Object.keys(stageLabels) as Stage[];
export function RequirementPage({
  id,
  view,
  userId,
  sessionId,
  projectId,
}: {
  id: string;
  view: View;
  userId: string;
  sessionId: string;
  projectId: string;
}) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ['requirement', id],
    queryFn: ({ signal }) =>
      api<RequirementDetail>(`/api/requirements/${id}`, { signal }),
    refetchInterval: 2000,
  });
  const [editing, setEditing] = useState<TaskRecord | 'new'>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef(false),
    retry = useRef<BusinessCommand | undefined>(undefined),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function mutate(body: BusinessCommand) {
    if (pending.current) return;
    pending.current = true;
    retry.current = body;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api<{ changed: boolean }>(
        `/api/requirements/${id}/commands`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!live.current) return;
      retry.current = undefined;
      setUncertain(false);
      setEditing(undefined);
      setNotice(
        r.changed
          ? '已保存，需求会话将在下一步使用最新信息。'
          : '当前已是该状态。',
      );
      await client.invalidateQueries({ queryKey: ['requirement', id] });
      await client.invalidateQueries({ queryKey: ['requirements'] });
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        setUncertain((e as { resultUnknown?: boolean }).resultUnknown === true);
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  if (detail.isPending) return <Loading text="正在读取需求档案" />;
  if (detail.isError)
    return (
      <div className="inline-feedback" role="alert">
        <Alert theme="error" message={detail.error.message} />
        <Button
          tag="button"
          variant="outline"
          loading={detail.isFetching}
          onClick={() => void detail.refetch()}
        >
          重试读取需求档案
        </Button>
      </div>
    );
  const data = detail.data,
    r = data.requirement,
    names = new Map(data.participants.map((p) => [p.id, p.name])),
    next = stages[stages.indexOf(r.stage) + 1];
  const reached = new Set(data.reachedStages);
  const stage = (value: Stage) =>
    void mutate({
      commandId: crypto.randomUUID(),
      type: 'requirement.stage',
      stage: value,
    });
  if (editing)
    return (
      <TaskForm
        key={editing === 'new' ? 'new' : editing.id}
        value={editing === 'new' ? undefined : editing}
        data={data}
        busy={busy}
        error={error}
        uncertain={uncertain}
        onRetry={() => retry.current && void mutate(retry.current)}
        onClose={() => setEditing(undefined)}
        onSave={(patch, commandId) => {
          if (editing === 'new')
            void mutate({
              commandId,
              type: 'task.create',
              task: patch as {
                title: string;
                assigneeId: string;
                description: string;
                acceptance: string;
              },
            });
          else
            void mutate({
              commandId,
              type: 'task.update',
              taskId: editing.id,
              patch,
            });
        }}
      />
    );
  const overview = view !== 'chat' && view !== 'context';
  return (
    <>
      {overview && (
        <div className="page-heading core-page-heading">
          <div>
            <h1>需求档案</h1>
            <p className="muted">
              查看需求阶段、验收标准、成员分派和最近活动。
            </p>
          </div>
        </div>
      )}
      <div
        className={
          overview
            ? 'requirement-summary-card'
            : 'page-heading core-page-heading'
        }
      >
        <div>
          {overview ? (
            <>
              <code className="record-id" title={r.id}>
                {r.id.slice(0, 8)}
              </code>
              <h2>{r.title}</h2>
            </>
          ) : (
            <h1>{r.title}</h1>
          )}
          <div className="heading-meta">
            <span className="pill brand-pill" data-testid="current-stage">
              {stageLabels[r.stage]}
            </span>
            <span>开发负责人 · {names.get(r.leadId) ?? '未命名成员'}</span>
          </div>
        </div>
        {view === 'overview' && data.permissions.canChangeStage && (
          <div className="stage-actions">
            <select
              aria-label="调整阶段"
              value={r.stage}
              onChange={(e) => stage(e.target.value as Stage)}
              disabled={busy}
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s === r.stage ? '当前 · ' : ''}
                  {stageLabels[s]}
                </option>
              ))}
            </select>
            {next && (
              <Button tag="button" onClick={() => stage(next)} loading={busy}>
                进入{stageLabels[next]}
                <Icon name="arrow" />
              </Button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="inline-feedback">
          <Alert theme="error" message={error} />
          {retry.current && (
            <Button
              tag="button"
              variant="outline"
              onClick={() => void mutate(retry.current!)}
              loading={busy}
            >
              重试原操作
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className="save-notice" role="status">
          <Icon name="check" />
          {notice}
        </p>
      )}
      {view === 'chat' ? (
        <Conversation requirementId={id} />
      ) : view === 'context' ? (
        <section className="context-page" data-testid="context-summary">
          <p className="muted context-explanation">
            每个新推理步骤读取当前业务信息；已开始的回复沿用原上下文。
          </p>
          <div className="context-grid">
            <section className="info-panel">
              <div className="panel-heading">
                <h2>当前需求上下文</h2>
                <span className="pill">只读快照</span>
              </div>
              <dl className="detail-grid">
                <dt>需求描述</dt>
                <dd className="prose-text">{r.description || '尚未填写'}</dd>
                <dt>验收标准</dt>
                <dd className="prose-text">{r.acceptance || '尚未填写'}</dd>
              </dl>
            </section>
            <section className="info-panel">
              <div className="panel-heading">
                <h2>分派与工作区</h2>
              </div>
              <dl className="detail-grid">
                <dt>当前阶段</dt>
                <dd>{stageLabels[r.stage]}</dd>
                <dt>开发负责人</dt>
                <dd>{names.get(r.leadId) ?? '未命名成员'}</dd>
                <dt>工作区能力</dt>
                <dd>只读分析</dd>
              </dl>
            </section>
          </div>
          <RequirementTemplate
            key={JSON.stringify([sessionId, userId, projectId, id])}
            id={id}
            userId={userId}
            sessionId={sessionId}
            projectId={projectId}
          />
          <section className="document-section info-panel context-tasks">
            <div className="panel-heading">
              <h2>子任务与当前分派</h2>
              <span className="muted">{data.tasks.length} 项</span>
            </div>
            {data.tasks.map((t) => (
              <div key={t.id} className="context-task">
                <strong>{t.title}</strong>
                <span>
                  {names.get(t.assigneeId)} · {taskStatusLabels[t.status]}
                </span>
              </div>
            ))}
            {!data.tasks.length && (
              <p className="muted context-empty">暂无子任务。</p>
            )}
          </section>
        </section>
      ) : (
        <>
          <RequirementWorktrees id={id} />
          <section className="flow-panel">
            <div className="panel-heading">
              <h2>主线流程</h2>
              <span className="flow-title">需求研发流程</span>
              <span
                className="flow-position"
                aria-label={
                  '当前阶段位置，第 ' +
                  (stages.indexOf(r.stage) + 1) +
                  ' 步，共 ' +
                  stages.length +
                  ' 步'
                }
              >
                {stages.indexOf(r.stage) + 1} / {stages.length}
                <progress
                  aria-hidden="true"
                  value={stages.indexOf(r.stage) + 1}
                  max={stages.length}
                />
              </span>
            </div>
            <ol className="flow-track">
              {stages.map((s, i) => (
                <li
                  key={s}
                  className={
                    r.stage === s ? 'current' : reached.has(s) ? 'visited' : ''
                  }
                >
                  <span className="flow-dot">{i + 1}</span>
                  <strong>{stageLabels[s]}</strong>
                  <small>
                    {r.stage === s
                      ? '当前阶段'
                      : reached.has(s)
                        ? '曾到达'
                        : '未经历'}
                  </small>
                </li>
              ))}
            </ol>
            <p className="flow-note">
              <Icon name="eye" />
              阶段记录由开发负责人推进，测试结果与合入事实单独记录。
            </p>
          </section>
          <section className="document-section">
            <h2>基本信息</h2>
            <div className="info-panel">
              <dl className="detail-grid requirement-facts">
                <dt>开发负责人</dt>
                <dd>{names.get(r.leadId) ?? '未命名成员'}</dd>
                <dt>当前阶段</dt>
                <dd>{stageLabels[r.stage]}</dd>
                <dt>需求说明</dt>
                <dd className="prose-text">{r.description || '尚未填写'}</dd>
                <dt>验收标准</dt>
                <dd className="prose-text">{r.acceptance || '尚未填写'}</dd>
                <dt>参与成员</dt>
                <dd>
                  {data.participants.map((p) => (
                    <span key={p.id} className="member-pill">
                      {p.name}
                      <small>
                        {p.roles.map((x) => roleLabels[x] ?? x).join(' / ')}
                      </small>
                    </span>
                  ))}
                </dd>
              </dl>
            </div>
          </section>
          <section className="document-section">
            <div className="section-heading">
              <div>
                <h2>子任务与分派</h2>
                <p className="muted">
                  一个任务由一位开发成员负责，围绕同一需求协作。
                </p>
              </div>
              {data.permissions.canManageTasks && (
                <Button
                  tag="button"
                  variant="outline"
                  onClick={() => setEditing('new')}
                  disabled={busy}
                >
                  <Icon name="plus" />
                  新增子任务
                </Button>
              )}
            </div>
            <div className="task-list">
              {data.tasks.map((t) => (
                <div className="task-row" key={t.id} data-testid="task-row">
                  <span className={'task-state ' + t.status}>
                    <Icon name={t.status === 'done' ? 'check' : 'file'} />
                  </span>
                  <div className="task-text">
                    <strong>{t.title}</strong>
                    <small>{t.description || '暂无任务说明'}</small>
                  </div>
                  <span className="task-owner">
                    <span className="avatar small">
                      {(names.get(t.assigneeId) ?? '?')
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    {names.get(t.assigneeId)}
                  </span>
                  {data.permissions.canManageTasks ||
                  (data.permissions.canUpdateOwnTasks &&
                    t.assigneeId === data.permissions.userId) ? (
                    <select
                      aria-label={t.title + ' 状态'}
                      value={t.status}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate({
                          commandId: crypto.randomUUID(),
                          type: 'task.update',
                          taskId: t.id,
                          patch: { status: e.target.value as TaskStatus },
                        })
                      }
                    >
                      {Object.entries(taskStatusLabels).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="pill">{taskStatusLabels[t.status]}</span>
                  )}
                  {data.permissions.canManageTasks && (
                    <Button
                      tag="button"
                      variant="text"
                      aria-label={'编辑子任务 ' + t.title}
                      onClick={() => setEditing(t)}
                      disabled={busy}
                    >
                      编辑
                    </Button>
                  )}
                </div>
              ))}
              {!data.tasks.length && (
                <div className="empty-state compact">
                  <p>尚未拆分子任务，开发负责人可随时补充。</p>
                </div>
              )}
            </div>
          </section>
          <section className="document-section">
            <div className="section-heading">
              <h2>最近活动</h2>
              <span className="muted">分派与状态变更留痕</span>
            </div>
            <div className="activity-list">
              {data.events.slice(0, 12).map((e) => (
                <div key={e.id} className="activity-row">
                  <Icon name="clock" />
                  <div>
                    <strong>
                      {names.get(e.actorId) ??
                        (e.source === 'migration' ? '初始化' : '成员')}
                    </strong>
                    <span>
                      {e.kind === 'requirement.stage'
                        ? ` 将阶段从「${stageLabels[e.before as Stage] ?? String(e.before)}」调整至「${stageLabels[e.after as Stage] ?? String(e.after)}」`
                        : e.kind === 'task.created'
                          ? ' 创建了子任务'
                          : e.kind === 'task.updated'
                            ? ' 更新了子任务与分派'
                            : e.kind === 'requirement.created'
                              ? ' 创建了需求与初始分工'
                              : ' 初始化需求阶段'}
                    </span>
                  </div>
                  <time>
                    {new Date(e.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
function TaskForm({
  value,
  data,
  busy,
  error,
  uncertain,
  onRetry,
  onClose,
  onSave,
}: {
  value?: TaskRecord;
  data: RequirementDetail;
  busy: boolean;
  error: string;
  uncertain: boolean;
  onRetry: () => void;
  onClose: () => void;
  onSave: (
    patch: {
      title?: string;
      description?: string;
      acceptance?: string;
      assigneeId?: string;
    },
    commandId: string,
  ) => void;
}) {
  const [title, setTitle] = useState(value?.title ?? ''),
    [description, setDescription] = useState(value?.description ?? ''),
    [acceptance, setAcceptance] = useState(value?.acceptance ?? ''),
    [assigneeId, setAssigneeId] = useState(
      value?.assigneeId ?? data.requirement.leadId,
    );
  const intentId = useRef(crypto.randomUUID());
  function submit(e: FormEvent) {
    e.preventDefault();
    const all = { title, description, acceptance, assigneeId };
    const patch = value
      ? Object.fromEntries(
          Object.entries(all).filter(
            ([k, v]) => v !== value[k as keyof TaskRecord],
          ),
        )
      : all;
    if (Object.keys(patch).length) onSave(patch, intentId.current);
    else onClose();
  }
  return (
    <section className="inline-panel">
      <Button tag="button" variant="text" onClick={onClose} disabled={busy}>
        返回需求档案
      </Button>
      <div className="page-heading">
        <h1>{value ? '编辑子任务' : '新增子任务'}</h1>
      </div>
      <form className="business-form" onSubmit={submit}>
        <fieldset
          className="form-section task-fields"
          disabled={busy || uncertain}
        >
          <label htmlFor="task-title">任务标题</label>
          <input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            required
          />
          <label htmlFor="task-description">任务描述</label>
          <textarea
            id="task-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={8000}
            rows={4}
          />
          <label htmlFor="task-acceptance">任务验收标准</label>
          <textarea
            id="task-acceptance"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            maxLength={8000}
            rows={3}
          />
          <label htmlFor="task-owner">任务负责人</label>
          <select
            id="task-owner"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            {data.participants
              .filter((p) => p.eligibleDeveloper)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </fieldset>
        {error && (
          <div className="inline-feedback">
            <Alert theme="error" message={error} />
            <Button
              tag="button"
              variant="outline"
              onClick={onRetry}
              loading={busy}
            >
              重试原操作
            </Button>
          </div>
        )}
        <div className="form-actions">
          <Button
            tag="button"
            type="submit"
            loading={busy}
            disabled={!title.trim() || !assigneeId || uncertain}
          >
            保存子任务
          </Button>
          <Button
            tag="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
        </div>
      </form>
    </section>
  );
}
