import { readSegmentPath } from './read-tool-arguments.ts';

// §11.20.27 exact argument shapes of the four write tools, shared by the
// permit (parent), the FD4 body policy and the Host probe (which adds its
// own frozen-arguments check). "Write tool" means: only the writable session
// can obtain a permit. The path rule is the one of T06 safeRelativePath, so
// that a permitted path is never refused by T06: a repository-relative path
// up to 1024 bytes, no empty, "." or ".." segment, no control character
// (Unicode Cc or Cf), no backslash, no ".git" segment (case-insensitive) and
// no protected location. The module itself also refuses the reserved prefix
// of a registered long-line segment identifier.
export const writeToolNames = ['edit', 'write', 'bash', 'git'] as const;
export type WriteToolName = (typeof writeToolNames)[number];
// Edit: an existing regular UTF-8 file of at most 16 KiB, old_string and
// new_string of at most 8 KiB each, a result of at most 64 KiB.
export const editTargetLimit = 16 * 1024;
export const editStringLimit = 8 * 1024;
export const editResultLimit = 64 * 1024;
// Write: content of at most 24 KiB; an existing target of at most 16 KiB.
export const writeContentLimit = 24 * 1024;
export const writeExistingLimit = 16 * 1024;
// The FD3 request envelope.
export const writePermitEnvelopeLimit = 64 * 1024;
export const gitOperations = ['status', 'diff'] as const;
// The only command form of the first batch; the parent compares the command
// with the one registered for the write generation.
export const shellCommandPattern = /^node ([a-zA-Z0-9_.-]+\.test\.mjs)$/;

const controls = /[\p{Cc}\p{Cf}]/u;
const editKeys = ['file_path', 'old_string', 'new_string', 'replace_all'];
const writeKeys = ['file_path', 'content'];
const bashKeys = ['command', 'description'];

// Every protected location of T06 protectedReadPath: judged per path segment,
// case-insensitively, by exact name or by the listed prefix or suffix.
export function protectedWritePath(path: string) {
  return path
    .toLowerCase()
    .split('/')
    .some(
      (part) =>
        part === '.credentials.yaml' ||
        part === '.credentials.yml' ||
        part === '.ssh' ||
        part === '.gnupg' ||
        part === '.env' ||
        part === 'model.env' ||
        part.startsWith('.env.') ||
        part.endsWith('.pem') ||
        part.endsWith('.key') ||
        part === '.netrc' ||
        part === '.npmrc' ||
        part === '.git-credentials',
    );
}

export function writeToolPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    wellFormed(path) &&
    path.length > 0 &&
    path.trim().length > 0 &&
    path.length <= 1024 &&
    !controls.test(path) &&
    !path.includes('\\') &&
    !path.startsWith(readSegmentPath) &&
    !protectedWritePath(path) &&
    path
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

function exactKeys(input: Record<string, unknown>, keys: string[]) {
  const names = Object.keys(input);
  return names.every((name) => keys.includes(name));
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
// Every text argument must be a well-formed string: a lone surrogate would
// be written as U+FFFD by T06 and mis-match the locked tools (step 0, third
// precision item), so the three callers refuse it here, before any permit.
const text = (value: unknown): value is string =>
  typeof value === 'string' && wellFormed(value);
function wellFormed(value: string) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// The exact shape of one write tool call. `registered` decides whether a
// bash command is the command registered for the current write generation
// (compared character by character by the parent); without it no command is
// registered.
export function writeToolArguments(
  toolName: unknown,
  input: unknown,
  registered?: (command: string) => boolean,
): boolean {
  if (
    !writeToolNames.includes(toolName as WriteToolName) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    return false;
  const args = input as Record<string, unknown>;
  switch (toolName) {
    case 'edit':
      return (
        exactKeys(args, editKeys) &&
        text(args.file_path) &&
        writeToolPath(args.file_path) &&
        text(args.old_string) &&
        text(args.new_string) &&
        args.old_string.length > 0 &&
        args.old_string !== args.new_string &&
        bytes(args.old_string) <= editStringLimit &&
        bytes(args.new_string) <= editStringLimit &&
        (!('replace_all' in args) || typeof args.replace_all === 'boolean')
      );
    case 'write':
      return (
        exactKeys(args, writeKeys) &&
        text(args.file_path) &&
        writeToolPath(args.file_path) &&
        // An empty content is a legitimate write of an empty file.
        text(args.content) &&
        bytes(args.content) <= writeContentLimit
      );
    case 'bash':
      return (
        exactKeys(args, bashKeys) &&
        text(args.command) &&
        text(args.description) &&
        args.description.trim().length > 0 &&
        shellCommandPattern.test(args.command) &&
        registered !== undefined &&
        registered(args.command)
      );
    case 'git':
      if (exactKeys(args, ['operation']))
        return gitOperations.includes(
          args.operation as (typeof gitOperations)[number],
        );
      // §11.23 C1: the controlled commit is the only other git form;
      // every other key set is a refusal (N8).
      return gitCommitArguments(args) !== false;
    default:
      return false;
  }
}

// §11.23 C1: the explicit selected-scope list of one controlled commit:
// a non-empty bounded array of repository-relative paths (at most 512,
// each judged by the shared writeToolPath rule) and a message of at most
// 4 KiB of well-formed UTF-8. The permit, the FD4 projection and the T06
// admission all judge this shape through writeToolArguments below.
export const gitCommitPathsLimit = 512;
export const gitCommitMessageLimit = 4 * 1024;
const commitKeys = ['operation', 'paths', 'message'];

export function gitCommitArguments(
  input: unknown,
): { paths: string[]; message: string } | false {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const args = input as Record<string, unknown>;
  if (!exactKeys(args, commitKeys) || args.operation !== 'commit') return false;
  if (!Array.isArray(args.paths) || args.paths.length === 0) return false;
  if (args.paths.length > gitCommitPathsLimit) return false;
  const seen = new Set<string>();
  for (const path of args.paths) {
    if (!writeToolPath(path) || seen.has(path)) return false;
    seen.add(path);
  }
  if (!text(args.message) || bytes(args.message) > gitCommitMessageLimit)
    return false;
  return { paths: args.paths as string[], message: args.message };
}
// The replacement arithmetic of Edit, shared by the T06 worker, the parent
// and the Host: a literal replacement from left to right without
// overlapping, the count advancing past every match (the same arithmetic as
// the locked fs-local countOccurrences and split/join, applied to the raw
// text without any line-ending normalization).
export function literalEdit(
  before: string,
  edit: { old_string: string; new_string: string },
) {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = before.indexOf(edit.old_string, index);
    if (found === -1) break;
    count++;
    index = found + edit.old_string.length;
  }
  return {
    count,
    after: before.split(edit.old_string).join(edit.new_string),
  };
}

// The JSON encoding of the permit body (tool name and arguments) must fit
// the FD3 request envelope; control characters expand up to six times.
export function writePermitEnvelopeBytes(toolName: string, input: unknown) {
  return Buffer.byteLength(
    JSON.stringify({ toolName, arguments: input }),
    'utf8',
  );
}
