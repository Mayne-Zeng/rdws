import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'tdesign-react';
import { useSearchParams } from 'react-router';
import type {
  RequirementDetail,
  RequirementTemplateBinding,
  RequirementWorkspace,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { Icon, api } from '../lib/ui.tsx';
import type { DeliveryChanges } from './requirement-changes.tsx';

type Tone = 'ok' | 'warn' | 'danger' | 'quiet';
type Status = { tone: Tone; text: string };
const reading: Status = { tone: 'quiet', text: '读取中' };
const unavailable: Status = { tone: 'quiet', text: '暂不可用' };

// Each row reads an endpoint the requirement's readers may already call. The
// query keys match the panels that own the data, so nothing is fetched twice.
function useArtifact<T>(
  key: readonly unknown[],
  path: string,
  loginId?: string,
  // A shared cache entry must store the same shape as its other readers; a
  // queryFn may unwrap the response to match them.
  unwrap?: (data: unknown) => T,
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const data: unknown = await api<unknown>(path, {
        signal,
        ...(loginId ? { headers: { [OBSERVED_LOGIN_HEADER]: loginId } } : {}),
      });
      return unwrap ? unwrap(data) : (data as T);
    },
    refetchOnMount: 'always',
  });
}
function statusOf<T>(
  query: { isPending: boolean; isError: boolean; data?: T },
  describe: (data: T) => Status,
): Status {
  if (query.isPending) return reading;
  if (query.isError) return unavailable;
  return describe(query.data as T);
}
// Move to a panel on the dossier; focus follows when the panel can hold it.
function jumpTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}
function ArtifactRow({
  icon,
  name,
  detail,
  status,
  action,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  name: string;
  detail: string;
  status: Status;
  action?: ReactNode;
}) {
  return (
    <li className="artifact-row">
      <span className="artifact-icon">
        <Icon name={icon} />
      </span>
      <div className="artifact-text">
        <strong>{name}</strong>
        <span className="muted">{detail}</span>
      </div>
      <span className={`pill artifact-status ${status.tone}`}>
        {status.text}
      </span>
      {action}
    </li>
  );
}

export function RequirementArtifacts({
  requirement,
  canEditDetails,
  userId,
  sessionId,
  projectId,
}: {
  requirement: RequirementDetail['requirement'];
  canEditDetails: boolean;
  userId: string;
  sessionId: string;
  projectId: string;
}) {
  const [, setSearch] = useSearchParams();
  const id = requirement.id;
  const root = `/api/requirements/${encodeURIComponent(id)}`;
  const template = useArtifact<RequirementTemplateBinding>(
    ['requirement-template', sessionId, userId, projectId, id],
    `${root}/capability-template`,
    sessionId,
  );
  const worktrees = useArtifact<RequirementWorkspace>(
    ['requirement-worktrees', userId, id],
    `${root}/worktrees`,
  );
  const changes = useArtifact<DeliveryChanges>(
    ['requirement-changes', userId, id],
    `${root}/changes?repositoryId=app`,
  );
  // The rail and the fleet page share this cache entry and store the bare
  // array; read the same shape instead of a second copy.
  const sessions = useArtifact<unknown[]>(
    ['fleet-sessions', projectId, id, userId, sessionId],
    `${root}/sessions`,
    sessionId,
    (data) => {
      if (!Array.isArray(data)) throw new Error('会话列表格式不正确');
      return data;
    },
  );
  const filled = [
    requirement.background,
    requirement.description,
    requirement.acceptance,
  ].filter((value) => value.trim()).length;
  const worktreeState = worktrees.data?.state;
  const openView = (view: string) =>
    setSearch((current) => {
      const next = new URLSearchParams(current);
      next.set('view', view);
      return next;
    });
  return (
    <section
      className="document-section"
      aria-labelledby="requirement-artifacts"
    >
      <div className="section-heading">
        <div>
          <h2 id="requirement-artifacts">重要产物</h2>
          <p className="muted">需求推进中形成的资料与状态，均取自当前记录。</p>
        </div>
      </div>
      <ul className="artifact-list info-panel">
        <ArtifactRow
          icon="file"
          name="需求说明"
          detail="需求背景、需求说明与验收标准"
          status={
            filled === 3
              ? { tone: 'ok', text: '已填写 3 / 3' }
              : filled
                ? { tone: 'warn', text: `已填写 ${filled} / 3` }
                : { tone: 'quiet', text: '未填写' }
          }
          action={
            canEditDetails ? (
              <Button
                tag="button"
                variant="text"
                onClick={() => jumpTo('requirement-facts')}
              >
                编辑需求资料
              </Button>
            ) : undefined
          }
        />
        <ArtifactRow
          icon="layers"
          name="能力模板"
          detail="需求绑定的已发布模板版本"
          status={statusOf(template, (data) =>
            data.binding
              ? data.binding.available
                ? {
                    tone: 'ok',
                    text: `${data.binding.name} · 第 ${data.binding.revision} 版`,
                  }
                : {
                    tone: 'danger',
                    text: `${data.binding.name} · 第 ${data.binding.revision} 版 · 已停用`,
                  }
              : { tone: 'quiet', text: '未绑定' },
          )}
          action={
            <Button
              tag="button"
              variant="text"
              onClick={() => openView('context')}
            >
              前往上下文
            </Button>
          }
        />
        <ArtifactRow
          icon="folder"
          name="需求工作树"
          detail="冻结基线对应的需求工作区"
          status={statusOf(worktrees, (data) =>
            data.state === 'ready'
              ? { tone: 'ok', text: '已就绪' }
              : data.state === 'pending'
                ? { tone: 'warn', text: '待准备' }
                : { tone: 'quiet', text: '未登记仓库' },
          )}
          action={
            worktreeState && worktreeState !== 'unconfigured' ? (
              <Button
                tag="button"
                variant="text"
                onClick={() => jumpTo('requirement-worktrees')}
              >
                查看工作树
              </Button>
            ) : undefined
          }
        />
        <ArtifactRow
          icon="branch"
          name="代码变更"
          detail="需求工作树的当前候选与已提交候选"
          status={statusOf(changes, (data) => {
            const pending =
              'entries' in data.current.status
                ? data.current.status.entries.length
                : 0;
            return pending
              ? { tone: 'warn', text: `${pending} 项未提交` }
              : { tone: 'ok', text: '无未提交变更' };
          })}
          action={
            <Button
              tag="button"
              variant="text"
              onClick={() => jumpTo('requirement-changes')}
            >
              查看变更
            </Button>
          }
        />
        <ArtifactRow
          icon="clock"
          name="会话轨迹"
          detail="本需求下的会话与固定切点历史"
          status={statusOf(sessions, (data) =>
            data.length
              ? { tone: 'ok', text: `${data.length} 个会话` }
              : { tone: 'quiet', text: '暂无会话' },
          )}
          action={
            <Button
              tag="button"
              variant="text"
              onClick={() => openView('trace')}
            >
              前往轨迹
            </Button>
          }
        />
      </ul>
    </section>
  );
}
