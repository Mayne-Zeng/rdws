import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { runtimeHome } from '../../scripts/env.mjs';
function assistantTexts(value: unknown): string[] {
  const result: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const row = v as Record<string, unknown>;
      if (row.type === 'assistant/message') {
        const data = row.data as {
          message?: { content?: { type: string; text?: string }[] };
        };
        result.push(
          (data.message?.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join(''),
        );
      }
      Object.values(row).forEach(visit);
    }
  };
  visit(value);
  return result;
}
test('real requests receive new requirement facts at each native step', async ({
  baseURL,
  page,
}) => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  async function send(
    path: string,
    body?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) {
    return fetch(baseURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseURL!,
        cookie,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(name: string) {
    const r = await send(
      '/api/auth/sign-in/username',
      accounts.find((a) => a.username === name),
    );
    expect(r.status).toBe(200);
    return r.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
  }
  const manager = await login('manager'),
    lead = await login('lead');
  try {
    const leadId = (
      await pool.query('select id from auth_user where username=$1', ['lead'])
    ).rows[0].id;
    const devId = (
      await pool.query('select id from auth_user where username=$1', ['dev'])
    ).rows[0].id;
    const created = await send(
      '/api/projects/poc/requirements',
      {
        commandId: randomUUID(),
        title: 'Context ' + Date.now(),
        description: 'Synthetic context verification',
        acceptance: 'Real frozen request matches current database state',
        leadId,
        participants: [{ userId: devId, roles: ['developer'] }],
        tasks: [{ title: 'Snapshot task' }],
      },
      manager,
    );
    expect(created.status).toBe(200);
    const id = (await created.json()).id;
    const session = await send(`/api/requirements/${id}/sessions`, {}, lead);
    expect(session.status).toBe(200);
    const sid = (await session.json()).sessionId;
    const identity = await (
      await send('/api/auth/get-session', undefined, lead)
    ).json();
    const bootstrap = await send(`/api/dsh/${id}/bootstrap`, undefined, lead, {
      'x-rdws-edit-session': identity.session.id,
    });
    expect(bootstrap.status).toBe(200);
    const { loginBinding } = await bootstrap.json();
    async function rpc(action: string, args: unknown) {
      const r = await send(
        `/api/dsh/${id}/native/api/${action}`,
        {
          type: 'client-request',
          rpcId: randomUUID(),
          method: action,
          payload: { args },
        },
        lead,
        {
          'x-rdws-native-login': loginBinding,
          'x-rdws-client-generation': randomUUID(),
        },
      );
      expect(r.status).toBe(200);
      return r.json();
    }
    const additional = await send(`/api/requirements/${id}/sessions`, {}, lead);
    expect(additional.status).toBe(200);
    const otherSid = (await additional.json()).sessionId;
    async function journal(sessionId = sid) {
      return rpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          maxMessages: 100,
        },
      });
    }
    async function prompt(marker: string, sessionId = sid) {
      const r = await rpc('session/prompt', {
        request: {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [
            {
              type: 'text',
              text:
                'Reply only with ' +
                marker +
                ' and the current requirement stage key from the latest RDWS facts. Do not use tools.',
            },
          ],
        },
      });
      expect(r.result.ok).toBe(true);
      await expect
        .poll(
          async () =>
            assistantTexts(await journal(sessionId)).some((text) =>
              text.includes(marker),
            ),
          { timeout: 45000 },
        )
        .toBe(true);
    }
    await prompt('RDWS_CONTEXT_FIRST');
    const changed = await send(
      `/api/requirements/${id}/commands`,
      { commandId: randomUUID(), type: 'requirement.stage', stage: 'testing' },
      lead,
    );
    expect(changed.status).toBe(200);
    const before = await (
      await send(`/api/requirements/${id}`, undefined, lead)
    ).json();
    const assigned = await send(
      `/api/requirements/${id}/commands`,
      {
        commandId: randomUUID(),
        type: 'task.update',
        taskId: before.tasks[0].id,
        patch: { assigneeId: devId },
      },
      lead,
    );
    expect(assigned.status).toBe(200);
    await prompt('RDWS_CONTEXT_OTHER', otherSid);
    await prompt('RDWS_CONTEXT_SECOND');
    const raw = { primary: await journal(), other: await journal(otherSid) };
    const notes: Record<string, unknown>[] = [],
      responses = assistantTexts(raw);
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') {
        const row = v as Record<string, unknown>;
        if (
          row.role === 'user' &&
          (row.source as { kind?: string })?.kind === 'rdws-context'
        )
          notes.push(row);
        Object.values(row).forEach(visit);
      }
    };
    visit(raw);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(
      responses.some(
        (t) => t.includes('RDWS_CONTEXT_SECOND') && t.includes('testing'),
      ),
    ).toBe(true);
    const evidence = (
      await readFile(
        join(runtimeHome, 'testing-web/runtime/context-evidence.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
      .filter(
        (r) => [sid, otherSid].includes(r.sessionId) && r.phase === 'request',
      );
    expect(evidence.some((r) => r.contextVersion === 1)).toBe(true);
    expect(evidence.some((r) => r.contextVersion === 3)).toBe(true);
    for (const r of evidence) {
      const note = notes.find((n) => n.id === r.messageId)!;
      expect(note).toBeTruthy();
      const content = (note.content as { text: string }[])[0]!.text;
      expect(createHash('sha256').update(content).digest('hex')).toBe(
        r.contentHash,
      );
      const snapshot = JSON.parse(content.slice(content.indexOf('\n') + 1));
      expect(snapshot.contextVersion).toBe(r.contextVersion);
      expect(snapshot.stage).toBe(
        r.contextVersion === 1 ? 'assignment' : 'testing',
      );
      expect(snapshot.tasks[0]).toMatchObject({
        title: 'Snapshot task',
        assigneeId: r.contextVersion === 1 ? leadId : devId,
        status: 'todo',
      });
      expect(snapshot.permissions.codeWrite).toBe(false);
      expect(snapshot.requirementId).toBe(id);
    }
    expect(
      evidence.some((r) => r.sessionId === otherSid && r.contextVersion === 3),
    ).toBe(true);
    await page.goto('/');
    const browserAccount = accounts.find((a) => a.username === 'lead')!;
    await page
      .getByLabel('账号', { exact: true })
      .fill(browserAccount.username);
    await page
      .getByLabel('密码', { exact: true })
      .fill(browserAccount.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      page.getByRole('navigation', { name: '项目导航' }),
    ).toBeVisible();
    await page.goto('/?project=poc&requirement=' + id + '&view=chat');
    await page
      .getByRole('button', { name: '会话 1 · 本人', exact: true })
      .click();
    await expect(page.getByTestId('transcript')).toContainText(
      'RDWS_CONTEXT_SECOND',
    );
    await mkdir('.impeccable/review', { recursive: true });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) {
          expect(
            (await page
              .getByRole('button', { name: '会话 1 · 本人', exact: true })
              .boundingBox())!.height,
          ).toBeGreaterThanOrEqual(40);
          expect(
            (await page
              .getByRole('button', { name: '新建会话', exact: true })
              .boundingBox())!.height,
          ).toBeGreaterThanOrEqual(40);
        }
        await page.screenshot({
          path: '.impeccable/review/chat-' + colorScheme + '-' + width + '.png',
          animations: 'disabled',
          fullPage: true,
        });
      }
    }
    console.log(
      JSON.stringify({
        contextRequests: evidence.length,
        versions: [...new Set(evidence.map((r) => r.contextVersion))],
        nativeMessagesMatch: true,
      }),
    );
  } finally {
    await pool.end();
  }
});
