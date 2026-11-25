import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '@rdws/server';
import { loadEnvironment } from '@rdws/runtime-config';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
import {
  capabilityMatrix,
  capabilitySubjects,
  type CapabilitySubject,
} from '@rdws/contracts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
loadEnvironment('test');

// The matrix is reference data for readers; this test keeps it true. Every
// row either has probes that call the real entry as each role, or is listed
// in `unprobed` with the reason, so a gap stays visible instead of silent.
//
// A probe checks one of two things:
// - `success`: an allowed subject completes (2xx) and everyone else is
//   refused with a client error;
// - `gate`: the entry also needs something this fixture does not have (a
//   frozen baseline, a published template), so it can only show that an
//   allowed subject passes the role gate while everyone else gets a 403.
const accountOf: Record<CapabilitySubject, string> = {
  requirement_manager: 'manager',
  developer: 'dev',
  tester: 'tester',
  project_admin: 'pm',
  platform_admin: 'admin',
};
const unprobed: Record<string, string> = {
  'session.create':
    '需要 Native 运行时；由 tests/e2e 的会话用例与 web-permissions 覆盖',
  'session.fork': '同上',
  'session.write': '仅在隔离装配提供；由 tests/web-live 的受管旅程覆盖',
};
type Ctx = {
  app: ReturnType<typeof buildApp>;
  // Per account: cookie, and the login the page would have observed.
  auth: Record<string, { cookie: string; login: string }>;
  ids: Record<string, string>;
  requirementId: string;
  taskId: string;
};
type Probe = {
  name: string;
  checks: 'success' | 'gate';
  // The observed-login header is only trusted on part of the routes; a probe
  // states whether its entry expects it.
  observed?: boolean;
  run: (ctx: Ctx, account: string) => Promise<number>;
};
async function call(
  ctx: Ctx,
  account: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  observed?: boolean,
) {
  const debug = process.env.MATRIX_DEBUG === '1';
  const response = await ctx.app.inject({
    method,
    url,
    headers: {
      cookie: ctx.auth[account]!.cookie,
      origin: process.env.RDWS_ORIGIN!,
      ...(observed
        ? { [OBSERVED_LOGIN_HEADER]: ctx.auth[account]!.login }
        : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  if (debug)
    console.log(
      [
        method,
        url,
        'observed=' + String(observed),
        response.statusCode,
        response.body.slice(0, 120),
      ].join(' | '),
    );
  return response.statusCode;
}
const post =
  (
    url: (ctx: Ctx) => string,
    body: (ctx: Ctx) => object,
    observed?: boolean,
  ): Probe['run'] =>
  (ctx, account) =>
    call(ctx, account, 'POST', url(ctx), body(ctx), observed);
const get =
  (url: (ctx: Ctx) => string, observed?: boolean): Probe['run'] =>
  (ctx, account) =>
    call(ctx, account, 'GET', url(ctx), undefined, observed);
const requirement = (ctx: Ctx) => `/api/requirements/${ctx.requirementId}`;
const probes: Record<string, Probe[]> = {
  'requirement.read': [
    {
      name: 'read dossier',
      checks: 'success',
      observed: true,
      run: get(requirement, true),
    },
  ],
  'requirement.create': [
    {
      name: 'create requirement',
      checks: 'success',
      run: post(
        () => '/api/projects/poc/requirements',
        (ctx) => ({
          commandId: randomUUID(),
          title: `Matrix probe ${randomUUID()}`,
          description: 'Synthetic capability probe',
          acceptance: 'Probe only',
          leadId: ctx.ids.lead!,
          participants: [],
        }),
      ),
    },
  ],
  'requirement.details': [
    {
      name: 'edit description',
      checks: 'success',
      observed: true,
      run: post(
        (ctx) => `${requirement(ctx)}/details`,
        () => ({
          commandId: randomUUID(),
          patch: { description: `Matrix probe ${randomUUID()}` },
        }),
        true,
      ),
    },
    {
      name: 'edit background',
      checks: 'success',
      observed: true,
      run: post(
        (ctx) => `${requirement(ctx)}/details`,
        () => ({
          commandId: randomUUID(),
          patch: { background: `Matrix probe ${randomUUID()}` },
        }),
        true,
      ),
    },
  ],
  'requirement.personnel': [
    {
      name: 'personnel change',
      checks: 'gate',
      observed: true,
      // Nothing to add or remove, with a placeholder digest: a subject who
      // passes the role gate is answered on the merits, not with a 403.
      run: post(
        (ctx) => `${requirement(ctx)}/personnel`,
        (ctx) => ({
          commandId: randomUUID(),
          previewLeadId: ctx.ids.lead!,
          leadId: ctx.ids.lead!,
          add: [],
          remove: [],
          taskDigest: 'a'.repeat(64),
          handoffs: [],
          overrides: [],
        }),
        true,
      ),
    },
  ],
  'requirement.stage': [
    {
      name: 'change stage',
      checks: 'success',
      run: post(
        (ctx) => `${requirement(ctx)}/commands`,
        () => ({
          commandId: randomUUID(),
          type: 'requirement.stage',
          stage: 'design',
        }),
      ),
    },
    {
      name: 'create subtask',
      checks: 'success',
      run: post(
        (ctx) => `${requirement(ctx)}/commands`,
        (ctx) => ({
          commandId: randomUUID(),
          type: 'task.create',
          task: {
            title: `Matrix probe task ${randomUUID()}`,
            assigneeId: ctx.ids.lead!,
            description: '',
            acceptance: '',
          },
        }),
      ),
    },
  ],
  'task.own': [
    {
      name: 'update assigned task',
      checks: 'success',
      run: post(
        (ctx) => `${requirement(ctx)}/commands`,
        (ctx) => ({
          commandId: randomUUID(),
          type: 'task.update',
          taskId: ctx.taskId,
          patch: { status: 'in_progress' },
        }),
      ),
    },
  ],
  'worktree.prepare': [
    {
      name: 'prepare worktree',
      checks: 'gate',
      run: post(
        (ctx) => `${requirement(ctx)}/worktrees`,
        () => ({}),
      ),
    },
  ],
  'template.bind': [
    {
      name: 'bind unpublished template',
      checks: 'gate',
      observed: true,
      run: post(
        (ctx) => `${requirement(ctx)}/capability-template`,
        () => ({
          commandId: randomUUID(),
          templateId: randomUUID(),
          revision: 1,
        }),
        true,
      ),
    },
  ],
  'repository.sync': [
    {
      name: 'sync unregistered repository',
      checks: 'gate',
      run: post(
        () => '/api/projects/poc/repositories/matrix-probe/sync',
        () => ({ commandId: randomUUID() }),
      ),
    },
  ],
  'member.roles': [
    {
      name: 'keep existing role',
      checks: 'success',
      run: post(
        () => '/api/management/commands',
        () => ({
          kind: 'project.roles',
          commandId: randomUUID(),
          projectId: 'poc',
          username: 'dev',
          roles: ['developer'],
        }),
      ),
    },
  ],
  'platform.admin': [
    {
      name: 'read platform',
      checks: 'success',
      run: get(() => '/api/management/platform'),
    },
  ],
};
// Conditional cells name the extra requirement; these entries point at the
// probe account that satisfies it, so pass and refusal are both checked. The
// bare role account must still be refused.
const holderAccount: Record<string, string> = {
  // The fixture makes every probe account a matching participant.
  'requirement.read/requirement_manager': 'manager',
  'requirement.read/developer': 'dev',
  'requirement.read/tester': 'tester',
  // The development lead holds the developer role and the assignment.
  'requirement.stage/developer': 'lead',
  // The fixture's manager created the requirement, so it is a requirement
  // manager participant.
  'requirement.details/requirement_manager': 'manager',
  'requirement.personnel/requirement_manager': 'manager',
  // The fixture assigns the probe task to the developer account.
  'task.own/developer': 'dev',
};
// A refusal is a client error that is not a login problem.
const refused = (status: number) =>
  status === 403 || (status >= 400 && status !== 401);

const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
});
const pool = createTestPool('migration');
const created: string[] = [];
let ctx: Ctx;
beforeAll(async () => {
  const accounts = await readTestAccounts();
  await app.ready();
  const auth: Ctx['auth'] = {};
  for (const { username, ...credentials } of accounts) {
    const signed = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: process.env.RDWS_ORIGIN! },
      payload: { username, ...credentials },
    });
    expect(signed.statusCode, username).toBe(200);
    const cookie = signed.cookies
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
    });
    auth[username] = { cookie, login: session.json().session.id as string };
  }
  const members = await app.inject({
    method: 'GET',
    url: '/api/projects/poc/members',
    headers: { cookie: auth.pm!.cookie, origin: process.env.RDWS_ORIGIN! },
  });
  const listed = members.json().members as {
    id: string;
    name: string;
    role: string;
  }[];
  // Each probe account holds exactly the role its column stands for.
  const rolesOf = (name: string) =>
    listed
      .filter((member) => member.name === name)
      .map((member) => member.role);
  expect(rolesOf('manager')).toEqual(['requirement_manager']);
  expect(rolesOf('dev')).toEqual(['developer']);
  expect(rolesOf('tester')).toEqual(['tester']);
  expect(rolesOf('pm')).toEqual(['project_admin']);
  expect(listed.some((member) => member.name === 'admin')).toBe(false);
  const ids = Object.fromEntries(
    listed.map((member) => [member.name, member.id]),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/poc/requirements',
    headers: {
      cookie: auth.manager!.cookie,
      origin: process.env.RDWS_ORIGIN!,
    },
    payload: {
      commandId: randomUUID(),
      title: `Matrix fixture ${randomUUID()}`,
      description: 'Synthetic capability fixture',
      acceptance: 'Probe only',
      leadId: ids.lead!,
      participants: [
        { userId: ids.dev!, roles: ['developer'] },
        { userId: ids.tester!, roles: ['tester'] },
      ],
      tasks: [{ title: 'Matrix probe assigned task', assigneeId: ids.dev! }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const requirementId = (response.json() as { id: string }).id;
  created.push(requirementId);
  ctx = { app, auth, ids, requirementId, taskId: '' };
  const dossier = await app.inject({
    method: 'GET',
    url: `/api/requirements/${requirementId}`,
    headers: {
      cookie: auth.manager!.cookie,
      origin: process.env.RDWS_ORIGIN!,
      [OBSERVED_LOGIN_HEADER]: auth.manager!.login,
    },
  });
  const tasks = (dossier.json() as { tasks: { id: string }[] }).tasks;
  expect(tasks).toHaveLength(1);
  ctx.taskId = tasks[0]!.id;
}, 30000);
afterAll(async () => {
  for (const id of created) {
    await pool.query('delete from task where requirement_id=$1', [id]);
    await pool.query('delete from requirement_event where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
  }
  await app.close();
  await pool.end();
}, 30000);

test('the capability matrix agrees with the server wherever a probe reaches', async () => {
  const rowIds = capabilityMatrix.map((row) => row.id);
  expect(new Set(rowIds).size).toBe(rowIds.length);
  for (const id of Object.keys(unprobed)) expect(rowIds).toContain(id);
  const probed = new Set<string>();
  const allowedOf = (row: (typeof capabilityMatrix)[number]) =>
    row.allowed as Partial<Record<CapabilitySubject, string>>;
  for (const row of capabilityMatrix) {
    const rowProbes = probes[row.id];
    if (!rowProbes) {
      expect(unprobed, row.id).toHaveProperty(row.id);
      continue;
    }
    expect(unprobed, row.id).not.toHaveProperty(row.id);
    const allowed = allowedOf(row);
    for (const subject of capabilitySubjects) {
      // Empty condition: the role alone is enough. Non-empty: the named
      // requirement must also hold, so the bare role account is refused.
      const condition = allowed[subject];
      const passAccount = condition
        ? holderAccount[`${row.id}/${subject}`]
        : condition === ''
          ? accountOf[subject]
          : undefined;
      const cases: (readonly [string, boolean])[] = [
        ...(passAccount ? [[passAccount, true] as const] : []),
        ...(!passAccount ? [[accountOf[subject], false] as const] : []),
      ];
      for (const [account, expected] of cases)
        for (const probe of rowProbes) {
          const status = await probe.run(ctx, account);
          const label = `${row.id} · ${probe.name} · ${account} (${expected ? 'pass' : 'refuse'}) → ${status}`;
          if (probe.checks === 'success')
            expect(expected ? status < 300 : refused(status), label).toBe(true);
          else
            // A gate probe only decides the role gate: an allowed subject
            // may still fail later for a missing baseline or template.
            expect(expected ? status !== 403 : status === 403, label).toBe(
              true,
            );
        }
      if (cases.length) probed.add(`${row.id}/${subject}`);
    }
  }
  // Only the three rows that need a Native runtime stay unprobed.
  expect(probed.size).toBe(
    (capabilityMatrix.length - Object.keys(unprobed).length) *
      capabilitySubjects.length,
  );
});

test('the conditions named in the matrix hold for the accounts that satisfy them', async () => {
  // The development lead is a developer who may move the stage and add tasks…
  for (const probe of probes['requirement.stage']!)
    expect(await probe.run(ctx, 'lead'), probe.name).toBe(200);
  // …and the assignee of a task may update that task.
  expect(await probes['task.own']![0]!.run(ctx, 'dev')).toBe(200);
  // A platform administrator holds no project access through that role alone.
  expect(await probes['requirement.read']![0]!.run(ctx, 'admin')).toBe(403);
});
