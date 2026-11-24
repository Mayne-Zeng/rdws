import { RDWS_TOOL_GUARD_DENIAL } from '../../bridge/access.ts';

// §11.20.26 B-4 and §11.20.27: the root guard dispatches by tool name.
// "read" goes to the Read probe's gate; the four write tool names go to
// the Write probe's gate (a name that probe did not arm, or a run without a
// permit, keeps the stage denial); every other name keeps the constant-tool
// gate, and a name no gate allows keeps the stage denial.
const writeNames = ['edit', 'write', 'bash', 'git'];
export function toolGateDecision(exec, gates) {
  const read = exec.name === 'read';
  const write = writeNames.includes(exec.name);
  const gate = read
    ? gates.readToolGate?.(exec)
    : write
      ? gates.writeToolGate?.(exec)
      : gates.fixtureToolGate?.(exec);
  if (gate === 'allow') return undefined;
  const label = read ? 'Read tool' : write ? 'Write tool' : 'Fixture tool';
  return {
    reason:
      gate === 'invalidated'
        ? label + ' permit no longer current'
        : 'Tools are disabled in this RDWS stage',
    info: RDWS_TOOL_GUARD_DENIAL,
  };
}
