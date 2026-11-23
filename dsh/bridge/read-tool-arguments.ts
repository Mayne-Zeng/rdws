// §11.20.26 exact argument shape of the locked read, shared by the permit
// (parent), the FD4 body policy and the Host probe (which adds its own
// frozen-arguments check): {file_path[, offset][, limit]}.
export const readToolName = 'read';
export const readLimit = 2000;
// FD3 reply envelope: 64 KiB, with a 48 KiB cap on the actual JSON encoding
// of a page reply, judged before the page leaves.
export const readReplyLimit = 48 * 1024;
// Reserved relative prefix of a registered long-line segment identifier.
export const readSegmentPath = '.rdws-read/';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const argumentNames = ['file_path', 'offset', 'limit'];

export function readToolArguments(
  input: Record<string, unknown>,
  segment?: (input: Record<string, unknown>, id: string) => boolean,
): boolean {
  if (!(
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof input.file_path === 'string'
  ))
    return false;
  const names = Object.keys(input);
  if (
    names.length === 0 ||
    names.length > 3 ||
    !names.every((name) => argumentNames.includes(name))
  )
    return false;
  const path = input.file_path as string;
  if (
    path.length === 0 ||
    path.length > 1024 ||
    // Control characters (NUL, newlines, DEL) and backslashes never name a
    // repository file.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\\]/.test(path) ||
    path.startsWith('/')
  )
    return false;
  if (path.startsWith(readSegmentPath)) {
    const id = path.slice(readSegmentPath.length);
    // The registry check belongs to the parent (permit and FD4 policy);
    // the Host judges the identifier's shape only.
    if (!uuidPattern.test(id) || (segment && !segment(input, id))) return false;
  } else if (
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return false;
  for (const name of ['offset', 'limit'])
    if (
      name in input &&
      (!Number.isSafeInteger(input[name]) || Number(input[name]) < 1)
    )
      return false;
  return !('limit' in input) || Number(input.limit) <= readLimit;
}
