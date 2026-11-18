import { useState, type FormEvent } from 'react';
import { Alert, Button, Input, Loading } from 'tdesign-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectList } from '@rdws/contracts';
import { useSearchParams } from 'react-router';
import {
  ManagementRecovery,
  pendingManagement,
  PlatformPage,
} from './administration.tsx';
import { ProjectWorkspace } from './project.tsx';
import { authClient } from '../lib/auth.ts';
import { Icon, api } from '../lib/ui.tsx';
export function Workbench() {
  const { data: session, isPending } = authClient.useSession();
  const client = useQueryClient();
  const [route, setRoute] = useSearchParams();
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const projects = useQuery({
    queryKey: ['projects', session?.user.id],
    enabled: !!session,
    queryFn: ({ signal }) => api<ProjectList>('/api/projects', { signal }),
  });
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.username({ username, password });
      if (result.error) setError('登录失败，请检查账号与密码');
      else setPassword('');
    } catch {
      setError('暂时无法连接服务，请稍后重试');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    try {
      const r = await authClient.signOut();
      if (r.error) setError('退出失败，请重试');
      else client.clear();
    } catch {
      setError('退出失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  if (isPending)
    return (
      <main className="shell centered">
        <Loading text="正在读取登录状态" />
      </main>
    );
  if (!session)
    return (
      <main className="shell login-shell">
        <a href="/" className="brand login-brand">
          <span className="brand-mark">
            <Icon name="layers" />
          </span>
          <strong>RDWS</strong>
          <span>研发工作台</span>
        </a>
        <section className="login">
          <h1>进入你的工作台</h1>
          <p className="muted">使用预置的本地账号登录，继续当前项目。</p>
          <form onSubmit={login}>
            <label htmlFor="username">账号</label>
            <Input
              ref={(n) => {
                if (n) n.inputElement.id = 'username';
              }}
              name="username"
              value={username}
              onChange={setUsername}
              autocomplete="username"
              placeholder="输入账号"
            />
            <label htmlFor="password">密码</label>
            <Input
              ref={(n) => {
                if (n) n.inputElement.id = 'password';
              }}
              name="password"
              type="password"
              value={password}
              onChange={setPassword}
              autocomplete="current-password"
              placeholder="输入密码"
            />
            {error && <Alert theme="error" message={error} />}
            <Button
              type="submit"
              block
              loading={busy}
              disabled={!username || !password}
            >
              登录
            </Button>
          </form>
          <p className="login-note">
            <Icon name="eye" />
            本地开发与功能验证
          </p>
        </section>
      </main>
    );
  if (projects.isPending)
    return (
      <main className="shell centered">
        <Loading text="正在读取项目" />
      </main>
    );
  if (projects.isError && !projects.data && pendingManagement(session.user.id))
    return (
      <ManagementRecovery
        userId={session.user.id}
        logout={() => void logout()}
      />
    );
  if (projects.isError && !projects.data)
    return (
      <main className="shell centered">
        <Alert theme="error" message={projects.error.message} />
        <Button onClick={() => void projects.refetch()}>重试</Button>
        <Button onClick={() => void logout()}>退出登录</Button>
      </main>
    );
  const platformAdmin = Reflect.get(session.user, 'platformAdmin') === true;
  if (
    platformAdmin &&
    (route.get('view') === 'platform' || !projects.data?.projects.length)
  )
    return (
      <PlatformPage
        userId={session.user.id}
        username={String(Reflect.get(session.user, 'username') ?? '')}
        logout={() => void logout()}
        back={projects.data?.projects.length ? () => setRoute({}) : undefined}
      />
    );
  if (!projects.data?.projects.length)
    return (
      <main className="shell centered">
        <h1>尚未分配项目</h1>
        <p className="muted">请由项目管理员分配项目职责后继续。</p>
        <Button onClick={() => void logout()}>退出登录</Button>
      </main>
    );
  return (
    <ProjectWorkspace
      projects={projects.data.projects}
      userId={session.user.id}
      platformAdmin={platformAdmin}
      username={session.user.name}
      logout={() => void logout()}
      logoutBusy={busy}
      error={error}
    />
  );
}
