import { homedir } from 'node:os';
import { join } from 'node:path';
export const runtimeHome = process.env.RDWS_HOME || join(homedir(), '.rdws');
export function loadEnvironment(mode = 'development') {
  process.loadEnvFile(join(runtimeHome, 'secrets', `${mode}.env`));
  process.env.RDWS_HOME = runtimeHome;
}
