import { useState } from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
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
import { LoginScreen } from './login-screen.tsx';
import { DesignSystemPage } from './design-system.tsx';
import { api } from '../lib/ui.tsx';
export function Workbench() {
  const { data: session, isPending } = authClient.useSession();
  const client = useQueryClient();
  const [route, setRoute] = useSearchParams();
  const design = route.get('view') === 'design';
  const returnProject = route.get('project');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
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
  if (isPending || !session) return <LoginScreen checkingSession={isPending} />;
  if (design)
    return (
      <DesignSystemPage
        back={() => setRoute(returnProject ? { project: returnProject } : {})}
        logout={() => void logout()}
        logoutBusy={busy}
        logoutError={error}
      />
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
        openDesign={openDesign}
      />
    );
  if (!projects.data?.projects.length)
    return (
      <main className="shell centered">
        <h1>尚未分配项目</h1>
        <p className="muted">请由项目管理员分配项目职责后继续。</p>
        <Button onClick={openDesign}>设计系统</Button>
        <Button onClick={() => void logout()}>退出登录</Button>
      </main>
    );
  return (
    <ProjectWorkspace
      projects={projects.data.projects}
      userId={session.user.id}
      sessionId={session.session.id}
      platformAdmin={platformAdmin}
      username={session.user.name}
      logout={() => void logout()}
      logoutBusy={busy}
      error={error}
    />
  );
}
