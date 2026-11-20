import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';

const secret = () => randomBytes(32).toString('hex');
const digest = (input: string) =>
  createHash('sha256').update(input).digest('hex');
const protectedTables = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'project',
  'project_member',
  'requirement',
  'requirement_participant',
  'native_session',
  'task',
  'command_receipt',
  'requirement_write_lease',
  'session_model_selection',
  'session_prompt_dispatch',
];
let lab: Awaited<ReturnType<typeof authorityDatabase>>;
const password = secret();
const userId = randomUUID();
type ChildFixture = {
  child: ChildProcess;
  exit: Promise<unknown[]>;
  label: string;
  origin(): string | undefined;
  output(): string;
};

beforeAll(async () => {
  lab = await authorityDatabase();
  await lab.migrate();
  await lab.owner.query(
    "insert into auth_user(id,name,email,username,active) values($1,'Fixture member','owner@fixture.invalid','fixture_owner',true)",
    [userId],
  );
  await lab.owner.query(
    "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
    [randomUUID(), userId, await hashPassword(password)],
  );
}, 40_000);
afterAll(async () => {
  await lab?.close();
});

async function state() {
  return (
    await lab.owner.query<{
      managed: boolean;
      generation: string | null;
      armed: boolean;
    }>(
      'select managed,generation,ticket_digest is not null as armed from rdws_authority.owner where singleton',
    )
  ).rows[0]!;
}

async function arm(ticket: string) {
  const result = await lab.owner.query(
    'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
    [digest(ticket)],
  );
  expect(result.rowCount).toBe(1);
}

async function recoverStopped(generation: string | null) {
  const result = await lab.owner.query(
    'update rdws_authority.owner set ticket_digest=null,proof_digest=null,generation=null where singleton and generation is not distinct from $1',
    [generation],
  );
  expect(result.rowCount).toBe(1);
}

test('an older database without the authority schema still starts the ordinary BFF', async () => {
  const url = new URL(lab.databaseUrl);
  url.pathname = '/postgres';
  const app = buildApp({
    databaseUrl: url.href,
    origin: lab.childEnv.RDWS_ORIGIN,
    secret: lab.childEnv.BETTER_AUTH_SECRET,
    nativeRuntimeRoot: lab.root,
    repositoryHome: lab.root,
  });
  try {
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

test('the persistent database gate serializes old snapshots, ordinary writers, and two owners with the same ticket', async () => {
  const ticket = secret(),
    proofA = secret(),
    proofB = secret();
  const ordinary = connectDatabase(lab.databaseUrl).pool;
  const contenders = [proofA, proofB].map(
    (proof) => connectDatabase(lab.databaseUrl, proof).pool,
  );
  const held = await ordinary.connect();
  const oldSnapshots = await Promise.all([
    ordinary.connect(),
    ordinary.connect(),
  ]);
  try {
    expect(await acquireAuthority(ordinary, false)).toBeNull();
    const guards = await lab.owner.query<{ name: string }>(
      `select c.relname as name from pg_trigger t join pg_class c on t.tgrelid=c.oid
       where t.tgname='rdws_authority_writer' and t.tgenabled='A' and t.tgtype=62 order by c.relname`,
    );
    expect(guards.rows.map(({ name }) => name)).toEqual(
      [...protectedTables].sort(),
    );
    const privileges = await lab.owner.query<{ guarded: boolean }>(
      `select has_schema_privilege('rdws_test_app', 'rdws_authority', 'USAGE')
         and not has_schema_privilege('rdws_test_app', 'rdws_authority', 'CREATE')
         and not has_table_privilege('rdws_test_app', 'rdws_authority.owner', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
         and has_function_privilege('rdws_test_app', 'rdws_authority.admit_owner(boolean,text)', 'EXECUTE')
         and has_function_privilege('rdws_test_app', 'rdws_authority.release_owner(uuid)', 'EXECUTE')
         and not has_function_privilege('rdws_test_app', 'rdws_authority.check_writer()', 'EXECUTE') as guarded`,
    );
    expect(privileges.rows[0]?.guarded).toBe(true);
    await expect(
      ordinary.query('select * from rdws_authority.owner'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      ordinary.query('update rdws_authority.owner set managed=true'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      ordinary.query(
        'alter table public.auth_account disable trigger rdws_authority_writer',
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      ordinary.query("set session_replication_role='replica'"),
    ).rejects.toMatchObject({ code: '42501' });

    for (const [index, connection] of oldSnapshots.entries()) {
      const level = index === 0 ? 'repeatable read' : 'serializable';
      await connection.query('begin isolation level ' + level);
      await connection.query('select 1 from auth_account limit 1');
    }
    await held.query('begin');
    const {
      rows: [backend],
    } = await held.query<{ pid: number }>('select pg_backend_pid() as pid');
    await held.query(
      'update auth_account set password=password where user_id=$1',
      [userId],
    );
    const arming = arm(ticket);
    void arming.catch(() => {});
    await expect
      .poll(
        async () =>
          (
            await lab.admin.query<{ waiting: boolean }>(
              'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting',
              [backend!.pid],
            )
          ).rows[0]?.waiting,
      )
      .toBe(true);
    await held.query('commit');
    await arming;
    for (const connection of oldSnapshots)
      await expect(
        connection.query(
          'update auth_account set password=password where user_id=$1',
          [userId],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    await expect(acquireAuthority(ordinary, false)).rejects.toThrow();
    await expect(acquireAuthority(ordinary, true, ticket)).rejects.toThrow();
    await expect(
      acquireAuthority(contenders[0]!, true, secret()),
    ).rejects.toThrow();
    await expect(
      ordinary.query('update auth_account set password=null where user_id=$1', [
        userId,
      ]),
    ).rejects.toMatchObject({ code: '55006' });

    const attempts = await Promise.allSettled(
      contenders.map((pool) => acquireAuthority(pool, true, ticket)),
    );
    const winner = attempts.findIndex(
      (result) => result.status === 'fulfilled',
    );
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const generation = (await state()).generation!;
    expect(generation).toBeTruthy();
    expect((await state()).armed).toBe(false);
    for (const statement of [
      'update task set status=status where false',
      'update command_receipt set result=result where false',
      'delete from command_receipt where false',
      'update requirement_write_lease set phase=phase where false',
    ]) {
      await expect(ordinary.query(statement)).rejects.toMatchObject({
        code: '55006',
      });
    }
    await expect(
      contenders[winner]!.query(
        'delete from requirement_write_lease where false',
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      contenders[winner]!.query('truncate requirement_write_lease'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      releaseAuthority(contenders[1 - winner]!, generation),
    ).rejects.toThrow();
    await expect(
      contenders[1 - winner]!.query(
        'update auth_user set active=false where id=$1',
        [userId],
      ),
    ).rejects.toMatchObject({ code: '55006' });
    const ticketAsProof = connectDatabase(lab.databaseUrl, ticket).pool;
    try {
      await expect(
        ticketAsProof.query('update auth_user set active=false where id=$1', [
          userId,
        ]),
      ).rejects.toMatchObject({ code: '55006' });
      await expect(
        releaseAuthority(ticketAsProof, generation),
      ).rejects.toThrow();
    } finally {
      await ticketAsProof.end();
    }
    expect(
      (
        await contenders[winner]!.query(
          'update auth_user set active=active where id=$1',
          [userId],
        )
      ).rowCount,
    ).toBe(1);
    const activity = await ordinary.query(
      'select query from pg_stat_activity where usename=current_user',
    );
    for (const value of [ticket, proofA, proofB]) {
      expect(JSON.stringify(activity.rows).includes(value)).toBe(false);
      expect((await lab.logs()).includes(value)).toBe(false);
    }
    await releaseAuthority(contenders[winner]!, generation);
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: false,
    });
    await expect(
      acquireAuthority(contenders[winner]!, true, ticket),
    ).rejects.toThrow();
  } finally {
    for (const client of [held, ...oldSnapshots]) client.release(true);
    await Promise.all([
      ordinary.end(),
      ...contenders.map((pool) => pool.end()),
    ]);
    await recoverStopped((await state()).generation);
  }
});

test('a lost commit acknowledgement never substitutes a second owner or reuses a startup ticket', async () => {
  const ticket = secret();
  const holder = connectDatabase(lab.databaseUrl, secret()).pool;
  const stranger = connectDatabase(lab.databaseUrl, secret()).pool;
  function loseNextCommit(pool: typeof holder) {
    const connect = pool.connect.bind(pool);
    return vi.spyOn(pool, 'connect').mockImplementationOnce((async () => {
      const client = await connect();
      const execute = client.query.bind(client);
      client.query = ((command: { text?: string }, ...args: unknown[]) => {
        const result = Reflect.apply(execute, client, [command, ...args]);
        if (command.text !== 'commit') return result;
        return result.then(() => {
          throw new Error('Fixture acknowledgement lost after commit');
        });
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect);
  }
  try {
    await arm(ticket);
    const claim = loseNextCommit(holder);
    await expect(acquireAuthority(holder, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    claim.mockRestore();
    const { generation } = await state();
    expect(generation).toBeTruthy();
    await expect(acquireAuthority(stranger, true, ticket)).rejects.toThrow();
    await expect(
      stranger.query('update auth_user set active=false where id=$1', [userId]),
    ).rejects.toMatchObject({ code: '55006' });
    const close = loseNextCommit(holder);
    await expect(releaseAuthority(holder, generation!)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    close.mockRestore();
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: false,
    });
    await expect(acquireAuthority(holder, true, ticket)).rejects.toThrow();
  } finally {
    await Promise.all([holder.end(), stranger.end()]);
    await recoverStopped((await state()).generation);
  }
});

test('unexpected grants and effective global privileges fail migration and BFF admission', async () => {
  const ticket = secret();
  const wouldBeOwner = connectDatabase(lab.databaseUrl, secret()).pool;
  try {
    await arm(ticket);
    await lab.owner.query(
      'grant select (proof_digest) on rdws_authority.owner to rdws_test_app',
    );
    await expect(
      lab.migrate().then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    await expect(acquireAuthority(wouldBeOwner, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: true,
    });
    await lab.owner.query(
      'revoke select (proof_digest) on rdws_authority.owner from rdws_test_app',
    );
    await lab.admin.query('grant pg_write_all_data to rdws_test_app');
    await expect(
      lab.migrate().then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    await expect(acquireAuthority(wouldBeOwner, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: true,
    });
    await lab.admin.query('revoke pg_write_all_data from rdws_test_app');
    await lab.migrate();
    const generation = await acquireAuthority(wouldBeOwner, true, ticket);
    expect(generation).toBeTruthy();
    await releaseAuthority(wouldBeOwner, generation!);
  } finally {
    await lab.admin.query('revoke pg_write_all_data from rdws_test_app');
    await lab.owner.query(
      'revoke select (proof_digest) on rdws_authority.owner from rdws_test_app',
    );
    await wouldBeOwner.end();
    await recoverStopped((await state()).generation);
  }
});

test('missing state and unsafe parameter logging cannot silently admit a runtime', async () => {
  const ordinary = connectDatabase(lab.databaseUrl).pool;
  const proof = secret(),
    ticket = secret();
  const protectedPool = connectDatabase(lab.databaseUrl, proof).pool;
  try {
    await lab.owner.query('delete from rdws_authority.owner where singleton');
    await expect(acquireAuthority(ordinary, false)).rejects.toThrow();
    await expect(
      ordinary.query('update auth_user set active=active where id=$1', [
        userId,
      ]),
    ).rejects.toMatchObject({ code: 'P0002' });
    await lab.owner.query(
      'insert into rdws_authority.owner(singleton) values(true)',
    );
    await arm(ticket);
    await lab.admin.query(
      "alter role rdws_test_app set log_parameter_max_length = '-1'",
    );
    await expect(acquireAuthority(protectedPool, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: true,
    });
    await lab.admin.query(
      'alter role rdws_test_app reset log_parameter_max_length',
    );
    await lab.admin.query(
      "alter role rdws_test_app set auto_explain.log_min_duration = '0'",
    );
    await expect(acquireAuthority(protectedPool, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: true,
    });
    await lab.admin.query(
      'alter role rdws_test_app reset auto_explain.log_min_duration',
    );
    await lab.admin.query(
      "alter role rdws_test_app set debug_print_plan = 'on'",
    );
    await expect(acquireAuthority(protectedPool, true, ticket)).rejects.toThrow(
      'ownership could not be confirmed',
    );
    expect(await state()).toEqual({
      managed: true,
      generation: null,
      armed: true,
    });
    const logs = await lab.logs();
    expect(logs.includes(proof) || logs.includes(ticket)).toBe(false);
  } finally {
    await Promise.all([ordinary.end(), protectedPool.end()]);
    await lab.admin.query(
      'alter role rdws_test_app reset log_parameter_max_length',
    );
    await lab.admin.query(
      'alter role rdws_test_app reset auto_explain.log_min_duration',
    );
    await lab.admin.query('alter role rdws_test_app reset debug_print_plan');
    await lab.owner.query(
      'insert into rdws_authority.owner(singleton) values(true) on conflict do nothing',
    );
    await recoverStopped((await state()).generation);
  }
});

test.skipIf(process.platform !== 'darwin')(
  'real BFF startup is exclusive across ports, roots and database aliases and retains ownership after a crash',
  async () => {
    const children: ChildFixture[] = [];
    function start(
      label: string,
      home: string,
      ticket?: string,
      mode = 'paused',
      port = '0',
    ): ChildFixture {
      const url = new URL(lab.databaseUrl);
      if (label.endsWith('alias')) url.hostname = 'localhost';
      url.searchParams.set('application_name', label);
      const child = spawn(
        process.execPath,
        [
          '--dns-result-order=ipv4first',
          '--import',
          'tsx',
          'apps/server/src/index.ts',
        ],
        {
          env: {
            ...lab.childEnv,
            RDWS_HOME: home,
            DATABASE_URL: url.href,
            RDWS_NATIVE_MODEL_EGRESS: mode,
            RDWS_AUTHORITY_TICKET_FILE: ticket,
            RDWS_API_PORT: port,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        origin: string | undefined;
      child.stdout!.on('data', (chunk) => {
        output += chunk.toString();
        origin = /RDWS API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
          output,
        )?.[1];
      });
      child.stderr!.on('data', (chunk) => {
        output += chunk.toString();
      });
      const exit = once(child, 'close');
      void exit.catch(() => {});
      const item = {
        child,
        exit,
        label,
        origin: () => origin,
        output: () => output,
      };
      children.push(item);
      return item;
    }
    const homeA = join(lab.root, 'owner-a'),
      homeB = join(lab.root, 'owner-b');
    await Promise.all([mkdir(homeA), mkdir(homeB)]);
    const ticket = secret(),
      file = join(lab.root, 'launch.ticket');
    await writeFile(file, ticket, { mode: 0o600 });
    async function login(origin: string) {
      const response = await fetch(origin + '/api/auth/sign-in/username', {
        method: 'POST',
        headers: {
          origin: lab.childEnv.RDWS_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ username: 'fixture_owner', password }),
      });
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      await response.text();
      expect(response.status).toBe(200);
      expect(Boolean(cookie)).toBe(true);
      return cookie;
    }
    try {
      await arm(ticket);
      const alias = new URL(lab.databaseUrl);
      alias.hostname = 'localhost';
      const witness = connectDatabase(alias.href).pool;
      try {
        expect(
          (
            await witness.query('select id from auth_user where id=$1', [
              userId,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        await witness.end();
      }
      const direct = start('forbidden-direct', homeB, undefined, 'direct');
      expect((await direct.exit)[0]).toBe(1);
      expect(direct.origin()).toBeUndefined();
      await chmod(file, 0o644);
      const unsafe = start('unsafe-file', homeA, file);
      expect((await unsafe.exit)[0]).toBe(1);
      expect(unsafe.output().includes('ticket file is not usable')).toBe(true);
      expect(await state()).toEqual({
        managed: true,
        generation: null,
        armed: true,
      });
      await chmod(file, 0o600);
      const contenders = [
        start('owner-a', homeA, file),
        start('owner-alias', homeB, file),
      ];
      await expect
        .poll(
          () => contenders.filter((candidate) => candidate.origin()).length,
          { timeout: 10_000 },
        )
        .toBe(1);
      const winner = contenders.find((candidate) => candidate.origin())!;
      const loser = contenders.find((candidate) => candidate !== winner)!;
      expect((await loser.exit)[0]).toBe(1);
      expect(loser.origin()).toBeUndefined();
      const cookie = await login(winner.origin()!);
      const logout = await fetch(winner.origin()! + '/api/auth/sign-out', {
        method: 'POST',
        headers: {
          cookie,
          origin: lab.childEnv.RDWS_ORIGIN,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(logout.status).toBe(200);
      await logout.text();
      const admittedGeneration = (await state()).generation!;
      const disconnected = await lab.admin.query<{ ended: boolean }>(
        'select pg_terminate_backend(pid) as ended from pg_stat_activity where application_name=$1 and datname=current_database()',
        [winner.label],
      );
      expect(disconnected.rows.some(({ ended }) => ended)).toBe(true);
      expect((await state()).generation).toBe(admittedGeneration);
      await login(winner.origin()!);
      winner.child.kill('SIGTERM');
      winner.child.kill('SIGINT');
      expect(await winner.exit).toEqual([0, null]);
      expect((await state()).generation).toBeNull();

      const crashedTicket = secret();
      await writeFile(file, crashedTicket, { mode: 0o600 });
      await arm(crashedTicket);
      const occupied = createServer();
      occupied.listen(0, '127.0.0.1');
      await once(occupied, 'listening');
      try {
        const port = String((occupied.address() as { port: number }).port);
        const failed = start('occupied-port', homeA, file, 'paused', port);
        expect((await failed.exit)[0]).toBe(1);
        expect(failed.origin()).toBeUndefined();
        expect(await state()).toEqual({
          managed: true,
          generation: null,
          armed: false,
        });
      } finally {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
      const nextTicket = secret();
      await writeFile(file, nextTicket, { mode: 0o600 });
      await arm(nextTicket);
      const crashed = start('crashed-owner', homeA, file);
      await expect
        .poll(crashed.origin, { timeout: 10_000 })
        .toBeTypeOf('string');
      const nextGeneration = (await state()).generation;
      expect(nextGeneration).not.toBe(admittedGeneration);
      crashed.child.kill('SIGKILL');
      expect(await crashed.exit).toEqual([null, 'SIGKILL']);
      const denied = start('crashed-reclaim-alias', homeB, file);
      expect((await denied.exit)[0]).toBe(1);
      expect(denied.origin()).toBeUndefined();
      expect((await state()).generation).toBe(nextGeneration);
      for (const value of [ticket, nextTicket, crashedTicket]) {
        expect(children.some((child) => child.output().includes(value))).toBe(
          false,
        );
        expect((await lab.logs()).includes(value)).toBe(false);
      }
    } finally {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      await Promise.allSettled(children.map(({ exit }) => exit));
      await recoverStopped((await state()).generation);
    }
  },
  40_000,
);

test.skipIf(process.platform !== 'darwin')(
  'a failed Native shutdown cannot release the owner even when stop is retried',
  async () => {
    const ticket = secret();
    await arm(ticket);
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
    const host = new NativeWebHost(
      lab.root,
      undefined,
      'poc',
      undefined,
      'paused',
    );
    const close = vi
      .spyOn(host, 'close')
      .mockRejectedValue(new Error('Fixture Native shutdown failed'));
    const app = buildApp({
      databaseUrl: lab.databaseUrl,
      origin: lab.childEnv.RDWS_ORIGIN,
      secret: lab.childEnv.BETTER_AUTH_SECRET,
      nativeHost: host,
      authorityTicket: ticket,
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { generation } = await state();
      expect(generation).toBeTruthy();
      const shutdown = app.close();
      await expect(shutdown).rejects.toThrow(
        'Project shutdown was not confirmed',
      );
      await expect(app.stopRuntime()).rejects.toThrow(
        'Project shutdown was not confirmed',
      );
      expect(app.stopRuntime()).toBe(shutdown);
      expect(close).toHaveBeenCalledOnce();
      expect(app.server.listening).toBe(false);
      expect((await state()).generation).toBe(generation);
    } finally {
      await app.close().catch(() => {});
      vi.unstubAllEnvs();
      await recoverStopped((await state()).generation);
    }
  },
);
