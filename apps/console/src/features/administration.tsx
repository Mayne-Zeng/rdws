import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type {
  ManagementCommand,
  ManagementResult,
  PlatformAdministration,
  ProjectAdministration,
} from '@rdws/contracts';
import { api, roleLabels } from '../lib/ui.tsx';
import { CapabilityApprovals } from './capability-approvals.tsx';

type Intent = ManagementCommand extends infer Command
  ? Command extends ManagementCommand
    ? Omit<Command, 'commandId'>
    : never
  : never;
const memberRoles = ['requirement_manager', 'developer', 'tester'] as const;
type MemberRole = (typeof memberRoles)[number];

function managementStorageKey(userId: string) {
  return 'rdws:management:' + userId;
}
export function pendingManagement(
  userId: string,
): ManagementCommand | undefined {
  try {
    const saved = sessionStorage.getItem(managementStorageKey(userId));
    if (!saved) return;
    const value = JSON.parse(saved) as ManagementCommand;
    if (typeof value?.commandId === 'string' && typeof value.kind === 'string')
      return value;
  } catch {
    return;
  }
}
function saveManagement(userId: string, value: ManagementCommand) {
  try {
    const previous = pendingManagement(userId);
    if (previous && previous.commandId !== value.commandId) return false;
    sessionStorage.setItem(managementStorageKey(userId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function clearManagement(userId: string, commandId: string) {
  try {
    if (pendingManagement(userId)?.commandId === commandId)
      sessionStorage.removeItem(managementStorageKey(userId));
  } catch {
    return;
  }
}
function useManagement(userId: string) {
  const client = useQueryClient();
  const [initial] = useState(() => pendingManagement(userId));
  const intent = useRef(initial);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(!!initial);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function send(input?: Intent) {
    if (active.current || (input && intent.current)) return;
    if (input) intent.current = { ...input, commandId: crypto.randomUUID() };
    if (!intent.current) return;
    const submitted = intent.current;
    if (!saveManagement(userId, submitted)) {
      if (input) intent.current = undefined;
      setError('无法保存原管理命令。请检查浏览器会话存储或先核对待处理操作。');
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api<ManagementResult>('/api/management/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submitted),
      });
      intent.current = undefined;
      clearManagement(userId, submitted.commandId);
      setUnknown(false);
      const messages = {
        confirmed: '已保存，相关会话连接已撤销。',
        'lease-expiry':
          '已保存，工作台已断开旧访问，原生连接将在短租约到期后关闭。',
        none: response.changed ? '已保存。' : '当前设置已一致。',
        'previously-recorded': '已核对原操作，当前设置已刷新。',
      };
      if (submitted.kind === 'capability.approval') {
        setNotice(
          response.replayed
            ? '原审核命令已核对，请以当前清单为准。'
            : response.changed
              ? '审核状态已保存。'
              : '审核状态未变。',
        );
      } else setNotice(messages[response.revocation]);
    } catch (failure) {
      const issue = failure as Error & { resultUnknown?: boolean };
      setError(issue.message);
      if (unknown || issue.resultUnknown) setUnknown(true);
      else {
        intent.current = undefined;
        clearManagement(userId, submitted.commandId);
      }
    } finally {
      try {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['administration'] }),
          client.invalidateQueries({ queryKey: ['projects'] }),
          client.invalidateQueries({ queryKey: ['requirements'] }),
        ]);
      } finally {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return { send, busy, unknown, notice, error, locked: busy || unknown };
}

function Feedback({ action }: { action: ReturnType<typeof useManagement> }) {
  return (
    <>
      {action.notice && (
        <p className="save-notice" role="status">
          {action.notice}
        </p>
      )}
      {action.error && <Alert theme="error" message={action.error} />}
      {action.unknown && (
        <div className="inline-feedback">
          <p>结果尚未确认，已保留原命令和内容。</p>
          <Button
            tag="button"
            variant="outline"
            loading={action.busy}
            onClick={() => void action.send()}
          >
            核对原管理操作
          </Button>
        </div>
      )}
    </>
  );
}

export function MembersPage({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}) {
  const query = useQuery({
    queryKey: ['administration', 'members', projectId],
    queryFn: ({ signal }) =>
      api<ProjectAdministration>(
        '/api/projects/' + encodeURIComponent(projectId) + '/access',
        { signal },
      ),
  });
  const action = useManagement(userId);
  const [username, setUsername] = useState('');
  const [roles, setRoles] = useState<MemberRole[]>([]);
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.send({
      kind: 'project.roles',
      projectId,
      username: username.trim(),
      roles,
    });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>成员与权限</h1>
          <p className="muted">在当前项目维护需求经理、开发和测试角色。</p>
        </div>
        <Button
          tag="button"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          刷新名单
        </Button>
      </div>
      {query.isPending && <Loading text="正在读取成员…" />}
      {query.isError && <Alert theme="error" message={query.error.message} />}
      {query.data && !query.isError && (
        <>
          <p className="muted">
            {query.data.project.name} ·{' '}
            {query.data.project.nativeConfigured
              ? '原生运行已登记'
              : '原生运行未登记'}
          </p>
          <section className="document-section">
            <h2>当前项目成员</h2>
            <div className="info-panel">
              <dl className="detail-grid">
                {query.data.members.map((member) => (
                  <div key={member.username} style={{ display: 'contents' }}>
                    <dt>{member.name}</dt>
                    <dd>
                      <span>
                        {member.roles
                          .map((role) => roleLabels[role] ?? role)
                          .join(' · ')}
                        {member.active ? '' : ' · 已停用'}
                      </span>{' '}
                      <Button
                        tag="button"
                        variant="text"
                        disabled={action.locked}
                        aria-label={'编辑 ' + member.username}
                        onClick={() => {
                          setUsername(member.username);
                          setRoles(
                            memberRoles.filter((role) =>
                              member.roles.includes(role),
                            ),
                          );
                        }}
                      >
                        编辑
                      </Button>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
          <section className="document-section">
            <h2>维护成员角色</h2>
            <p className="muted">
              留空角色会撤回这三类权限。已有分派记录保留，失去权限的负责人暂不能维护任务或阶段。
            </p>
            <form className="business-form" onSubmit={submit}>
              <fieldset
                className="form-section task-fields"
                disabled={action.locked}
              >
                <label htmlFor="member-username">成员登录名</label>
                <input
                  id="member-username"
                  value={username}
                  maxLength={64}
                  pattern="[A-Za-z0-9_.\-]+"
                  required
                  onChange={(event) => setUsername(event.target.value)}
                />
                <fieldset className="member-options">
                  <legend>项目角色</legend>
                  {memberRoles.map((role) => (
                    <label key={role}>
                      <input
                        type="checkbox"
                        checked={roles.includes(role)}
                        onChange={(event) =>
                          setRoles((previous) =>
                            event.target.checked
                              ? [...previous, role]
                              : previous.filter((item) => item !== role),
                          )
                        }
                      />
                      {roleLabels[role]}
                    </label>
                  ))}
                </fieldset>
                <div className="form-actions">
                  <Button
                    tag="button"
                    type="submit"
                    disabled={action.locked || !username.trim()}
                  >
                    保存成员角色
                  </Button>
                </div>
              </fieldset>
            </form>
          </section>
        </>
      )}
      <Feedback action={action} />
    </>
  );
}

export function PlatformPage({
  userId,
  username,
  logout,
  back,
  openDesign,
}: {
  userId: string;
  username: string;
  logout: () => void;
  back?: () => void;
  openDesign: () => void;
}) {
  const query = useQuery({
    queryKey: ['administration', 'platform'],
    queryFn: ({ signal }) =>
      api<PlatformAdministration>('/api/management/platform', { signal }),
  });
  const action = useManagement(userId);
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState('');
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [targetAdmin, setTargetAdmin] = useState('');
  const selected = query.data?.projects.find(
    (project) => project.id === target,
  );

  return (
    <main className="shell">
      <div className="topbar">
        <strong>RDWS 平台设置</strong>
        {back && (
          <Button tag="button" variant="outline" onClick={back}>
            返回工作台
          </Button>
        )}
        <Button tag="button" variant="text" onClick={logout}>
          退出登录
        </Button>
      </div>
      <div className="workspace-scroll">
        <div className="content-width">
          <div className="page-heading">
            <div>
              <h1>项目与账号</h1>
              <p className="muted">
                登记项目、指定项目管理员，管理现有账号状态。
              </p>
            </div>
            <Button
              tag="button"
              variant="outline"
              disabled={action.locked}
              onClick={openDesign}
            >
              设计系统
            </Button>
          </div>
          <Feedback action={action} />
          {query.isPending && <Loading text="正在读取平台设置…" />}
          {query.isError && (
            <Alert theme="error" message={query.error.message} />
          )}
          {query.data && !query.isError && (
            <>
              <CapabilityApprovals
                locked={action.locked}
                change={action.send}
              />
              <section className="document-section">
                <h2>登记项目</h2>
                <form
                  className="business-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action.send({
                      kind: 'project.create',
                      projectId,
                      name: name.trim(),
                      username: admin.trim(),
                    });
                  }}
                >
                  <fieldset
                    className="form-section task-fields"
                    disabled={action.locked}
                  >
                    <label htmlFor="project-id">项目标识</label>
                    <input
                      id="project-id"
                      value={projectId}
                      maxLength={64}
                      required
                      onChange={(event) => setProjectId(event.target.value)}
                    />
                    <label htmlFor="project-name">项目显示名</label>
                    <input
                      id="project-name"
                      value={name}
                      maxLength={80}
                      required
                      onChange={(event) => setName(event.target.value)}
                    />
                    <label htmlFor="project-admin">初始项目管理员登录名</label>
                    <input
                      id="project-admin"
                      value={admin}
                      maxLength={64}
                      required
                      onChange={(event) => setAdmin(event.target.value)}
                    />
                    <div className="form-actions">
                      <Button
                        tag="button"
                        type="submit"
                        disabled={
                          action.locked ||
                          !projectId ||
                          !name.trim() ||
                          !admin.trim()
                        }
                      >
                        登记项目
                      </Button>
                    </div>
                  </fieldset>
                </form>
              </section>
              <section className="document-section">
                <h2>项目设置</h2>
                <fieldset
                  className="form-section task-fields"
                  disabled={action.locked}
                >
                  <label htmlFor="managed-project">项目</label>
                  <select
                    id="managed-project"
                    value={target}
                    onChange={(event) => {
                      const id = event.target.value;
                      setTarget(id);
                      setNewName(
                        query.data.projects.find((item) => item.id === id)
                          ?.name ?? '',
                      );
                      setTargetAdmin('');
                    }}
                  >
                    <option value="">选择项目</option>
                    {query.data.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} · {project.id}
                      </option>
                    ))}
                  </select>
                  {selected && (
                    <>
                      <p className="muted">
                        {selected.nativeConfigured
                          ? '原生运行已登记'
                          : '原生运行未登记，请由维护者配置项目 Profile。'}
                      </p>
                      <label htmlFor="new-project-name">更新显示名</label>
                      <input
                        id="new-project-name"
                        value={newName}
                        maxLength={80}
                        onChange={(event) => setNewName(event.target.value)}
                      />
                      <div className="form-actions">
                        <Button
                          tag="button"
                          variant="outline"
                          disabled={!newName.trim() || action.locked}
                          onClick={() =>
                            void action.send({
                              kind: 'project.rename',
                              projectId: target,
                              name: newName.trim(),
                            })
                          }
                        >
                          保存显示名
                        </Button>
                      </div>
                      <label htmlFor="admin-seat">管理员登录名</label>
                      <input
                        id="admin-seat"
                        value={targetAdmin}
                        maxLength={64}
                        onChange={(event) => setTargetAdmin(event.target.value)}
                      />
                      <p className="muted">
                        当前席位 {selected.admins.join('、') || '暂无'}
                      </p>
                      <div className="form-actions">
                        <Button
                          tag="button"
                          variant="outline"
                          disabled={!targetAdmin.trim() || action.locked}
                          onClick={() =>
                            void action.send({
                              kind: 'project.admin',
                              projectId: target,
                              enabled: true,
                              username: targetAdmin.trim(),
                            })
                          }
                        >
                          授予席位
                        </Button>
                        <Button
                          tag="button"
                          variant="outline"
                          disabled={!targetAdmin.trim() || action.locked}
                          onClick={() =>
                            void action.send({
                              kind: 'project.admin',
                              projectId: target,
                              enabled: false,
                              username: targetAdmin.trim(),
                            })
                          }
                        >
                          撤回席位
                        </Button>
                      </div>
                    </>
                  )}
                </fieldset>
              </section>
              <section className="document-section">
                <h2>账号状态</h2>
                <p className="muted">
                  停用会使此账号的所有旧登录失效，恢复后需要重新登录。
                </p>
                <div className="info-panel">
                  <dl className="detail-grid">
                    {query.data.accounts.map((account) => (
                      <div
                        key={account.username}
                        style={{ display: 'contents' }}
                      >
                        <dt>{account.name}</dt>
                        <dd>
                          {account.active ? '有效' : '已停用'}
                          {account.platformAdmin ? ' · 平台管理员' : ''}{' '}
                          <Button
                            tag="button"
                            variant="outline"
                            disabled={
                              action.locked || username === account.username
                            }
                            aria-label={
                              (account.active ? '停用 ' : '恢复 ') +
                              account.username
                            }
                            onClick={() =>
                              void action.send({
                                kind: 'account.active',
                                username: account.username,
                                active: !account.active,
                              })
                            }
                          >
                            {account.active ? '停用账号' : '恢复账号'}
                          </Button>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export function ManagementRecovery({
  userId,
  logout,
}: {
  userId: string;
  logout: () => void;
}) {
  const action = useManagement(userId);
  return (
    <main className="shell centered">
      <h1>核对管理操作</h1>
      <p className="muted">项目列表暂不可用。可用已保留的原命令核对结果。</p>
      <Feedback action={action} />
      <Button tag="button" variant="text" onClick={logout}>
        退出登录
      </Button>
    </main>
  );
}
