import { spawnSync } from 'node:child_process';
import { loadEnvironment } from './env.mjs';
loadEnvironment();
const action = process.argv[2];
const commands = {
  up: ['up', '-d', '--wait'],
  status: ['ps'],
  recreate: ['up', '-d', '--wait', '--force-recreate', 'postgres'],
};
if (!Object.hasOwn(commands, action))
  throw new Error('Expected up, status or recreate');
const endpoint = [];
if (
  !process.env.DOCKER_HOST &&
  spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0 &&
  spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'version'], {
    stdio: 'ignore',
  }).status === 0
)
  endpoint.push('--host', 'unix:///var/run/docker.sock');
const result = spawnSync(
  'docker',
  [
    ...endpoint,
    'compose',
    '--project-name',
    'rdws-local',
    '-f',
    'deploy/compose.postgres.yml',
    ...commands[action],
  ],
  { stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
