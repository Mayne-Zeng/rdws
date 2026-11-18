import * as Cordis from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as Jsx from 'react/jsx-runtime';
import * as Zod from 'zod';
import * as Store from '@deepseek-ai/dsh-client-store';
import type {
  ClientModuleLoader,
  DshWindow,
  WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    rdws: unknown;
  }
}
let serial: Promise<unknown> = Promise.resolve();
let active: { dispose: () => Promise<void> } | undefined;
export async function readSessionHistory(
  requirementId: string,
  sessionId: string,
  positions: { throughSeq?: number; beforeSeq?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(positions))
    if (value !== undefined) query.set(key, String(value));
  const response = await fetch(
    `/api/requirements/${encodeURIComponent(requirementId)}/sessions/${encodeURIComponent(sessionId)}/history?${query}`,
    { cache: 'no-store', signal },
  );
  if (!response.ok)
    throw Object.assign(new Error('会话历史读取失败，请重试'), {
      status: response.status,
    });
  return response.json() as Promise<{
    cursor: number;
    beforeSeq: number;
    hasMore: boolean;
    events: {
      seq: number;
      type: string;
      label: string;
      text?: string;
      outcome?: string;
    }[];
  }>;
}
export function connectNative(requirementId: string, signal: AbortSignal) {
  const task = serial
    .catch(() => {})
    .then(async () => {
      await active?.dispose();
      signal.throwIfAborted();
      const prefix = `/api/dsh/${requirementId}/native/`;
      const response = await fetch(`/api/dsh/${requirementId}/bootstrap`, {
        signal,
      });
      if (!response.ok) throw new Error('无法连接需求会话');
      const payload = (await response.json()) as {
        graph: WebBootGraph;
        injections: {
          kind: string;
          text?: string;
          src?: string;
          name?: string;
          value?: unknown;
        }[];
      };
      const root = new Cordis.Context();
      let disposed = false;
      let generation = crypto.randomUUID();
      const load = (path: string) =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = prefix + path.replace(/^\//, '');
          script.onload = () => {
            script.remove();
            resolve();
          };
          script.onerror = () => {
            script.remove();
            reject(new Error('原生客户端资源加载失败'));
          };
          document.head.append(script);
        });
      const win = window as unknown as DshWindow & {
        __DSH_TRANSPORT__?: unknown;
      };
      try {
        for (const injection of payload.injections) {
          signal.throwIfAborted();
          if (injection.kind === 'script' && injection.text) {
            const script = document.createElement('script');
            script.text = injection.text;
            document.head.append(script);
            script.remove();
          } else if (injection.kind === 'script-src' && injection.src)
            await load(injection.src);
          else if (
            injection.kind === 'global' &&
            injection.name === '__DSH_BOOT__'
          )
            Reflect.set(window, injection.name, injection.value);
        }
        win.__DSH_TRANSPORT__ = {
          fetch: (input: string | URL, init: RequestInit) =>
            fetch(prefix + String(input).replace(/^\//, ''), {
              ...init,
              headers: {
                ...init.headers,
                'x-rdws-client-generation': generation,
              },
            }),
          createWebSocket: () => {
            generation = crypto.randomUUID();
            return new WebSocket(
              `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${prefix}api/remote.mux?generation=${generation}`,
            );
          },
          streamBaseUrl: location.origin,
          loadBundle: load,
        };
        const facade = win.__ModuleLoader__;
        if (!facade) throw new Error('原生启动模块未加载');
        const modules = facade.create({
          boot: payload.graph,
          staticModules: {
            react: React,
            'react/jsx-runtime': Jsx,
            'react-dom': ReactDom,
            'react-dom/client': ReactDomClient,
            '@deepseek-ai/cordis': Cordis,
            zod: Zod,
            '@deepseek-ai/dsh-client-store': Store,
          },
          loadBundle: load,
        }) as ClientModuleLoader;
        const native = (await modules.import(
          '@deepseek-ai/dsh-client-modules',
          import.meta.url,
          {},
        )) as {
          parseBootManifest: (boot: unknown) => { plugins: { id: string }[] };
        };
        const manifest = native.parseBootManifest(payload.graph);
        const names = new Set([
          '@deepseek-ai/dsh-client-modules',
          '@deepseek-ai/dsh-client-connection',
          '@deepseek-ai/dsh-typert-registry',
          '@deepseek-ai/dsh-api-gateway',
          '@deepseek-ai/dsh-api-remotes',
          '@deepseek-ai/dsh-client-file-upload',
          '@deepseek-ai/dsh-api-session-controller',
        ]);
        await root.plugin(Loader);
        root.loader.internal = modules as never;
        await modules.entries.start(root.loader, {
          ...manifest,
          plugins: manifest.plugins.filter((row) => names.has(row.id)),
        } as never);
        await root.loader.await();
        const sessions = root.get('sessions') as ISessions | undefined;
        if (!sessions || !root.get('remote') || !root.get('connection'))
          throw new Error('原生会话服务未就绪');
        signal.throwIfAborted();
        const runtime = {
          sessions,
          root,
          history(
            sessionId: string,
            positions: { throughSeq?: number; beforeSeq?: number } = {},
            signal?: AbortSignal,
          ) {
            return readSessionHistory(
              requirementId,
              sessionId,
              positions,
              signal,
            );
          },
          async reconnect() {
            const connection = root.get('connection') as {
              reconnect: () => void;
              generation: {
                getSnapshot: () => unknown;
                subscribe: (listener: () => void) => () => void;
              };
            };
            const previous = connection.generation.getSnapshot();
            await new Promise<void>((resolve, reject) => {
              let stop = () => {};
              const timer = setTimeout(() => {
                stop();
                reject(new Error('重新连接超时'));
              }, 12000);
              stop = connection.generation.subscribe(() => {
                const current = connection.generation.getSnapshot();
                if (current && current !== previous) {
                  clearTimeout(timer);
                  stop();
                  resolve();
                }
              });
              connection.reconnect();
            });
          },
          async dispose() {
            if (disposed) return;
            disposed = true;
            await root.fiber.dispose();
          },
        };
        active = runtime;
        return runtime;
      } catch (error) {
        await root.fiber.dispose();
        throw error;
      }
    });
  serial = task;
  return task;
}
export type NativeRuntime = Awaited<ReturnType<typeof connectNative>>;
