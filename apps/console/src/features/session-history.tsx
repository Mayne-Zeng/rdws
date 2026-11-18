import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'tdesign-react';
import type { SessionHistoryPage } from '@rdws/contracts';
import { readSessionHistory } from '../lib/native.ts';

function downloadSummary(id: string, history: SessionHistoryPage) {
  const summary = {
    sessionId: id,
    source: 'native-logical-history',
    recoveryMayBeSynthesized: true,
    throughSeq: history.cursor,
    oldestLoadedSeq: history.beforeSeq,
    hasEarlierPages: history.hasMore,
    events: history.events.map(({ seq, type, label, outcome }) => ({
      seq,
      type,
      label,
      outcome,
    })),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `trace-${id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SessionHistory({
  requirementId,
  id,
  mode = 'replay',
  onAccessLost,
}: {
  requirementId: string;
  id: string;
  mode?: 'replay' | 'trace';
  onAccessLost?: () => void;
}) {
  const trace = mode === 'trace';
  const [history, setHistory] = useState<SessionHistoryPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController>(undefined),
    pending = useRef(false);
  async function load(current?: SessionHistoryPage) {
    const request = controller.current;
    if (!request || pending.current) return;
    const isCurrent = () =>
      controller.current === request && !request.signal.aborted;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const page = await readSessionHistory(
        requirementId,
        id,
        current
          ? { throughSeq: current.cursor, beforeSeq: current.beforeSeq }
          : {},
        request.signal,
      );
      if (!isCurrent()) return;
      if (
        current &&
        (page.cursor !== current.cursor ||
          !(page.beforeSeq < current.beforeSeq) ||
          page.events.some(
            ({ seq }) => !(seq >= page.beforeSeq && seq < current.beforeSeq),
          ))
      ) {
        setError('会话历史分页位置变化，请重试读取同一页。');
        return;
      }
      setHistory(
        current
          ? { ...page, events: [...page.events, ...current.events] }
          : page,
      );
    } catch (failure) {
      if (!isCurrent()) return;
      if (
        failure instanceof Error &&
        'status' in failure &&
        typeof failure.status === 'number' &&
        [401, 403, 404].includes(failure.status)
      ) {
        setHistory(undefined);
        setError('会话访问已变化，请重新读取历史。');
        onAccessLost?.();
      } else {
        setError(
          trace ? '会话轨迹读取失败，请重试。' : (failure as Error).message,
        );
      }
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    pending.current = false;
    void load();
    return () => current.abort();
  }, [requirementId, id]);
  const shown = trace && (busy || error) ? undefined : history;
  return (
    <section
      className="history-panel"
      aria-label={trace ? '会话轨迹事件' : '会话历史回放'}
    >
      <div className="conversation-title">
        <strong>{trace ? '已读事件' : '历史回放'}</strong>
        <span className="muted">
          {shown
            ? shown.cursor < 0
              ? '空历史'
              : `固定至事件 ${shown.cursor}`
            : error
              ? '读取失败'
              : '正在确定回放位置'}
        </span>
      </div>
      <p className="muted">
        原生会话历史可能包含中断后的恢复补齐。回放不会重新执行模型或工具。
      </p>
      {error && (
        <Alert theme="error" message={<span role="alert">{error}</span>} />
      )}
      <div className="session-actions">
        {(history?.hasMore || error) && (
          <Button
            tag="button"
            onClick={() => void load(history)}
            loading={busy}
          >
            {error ? '重试读取历史' : '加载更早事件'}
          </Button>
        )}
        {busy && <span role="status">正在读取历史…</span>}
        {trace
          ? shown &&
            shown.cursor >= 0 && (
              <>
                <span className="muted">
                  逻辑范围 #{shown.beforeSeq} 至 #{shown.cursor} · 可见{' '}
                  {shown.events.length} 条
                  {shown.hasMore ? ' · 还有更早事件' : ' · 已读取至起点'}
                </span>
                {shown.events.length > 0 && (
                  <Button
                    tag="button"
                    variant="outline"
                    onClick={() => downloadSummary(id, shown)}
                  >
                    导出已读摘要
                  </Button>
                )}
              </>
            )
          : shown &&
            !shown.hasMore && (
              <span className="muted">
                已加载至历史起点 · {shown.events.length} 条可展示事件
              </span>
            )}
      </div>
      <ol className="history-events" aria-label="历史事件序列">
        {shown?.events.map((event) => (
          <li key={event.seq} className="history-event">
            {trace ? (
              <details>
                <summary>
                  <span className="muted">#{event.seq}</span>{' '}
                  <strong>{event.label}</strong>
                  {event.outcome && <span> · {event.outcome}</span>}
                </summary>
                <div className="trace-event-detail">
                  <span className="muted">事件类型 {event.type}</span>
                  {event.text !== undefined && <p>{event.text}</p>}
                </div>
              </details>
            ) : (
              <>
                <div>
                  <span className="muted">#{event.seq}</span>
                  <strong>{event.label}</strong>
                  {event.outcome && <span>{event.outcome}</span>}
                </div>
                {event.text !== undefined && <p>{event.text}</p>}
              </>
            )}
          </li>
        ))}
      </ol>
      {shown && !shown.events.length && (
        <p className="muted">当前范围暂无可展示事件。</p>
      )}
    </section>
  );
}
