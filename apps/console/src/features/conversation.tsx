import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import {
  connectNative,
  type NativeRuntime,
  type SessionBinding,
} from '../lib/native.ts';
import { Icon } from '../lib/ui.tsx';
import { ConversationStream } from './conversation-stream.tsx';
import {
  createProjectionCache,
  projectConversationNodes,
  type ProjectionCache,
} from './conversation-nodes.ts';
import { SessionModelComposer } from './session-model-composer.tsx';
import { SessionModelStatus } from './session-model.tsx';
import type { SessionOperationResult } from '@rdws/contracts';
import { SessionHistory } from './session-history.tsx';
import { WORKBENCH_POLL_INTERVAL_MS } from '../lib/query.ts';
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
  // Entries keep their objects across publications, so unchanged messages
  // keep their nodes and skip re-rendering.
  const cache = useRef<ProjectionCache>(undefined);
  cache.current ??= createProjectionCache();
  const nodes = useMemo(
    () => projectConversationNodes(snapshot.entries, cache.current!),
    [snapshot.entries],
  );
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const body = list.current?.parentElement;
    if (!body) return;
    const track = () => {
      stick.current =
        body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    };
    body.addEventListener('scroll', track, { passive: true });
    return () => body.removeEventListener('scroll', track);
  }, []);
  // Follow the newest message only while the reader is already at the end.
  useLayoutEffect(() => {
    const body = list.current?.parentElement;
    if (body && stick.current) body.scrollTop = body.scrollHeight;
  }, [nodes]);
  return (
    <div
      className="transcript"
      aria-live="polite"
      data-testid="transcript"
      ref={list}
    >
      {nodes.length === 0 && (
        <p className="muted">会话已就绪，可以开始讨论当前需求。</p>
      )}
      <ConversationStream nodes={nodes} own={own} />
    </div>
  );
}
function SessionPanel({
  runtime,
  id,
  own,
  isFork,
  login,
  projectId,
  requirementId,
  draft,
  setDraft,
  actions,
}: {
  runtime: NativeRuntime;
  id: string;
  own: boolean;
  isFork: boolean;
  login: NativeTab['login'];
  projectId: string;
  requirementId: string;
  draft: NativeTab['draft'];
  setDraft: NativeTab['setDraft'];
  actions: ReactNode;
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
  function begin(value: string) {
    if (!binding) return;
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
  }
  function accepted(value: string) {
    if (!submissionState.current?.failed)
      setInput((current) => (current === value ? '' : current));
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!binding || !input.trim()) return;
    setBusy(true);
    setError('');
    const value = input;
    begin(value);
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
      accepted(value);
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
        <span>
          <strong>需求会话</strong>
          <span className="muted">
            {own ? '本人会话 · 只读分析' : '他人会话 · 只读查看'}
          </span>
        </span>
        {actions}
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
      {own && runtime.sessionModelPilot && (
        <SessionModelComposer
          runtime={runtime}
          binding={binding}
          id={id}
          isFork={isFork}
          loginId={login.sessionId}
          userId={login.userId}
          projectId={projectId}
          requirementId={requirementId}
          input={input}
          setInput={setInput}
          generating={generating}
          begin={begin}
          accepted={accepted}
        />
      )}
      {own && !runtime.sessionModelPilot && (
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
  initialSessionId = '',
}: {
  requirementId: string;
  projectId: string;
  userId: string;
  sessionId: string;
  nativeTab: NativeTab;
  // A session named by the page address is selected once the directory
  // confirms it; the address never widens what the reader may open.
  initialSessionId?: string;
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
      initialSessionId={initialSessionId}
    />
  );
}
function ConnectedConversation({
  requirementId,
  projectId,
  login,
  draft,
  setDraft,
  initialSessionId,
}: NativeTab & {
  requirementId: string;
  projectId: string;
  initialSessionId: string;
}) {
  const storageKey =
    'rdws:session-operation:' + login.userId + ':' + requirementId;
  const initialSession = useRef(initialSessionId || draft?.sessionId || '');
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
  // A session named by the address is followed when it changes, for example
  // from the sidebar. It resolves only against the authorized directory.
  useEffect(() => {
    if (!initialSessionId) return;
    setSelected(initialSessionId);
    setReplay(false);
  }, [initialSessionId]);
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
        headers: { [OBSERVED_LOGIN_HEADER]: login.sessionId },
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
    }, WORKBENCH_POLL_INTERVAL_MS);
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
            [OBSERVED_LOGIN_HEADER]: login.sessionId,
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
  // Session-level actions share the panel's title row instead of their own.
  const sessionActions = (
    <div className="session-actions" aria-label="当前会话操作">
      {selectedSession?.own && (
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
  );
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
            {replay ? (
              <SessionHistory
                key={'history-' + selected}
                requirementId={requirementId}
                id={selected}
                observedLoginId={login.sessionId}
                actions={sessionActions}
              />
            ) : (
              <SessionPanel
                key={JSON.stringify([
                  login.sessionId,
                  projectId,
                  requirementId,
                  selected,
                ])}
                isFork={!!selectedSession.sourceSessionId}
                login={login}
                runtime={runtime}
                id={selected}
                projectId={projectId}
                requirementId={requirementId}
                draft={draft}
                setDraft={setDraft}
                own={selectedSession.own}
                actions={sessionActions}
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
