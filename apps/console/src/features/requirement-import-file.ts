import {
  importColumns,
  importLimits,
  type RequirementImportField,
  type RequirementImportRow,
} from '@rdws/contracts';
import { openWorkbook } from './requirement-import-xlsx.ts';

export interface ImportSheet {
  name: string;
  read: (
    signal: AbortSignal,
    progress: (rows: number) => void,
  ) => Promise<RequirementImportRow[]>;
}
export interface ImportCells {
  row: number;
  cells: string[];
}

async function readFile(
  file: File,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  if (file.size > importLimits.bytes)
    throw new Error('文件超过 2 MiB，请拆分后再导入');
  const reader = file.stream().getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.length;
      if (bytes > importLimits.bytes)
        throw new Error('文件超过 2 MiB，请拆分后再导入');
      parts.push(value);
      progress(bytes);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const fileBytes = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      fileBytes.set(part, offset);
      offset += part.length;
    }
    return fileBytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function nonEmpty(row: string[]) {
  let end = row.length;
  while (end && !row[end - 1]?.trim()) end--;
  return row.slice(0, end);
}

function toImportRows(rows: ImportCells[]): RequirementImportRow[] {
  const [header, ...rest] = rows;
  if (!header || !rest.length) throw new Error('文件没有可导入的需求行');
  const byName = new Map<string, RequirementImportField>(
    Object.entries(importColumns).map(([key, name]) => [
      name,
      key as RequirementImportField,
    ]),
  );
  const columns = nonEmpty(header.cells).map((name, index) => {
    const key = byName.get(name.trim());
    if (!key)
      throw new Error(
        `第 ${header.row} 行第 ${index + 1} 列不是导入模板中的表头`,
      );
    return key;
  });
  if (new Set(columns).size !== columns.length)
    throw new Error(`第 ${header.row} 行有重复表头`);
  if (!columns.includes('title') || !columns.includes('lead'))
    throw new Error('表头须包含需求标题和开发负责人');
  return rest.map(({ row, cells }) => {
    if (nonEmpty(cells).length > columns.length)
      throw new Error(`第 ${row} 行有超出表头的数据`);
    const bad = cells.findIndex((value) => /[\0\p{Surrogate}]/u.test(value));
    if (bad >= 0) throw new Error(`第 ${row} 行第 ${bad + 1} 列文字无效`);
    const result: RequirementImportRow = {
      row,
      title: '',
      description: '',
      acceptance: '',
      lead: '',
      managers: '',
      developers: '',
      testers: '',
      tasks: '',
    };
    for (const [index, field] of columns.entries())
      result[field] = cells[index] ?? '';
    return result;
  });
}

function showParsedProgress(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, 0);
    });
    function stop() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function csvRows(
  bytes: Uint8Array,
  signal: AbortSignal,
  progress: (rows: number) => void,
) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('CSV 须使用 UTF-8 编码');
  }
  const rows: ImportCells[] = [];
  let line = 1,
    firstLine = 1,
    field = '',
    cells: string[] = [];
  let quoted = false,
    closedQuote = false;
  function finishField() {
    cells.push(field);
    if (cells.length > 32) throw new Error(`第 ${firstLine} 行字段数过多`);
    field = '';
    closedQuote = false;
  }
  function finishRow() {
    finishField();
    if (nonEmpty(cells).length) {
      if (rows.length > importLimits.rows)
        throw new Error('每批最多导入 50 行，请拆分文件');
      rows.push({ row: firstLine, cells });
      progress(rows.length - 1);
    }
    cells = [];
    firstLine = ++line;
  }
  let lastYield = 0,
    firstRowShown = false;
  for (let index = 0; index < text.length; index++) {
    if (index - lastYield >= 8192) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      lastYield = index;
    }
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (
          character === '\n' ||
          (character === '\r' && text[index + 1] !== '\n')
        )
          line++;
      }
    } else if (character === ',') finishField();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      finishRow();
      if (!firstRowShown && rows.length === 2) {
        firstRowShown = true;
        await showParsedProgress(signal);
      }
    } else if (character === '"' && !field && !closedQuote) quoted = true;
    else if (closedQuote || character === '"')
      throw new Error(`第 ${line} 行引号位置不正确`);
    else field += character;
    if (field.length > 16000)
      throw new Error(`第 ${firstLine} 行有字段超过读取长度上限`);
    if (line > 1048576) throw new Error('CSV 原始行号超过读取上限');
  }
  if (quoted) throw new Error(`第 ${firstLine} 行引号未闭合`);
  if (field || closedQuote || cells.length) finishRow();
  if (!firstRowShown && rows.length > 1) await showParsedProgress(signal);
  signal.throwIfAborted();
  return rows;
}

export async function openImportFile(
  file: File,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<ImportSheet[]> {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'csv' && extension !== 'xlsx')
    throw new Error('请选择 CSV 或 .xlsx 工作簿');
  const bytes = await readFile(file, signal, progress);
  if (extension === 'csv')
    return [
      {
        name: file.name,
        read: async (signal, rows) =>
          toImportRows(await csvRows(bytes, signal, rows)),
      },
    ];
  return (await openWorkbook(bytes, signal)).map((sheet) => ({
    ...sheet,
    read: async (signal, rows) => toImportRows(await sheet.read(signal, rows)),
  }));
}
