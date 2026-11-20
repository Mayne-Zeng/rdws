import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'tdesign-react';
import {
  isWriteAuthorityCommand,
  type RequirementWriteAuthority,
  type WriteAuthorityCommand,
  type WriteAuthorityCommandOutcome,
  type WriteAuthorityCommandReceipt,
} from '@rdws/contracts';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import { api } from '../lib/ui.tsx';

type Intent = { sessionId: string; command: WriteAuthorityCommand };

function storedIntent(key: string): Intent | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return;
    const { sessionId, command } = value as Partial<Intent>;
    if (
      typeof sessionId === 'string' &&
      sessionId &&
      isWriteAuthorityCommand(command)
    )
      return { sessionId, command };
  } catch {
    return;
  }
}

export function FleetWriteCommands({
  keyScope,
  loginId,
  requirementPath,
  status,
  sessions,
  onAccessLost,
  refreshStatus,
}: {
  keyScope: readonly string[];
  loginId: string;
  requirementPath: string;
  status?: RequirementWriteAuthority;
  sessions: { id: string; own: boolean }[];
  onAccessLost: () => void;
  refreshStatus: () => void;
}) {
  const key = 'rdws:fleet-write:' + JSON.stringify(keyScope);
  const [pending, setPending] = useState(() => storedIntent(key));
  const [choice, setChoice] = useState('');
  const [message, setMessage] = useState('');
  const [canDiscard, setCanDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController>(undefined);
  useLayoutEffect(() => () => inFlight.current?.abort(), []);

  const own = sessions.flatMap(({ id, own }, index) =>
    own ? [{ id, label: `会话 ${index + 1}` }] : [],
  );
  const selected = own.find(({ id }) => id === choice) ?? own[0];
  const target = status?.releaseTarget;
  const mayRelease =
    target &&
    target.expiresAt > Date.now() &&
    own.some(({ id }) => id === target.sessionId);

  async function submit(intent: Intent, check: boolean) {
    if (inFlight.current) return;
    const original = JSON.stringify(intent);
    try {
      const existing = sessionStorage.getItem(key);
      if (pending ? existing !== original : existing !== null) {
        setPending(storedIntent(key));
        setMessage('请先核对此登录保存的原操作。');
        return;
      }
      if (!pending) sessionStorage.setItem(key, original);
    } catch {
      setMessage('无法保存原操作，请先恢复浏览器存储。');
      return;
    }
    setPending(intent);
    setMessage('');
    setCanDiscard(false);
    const controller = new AbortController();
    const signal = controller.signal;
    inFlight.current = controller;
    setBusy(true);
    const current = () => {
      if (signal.aborted || inFlight.current !== controller) return false;
      try {
        return sessionStorage.getItem(key) === original;
      } catch {
        return false;
      }
    };
    const header = { [OBSERVED_LOGIN_HEADER]: loginId };
    async function sampleStatus() {
      const sampled = await api<RequirementWriteAuthority>(
        requirementPath + '/write-authority',
        { headers: header, cache: 'no-store', signal },
      );
      if (sampled?.actionsEnabled !== true || sampled.state === 'unavailable')
        throw new Error();
      return sampled;
    }
    try {
      const { command } = intent;
      async function receive(readOnly: boolean) {
        const result = await api<
          WriteAuthorityCommandOutcome | WriteAuthorityCommandReceipt
        >(
          requirementPath +
            '/sessions/' +
            encodeURIComponent(intent.sessionId) +
            '/write-authority' +
            (readOnly ? '/check' : '/commands'),
          {
            method: 'POST',
            headers: { ...header, 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(command),
            signal,
          },
        );
        if (
          result.type !== command.type ||
          result.commandId !== command.commandId
        )
          throw new Error();
        return result;
      }
      let result = await receive(check);
      if (!current()) return;
      if (command.type === 'takeover') {
        for (let poll = 0; result.state === 'pending' && poll < 5; poll++) {
          setMessage('正在核验旧会话是否停稳。');
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (!current()) return;
          result = await receive(true);
          if (!current()) return;
        }
        if (result.state === 'pending') return;
        if (result.state === 'unrecorded') {
          setMessage('尚未读到原回执，可核对或重试原操作。');
          setCanDiscard(true);
          return;
        }
        if (result.state === 'cancelled') {
          await sampleStatus();
          if (!current()) return;
          setMessage('接手已取消，请查看当前写权状态。');
        } else if (
          result.state === 'acquired' &&
          isWriteAuthorityCommand({
            type: 'release',
            commandId: command.commandId,
            generation: result.generation,
          })
        ) {
          const sampled = await sampleStatus();
          if (!current()) return;
          const held = sampled.state === 'held' && sampled.holder;
          setMessage(
            held &&
              held.sessionId === intent.sessionId &&
              held.generation === result.generation &&
              held.expiresAt > Date.now()
              ? '已设为可写会话。'
              : '原接手已确认，请查看当前写权状态。',
          );
        } else throw new Error();
        sessionStorage.removeItem(key);
        setPending(undefined);
        return;
      }
      if (check && result.state === 'unrecorded') {
        setMessage('尚未读到原回执，可重试原操作。');
        return;
      }
      if (
        !('generation' in result) ||
        !isWriteAuthorityCommand({
          type: 'release',
          commandId: command.commandId,
          generation: result.generation,
        }) ||
        (command.type === 'release' && command.generation !== result.generation)
      )
        throw new Error();
      let complete = false;
      if (check && result.state === 'recorded') {
        const sampled = await sampleStatus();
        if (!current()) return;
        const held = sampled.state === 'held' && sampled.holder;
        const valid = !!held && held.expiresAt > Date.now();
        const departed =
          sampled.state === 'idle' ||
          (sampled.state === 'held' &&
            (!held || (valid && held.generation !== result.generation)));
        const matching =
          valid &&
          held.generation === result.generation &&
          held.sessionId === intent.sessionId;
        complete = departed || (command.type === 'acquire' && matching);
        setMessage(
          complete
            ? command.type === 'acquire' && departed
              ? '原申请已记录，写代已结束。'
              : '原操作已核对。'
            : '已读到原回执，当前写权或停稳状态仍待确认。',
        );
      } else if (!check) {
        if (command.type === 'acquire' && result.state === 'acquired') {
          complete = true;
        } else if (command.type === 'release' && result.state === 'released') {
          complete = true;
        } else if (command.type === 'release' && result.state === 'draining') {
          setMessage('释放已记录，等待旧任务停稳。');
        } else throw new Error();
      } else throw new Error();

      if (complete && !check) {
        await sampleStatus();
        if (!current()) return;
        setMessage(
          command.type === 'acquire'
            ? '申请已确认，请查看当前写权状态。'
            : '原写代已释放。',
        );
      }
      if (complete && current()) {
        sessionStorage.removeItem(key);
        setPending(undefined);
      }
    } catch (error) {
      if (!current()) return;
      const code = (error as { status?: number } | null)?.status;
      if (
        (code === 401 || code === 403 || code === 404) &&
        intent.command.type === 'takeover'
      ) {
        try {
          await sampleStatus();
          if (current())
            setMessage(
              code === 403
                ? '当前会话没有接手资格，可核对原操作。'
                : '当前写权已变化，可核对原操作。',
            );
        } catch (readError) {
          if (!current()) return;
          const status = (readError as { status?: number } | null)?.status;
          if (status === 401 || status === 403 || status === 404)
            onAccessLost();
          else setMessage('当前未能读取写权状态，请稍后核对原操作。');
        }
      } else if (code === 401 || code === 403 || code === 404) onAccessLost();
      else setMessage('当前未能完成确认，请核对或重试原操作。');
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = undefined;
        if (!signal.aborted) {
          setBusy(false);
          refreshStatus();
        }
      }
    }
  }

  if (!pending && !message && !status?.canTakeover && !mayRelease) return null;
  return (
    <div className="fleet-write-commands">
      {pending ? (
        <div className="session-actions">
          <Button
            tag="button"
            variant="outline"
            disabled={busy}
            onClick={() => void submit(pending, true)}
          >
            核对原操作
          </Button>
          <Button
            tag="button"
            variant="outline"
            disabled={busy}
            onClick={() => void submit(pending, false)}
          >
            重试原操作
          </Button>
          {canDiscard && (
            <Button
              tag="button"
              variant="text"
              disabled={busy}
              onClick={() => {
                try {
                  if (sessionStorage.getItem(key) !== JSON.stringify(pending))
                    return;
                  sessionStorage.removeItem(key);
                  setPending(undefined);
                  setCanDiscard(false);
                  setMessage('已放下本地操作记录，请查看当前写权状态。');
                  refreshStatus();
                } catch {
                  setMessage('无法更新本地操作记录。');
                }
              }}
            >
              放下本地记录
            </Button>
          )}
        </div>
      ) : (
        <div className="session-actions">
          {status?.canTakeover && selected && (
            <>
              <select
                aria-label="申请写权的会话"
                value={selected.id}
                onChange={(event) => setChoice(event.target.value)}
              >
                {own.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <Button
                tag="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void submit(
                    {
                      sessionId: selected.id,
                      command: {
                        type: 'takeover',
                        commandId: crypto.randomUUID(),
                      },
                    },
                    false,
                  )
                }
              >
                设为可写会话
              </Button>
            </>
          )}
          {mayRelease && target && (
            <Button
              tag="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void submit(
                  {
                    sessionId: target.sessionId,
                    command: {
                      type: 'release',
                      commandId: crypto.randomUUID(),
                      generation: target.generation,
                    },
                  },
                  false,
                )
              }
            >
              释放写锁
            </Button>
          )}
        </div>
      )}
      {(pending || message) && (
        <p role="status" aria-label="写权操作结果">
          {message || '原操作待核对。'}
        </p>
      )}
    </div>
  );
}
