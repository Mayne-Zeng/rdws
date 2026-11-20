import { createWorkbenchRuntime } from './workbench-runtime.ts';
import { registerAdministration } from './workbench-administration.ts';
import { registerRepositories } from './workbench-repositories.ts';
import {
  registerRequirementList,
  registerRequirements,
} from './workbench-requirements.ts';
import { registerRequirementImport } from './workbench-import.ts';
import { registerSessions } from './workbench-sessions.ts';
import { registerNativeTransport } from './workbench-native.ts';
import { writeAuthorityStatusPath } from './workbench-paths.ts';

export async function registerWorkbench(
  ...args: Parameters<typeof createWorkbenchRuntime>
) {
  const [app] = args;
  const runtime = createWorkbenchRuntime(...args);
  registerAdministration(app, runtime);
  registerRepositories(app, runtime);
  registerRequirementList(app, runtime);
  registerRequirementImport(app, runtime);
  registerRequirements(app, runtime);
  registerSessions(app, runtime);
  app.get(
    writeAuthorityStatusPath,
    { exposeHeadRoute: false },
    runtime.readWriteAuthorityStatus,
  );
  await registerNativeTransport(app, runtime);
  runtime.registerShutdown();
  return {
    access: runtime.access,
    revoke: runtime.revoke,
    closeLogin: runtime.closeLogin,
    writeWorktrees: runtime.writeWorktrees,
    writeLoginClosed: runtime.writeLoginClosed,
    recoverWriteAuthority: runtime.writeAuthority.recover,
    closeWorkflows: runtime.closeWorkflows,
  };
}
