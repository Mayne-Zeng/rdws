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
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { Icon, api, roleLabels } from '../lib/ui.tsx';
import { Conversation, type NativeTab } from './conversation.tsx';
import { RequirementWorktrees } from './requirement-worktrees.tsx';
import { RequirementTemplate } from './requirement-template.tsx';
import { RequirementPersonnel } from './requirement-personnel.tsx';
import {
  RequirementDetailsEditor,
  detailFieldLabels,
} from './requirement-details-editor.tsx';
import type { View } from './project.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';
const stages = Object.keys(stageLabels) as Stage[];
function assignmentOf(value: unknown) {
  if (!value || typeof value !== 'object' || !('assigneeId' in value))
    return undefined;
  return typeof value.assigneeId === 'string' ? value.assigneeId : undefined;
}
export function RequirementPage({
  id,
  view,
  userId,
  sessionId,
  projectId,
  nativeTab,
}: {
  id: string;
  view: View;
  userId: string;
  sessionId: string;
  projectId: string;
  nativeTab: NativeTab;
}) {
  const client = useQueryClient();
  const detailsScope = JSON.stringify([sessionId, userId, projectId, id]);
  const detail = useQuery({
    queryKey: ['requirement', id, sessionId, userId, projectId],
    queryFn: ({ signal }) =>
      api<RequirementDetail>(`/api/requirements/${id}`, {
        signal,
        headers: { [OBSERVED_LOGIN_HEADER]: sessionId },
      }),
    refetchInterval: WORKBENCH_POLL_INTERVAL_MS,
    refetchOnMount: 'always',
  });
  const [detailsReceipt, setDetailsReceipt] = useState<{
    scope: string;
    changed: boolean;
  }>();
  const [personnelReceipt, setPersonnelReceipt] = useState<{
    scope: string;
    text: string;
    saved?: boolean;
  }>();
  const status = (detail.error as { status?: number } | null)?.status;
  const editAuthorityLost =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    (detail.isSuccess &&
      detail.isFetchedAfterMount &&
      (!detail.data.permissions.canEditDetails ||
        detail.data.permissions.userId !== userId));
  useEffect(() => {
    if (editAuthorityLost || view !== 'overview') {
      setDetailsReceipt(undefined);
      setPersonnelReceipt(undefined);
    }
  }, [editAuthorityLost, view]);
  const receiptNotice = view === 'overview' &&
    !editAuthorityLost &&
    detailsReceipt?.scope === detailsScope && (
      <p className="save-notice" role="status">
        {detailsReceipt.changed
          ? '原保存已确认。'
          : '原保存已确认，资料未发生变化。'}
      </p>
    );
  const personnelNotice = view === 'overview' &&
    !editAuthorityLost &&
    personnelReceipt?.scope === detailsScope && (
      <p
        className={personnelReceipt.saved ? 'save-notice' : 'muted'}
        role="status"
      >
        {personnelReceipt.text}
      </p>
    );
  const [editing, setEditing] = useState<TaskRecord | 'new'>(),
    [openingStatus, setOpeningStatus] = useState<TaskStatus>(),
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
      setOpeningStatus(undefined);
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
      <>
        {receiptNotice}
        {personnelNotice}
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
      </>
    );
  const data = detail.data,
    r = data.requirement,
    names = new Map([
      ...Object.entries(data.assignmentNames ?? {}),
      ...data.participants.map((p): [string, string] => [p.id, p.name]),
    ]),
    next = stages[stages.indexOf(r.stage) + 1];
  const canEdit =
    detail.isFetchedAfterMount &&
    data.permissions.userId === userId &&
    data.permissions.canEditDetails;
  function taskActivity(before: unknown, after: unknown) {
    const previous = assignmentOf(before),
      current = assignmentOf(after);
    return previous && current && previous !== current
      ? ` 将子任务从「${names.get(previous) ?? '原负责人'}」改派给「${names.get(current) ?? '接手人'}」`
      : ' 更新了子任务与分派';
  }
  const refreshDetails = () =>
    Promise.all([
      detail.refetch(),
      client.invalidateQueries({ queryKey: ['requirements'] }),
    ]);
  const reached = new Set(data.reachedStages);
  const stage = (value: Stage) =>
    void mutate({
      commandId: crypto.randomUUID(),
      type: 'requirement.stage',
      stage: value,
    });
  function openTaskEditor(task: TaskRecord | 'new', status?: TaskStatus) {
    setEditing(task);
    setOpeningStatus(status);
  }
  if (editing && data.permissions.canManageTasks)
    return (
      <TaskForm
        key={editing === 'new' ? 'new' : editing.id}
        value={editing === 'new' ? undefined : editing}
        data={data}
        busy={busy}
        error={error}
        uncertain={uncertain}
        openingStatus={openingStatus}
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
        detail.isFetchedAfterMount && data.permissions.userId === userId ? (
          <Conversation
            requirementId={id}
            projectId={projectId}
            userId={userId}
            sessionId={sessionId}
            nativeTab={nativeTab}
          />
        ) : (
          <Loading text="正在核对需求会话权限" />
        )
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
              {receiptNotice}
              {personnelNotice}
              <RequirementDetailsEditor
                key={detailsScope}
                requirement={r}
                userId={userId}
                sessionId={sessionId}
                onReceipt={(receipt) =>
                  setDetailsReceipt(
                    receipt
                      ? { scope: detailsScope, changed: receipt.changed }
                      : undefined,
                  )
                }
                canEdit={canEdit}
                refresh={refreshDetails}
              />
              <RequirementPersonnel
                key={'personnel:' + detailsScope}
                data={data}
                userId={userId}
                sessionId={sessionId}
                projectId={projectId}
                canEdit={canEdit}
                refresh={refreshDetails}
                onReceipt={(text, saved) =>
                  setPersonnelReceipt(
                    text ? { scope: detailsScope, text, saved } : undefined,
                  )
                }
              />
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
                  onClick={() => openTaskEditor('new')}
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
                      onChange={(e) => {
                        const status = e.target.value as TaskStatus;
                        const reopening =
                          (t.status === 'done' || t.status === 'cancelled') &&
                          (status === 'todo' || status === 'in_progress');
                        if (
                          reopening &&
                          data.permissions.canManageTasks &&
                          !data.participants.some(
                            (person) =>
                              person.id === t.assigneeId &&
                              person.eligibleDeveloper,
                          )
                        ) {
                          openTaskEditor(t, status);
                          return;
                        }
                        void mutate({
                          commandId: crypto.randomUUID(),
                          type: 'task.update',
                          taskId: t.id,
                          patch: { status },
                        });
                      }}
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
                      onClick={() => openTaskEditor(t)}
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
                      {e.actorName ??
                        names.get(e.actorId) ??
                        (e.source === 'migration' ? '初始化' : '成员')}
                    </strong>
                    <span>
                      {e.kind === 'requirement.stage'
                        ? ` 将阶段从「${stageLabels[e.before as Stage] ?? String(e.before)}」调整至「${stageLabels[e.after as Stage] ?? String(e.after)}」`
                        : e.kind === 'requirement.details'
                          ? ` 更新了需求资料${e.changedFields?.length ? ` · ${e.changedFields.map((field) => detailFieldLabels[field]).join('、')}` : ''}`
                          : e.kind === 'requirement.personnel'
                            ? ' 变更了需求人员与分工'
                            : e.kind === 'task.created'
                              ? ' 创建了子任务'
                              : e.kind === 'task.updated'
                                ? taskActivity(e.before, e.after)
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
  openingStatus,
}: {
  value?: TaskRecord;
  data: RequirementDetail;
  busy: boolean;
  error: string;
  uncertain: boolean;
  onRetry: () => void;
  onClose: () => void;
  openingStatus?: TaskStatus;
  onSave: (
    patch: {
      title?: string;
      description?: string;
      acceptance?: string;
      assigneeId?: string;
      status?: TaskStatus;
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
  const developers = data.participants.filter(
    (person) => person.eligibleDeveloper,
  );
  const historical =
    value && !developers.some((person) => person.id === value.assigneeId);
  const eligible = developers.some((person) => person.id === assigneeId);
  const eligibleSelection =
    eligible || (!openingStatus && assigneeId === value?.assigneeId);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!eligibleSelection) return;
    const all = {
      title,
      description,
      acceptance,
      assigneeId,
      ...(openingStatus ? { status: openingStatus } : {}),
    };
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
          {openingStatus && (
            <p className="muted">
              选择有效接手人后，将任务状态改为{taskStatusLabels[openingStatus]}
              。
            </p>
          )}
          <select
            id="task-owner"
            value={
              eligible || assigneeId === value?.assigneeId ? assigneeId : ''
            }
            onChange={(e) => setAssigneeId(e.target.value)}
          >
            <option value="" disabled>
              选择有效负责人
            </option>
            {historical && (
              <option value={value.assigneeId} disabled>
                原负责人已失效
              </option>
            )}
            {developers.map((p) => (
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
            disabled={!title.trim() || !eligibleSelection || uncertain}
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
