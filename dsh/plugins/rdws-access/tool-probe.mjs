import { bodyHash, isRecord } from '../../bridge/access.ts';

const name = 'rdws_authority_probe';
const fixtureResult = 'RDWS fixture tool completed';
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

function emptyArguments(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return isRecord(value) && Object.keys(value).length === 0;
}

export function installFixtureToolProbe(ctx, currentStep, liveRun, service) {
  let offered;
  const claims = new WeakMap();
  const agents = new WeakMap();
  const calls = new WeakMap();
  const permits = new WeakMap();
  const definition = Object.freeze({
    name,
    description: 'Return the fixed result of the isolated permission probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      if (!currentPermit(exec)) throw new Error('Fixture tool permit expired');
      permits.delete(exec);
      return fixtureResult;
    },
  });

  function currentPermit(exec) {
    const permit = permits.get(exec);
    return (
      permit &&
      permit.expiresAt > Date.now() &&
      routeFields.every((key) => exec[key] === permit.route[key]) &&
      !exec.signal.aborted &&
      currentStep(exec.agent) === permit.step &&
      calls.get(exec.agent.session) === permit.call &&
      ctx.tools.executable(exec.name, exec.agent, exec.toolSet) === definition
    );
  }

  ctx.on(
    'agent/created',
    ({ agent }) => {
      agents.set(agent.session, agent);
      agent.ctx.tools.register(definition, {
        when: ({ agent: actual }) => {
          const claim = claims.get(agent);
          return (
            actual === agent &&
            offered !== undefined &&
            claim?.run === offered &&
            liveRun(offered)
          );
        },
      });
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
      if (event.type === 'tool/call' && event.data.name === name)
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
      if (
        outcome.kind !== 'allow' ||
        exec.name !== name ||
        !exec.agent ||
        exec.parent !== undefined ||
        exec.rootCallId !== exec.callId ||
        !exec.toolSet ||
        exec.signal.aborted ||
        !routeFields.every((key) => exec[key] === route[key]) ||
        !Object.isFrozen(exec.arguments) ||
        !emptyArguments(exec.arguments) ||
        ctx.tools.executable(name, exec.agent, exec.toolSet) !== definition
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
        !emptyArguments(call.data.arguments) ||
        call.data.turn !== claim.turn ||
        call.data.step !== step.body.modelStep.step
      )
        return outcome;
      const body = {
        ...step.body,
        authSessionId: offered.authSessionId,
        modelBindingId: step.bindingId,
        toolName: name,
        toolCallId: exec.callId,
        toolCallSeq: call.seq,
        arguments: exec.arguments,
        deadline: Date.now() + 2000,
      };
      try {
        const permit = await service('fixture-tool-permit', body, exec.signal);
        if (
          permit?.digest === bodyHash(body) &&
          Number.isSafeInteger(permit.expiresAt) &&
          permit.expiresAt <= body.deadline
        )
          permits.set(exec, { step, call, route, expiresAt: permit.expiresAt });
      } catch {
        permits.delete(exec);
      }
      return outcome;
    },
    { global: true },
  );

  return {
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
      for (const key of routeFields) {
        Object.defineProperty(exec, key, {
          value: exec[key],
          writable: false,
          configurable: false,
        });
      }
      return 'allow';
    },
  };
}
