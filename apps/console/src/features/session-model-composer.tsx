import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { Alert, Button } from 'tdesign-react';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import type {
  NativeRuntime,
  PilotPrompt,
  SessionBinding,
} from '../lib/native.ts';

type Choice = { provider: string; model: string };
type Saved = Choice & { revision: string };
type Command = Choice & { commandId: string; supersedes?: string[] };
type Pending = {
  refusedRevision?: string;
  choice?: Command;
  prompt?: PilotPrompt;
  draft: string;
};
type Snapshot = {
  selection: Saved | null;
  firstWrite: 'submitted' | 'prepared' | null;
  catalogReady: boolean;
  options: Choice[];
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const slot = (value: Choice) => JSON.stringify([value.provider, value.model]);
const choice = (value: unknown): value is Choice =>
  !!value &&
  typeof value === 'object' &&
  'provider' in value &&
  typeof value.provider === 'string' &&
  !!value.provider &&
  'model' in value &&
  typeof value.model === 'string' &&
  !!value.model;
const saved = (v: unknown): v is Saved =>
  choice(v) &&
  'revision' in v &&
  typeof v.revision === 'string' &&
  uuid.test(v.revision);
function validPrompt(value: PilotPrompt | undefined, sessionId: string) {
  return (
    value &&
    value.sessionId === sessionId &&
    uuid.test(value.requestId) &&
    Object.keys(value).every((k) =>
      ['sessionId', 'requestId', 'mode', 'content', 'clientTimeZone'].includes(
        k,
      ),
    ) &&
    value.mode === 'queue' &&
    Array.isArray(value.content) &&
    value.content.length === 1 &&
    value.content[0]?.type === 'text' &&
    Object.keys(value.content[0]).length === 2 &&
    typeof value.content[0].text === 'string' &&
    value.content[0].text.length <= 8000 &&
    (value.clientTimeZone === undefined ||
      typeof value.clientTimeZone === 'string')
  );
}
function pendingRecord(key: string, id: string): Pending {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return { draft: '' };
  const value = JSON.parse(raw) as Pending;
  const c = value?.choice;
  if (
    !value ||
    typeof value.draft !== 'string' ||
    value.draft.length > 8000 ||
    (!c && !value.prompt && !value.refusedRevision) ||
    (value.refusedRevision !== undefined &&
      !uuid.test(value.refusedRevision)) ||
    (value.prompt && !validPrompt(value.prompt, id)) ||
    (c &&
      (!choice(c) ||
        !uuid.test(c.commandId) ||
        (c.supersedes !== undefined &&
          (!Array.isArray(c.supersedes) ||
            !c.supersedes.length ||
            c.supersedes.length > 32 ||
            c.supersedes.includes(c.commandId) ||
            new Set(c.supersedes).size !== c.supersedes.length ||
            c.supersedes.some((x) => !uuid.test(x))))))
  )
    throw new Error('保存记录无法核对');
  return value;
}

export function SessionModelComposer({
  runtime,
  binding,
  id,
  loginId,
  userId,
  projectId,
  requirementId,
  isFork,
  input,
  setInput,
  generating,
  begin,
  accepted,
}: {
  runtime: NativeRuntime;
  binding: SessionBinding | undefined;
  id: string;
  loginId: string;
  userId: string;
  projectId: string;
  requirementId: string;
  isFork: boolean;
  input: string;
  setInput: (value: SetStateAction<string>) => void;
  generating: boolean;
  begin: (text: string) => void;
  accepted: (text: string) => void;
}) {
  const path =
    '/api/requirements/' +
    encodeURIComponent(requirementId) +
    '/sessions/' +
    encodeURIComponent(id);
  const key =
    'rdws:model-composer:' +
    JSON.stringify([userId, projectId, requirementId, id]);
  const live = useRef(false),
    sequence = useRef(0),
    hydrated = useRef(false),
    sending = useRef(false);
  const pending = useRef<Pending>({ draft: '' });
  const [record, setRecord] = useState<Pending>(pending.current);
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState('');
  const [message, setMessage] = useState(''),
    [broken, setBroken] = useState(false),
    [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string>(),
    [attempting, setAttempting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const draft = useRef(input);
  draft.current = input;

  function store(next: Pending) {
    if (!live.current) return false;
    try {
      if (next.choice || next.prompt || next.refusedRevision)
        sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
      pending.current = next;
      setRecord(next);
      return true;
    } catch {
      setBroken(true);
      setMessage('本标签无法保留原操作。请核对浏览器存储。');
      return false;
    }
  }

  const refresh = useCallback(async (): Promise<Snapshot | undefined> => {
    const ticket = ++sequence.current;
    const current = () => live.current && ticket === sequence.current;
    if (live.current) setBusy(true);
    try {
      const response = await fetch(path + '/model-selection', {
        headers: { [OBSERVED_LOGIN_HEADER]: loginId },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (
        !(data.selection === null || saved(data.selection)) ||
        ![null, 'prepared', 'submitted'].includes(data.firstWrite)
      )
        throw new Error();
      const catalog = await runtime.root
        .get('remote')
        ?.session.modelCatalog()
        .catch(() => undefined);
      const catalogReady =
        catalog?.ok === true && !catalog.value.failures.length;
      const options = catalogReady
        ? catalog.value.groups
            .filter((g) => catalog.value.routableProviders.includes(g.id))
            .flatMap((g) =>
              g.models.map((m) => ({ provider: g.id, model: m.id })),
            )
        : [];
      if (!current()) return;
      if (!hydrated.current) {
        let stored: Pending;
        try {
          stored = pendingRecord(key, id);
        } catch {
          setBroken(true);
          throw new Error();
        }
        pending.current = stored;
        setRecord(stored);
        hydrated.current = true;
        if (stored.choice || stored.prompt || stored.refusedRevision)
          setInput((text) => text || stored.draft);
      }
      const next = {
        catalogReady,
        selection: data.selection,
        firstWrite: data.firstWrite,
        options,
      } as Snapshot;
      setSnapshot(next);
      setMessage((value) =>
        value === '当前登录的会话模型或目录无法核对。' ? '' : value,
      );
      return next;
    } catch {
      if (current()) {
        setSnapshot(undefined);
        setMessage('当前登录的会话模型或目录无法核对。');
      }
      return undefined;
    } finally {
      if (current()) setBusy(false);
    }
  }, [path, loginId, runtime, key, id, setInput]);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (!generating) void refresh();
  }, [refresh, generating]);

  async function save(retry: boolean) {
    if (!live.current || broken || !snapshot || !hydrated.current) return;
    const old = pending.current.choice;
    const option = snapshot.options.find((item) => slot(item) === selected);
    if (!retry && !option) return;
    if (retry && (!old || saving === old.commandId)) return;
    const replaced = old ? [...(old.supersedes ?? []), old.commandId] : [];
    if (!retry && replaced.length > 32) {
      setMessage('请先核对原保存。');
      return;
    }
    const cmd = retry
      ? old!
      : {
          ...option!,
          commandId: crypto.randomUUID(),
          ...(replaced.length ? { supersedes: replaced } : {}),
        };
    if (!store({ ...pending.current, choice: cmd, draft: draft.current }))
      return;
    setSaving(cmd.commandId);
    setMessage('');
    const current = () =>
      live.current && pending.current.choice?.commandId === cmd.commandId;
    try {
      const response = await fetch(path + '/model-selection', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OBSERVED_LOGIN_HEADER]: loginId,
        },
        body: JSON.stringify(cmd),
      });
      const reply = await response.json();
      if (!current()) return;
      if (
        !response.ok ||
        response.headers.get('x-rdws-model-command') !== cmd.commandId ||
        !saved(reply.selection) ||
        slot(reply.selection) !== slot(cmd)
      )
        throw new Error();
      const next = await refresh();
      if (!next || !current()) return;
      if (
        !next.selection ||
        next.selection.revision !== reply.selection.revision ||
        slot(next.selection) !== slot(cmd)
      ) {
        setMessage('原保存已有回执，但当前选择已改变。请核对后明确改选。');
        return;
      }
      if (
        store({
          ...pending.current,
          choice: undefined,
          refusedRevision:
            next.selection?.revision === pending.current.refusedRevision
              ? pending.current.refusedRevision
              : undefined,
          draft: draft.current,
        })
      ) {
        setMessage('选模保存已确认。');
        setOpen(false);
        setSelected('');
      }
    } catch {
      if (current()) {
        setMessage('原保存尚待核对。可以按原键重试，也可以明确改选。');
        await refresh();
      }
    } finally {
      if (live.current)
        setSaving((value) => (value === cmd.commandId ? undefined : value));
    }
  }
  const permitted = (state: Snapshot) =>
    state.catalogReady &&
    (state.selection
      ? state.selection.revision !== pending.current.refusedRevision &&
        state.options.some((item) => slot(item) === slot(state.selection!))
      : !isFork && state.options.length > 0);
  async function submit(retry: boolean) {
    const original = pending.current.prompt;
    if (
      !binding ||
      broken ||
      sending.current ||
      generating ||
      pending.current.choice ||
      !hydrated.current ||
      (retry ? !original : !!original || !draft.current.trim())
    )
      return;
    sending.current = true;
    setAttempting(true);
    const text = retry ? original!.content[0].text : draft.current;
    try {
      const next = await refresh();
      if (
        !next ||
        !permitted(next) ||
        !live.current ||
        pending.current.choice ||
        (!retry && draft.current !== text)
      )
        return;
      const requestId = retry
        ? original!.requestId
        : binding.session.beginSubmission({
            mode: 'queue',
            text,
            attachments: [],
          }).requestId;
      begin(text);
      let ok = false;
      try {
        const result = await runtime.sendPilotText(
          binding,
          requestId,
          text,
          (req) => {
            if (
              !live.current ||
              pending.current.choice ||
              !validPrompt(req, id) ||
              req.requestId !== requestId ||
              req.content[0].text !== text ||
              !store({ ...pending.current, prompt: req, draft: draft.current })
            )
              throw new Error('原消息无法保留');
          },
          retry ? original : undefined,
        );
        ok = result.ok;
      } catch {
        ok = false;
      }
      const refused = runtime.unavailablePromptRevision(requestId);
      runtime.finishPrompt(requestId, ok);
      if (!live.current || pending.current.prompt?.requestId !== requestId)
        return;
      if (ok) {
        if (
          store({ ...pending.current, prompt: undefined, draft: draft.current })
        ) {
          accepted(text);
          setMessage('');
        }
      } else if (!retry && refused) {
        if (
          store({
            ...pending.current,
            prompt: undefined,
            refusedRevision: refused,
            draft: draft.current,
          })
        )
          setMessage('本条消息未派发。请核对当前模型并重新选择。');
      } else setMessage('原消息接纳状态尚待核对。');
      await refresh();
    } finally {
      sending.current = false;
      if (live.current) setAttempting(false);
    }
  }
  async function check() {
    const original = pending.current.prompt;
    if (!original || !live.current || sending.current) return;
    sending.current = true;
    setAttempting(true);
    try {
      const result = await fetch(path + '/prompt-receipt', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OBSERVED_LOGIN_HEADER]: loginId,
        },
        body: JSON.stringify(original),
      });
      const value = await result.json();
      const fresh = await refresh();
      if (
        !live.current ||
        !fresh ||
        pending.current.prompt?.requestId !== original.requestId
      )
        return;
      if (
        result.ok &&
        value.requestId === original.requestId &&
        value.state === 'accepted'
      ) {
        if (
          store({ ...pending.current, prompt: undefined, draft: draft.current })
        ) {
          accepted(original.content[0].text);
          setMessage('原消息已接纳。');
        }
      } else setMessage('原消息接纳状态尚待核对。');
    } catch {
      if (live.current) setMessage('原消息无法核对，已保留原操作。');
    } finally {
      sending.current = false;
      if (live.current) setAttempting(false);
    }
  }
  const blocked =
    broken ||
    !snapshot ||
    !permitted(snapshot) ||
    !!record.choice ||
    !!record.prompt ||
    attempting ||
    busy;
  return (
    <form
      className="composer"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!blocked) void submit(false);
      }}
    >
      <label htmlFor="prompt">消息</label>
      <textarea
        id="prompt"
        value={input}
        maxLength={8000}
        placeholder="围绕当前需求提问"
        onChange={(e) => {
          const text = e.target.value;
          setInput(text);
          if (
            pending.current.choice ||
            pending.current.prompt ||
            pending.current.refusedRevision
          )
            store({ ...pending.current, draft: text });
        }}
      />
      <div className="model-composer-actions">
        <button
          type="button"
          className="ctrl"
          ref={trigger}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            void refresh();
          }}
        >
          选择会话模型
        </button>
        <Button
          tag="button"
          type="submit"
          disabled={!binding || !input.trim() || generating || blocked}
        >
          发送消息
        </Button>
      </div>
      {open && (
        <div
          className="session-model-choices"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <label>
            可用模型
            <select
              value={selected}
              disabled={!snapshot || broken}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择模型</option>
              {snapshot?.options.map((o) => (
                <option key={slot(o)} value={slot(o)}>
                  {o.provider} / {o.model}
                </option>
              ))}
            </select>
          </label>
          <Button
            tag="button"
            type="button"
            disabled={
              broken ||
              !selected ||
              !snapshot?.options.some((o) => slot(o) === selected) ||
              attempting
            }
            onClick={() => void save(false)}
          >
            {record.choice ? '明确改选并保存' : '保存选择'}
          </Button>
        </div>
      )}
      {busy && <span role="status">正在核对会话模型</span>}
      {snapshot && (
        <p role="status">
          {snapshot.selection
            ? '已保存 ' +
              snapshot.selection.provider +
              ' / ' +
              snapshot.selection.model +
              ' · ' +
              (snapshot.firstWrite === 'submitted'
                ? '已开始发送'
                : snapshot.firstWrite === 'prepared'
                  ? '首写待核对'
                  : '待生效')
            : isFork
              ? '首次发送前请明确选择模型。'
              : '尚未保存个人选择。'}
        </p>
      )}
      {snapshot && !snapshot.catalogReady && (
        <Alert theme="warning" message="模型目录暂不可用，请重新核对。" />
      )}
      {snapshot?.catalogReady && !snapshot.options.length && (
        <Alert theme="warning" message="当前目录没有可用模型。" />
      )}
      {snapshot?.catalogReady && snapshot.selection && !permitted(snapshot) && (
        <Alert
          theme="warning"
          message="已选模型当前不可用，请重新选择后发送。"
        />
      )}
      {record.choice && (
        <Button
          tag="button"
          type="button"
          disabled={!snapshot || broken || saving === record.choice.commandId}
          onClick={() => void save(true)}
        >
          按原键重试保存
        </Button>
      )}
      {record.prompt && (
        <div className="model-composer-actions">
          <Button
            tag="button"
            type="button"
            disabled={!snapshot || broken || attempting}
            onClick={() => void check()}
          >
            核对原消息
          </Button>
          <Button
            tag="button"
            type="button"
            disabled={
              !snapshot ||
              !permitted(snapshot) ||
              broken ||
              attempting ||
              !!record.choice
            }
            onClick={() => void submit(true)}
          >
            按原键继续提交原消息
          </Button>
        </div>
      )}
      {(record.choice || record.prompt) && (
        <p>按原键继续时，尚未提交的原操作可能执行。</p>
      )}
      {message && <Alert theme="info" message={message} />}
      {(!snapshot || !snapshot.catalogReady) && !busy && (
        <Button tag="button" type="button" onClick={() => void refresh()}>
          重新核对模型
        </Button>
      )}
    </form>
  );
}
