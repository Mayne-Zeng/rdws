import {
  useEffect,
  useState,
  useSyncExternalStore,
  useRef,
  type FormEvent,
} from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import { connectNative, type NativeRuntime } from '../lib/native.ts';
import { authClient } from '../lib/auth.ts';
import { Icon } from '../lib/ui.tsx';
import { SessionModelStatus } from './session-model.tsx';
import type {
  SessionHistoryPage,
  SessionOperationResult,
} from '@rdws/contracts';
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}
function Transcript({
  binding,
  own,
}: {
  binding: SessionBinding;
  own: boolean;
}) {
  const source = binding.eventSource;
  const snapshot = useSyncExternalStore(
    source.subscribe.bind(source),
    source.getSnapshot.bind(source),
  );
  const rows: { id: string; role: string; body: string; live: boolean }[] = [];
  const live = new Map<
    string,
    { id: string; role: string; body: string; live: boolean }
  >();
  for (const entry of snapshot.entries) {
    const event = entry.event;
    const data = event.data as unknown as Record<string, unknown>;
    if (
      event.type === 'user/message' &&
      (data.source as { kind?: string } | undefined)?.kind === 'user'
    ) {
      const message = data.message as { content?: unknown } | undefined;
      const body = text(message?.content ?? data.content);
      if (body)
        rows.push({ id: 'user-' + event.seq, role: 'user', body, live: false });
    }
    if (event.type === 'assistant/message') {
      const message = data.message as { content?: unknown } | undefined;
      const body = text(message?.content);
      if (body)
        rows.push({
          id: 'assistant-' + event.seq,
          role: 'assistant',
          body,
          live: false,
        });
    }
    if (
      entry.type === 'transient' &&
      entry.event.data.chunk.type === 'text-delta'
    ) {
      const key = String(entry.event.data.attemptId);
      let row = live.get(key);
      if (!row) {
        row = { id: key, role: 'assistant', body: '', live: true };
        live.set(key, row);
        rows.push(row);
      }
      row.body += entry.event.data.chunk.text;
    }
  }
  return (
    <div className="transcript" aria-live="polite" data-testid="transcript">
      {rows.length === 0 && (
        <p className="muted">会话已就绪，可以开始讨论当前需求。</p>
      )}
      {rows.map((row) => (
        <div
          className={'message ' + (row.role === 'user' ? 'from-user' : '')}
          key={row.id}
          data-live={row.live ? 'true' : 'false'}
        >
          <span>
            {row.role === 'user' ? (own ? '你' : '用户') : '助手'}
            {row.live ? ' · 正在生成' : ''}
          </span>
          <div>{row.body}</div>
        </div>
      ))}
    </div>
  );
}
function SessionPanel({
  runtime,
  id,
  own,
}: {
  runtime: NativeRuntime;
  id: string;
  own: boolean;
}) {
  const [binding, setBinding] = useState<SessionBinding>();
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false),
    [retryMessage, setRetryMessage] = useState('');
  const submissionState = useRef<
    { text: string; seq: number; failed: boolean } | undefined
  >(undefined);
  useEffect(() => {
    if (!binding) return;
    let handled = -1;
    const update = () => {
      setGenerating(binding.session.getSnapshot().running);
      const entries = binding.eventSource.getSnapshot().entries;
      const blocked = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type !== 'transient' && entry.event.type === 'turn/end',
        );
      if (!blocked || blocked.event.seq <= handled) return;
      const data = blocked.event.data as unknown as {
        reason?: { kind?: string };
      };
      if (data.reason?.kind !== 'blocked') return;
      handled = Number(blocked.event.seq);
      setError('本轮未执行，当前需求上下文或权限不可用，请稍后重试。');
      const current = submissionState.current;
      if (
        current &&
        Number(blocked.event.seq) > current.seq &&
        !current.failed
      ) {
        current.failed = true;
        setRetryMessage(current.text);
        setInput((value) => (value.trim() ? value : current.text));
      }
    };
    const a = binding.eventSource.subscribe(update),
      b = binding.session.subscribe(update);
    update();
    return () => {
      a();
      b();
    };
  }, [binding]);
  useEffect(() => {
    let live = true;
    let ref: ReturnType<NativeRuntime['sessions']['retain']> | undefined;
    void runtime.sessions
      .refresh()
      .then(async () => {
        if (!live) return;
        ref = runtime.sessions.retain(id as never, { source: 'rdws' });
        const value = await ref.ready;
        if (live) setBinding(value);
      })
      .catch(() => {
        if (live) setError('会话目录或历史尚未就绪，请重新打开');
      });
    return () => {
      live = false;
      ref?.release();
    };
  }, [runtime, id]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!binding || !input.trim()) return;
    setBusy(true);
    setError('');
    const value = input;
    submissionState.current = {
      text: value,
      seq: Math.max(
        0,
        ...binding.eventSource
          .getSnapshot()
          .entries.filter((e) => e.type !== 'transient')
          .map((e) => Number(e.event.seq)),
      ),
      failed: false,
    };
    setRetryMessage('');
    const submission = binding.session.beginSubmission({
      mode: 'queue',
      text: value,
      attachments: [],
    });
    try {
      const result = await binding.session.prompt(
        [{ type: 'text', text: value }],
        'queue',
        undefined,
        submission.requestId,
      );
      if (!result.ok) throw new Error();
      if (!submissionState.current.failed) setInput('');
    } catch {
      setError('消息发送失败，请检查权限或重新连接');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="conversation" data-testid="conversation">
      <div className="conversation-title">
        <strong>需求会话</strong>
        <span className="muted">
          {own ? '本人会话 · 只读分析' : '他人会话 · 只读查看'}
        </span>
      </div>
      {error && <Alert theme="error" message={error} />}
      {retryMessage && (
        <Button
          tag="button"
          variant="text"
          onClick={() => setInput(retryMessage)}
        >
          重新填入未执行消息
        </Button>
      )}
      <div className="conversation-body">
        {binding ? (
          <Transcript binding={binding} own={own} />
        ) : (
          <Loading text="正在读取会话" />
        )}
      </div>
      {own && (
        <form className="composer" onSubmit={send}>
          <label htmlFor="prompt">消息</label>
          <textarea
            id="prompt"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={8000}
            placeholder="围绕当前需求提问"
          />
          <Button
            tag="button"
            type="submit"
            loading={busy}
            disabled={!binding || !input.trim() || generating}
          >
            发送消息
          </Button>
        </form>
      )}
      {binding && <SessionModelStatus binding={binding} runtime={runtime} />}
    </div>
  );
}
function History({ runtime, id }: { runtime: NativeRuntime; id: string }) {
  const [history, setHistory] = useState<SessionHistoryPage>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef(new AbortController()),
    pending = useRef(false);
  async function load(current?: SessionHistoryPage) {
    if (pending.current) return;
    pending.current = true;
    const requestController = controller.current;
    setBusy(true);
    setError('');
    try {
      const page = await runtime.history(
        id,
        current
          ? { throughSeq: current.cursor, beforeSeq: current.beforeSeq }
          : {},
        requestController.signal,
      );
      if (requestController.signal.aborted) return;
      setHistory(
        current
          ? { ...page, events: [...page.events, ...current.events] }
          : page,
      );
    } catch (e) {
      if (!requestController.signal.aborted) setError((e as Error).message);
    } finally {
      if (controller.current === requestController) pending.current = false;
      if (!requestController.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    pending.current = false;
    void load();
    return () => current.abort();
  }, [runtime, id]);
  return (
    <section className="history-panel" aria-label="会话历史回放">
      <div className="conversation-title">
        <strong>历史回放</strong>
        <span className="muted">
          {history
            ? history.cursor < 0
              ? '空历史'
              : `固定至事件 ${history.cursor}`
            : '正在确定回放位置'}
        </span>
      </div>
      <p className="muted">
        原生会话历史可能包含中断后的恢复补齐。回放不会重新执行模型或工具。
      </p>
      {error && <Alert theme="error" message={error} />}
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
        {history && !history.hasMore && (
          <span className="muted">
            已加载至历史起点 · {history.events.length} 条可展示事件
          </span>
        )}
      </div>
      <ol className="history-events" aria-label="历史事件序列">
        {history?.events.map((event) => (
          <li key={event.seq} className="history-event">
            <div>
              <span className="muted">#{event.seq}</span>
              <strong>{event.label}</strong>
              {event.outcome && <span>{event.outcome}</span>}
            </div>
            {event.text !== undefined && <p>{event.text}</p>}
          </li>
        ))}
      </ol>
      {history && !history.events.length && (
        <p className="muted">当前范围暂无可展示事件。</p>
      )}
    </section>
  );
}
type PendingSession = { commandId: string; sourceSessionId?: string };
export function Conversation({ requirementId }: { requirementId: string }) {
  const { data: identity } = authClient.useSession();
  const storageKey = identity
    ? 'rdws:session-operation:' + identity.user.id + ':' + requirementId
    : '';
  const [runtime, setRuntime] = useState<NativeRuntime>();
  const [sessions, setSessions] = useState<
    { id: string; own: boolean; sourceSessionId?: string }[]
  >([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState(false),
    [intent, setIntent] = useState<PendingSession>();
  const live = useRef(true),
    sending = useRef(false),
    refreshSequence = useRef(0);
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved.commandId === 'string') {
        setIntent(saved);
        setError('有一项会话操作尚未确认，请先核对原操作。');
      }
    } catch {
      setError('本页无法保留会话操作标识，请检查浏览器存储设置。');
    }
  }, [storageKey]);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const response = await fetch(`/api/requirements/${requirementId}/sessions`);
    if (!response.ok) throw new Error('会话列表读取失败');
    const data = await response.json();
    if (live.current && sequence === refreshSequence.current)
      setSessions(data.sessions);
  }
  useEffect(() => {
    const controller = new AbortController();
    let current: NativeRuntime | undefined;
    live.current = true;
    setRuntime(undefined);
    setSelected('');
    setError('');
    void connectNative(requirementId, controller.signal)
      .then(async (value) => {
        current = value;
        if (controller.signal.aborted) {
          await value.dispose();
          return;
        }
        setRuntime(value);
        await refresh();
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '会话连接失败');
      });
    return () => {
      live.current = false;
      controller.abort();
      void current?.dispose();
    };
  }, [requirementId]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible')
        void refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [requirementId]);
  async function create(sourceSessionId?: string, retry?: PendingSession) {
    if (sending.current || !storageKey) return;
    const operation = retry ?? {
      commandId: crypto.randomUUID(),
      ...(sourceSessionId ? { sourceSessionId } : {}),
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(operation));
    } catch {
      setError('无法保留操作标识，请检查浏览器存储设置后重试。');
      return;
    }
    sending.current = true;
    setIntent(operation);
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/requirements/${requirementId}/sessions${operation.sourceSessionId ? '/' + encodeURIComponent(operation.sourceSessionId) + '/fork' : ''}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId: operation.commandId }),
        },
      );
      const data = (await response.json()) as SessionOperationResult & {
        error?: string;
      };
      if (!live.current) return;
      if (data.commandId !== operation.commandId)
        throw new Error('Unexpected operation response');
      if (data.status === 'rejected') {
        sessionStorage.removeItem(storageKey);
        setIntent(undefined);
        setError(data.error ?? '本次操作未执行，可重新发起。');
        return;
      }
      if (!response.ok) {
        setError(data.error ?? '会话操作失败，请核对原操作');
        return;
      }
      if (data.status !== 'mapped' || !data.sessionId) {
        setError(
          data.status === 'unknown'
            ? '会话结果尚不能确认，请联系管理员核对。核对原操作不会再次创建会话。'
            : '会话操作仍在处理中，请稍后核对原操作。',
        );
        return;
      }
      await runtime?.reconnect();
      if (!live.current) return;
      await runtime?.sessions.refresh();
      if (!live.current) return;
      await refresh();
      if (!live.current) return;
      sessionStorage.removeItem(storageKey);
      setIntent(undefined);
      setSelected(data.sessionId);
      setReplay(false);
    } catch {
      if (live.current) setError('会话结果未确认，请核对原操作。');
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="sessions-region">
      <div className="title-row">
        <h2>会话工作区</h2>
        <Button
          tag="button"
          onClick={() => void create()}
          loading={busy}
          disabled={!runtime || !!intent || !storageKey}
        >
          新建会话
        </Button>
      </div>
      {error && <Alert theme="error" message={error} />}
      {intent && (
        <Button
          tag="button"
          variant="outline"
          onClick={() => void create(undefined, intent)}
          loading={busy}
          disabled={!runtime}
        >
          核对原操作
        </Button>
      )}
      <div className="session-layout">
        <nav aria-label="需求会话列表">
          {sessions.map((session, index) => (
            <div className="session-row" key={session.id}>
              <Button
                tag="button"
                variant={selected === session.id ? 'base' : 'text'}
                aria-current={selected === session.id ? 'true' : undefined}
                onClick={() => {
                  setSelected(session.id);
                  setReplay(false);
                }}
              >
                会话 {sessions.indexOf(session) + 1}
                {session.own ? ' · 本人' : ''}
                {session.sourceSessionId ? ' · 派生' : ''}
              </Button>
              <Button
                tag="button"
                className="session-replay"
                variant="text"
                shape="square"
                aria-label={'回放会话 ' + (index + 1)}
                title={'回放会话 ' + (index + 1)}
                icon={<Icon name="clock" />}
                onClick={() => {
                  setSelected(session.id);
                  setReplay(true);
                }}
              />
            </div>
          ))}
          {sessions.length === 0 && <p className="muted">暂无会话</p>}
        </nav>
        {runtime && selected ? (
          <div className="conversation">
            <div className="session-actions" aria-label="当前会话操作">
              {sessions.find((s) => s.id === selected)?.own && (
                <Button
                  tag="button"
                  variant="outline"
                  onClick={() => void create(selected)}
                  disabled={busy || !!intent}
                >
                  派生当前会话
                </Button>
              )}
              <Button
                tag="button"
                variant="text"
                onClick={() => setReplay((value) => !value)}
              >
                {replay ? '返回会话' : '回放历史'}
              </Button>
            </div>
            {replay ? (
              <History
                key={'history-' + selected}
                runtime={runtime}
                id={selected}
              />
            ) : (
              <SessionPanel
                key={selected}
                runtime={runtime}
                id={selected}
                own={
                  sessions.find((item) => item.id === selected)?.own ?? false
                }
              />
            )}
          </div>
        ) : (
          <p className="muted">选择或新建一个需求会话。</p>
        )}
      </div>
    </section>
  );
}
