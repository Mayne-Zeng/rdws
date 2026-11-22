import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { buildApp } from '@rdws/server';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, vi } from 'vitest';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

test.skipIf(process.platform !== 'darwin')(
  'the project model allowlist converges the pilot projection only through admin maintenance',
  async () => {
    const context = execFileSync(
      'docker',
      [
        'context',
        'inspect',
        '--format',
        '{{(index .Endpoints "docker").Host}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const lab = await authorityDatabase(
      process.env.DOCKER_CONTEXT ? context : process.env.DOCKER_HOST || context,
    );
    const trust = getCACertificates('default');
    let app: ReturnType<typeof buildApp> | undefined;
    let supplier: ReturnType<typeof createServer> | undefined;
    const receivedModels: string[] = [];
    const root = join(lab.root, 'pilot');
    const projectId = 'poc';
    const otherProject = 'elsewhere';
    const provider = 'rdws-glm';
    const defaultModel = 'pilot-model-a';
    const model = 'pilot-model-b';
    const crossProvider = 'pilot-unfrozen';
    const ghostModel = 'pilot-model-ghost';
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(24).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN;
    const ordinary = connectDatabase(lab.databaseUrl);
    try {
      // Judgment 7: the migration only adds the new table, its constraints
      // and the authority trigger; nothing else is touched.
      const migrationSql = readFileSync(
        'packages/db/migrations/0018_project_model_allowlist.sql',
        'utf8',
      );
      const statements = migrationSql
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim());
      expect(statements).toHaveLength(4);
      expect(statements[0]).toMatch(
        /^CREATE TABLE "project_model_allowlist" \($/m,
      );
      expect(statements[0]).toMatch(
        /CONSTRAINT "project_model_allowlist_project_id_provider_model_pk" PRIMARY KEY\("project_id","provider","model"\)/,
      );
      expect(statements[0]).toMatch(
        /CONSTRAINT "project_model_allowlist_reference" CHECK \(char_length\("project_model_allowlist"\."provider"\) between 1 and 160 and char_length\("project_model_allowlist"\."model"\) between 1 and 160\)/,
      );
      expect(statements[0]).toMatch(
        /CONSTRAINT "project_model_allowlist_state" CHECK \("project_model_allowlist"\."state" in \('enabled', 'disabled'\)\)/,
      );
      expect(statements[1]).toMatch(
        /^ALTER TABLE "project_model_allowlist" ADD CONSTRAINT "project_model_allowlist_project_id_project_id_fk" FOREIGN KEY \("project_id"\) REFERENCES "public"\."project"\("id"\)/,
      );
      expect(statements[2]).toMatch(
        /^CREATE TRIGGER rdws_authority_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public\.project_model_allowlist FOR EACH STATEMENT EXECUTE FUNCTION rdws_authority\.check_writer\(\);$/,
      );
      expect(statements[3]).toMatch(
        /^ALTER TABLE public\.project_model_allowlist ENABLE ALWAYS TRIGGER rdws_authority_writer;$/,
      );
      for (const statement of statements)
        expect(statement).toMatch(
          /^(CREATE TABLE |ALTER TABLE |CREATE TRIGGER )/,
        );
      const relations = ['project_model_allowlist'];
      const guards = async () =>
        (
          await lab.owner.query<{
            table_name: string;
            guarded: boolean;
            writable: boolean;
            protected: boolean;
          }>(
            `select c.relname as table_name,
          exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=c.oid
            and t.tgname='rdws_authority_writer' and t.tgenabled='A' and t.tgtype=62
            and t.tgfoid='rdws_authority.check_writer()'::regprocedure) as guarded,
          pg_catalog.has_table_privilege('rdws_test_app', c.oid, 'SELECT,INSERT,UPDATE') as writable,
          not pg_catalog.has_table_privilege('rdws_test_app', c.oid, 'DELETE,TRUNCATE') as protected
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname=any($1::name[]) order by c.relname`,
            [relations],
          )
        ).rows;
      expect(await guards()).toEqual([
        {
          table_name: 'project_model_allowlist',
          guarded: true,
          writable: true,
          protected: true,
        },
      ]);
      await lab.owner.query(
        "insert into project values($1,'Model pilot',now(),now())",
        [projectId],
      );
      await lab.owner.query(
        "insert into project values($1,'Other project',now(),now())",
        [otherProject],
      );
      const people: { id: string; username: string; role: string | null }[] = [
        { username: 'pilot_admin', role: 'project_admin' },
        { username: 'pilot_member', role: 'developer' },
        { username: 'pilot_outside', role: null },
        { username: 'pilot_stranger', role: null },
      ].map(({ username, role }) => ({ id: randomUUID(), username, role }));
      for (const person of people) {
        await lab.owner.query(
          'insert into auth_user(id,name,email,username,active) values($1,$2,$3,$2,true)',
          [person.id, person.username, person.username + '@fixture.invalid'],
        );
        await lab.owner.query(
          "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
          [randomUUID(), person.id, await hashPassword(password)],
        );
        if (person.role)
          await lab.owner.query('insert into project_member values($1,$2,$3)', [
            projectId,
            person.id,
            person.role,
          ]);
      }
      const outside = people.find(
        ({ username }) => username === 'pilot_outside',
      )!;
      await lab.owner.query('insert into project_member values($1,$2,$3)', [
        otherProject,
        outside.id,
        'project_admin',
      ]);
      const admin = people[0]!;
      const requirementId = randomUUID();
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Synthetic allowlist requirement','','',$3,$3)",
        [requirementId, projectId, admin.id],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, admin.id],
      );
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
            [createHash('sha256').update(ticket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      // Judgment 2: a direct write bypassing the application is rejected by
      // the authority trigger while the managed runtime is in effect, and
      // the application role holds no DELETE/TRUNCATE on the new table.
      await expect(
        ordinary.pool.query(
          'insert into project_model_allowlist(project_id,provider,model,state,revision) values($1,$2,$3,$4,$5)',
          [projectId, provider, model, 'enabled', randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '55006' });
      const proof = randomBytes(32).toString('hex');
      const admitted = connectDatabase(lab.databaseUrl, proof);
      const generation = await acquireAuthority(admitted.pool, true, ticket);
      expect(generation).toEqual(expect.any(String));
      try {
        await expect(
          admitted.pool.query(
            'delete from project_model_allowlist where false',
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          admitted.pool.query('truncate project_model_allowlist'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await releaseAuthority(admitted.pool, generation!);
        await admitted.pool.end();
        // Admission consumed the one-shot ticket; restore it for the app.
        expect(
          (
            await lab.owner.query(
              'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
              [createHash('sha256').update(ticket).digest('hex')],
            )
          ).rowCount,
        ).toBe(1);
      }
      const cert = await modelTlsCertificate(lab.root);
      setDefaultCACertificates([...trust, cert.cert.toString()]);
      supplier = createServer(
        { ...cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
        async (request, response) => {
          try {
            if (
              request.method !== 'POST' ||
              request.url !== '/v1/chat/completions'
            ) {
              response.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
              model: string;
            };
            receivedModels.push(payload.model);
            const chunk = {
              id: 'synthetic-allowlist-pilot',
              object: 'chat.completion.chunk',
              created: 1,
              model: payload.model,
            };
            response
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(
                [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: 'Completed synthetic allowlist prompt',
                    },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: 'stop' },
                ]
                  .map(
                    (choice) =>
                      `data: ${JSON.stringify({ ...chunk, choices: [choice] })}\n\n`,
                  )
                  .join('') + 'data: [DONE]\n\n',
              );
          } catch {
            response.destroy();
          }
        },
      );
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      const supplierPort = (supplier.address() as { port: number }).port;
      const destination = `https://127.0.0.1:${supplierPort}/v1/chat/completions`;
      const configuration = join(root, 'config', 'projects', projectId, 'dsh');
      const profile = join(configuration, 'profiles', 'rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(configuration, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { TEST_MODEL: randomBytes(24).toString('hex') },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                [provider]: {
                  api: 'openai-completions',
                  baseURL: destination.slice(0, -'/chat/completions'.length),
                  apiKeyEnv: 'TEST_MODEL',
                  models: [{ id: defaultModel }, { id: model }],
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      const databaseFixture = (
        await lab.owner.query<{ name: string }>(
          "select current_setting('rdws.fixture_instance') as name",
        )
      ).rows[0]!.name;
      app = buildApp({
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET,
        nativeRuntimeRoot: root,
        repositoryHome: root,
        authorityTicket: ticket,
        mainModelPolicy: {
          projectId,
          provider,
          model: defaultModel,
          destination,
        },
        sessionModelPilot: { alternateModel: model, databaseFixture },
      });
      // Startup itself confirms judgment 7 through the extended
      // validateSessionModelStorage checklist assertion.
      await app.ready();
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      async function login(username: string) {
        const response = await fetch(address + '/api/auth/sign-in/username', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
          redirect: 'error',
        });
        expect(response.status).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .map((part) => part.split(';')[0])
          .join('; ');
        await response.text();
        const authenticated = await fetch(address + '/api/auth/get-session', {
          headers: { cookie },
          redirect: 'error',
        });
        expect(authenticated.status).toBe(200);
        const { session } = (await authenticated.json()) as {
          session: { id: string };
        };
        return {
          origin,
          cookie,
          'x-rdws-edit-session': session.id,
          'content-type': 'application/json',
        };
      }
      const adminHeaders = await login('pilot_admin');
      const memberHeaders = await login('pilot_member');
      const outsideHeaders = await login('pilot_outside');
      const strangerHeaders = await login('pilot_stranger');
      const allowPath = `${address}/api/projects/${projectId}/model-allowlist`;
      const allow = (headers: Record<string, string>, body: unknown) =>
        fetch(allowPath, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      const allowRows = async () =>
        (
          await lab.owner.query(
            'select provider,model,state from project_model_allowlist order by provider,model',
          )
        ).rows;
      const allowReceipts = async () =>
        (
          await lab.owner.query(
            "select count(*)::int as count from command_receipt where operation='project.model.allow'",
          )
        ).rows[0]!.count;
      const modelCommand = (
        commandId: string,
        selected: string,
        enabled = true,
      ) => ({
        commandId,
        provider,
        model: selected,
        enabled,
      });
      const sessionsPath = `${address}/api/requirements/${requirementId}/sessions`;
      const created = await fetch(sessionsPath, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ commandId: randomUUID() }),
      });
      expect(created.status, await created.clone().text()).toBe(200);
      const { sessionId } = (await created.json()) as { sessionId: string };
      const selectionPath = `${sessionsPath}/${encodeURIComponent(sessionId)}/model-selection`;
      const save = (commandId: string, selected: string) =>
        fetch(selectionPath, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            commandId,
            provider,
            model: selected,
          }),
        });
      const bootstrap = await fetch(
        `${address}/api/dsh/${requirementId}/bootstrap`,
        { headers: adminHeaders },
      );
      expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
      const { loginBinding } = (await bootstrap.json()) as {
        loginBinding: string;
      };
      const nativeHeaders = {
        origin,
        cookie: adminHeaders.cookie,
        'content-type': 'application/json',
        'x-rdws-native-login': loginBinding,
        'x-rdws-client-generation': randomUUID(),
      };
      const prompt = (requestId: string, text: string) =>
        fetch(`${address}/api/dsh/${requirementId}/native/api/session/prompt`, {
          method: 'POST',
          headers: nativeHeaders,
          redirect: 'error',
          body: JSON.stringify({
            type: 'client-request',
            method: 'session/prompt',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  sessionId,
                  requestId,
                  mode: 'queue',
                  content: [{ type: 'text', text }],
                },
              },
            },
          }),
        });
      const frozenDispatch = async () =>
        (
          await lab.owner.query(
            'select request_id,provider,model from session_prompt_dispatch where native_session_id=$1 order by request_id',
            [sessionId],
          )
        ).rows;
      const originalFrozen = async () => {
        const frozen = await frozenDispatch();
        return frozen.filter((row) => frozenBeforeIds.includes(row.request_id));
      };

      // Judgment 6: without any allowlist row the projection falls back to
      // the accepted 「Native 目录 ∩ 冻结策略」 behavior without errors.
      expect(await allowRows()).toEqual([]);
      const fallbackSave = await save(randomUUID(), model);
      expect(fallbackSave.status, await fallbackSave.clone().text()).toBe(200);
      const fallbackSend = await prompt(randomUUID(), 'Fallback send');
      expect(fallbackSend.status, await fallbackSend.clone().text()).toBe(200);
      expect((await fallbackSend.json()).result).toEqual({
        ok: true,
        value: { accepted: true },
      });
      await expect.poll(() => receivedModels).toEqual([model]);
      expect(await frozenDispatch()).toHaveLength(1);

      // Judgment 1: a catalog model outside the allowlist disappears from
      // save validation; inside the intersection behavior is unchanged.
      const enableA = randomUUID();
      const enabled = await allow(
        adminHeaders,
        modelCommand(enableA, defaultModel),
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const enabledBody = (await enabled.json()) as Record<string, unknown>;
      expect(enabledBody).toEqual({
        commandId: enableA,
        provider,
        model: defaultModel,
        state: 'enabled',
        changed: true,
        replayed: false,
      });
      const rejectedSave = await save(randomUUID(), model);
      expect(rejectedSave.status).toBe(409);
      expect(await rejectedSave.json()).toEqual({
        error: '已选模型当前不可用，请重新选择后发送',
      });
      const acceptedSave = await save(randomUUID(), defaultModel);
      expect(acceptedSave.status, await acceptedSave.clone().text()).toBe(200);

      // Judgment 4: the platform lock cannot be overridden by the project.
      // An entry of the frozen provider outside the catalog and a row under
      // another provider both fail to enter the projection.
      await allow(adminHeaders, modelCommand(randomUUID(), ghostModel));
      await expect(
        (await save(randomUUID(), ghostModel)).json(),
      ).resolves.toEqual({ error: '已选模型当前不可用，请重新选择后发送' });
      const cross = await allow(adminHeaders, {
        commandId: randomUUID(),
        provider: crossProvider,
        model,
        enabled: true,
      });
      expect(cross.status).toBe(200);
      const crossSave = await save(randomUUID(), model);
      expect(crossSave.status).toBe(409);
      expect(await crossSave.json()).toEqual({
        error: '已选模型当前不可用，请重新选择后发送',
      });

      // Judgment 2: ordinary members, other projects' admins and users
      // without any qualification are rejected without row changes.
      const beforeUnauthorized = await allowRows();
      for (const headers of [memberHeaders, outsideHeaders, strangerHeaders]) {
        const denied = await allow(
          headers,
          modelCommand(randomUUID(), defaultModel),
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({
          error: '无权管理当前项目模型允许集合',
        });
      }
      expect(await allowRows()).toEqual(beforeUnauthorized);
      expect(await allowReceipts()).toBe(3);

      // Judgment 5: the maintenance DTO carries no credentials or
      // diagnostics, and error text stays stable.
      const dto = await allow(
        adminHeaders,
        modelCommand(randomUUID(), defaultModel),
      );
      expect(dto.status).toBe(200);
      const dtoBody = (await dto.json()) as Record<string, unknown>;
      expect(Object.keys(dtoBody).sort()).toEqual([
        'changed',
        'commandId',
        'model',
        'provider',
        'replayed',
        'state',
      ]);
      expect(JSON.stringify(dtoBody)).not.toMatch(
        /credential|apiKey|endpoint|token|diagnos|destination/i,
      );
      const dtoConflicting = await allow(adminHeaders, {
        commandId: enableA,
        provider,
        model,
        enabled: false,
      });
      expect(dtoConflicting.status).toBe(409);
      expect(await dtoConflicting.json()).toEqual({
        error: '操作标识已用于不同内容，请核对原操作',
      });

      // Original-key receipt conventions (§11.21, §11.16.52).
      const replay = await allow(
        adminHeaders,
        modelCommand(enableA, defaultModel),
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...enabledBody, replayed: true });
      const unchanged = await allow(
        adminHeaders,
        modelCommand(randomUUID(), defaultModel),
      );
      expect(await unchanged.json()).toEqual({
        commandId: expect.any(String),
        provider,
        model: defaultModel,
        state: 'enabled',
        changed: false,
        replayed: false,
      });
      expect(await allowReceipts()).toBe(5);

      // Judgment 3: send after removal returns a clear re-selectable state,
      // keeps the pending input marker and adds zero supplier requests;
      // frozen dispatches and in-flight steps keep their model; re-adding
      // resumes under the current rules; removal only disables rows.
      const firstPrompt = randomUUID();
      const first = await prompt(firstPrompt, 'Send with the saved model');
      expect(first.status, await first.clone().text()).toBe(200);
      await expect.poll(() => receivedModels).toEqual([model, defaultModel]);
      const frozenBefore = await frozenDispatch();
      const frozenBeforeIds = frozenBefore.map(({ request_id }) => request_id);
      expect(frozenBefore.map(({ model }) => model).sort()).toEqual(
        [model, defaultModel].sort(),
      );
      const disable = await allow(adminHeaders, {
        commandId: randomUUID(),
        provider,
        model: defaultModel,
        enabled: false,
      });
      expect(await disable.json()).toMatchObject({
        state: 'disabled',
        changed: true,
        replayed: false,
      });
      expect(await allowRows()).toEqual([
        { provider: crossProvider, model, state: 'enabled' },
        { provider, model: defaultModel, state: 'disabled' },
        { provider, model: ghostModel, state: 'enabled' },
      ]);
      const removedRequest = randomUUID();
      const afterDisable = await prompt(removedRequest, 'Send after removal');
      expect(afterDisable.status).toBe(409);
      expect(await afterDisable.json()).toEqual({
        error: '已选模型当前不可用，请重新选择后发送',
      });
      expect(afterDisable.headers.get('x-rdws-unsent-prompt')).toBe(
        removedRequest,
      );
      expect(receivedModels).toEqual([model, defaultModel]);
      expect(await originalFrozen()).toEqual(frozenBefore);
      const reenable = await allow(adminHeaders, {
        commandId: randomUUID(),
        provider,
        model: defaultModel,
        enabled: true,
      });
      expect(await reenable.json()).toMatchObject({
        state: 'enabled',
        changed: true,
      });
      const resumed = await prompt(randomUUID(), 'Send after re-adding');
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      await expect
        .poll(() => receivedModels)
        .toEqual([model, defaultModel, defaultModel]);
      expect(await originalFrozen()).toEqual(frozenBefore);
      const stepWrites = async () =>
        (
          await lab.owner.query(
            'select selection_request_id,provider,model from session_model_first_write where native_session_id=$1 order by selection_request_id',
            [sessionId],
          )
        ).rows;
      expect(
        (await stepWrites()).filter((row) =>
          frozenBeforeIds.includes(row.selection_request_id),
        ),
      ).toEqual(
        frozenBefore.map(({ request_id, provider, model }) => ({
          selection_request_id: request_id,
          provider,
          model,
        })),
      );
      const finalDisable = await allow(adminHeaders, {
        commandId: randomUUID(),
        provider,
        model: defaultModel,
        enabled: false,
      });
      expect(await finalDisable.json()).toMatchObject({ changed: true });
      expect(
        (
          await lab.owner.query(
            'select count(*)::int as count from project_model_allowlist where provider=$1 and model=$2',
            [provider, defaultModel],
          )
        ).rows[0]!.count,
      ).toBe(1);
    } finally {
      setDefaultCACertificates(trust);
      vi.unstubAllEnvs();
      if (app) await app.close();
      await ordinary.pool.end();
      try {
        supplier?.close();
      } finally {
        await lab.close();
      }
    }
  },
);
