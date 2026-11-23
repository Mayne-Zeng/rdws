import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { bodyHash, isRecord } from '../../bridge/access.ts';

// The locked packages resolve from the pinned @deepseek-ai/dsh installation
// of the dsh workspace, not from this plugin's own dependencies.
const require = createRequire(import.meta.url);
const pinned = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const load = (name) =>
  import(pathToFileURL(pinned.resolve('@deepseek-ai/' + name)).href);

// §11.20.26 Read probe (hop 2 and 3 on the Host): acquires the locked read
// definition inside a probe scope that carries the managed file provider and
// a fixed working directory, registers that same object in the Agent scope
// with a step-time condition so it shadows the global name, requests the
// Read-specific single-use permit before execution, and gates the root guard
// on it. The package entry exports no read definition object, which is why
// the definition is taken from tools.get('read') after applying the plugin.

import {
  readLimit,
  readSegmentPath,
  readToolArguments as sharedReadToolArguments,
  readToolName,
} from '../../bridge/read-tool-arguments.ts';

export { readSegmentPath };
const routeFields = [
  'name',
  'agent',
  'parent',
  'toolSet',
  'token',
  'callId',
  'rootCallId',
  'arguments',
];

// The Host adds its own frozen-arguments check to the shared exact shape of
// the locked read and projects the three permitted fields.
export function readToolArguments(value) {
  if (!isRecord(value) || !Object.isFrozen(value)) return undefined;
  if (!sharedReadToolArguments(value)) return undefined;
  const { file_path, offset, limit } = value;
  return {
    file_path,
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

// Lines the locked read annotated as truncated: their numbers and the exact
// prefixes it displayed (the native marker is kept as is).
export function truncatedLines(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  for (const row of text.split('\n')) {
    const match = /^(\d+): (.*)$/.exec(row);
    const inner =
      match && /^(.*)\.\.\. \(line truncated to (\d+) chars\)$/.exec(match[2]);
    if (match && inner)
      found.push({
        line: Number(match[1]),
        prefix: inner[1],
        chars: Number(inner[2]),
      });
  }
  return found;
}

export function installReadToolProbe(ctx, deps) {
  const { currentStep, liveRun, service, config } = deps;
  let offered;
  let definition;
  let snapshot;
  // The registered segment the last read continued, when it was one.
  let segment;
  const claims = new WeakMap();
  const agents = new WeakMap();
  const calls = new WeakMap();
  const permits = new WeakMap();
  const starts = new WeakMap();
  const reportedResults = new WeakMap();
  // segment attempts and the registrations the parent confirmed.
  const counts = {
    stat: 0,
    pages: 0,
    segmentAttempts: 0,
    segments: 0,
    permits: 0,
    executed: 0,
  };

  function scopeBody(extra) {
    const run = offered;
    if (!run) throw new Error('RDWS read: no armed run');
    return {
      runId: run.runId,
      hostGeneration: run.hostGeneration,
      requirementId: run.requirementId,
      sessionId: run.sessionId,
      requestId: run.requestId,
      peerNonce: run.peerNonce,
      authSessionId: run.authSessionId,
      ...extra,
    };
  }

  // The managed file provider: a metadata request per file (the single
  // snapshot K) and one page request per page, all bound to the armed run.
  async function* pages(target, signal) {
    const start = starts.get(target);
    starts.delete(target);
    if (!start) throw new Error('RDWS read: file was not stated');
    let cursor = start.cursor;
    let snapshotId;
    for (;;) {
      signal.throwIfAborted();
      const page = await service(
        'worktree-read',
        scopeBody({ cursor }),
        signal,
      );
      if (
        !isRecord(page) ||
        typeof page.text !== 'string' ||
        typeof page.snapshotId !== 'string' ||
        page.sha256 !== start.sha256 ||
        (snapshotId !== undefined && page.snapshotId !== snapshotId)
      )
        throw new Error('RDWS read: file changed during read');
      snapshotId = page.snapshotId;
      snapshot = snapshotId;
      segment = start.path.startsWith(readSegmentPath)
        ? start.path.slice(readSegmentPath.length)
        : undefined;
      counts.pages++;
      yield page.text;
      if (typeof page.cursor !== 'string') return;
      cursor = page.cursor;
    }
  }
  const managed = {
    resolve: async (path) => {
      if (typeof path !== 'string' || path.length === 0)
        throw new Error('RDWS read: invalid path');
      return { targetKey: path, displayPath: '/workspace/' + path };
    },
    stat: async (target, signal) => {
      counts.stat++;
      const meta = await service(
        'worktree-stat',
        scopeBody({ path: target.targetKey }),
        signal,
      );
      if (
        !isRecord(meta) ||
        meta.type !== 'file' ||
        typeof meta.cursor !== 'string' ||
        typeof meta.sha256 !== 'string' ||
        typeof meta.size !== 'number'
      )
        throw new Error('RDWS read: file is not available');
      starts.set(target, { ...meta, path: target.targetKey });
      return { type: 'file', size: meta.size, version: meta.sha256 };
    },
    processPath: (target) => target.displayPath,
    readText: async (target, signal) => {
      const chunks = [];
      for await (const chunk of pages(target, signal)) chunks.push(chunk);
      return chunks.join('');
    },
    streamText: (target, signal) => pages(target, signal),
  };

  // Definition acquisition: apply the locked plugin in a scope that carries
  // the managed provider and the fixed working directory, then take
  // tools.get('read'). The probe scope owns its own tools service, so the
  // Host's registry only ever sees the Agent-scoped registration below.
  const ready = (async () => {
    const { Context } = await load('cordis');
    const scope = new Context();
    scope.provide('workingDirectory', { ensure: async () => '/workspace' });
    scope.provide('fs', managed);
    await scope.plugin((await load('dsh-system-prompt')).default, {
      personaPrefix: '',
      personaSuffix: '',
    });
    await scope.plugin((await load('dsh-tools')).default);
    // The package entry is the plugin namespace (apply/inject/name); it
    // exports no definition object.
    await scope.plugin(await load('dsh-tool-fs'), {
      read: true,
      readImage: false,
      write: false,
      edit: false,
      applyPatch: false,
      readStreamMinSize: config.readStreamMinSize,
    });
    const found = scope.tools.get('read');
    if (!found) throw new Error('RDWS read: locked read definition missing');
    return { definition: found, scope };
  })();
  ready.then(
    (acquired) => {
      definition = acquired.definition;
    },
    () => {},
  );

  function currentPermit(exec) {
    const permit = permits.get(exec);
    return (
      permit &&
      permit.expiresAt > Date.now() &&
      routeFields.every((key) => exec[key] === permit.route[key]) &&
      !exec.signal.aborted &&
      currentStep(exec.agent) === permit.step &&
      calls.get(exec.agent.session) === permit.call &&
      ctx.tools.executable(exec.name, exec.agent, exec.toolSet) ===
        definition &&
      permit
    );
  }

  function register(agent) {
    agent.ctx.tools.register(definition, {
      when: ({ agent: actual }) =>
        actual === agent &&
        offered !== undefined &&
        claims.get(agent)?.run === offered &&
        liveRun(offered),
    });
  }
  ctx.on(
    'agent/created',
    ({ agent }) => {
      agents.set(agent.session, agent);
      if (definition) register(agent);
      else
        void ready.then(
          () => register(agent),
          () => {},
        );
    },
    { global: true },
  );
  ctx.on(
    'session/event',
    (session, event) => {
      const agent = agents.get(session);
      if (agent && event.type === 'turn/start') claims.delete(agent);
      if (
        agent &&
        event.type === 'turn/end' &&
        claims.get(agent)?.turn === event.data.turn
      )
        claims.delete(agent);
      if (event.type === 'tool/call' && event.data.name === readToolName)
        calls.set(session, event);
      // Long-line continuation registration (§11.20.26 point 4): only the
      // native result of the read call this probe permitted, once per result
      // sequence; each line the locked read annotated as truncated is
      // reported with the prefix it actually displayed and the parent resolves
      // the byte offset.
      if (
        event.type === 'tool/result' &&
        Number.isSafeInteger(event.seq) &&
        snapshot !== undefined &&
        calls.get(session)?.data.callId === event.data.message?.toolCallId &&
        event.data.message?.isError !== true &&
        Array.isArray(event.data.message?.content) &&
        event.data.message.content.length === 1 &&
        event.data.message.content[0]?.type === 'text' &&
        typeof event.data.message.content[0].text === 'string'
      ) {
        const reported = reportedResults.get(session) ?? new Set();
        reportedResults.set(session, reported);
        if (!reported.has(event.seq)) {
          reported.add(event.seq);
          for (const { line, prefix } of truncatedLines(
            event.data.message.content[0].text,
          )) {
            counts.segmentAttempts++;
            void service(
              'read-segment-register',
              scopeBody({
                snapshotId: snapshot,
                line,
                prefix,
                ...(segment && { segment }),
              }),
            )
              .then(() => {
                counts.segments++;
              })
              .catch(() => {});
          }
        }
      }
    },
    { global: true },
  );
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const route = Object.fromEntries(
        routeFields.map((key) => [key, exec[key]]),
      );
      const outcome = await next();
      const args = readToolArguments(exec.arguments);
      if (
        outcome.kind !== 'allow' ||
        exec.name !== readToolName ||
        !args ||
        !exec.agent ||
        exec.parent !== undefined ||
        exec.rootCallId !== exec.callId ||
        !exec.toolSet ||
        exec.signal.aborted ||
        !routeFields.every((key) => exec[key] === route[key]) ||
        ctx.tools.executable(exec.name, exec.agent, exec.toolSet) !== definition
      )
        return outcome;
      const step = currentStep(exec.agent);
      const claim = claims.get(exec.agent);
      const call = calls.get(exec.agent.session);
      if (
        !step?.bindingId ||
        !claim ||
        claim.run !== offered ||
        step.runs.length !== 1 ||
        step.runs[0] !== offered ||
        claim.turn !== step.body.turn ||
        !call ||
        call.data.callId !== exec.callId ||
        call.data.turn !== claim.turn ||
        call.data.step !== step.body.modelStep.step
      )
        return outcome;
      const body = {
        ...step.body,
        authSessionId: offered.authSessionId,
        modelBindingId: step.bindingId,
        toolName: readToolName,
        toolCallId: exec.callId,
        toolCallSeq: call.seq,
        arguments: exec.arguments,
        deadline: Date.now() + 2000,
      };
      try {
        const permit = await service('read-tool-permit', body, exec.signal);
        if (
          permit?.digest === bodyHash(body) &&
          Number.isSafeInteger(permit.expiresAt) &&
          permit.expiresAt <= body.deadline
        ) {
          counts.permits++;
          permits.set(exec, {
            step,
            call,
            route,
            body,
            expiresAt: permit.expiresAt,
          });
        }
      } catch {
        permits.delete(exec);
      }
      return outcome;
    },
    { global: true },
  );

  return {
    definition: () => definition,
    ready,
    offer(run) {
      if (
        (offered && offered !== run) ||
        typeof run.authSessionId !== 'string' ||
        !run.authSessionId
      )
        return false;
      offered = run;
      return true;
    },
    claim(agent, run, turn) {
      const previous = claims.get(agent);
      claims.set(agent, {
        turn,
        run:
          run === offered && (previous?.turn !== turn || previous?.run === run)
            ? run
            : undefined,
      });
    },
    gate(exec) {
      if (!currentPermit(exec))
        return permits.has(exec) ? 'invalidated' : undefined;
      counts.executed++;
      for (const key of routeFields) {
        Object.defineProperty(exec, key, {
          value: exec[key],
          writable: false,
          configurable: false,
        });
      }
      return 'allow';
    },
    stats: () => ({ ...counts }),
    dispose: () => ready.then((acquired) => acquired.scope.fiber.dispose()),
  };
}
