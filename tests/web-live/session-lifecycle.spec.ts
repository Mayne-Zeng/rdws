import { nativeReady } from '../helpers/native-ready.ts';
import { bootstrapNative } from '../helpers/native-browser.ts';
import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { runtimeHome } from '../../scripts/env.mjs';
import { signGrant } from '@rdws/dsh/access';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepareSession } from '../helpers/auth-session.ts';
function decodeJournal(bytes: Buffer) {
  let offset = 0,
    text = '';
  while (offset < bytes.length) {
    const result = zstdDecompressSync(bytes.subarray(offset), {
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (result.engine.bytesWritten <= 0)
      throw new Error('Journal decoder made no progress');
    offset += result.engine.bytesWritten;
    text += result.buffer.toString();
  }
  return text
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
}
async function journal(root: string, sessionId: string) {
  const base = join(root, 'runtime/dsh/project-poc/sessions');
  const files = await readdir(base, { recursive: true });
  const file = files.find(
    (p) => p.split('/').includes(sessionId) && p.endsWith('.jsonl.zstd'),
  );
  if (!file) throw new Error('Native journal not persisted');
  const bytes = await readFile(join(base, file));
  const rows = decodeJournal(bytes);
  return {
    bytes,
    header: rows[0],
    events: rows.filter((r) => Number.isSafeInteger(r.seq)),
  };
}
async function requestCount(root: string, ids: string[]) {
  return (await readFile(join(root, 'runtime/context-evidence.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((text) => JSON.parse(text))
    .filter((row) => row.phase === 'request' && ids.includes(row.sessionId))
    .length;
}
test('five real sessions support owned fork, passive replay and current context', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240000);
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function login(name: string) {
    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find((a) => a.username === name)!,
    );
  }
  async function post(path: string, data: unknown) {
    const response = await page.request.post(path, {
      headers: { origin: baseURL! },
      data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  try {
    await login('manager');
    const lead = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    const requirement = await post('/api/projects/poc/requirements', {
      commandId: randomUUID(),
      title: 'Session lifecycle ' + Date.now(),
      description: 'Synthetic lifecycle facts',
      acceptance: 'Five sessions and passive replay',
      leadId: lead,
      participants: [],
    });
    const id = requirement.id as string;
    await login('lead');
    const source = await post(`/api/requirements/${id}/sessions`, {
      commandId: randomUUID(),
    });
    const sessionIds = [source.sessionId as string];
    for (let i = 0; i < 3; i++)
      sessionIds.push(
        (
          await post(`/api/requirements/${id}/sessions`, {
            commandId: randomUUID(),
          })
        ).sessionId,
      );
    await page.goto(`/?project=poc&requirement=${id}&view=chat`);
    await page
      .getByRole('button', { name: '会话 1 · 本人', exact: true })
      .click();
    await page
      .getByLabel('消息', { exact: true })
      .fill('Reply only with RDWS_LIFECYCLE_SOURCE. Do not use tools.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(
      page.locator('.message:not(.from-user)>div').last(),
    ).toContainText('RDWS_LIFECYCLE_SOURCE', { timeout: 60000 });
    await expect(page.locator('[data-live="true"]')).toHaveCount(0, {
      timeout: 20000,
    });
    await page
      .getByRole('button', { name: '派生当前会话', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '会话 5 · 本人 · 派生', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('transcript')).toContainText(
      'RDWS_LIFECYCLE_SOURCE',
    );
    const mappings = (
      await pool.query(
        'select * from native_session where requirement_id=$1 order by created_at,id',
        [id],
      )
    ).rows;
    expect(mappings).toHaveLength(5);
    const child = mappings.find(
      (r) => r.source_session_id === source.sessionId,
    )!;
    expect(child).toBeTruthy();
    sessionIds.push(child.id);
    expect(child.source_through_seq).toBeGreaterThanOrEqual(0);
    await post(`/api/requirements/${id}/commands`, {
      commandId: randomUUID(),
      type: 'requirement.stage',
      stage: 'testing',
    });
    await page
      .getByLabel('消息', { exact: true })
      .fill(
        'Reply only with RDWS_LIFECYCLE_CHILD and the latest requirement stage. Do not use tools.',
      );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(
      page.locator('.message:not(.from-user)>div').last(),
    ).toContainText('RDWS_LIFECYCLE_CHILD', { timeout: 60000 });
    await expect(page.locator('[data-live="true"]')).toHaveCount(0, {
      timeout: 20000,
    });
    const evidence = (
      await readFile(
        join(runtimeHome, 'testing-web/runtime/context-evidence.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
      .filter((r) => r.sessionId === child.id && r.phase === 'request');
    expect(evidence.some((r) => r.contextVersion === 2)).toBe(true);
    const nativeRoot = join(runtimeHome, 'testing-web');
    const callsBeforeReplay = await requestCount(nativeRoot, sessionIds);
    const before = await page.request.get(
      `/api/requirements/${id}/sessions/${child.id}/history?pageSize=1`,
    );
    expect(before.status()).toBe(200);
    let history = await before.json();
    expect(history.hasMore).toBe(true);
    const cursor = history.cursor;
    const seen = new Set<number>();
    for (let pageIndex = 0; ; pageIndex++) {
      expect(pageIndex).toBeLessThan(30);
      for (const event of history.events) {
        expect(seen.has(event.seq)).toBe(false);
        seen.add(event.seq);
      }
      if (!history.hasMore) break;
      const older = await page.request.get(
        `/api/requirements/${id}/sessions/${child.id}/history?pageSize=1&throughSeq=${cursor}&beforeSeq=${history.beforeSeq}`,
      );
      expect(older.status()).toBe(200);
      history = await older.json();
      expect(history.cursor).toBe(cursor);
    }
    expect(seen.size).toBeGreaterThan(4);
    await page.getByRole('button', { name: '回放历史', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '会话历史回放' }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: '历史事件序列' }),
    ).toContainText('RDWS_LIFECYCLE_CHILD');
    expect(
      await page.getByRole('list', { name: '历史事件序列' }).textContent(),
    ).not.toContain('rdws-context');
    await mkdir('.impeccable/review', { recursive: true });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1440, 1024, 820, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `.impeccable/review/session-history-${colorScheme}-${width}.png`,
          animations: 'disabled',
        });
      }
    }
    const root = join(runtimeHome, 'testing-web');
    expect(await requestCount(root, sessionIds)).toBe(callsBeforeReplay);
    const sourceLog = await journal(root, source.sessionId),
      childLog = await journal(root, child.id);
    expect(
      childLog.events.filter((e) => e.seq <= child.source_through_seq),
    ).toEqual(
      sourceLog.events.filter((e) => e.seq <= child.source_through_seq),
    );
    for (const sessionId of sessionIds) {
      const saved = await journal(root, sessionId);
      expect(saved.header.cwd).toBe(join(root, 'projects/poc/demands', id));
      expect(saved.events.filter((e) => e.type === 'tool/call')).toHaveLength(
        0,
      );
      for (const header of saved.events.filter(
        (e) => e.type === 'request/header',
      ))
        expect(header.data.header.tools ?? []).toHaveLength(0);
    }
    const key = await readFile(join(root, 'secrets/dsh-bff-key'), 'utf8');
    const { port, generation: hostGeneration } = await nativeReady(root);
    const actor = await (
      await page.request.get('/api/auth/get-session')
    ).json();
    const workspace = (
      await pool.query(
        'select native_workspace_id from requirement where id=$1',
        [id],
      )
    ).rows[0].native_workspace_id;
    const cap = {
      aud: 'rdws:poc',
      hostGeneration,
      purpose: 'fork' as const,
      userId: lead,
      authSessionId: actor.session.id,
      requirementId: id,
      workspaceId: workspace,
      cwd: join(root, 'projects/poc/demands', id),
      sourceSessionId: source.sessionId,
      atSeq: child.source_through_seq,
    };
    for (const change of [
      { atSeq: child.source_through_seq + 1 },
      { workspaceId: 'wrong' },
      { cwd: '/wrong' },
      { sourceSessionId: 'session-unknown' },
      {
        purpose: 'browser' as const,
        readSessionIds: [source.sessionId],
        ownSessionIds: [source.sessionId],
      },
    ]) {
      const token = signGrant(key, { ...cap, ...change });
      const response = await fetch(
        `http://127.0.0.1:${port}/_rdws/api/session/fork`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-rdws-delegation': token,
          },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/fork',
            payload: {
              args: {
                request: {
                  sessionId: source.sessionId,
                  atSeq: child.source_through_seq,
                  allowMigration: false,
                },
              },
            },
          }),
        },
      );
      const text = await response.text();
      expect([200, 401, 403]).toContain(response.status);
      expect(!response.ok || JSON.parse(text).result?.ok === false).toBe(true);
    }
    const artifactsBefore = (
      await readdir(join(root, 'runtime/dsh/project-poc/sessions'), {
        recursive: true,
      })
    ).filter((p) => p.endsWith('.jsonl.zstd')).length;
    for (const addition of [
      { cwd: '/wrong' },
      { agentPreset: 'unsafe' },
      { workspaceId: 'wrong' },
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/_rdws/api/session/fork`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-rdws-delegation': signGrant(key, cap),
          },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/fork',
            payload: {
              args: {
                request: {
                  sessionId: source.sessionId,
                  atSeq: child.source_through_seq,
                  allowMigration: false,
                  ...addition,
                },
              },
            },
          }),
        },
      );
      const text = await response.text();
      expect(response.status).toBe(403);
      expect(!response.ok || JSON.parse(text).result?.ok === false).toBe(true);
    }
    expect(
      (
        await readdir(join(root, 'runtime/dsh/project-poc/sessions'), {
          recursive: true,
        })
      ).filter((p) => p.endsWith('.jsonl.zstd')).length,
    ).toBe(artifactsBefore);
    await login('manager');
    await page.goto(`/?project=poc&requirement=${id}&view=chat`);
    await page.getByRole('button', { name: '会话 1', exact: true }).click();
    await expect(page.locator('.from-user > span').first()).toHaveText('用户');
    await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
    expect(await requestCount(root, sessionIds)).toBe(callsBeforeReplay);
    expect(errors).toEqual([]);
    await mkdir(join(runtimeHome, 'state/exports'), { recursive: true });
    await writeFile(
      join(runtimeHome, 'state/exports/session-lifecycle-web.json'),
      JSON.stringify(
        {
          requirementId: id,
          sessionIds,
          childId: child.id,
          cut: child.source_through_seq,
          replayCursor: cursor,
          visibleEventCount: seen.size,
          contextVersions: evidence.map((r) => r.contextVersion),
          pageErrors: errors,
          sessionDigest: createHash('sha256')
            .update(JSON.stringify(sessionIds))
            .digest('hex'),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await pool.end();
  }
});
test('cold restart preserves five ids and separates durable logs from interrupted replay', async ({
  page: browserPage,
}) => {
  test.setTimeout(240000);
  const controls = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"header"}\n')),
    zstdCompressSync(Buffer.from('{"type":"sample","seq":0}\n')),
  ]);
  expect(decodeJournal(controls).map((r) => r.type)).toEqual([
    'header',
    'sample',
  ]);
  expect(() =>
    decodeJournal(Buffer.concat([controls, Buffer.from('invalid')])),
  ).toThrow();
  const root = join(runtimeHome, 'testing-sessions', randomUUID());
  const configuration = join(runtimeHome, 'runtime/dsh/project-poc');
  let app!: ReturnType<typeof buildApp>;
  let native: NativeWebHost;
  const reservation = createNetServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const frontPort = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = 'http://127.0.0.1:' + frontPort;
  let apiPort = 0,
    frontend: { close: () => Promise<void> } | undefined;
  async function start() {
    native = new NativeWebHost(root, configuration);
    app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin,
      nativeHost: native,
    });
    const address = await app.listen({ host: '127.0.0.1', port: apiPort });
    apiPort = Number(new URL(address).port);
  }
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  let cookie = '';
  async function request(path: string, body?: unknown, binding?: string) {
    return app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        ...(binding
          ? {
              'x-rdws-client-generation': randomUUID(),
              'x-rdws-native-login': binding,
            }
          : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }
  async function login(name: string) {
    const response = await request(
      '/api/auth/sign-in/username',
      accounts.find((a) => a.username === name),
    );
    expect(response.statusCode).toBe(200);
    cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  let id = '';
  async function rpc(action: string, args: unknown) {
    const binding = await bootstrapNative(app, cookie, id);
    const response = await request(
      `/api/dsh/${id}/native/api/${action}`,
      {
        type: 'client-request',
        rpcId: randomUUID(),
        method: action,
        payload: { args },
      },
      binding,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().result.ok).toBe(true);
    return response.json().result.value;
  }
  async function prompt(sessionId: string, content: string) {
    await rpc('session/prompt', {
      request: {
        sessionId,
        requestId: randomUUID(),
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      },
    });
  }
  async function waitFor(sessionId: string, marker: string) {
    await expect
      .poll(
        async () => {
          const page = await rpc('session/events', {
            request: {
              address: { kind: 'session', sessionId },
              maxMessages: 100,
            },
          });
          const events = page.records.map(
            (r: { event: { seq: number; type: string; data: unknown } }) =>
              r.event,
          );
          const answer = events.findLast(
            (e: { type: string; data: unknown }) =>
              e.type === 'assistant/message' &&
              JSON.stringify(e.data).includes(marker),
          );
          const end = events.findLast(
            (e: { type: string }) => e.type === 'turn/end',
          );
          const start = events.findLast(
            (e: { type: string }) => e.type === 'turn/start',
          );
          return {
            found: !!answer,
            closed:
              !!answer &&
              !!end &&
              end.seq > answer.seq &&
              end.seq > (start?.seq ?? -1),
            lastType: events.at(-1)?.type,
          };
        },
        { timeout: 60000 },
      )
      .toMatchObject({ found: true, closed: true });
  }
  await start();
  try {
    const resolver = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolver.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    const vite = await createVite({
      root: consoleRoot,
      configFile: join(consoleRoot, 'vite.config.ts'),
      cacheDir: join(root, 'vite-cache'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: frontPort,
        strictPort: true,
        proxy: { '/api': { target: 'http://127.0.0.1:' + apiPort, ws: true } },
      },
    });
    frontend = vite;
    await vite.listen();
    await login('manager');
    const leadId = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    const created = await request('/api/projects/poc/requirements', {
      commandId: randomUUID(),
      title: 'Cold lifecycle ' + Date.now(),
      description: 'Synthetic crash recovery',
      acceptance: 'Original IDs survive and passive reads do not write',
      leadId,
      participants: [],
    });
    expect(created.statusCode).toBe(200);
    id = created.json().id;
    await login('lead');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await request(`/api/requirements/${id}/sessions`, {
        commandId: randomUUID(),
      });
      expect(response.statusCode).toBe(200);
      ids.push(response.json().sessionId);
    }
    const source = ids[0]!;
    await prompt(source, 'Reply only with RDWS_COLD_BASE. Do not use tools.');
    await waitFor(source, 'RDWS_COLD_BASE');
    await prompt(
      source,
      'For a cancellation test, print every integer from 1 to 100000, one integer per line, without tools or abbreviations.',
    );
    await expect
      .poll(
        async () => {
          try {
            const events = (await journal(root, source)).events;
            return (
              events.filter((e) => e.type === 'turn/start').length >= 2 &&
              events.filter((e) => e.type === 'turn/start').length >
                events.filter((e) => e.type === 'turn/end').length &&
              events.filter((e) => e.type === 'step/start').length >= 2
            );
          } catch {
            return false;
          }
        },
        { timeout: 30000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    const lock = JSON.parse(
      await readFile(join(root, 'runtime/instances/project-poc.lock'), 'utf8'),
    );
    expect(lock.pid).toBe(process.pid);
    process.kill(lock.childPid, 'SIGKILL');
    await expect
      .poll(
        () => {
          try {
            process.kill(lock.childPid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10000 },
      )
      .toBe(false);
    await app.close();
    const persisted = await journal(root, source);
    const callsBeforeReplay = await requestCount(root, ids);
    const p = persisted.events.at(-1).seq as number;
    expect(persisted.events.at(-1).type).not.toBe('turn/end');
    await start();
    await browserPage.goto(
      origin + '/?project=poc&requirement=' + id + '&view=chat',
    );
    const browserAccount = accounts.find((a) => a.username === 'lead')!;
    await browserPage
      .getByLabel('账号', { exact: true })
      .fill(browserAccount.username);
    await browserPage
      .getByLabel('密码', { exact: true })
      .fill(browserAccount.password);
    await browserPage
      .getByRole('button', { name: '登录', exact: true })
      .click();
    await browserPage
      .getByRole('button', { name: '回放会话 1', exact: true })
      .click();
    await expect(
      browserPage.getByRole('region', { name: '会话历史回放' }),
    ).toContainText('已中断');
    await expect(browserPage.getByLabel('消息', { exact: true })).toHaveCount(
      0,
    );
    expect((await journal(root, source)).bytes.equals(persisted.bytes)).toBe(
      true,
    );
    expect(await requestCount(root, ids)).toBe(callsBeforeReplay);
    const before = await request(
      `/api/requirements/${id}/sessions/${source}/history?pageSize=1`,
    );
    expect(before.statusCode).toBe(200);
    let page = before.json();
    const c = page.cursor;
    expect(c).toBeGreaterThan(p);
    expect(
      page.events.some((e: { outcome?: string }) => e.outcome === '已中断'),
    ).toBe(true);
    while (page.hasMore) {
      const previous = page.beforeSeq;
      const response = await request(
        `/api/requirements/${id}/sessions/${source}/history?pageSize=1&throughSeq=${c}&beforeSeq=${previous}`,
      );
      expect(response.statusCode).toBe(200);
      page = response.json();
      expect(page.cursor).toBe(c);
      expect(page.beforeSeq).toBeLessThan(previous);
    }
    expect((await journal(root, source)).bytes.equals(persisted.bytes)).toBe(
      true,
    );
    const child = await request(
      `/api/requirements/${id}/sessions/${source}/fork`,
      { commandId: randomUUID() },
    );
    expect(child.statusCode).toBe(200);
    const provenance = (
      await pool.query(
        'select source_through_seq from native_session where id=$1',
        [child.json().sessionId],
      )
    ).rows[0];
    expect(provenance.source_through_seq).toBe(c);
    const childLog = await journal(root, child.json().sessionId);
    expect(childLog.events.filter((e) => e.seq <= p)).toEqual(persisted.events);
    expect(
      childLog.events
        .filter((e) => e.seq > p && e.seq <= c)
        .some(
          (e) => e.type === 'turn/end' && e.data.reason.kind === 'interrupted',
        ),
    ).toBe(true);
    expect((await journal(root, source)).bytes.equals(persisted.bytes)).toBe(
      true,
    );
    for (const [index, sid] of ids.entries())
      await prompt(
        sid,
        'Reply only with RDWS_COLD_RESUMED_' + index + '. Do not use tools.',
      );
    for (const [index, sid] of ids.entries()) {
      await waitFor(sid, 'RDWS_COLD_RESUMED_' + index);
      const saved = await journal(root, sid);
      expect(saved.header.id).toBe(sid);
      expect(saved.header.cwd).toBe(join(root, 'projects/poc/demands', id));
      expect(saved.events.filter((e) => e.type === 'tool/call')).toHaveLength(
        0,
      );
      for (const header of saved.events.filter(
        (e) => e.type === 'request/header',
      ))
        expect(header.data.header.tools ?? []).toHaveLength(0);
    }
    const recovered = await journal(root, source);
    expect(recovered.events.slice(0, p + 1)).toEqual(persisted.events);
    expect(
      recovered.events
        .slice(p + 1)
        .some(
          (e) => e.type === 'turn/end' && e.data.reason.kind === 'interrupted',
        ),
    ).toBe(true);
    await mkdir(join(runtimeHome, 'state/exports'), { recursive: true });
    await writeFile(
      join(runtimeHome, 'state/exports/session-lifecycle-cold.json'),
      JSON.stringify(
        {
          requirementId: id,
          ids,
          durableCut: p,
          logicalCut: c,
          forkCut: provenance.source_through_seq,
          sourcePrefixHash: createHash('sha256')
            .update(JSON.stringify(persisted.events))
            .digest('hex'),
          resumedIds: ids,
          passiveReadPreservedBytes: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await frontend?.close();
    await app!.close();
    await pool.end();
  }
});
