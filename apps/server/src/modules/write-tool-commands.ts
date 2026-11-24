import { shellCommandPattern } from '@rdws/dsh/write-tool-arguments';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';

type Broker = Pick<
  ReturnType<typeof createOwnedWriteHandoff>,
  'readWorktreeBytes'
>;
export type RegisteredCommand = {
  command: string;
  sha256: string;
  repositoryId: string;
};

// The only command form the first batch registers: scripts.test of the
// requirement tree's package.json, parsed as JSON.
export function parseTestCommand(text: string) {
  let scripts: unknown;
  try {
    ({ scripts } = JSON.parse(text) as { scripts?: unknown });
  } catch {
    return undefined;
  }
  const test =
    scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as { test?: unknown }).test
      : undefined;
  return typeof test === 'string' && shellCommandPattern.test(test)
    ? test
    : undefined;
}

// §11.20.27 W6: the command set of a write generation. When a generation
// becomes the confirmed holding (acquire and takeover alike) the parent
// reads package.json of the requirement tree once through the managed
// read-only entry and registers the command parsed from scripts.test
// together with the SHA-256 of the file, bound to that generation. Every
// Shell permit reads the file again and compares the digest: a mismatch,
// an unreadable file or no registration is zero permit. A new generation
// registers again; a registration never carries over.
// The registry is bounded: a generation's entry lives while some holder
// may still verify against it, and the oldest go first.
export const maxRegisteredCommands = 64;

export function createWriteCommands(broker: Broker) {
  const registered = new Map<string, RegisteredCommand>();
  const pending = new Map<string, Promise<RegisteredCommand | undefined>>();
  const live = {
    read: (scope: WriteHandoffScope, repositoryId: string) =>
      broker.readWorktreeBytes(
        scope,
        { repositoryId, path: 'package.json' },
        () => {},
        undefined,
        () => true,
      ),
  };

  function confirm(
    scope: WriteHandoffScope,
    generation: string,
    repositoryId: string,
  ) {
    const done = registered.get(generation) ?? pending.get(generation);
    if (done) return done;
    const work: Promise<RegisteredCommand | undefined> = live
      .read(scope, repositoryId)
      .then(({ sha256, bytes }) => {
        const command = parseTestCommand(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (!command) return undefined;
        const entry = { command, sha256, repositoryId };
        while (registered.size >= maxRegisteredCommands)
          registered.delete(registered.keys().next().value!);
        registered.set(generation, entry);
        return entry;
      })
      .catch(() => undefined)
      .finally(() => pending.delete(generation));
    pending.set(generation, work);
    return work;
  }

  // The registered command of a generation, when the file still has the
  // registered digest. The read is bounded by the permit request: the
  // signal is the remaining time of that request and assertCurrent its
  // liveness; neither is extended for this read.
  async function verify(
    scope: WriteHandoffScope,
    generation: string,
    repositoryId: string,
    assertCurrent: () => void = () => {},
    signal?: AbortSignal,
  ): Promise<RegisteredCommand | undefined> {
    const entry = registered.get(generation);
    if (!entry || entry.repositoryId !== repositoryId) return undefined;
    try {
      assertCurrent();
      const { sha256 } = await broker.readWorktreeBytes(
        scope,
        { repositoryId, path: 'package.json' },
        assertCurrent,
        signal,
        () => true,
      );
      assertCurrent();
      return sha256 === entry.sha256 ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    confirm,
    verify,
    registered: (generation: string) => registered.get(generation),
    size: () => registered.size,
  };
}
export type WriteCommands = ReturnType<typeof createWriteCommands>;
