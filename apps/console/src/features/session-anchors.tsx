import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type { SessionAnchorCursor, SessionAnchorPage } from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';
import { downloadAuditCsv } from './requirement-audit.tsx';

type Scope = {
  projectId: string;
  requirementId: string;
  sessionId: string;
  userId: string;
  loginId: string;
};

export function SessionAnchors({
  onAccessLost,
  ...scope
}: Scope & { onAccessLost: () => void }) {
  const [cursor, setCursor] = useState<SessionAnchorCursor>();
  return (
    <section className="history-panel" aria-label="已记录物理锚点">
      <div className="conversation-title">
        <strong>已记录物理锚点</strong>
      </div>
      <p className="muted">
        这里展示独立校验者已记录的原始前缀摘要。核对当前原件由独立校验流程完成。
      </p>
      <AnchorPage
        key={JSON.stringify(cursor) ?? 'latest'}
        {...scope}
        cursor={cursor}
        onNavigate={setCursor}
        onAccessLost={onAccessLost}
      />
    </section>
  );
}

function AnchorPage({
  projectId,
  requirementId,
  sessionId,
  userId,
  loginId,
  cursor,
  onNavigate,
  onAccessLost,
}: Scope & {
  cursor?: SessionAnchorCursor;
  onNavigate: (cursor?: SessionAnchorCursor) => void;
  onAccessLost: () => void;
}) {
  const parameters = cursor
    ? '?' +
      new URLSearchParams({
        beforeAt: cursor.recordedAt,
        beforeId: cursor.id,
      }).toString()
    : '';
  const anchors = useQuery({
    queryKey: [
      'session-anchors',
      projectId,
      requirementId,
      sessionId,
      userId,
      loginId,
      parameters,
    ],
    queryFn: async ({ signal }) => {
      const page = await api<SessionAnchorPage>(
        `/api/requirements/${encodeURIComponent(requirementId)}/sessions/${encodeURIComponent(sessionId)}/anchors${parameters}`,
        {
          signal,
          cache: 'no-store',
          headers: { [OBSERVED_LOGIN_HEADER]: loginId },
        },
      );
      if (
        page.projectId !== projectId ||
        page.requirementId !== requirementId ||
        page.sessionId !== sessionId
      )
        throw new Error('锚点范围已变化');
      return page;
    },
    refetchOnMount: 'always',
  });
  const status = (anchors.error as { status?: number } | null)?.status;
  const lost = status === 401 || status === 403 || status === 404;
  useEffect(() => {
    if (lost) onAccessLost();
  }, [lost, onAccessLost]);
  const page =
    anchors.isFetchedAfterMount && !anchors.isError && !anchors.isFetching
      ? anchors.data
      : undefined;
  const latest = cursor && (
    <Button tag="button" variant="text" onClick={() => onNavigate()}>
      返回最新锚点
    </Button>
  );
  if (lost) return null;
  if (anchors.isError)
    return (
      <div className="inline-feedback">
        <Alert theme="error" message="读取物理锚点失败，请重试。" />
        <Button
          tag="button"
          variant="outline"
          loading={anchors.isFetching}
          onClick={() => void anchors.refetch()}
        >
          重试读取物理锚点
        </Button>
        {latest}
      </div>
    );
  if (!page) return <Loading text="正在读取物理锚点" />;
  const next = page.next;
  return (
    <>
      {page.items.length > 0 ? (
        <ol className="history-events" aria-label="物理锚点列表">
          {page.items.map((item) => (
            <li className="history-event" key={item.id}>
              <p>
                记录时间 UTC{' '}
                <time dateTime={item.recordedAt}>{item.recordedAt}</time>
              </p>
              <p>物理截止 {item.throughByte.toLocaleString('zh-CN')} 字节</p>
              <p>
                SHA-256 <code>{item.sha256}</code>
              </p>
              <p>
                锚点标识 <code>{item.id}</code>
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">当前会话暂无已记录物理锚点。</p>
      )}
      <div className="session-actions">
        {page.items.length > 0 && (
          <Button
            tag="button"
            variant="outline"
            onClick={() =>
              downloadAuditCsv(`anchors-${sessionId}.csv`, [
                [
                  '项目标识',
                  '需求标识',
                  '会话标识',
                  '锚点标识',
                  '记录时间 UTC',
                  '物理截止字节',
                  'SHA-256',
                ],
                ...page.items.map((item) => [
                  projectId,
                  requirementId,
                  sessionId,
                  item.id,
                  item.recordedAt,
                  item.throughByte,
                  item.sha256,
                ]),
              ])
            }
          >
            导出当前页锚点 CSV
          </Button>
        )}
        {next && (
          <Button
            tag="button"
            variant="outline"
            onClick={() => onNavigate(next)}
          >
            下一页锚点
          </Button>
        )}
        {latest}
      </div>
    </>
  );
}
