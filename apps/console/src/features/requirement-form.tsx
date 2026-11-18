import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Loading } from 'tdesign-react';
import { Icon, api, roleLabels } from '../lib/ui.tsx';
import type { Project } from './project.tsx';
export function RequirementForm({
  project,
  onProtectedChange,
  onClose,
  onCreated,
}: {
  project: Project;
  onProtectedChange: (value: boolean) => void;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [acceptance, setAcceptance] = useState(''),
    [leadId, setLeadId] = useState('');
  const [participants, setParticipants] = useState<Record<string, string[]>>(
      {},
    ),
    [tasks, setTasks] = useState<
      { key: string; title: string; assigneeId?: string }[]
    >([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const running = useRef(false),
    live = useRef(true),
    commandId = useRef(crypto.randomUUID()),
    payload = useRef<string | undefined>(undefined);
  useEffect(() => {
    onProtectedChange(busy || uncertain);
  }, [busy, uncertain, onProtectedChange]);
  useEffect(() => () => onProtectedChange(false), [onProtectedChange]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const members = useQuery({
    queryKey: ['members', project.id],
    queryFn: ({ signal }) =>
      api<{ members: { id: string; name: string; role: string }[] }>(
        `/api/projects/${project.id}/members`,
        { signal },
      ),
  });
  const developers =
    members.data?.members.filter((m) => m.role === 'developer') ?? [];
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    payload.current ??= JSON.stringify({
      commandId: commandId.current,
      title,
      description,
      acceptance,
      leadId,
      participants: Object.entries(participants)
        .filter(([, r]) => r.length)
        .map(([userId, roles]) => ({ userId, roles })),
      tasks: tasks.map((t) => ({
        title: t.title,
        ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
      })),
    });
    try {
      const result = await api<{ id: string }>(
        `/api/projects/${project.id}/requirements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload.current,
        },
      );
      if (live.current) {
        setUncertain(false);
        await onCreated(result.id);
      }
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        const unknown =
          (e as { resultUnknown?: boolean }).resultUnknown === true;
        setUncertain((current) => current || unknown);
        if (!uncertain && !unknown) {
          payload.current = undefined;
          commandId.current = crypto.randomUUID();
        }
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="inline-panel requirement-editor">
      <Button
        tag="button"
        variant="text"
        onClick={onClose}
        disabled={busy || uncertain}
      >
        返回需求列表
      </Button>
      <div className="page-heading core-page-heading">
        <div>
          <h1>新建需求</h1>
          <p className="muted">
            明确需求、参与成员与初始分工，随后进入需求工作区。
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="business-form">
        <fieldset className="form-fields" disabled={busy || uncertain}>
          <div className="form-section">
            <h2>需求信息</h2>
            <label htmlFor="requirement-title">需求标题</label>
            <Input
              ref={(n) => {
                if (n) n.inputElement.id = 'requirement-title';
              }}
              value={title}
              disabled={busy || uncertain}
              onChange={setTitle}
              maxlength={160}
              placeholder="简要描述需要完成的事"
            />
            <label htmlFor="requirement-description">需求描述</label>
            <textarea
              id="requirement-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={8000}
              rows={4}
            />
            <label htmlFor="requirement-acceptance">验收标准</label>
            <textarea
              id="requirement-acceptance"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              maxLength={8000}
              rows={3}
            />
          </div>
          <div className="form-section">
            <h2>成员与分派</h2>
            <label htmlFor="requirement-lead">开发负责人</label>
            <select
              id="requirement-lead"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              required
            >
              <option value="">请选择</option>
              {developers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <fieldset className="member-options">
              <legend>其他参与成员</legend>
              {members.data?.members.map((m) => (
                <label key={m.id + ':' + m.role}>
                  <input
                    type="checkbox"
                    checked={participants[m.id]?.includes(m.role) ?? false}
                    onChange={(e) =>
                      setParticipants((current) => ({
                        ...current,
                        [m.id]: e.target.checked
                          ? [...(current[m.id] ?? []), m.role]
                          : (current[m.id] ?? []).filter((r) => r !== m.role),
                      }))
                    }
                  />
                  {m.name} · {roleLabels[m.role]}
                </label>
              ))}
            </fieldset>
            {members.isPending && <Loading text="正在读取项目成员" />}
          </div>
          <div className="form-section">
            <div className="panel-heading">
              <h2>初始子任务</h2>
              <Button
                tag="button"
                variant="outline"
                onClick={() =>
                  setTasks([...tasks, { key: crypto.randomUUID(), title: '' }])
                }
              >
                <Icon name="plus" />
                添加初始子任务
              </Button>
            </div>
            <p className="muted">
              可稍后由开发负责人补充，未指定负责人时默认由其负责。
            </p>
            {tasks.map((t, i) => (
              <div key={t.key} className="initial-task">
                <label htmlFor={'initial-' + t.key}>子任务标题 {i + 1}</label>
                <input
                  id={'initial-' + t.key}
                  value={t.title}
                  onChange={(e) =>
                    setTasks(
                      tasks.map((x) =>
                        x.key === t.key ? { ...x, title: e.target.value } : x,
                      ),
                    )
                  }
                  maxLength={160}
                  required
                />
                <label className="sr-only" htmlFor={'initial-owner-' + t.key}>
                  子任务负责人 {i + 1}
                </label>
                <select
                  id={'initial-owner-' + t.key}
                  value={t.assigneeId ?? ''}
                  onChange={(e) =>
                    setTasks(
                      tasks.map((x) =>
                        x.key === t.key
                          ? { ...x, assigneeId: e.target.value || undefined }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="">默认 · 开发负责人</option>
                  {developers
                    .filter(
                      (m) =>
                        m.id === leadId ||
                        participants[m.id]?.includes('developer'),
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
                <Button
                  tag="button"
                  variant="text"
                  onClick={() => setTasks(tasks.filter((x) => x.key !== t.key))}
                  aria-label={'移除初始子任务 ' + (i + 1)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        </fieldset>
        {members.isError && (
          <div className="inline-feedback" role="alert">
            <Alert theme="error" message={members.error.message} />
            <Button
              tag="button"
              variant="outline"
              loading={members.isFetching}
              onClick={() => void members.refetch()}
            >
              重试读取项目成员
            </Button>
          </div>
        )}
        {uncertain && (
          <p className="muted" role="status">
            创建结果尚未确认，已保留本次内容。请重试原操作核对结果；刷新或离开页面会丢失本地核对信息。
          </p>
        )}
        {error && <Alert theme="error" message={error} />}
        {uncertain && (
          <Button
            tag="button"
            variant="outline"
            loading={busy}
            onClick={() => void submit()}
          >
            重试原操作
          </Button>
        )}
        <div className="form-actions">
          <Button
            tag="button"
            type="submit"
            loading={busy}
            disabled={
              uncertain ||
              members.isError ||
              !title.trim() ||
              !leadId ||
              tasks.some((t) => !t.title.trim())
            }
          >
            创建需求
          </Button>
          <Button
            tag="button"
            variant="outline"
            onClick={onClose}
            disabled={busy || uncertain}
          >
            取消
          </Button>
        </div>
      </form>
    </section>
  );
}
