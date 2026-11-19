import type { BrowserContext } from '@playwright/test';
import { connectDatabase } from '@rdws/db';
import { createAuth } from '../../apps/server/src/modules/auth.ts';
let client = 0;
export async function prepareSession(
  context: BrowserContext,
  origin: string,
  account: { username: string; password: string },
) {
  const database = connectDatabase(process.env.DATABASE_URL!);
  try {
    const auth = createAuth(database.db, {
      secret: process.env.BETTER_AUTH_SECRET!,
      origin,
    });
    const response = await auth.api.signInUsername({
      body: account,
      headers: new Headers({
        origin,
        'x-rdws-client-ip': '192.0.2.' + ++client,
      }),
      asResponse: true,
    });
    if (!response.ok || !response.headers.getSetCookie().length)
      throw new Error('Synthetic session setup failed');
    const cookies = response.headers.getSetCookie().map((line) => {
      const pair = line.split(';')[0]!,
        at = pair.indexOf('=');
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
        secure: origin.startsWith('https:'),
      };
    });
    const identity = await auth.api.getSession({
      headers: new Headers({
        origin,
        cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      }),
    });
    if (!identity) throw new Error('Synthetic session identity unavailable');
    await context.addCookies(cookies);
    return {
      session: { id: identity.session.id },
      user: { id: identity.user.id },
    };
  } finally {
    await database.pool.end();
  }
}
