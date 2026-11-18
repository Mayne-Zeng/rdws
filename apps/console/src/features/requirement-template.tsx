import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type {
  RequirementTemplateBinding,
  TemplateBindingInput,
  TemplateBindingReceipt,
} from '@rdws/contracts';
import { api } from '../lib/ui.tsx';

function readPending(key: string): TemplateBindingInput | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value.commandId === 'string' &&
      typeof value.templateId === 'string' &&
      Number.isInteger(value.revision)
    ) {
      return {
        commandId: value.commandId,
        templateId: value.templateId,
        revision: value.revision,
      };
    }
  } catch {
    return undefined;
  }
}

const optionKey = ({
  templateId,
  revision,
}: Pick<TemplateBindingInput, 'templateId' | 'revision'>) =>
  `${templateId}:${revision}`;
function isVersion(
  value: unknown,
): value is NonNullable<TemplateBindingReceipt['before']> {
  if (!value || typeof value !== 'object') return false;
  const version = value as { templateId?: unknown; revision?: unknown };
  return (
    typeof version.templateId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(version.templateId) &&
    typeof version.revision === 'number' &&
    Number.isInteger(version.revision) &&
    version.revision >= 1 &&
    version.revision <= 2147483647
  );
}

function isTerminalReceipt(
  value: unknown,
  input: TemplateBindingInput,
): value is TemplateBindingReceipt {
  if (!value || typeof value !== 'object') return false;
  const { commandId, status, before, after, replayed } =
    value as Partial<TemplateBindingReceipt>;
  if (
    commandId !== input.commandId ||
    typeof replayed !== 'boolean' ||
    (before !== null && !isVersion(before)) ||
    (after !== null && !isVersion(after))
  )
    return false;
  const previous = before ? optionKey(before) : null;
  const current = after ? optionKey(after) : null;
  if (status === 'unavailable') return previous === current;
  if (current !== optionKey(input)) return false;
  return status === 'saved'
    ? previous !== current
    : status === 'unchanged' && previous === current;
}
const notices = {
  saved: '模板绑定已保存。',
  unchanged: '当前已绑定该版本。',
  unavailable: '所选版本已不可用，当前绑定未变更。',
};

export function RequirementTemplate({
  id,
  userId,
  sessionId,
  projectId,
}: {
  id: string;
  userId: string;
  sessionId: string;
  projectId: string;
}) {
  const client = useQueryClient();
  const url = `/api/requirements/${encodeURIComponent(id)}/capability-template`;
  const key = [
    'requirement-template',
    sessionId,
    userId,
    projectId,
    id,
  ] as const;
  const storageKey = `rdws:requirement-template:${JSON.stringify([userId, id])}`;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<RequirementTemplateBinding>(url, { signal }),
    refetchOnMount: 'always',
    refetchInterval: 2000,
  });
  const [pending, setPending] = useState(() => readPending(storageKey));
  const [selection, setSelection] = useState('');
  const [notice, setNotice] = useState<TemplateBindingReceipt['status']>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingAuthority, setCheckingAuthority] = useState(false);
  const running = useRef(false);
  const live = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);

  const current =
    query.isFetchedAfterMount && !query.isError ? query.data : undefined;
  const admin = current?.options !== undefined && !checkingAuthority;
  useEffect(() => {
    if (admin) return;
    generation.current++;
    setNotice(undefined);
    setSelection('');
  }, [admin]);

  async function send(input: TemplateBindingInput) {
    if (running.current || !admin) return;
    const revision = generation.current;
    const sameRequest = () => live.current && generation.current === revision;
    const authorized = () =>
      sameRequest() &&
      client.getQueryState(key)?.status === 'success' &&
      client.getQueryData<RequirementTemplateBinding>(key)?.options !==
        undefined;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
    } catch {
      setError('无法保留待核对操作，请检查浏览器存储后重试。');
      return;
    }
    running.current = true;
    setPending(input);
    setBusy(true);
    setError('');
    setNotice(undefined);
    try {
      const receipt = await api<unknown>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!authorized()) return;
      if (!isTerminalReceipt(receipt, input)) {
        setError('响应与原操作不匹配，请核对原操作。');
        return;
      }
      if (readPending(storageKey)?.commandId === input.commandId)
        sessionStorage.removeItem(storageKey);
      setPending(readPending(storageKey));
      setSelection('');
      setNotice(receipt.status);
      await query.refetch();
    } catch (failure) {
      if (!sameRequest()) return;
      const issue = failure as Error & { status?: number };
      setError(issue.message);
      if (issue.status === 401 || issue.status === 403) {
        setNotice(undefined);
        setSelection('');
        setCheckingAuthority(true);
        await query.refetch();
        if (live.current) setCheckingAuthority(false);
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }

  const options = current?.options ?? [];
  const selected = options.find((option) => optionKey(option) === selection);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || pending) return;
    void send({
      commandId: crypto.randomUUID(),
      templateId: selected.templateId,
      revision: selected.revision,
    });
  }

  return (
    <section
      className="document-section info-panel context-tasks"
      aria-labelledby="requirement-template-title"
    >
      <div className="panel-heading">
        <h2 id="requirement-template-title">需求能力模板</h2>
      </div>
      <div className="context-empty">
        {!current && !query.isError && <Loading text="正在读取需求模板" />}
        {query.isError && (
          <div className="inline-feedback">
            <Alert theme="error" message={query.error.message} />
            <Button
              tag="button"
              variant="outline"
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              重试读取绑定
            </Button>
          </div>
        )}
        {current && (
          <>
            {current.binding ? (
              <>
                <p className="prose-text">
                  <strong>{current.binding.name}</strong> · 第{' '}
                  {current.binding.revision} 版
                </p>
                <p className="muted">
                  {current.binding.available
                    ? '当前会话尚未使用此配置。'
                    : '此版本的审核引用已失效。'}
                </p>
              </>
            ) : (
              <p className="muted">尚未绑定能力模板。</p>
            )}
            {admin && (
              <>
                {notice === 'unavailable' ? (
                  <Alert theme="warning" message={notices.unavailable} />
                ) : (
                  notice && (
                    <p className="save-notice" role="status">
                      {notices[notice]}
                    </p>
                  )
                )}
                {error && <Alert theme="error" message={error} />}
                {pending ? (
                  <div className="form-actions">
                    <Button
                      tag="button"
                      variant="outline"
                      loading={busy}
                      onClick={() => void send(pending)}
                    >
                      核对原绑定操作
                    </Button>
                  </div>
                ) : options.length ? (
                  <form className="form-section" onSubmit={submit}>
                    <label htmlFor="requirement-template-version">
                      已发布模板版本
                    </label>
                    <select
                      id="requirement-template-version"
                      value={selection}
                      disabled={busy}
                      onChange={(event) => setSelection(event.target.value)}
                    >
                      <option value="">选择模板版本</option>
                      {options.map((option) => (
                        <option
                          key={optionKey(option)}
                          value={optionKey(option)}
                        >
                          {option.name} · 第 {option.revision} 版 ·{' '}
                          {option.templateId.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    <div className="form-actions">
                      <Button
                        tag="button"
                        type="submit"
                        disabled={!selected}
                        loading={busy}
                      >
                        保存模板绑定
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="muted">本项目暂无可绑定的发布版本。</p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
