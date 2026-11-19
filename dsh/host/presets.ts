import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../bridge/access.ts';

type Reference = {
  kind: 'plugin' | 'skill' | 'mcp';
  reference: string;
  revision: string;
};
export type ReleasedCapability = Reference & {
  sha256: string;
  modulePath: string;
};
export type PresetSelection = {
  templateId: string;
  revision: number;
  capabilities: Reference[];
};
type PresetDefinition = {
  id: string;
  projectId: string;
  requirementId: string;
  templateId: string;
  revision: number;
  capabilities: (Reference & { sha256: string })[];
};

export const capabilityRelease: readonly ReleasedCapability[] = [];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const idPattern = /^rdws-demand-v1-[0-9a-f]{64}$/;
export const isDemandPreset = (id: unknown): id is string =>
  typeof id === 'string' && idPattern.test(id);
const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const referenceKey = ({ kind, reference, revision }: Reference) =>
  JSON.stringify([kind, reference, revision]);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function sync(path: string, directory = false) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await file.stat();
    if (directory ? !entry.isDirectory() : !entry.isFile())
      throw new Error('Invalid path for preset synchronization');
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readBounded(path: string, max: number, privateMode = false) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await file.stat();
    if (
      !entry.isFile() ||
      entry.size > max ||
      entry.mode & (privateMode ? 0o077 : 0o022) ||
      (privateMode && entry.uid !== process.getuid?.())
    )
      throw new Error('Invalid preset file');
    const bytes = Buffer.alloc(entry.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== entry.size) throw new Error('Preset file size changed');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export class DemandPresets {
  private readonly entries = new Map<string, ReleasedCapability>();
  constructor(
    private readonly runtimeHome: string,
    readonly projectId: string,
    release: readonly ReleasedCapability[],
  ) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectId))
      throw new Error('Invalid project for demand presets');
    for (const entry of release) {
      const key = referenceKey(entry);
      if (
        this.entries.has(key) ||
        !sha256.test(entry.sha256) ||
        !isAbsolute(entry.modulePath)
      )
        throw new Error('Invalid capability release');
      this.entries.set(key, { ...entry });
    }
  }

  private async directory(publish = false) {
    let path = await realpath(this.runtimeHome);
    for (const part of ['runtime', 'presets', 'project-' + this.projectId]) {
      const parent = path;
      path = join(path, part);
      if (publish)
        await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
          if (errorCode(error) !== 'EEXIST') throw error;
        });
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & (part === 'runtime' ? 0o022 : 0o077)
      )
        throw new Error('Invalid preset directory');
      if (publish) await sync(parent, true);
    }
    return path;
  }

  definition(
    requirementId: string,
    selection: PresetSelection,
  ): PresetDefinition {
    if (
      !uuid.test(requirementId) ||
      !uuid.test(selection.templateId) ||
      !Number.isSafeInteger(selection.revision) ||
      selection.revision < 1 ||
      !Array.isArray(selection.capabilities) ||
      selection.capabilities.length > 64
    )
      throw new Error('Invalid preset selection');
    const keys = selection.capabilities.map(referenceKey).sort();
    if (new Set(keys).size !== keys.length)
      throw new Error('Duplicate preset capability');
    const capabilities = keys.map((key) => {
      const entry = this.entries.get(key);
      if (!entry) throw new Error('Capability is absent from the release');
      const { kind, reference, revision, sha256 } = entry;
      return { kind, reference, revision, sha256 };
    });
    const content = {
      projectId: this.projectId,
      requirementId,
      templateId: selection.templateId,
      revision: selection.revision,
      capabilities,
    };
    return {
      id: 'rdws-demand-v1-' + hash(JSON.stringify(content)),
      ...content,
    };
  }

  async read(id: string, requirementId: string) {
    if (!isDemandPreset(id)) throw new Error('Invalid preset ID');
    const path = join(await this.directory(), id + '.json');
    const stored = JSON.parse(
      (await readBounded(path, 48 * 1024, true)).toString(),
    ) as unknown;
    if (!isRecord(stored) || stored.requirementId !== requirementId)
      throw new Error('Invalid preset scope');
    const definition = this.definition(
      stored.requirementId,
      stored as unknown as PresetSelection,
    );
    if (
      definition.id !== id ||
      JSON.stringify(stored) !== JSON.stringify(definition)
    )
      throw new Error('Stored preset does not match the release');
    return definition;
  }

  async publish(definition: PresetDefinition) {
    if (
      definition.id !==
        this.definition(definition.requirementId, definition).id ||
      definition.projectId !== this.projectId
    )
      throw new Error('Invalid preset definition');
    const directory = await this.directory(true);
    const path = join(directory, definition.id + '.json');
    const draft = path + '.' + randomUUID();
    const file = await open(draft, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(definition));
        await file.sync();
      } finally {
        await file.close();
      }
      await link(draft, path).catch((error: unknown) => {
        if (errorCode(error) !== 'EEXIST') throw error;
      });
      await sync(path);
      await sync(directory, true);
      await this.read(definition.id, definition.requirementId);
    } finally {
      await unlink(draft);
    }
  }

  async plugins(definition: PresetDefinition) {
    return Promise.all(
      definition.capabilities.map(async (reference, index) => {
        const entry = this.entries.get(referenceKey(reference));
        if (
          !entry ||
          entry.sha256 !== reference.sha256 ||
          (await realpath(entry.modulePath)) !== entry.modulePath
        )
          throw new Error('Released capability bytes do not match');
        const source = await readBounded(entry.modulePath, 2 * 1024 * 1024);
        if (hash(source) !== entry.sha256)
          throw new Error('Released capability bytes do not match');
        const url = pathToFileURL(entry.modulePath);
        url.searchParams.set('rdws-release', entry.sha256);
        return { id: `capability-${index}`, name: url.href, source };
      }),
    );
  }
}
