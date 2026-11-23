import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord, onlyKeys } from '@rdws/dsh/access';
import { validProjectId } from '@rdws/dsh/web';
import { readToolArguments } from '@rdws/dsh/read-tool-arguments';

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
