import { spawn } from 'node:child_process';
import { loadEnvironment } from './env.mjs';
loadEnvironment(process.env.RDWS_MODE || 'development');
const children = [
  spawn('pnpm', ['--filter', '@rdws/server', 'dev'], {
    stdio: 'inherit',
    env: process.env,
  }),
  spawn('pnpm', ['--filter', '@rdws/console', 'dev'], {
    stdio: 'inherit',
    env: process.env,
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
for (const child of children) child.once('exit', (code) => stop(code || 0));
