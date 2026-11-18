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
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}
function Transcript({ binding }: { binding: SessionBinding }) {
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
        rows.push({ id: 'user-' + event.seq, role: '你', body, live: false });
    }
    if (event.type === 'assistant/message') {
      const message = data.message as { content?: unknown } | undefined;
      const body = text(message?.content);
      if (body)
        rows.push({
          id: 'assistant-' + event.seq,
          role: '助手',
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
        row = { id: key, role: '助手', body: '', live: true };
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
          className={'message ' + (row.role === '你' ? 'from-user' : '')}
          key={row.id}
          data-live={row.live ? 'true' : 'false'}
        >
          <span>
            {row.role}
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
      setError(
        binding.session.getSnapshot().lastAgentError ??
          '本轮未执行，当前需求上下文或权限不可用，请稍后重试。',
      );
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
        <Button variant="text" onClick={() => setInput(retryMessage)}>
          重新填入未执行消息
        </Button>
      )}
      <div className="conversation-body">
        {binding ? (
          <Transcript binding={binding} />
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
            type="submit"
            loading={busy}
            disabled={!binding || !input.trim() || generating}
          >
            发送消息
          </Button>
        </form>
      )}
    </div>
  );
}
export function Conversation({ requirementId }: { requirementId: string }) {
  const [runtime, setRuntime] = useState<NativeRuntime>();
  const [sessions, setSessions] = useState<{ id: string; own: boolean }[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch(`/api/requirements/${requirementId}/sessions`);
    if (!response.ok) throw new Error('会话列表读取失败');
    const data = await response.json();
    setSessions(data.sessions);
  }
  useEffect(() => {
    const controller = new AbortController();
    let current: NativeRuntime | undefined;
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
      controller.abort();
      void current?.dispose();
    };
  }, [requirementId]);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/requirements/${requirementId}/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) throw new Error('会话创建失败');
      const data = await response.json();
      await runtime?.reconnect();
      await runtime?.sessions.refresh();
      await refresh();
      setSelected(data.sessionId);
    } catch (error) {
      setError(error instanceof Error ? error.message : '会话创建失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sessions-region">
      <div className="title-row">
        <h3>会话工作区</h3>
        <Button
          onClick={() => void create()}
          loading={busy}
          disabled={!runtime}
        >
          新建会话
        </Button>
      </div>
      {error && <Alert theme="error" message={error} />}
      <div className="session-layout">
        <nav aria-label="需求会话列表">
          {sessions.map((session) => (
            <Button
              key={session.id}
              variant={selected === session.id ? 'base' : 'text'}
              onClick={() => setSelected(session.id)}
            >
              会话 {sessions.indexOf(session) + 1}
              {session.own ? ' · 本人' : ''}
            </Button>
          ))}
          {sessions.length === 0 && <p className="muted">暂无会话</p>}
        </nav>
        {runtime && selected ? (
          <SessionPanel
            key={selected}
            runtime={runtime}
            id={selected}
            own={sessions.find((item) => item.id === selected)?.own ?? false}
          />
        ) : (
          <p className="muted">选择或新建一个需求会话。</p>
        )}
      </div>
    </section>
  );
}
