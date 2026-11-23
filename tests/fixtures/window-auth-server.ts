import { once } from 'node:events';
import { buildApp } from '@rdws/server';

// Real sign-in entry for the §11.20.25 window assembly. Runs in a dedicated
// process (the vitest worker corrupts the in-process fastify pipeline),
// reports the resulting auth session over IPC and exits; the session row is
// the same object the trusted read path and its revocation checks consume.
// Seat revocation in the assembly is performed by the proof-bound runtime
// writer (the production revocation writer), not through this entry, so the
// child never waits for a follow-up request. The disconnect fallback ends the
// child even when the parent dies first.

type Boot = {
  databaseUrl: string;
  secret: string;
  origin: string;
  username: string;
  password: string;
};

if (!process.send) throw new Error('Window auth entry requires IPC');
process.on('disconnect', () => process.exit(0));
const [boot] = (await once(process, 'message')) as [Boot];
const app = buildApp({
  databaseUrl: boot.databaseUrl,
  secret: boot.secret,
  origin: boot.origin,
});
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const login = await fetch(address + '/api/auth/sign-in/username', {
  method: 'POST',
  headers: { origin: boot.origin, 'content-type': 'application/json' },
  body: JSON.stringify({ username: boot.username, password: boot.password }),
  redirect: 'error',
  signal: AbortSignal.timeout(8_000),
});
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
await login.text();
const observed = await fetch(address + '/api/auth/get-session', {
  headers: { cookie },
  redirect: 'error',
  signal: AbortSignal.timeout(8_000),
});
const identity = (await observed.json()) as {
  session: { id: string };
  user: { id: string };
};
// The send callback fires once the report has left the process; exiting
// before that could drop the IPC message.
await new Promise<void>((resolve, reject) =>
  process.send!(
    {
      kind: 'session',
      status: login.status,
      sessionId: identity.session?.id,
      userId: identity.user?.id,
    },
    (error) => (error ? reject(error) : resolve()),
  ),
);
await app.close();
process.exit(0);
