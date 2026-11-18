import { importLimits } from '@rdws/contracts';
import type { ImportCells } from './requirement-import-file.ts';

const partLimit = 4 * 1024 * 1024;
const expandedLimit = 8 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++)
    index = (index >>> 1) ^ (index & 1 ? 0xedb88320 : 0);
  return index;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return ~crc >>> 0;
}

function zipCheck(condition: unknown): asserts condition {
  if (!condition) throw new Error('工作簿压缩结构不受支持或已损坏');
}
const virtualPackage = 'https://xlsx-package.invalid';
function validPart(part: string) {
  return (
    part.length <= 512 &&
    !/[\\\0]/u.test(part) &&
    part
      .split('/')
      .every((section) => section && section !== '.' && section !== '..')
  );
}

function archive(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (offset: number) => view.getUint16(offset, true);
  const dword = (offset: number) => view.getUint32(offset, true);
  const decode = new TextDecoder('utf-8', { fatal: true });
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (
    end >= earliest &&
    (dword(end) !== 0x06054b50 || end + 22 + word(end + 20) !== bytes.length)
  )
    end--;
  zipCheck(end >= earliest && word(end + 4) === 0 && word(end + 6) === 0);
  const count = word(end + 10),
    directory = dword(end + 16);
  zipCheck(
    count > 0 &&
      count <= 512 &&
      word(end + 8) === count &&
      directory + dword(end + 12) === end,
  );
  const entries = new Map<
    string,
    {
      method: number;
      local: number;
      start: number;
      compressed: number;
      size: number;
      crc: number;
    }
  >();
  let cursor = directory;
  for (let index = 0; index < count; index++) {
    zipCheck(
      cursor + 46 <= end &&
        dword(cursor) === 0x02014b50 &&
        word(cursor + 34) === 0,
    );
    const flags = word(cursor + 8),
      method = word(cursor + 10),
      crc = dword(cursor + 16);
    const compressed = dword(cursor + 20),
      size = dword(cursor + 24);
    const nameLength = word(cursor + 28),
      local = dword(cursor + 42);
    const next =
      cursor + 46 + nameLength + word(cursor + 30) + word(cursor + 32);
    zipCheck(
      next <= end && local + 30 <= directory && dword(local) === 0x04034b50,
    );
    zipCheck(
      (flags & ~0x080e) === 0 &&
        (method === 0 || method === 8) &&
        word(local + 6) === flags &&
        word(local + 8) === method,
    );
    const encoded = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decode.decode(encoded);
    const start = local + 30 + word(local + 26) + word(local + 28);
    zipCheck(
      word(local + 26) === nameLength &&
        start + compressed <= directory &&
        dword(cursor + 24) !== 0xffffffff,
    );
    zipCheck(
      encoded.every((value, offset) => bytes[local + 30 + offset] === value),
    );
    if (!(flags & 8))
      zipCheck(
        dword(local + 14) === crc &&
          dword(local + 18) === compressed &&
          dword(local + 22) === size,
      );
    zipCheck(
      validPart(name.endsWith('/') ? name.slice(0, -1) : name) &&
        !entries.has(name),
    );
    entries.set(name, { method, local, start, compressed, size, crc });
    cursor = next;
  }
  zipCheck(cursor === end);
  let previousEnd = 0;
  for (const entry of [...entries.values()].sort((a, b) => a.local - b.local)) {
    zipCheck(entry.local >= previousEnd);
    previousEnd = entry.start + entry.compressed;
  }

  let unpacked = 0;
  const cache = new Map<string, string>();
  return async (path: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const known = cache.get(path);
    if (known !== undefined) return known;
    const entry = entries.get(path);
    zipCheck(entry);
    if (entry.size > partLimit || unpacked + entry.size > expandedLimit)
      throw new Error('工作簿解压数据超过上限');
    const input = bytes.subarray(entry.start, entry.start + entry.compressed);
    let data: Uint8Array = input;
    if (entry.method === 8) {
      const stream = new Blob([new Uint8Array(input)])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const chunks: Uint8Array[] = [];
        let written = 0;
        for (;;) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          if (
            written + value.length > entry.size ||
            unpacked + written + value.length > expandedLimit
          )
            throw new Error('工作簿实际解压数据超过上限');
          chunks.push(value);
          written += value.length;
        }
        zipCheck(written === entry.size);
        data = new Uint8Array(written);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    zipCheck(data.length === entry.size && crc32(data) === entry.crc);
    if (unpacked + data.length > expandedLimit)
      throw new Error('工作簿解压数据超过上限');
    const xml = decode.decode(data);
    unpacked += data.length;
    cache.set(path, xml);
    return xml;
  };
}

const elements = (parent: Element, name: string) =>
  Array.from(parent.children).filter((child) => child.localName === name);
const child = (parent: Element, name: string) => elements(parent, name)[0];
function parseXml(xml: string, name: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('工作簿包含不支持的 XML 声明');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (
    parsed.documentElement.localName !== name ||
    parsed.querySelector('parsererror')
  )
    throw new Error('工作簿 XML 结构无效');
  return parsed.documentElement;
}

function resolveTarget(source: string, rel: Element) {
  const target = rel.getAttribute('Target') ?? '';
  if (
    !target ||
    rel.getAttribute('TargetMode') === 'External' ||
    /^(?:[A-Za-z][A-Za-z\d.+-]*:|\/\/)|[\\?#]/u.test(target)
  )
    throw new Error('工作簿关系须指向包内数据');
  const resolved = new URL(target, virtualPackage + '/' + source);
  const path = decodeURIComponent(resolved.pathname.slice(1));
  if (resolved.origin !== virtualPackage || !validPart(path))
    throw new Error('工作簿关系须指向包内数据');
  return path;
}

function richText(node: Element) {
  return Array.from(node.children)
    .map((part) =>
      part.localName === 't'
        ? part.textContent
        : part.localName === 'r'
          ? child(part, 't')?.textContent
          : '',
    )
    .join('');
}
function decodeText(text: string) {
  return text.replace(/_x([\da-f]{4})_/giu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function rowCells(
  sheet: Element,
  shared: string[],
  signal: AbortSignal,
  progress: (rows: number) => void,
) {
  const grid = child(sheet, 'sheetData');
  if (!grid) throw new Error('工作表缺少数据区');
  const elementsInGrid = elements(grid, 'row');
  if (elementsInGrid.length > 4096) throw new Error('工作表行结构超过读取上限');
  return (async () => {
    const rows: ImportCells[] = [];
    let row = 0,
      cellsSeen = 0,
      expanded = 0;
    const encoder = new TextEncoder();
    for (const [index, element] of elementsInGrid.entries()) {
      if (index % 16 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      const rowIndex = element.getAttribute('r');
      if (rowIndex && !/^\d+$/.test(rowIndex))
        throw new Error('工作表行坐标不正确');
      const nextRow = rowIndex ? Number(rowIndex) : row + 1;
      if (nextRow <= row || nextRow > 1048576)
        throw new Error('工作表行坐标不正确');
      row = nextRow;
      const cells: string[] = [];
      let column = -1;
      for (const cell of elements(element, 'c')) {
        if (++cellsSeen > 4096) throw new Error('工作表单元格超过读取上限');
        const ref = cell.getAttribute('r');
        let nextColumn = column + 1;
        if (ref) {
          const match = /^([A-Z]{1,3})(\d+)$/.exec(ref);
          if (!match || Number(match[2]) !== row)
            throw new Error(`第 ${row} 行的单元格坐标不正确`);
          nextColumn =
            [...match[1]!].reduce(
              (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
              0,
            ) - 1;
        }
        if (nextColumn <= column || nextColumn >= 128)
          throw new Error(`第 ${row} 行的列坐标超过读取范围或重复`);
        column = nextColumn;
        const type = cell.getAttribute('t');
        const text = child(cell, 'v')?.textContent;
        let value: string;
        if (child(cell, 'f'))
          throw new Error(
            `第 ${row} 行第 ${column + 1} 列含公式，请转换为文本值`,
          );
        if (type === 'inlineStr') {
          const inline = child(cell, 'is');
          value = inline ? richText(inline) : '';
        } else if (!text) value = '';
        else if (type === 's') {
          const mapped = /^\d+$/.test(text) ? shared[Number(text)] : undefined;
          if (mapped === undefined)
            throw new Error(`第 ${row} 行第 ${column + 1} 列的共享文本无效`);
          value = mapped;
        } else if (type === 'str') value = text;
        else throw new Error(`第 ${row} 行第 ${column + 1} 列须为文本`);
        value = decodeText(value);
        if (value.length > 16000 || /[\0\p{Surrogate}]/u.test(value))
          throw new Error(`第 ${row} 行第 ${column + 1} 列文字超限或无效`);
        expanded += encoder.encode(value).length;
        if (expanded > importLimits.bytes)
          throw new Error('工作表文本超过 2 MiB，请拆分后再导入');
        while (cells.length < column) cells.push('');
        cells.push(value);
      }
      if (cells.some((value) => value.trim())) {
        if (rows.length > importLimits.rows)
          throw new Error('每批最多导入 50 行，请拆分工作表');
        rows.push({ row, cells });
        progress(rows.length - 1);
      }
    }
    return rows;
  })();
}

export async function openWorkbook(bytes: Uint8Array, signal: AbortSignal) {
  const read = archive(bytes);
  async function relationships(path: string, signal: AbortSignal) {
    const rels = elements(
      parseXml(await read(path, signal), 'Relationships'),
      'Relationship',
    );
    if (rels.length > 256) throw new Error('工作簿关系数超过读取上限');
    return rels;
  }
  const root = await relationships('_rels/.rels', signal);
  const office = root.filter((rel) =>
    rel.getAttribute('Type')?.endsWith('/officeDocument'),
  );
  if (office.length !== 1) throw new Error('文件中的工作簿关系无效');
  const workbookPath = resolveTarget('', office[0]!);
  const workbook = parseXml(await read(workbookPath, signal), 'workbook');
  const directory = workbookPath.slice(0, workbookPath.lastIndexOf('/') + 1);
  const rels = await relationships(
    directory + '_rels/' + workbookPath.slice(directory.length) + '.rels',
    signal,
  );
  const byId = new Map(rels.map((rel) => [rel.getAttribute('Id'), rel]));
  if (byId.size !== rels.length || byId.has(null))
    throw new Error('工作簿关系标识无效');
  const shared = rels.find((rel) =>
    rel.getAttribute('Type')?.endsWith('/sharedStrings'),
  );
  let sharedStrings: string[] | undefined;
  const sheets = child(workbook, 'sheets');
  if (!sheets || sheets.children.length > 100)
    throw new Error('工作簿的工作表数量无效');
  const supported = elements(sheets, 'sheet').flatMap((sheet) => {
    const name = sheet.getAttribute('name');
    const id = Array.from(sheet.attributes).find(
      (attr) =>
        attr.localName === 'id' &&
        attr.namespaceURI?.endsWith('/relationships'),
    )?.value;
    const rel = id ? byId.get(id) : undefined;
    if (!name || !rel) throw new Error('工作表关系无效');
    if (!rel.getAttribute('Type')?.endsWith('/worksheet')) return [];
    const path = resolveTarget(workbookPath, rel);
    return [
      {
        name,
        read: async (signal: AbortSignal, progress: (rows: number) => void) => {
          if (!sharedStrings && shared) {
            const table = elements(
              parseXml(
                await read(resolveTarget(workbookPath, shared), signal),
                'sst',
              ),
              'si',
            );
            if (table.length > 20000)
              throw new Error('工作簿共享文本数超过读取上限');
            sharedStrings = table.map(richText);
          }
          const sheet = parseXml(await read(path, signal), 'worksheet');
          return rowCells(sheet, sharedStrings ?? [], signal, progress);
        },
      },
    ];
  });
  if (!supported.length) throw new Error('工作簿没有可导入的工作表');
  return supported;
}
