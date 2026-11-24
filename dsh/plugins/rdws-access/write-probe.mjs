import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { bodyHash, isRecord } from '../../bridge/access.ts';
import {
  literalEdit,
  writeToolArguments as sharedWriteToolArguments,
} from '../../bridge/write-tool-arguments.ts';

// The locked packages resolve from the pinned @deepseek-ai/dsh installation
// of the dsh workspace, not from this plugin's own dependencies.
const require = createRequire(import.meta.url);
const pinned = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const load = (name) =>
  import(pathToFileURL(pinned.resolve('@deepseek-ai/' + name)).href);

// §11.20.27 Write probe (hop 2 and 3 on the Host). A segment: the file
// tools edit and write. B segment: the locked bash tool over a managed
// shell provider and the platform git tool, both through the same permit
// and job channel. The locked definitions are acquired inside a probe scope
// that carries the managed providers (no sandbox mode, so the locked tools
// request no escalation: the confinement is the permit, the Broker and
// T06), registered in the Agent scope with a step-time condition, the
// write-specific single-use permit is requested before execution, the root
// guard is gated on it, and the registered declarations are reported to the
// parent for the FD4 projection. The provider methods drive the permitted
// job over FD3 (begin, status, output); for a file tool the after text is
// derived here from the call and the bytes before and must hash to the
// parent's digest; for Shell and Git the parent's handled output is handed
// to the locked renderer (bash) or rendered with the same vocabulary (git).

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
const fileNames = ['edit', 'write'];
const shellNames = ['bash', 'git'];
const toolNames = [...fileNames, ...shellNames];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The Host adds its own frozen-arguments check to the shared exact shape of
// the locked tools and projects the permitted fields. The registration of a
// bash command is judged by the parent; the Host judges the shape and the
// closed form only.
export function writeToolCall(name, value) {
  if (
    !toolNames.includes(name) ||
    !isRecord(value) ||
    !Object.isFrozen(value) ||
    !sharedWriteToolArguments(
      name,
      value,
      name === 'bash' ? () => true : undefined,
    )
  )
    return undefined;
  if (name === 'write')
    return { file_path: value.file_path, content: value.content };
  if (name === 'bash')
    return { command: value.command, description: value.description };
  if (name === 'git') return { operation: value.operation };
  const { file_path, old_string, new_string } = value;
  return {
    file_path,
    old_string,
    new_string,
    ...(value.replace_all !== undefined && {
      replace_all: value.replace_all,
    }),
  };
}

const terminal = ['ok', 'failed', 'aborted', 'unknown'];
const refusalCodes = {
  limit: ['FS_TOO_LARGE', 'is over the limit of this stage'],
  'not-found': ['FS_EDIT_NOT_FOUND', 'was not found in'],
  ambiguous: ['FS_AMBIGUOUS_EDIT', 'matched more than once in'],
  'not-utf8': ['FS_NOT_TEXT', 'is not UTF-8 text'],
  invalid: ['FS_IO_ERROR', 'could not be edited'],
  'not-started': ['FS_ABORTED', 'was not started'],
  aborted: ['FS_ABORTED', 'was cancelled before it ran'],
  rejected: ['FS_PERMISSION_DENIED', 'was refused'],
  file: ['FS_IO_ERROR', 'could not be written'],
};

// The platform git tool renders with the vocabulary of the locked bash
// renderResult: the output, a marked stderr section, then the deadline,
// stop and exit markers; exit 0 has no exit marker.
// What the model is told about a Shell or Git call that did not finish: the
// wording follows what actually happened. A command that ran but whose
// result cannot be given (the output policy was unavailable), or one whose
// result could not be confirmed, must not read as "not executed" — the
// model would simply run it again.
export function shellRefusalMessage(name, output) {
  const reason = output.reason ?? output.state;
  if (reason === 'output-policy-unavailable')
    return `RDWS ${name}: the command ran, but its result cannot be given (${reason})`;
  if (output.outcome === 'unknown' || output.state === 'unknown')
    return `RDWS ${name}: the command may have run; its result could not be confirmed (${reason})`;
  return `RDWS ${name}: the call was not executed (${reason})`;
}

export function renderGitOutput(output) {
  let body = output.stdout.text;
  const err = output.stderr.text;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';
    body += '[stderr]\n' + err;
  }
  if (body.length === 0) body = '(no output)';
  const markers = [];
  if (output.timedOut)
    markers.push('[timed out after ' + output.timeoutMs + 'ms]');
  if (output.stopped !== undefined)
    markers.push('[stopped: ' + output.stopped + ']');
  else if (output.exitCode !== null && output.exitCode !== 0)
    markers.push('[exit code: ' + output.exitCode + ']');
  if (markers.length === 0) return body;
  if (!body.endsWith('\n')) body += '\n';
  return body + markers.join('\n');
}

export function installWriteToolProbe(ctx, deps) {
  const { currentStep, liveRun, service, config, after } = deps;
  // §11.20.27 B-1: every armed run of the BFF, by run id, bounded.
  const offered = new Map();
  // The runs armed with Shell and Git, by run id: a run armed with the
  // file tools alone never declares them because another run was.
  const shellRuns = new Set();
  const reports = new Map();
  const maxArmedRuns = 32;
  let FsError;
  const definitions = new Map();
  const claims = new WeakMap();
  const agents = new WeakMap();
  const calls = new WeakMap();
  const permits = new WeakMap();
  // The permitted job of an execution, reached from the provider through
  // the very AbortSignal the locked tool hands to it.
  const bySignal = new WeakMap();
  const counts = {
    definitions: 0,
    permits: 0,
    executed: 0,
    applied: 0,
    refused: 0,
    unknown: 0,
  };

  function scopeBody(extra, run) {
    if (!run) throw new Error('RDWS write: no armed run');
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

  const unknown = (displayPath, detail) =>
    new FsError(
      `RDWS write: the result of "${displayPath}" is unknown (${detail}); read the file again to verify it`,
      'FS_IO_ERROR',
    );

  async function permitted(signal, name) {
    const job = bySignal.get(signal);
    if (!job || job.name !== name)
      throw new FsError(
        `RDWS write: the ${name} call was not permitted`,
        'FS_PERMISSION_DENIED',
      );
    return job;
  }

  // Drives the permitted job: begin once, wait for a terminal state, take
  // the output.
  async function run(output) {
    const body = { ...output.body, jobId: output.jobId };
    const signal = output.signal;
    const begin = await service('write-tool-begin', body, signal);
    if (!isRecord(begin) || begin.accepted !== true)
      throw new Error('RDWS write: the job was not accepted');
    let state;
    for (;;) {
      signal.throwIfAborted();
      const status = await service('write-tool-status', body, signal);
      if (!isRecord(status) || typeof status.state !== 'string')
        throw new Error('RDWS write: no state');
      if (terminal.includes(status.state)) {
        state = status.state;
        break;
      }
      // The status poll is an FD3 round trip with a login and session check
      // at the parent: the same interval as the fixture probe.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const result = await service(
      'write-tool-output',
      scopeBody({ jobId: output.jobId }, output.run),
      signal,
    );
    if (!isRecord(result)) throw new Error('RDWS write: no output');
    return { state, result };
  }

  async function drive(job, target, signal) {
    const { state, result: output } = await run({
      body: job.body,
      jobId: job.jobId,
      run: job.run,
      signal,
    });
    if (state === 'ok' && output.outcome === 'applied') {
      const before = Buffer.from(
        typeof output.before === 'string' ? output.before : '',
        'base64',
      );
      let afterText;
      let replacements;
      if (job.name === 'write') afterText = job.args.content;
      else {
        const edit = literalEdit(before.toString('utf8'), {
          old_string: job.args.old_string,
          new_string: job.args.new_string,
        });
        if (
          edit.count === 0 ||
          (edit.count > 1 && job.args.replace_all !== true) ||
          output.replacements !== edit.count
        )
          throw unknown(target.displayPath, 'an edit the Host refuses');
        afterText = edit.after;
        replacements = edit.count;
      }
      const after = Buffer.from(afterText, 'utf8');
      const digest = isRecord(output.after) ? output.after : undefined;
      if (
        !digest ||
        digest.sha256 !== sha256(after) ||
        digest.size !== after.length
      )
        throw unknown(target.displayPath, 'the digest after the write differs');
      counts.applied++;
      const existed = output.existed === true;
      const beforeText = existed ? before.toString('utf8') : null;
      return job.name === 'write'
        ? {
            operation: existed ? 'update' : 'create',
            before: beforeText,
            after: afterText,
          }
        : { before: beforeText, after: afterText };
    }
    if (state === 'failed' && output.outcome === 'refused') {
      counts.refused++;
      const [code, detail] = refusalCodes[output.reason] ?? refusalCodes.file;
      throw new FsError(
        `cannot write "${target.displayPath}": the file ${detail}`,
        code,
      );
    }
    counts.unknown++;
    throw unknown(
      target.displayPath,
      output.outcome === 'unknown' ? output.reason : state,
    );
  }

  // Shell and Git: the parent's handled output becomes the canonical
  // result of the locked bash renderer (the continuation identifier rides
  // in the locked truncation marker as the full output location).
  async function driveShell(job, signal) {
    counts.executed++;
    const { result: output } = await run({
      body: job.body,
      jobId: job.jobId,
      run: job.run,
      signal,
    });
    if (output.outcome !== 'finished') {
      counts.refused++;
      throw new FsError(
        shellRefusalMessage(job.name, output),
        'FS_PERMISSION_DENIED',
      );
    }
    const stream = (value) => ({
      text: typeof value?.text === 'string' ? value.text : '',
      truncated: value?.truncated === true,
      ...(value?.spillPath ? { spillPath: value.spillPath } : {}),
    });
    return {
      exitCode: output.exitCode,
      signal: null,
      timedOut: output.timedOut === true,
      aborted: false,
      timeoutMs: output.timeoutMs,
      stdout: stream(output.stdout),
      stderr: stream(output.stderr),
      ...(output.stopped !== undefined && { stopped: output.stopped }),
      handled: output.handled ?? { prefixes: 0, credentials: 0 },
    };
  }

  // The managed providers of the probe scope. The file provider needs no
  // stat and advertises no sandbox mode; the shell provider receives the
  // locked bash spec and drives the permitted job.
  const managed = {
    resolve: async (path) => {
      if (typeof path !== 'string' || path.length === 0)
        throw new FsError('RDWS write: invalid path', 'FS_NOT_FOUND');
      return { targetKey: path, displayPath: '/workspace/' + path };
    },
    processPath: (target) => target.displayPath,
    writeText: async (target, content, intent, signal) =>
      drive(await permitted(signal, 'write'), target, signal),
    editText: async (target, edit, intent, signal) => {
      const job = await permitted(signal, 'edit');
      if (
        edit.oldString !== job.args.old_string ||
        edit.newString !== job.args.new_string ||
        edit.replaceAll !== (job.args.replace_all === true)
      )
        throw unknown(target.displayPath, 'the edit differs from the call');
      return drive(job, target, signal);
    },
  };
  const managedShell = {
    resolve: (spec) => ({ ...spec }),
    execute: async (spec) => {
      const job = await permitted(spec.signal, 'bash');
      if (spec.command !== job.args.command)
        throw new FsError(
          'RDWS bash: the command differs from the call',
          'FS_PERMISSION_DENIED',
        );
      const result = driveShell(job, spec.signal);
      return { result: () => result };
    },
  };

  const ready = (async () => {
    const [{ Context }, fs, tools] = await Promise.all([
      load('cordis'),
      load('dsh-fs'),
      load('dsh-tools'),
    ]);
    FsError = fs.FsError;
    const scope = new Context();
    scope.provide('workingDirectory', { ensure: async () => '/workspace' });
    scope.provide('fs', managed);
    // An empty shell environment: the managed DSH_* variables never enter
    // the request, and the managed shell offers no sandbox mode.
    scope.provide('shell', managedShell);
    scope.provide('shellEnv', { collect: () => ({}) });
    await scope.plugin((await load('dsh-system-prompt')).default, {
      personaPrefix: '',
      personaSuffix: '',
    });
    await scope.plugin((await load('dsh-tools')).default);
    await scope.plugin(await load('dsh-tool-fs'), {
      read: true,
      readImage: false,
      write: true,
      edit: true,
      applyPatch: false,
      readStreamMinSize: config.readStreamMinSize,
    });
    await scope.plugin(await load('dsh-tool-bash'), {
      enableRunInBackground: false,
      promoteOnTimeout: false,
    });
    // The platform git tool: a fixed read-only query through the locked
    // defineTool, so it takes the same native pipeline as the locked tools.
    scope.tools.register(
      tools.defineTool({
        name: 'git',
        description:
          'Show the working tree status or the diff of the tracked changes of this requirement tree (read-only; status or diff).',
        parameters: {
          operation: {
            type: 'string',
            required: true,
            enum: ['status', 'diff'],
            description: 'The fixed query: status or diff.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              operation: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const job = await permitted(exec.signal, 'git');
          if (args.operation !== job.args.operation)
            throw new Error('RDWS git: the operation differs from the call');
          return {
            operation: args.operation,
            text: renderGitOutput(await driveShell(job, exec.signal)),
          };
        },
      }),
    );
    // read is declared by the Read probe of the same run; its definition
    // is taken here only to be reported with the others.
    for (const name of ['read', 'edit', 'write', 'bash', 'git']) {
      const found = scope.tools.get(name);
      if (!found)
        throw new Error('RDWS write: locked ' + name + ' definition missing');
      definitions.set(name, found);
    }
    return { scope };
  })();
  ready.then(
    () => {},
    () => {},
  );

  function armedNames(run) {
    return run && shellRuns.has(run.runId) ? toolNames : fileNames;
  }

  function currentPermit(exec) {
    const permit = permits.get(exec);
    const definition = definitions.get(exec.name);
    return (
      permit &&
      definition &&
      armedNames(permit.run).includes(exec.name) &&
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

  function register(agent, name) {
    agent.ctx.tools.register(definitions.get(name), {
      when: ({ agent: actual }) => {
        if (actual !== agent) return false;
        const claimed = claims.get(agent)?.run;
        // Shell and Git appear only for a run armed with them.
        return (
          !!claimed &&
          offered.has(claimed.runId) &&
          armedNames(claimed).includes(name) &&
          liveRun(claimed)
        );
      },
    });
  }
  // The Read probe registers first, so the declared order of a run is by
  // name (bash, edit, git, read, write).
  const registered = Promise.all([ready, after]).then(() => undefined);
  // Every tool of the probe is registered when the agent is created; the
  // Shell and Git tools are visible only from the moment the run is armed
  // with them (the condition is evaluated at step time).
  function registerAll(agent) {
    for (const name of toolNames) register(agent, name);
  }
  ctx.on(
    'agent/created',
    ({ agent }) => {
      agents.set(agent.session, agent);
      void registered.then(
        () => registerAll(agent),
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
      if (event.type === 'tool/call' && toolNames.includes(event.data.name))
        calls.set(session, event);
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
      const args = writeToolCall(exec.name, exec.arguments);
      // The tools this run was armed with decide what may be permitted.
      const claimedRun = exec.agent ? claims.get(exec.agent)?.run : undefined;
      if (
        outcome.kind !== 'allow' ||
        !args ||
        !armedNames(claimedRun).includes(exec.name) ||
        !exec.agent ||
        exec.parent !== undefined ||
        exec.rootCallId !== exec.callId ||
        !exec.toolSet ||
        exec.signal.aborted ||
        !routeFields.every((key) => exec[key] === route[key]) ||
        !definitions.has(exec.name) ||
        ctx.tools.executable(exec.name, exec.agent, exec.toolSet) !==
          definitions.get(exec.name)
      )
        return outcome;
      const step = currentStep(exec.agent);
      const claim = claims.get(exec.agent);
      const call = calls.get(exec.agent.session);
      if (
        !step?.bindingId ||
        !claim ||
        !offered.has(claim.run.runId) ||
        step.runs.length !== 1 ||
        step.runs[0] !== claim.run ||
        claim.turn !== step.body.turn ||
        !call ||
        call.data.callId !== exec.callId ||
        call.data.turn !== claim.turn ||
        call.data.step !== step.body.modelStep.step
      )
        return outcome;
      const body = {
        ...step.body,
        authSessionId: claim.run.authSessionId,
        modelBindingId: step.bindingId,
        toolName: exec.name,
        toolCallId: exec.callId,
        toolCallSeq: call.seq,
        arguments: exec.arguments,
        deadline: Date.now() + 2000,
      };
      try {
        const permit = await service('write-tool-permit', body, exec.signal);
        if (
          permit?.digest === bodyHash(body) &&
          Number.isSafeInteger(permit.expiresAt) &&
          permit.expiresAt <= body.deadline &&
          typeof permit.jobId === 'string' &&
          permit.jobId
        ) {
          counts.permits++;
          permits.set(exec, {
            step,
            call,
            route,
            body,
            run: claim.run,
            expiresAt: permit.expiresAt,
          });
          bySignal.set(exec.signal, {
            name: exec.name,
            args,
            body,
            jobId: permit.jobId,
            run: claim.run,
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
    ready,
    offer(run, withShell) {
      if (
        offered.has(run.runId) ||
        typeof run.authSessionId !== 'string' ||
        !run.authSessionId
      )
        return false;
      while (offered.size >= maxArmedRuns)
        offered.delete(offered.keys().next().value);
      offered.set(run.runId, run);
      if (withShell === true) shellRuns.add(run.runId);
      // The declarations of the armed set, as registered, in the order the
      // Host serializes them (by name): the parent keeps them for the
      // word-for-word comparison of every FD4 body. The report is awaited
      // by the run route, so no model request of the run can precede it.
      const declared = ['read', ...armedNames(run)].sort().map((name) => {
        const {
          name: toolName,
          description,
          parameters,
        } = definitions.get(name);
        return { name: toolName, description, parameters };
      });
      const report = registered
        .then(() =>
          service(
            'write-tool-definitions',
            scopeBody({ definitions: declared }, run),
          ),
        )
        .then(
          () => {
            counts.definitions++;
          },
          (error) => {
            throw error;
          },
        );
      reports.set(run.runId, report);
      return true;
    },
    // Resolves when the parent holds the definitions of the run; rejects
    // when it refused them.
    reported(run) {
      return reports.get(run.runId) ?? Promise.resolve();
    },
    claim(agent, run, turn) {
      const previous = claims.get(agent);
      claims.set(agent, {
        turn,
        run:
          offered.has(run.runId) &&
          (previous?.turn !== turn || previous?.run === run)
            ? run
            : undefined,
      });
    },
    gate(exec) {
      if (!toolNames.includes(exec.name)) return undefined;
      if (!armedNames(permits.get(exec)?.run).includes(exec.name))
        return undefined;
      if (!currentPermit(exec))
        return permits.has(exec) ? 'invalidated' : undefined;
      counts.executed += fileNames.includes(exec.name) ? 1 : 0;
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
