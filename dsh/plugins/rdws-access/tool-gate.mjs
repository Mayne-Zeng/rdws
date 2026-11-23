import { RDWS_TOOL_GUARD_DENIAL } from '../../bridge/access.ts';

// §11.20.26 B-4: the root guard dispatches by tool name. "read" goes to the
// Read probe's gate; every other name keeps the constant-tool gate, and a
// name no gate allows keeps the stage denial.
export function toolGateDecision(exec, gates) {
  const read = exec.name === 'read';
  const gate = read
    ? gates.readToolGate?.(exec)
    : gates.fixtureToolGate?.(exec);
  if (gate === 'allow') return undefined;
  return {
    reason:
      gate === 'invalidated'
        ? read
          ? 'Read tool permit no longer current'
          : 'Fixture tool permit no longer current'
        : 'Tools are disabled in this RDWS stage',
    info: RDWS_TOOL_GUARD_DENIAL,
  };
}
