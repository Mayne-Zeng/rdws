import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  requirementStateLabels,
  requirementStateOf,
  requirementStates,
  stageLabels,
  type RequirementSummary,
  type RequirementWriteAuthority,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { Icon, api } from '../lib/ui.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';

type DirectorySession = {
  id: string;
  own: boolean;
  sourceSessionId?: string | null;
};

export const railCollapseStorageKey = 'rdws:rail-collapsed';
export function readRailCollapsed() {
  try {
    return localStorage.getItem(railCollapseStorageKey) === '1';
  } catch {
    return false;
  }
}
function writeRailCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(railCollapseStorageKey, collapsed ? '1' : '0');
  } catch {
    // Storage can be unavailable; the choice then lasts for this page only.
  }
}
// The 621px–820px range is forced to icons by the stylesheet itself, so it
// reacts in the same frame as a resize. The stored choice only has an effect
// above that range, where the stylesheet shows the toggle.
export function useRailIcon() {
  const [chosen, setChosen] = useState(readRailCollapsed);
  return {
    icon: chosen,
    toggle() {
      setChosen((current) => {
        const next = !current;
        writeRailCollapsed(next);
        return next;
      });
    },
  };
}

// Sidebar tree: status group -> requirement -> sessions. A requirement row
// keeps its button role and exact title name; sessions load on expansion and
// only the selected requirement keeps following the directory.
export function DemandTree({
  requirements,
  current,
  selected,
  selectedSession,
  directoryFollowedElsewhere,
  isOpen,
  projectId,
  userId,
  loginId,
  observedLoginId,
  disabled,
  onToggle,
  onOpenRequirement,
  onOpenSession,
}: {
  requirements: RequirementSummary[];
  // Mirrors the former aria-current of a requirement row.
  current: boolean;
  selected: string;
  selectedSession: string;
  // The conversation, trace and fleet views already follow this directory.
  directoryFollowedElsewhere: boolean;
  isOpen: (id: string) => boolean;
  projectId: string;
  userId: string;
  loginId: string;
  observedLoginId: string;
  disabled: boolean;
  onToggle: (id: string) => void;
  onOpenRequirement: (id: string) => void;
  onOpenSession: (requirementId: string, sessionId: string) => void;
}) {
  const selectedOpen = isOpen(selected);
  const authority = useQuery({
    queryKey: [
      'fleet-write-status',
      projectId,
      selected,
      userId,
      observedLoginId,
    ],
    queryFn: ({ signal }) =>
      api<RequirementWriteAuthority>(
        `/api/requirements/${encodeURIComponent(selected)}/write-authority`,
        {
          cache: 'no-store',
          headers: { [OBSERVED_LOGIN_HEADER]: observedLoginId },
          signal,
        },
      ),
    enabled: selectedOpen,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.state === 'unavailable'
        ? false
        : WORKBENCH_POLL_INTERVAL_MS,
  });
  const holder =
    authority.isFetchedAfterMount && authority.data?.state === 'held'
      ? authority.data.holder
      : undefined;
  const writing =
    holder && holder.sessionId && holder.expiresAt > Date.now()
      ? holder.sessionId
      : undefined;
  return (
    <>
      {requirementStates.flatMap((state) => {
        const group = requirements.filter(
          (requirement) => requirementStateOf(requirement.stage) === state,
        );
        if (!group.length) return [];
        return [
          <div className="tree-group" key={`group-${state}`}>
            <span className="status-dot" />
            {requirementStateLabels[state]}
            <span>{group.length}</span>
          </div>,
          ...group.map((requirement) => {
            const open = isOpen(requirement.id);
            return (
              <div
                className={'demand-node' + (open ? ' open' : '')}
                key={requirement.id}
              >
                <button
                  type="button"
                  className="demand-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? '收起' : '展开'}会话：${requirement.title}`}
                  title={open ? '收起会话' : '展开会话'}
                  disabled={disabled}
                  onClick={() => onToggle(requirement.id)}
                >
                  <Icon name="arrow" />
                </button>
                <button
                  disabled={disabled}
                  aria-current={
                    current && requirement.id === selected ? 'page' : undefined
                  }
                  aria-label={requirement.title}
                  className={
                    'demand-item' +
                    (requirement.id === selected ? ' active' : '')
                  }
                  onClick={() => onOpenRequirement(requirement.id)}
                >
                  <span className="demand-icon">
                    <Icon name="file" />
                  </span>
                  <span className="demand-text">
                    <strong>{requirement.title}</strong>
                    <small>{stageLabels[requirement.stage]}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="demand-gear"
                  aria-label="打开需求档案"
                  title="打开需求档案"
                  disabled={disabled}
                  onClick={() => onOpenSession(requirement.id, '')}
                >
                  <Icon name="grid" />
                </button>
                {open && (
                  <DemandSessions
                    requirement={requirement}
                    projectId={projectId}
                    userId={userId}
                    loginId={loginId}
                    observedLoginId={observedLoginId}
                    selectedSession={selectedSession}
                    follows={
                      requirement.id === selected && !directoryFollowedElsewhere
                    }
                    writing={requirement.id === selected ? writing : undefined}
                    disabled={disabled}
                    onOpenSession={onOpenSession}
                  />
                )}
              </div>
            );
          }),
        ];
      })}
    </>
  );
}
function DemandSessions({
  requirement,
  projectId,
  userId,
  loginId,
  observedLoginId,
  selectedSession,
  follows,
  writing,
  disabled,
  onOpenSession,
}: {
  requirement: RequirementSummary;
  projectId: string;
  userId: string;
  loginId: string;
  observedLoginId: string;
  selectedSession: string;
  follows: boolean;
  writing?: string;
  disabled: boolean;
  onOpenSession: (requirementId: string, sessionId: string) => void;
}) {
  const query = useQuery({
    queryKey: ['fleet-sessions', projectId, requirement.id, userId, loginId],
    // The fleet page reads the same cache entry and expects the bare array.
    queryFn: async ({ signal }) => {
      const result = await api<{ sessions: DirectorySession[] }>(
        `/api/requirements/${encodeURIComponent(requirement.id)}/sessions`,
        {
          cache: 'no-store',
          headers: { [OBSERVED_LOGIN_HEADER]: observedLoginId },
          signal,
        },
      );
      if (!Array.isArray(result?.sessions))
        throw new Error('会话列表格式不正确');
      return result.sessions;
    },
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: follows ? WORKBENCH_POLL_INTERVAL_MS : false,
  });
  return (
    <div className="demand-sessions">
      {query.isPending && <p className="rail-empty">正在读取会话…</p>}
      {query.isError && <p className="rail-empty">会话暂不可用</p>}
      {query.data?.length === 0 && <p className="rail-empty">尚无会话</p>}
      {query.data?.map((session, index) => (
        <button
          type="button"
          key={session.id}
          className={
            'session-item' + (session.id === selectedSession ? ' active' : '')
          }
          aria-current={session.id === selectedSession ? 'true' : undefined}
          aria-label={`${requirement.title} · 会话 ${index + 1}${session.own ? ' · 本人' : ''}${session.sourceSessionId ? ' · 派生' : ''}`}
          disabled={disabled}
          onClick={() => onOpenSession(requirement.id, session.id)}
        >
          <span className="session-badge">
            {session.id === writing ? '写' : session.own ? '本人' : '成员'}
          </span>
          <span>会话 {index + 1}</span>
          {session.sourceSessionId && (
            <span className="session-badge">派生</span>
          )}
        </button>
      ))}
    </div>
  );
}
