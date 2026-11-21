import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  createWriteHandoff,
  WriteHandoffScope,
} from '../../apps/server/src/modules/write-handoff.ts';

type Broker = Awaited<ReturnType<typeof createWriteHandoff>>;
type Page = Awaited<ReturnType<Broker['readWorktree']>>;
type Target = { targetKey: string; displayPath: string };
type Result = { content: { type: string; text?: string }[]; isError?: boolean };

export async function nativeWorktreeReadFixture(
  broker: Broker,
  reader: WriteHandoffScope,
  repositoryId: string,
  files: readonly string[],
) {
  const installed = createRequire(resolve('dsh/package.json'));
  const native = createRequire(
    installed.resolve('@deepseek-ai/dsh/package.json'),
  );
  const load = (tool: string) =>
    import(pathToFileURL(native.resolve('@deepseek-ai/' + tool)).href);
  const { Context } = await load('cordis');
  const ctx = new Context();
  const starts = new WeakMap<Target, Page>();
  const reads = { text: 0, stream: 0, continuations: 0 };
  const fetchPage = (path: string, signal: AbortSignal) =>
    broker.readWorktree(reader, { repositoryId, path }, undefined, signal);
  async function* chunks(target: Target, signal: AbortSignal) {
    let page = starts.get(target);
    starts.delete(target);
    if (!page) throw new Error('Unobserved fixture file');
    const current = await fetchPage(target.targetKey, signal);
    if (page.sha256 !== current.sha256)
      throw new Error('Fixture file changed during read');
    const snapshotId = page.snapshotId;
    while (true) {
      signal.throwIfAborted();
      yield page.text;
      if (!page.cursor) break;
      reads.continuations++;
      page = await broker.readWorktree(
        reader,
        { cursor: page.cursor },
        undefined,
        signal,
      );
      if (page.snapshotId !== snapshotId)
        throw new Error('Invalid fixture continuation');
    }
  }
  try {
    ctx.provide('workingDirectory', { ensure: async () => '/workspace' });
    ctx.provide('fs', {
      resolve: async (path: string) => {
        if (!files.includes(path)) throw new Error('Fixture path unavailable');
        return { targetKey: path, displayPath: '/workspace/' + path };
      },
      stat: async (target: Target, signal: AbortSignal) => {
        const page = await fetchPage(target.targetKey, signal);
        starts.set(target, page);
        return { type: 'file', size: page.totalBytes, version: page.sha256 };
      },
      processPath: (target: Target) => target.displayPath,
      readText: async (target: Target, signal: AbortSignal) => {
        reads.text++;
        const decoded: string[] = [];
        for await (const chunk of chunks(target, signal)) decoded.push(chunk);
        return decoded.join('');
      },
      streamText: (target: Target, signal: AbortSignal) => {
        reads.stream++;
        return chunks(target, signal);
      },
    });
    await ctx.plugin((await load('dsh-system-prompt')).default, {
      personaPrefix: '',
      personaSuffix: '',
    });
    await ctx.plugin((await load('dsh-tools')).default);
    await ctx.plugin(await load('dsh-tool-executor-native'));
    await ctx.plugin(await load('dsh-tool-fs'), {
      read: true,
      readImage: false,
      write: false,
      edit: false,
      applyPatch: false,
      readStreamMinSize: 16 * 1024,
    });
    return {
      schemas: ctx.tools
        .schemas()
        .map((s: { name: string }) => s.name) as string[],
      reads,
      async call(
        args: Record<string, unknown>,
        name = 'read',
      ): Promise<Result> {
        const reply = await ctx.tools.execute({
          signal: AbortSignal.timeout(15000),
          calls: [
            {
              type: 'tool-call',
              id: randomUUID(),
              name,
              arguments: JSON.stringify(args),
            },
          ],
        });
        return reply.results[0].result;
      },
      dispose: () => ctx.fiber.dispose() as Promise<void>,
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
