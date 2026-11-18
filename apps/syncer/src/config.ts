import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export class MirrorConfigError extends Error {}

export function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export const safeId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
const fileName = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(id);
const refName = (ref: string) =>
  /^refs\/heads\/[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,191}$/.test(ref) &&
  !ref.includes('..') &&
  ref
    .split('/')
    .every(
      (part) =>
        part &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !part.endsWith('.lock'),
    );

export function owned(stat: Stats, privateMode = false) {
  if (
    stat.uid !== process.getuid?.() ||
    stat.mode & (privateMode ? 0o077 : 0o022)
  )
    throw new MirrorConfigError('Runtime file ownership or mode is invalid');
}

export async function safeDirectory(
  root: string,
  parts: string[],
  create = false,
) {
  if (!isAbsolute(root))
    throw new MirrorConfigError('Runtime root must be absolute');
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    if (create && part) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = await lstat(path);
    if (!stat.isDirectory())
      throw new MirrorConfigError('Runtime path is not a directory');
    owned(stat);
  }
  return path;
}

export async function readOwned(
  path: string,
  max: number,
  privateMode = false,
) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    owned(stat, privateMode);
    if (!stat.isFile() || stat.size > max)
      throw new MirrorConfigError('Runtime file type or size is invalid');
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max)
      throw new MirrorConfigError('Runtime file exceeds its limit');
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export interface RegisteredRepository {
  id: string;
  name: string;
  url: string;
  baselineRef: string;
  targetName: string;
  targetRef: string;
  signersFile: string;
  credentialFile: string;
  caFile?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(row: Record<string, unknown>, keys: string[]) {
  return Object.keys(row).every((key) => keys.includes(key));
}

function displayName(value: string) {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 80 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

export function parseRepositoryUrl(value: string) {
  const url = new URL(value);
  if (
    url.href !== value ||
    url.protocol !== 'https:' ||
    !/^https:\/\/[a-zA-Z0-9.:[\]-]+\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)+[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.git$/.test(
      value,
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MirrorConfigError(
      'A canonical GitLab HTTPS repository URL is required',
    );
  return url.href;
}

export async function repositories(root: string, project: string) {
  if (!safeId(project)) throw new MirrorConfigError('Invalid project ID');
  let dir: string;
  let raw: Buffer;
  try {
    dir = await safeDirectory(root, ['config', 'projects', project]);
    raw = await readOwned(join(dir, 'repositories.json'), 32_768);
  } catch (error) {
    if (isMissing(error))
      return { entries: [] as RegisteredRepository[], dir: '' };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw.toString());
    if (!Array.isArray(value) || value.length > 16) throw new Error();
    const ids = new Set<string>();
    const entries = value.map((item: unknown): RegisteredRepository => {
      const required = [
        'id',
        'name',
        'url',
        'baselineRef',
        'targetName',
        'targetRef',
        'signersFile',
        'credentialFile',
      ] as const;
      if (
        !record(item) ||
        !exactFields(item, [...required, 'caFile']) ||
        required.some((key) => typeof item[key] !== 'string') ||
        (item.caFile !== undefined && typeof item.caFile !== 'string')
      )
        throw new Error();
      const row = item as unknown as RegisteredRepository;
      if (
        !safeId(row.id) ||
        ids.has(row.id) ||
        !displayName(row.name) ||
        !displayName(row.targetName) ||
        !refName(row.baselineRef) ||
        !refName(row.targetRef) ||
        !fileName(row.signersFile) ||
        !fileName(row.credentialFile) ||
        (row.caFile !== undefined && !fileName(row.caFile))
      )
        throw new Error();
      ids.add(row.id);
      return { ...row, url: parseRepositoryUrl(row.url) };
    });
    return { entries, dir };
  } catch {
    throw new MirrorConfigError('Repository configuration is invalid');
  }
}

export async function readTrust(dir: string, row: RegisteredRepository) {
  const signers = await readOwned(join(dir, row.signersFile), 65_536);
  const ca = row.caFile
    ? await readOwned(join(dir, row.caFile), 131_072)
    : undefined;
  return { signers, ca };
}

export async function credential(root: string, row: RegisteredRepository) {
  const dir = await safeDirectory(root, ['secrets']);
  try {
    const value: unknown = JSON.parse(
      (await readOwned(join(dir, row.credentialFile), 4096, true)).toString(),
    );
    if (
      !record(value) ||
      !exactFields(value, ['url', 'username', 'token']) ||
      value.url !== row.url ||
      typeof value.username !== 'string' ||
      typeof value.token !== 'string' ||
      !/^[a-zA-Z0-9_.@+-]{1,128}$/.test(value.username) ||
      !/^[a-zA-Z0-9_.~+/-]{1,1024}$/.test(value.token)
    )
      throw new Error();
    return (
      'Authorization: Basic ' +
      Buffer.from(value.username + ':' + value.token).toString('base64')
    );
  } catch {
    throw new MirrorConfigError(
      'Read credential is unavailable or does not match the repository',
    );
  }
}
