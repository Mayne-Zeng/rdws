import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { validProjectId } from '@rdws/dsh/web';
import { readToolArguments } from '@rdws/dsh/read-tool-arguments';
import {
  writeToolArguments,
  writeToolNames,
} from '@rdws/dsh/write-tool-arguments';
import { digestOf } from './business.ts';
import { scrubOutput, type OutputPolicy } from './shell-output-handling.ts';

const maximumPolicyBytes = 4096;
const unavailable = () => new Error('Main model egress policy is not usable');

export function mainModelPolicy(value: unknown) {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'projectId',
      'provider',
      'model',
      'destination',
      'firstMessageTitle',
    ]) ||
    (value.firstMessageTitle !== undefined &&
      typeof value.firstMessageTitle !== 'boolean') ||
    typeof value.projectId !== 'string' ||
    !validProjectId(value.projectId) ||
    typeof value.provider !== 'string' ||
    !value.provider ||
    value.provider.length > 160 ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 160 ||
    typeof value.destination !== 'string'
  )
    throw unavailable();
  let url: URL;
  try {
    url = new URL(value.destination);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== 'https:' ||
    url.href !== value.destination ||
    !url.pathname.endsWith('/chat/completions') ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    url.username ||
    url.password
  )
    throw unavailable();
  return Object.freeze({
    projectId: value.projectId,
    provider: value.provider,
    model: value.model,
    destination: url.href,
    ...(value.firstMessageTitle === true
      ? { firstMessageTitle: true as const }
      : {}),
  });
}

export type MainModelPolicy = ReturnType<typeof mainModelPolicy>;

export async function readMainModelPolicy(path: string) {
  try {
    if (!isAbsolute(path)) throw unavailable();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 2 ||
        stat.size > maximumPolicyBytes
      )
        throw unavailable();
      const bytes = Buffer.alloc(maximumPolicyBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw unavailable();
      return mainModelPolicy(
        JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
      );
    } finally {
      await file.close();
    }
  } catch {
    throw unavailable();
  }
}

const samplingKeys = [
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'thinking_token_budget',
];
const textKeys = [
  'reasoning_effort',
  'prompt_cache_key',
  'prompt_cache_retention',
];
const mainKeys = [
  'model',
  'messages',
  'stream',
  'stream_options',
  'store',
  'tools',
  'enable_thinking',
  ...samplingKeys,
  ...textKeys,
];
const roles = ['system', 'developer', 'user', 'assistant'];
const messageKeys = ['role', 'content', 'reasoning_content'];
const fixtureName = 'rdws_authority_probe';
const fixtureDescription =
  'Return the fixed result of the isolated permission probe';
const fixtureResult = 'RDWS fixture worktree state: ok';

export type FixtureToolProjection =
  { kind: 'declaration' } | { kind: 'history'; callId: string };
// §11.20.26 FD4 body projection of the armed Read run (hop 6): the locked
// read is the only declared tool, and every tool exchange in the history is
// one read call with the exact argument shape (a registered path or segment)
// immediately followed by its own result. The FD4 first write itself is the
// existing mechanism and is not changed.
export type ReadToolProjection = {
  kind: 'read';
  segment: (input: Record<string, unknown>, id: string) => boolean;
};
// One declared tool as the Host registered it: the function object of the
// declaration ({name, description, parameters}), compared word for word.
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};
// §11.20.27 FD4 body projection of a run armed with write tools (hop 6):
// the declared set is exactly the armed set in its fixed order (read, then
// the write tools), each declaration equal to the definition the Host
// registered; every tool exchange in the history is one call of a declared
// name with the exact argument shape, immediately followed by its own
// result. The FD4 first write itself is the existing mechanism.
export type WriteToolProjection = {
  kind: 'tools';
  // The declared set of this run: exactly what the Host registered for it
  // (read alone for a run without the write generation).
  tools: readonly ToolDefinition[];
  segment: (input: Record<string, unknown>, id: string) => boolean;
  // The prefix policy of the output handling. Every tool result is scanned
  // once more here; a hit is masked and counted, and the joint tests assert
  // the count is zero (a nonzero count means the parent's own handling
  // failed). The policy is never absent: before the locations of the run
  // are resolved the conservative default (account home and node) stands in
  // and the first request of a run carries no tool result anyway.
  redaction: OutputPolicy;
  redactions: number;
  countRedaction?: () => void;
};
// History calls may name any tool the session ever had: a session that lost
// the write generation still carries its earlier exchanges, which are
// projections of results that already happened and grant nothing now.
const historyNames = ['read', ...writeToolNames] as const;
export const conservativeRedaction = (): OutputPolicy => ({
  prefixes: [
    { value: process.env.HOME ?? '', replacement: '<home>' },
    { value: process.execPath, replacement: '<node>' },
  ].filter(({ value }) => value.length > 0),
});
// The fixed order of the armed set.
export const declaredToolOrder = [
  'read',
  'edit',
  'write',
  'bash',
  'git',
] as const;
export const toolResultLimit = 256 * 1024;

// The declarations the Host registered for the armed run: exactly the
// armed names, in the order the Host serializes them (by name; the armed
// priority order is declaredToolOrder), each a plain {name, description,
// parameters} function object of at most 16 KiB of JSON.
export function toolDefinitions(value: unknown, armed: readonly string[]) {
  const expected = declaredToolOrder
    .filter((name) => armed.includes(name))
    .sort();
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every(
      (entry) =>
        isRecord(entry) &&
        onlyKeys(entry, ['name', 'description', 'parameters']) &&
        isRecord(entry.parameters),
    )
  )
    return;
  const tools = value as ToolDefinition[];
  if (!tools.every(({ name }, index) => name === expected[index])) return;
  if (tools.some((tool) => Buffer.byteLength(JSON.stringify(tool)) > 16 * 1024))
    return;
  return tools.map((tool) => structuredClone(tool));
}

function toolDeclarations(value: unknown, tools: readonly ToolDefinition[]) {
  if (!Array.isArray(value) || value.length !== tools.length) return false;
  // The Host serializes the visible tools by name; the reported order is
  // held to that same order, so any other order is refused here.
  return value.every(
    (entry, index) =>
      isRecord(entry) &&
      onlyKeys(entry, ['type', 'function']) &&
      entry.type === 'function' &&
      isRecord(entry.function) &&
      digestOf(entry.function) === digestOf(tools[index]),
  );
}

// The exact argument shape of one history call, by name. A bash call in
// the history is judged by its closed form only: which command was
// registered belonged to the permit of that moment, not to the projection.
function toolCallArguments(name: string, args: Record<string, unknown>) {
  // A read in the history is judged by its shape: a segment identifier
  // that expired (the registry lives 60 seconds) is still the projection
  // of a result the session already received; the registry belongs to the
  // permit of a new call.
  if (name === 'read') return readToolArguments(args);
  if (!writeToolNames.includes(name as (typeof writeToolNames)[number]))
    return false;
  return writeToolArguments(
    name,
    args,
    name === 'bash' ? () => true : undefined,
  );
}

function toolHistory(messages: unknown[], projection: WriteToolProjection) {
  const names = historyNames as readonly string[];
  let index = 0;
  while (index < messages.length) {
    const entry = messages[index];
    if (!isRecord(entry) || entry.tool_calls === undefined) {
      if (!textMessage(entry)) return false;
      index++;
      continue;
    }
    if (
      !onlyKeys(entry, ['role', 'content', 'tool_calls']) ||
      entry.role !== 'assistant' ||
      (entry.content !== null && entry.content !== '') ||
      !Array.isArray(entry.tool_calls) ||
      entry.tool_calls.length !== 1
    )
      return false;
    const call = entry.tool_calls[0];
    if (
      !isRecord(call) ||
      !onlyKeys(call, ['id', 'type', 'function']) ||
      typeof call.id !== 'string' ||
      !call.id ||
      call.type !== 'function' ||
      !isRecord(call.function) ||
      !onlyKeys(call.function, ['name', 'arguments']) ||
      typeof call.function.name !== 'string' ||
      !names.includes(call.function.name) ||
      typeof call.function.arguments !== 'string'
    )
      return false;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return false;
    }
    if (!isRecord(args) || !toolCallArguments(call.function.name, args))
      return false;
    const result = messages[index + 1];
    if (
      !isRecord(result) ||
      !onlyKeys(result, ['role', 'tool_call_id', 'content']) ||
      result.role !== 'tool' ||
      result.tool_call_id !== call.id ||
      typeof result.content !== 'string' ||
      result.content.length > toolResultLimit
    )
      return false;
    // The backstop of the output handling (W18): the same scan over every
    // result; a hit is masked here and counted. The scan is never skipped.
    const scrubbed = scrubOutput(result.content, projection.redaction);
    if (scrubbed.text !== result.content) {
      result.content = scrubbed.text;
      projection.countRedaction?.();
    }
    index += 2;
  }
  return true;
}
const readName = 'read';
const readDescription =
  'Read a UTF-8 text file and return line-numbered content.';
const readResultLimit = 256 * 1024;

function readDeclaration(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    !onlyKeys(value[0], ['type', 'function']) ||
    value[0].type !== 'function' ||
    !isRecord(value[0].function)
  )
    return false;
  const fn = value[0].function;
  if (
    !onlyKeys(fn, ['name', 'description', 'parameters']) ||
    fn.name !== readName ||
    fn.description !== readDescription ||
    !isRecord(fn.parameters) ||
    !onlyKeys(fn.parameters, [
      'type',
      'properties',
      'required',
      'additionalProperties',
    ]) ||
    fn.parameters.type !== 'object' ||
    !isRecord(fn.parameters.properties) ||
    !('file_path' in fn.parameters.properties) ||
    !Object.keys(fn.parameters.properties).every((key) =>
      ['file_path', 'offset', 'limit'].includes(key),
    )
  )
    return false;
  return (
    fn.parameters.required === undefined ||
    (Array.isArray(fn.parameters.required) &&
      fn.parameters.required.length === 1 &&
      fn.parameters.required[0] === 'file_path')
  );
}

function readHistory(
  messages: unknown[],
  segment: ReadToolProjection['segment'],
) {
  let index = 0;
  while (index < messages.length) {
    const entry = messages[index];
    if (!isRecord(entry) || entry.tool_calls === undefined) {
      if (!textMessage(entry)) return false;
      index++;
      continue;
    }

    if (
      !onlyKeys(entry, ['role', 'content', 'tool_calls']) ||
      entry.role !== 'assistant' ||
      (entry.content !== null && entry.content !== '') ||
      !Array.isArray(entry.tool_calls) ||
      entry.tool_calls.length !== 1
    )
      return false;
    const call = entry.tool_calls[0];
    if (
      !isRecord(call) ||
      !onlyKeys(call, ['id', 'type', 'function']) ||
      typeof call.id !== 'string' ||
      !call.id ||
      call.type !== 'function' ||
      !isRecord(call.function) ||
      !onlyKeys(call.function, ['name', 'arguments']) ||
      call.function.name !== readName ||
      typeof call.function.arguments !== 'string'
    )
      return false;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return false;
    }
    if (!isRecord(args) || !readToolArguments(args, segment)) return false;
    const result = messages[index + 1];
    if (
      !isRecord(result) ||
      !onlyKeys(result, ['role', 'tool_call_id', 'content']) ||
      result.role !== 'tool' ||
      result.tool_call_id !== call.id ||
      typeof result.content !== 'string' ||
      result.content.length > readResultLimit
    )
      return false;
    index += 2;
  }
  return true;
}

function fixtureDeclaration(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    !onlyKeys(value[0], ['type', 'function']) ||
    value[0].type !== 'function' ||
    !isRecord(value[0].function)
  )
    return false;
  const fn = value[0].function;
  return (
    onlyKeys(fn, ['name', 'description', 'parameters']) &&
    fn.name === fixtureName &&
    fn.description === fixtureDescription &&
    isRecord(fn.parameters) &&
    onlyKeys(fn.parameters, ['type', 'properties', 'additionalProperties']) &&
    fn.parameters.type === 'object' &&
    fn.parameters.additionalProperties === false &&
    isRecord(fn.parameters.properties) &&
    Object.keys(fn.parameters.properties).length === 0
  );
}

function fixtureHistory(messages: unknown[], callId: string) {
  const start = messages.findIndex(
    (message) => isRecord(message) && message.tool_calls !== undefined,
  );
  const assistant = messages[start];
  const result = messages[start + 1];
  if (
    !isRecord(assistant) ||
    !onlyKeys(assistant, ['role', 'content', 'tool_calls']) ||
    assistant.role !== 'assistant' ||
    (assistant.content !== null && assistant.content !== '') ||
    !Array.isArray(assistant.tool_calls) ||
    assistant.tool_calls.length !== 1 ||
    !isRecord(result) ||
    !onlyKeys(result, ['role', 'tool_call_id', 'content']) ||
    result.role !== 'tool' ||
    result.tool_call_id !== callId ||
    result.content !== fixtureResult
  )
    return false;
  const call = assistant.tool_calls[0];
  return (
    isRecord(call) &&
    onlyKeys(call, ['id', 'type', 'function']) &&
    call.id === callId &&
    call.type === 'function' &&
    isRecord(call.function) &&
    onlyKeys(call.function, ['name', 'arguments']) &&
    call.function.name === fixtureName &&
    call.function.arguments === '{}' &&
    messages.slice(0, start).every(textMessage) &&
    messages.slice(start + 2).every(textMessage)
  );
}

function textMessage(entry: unknown) {
  return (
    isRecord(entry) &&
    onlyKeys(entry, messageKeys) &&
    typeof entry.role === 'string' &&
    roles.includes(entry.role) &&
    (entry.reasoning_content === undefined ||
      typeof entry.reasoning_content === 'string') &&
    (typeof entry.content === 'string' ||
      (entry.content === null && entry.role === 'assistant') ||
      (Array.isArray(entry.content) &&
        entry.content.every(
          (part: unknown) =>
            isRecord(part) &&
            onlyKeys(part, ['type', 'text']) &&
            part.type === 'text' &&
            typeof part.text === 'string',
        )))
  );
}

export function prepareMainModelBody(
  body: Buffer,
  model: string,
  fixture?: FixtureToolProjection,
  read?: ReadToolProjection,
  write?: WriteToolProjection,
) {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body),
    );
    if (
      !isRecord(value) ||
      !onlyKeys(value, mainKeys) ||
      value.model !== model ||
      value.stream !== true ||
      (value.store !== undefined && value.store !== false) ||
      (value.enable_thinking !== undefined &&
        typeof value.enable_thinking !== 'boolean') ||
      (fixture?.kind === 'declaration'
        ? !fixtureDeclaration(value.tools)
        : write
          ? !toolDeclarations(value.tools, write.tools)
          : read
            ? !readDeclaration(value.tools)
            : value.tools !== undefined &&
              (!Array.isArray(value.tools) || value.tools.length > 0)) ||
      (value.stream_options !== undefined &&
        (!isRecord(value.stream_options) ||
          !onlyKeys(value.stream_options, ['include_usage']) ||
          typeof value.stream_options.include_usage !== 'boolean')) ||
      !samplingKeys.every(
        (key) => value[key] === undefined || Number.isFinite(value[key]),
      ) ||
      !textKeys.every(
        (key) => value[key] === undefined || typeof value[key] === 'string',
      ) ||
      !Array.isArray(value.messages) ||
      value.messages.length === 0 ||
      (fixture?.kind === 'history'
        ? !fixtureHistory(value.messages, fixture.callId)
        : write
          ? !toolHistory(value.messages, write)
          : read
            ? !readHistory(value.messages, read.segment)
            : !value.messages.every(textMessage))
    )
      return;
    return Buffer.from(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export function prepareTitleModelBody(body: Buffer, model: string) {
  const projected = prepareMainModelBody(body, model);
  if (!projected) return;
  const request = JSON.parse(projected.toString('utf8')) as {
    messages: { role: string }[];
    max_completion_tokens?: number;
    max_tokens?: number;
  };
  const budget = request.max_completion_tokens ?? request.max_tokens;
  if (
    request.messages.every(
      ({ role }) => role === 'system' || role === 'user',
    ) &&
    request.messages.filter(({ role }) => role === 'user').length === 1 &&
    Number.isInteger(budget) &&
    budget! > 0 &&
    budget! <= 4096
  )
    return projected;
}
