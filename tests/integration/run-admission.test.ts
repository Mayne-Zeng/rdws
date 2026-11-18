import { test, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
class FailedAdmissionHost extends NativeWebHost {
  mode: 'sideband' | 'rejected' | 'accepted' = 'sideband';
  constructor() {
    super('/tmp/rdws-admission-unstarted');
  }
  override async workspace() {
    return { workspaceId: 'w', cwd: '/unused' };
  }
  override ticket() {
    return 'synthetic-ticket';
  }
  override claims() {
    return {
      aud: this.audience,
      purpose: 'browser' as const,
      nonce: 'peer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20000,
    };
  }
  override async control(operation: string) {
    if (operation === 'run' && this.mode === 'sideband')
      throw new Error('Controlled admission outage');
    return { seen: false };
  }
  override async fetch(
    _path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    return new Response(
      JSON.stringify({
        type: 'server-response',
        rpcId: JSON.parse(String(init.body)).rpcId,
        result:
          this.mode === 'accepted'
            ? { ok: true, value: { accepted: true } }
            : {
                ok: false,
                error: {
                  code: 'gateway/internal',
                  message: 'Rejected',
                  details: {},
                },
              },
      }),
    );
  }
  override async close() {}
}
test('failed sideband and rejected RPC admissions release their global quota', async () => {
  const native = new FailedAdmissionHost(),
    app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin: process.env.RDWS_ORIGIN!,
      nativeHost: native,
    }),
    pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const id = randomUUID(),
    sid = 'admission-' + randomUUID();
  try {
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: process.env.RDWS_ORIGIN! },
      payload: accounts.find(
        (a: { username: string }) => a.username === 'lead',
      ),
    });
    const uid = login.json().user.id,
      cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
      [id, 'poc', 'Admission fixture', 'Synthetic', 'No quota leak', uid, 'w'],
    );
    await pool.query('insert into requirement_participant values($1,$2,$3)', [
      id,
      uid,
      'developer',
    ]);
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sid, id, uid],
    );
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/dsh/${id}/native/api/session/prompt`,
        headers: {
          cookie,
          origin: process.env.RDWS_ORIGIN!,
          'x-rdws-client-generation': randomUUID(),
        },
        payload: {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session/prompt',
          payload: {
            args: {
              request: {
                sessionId: sid,
                requestId: randomUUID(),
                mode: 'queue',
                content: [{ type: 'text', text: 'Synthetic prompt' }],
              },
            },
          },
        },
      });
    for (let i = 0; i < 515; i++) expect((await send()).statusCode).toBe(500);
    native.mode = 'rejected';
    for (let i = 0; i < 515; i++) expect((await send()).statusCode).toBe(200);
    native.mode = 'accepted';
    expect((await send()).statusCode).toBe(200);
  } finally {
    await pool.query('delete from native_session where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
    await app.close();
    await pool.end();
  }
}, 30000);
