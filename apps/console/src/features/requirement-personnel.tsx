import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  personnelRoles,
  taskAssignmentMaterial,
  type PersonnelRole,
  type RequirementDetail,
  type RequirementPersonnelCandidates,
  type RequirementPersonnelInput,
  type RequirementPersonnelReceipt,
  type TaskRecord,
} from '@rdws/contracts';
import { api, roleLabels } from '../lib/ui.tsx';

type MemberRole = RequirementPersonnelInput['add'][number];
const keyFor = (userId: string, role: string) => `${userId}:${role}`;
const messages: Record<RequirementPersonnelReceipt['status'], string> = {
  saved: '需求人员与任务分派已保存。',
  unchanged: '当前人员与分派已是所选状态。',
  stale: '任务或负责人已变化，请读取当前状态后重新编辑。',
  invalid: '参与角色或接手人已不可用，请重新选择。',
};
function originalCommand(key: string) {
  try {
    const text = sessionStorage.getItem(key);
    if (text && typeof JSON.parse(text)?.commandId === 'string') return text;
  } catch {
    return undefined;
  }
}
function isReceipt(
  value: unknown,
  commandId: string,
): value is RequirementPersonnelReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<RequirementPersonnelReceipt>;
  return (
    receipt.commandId === commandId &&
    typeof receipt.status === 'string' &&
    Object.hasOwn(messages, receipt.status) &&
    typeof receipt.contextVersion === 'number' &&
    Number.isSafeInteger(receipt.contextVersion) &&
    receipt.contextVersion > 0 &&
    ['none', 'confirmed', 'lease-expiry', 'previously-recorded'].includes(
      receipt.revocation ?? '',
    )
  );
}

export function RequirementPersonnel({
  data,
  userId,
  projectId,
  sessionId,
  canEdit,
  refresh,
  onReceipt,
}: {
  data: RequirementDetail;
  userId: string;
  projectId: string;
  sessionId: string;
  canEdit: boolean;
  refresh: () => Promise<unknown>;
  onReceipt: (text?: string, saved?: boolean) => void;
}) {
  const { id } = data.requirement;
  const url = `/api/requirements/${encodeURIComponent(id)}/personnel`;
  const headers = { 'x-rdws-edit-session': sessionId };
  const storage = 'rdws:requirement-personnel:' + JSON.stringify([userId, id]);
  const [original, setOriginal] = useState(() => originalCommand(storage));
  const [draft, setDraft] = useState<RequirementDetail>();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [leader, setLeader] = useState('');
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const live = useRef(false),
    generation = useRef(0),
    running = useRef(false);
  const members = useQuery({
    queryKey: ['requirement-personnel', sessionId, userId, projectId, id],
    queryFn: ({ signal }) =>
      api<RequirementPersonnelCandidates>(url, { headers, signal }),
    enabled: canEdit && Boolean(draft) && !original,
    refetchOnMount: 'always',
    refetchInterval: 2000,
  });
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

  const freshMembers =
    members.isFetchedAfterMount && !members.isError
      ? members.data?.members
      : undefined;
  const initial = new Map<string, MemberRole>();
  for (const participant of draft?.participants ?? []) {
    for (const role of participant.roles) {
      if (personnelRoles.includes(role as PersonnelRole))
        initial.set(keyFor(participant.id, role), {
          userId: participant.id,
          role: role as PersonnelRole,
        });
    }
  }
  const rows = new Map<
    string,
    MemberRole & { name: string; active: boolean }
  >();
  for (const person of initial.values())
    rows.set(keyFor(person.userId, person.role), {
      ...person,
      name: draft!.participants.find((p) => p.id === person.userId)!.name,
      active: false,
    });
  for (const member of freshMembers ?? [])
    rows.set(keyFor(member.id, member.role), {
      userId: member.id,
      name: member.name,
      role: member.role,
      active: true,
    });
  const developers = [...rows.values()].filter(
    (person) =>
      person.role === 'developer' &&
      person.active &&
      selected[keyFor(person.userId, person.role)],
  );
  const add = [...rows.entries()].flatMap(([key, person]) =>
    !initial.has(key) && selected[key]
      ? [{ userId: person.userId, role: person.role }]
      : [],
  );
  const remove = [...initial.entries()].flatMap(([key, person]) =>
    !selected[key] ? [person] : [],
  );
  const former = new Set(
    remove.filter((p) => p.role === 'developer').map((p) => p.userId),
  );
  if (draft && leader !== draft.requirement.leadId)
    former.add(draft.requirement.leadId);
  const groups = new Map<string, TaskRecord[]>();
  const tasks = (draft?.tasks ?? []).filter(
    (task) =>
      former.has(task.assigneeId) &&
      (task.status === 'todo' || task.status === 'in_progress'),
  );
  for (const task of tasks) {
    const items = groups.get(task.assigneeId) ?? [];
    items.push(task);
    groups.set(task.assigneeId, items);
  }
  const targetIds = new Set(developers.map((person) => person.userId));
  const handoffs = [...groups.keys()].flatMap((fromId) => {
    const toId = owners[fromId];
    return toId && toId !== fromId && targetIds.has(toId)
      ? [{ fromId, toId }]
      : [];
  });
  const individual = tasks.flatMap((task) => {
    const toId = overrides[task.id];
    return toId && toId !== task.assigneeId && targetIds.has(toId)
      ? [{ taskId: task.id, toId }]
      : [];
  });
  const overflow =
    add.length > 50 || remove.length > 50 || individual.length > 80;
  const expiredChoice =
    Object.keys(selected).some((key) => selected[key] && !rows.has(key)) ||
    [...groups.keys()].some(
      (fromId) => owners[fromId] && !targetIds.has(owners[fromId]!),
    ) ||
    tasks.some(
      (task) => overrides[task.id] && !targetIds.has(overrides[task.id]!),
    );
  const valid =
    freshMembers &&
    targetIds.has(leader) &&
    !overflow &&
    !expiredChoice &&
    tasks.every(
      (task) =>
        handoffs.some((entry) => entry.fromId === task.assigneeId) ||
        individual.some((entry) => entry.taskId === task.id),
    );

  async function send(input?: RequirementPersonnelInput) {
    if (!canEdit || checking || running.current) return;
    const revision = generation.current;
    const current = () => live.current && generation.current === revision;
    running.current = true;
    setBusy(true);
    setError('');
    onReceipt();
    let text = original;
    try {
      if (input) {
        const hash = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(taskAssignmentMaterial(tasks)),
        );
        if (!current()) return;
        input.taskDigest = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        text = JSON.stringify(input);
      }
      if (!text || !current()) return;
      try {
        sessionStorage.setItem(storage, text);
      } catch {
        setError('无法保留原操作，请检查浏览器存储后重试。');
        return;
      }
      setOriginal(text);
      const operation = JSON.parse(text) as RequirementPersonnelInput;
      const result = await api<unknown>(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: text,
      });
      if (!current()) return;
      if (!isReceipt(result, operation.commandId)) {
        setError('响应与原操作不匹配，请核对原操作。');
        return;
      }
      clear(text);
      setDraft(undefined);
      onReceipt(
        messages[result.status] +
          (result.revocation === 'lease-expiry' ? '原连接等待租约到期。' : ''),
        result.status === 'saved' || result.status === 'unchanged',
      );
      await refresh();
    } catch (failure) {
      if (!current()) return;
      const issue = failure as {
        status?: number;
        code?: string;
        message: string;
      };
      setError(issue.message);
      if (
        text &&
        ((issue.status === 409 && issue.code === 'command-conflict') ||
          (!original &&
            issue.status === 400 &&
            issue.code === 'invalid-personnel'))
      ) {
        clear(text);
        if (issue.status === 409) setDraft(undefined);
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

  function clear(text: string) {
    try {
      if (sessionStorage.getItem(storage) === text)
        sessionStorage.removeItem(storage);
      setOriginal(originalCommand(storage));
    } catch {
      setError('无法清除浏览器中的待核对记录。');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !draft || original) return;
    void send({
      commandId: crypto.randomUUID(),
      previewLeadId: draft.requirement.leadId,
      leadId: leader,
      add,
      remove,
      taskDigest: '',
      handoffs,
      overrides: individual,
    });
  }

  if (!canEdit || checking) return null;
  const nameFor = (id: string) =>
    data.participants.find((person) => person.id === id)?.name ??
    data.assignmentNames?.[id] ??
    '原负责人';
  return (
    <div className="requirement-details-editor">
      {error && <Alert theme="error" message={error} />}
      {original ? (
        <div className="form-section">
          <p className="muted">
            人员变更结果待确认。若原操作尚未提交，重试会应用原变更。
          </p>
          <div className="form-actions">
            <Button tag="button" loading={busy} onClick={() => void send()}>
              重试原人员变更
            </Button>
          </div>
        </div>
      ) : draft ? (
        <form
          className="form-section"
          aria-label="维护需求人员"
          onSubmit={submit}
        >
          {members.isPending && <Loading text="正在读取可选成员" />}
          {members.isError && (
            <div className="inline-feedback">
              <Alert theme="error" message={members.error.message} />
              <Button
                tag="button"
                variant="outline"
                onClick={() => void members.refetch()}
              >
                重试读取候选
              </Button>
            </div>
          )}
          {freshMembers && (
            <>
              <fieldset className="member-options" disabled={busy}>
                <legend>需求参与角色</legend>
                {[...rows.entries()].map(([key, person]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[key])}
                      disabled={!person.active && !selected[key]}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          [key]: event.target.checked,
                        })
                      }
                    />
                    {person.name} · {roleLabels[person.role]}
                    {person.active ? '' : '（已失效）'}
                  </label>
                ))}
              </fieldset>
              <div className="detail-edit-field">
                <label htmlFor="personnel-lead">目标开发负责人</label>
                <select
                  id="personnel-lead"
                  disabled={busy}
                  value={targetIds.has(leader) ? leader : ''}
                  onChange={(event) => setLeader(event.target.value)}
                >
                  <option value="">选择有效的需求开发成员</option>
                  {developers.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </div>
              {[...groups.entries()].map(([fromId, items]) => (
                <fieldset key={fromId} className="form-fields" disabled={busy}>
                  <legend>{nameFor(fromId)}的未完成任务</legend>
                  <div className="detail-edit-field">
                    <label htmlFor={'group-' + fromId}>本组接手人</label>
                    <select
                      id={'group-' + fromId}
                      value={owners[fromId] ?? ''}
                      onChange={(event) =>
                        setOwners({ ...owners, [fromId]: event.target.value })
                      }
                    >
                      <option value="">逐项选择</option>
                      {developers
                        .filter((p) => p.userId !== fromId)
                        .map((p) => (
                          <option key={p.userId} value={p.userId}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  {items.map((task) => (
                    <div key={task.id} className="detail-edit-field">
                      <label htmlFor={'task-handoff-' + task.id}>
                        {task.title}的接手人
                      </label>
                      <select
                        id={'task-handoff-' + task.id}
                        value={overrides[task.id] ?? ''}
                        onChange={(event) =>
                          setOverrides({
                            ...overrides,
                            [task.id]: event.target.value,
                          })
                        }
                      >
                        <option value="">沿用本组选择</option>
                        {developers
                          .filter((p) => p.userId !== fromId)
                          .map((p) => (
                            <option key={p.userId} value={p.userId}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  ))}
                </fieldset>
              ))}
              {overflow && (
                <Alert
                  theme="warning"
                  message="本次角色增删或逐项选择超限。可以减少角色改动，任务可按组指定接手人。"
                />
              )}
              {expiredChoice && (
                <Alert
                  theme="warning"
                  message="部分草稿选项已失效，请取消后按当前候选重新编辑。"
                />
              )}
            </>
          )}
          <div className="form-actions">
            <Button
              tag="button"
              type="submit"
              loading={busy}
              disabled={
                !valid ||
                (!add.length &&
                  !remove.length &&
                  leader === draft.requirement.leadId)
              }
            >
              保存人员与分派
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
              取消人员编辑
            </Button>
          </div>
        </form>
      ) : (
        <Button
          tag="button"
          variant="outline"
          onClick={() => {
            setDraft(data);
            setSelected(
              Object.fromEntries(
                data.participants.flatMap((participant) =>
                  participant.roles
                    .filter((role) =>
                      personnelRoles.includes(role as PersonnelRole),
                    )
                    .map((role) => [keyFor(participant.id, role), true]),
                ),
              ),
            );
            setLeader(data.requirement.leadId);
            setOwners({});
            setOverrides({});
            setError('');
            onReceipt();
          }}
        >
          维护需求人员
        </Button>
      )}
    </div>
  );
}
