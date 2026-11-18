import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button } from 'tdesign-react';
import {
  importColumns,
  importLimits,
  splitImportAccounts,
  splitImportTasks,
  type RequirementImportFeedback,
  type RequirementImportField,
  type RequirementImportInput,
  type RequirementImportReceipt,
  type RequirementImportRow,
} from '@rdws/contracts';
import { api, Icon } from '../lib/ui.tsx';
import { openImportFile, type ImportSheet } from './requirement-import-file.ts';

type Pending = { input: RequirementImportInput; sheet: string };
type Progress =
  | { type: 'reading' | 'validating'; done: number; total: number }
  | { type: 'parsing'; done: number };
const columns = Object.entries(importColumns) as [
  RequirementImportField,
  string,
][];
const workspace = {
  unconfigured: '工作树未配置',
  pending: '工作树待准备',
  ready: '工作树已就绪',
} as const;

function readPending(key: string): Pending | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null',
    ) as Partial<Pending> | null;
    if (
      value &&
      typeof value.sheet === 'string' &&
      typeof value.input?.commandId === 'string' &&
      Array.isArray(value.input.rows) &&
      value.input.rows.length &&
      value.input.rows.every(
        (row) =>
          Number.isInteger(row?.row) &&
          columns.every(([field]) => typeof row[field] === 'string'),
      )
    )
      return value as Pending;
  } catch {
    return undefined;
  }
}
function feedbackMatches(
  value: unknown,
  rows: RequirementImportRow[],
): value is RequirementImportFeedback[] {
  return (
    Array.isArray(value) &&
    value.length === rows.length &&
    value.every(
      (item, index) =>
        item &&
        item.row === rows[index]?.row &&
        Array.isArray(item.issues) &&
        item.issues.every(
          (issue: RequirementImportFeedback['issues'][number]) =>
            issue &&
            Object.hasOwn(importColumns, issue.field) &&
            typeof issue.message === 'string',
        ),
    )
  );
}
function matchesReceipt(
  value: unknown,
  input: RequirementImportInput,
): value is RequirementImportReceipt {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<RequirementImportReceipt>;
  if (result.commandId !== input.commandId) return false;
  if (result.status === 'rejected')
    return (
      feedbackMatches(result.rows, input.rows) &&
      result.rows.some((row) => row.issues.length)
    );
  return (
    result.status === 'created' &&
    Array.isArray(result.rows) &&
    result.rows.length === input.rows.length &&
    new Set(result.rows.map((item) => item?.id)).size === input.rows.length &&
    result.rows.every(
      (item, index) =>
        item &&
        item.row === input.rows[index]?.row &&
        typeof item.id === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.id) &&
        Object.hasOwn(workspace, item.workspaceState),
    )
  );
}
function checkWorkload(rows: RequirementImportRow[]) {
  let tasks = 0,
    roles = 0;
  for (const row of rows) {
    tasks += splitImportTasks(row.tasks).length;
    roles +=
      splitImportAccounts(row.managers).length +
      splitImportAccounts(row.developers).length +
      splitImportAccounts(row.testers).length;
  }
  if (tasks > importLimits.taskCount || roles > importLimits.roleCount)
    return '整批最多 200 个初始任务、500 个角色项，请减少填报或拆分批次。';
  if (
    new TextEncoder().encode(
      JSON.stringify({
        commandId: '00000000-0000-0000-0000-000000000000',
        rows,
      }),
    ).length > importLimits.bytes
  )
    return '批次数据超过 2 MiB，请拆分后再提交。';
  return '';
}
function downloadTemplate() {
  const url = URL.createObjectURL(
    new Blob(['\ufeff', Object.values(importColumns).join(','), '\r\n'], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = '需求批量导入模板.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function RequirementImport({
  projectId,
  userId,
  sessionId,
  onProtectedChange,
  onClose,
  onOpen,
  onCreated,
}: {
  projectId: string;
  userId: string;
  sessionId: string;
  onProtectedChange: (value: boolean) => void;
  onClose: () => void;
  onOpen: (id: string) => void;
  onCreated: () => void;
}) {
  const root = `/api/projects/${encodeURIComponent(projectId)}/requirements/import`;
  const headers = {
    'content-type': 'application/json',
    'x-rdws-edit-session': sessionId,
  };
  const key = 'rdws:requirement-import:' + JSON.stringify([userId, projectId]);
  const [pending, setPending] = useState(() => readPending(key));
  const [rows, setRows] = useState<RequirementImportRow[]>(
    () => pending?.input.rows ?? [],
  );
  const [sheetName, setSheetName] = useState(() => pending?.sheet ?? '');
  const [sheets, setSheets] = useState<ImportSheet[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [feedback, setFeedback] = useState<RequirementImportFeedback[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [passed, setPassed] = useState(false);
  const [result, setResult] = useState<RequirementImportReceipt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const job = useRef<AbortController | undefined>(undefined);
  const sending = useRef(false),
    live = useRef(false);

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      job.current?.abort();
    };
  }, []);
  useEffect(() => {
    onProtectedChange(busy);
  }, [busy, onProtectedChange]);
  useEffect(() => () => onProtectedChange(false), [onProtectedChange]);

  function resetCheck() {
    job.current?.abort();
    setProgress(undefined);
    setFeedback([]);
    setPassed(false);
    setError('');
    setResult(undefined);
  }
  function newJob() {
    resetCheck();
    const controller = new AbortController();
    job.current = controller;
    return controller.signal;
  }
  function finishJob(signal: AbortSignal) {
    if (!signal.aborted) setProgress(undefined);
  }
  function handleJobError(failure: unknown, signal: AbortSignal) {
    if (!signal.aborted) setError((failure as Error).message);
  }
  function showFeedback(items: RequirementImportFeedback[]) {
    setFeedback(items);
    setExpanded(
      (prior) =>
        new Set([
          ...prior,
          ...items.filter((item) => item.issues.length).map(({ row }) => row),
        ]),
    );
  }

  async function validate(supplied: RequirementImportRow[], signal = newJob()) {
    const limit = checkWorkload(supplied);
    if (limit) {
      setError(limit);
      finishJob(signal);
      return;
    }
    const details: RequirementImportFeedback[] = [];
    setProgress({ type: 'validating', done: 0, total: supplied.length });
    try {
      for (let offset = 0; offset < supplied.length; offset += 8) {
        const group = supplied.slice(offset, offset + 8);
        const response = await api<{ rows: unknown }>(root + '/preview', {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({ rows: group }),
        });
        signal.throwIfAborted();
        if (!feedbackMatches(response.rows, group))
          throw new Error('校验结果与当前导入行不匹配，请重新校验');
        details.push(...response.rows);
        showFeedback([...details]);
        setProgress({
          type: 'validating',
          done: details.length,
          total: supplied.length,
        });
      }
      setPassed(details.every((row) => !row.issues.length));
    } catch (failure) {
      handleJobError(failure, signal);
    } finally {
      finishJob(signal);
    }
  }

  async function readSheet(sheet: ImportSheet, signal: AbortSignal) {
    setSheetName(sheet.name);
    setRows([]);
    setExpanded(new Set());
    setProgress({ type: 'parsing', done: 0 });
    try {
      const next = await sheet.read(signal, (done) =>
        setProgress({ type: 'parsing', done }),
      );
      signal.throwIfAborted();
      setRows(next);
      await validate(next, signal);
    } catch (failure) {
      handleJobError(failure, signal);
      finishJob(signal);
    }
  }
  async function selectFile(file: File) {
    if (sending.current || pending) return;
    const signal = newJob();
    setRows([]);
    setExpanded(new Set());
    setSheets([]);
    setSheetName('');
    setSelectedSheet('');
    setProgress({ type: 'reading', done: 0, total: file.size });
    try {
      const opened = await openImportFile(file, signal, (done) =>
        setProgress({ type: 'reading', done, total: file.size }),
      );
      signal.throwIfAborted();
      setSheets(opened);
      if (opened.length === 1) await readSheet(opened[0]!, signal);
      else finishJob(signal);
    } catch (failure) {
      handleJobError(failure, signal);
      finishJob(signal);
    }
  }
  function edit(row: number, field: RequirementImportField, value: string) {
    if (sending.current || pending) return;
    resetCheck();
    setRows((previous) =>
      previous.map((entry) =>
        entry.row === row ? { ...entry, [field]: value } : entry,
      ),
    );
  }

  async function submit(original?: Pending) {
    if (sending.current || (!original && (!passed || pending))) return;
    const current = original ?? {
      input: { commandId: crypto.randomUUID(), rows },
      sheet: sheetName,
    };
    const text = JSON.stringify(current);
    try {
      sessionStorage.setItem(key, text);
    } catch {
      setError('无法保留待核对的原批次，请检查浏览器存储。');
      return;
    }
    sending.current = true;
    setBusy(true);
    setPending(current);
    setError('');
    try {
      const response = await api<unknown>(root + '/commit', {
        method: 'POST',
        headers,
        body: JSON.stringify(current.input),
      });
      if (!live.current) return;
      if (!matchesReceipt(response, current.input)) {
        setError('响应与原批次不匹配，请重试原批次。');
        return;
      }
      if (!clearOriginal(text)) return;
      setPassed(false);
      setResult(response);
      if (response.status === 'rejected') showFeedback(response.rows);
      else onCreated();
    } catch (failure) {
      if (!live.current) return;
      const issue = failure as Error & { status?: number; code?: string };
      setError(issue.message);
      if (
        (issue.status === 409 && issue.code === 'command-conflict') ||
        (!original && issue.status === 400 && issue.code === 'invalid-import')
      ) {
        clearOriginal(text);
        setPassed(false);
      }
    } finally {
      sending.current = false;
      if (live.current) setBusy(false);
    }
  }
  function clearOriginal(text: string) {
    try {
      if (sessionStorage.getItem(key) === text) sessionStorage.removeItem(key);
      setPending(readPending(key));
      return true;
    } catch {
      setError('无法清除浏览器中的待核对批次。');
      return false;
    }
  }

  const issuesByRow = new Map(feedback.map((row) => [row.row, row.issues]));
  return (
    <section className="inline-panel requirement-editor">
      <div className="page-heading core-page-heading">
        <div>
          <h1>批量导入需求</h1>
          <p className="muted">选择文件，校验并修正每行，通过后再整批入库。</p>
        </div>
        <Button
          tag="button"
          variant="outline"
          disabled={busy}
          onClick={onClose}
        >
          返回需求列表
        </Button>
      </div>
      <div className="form-section">
        <label htmlFor="requirement-import-file">需求文件</label>
        <input
          id="requirement-import-file"
          type="file"
          accept=".csv,.xlsx"
          disabled={!!pending || busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void selectFile(file);
            event.currentTarget.value = '';
          }}
        />
        <p className="muted">
          UTF-8 CSV 或 .xlsx 文本表格，每文件最多 2 MiB，每批最多 50 条。
        </p>
        <div className="form-actions">
          <Button tag="button" variant="outline" onClick={downloadTemplate}>
            下载字段模板
          </Button>
        </div>
        {sheets.length > 1 && (
          <>
            <label htmlFor="requirement-import-sheet">工作表</label>
            <select
              id="requirement-import-sheet"
              value={selectedSheet}
              disabled={!!pending || busy}
              onChange={(event) => {
                const index = event.target.value;
                setSelectedSheet(index);
                const sheet = index ? sheets[Number(index) - 1] : undefined;
                if (sheet) void readSheet(sheet, newJob());
              }}
            >
              <option value="" disabled>
                选择数据工作表
              </option>
              {sheets.map((sheet, index) => (
                <option key={index} value={index + 1}>
                  {sheet.name}
                </option>
              ))}
            </select>
          </>
        )}
        {progress && (
          <div role="status">
            {progress.type === 'parsing' ? (
              <span>正在解析，已读 {progress.done} 条需求</span>
            ) : (
              <>
                <span>
                  {progress.type === 'reading' ? '正在读取文件' : '正在校验'} ·{' '}
                  {progress.done} / {progress.total}
                </span>
                <progress
                  aria-label={
                    progress.type === 'reading' ? '文件读取进度' : '校验进度'
                  }
                  value={progress.done}
                  max={Math.max(progress.total, 1)}
                />
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="inline-feedback">
          <Alert theme="error" message={error} />
        </div>
      )}
      {pending && (
        <div className="form-section">
          <p className="muted">
            原批次结果待确认。若原请求尚未入库，重试会使用原内容提交。
          </p>
          <div className="form-actions">
            <Button
              tag="button"
              loading={busy}
              onClick={() => void submit(pending)}
            >
              重试原批次
            </Button>
          </div>
        </div>
      )}
      {result?.status === 'created' ? (
        <section className="document-section" aria-label="批量入库结果">
          <h2>入库结果</h2>
          <p className="save-notice" role="status">
            已整批入库，共 {result.rows.length} 条需求。
          </p>
          <ul className="import-rows">
            {result.rows.map((row, index) => (
              <li className="info-panel import-row" key={row.id}>
                <div className="import-row-heading">
                  <strong>
                    第 {row.row} 行 · {rows[index]?.title}
                  </strong>
                  <span>{workspace[row.workspaceState]}</span>
                </div>
                <Button
                  tag="button"
                  variant="text"
                  onClick={() => onOpen(row.id)}
                >
                  打开需求档案 <Icon name="arrow" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        rows.length > 0 && (
          <section className="document-section" aria-label="逐条导入预览">
            <div className="section-heading">
              <h2>{sheetName ? `导入明细 · ${sheetName}` : '导入明细'}</h2>
              <span className="muted">{rows.length} 条</span>
            </div>
            {result?.status === 'rejected' && (
              <Alert
                theme="warning"
                message="提交时部分行未通过，本批次没有需求入库。"
              />
            )}
            <ul className="import-rows">
              {rows.map((row) => {
                const issues = issuesByRow.get(row.row);
                return (
                  <li className="info-panel import-row" key={row.row}>
                    <details
                      open={expanded.has(row.row)}
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setExpanded((prior) => {
                          if (prior.has(row.row) === open) return prior;
                          const next = new Set(prior);
                          if (open) next.add(row.row);
                          else next.delete(row.row);
                          return next;
                        });
                      }}
                    >
                      <summary className="import-row-heading">
                        <strong>
                          第 {row.row} 行 · {row.title || '未填写标题'}
                        </strong>
                        <span>
                          {pending
                            ? '待核对'
                            : issues?.length
                              ? '需修正'
                              : result?.status === 'rejected'
                                ? '未入库'
                                : issues
                                  ? '校验通过'
                                  : '待校验'}
                        </span>
                      </summary>
                      <fieldset
                        className="import-fields"
                        disabled={!!pending || busy}
                      >
                        <legend className="sr-only">修正第 {row.row} 行</legend>
                        {columns.map(([field, label]) => (
                          <div className="detail-edit-field" key={field}>
                            <label htmlFor={`import-${row.row}-${field}`}>
                              {label}
                            </label>
                            {field === 'title' || field === 'lead' ? (
                              <input
                                id={`import-${row.row}-${field}`}
                                value={row[field]}
                                onChange={(event) =>
                                  edit(row.row, field, event.target.value)
                                }
                              />
                            ) : (
                              <textarea
                                id={`import-${row.row}-${field}`}
                                rows={2}
                                value={row[field]}
                                onChange={(event) =>
                                  edit(row.row, field, event.target.value)
                                }
                              />
                            )}
                            {issues
                              ?.filter((issue) => issue.field === field)
                              .map((issue, index) => (
                                <small className="import-error" key={index}>
                                  {issue.message}
                                </small>
                              ))}
                          </div>
                        ))}
                      </fieldset>
                    </details>
                    {issues?.length ? (
                      <p className="import-error">
                        {issues
                          .map(
                            (issue) =>
                              `${importColumns[issue.field]} · ${issue.message}`,
                          )
                          .join('。')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {!pending && (
              <div className="form-actions">
                <Button
                  tag="button"
                  variant="outline"
                  loading={progress?.type === 'validating'}
                  disabled={
                    busy ||
                    progress?.type === 'parsing' ||
                    progress?.type === 'reading'
                  }
                  onClick={() => void validate(rows)}
                >
                  重新校验
                </Button>
                <Button
                  tag="button"
                  disabled={!passed || busy}
                  onClick={() => void submit()}
                >
                  整批提交入库
                </Button>
              </div>
            )}
          </section>
        )
      )}
    </section>
  );
}
