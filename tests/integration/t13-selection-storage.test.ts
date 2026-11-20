import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { expect, test } from 'vitest';
import {
  createBusiness,
  digestOf,
} from '../../apps/server/src/modules/business.ts';
import { checkedWriteTransaction } from '../../apps/server/src/modules/checked-write-transaction.ts';
import { createSessionModelSelection } from '../../apps/server/src/modules/session-model-selection.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';

test('managed model selection and dispatch records survive permission refresh and logout', async () => {
  const context = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'],
    { encoding: 'utf8' },
  ).trim();
  const endpoint = process.env.DOCKER_CONTEXT
    ? context
    : process.env.DOCKER_HOST || context;
  const projectId = 'model-fixture';
  const actorId = randomUUID();
  const loginId = randomUUID();
  const reopenedLoginId = randomUUID();
  const observerLoginId = randomUUID();
  const requirementId = randomUUID();
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const oldRevision = randomUUID();
  const newRevision = randomUUID();
  const hostGeneration = randomUUID();
  const peerNonce = randomUUID();
  const inputDigest = createHash('sha256')
    .update('synthetic input')
    .digest('hex');
  const lab = await authorityDatabase(endpoint, async (previousOwner, root) => {
    const migrations = join('packages', 'db', 'migrations');
    const previous = join(root, 'before-session-model-selection');
    await mkdir(join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(
      await readFile(join(migrations, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter(({ idx }) => idx <= 14);
    expect(journal.entries).toHaveLength(15);
    for (const { tag } of journal.entries)
      await copyFile(
        join(migrations, tag + '.sql'),
        join(previous, tag + '.sql'),
      );
    await writeFile(
      join(previous, 'meta', '_journal.json'),
      JSON.stringify(journal),
    );
    const previousClient = await previousOwner.connect();
    try {
      expect(
        (
          await previousClient.query(
            'select current_database() as db,current_user as role',
          )
        ).rows,
      ).toEqual([{ db: 'rdws_test', role: 'rdws_test_migrator' }]);
      await migrate(drizzle(previousClient), { migrationsFolder: previous });
      expect(
        (
          await previousClient.query(
            "select to_regclass('public.session_prompt_dispatch') as relation",
          )
        ).rows,
      ).toEqual([{ relation: null }]);
    } finally {
      previousClient.release();
    }
    await previousOwner.query(
      "insert into project(id,name) values($1,'Model selection fixture')",
      [projectId],
    );
    await previousOwner.query(
      "insert into auth_user(id,name,email,username,active) values($1,'Fixture owner','model-fixture@example.invalid','model_fixture',true)",
      [actorId],
    );
    await previousOwner.query(
      "insert into auth_session(id,user_id,token,auth_epoch,expires_at) values($1,$2,$3,0,now()+interval '10 minutes')",
      [loginId, actorId, randomUUID()],
    );
    for (const id of [reopenedLoginId, observerLoginId])
      await previousOwner.query(
        "insert into auth_session(id,user_id,token,auth_epoch,expires_at) values($1,$2,$3,0,now()+interval '10 minutes')",
        [id, actorId, randomUUID()],
      );
    await previousOwner.query(
      "insert into project_member values($1,$2,'developer')",
      [projectId, actorId],
    );
    await previousOwner.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Model choice','','',$3,$3)",
      [requirementId, projectId, actorId],
    );
    await previousOwner.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sessionId, requirementId, actorId],
    );
    await previousOwner.query(
      "insert into requirement_participant values($1,$2,'developer')",
      [requirementId, actorId],
    );
  });
  const ordinary = connectDatabase(lab.databaseUrl);
  const proof = randomBytes(32).toString('hex');
  const owner = connectDatabase(lab.databaseUrl, proof);
  const ticket = randomBytes(32).toString('hex');
  let generation: string | null = null;
  try {
    const relations = ['session_model_selection', 'session_prompt_dispatch'];
    async function assertGuards() {
      const result = await lab.owner.query<{
        table_name: string;
        guarded: boolean;
        protected: boolean;
      }>(
        `select c.relname as table_name,
          exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=c.oid
            and t.tgname='rdws_authority_writer' and t.tgenabled='A' and t.tgtype=62
            and t.tgfoid='rdws_authority.check_writer()'::regprocedure) as guarded,
          not pg_catalog.has_table_privilege('rdws_test_app', c.oid, 'DELETE,TRUNCATE') as protected
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname=any($1::name[]) order by c.relname`,
        [relations],
      );
      expect(result.rows).toEqual(
        relations.map((table_name) => ({
          table_name,
          guarded: true,
          protected: true,
        })),
      );
    }
    await assertGuards();
    await lab.migrate();
    await assertGuards();
    expect(
      (
        await lab.owner.query(
          'select requirement_id,owner_id from native_session where id=$1',
          [sessionId],
        )
      ).rows,
    ).toEqual([{ requirement_id: requirementId, owner_id: actorId }]);

    expect(
      (
        await lab.owner.query(
          'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
          [createHash('sha256').update(ticket).digest('hex')],
        )
      ).rowCount,
    ).toBe(1);
    generation = await acquireAuthority(owner.pool, true, ticket);
    expect(generation).toEqual(expect.any(String));
    await expect(
      ordinary.pool.query(
        'insert into session_model_selection(native_session_id,provider,model,revision) values($1,$2,$3,$4)',
        [sessionId, 'fixture', 'model-a', oldRevision],
      ),
    ).rejects.toMatchObject({ code: '55006' });
    await expect(
      ordinary.pool.query(
        'update session_prompt_dispatch set state=state where false',
      ),
    ).rejects.toMatchObject({ code: '55006' });

    await owner.pool.query(
      'insert into session_model_selection(native_session_id,provider,model,revision) values($1,$2,$3,$4)',
      [sessionId, 'fixture', 'model-a', oldRevision],
    );
    const insertDispatch = () =>
      owner.pool.query(
        `insert into session_prompt_dispatch(native_session_id,request_id,project_id,requirement_id,actor_id,auth_session_id,input_digest,provider,model,selection_revision)
       values($1,$2,$3,$4,$5,$6,$7,'fixture','model-a',$8)`,
        [
          sessionId,
          requestId,
          projectId,
          requirementId,
          actorId,
          loginId,
          inputDigest,
          oldRevision,
        ],
      );
    await insertDispatch();
    await expect(insertDispatch()).rejects.toMatchObject({ code: '23505' });
    await expect(
      owner.pool.query(
        "update session_prompt_dispatch set state='pending' where native_session_id=$1 and request_id=$2",
        [sessionId, requestId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await owner.pool.query(
          `update session_prompt_dispatch set state='pending',host_generation=$3,peer_nonce=$4,lease_expires_at=now()+interval '1 minute'
       where native_session_id=$1 and request_id=$2 and state='reserved'`,
          [sessionId, requestId, hostGeneration, peerNonce],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      owner.pool.query(
        "update session_prompt_dispatch set state='accepted' where native_session_id=$1 and request_id=$2",
        [sessionId, requestId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.pool.query(
      "update session_model_selection set model='model-b',revision=$2 where native_session_id=$1",
      [sessionId, newRevision],
    );
    await owner.pool.query('delete from auth_session where id=$1', [loginId]);
    expect(
      (
        await owner.pool.query('select id from auth_session where id=$1', [
          loginId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await ordinary.pool.query(
          'select auth_session_id,input_digest,host_generation,peer_nonce,model,selection_revision,state from session_prompt_dispatch where native_session_id=$1 and request_id=$2',
          [sessionId, requestId],
        )
      ).rows,
    ).toEqual([
      {
        auth_session_id: loginId,
        input_digest: inputDigest,
        host_generation: hostGeneration,
        peer_nonce: peerNonce,
        model: 'model-a',
        selection_revision: oldRevision,
        state: 'pending',
      },
    ]);
    await owner.pool.query(
      "update session_prompt_dispatch set state='accepted',accepted_seq=25,accepted_message_id=$3 where native_session_id=$1 and request_id=$2 and state='pending'",
      [sessionId, requestId, randomUUID()],
    );
    for (const relation of relations) {
      await expect(
        owner.pool.query(`delete from ${relation} where false`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        owner.pool.query(`truncate ${relation}`),
      ).rejects.toMatchObject({ code: '42501' });
    }

    const store = createSessionModelSelection(
      createBusiness(owner.db),
      checkedWriteTransaction(owner.pool),
    );
    const scope = {
      projectId,
      requirementId,
      sessionId,
      who: { userId: actorId, authSessionId: reopenedLoginId },
    };
    const current = () => {};
    const readOptions = async () => ({
      provider: 'fixture',
      models: new Set(['model-a', 'model-b']),
      isCurrent: () => true,
    });
    const skipOptions = () =>
      Promise.reject(
        new Error('Receipt recovery must not query the Native catalog'),
      );
    expect(await store.read(scope, current)).toEqual({
      provider: 'fixture',
      model: 'model-b',
      revision: newRevision,
    });
    const saveInput = {
      commandId: randomUUID(),
      provider: 'fixture',
      model: 'model-a',
    };
    const chosen = await store.save(scope, saveInput, current, readOptions);
    expect(chosen).toMatchObject({
      provider: 'fixture',
      model: 'model-a',
      revision: expect.any(String),
    });
    const prompt = {
      requestId: randomUUID(),
      inputDigest: digestOf({ content: 'new synthetic prompt' }),
    };
    const reserved = await store.reservePrompt(
      scope,
      prompt,
      current,
      readOptions,
      chosen,
    );
    expect(reserved).toMatchObject({
      state: 'reserved',
      selectionRevision: chosen.revision,
      authSessionId: reopenedLoginId,
      model: 'model-a',
    });
    const changed = await store.save(
      scope,
      { ...saveInput, commandId: randomUUID(), model: 'model-b' },
      current,
      readOptions,
    );
    expect(changed.revision).not.toBe(chosen.revision);
    expect(await store.save(scope, saveInput, current, skipOptions)).toEqual(
      chosen,
    );
    await expect(
      store.save(
        scope,
        { ...saveInput, model: 'model-b' },
        current,
        skipOptions,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const lease = { hostGeneration, peerNonce, expiresAt: Date.now() + 35_000 };
    const frozen = await store.freezePrompt(
      scope,
      prompt.requestId,
      lease,
      await readOptions(),
      current,
    );
    expect(frozen).toMatchObject({
      state: 'pending',
      selectionRevision: chosen.revision,
      model: 'model-a',
      hostGeneration,
      peerNonce,
    });
    await expect(
      store.freezePrompt(
        scope,
        prompt.requestId,
        lease,
        await readOptions(),
        current,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await owner.pool.query('delete from auth_session where id=$1', [
      reopenedLoginId,
    ]);
    await expect(store.read(scope, current)).rejects.toMatchObject({
      statusCode: 401,
    });
    const observer = {
      ...scope,
      who: { userId: actorId, authSessionId: observerLoginId },
    };
    expect(
      await store.reservePrompt(
        observer,
        prompt,
        current,
        skipOptions,
        changed,
      ),
    ).toEqual(frozen);
    await expect(
      store.reservePrompt(
        observer,
        { ...prompt, inputDigest: digestOf('different') },
        current,
        skipOptions,
        changed,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const coordinates = { sequence: 11, messageId: randomUUID() };
    await expect(
      store.confirmPrompt(
        observer,
        { ...frozen, peerNonce: randomUUID() },
        coordinates,
        current,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const accepted = await store.confirmPrompt(
      observer,
      frozen,
      coordinates,
      current,
    );
    expect(accepted).toMatchObject({
      state: 'accepted',
      acceptedSeq: coordinates.sequence,
      acceptedMessageId: coordinates.messageId,
      authSessionId: reopenedLoginId,
      model: 'model-a',
    });
    expect(
      await store.confirmPrompt(observer, frozen, coordinates, current),
    ).toEqual(accepted);
    expect(await store.read(observer, current)).toEqual(changed);
    await releaseAuthority(owner.pool, generation!);
    generation = null;
    expect(
      (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows,
    ).toEqual([{ generation: null }]);
  } finally {
    try {
      if (generation) await releaseAuthority(owner.pool, generation);
    } finally {
      try {
        await Promise.all([owner.pool.end(), ordinary.pool.end()]);
      } finally {
        await lab.close();
      }
    }
  }
}, 45_000);
