import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  useRef,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  connectNative,
  type NativeRuntime,
  type SessionBinding,
} from '../lib/native.ts';
import { Icon } from '../lib/ui.tsx';
import { SessionModelStatus } from './session-model.tsx';
import type { SessionOperationResult } from '@rdws/contracts';
import { SessionHistory } from './session-history.tsx';
type NativeDraft = {
  projectId: string;
  requirementId: string;
  sessionId: string;
  text: string;
};
export type NativeTab = {
  login: { userId: string; sessionId: string };
  draft: NativeDraft | undefined;
  setDraft: Dispatch<SetStateAction<NativeDraft | undefined>>;
};
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
  projectId,
  requirementId,
  draft,
  setDraft,
}: {
  runtime: NativeRuntime;
  id: string;
  own: boolean;
  projectId: string;
  requirementId: string;
  draft: NativeTab['draft'];
  setDraft: NativeTab['setDraft'];
}) {
  const [binding, setBinding] = useState<SessionBinding>();
  const [error, setError] = useState('');
  const input = draft?.sessionId === id ? draft.text : '';
  const setInput = useCallback(
    (update: SetStateAction<string>) => {
      setDraft((current) => {
        const matches =
          current?.sessionId === id &&
          current.requirementId === requirementId &&
          current.projectId === projectId;
        const next =
          typeof update === 'string'
            ? update
            : update(matches ? current.text : '');
        if (!next) return matches ? undefined : current;
        if (matches && next === current.text) return current;
        return { projectId, requirementId, sessionId: id, text: next };
      });
    },
    [id, projectId, requirementId, setDraft],
  );
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
  }, [binding, setInput]);
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
      runtime.finishPrompt(submission.requestId, true);
      if (!submissionState.current.failed)
        setInput((current) => (current === value ? '' : current));
    } catch {
      if (!runtime.finishPrompt(submission.requestId, false))
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
      {own && runtime.modelEgressPaused && (
        <Alert
          theme="warning"
          message="模型发送已暂停。输入会保留，可在恢复后再次发送。"
        />
      )}
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
type PendingSession = { commandId: string; sourceSessionId?: string };
export function Conversation({
  requirementId,
  projectId,
  userId,
  sessionId,
  nativeTab,
}: {
  requirementId: string;
  projectId: string;
  userId: string;
  sessionId: string;
  nativeTab: NativeTab;
}) {
  const { login, draft } = nativeTab;
  const scopedDraft =
    draft?.projectId === projectId && draft.requirementId === requirementId
      ? draft
      : undefined;
  if (login.sessionId !== sessionId || login.userId !== userId)
    return (
      <section className="sessions-region">
        <h2>会话工作区</h2>
        <Alert theme="warning" message="登录已变化，请重新打开需求会话。" />
        {login.userId === userId && scopedDraft && (
          <div className="composer">
            <label htmlFor="stale-prompt">未发送草稿</label>
            <textarea id="stale-prompt" value={scopedDraft.text} readOnly />
          </div>
        )}
        <Button tag="button" onClick={() => window.location.reload()}>
          重新打开需求会话
        </Button>
      </section>
    );
  return (
    <ConnectedConversation
      requirementId={requirementId}
      projectId={projectId}
      login={login}
      draft={scopedDraft}
      setDraft={nativeTab.setDraft}
    />
  );
}
function ConnectedConversation({
  requirementId,
  projectId,
  login,
  draft,
  setDraft,
}: NativeTab & { requirementId: string; projectId: string }) {
  const storageKey =
    'rdws:session-operation:' + login.userId + ':' + requirementId;
  const initialSession = useRef(draft?.sessionId ?? '');
  const [runtime, setRuntime] = useState<NativeRuntime>();
  const [sessions, setSessions] = useState<
    { id: string; own: boolean; sourceSessionId?: string }[]
  >([]);
  const [directoryAccessLost, setDirectoryAccessLost] = useState(false);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState(false),
    [intent, setIntent] = useState<PendingSession>();
  const live = useRef(true),
    sending = useRef(false),
    refreshSequence = useRef(0),
    appliedDirectorySequence = useRef(0);
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
    const current = () =>
      live.current && sequence > appliedDirectorySequence.current;
    const response = await fetch(
      `/api/requirements/${requirementId}/sessions`,
      {
        cache: 'no-store',
        headers: { 'x-rdws-edit-session': login.sessionId },
      },
    );
    if (!response.ok) {
      if (current() && [401, 403, 404].includes(response.status)) {
        appliedDirectorySequence.current = sequence;
        setDirectoryAccessLost(true);
        setSessions([]);
        setSelected('');
      }
      throw new Error('会话列表读取失败');
    }
    const data = await response.json();
    if (current()) {
      appliedDirectorySequence.current = sequence;
      setDirectoryAccessLost(false);
      setSessions(data.sessions);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let current: NativeRuntime | undefined;
    live.current = true;
    setRuntime(undefined);
    setSessions([]);
    setDirectoryAccessLost(false);
    setSelected(initialSession.current);
    setError('');
    void connectNative(requirementId, login.sessionId, controller.signal)
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
      appliedDirectorySequence.current = refreshSequence.current;
      controller.abort();
      void current?.dispose();
    };
  }, [requirementId, login.sessionId]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible')
        void refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [requirementId, login.sessionId]);
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
          headers: {
            'content-type': 'application/json',
            'x-rdws-edit-session': login.sessionId,
          },
          body: JSON.stringify({ commandId: operation.commandId }),
        },
      );
      if (response.status === 401) {
        if (live.current)
          setError('会话访问已变化，请重新打开需求会话后核对原操作。');
        return;
      }
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
  const selectedSession = sessions.find((session) => session.id === selected);
  return (
    <section className="sessions-region">
      <div className="title-row">
        <h2>会话工作区</h2>
        <Button
          tag="button"
          onClick={() => void create()}
          loading={busy}
          disabled={!runtime || !!intent || !storageKey || directoryAccessLost}
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
          disabled={!runtime || directoryAccessLost}
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
          {directoryAccessLost ? (
            <p className="muted" role="status">
              会话访问已变化，正在重新核对。
            </p>
          ) : (
            sessions.length === 0 && <p className="muted">暂无会话</p>
          )}
        </nav>
        {runtime && selectedSession ? (
          <div className="conversation">
            <div className="session-actions" aria-label="当前会话操作">
              {selectedSession.own && (
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
              <SessionHistory
                key={'history-' + selected}
                requirementId={requirementId}
                id={selected}
                observedLoginId={login.sessionId}
              />
            ) : (
              <SessionPanel
                key={selected}
                runtime={runtime}
                id={selected}
                projectId={projectId}
                requirementId={requirementId}
                draft={draft}
                setDraft={setDraft}
                own={selectedSession.own}
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
