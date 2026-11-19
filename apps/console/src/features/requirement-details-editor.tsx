import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button } from 'tdesign-react';
import type {
  RequirementDetailsInput,
  RequirementDetailsReceipt,
  RequirementSummary,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';

export const detailFieldLabels = {
  title: '需求标题',
  description: '需求说明',
  acceptance: '验收标准',
} as const;
type Fields = Pick<RequirementSummary, keyof typeof detailFieldLabels>;

function savedCommand(key: string) {
  try {
    const stored = sessionStorage.getItem(key);
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Partial<RequirementDetailsInput> | null;
    return typeof value?.commandId === 'string' &&
      value.patch &&
      typeof value.patch === 'object'
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
}

function isReceipt(
  value: unknown,
  commandId: string,
): value is RequirementDetailsReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<RequirementDetailsReceipt>;
  return (
    receipt.commandId === commandId &&
    typeof receipt.changed === 'boolean' &&
    typeof receipt.contextVersion === 'number' &&
    Number.isSafeInteger(receipt.contextVersion) &&
    receipt.contextVersion > 0
  );
}

export function RequirementDetailsEditor({
  requirement,
  userId,
  sessionId,
  canEdit,
  refresh,
  onReceipt,
}: {
  requirement: RequirementSummary;
  userId: string;
  sessionId: string;
  canEdit: boolean;
  refresh: () => Promise<unknown>;
  onReceipt: (receipt?: RequirementDetailsReceipt) => void;
}) {
  const storageKey =
    'rdws:requirement-details:' + JSON.stringify([userId, requirement.id]);
  const [pending, setPending] = useState(() => savedCommand(storageKey));
  const [draft, setDraft] = useState<{ initial: Fields; values: Fields }>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const live = useRef(false);
  const generation = useRef(0);

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);

  useLayoutEffect(() => {
    if (canEdit) return;
    generation.current++;
    setDraft(undefined);
    setError('');
  }, [canEdit]);

  function clear(original: string) {
    try {
      if (sessionStorage.getItem(storageKey) === original)
        sessionStorage.removeItem(storageKey);
      setPending(savedCommand(storageKey));
      return true;
    } catch {
      setError('无法清除浏览器中的待重试记录。');
      return false;
    }
  }

  async function send(original: string) {
    if (running.current || !canEdit || checking) return;
    const revision = generation.current;
    const current = () => live.current && generation.current === revision;
    const first = !pending;
    const command = JSON.parse(original) as RequirementDetailsInput;
    try {
      sessionStorage.setItem(storageKey, original);
    } catch {
      setError('无法保留原保存，请检查浏览器存储后重试。');
      return;
    }
    running.current = true;
    setPending(original);
    setBusy(true);
    onReceipt();
    setError('');
    try {
      const result = await api<unknown>(
        `/api/requirements/${encodeURIComponent(requirement.id)}/details`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [OBSERVED_LOGIN_HEADER]: sessionId,
          },
          body: original,
        },
      );
      if (!current()) return;
      if (!isReceipt(result, command.commandId)) {
        setError('响应与原保存不匹配，请重试原保存。');
        return;
      }
      if (!clear(original)) return;
      setDraft(undefined);
      onReceipt(result);
      await refresh();
    } catch (failure) {
      if (!current()) return;
      const issue = failure as {
        status?: number;
        code?: string;
        message: string;
      };
      setError(issue.message);
      const conflict =
        issue.status === 409 && issue.code === 'command-conflict';
      if (
        conflict ||
        (first && issue.status === 400 && issue.code === 'invalid-details')
      ) {
        if (!clear(original)) return;
        if (conflict) setDraft(undefined);
        await refresh();
      }
      if (issue.status === 401 || issue.status === 403) {
        setDraft(undefined);
        setChecking(true);
        await refresh();
        if (live.current) setChecking(false);
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }

  const patch: RequirementDetailsInput['patch'] = draft
    ? Object.fromEntries(
        (Object.keys(detailFieldLabels) as (keyof Fields)[])
          .filter((field) => draft.values[field] !== draft.initial[field])
          .map((field) => [field, draft.values[field]]),
      )
    : {};

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending && Object.keys(patch).length)
      void send(JSON.stringify({ commandId: crypto.randomUUID(), patch }));
  }

  if (!canEdit || checking) return null;
  return (
    <div className="context-empty requirement-details-editor">
      {error && <Alert theme="error" message={error} />}
      {pending ? (
        <div className="form-section">
          <p className="muted">
            原保存结果待确认。重试时，如果原操作尚未提交，将保存原先编辑的字段。
          </p>
          <div className="form-actions">
            <Button
              tag="button"
              variant="outline"
              loading={busy}
              onClick={() => void send(pending)}
            >
              重试原保存
            </Button>
          </div>
        </div>
      ) : draft ? (
        <form className="form-section" onSubmit={submit}>
          {(Object.keys(detailFieldLabels) as (keyof Fields)[]).map((field) => {
            const input = {
              id: 'edit-detail-' + field,
              value: draft.values[field],
              maxLength: field === 'title' ? 160 : 8000,
              onChange: (
                event: React.ChangeEvent<
                  HTMLInputElement | HTMLTextAreaElement
                >,
              ) => {
                const value = event.target.value;
                setDraft({
                  ...draft,
                  values: { ...draft.values, [field]: value },
                });
              },
            };
            return (
              <div key={field} className="detail-edit-field">
                <label htmlFor={input.id}>{detailFieldLabels[field]}</label>
                {field === 'title' ? (
                  <input {...input} required />
                ) : (
                  <textarea {...input} rows={3} />
                )}
              </div>
            );
          })}
          <div className="form-actions">
            <Button
              tag="button"
              type="submit"
              loading={busy}
              disabled={
                !draft.values.title.trim() || !Object.keys(patch).length
              }
            >
              保存需求资料
            </Button>
            <Button
              tag="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                setError('');
              }}
            >
              取消编辑
            </Button>
          </div>
        </form>
      ) : (
        <Button
          tag="button"
          variant="outline"
          onClick={() => {
            const { title, description, acceptance } = requirement;
            const values = { title, description, acceptance };
            setDraft({ initial: values, values });
            onReceipt();
            setError('');
          }}
        >
          编辑需求资料
        </Button>
      )}
    </div>
  );
}
