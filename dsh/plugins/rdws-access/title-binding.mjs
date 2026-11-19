import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const native = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const origins = new Map();
const calls = new WeakMap();
let ready = false;

export const loadNativeTitlePackage = (name) =>
  import(pathToFileURL(native.resolve(name)));
export const titleUnavailable = () =>
  new Error('Managed first-message title is unavailable');
export const setTitleReady = (value) => {
  ready = value;
};
export const titleCall = (options) => calls.get(options);

export function rememberTitleOrigin(sessionId, create) {
  if (!ready) return;
  for (const [id, active] of origins)
    if (active.expiresAt <= Date.now()) origins.delete(id);
  if (origins.has(sessionId) || origins.size >= 512) return;
  origins.set(sessionId, { ...create(), controller: new AbortController() });
}

export function cancelTitleOrigins(matches, { abortStream = true } = {}) {
  for (const [sessionId, origin] of origins) {
    if (!matches(origin, sessionId)) continue;
    origins.delete(sessionId);
    if (abortStream) origin.controller.abort();
    void origin.close().catch(() => {});
  }
}

export async function bindTitleCall(options, event, flush) {
  const origin = origins.get(options.sessionId);
  if (
    !ready ||
    !origin ||
    origin.expiresAt <= Date.now() ||
    origin.controller.signal.aborted ||
    event?.data.messageSeqs.length !== 1 ||
    event.data.messageSeqs[0] !== origin.sourceSeq ||
    event.data.messages[0]?.id !== options.messages[0]?.id ||
    event.data.route.provider !== options.provider ||
    event.data.route.model !== options.model
  )
    throw titleUnavailable();
  if (!(await flush())) throw titleUnavailable();
  const callId = randomUUID();
  const result = await origin.prepare(callId);
  if (
    !result ||
    typeof result.bindingId !== 'string' ||
    origin.controller.signal.aborted ||
    origins.get(options.sessionId) !== origin
  )
    throw titleUnavailable();
  const request = {
    ...options,
    signal: AbortSignal.any([options.signal, origin.controller.signal]),
  };
  calls.set(request, { id: callId, bindingId: result.bindingId });
  return request;
}
