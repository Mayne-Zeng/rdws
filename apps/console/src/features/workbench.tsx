import { useState } from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectList } from '@rdws/contracts';
import { useSearchParams } from 'react-router';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import {
  ManagementRecovery,
  pendingManagement,
  PlatformPage,
} from './administration.tsx';
import { ProjectWorkspace } from './project.tsx';
import { authClient } from '../lib/auth.ts';
import { LoginScreen } from './login-screen.tsx';
import { DesignSystemPage } from './design-system.tsx';
import type { NativeTab } from './conversation.tsx';
import { api } from '../lib/ui.tsx';
export function Workbench() {
  const {
    data: session,
    error: sessionError,
    isPending,
  } = authClient.useSession();
  const client = useQueryClient();
  const [route, setRoute] = useSearchParams();
  const design = route.get('view') === 'design';
  const returnProject = route.get('project');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [observedLogin, setObservedLogin] = useState<NativeTab['login']>();
  const [draft, setDraft] = useState<NativeTab['draft']>();
  if (session && !observedLogin)
    setObservedLogin({
      userId: session.user.id,
      sessionId: session.session.id,
    });
  const openDesign = () =>
    setRoute(
      returnProject
        ? { project: returnProject, view: 'design' }
        : { view: 'design' },
    );
  const projects = useQuery({
    queryKey: ['projects', session?.user.id],
    enabled: !!session && !design,
    queryFn: ({ signal }) => api<ProjectList>('/api/projects', { signal }),
  });
  async function logout() {
    if (!observedLogin) return;
    setBusy(true);
    setError('');
    try {
      const r = await authClient.signOut({
        fetchOptions: {
          headers: { [OBSERVED_LOGIN_HEADER]: observedLogin.sessionId },
        },
      });
      if (r.error)
        setError(
          r.error.status === 401
            ? '登录已变化，请刷新后重试'
            : '退出失败，请重试',
        );
      else {
        client.clear();
        window.location.reload();
      }
    } catch {
      setError('退出失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  const logoutProps = {
    logout: () => void logout(),
    logoutBusy: busy,
    logoutError: error,
  };
  if (isPending || !session || !observedLogin)
    return (
      <LoginScreen
        checkingSession={isPending}
        sessionNotice={
          observedLogin && error && !session
            ? sessionError
              ? '退出状态暂未确认，请刷新后核对。'
              : '此浏览器当前没有有效登录，原退出结果尚未确认。'
            : undefined
        }
        onLogin={observedLogin ? () => window.location.reload() : undefined}
      />
    );
  if (design)
    return (
      <DesignSystemPage
        back={() => setRoute(returnProject ? { project: returnProject } : {})}
        {...logoutProps}
      />
    );
  if (projects.isPending)
    return (
      <main className="shell centered">
        <Loading text="正在读取项目" />
      </main>
    );
  if (projects.isError && !projects.data && pendingManagement(session.user.id))
    return <ManagementRecovery userId={session.user.id} {...logoutProps} />;
  if (projects.isError && !projects.data)
    return (
      <main className="shell centered">
        <Alert theme="error" message={projects.error.message} />
        {error && <Alert theme="error" message={error} />}
        <Button onClick={() => void projects.refetch()}>重试</Button>
        <Button loading={busy} onClick={logoutProps.logout}>
          退出登录
        </Button>
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
        accountAuditLoginId={
          observedLogin.userId === session.user.id &&
          observedLogin.sessionId === session.session.id
            ? observedLogin.sessionId
            : undefined
        }
        username={String(Reflect.get(session.user, 'username') ?? '')}
        {...logoutProps}
        back={projects.data?.projects.length ? () => setRoute({}) : undefined}
        openDesign={openDesign}
      />
    );
  if (!projects.data?.projects.length)
    return (
      <main className="shell centered">
        <h1>尚未分配项目</h1>
        <p className="muted">请由项目管理员分配项目职责后继续。</p>
        {error && <Alert theme="error" message={error} />}
        <Button onClick={openDesign}>设计系统</Button>
        <Button loading={busy} onClick={logoutProps.logout}>
          退出登录
        </Button>
      </main>
    );
  return (
    <ProjectWorkspace
      projects={projects.data.projects}
      userId={session.user.id}
      sessionId={session.session.id}
      nativeTab={{ login: observedLogin, draft, setDraft }}
      platformAdmin={platformAdmin}
      username={session.user.name}
      logout={logoutProps.logout}
      logoutBusy={busy}
      error={error}
    />
  );
}
