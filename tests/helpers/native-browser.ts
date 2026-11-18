import { nativeLoginBinding } from '@rdws/dsh/access';
import type { buildApp } from '@rdws/server';

type App = ReturnType<typeof buildApp>;

export async function observedLogin(app: App, cookie: string) {
  const response = await app.inject({
    url: '/api/auth/get-session',
    headers: { cookie },
  });
  if (response.statusCode !== 200) throw new Error('Test login is unavailable');
  return response.json<{ session: { id: string } }>().session.id;
}

export async function fixtureBinding(
  app: App,
  cookie: string,
  projectId: string,
  requirementId: string,
) {
  return nativeLoginBinding(
    await observedLogin(app, cookie),
    projectId,
    requirementId,
  );
}

export async function bootstrapNative(app: App, cookie: string, id: string) {
  const observed = await observedLogin(app, cookie);
  const response = await app.inject({
    url: `/api/dsh/${id}/bootstrap`,
    headers: { cookie, 'x-rdws-edit-session': observed },
  });
  if (response.statusCode !== 200)
    throw new Error(`Test Native bootstrap failed (${response.statusCode})`);
  return response.json<{ loginBinding: string }>().loginBinding;
}
