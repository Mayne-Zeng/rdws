import { buildApp } from './app.ts';
import { readAuthorityTicket } from './modules/authority-ticket.ts';
const {
  DATABASE_URL,
  BETTER_AUTH_SECRET,
  RDWS_ORIGIN = 'http://127.0.0.1:5173',
  RDWS_API_PORT = '3001',
  RDWS_AUTHORITY_TICKET_FILE,
} = process.env;
if (!DATABASE_URL || !BETTER_AUTH_SECRET)
  throw new Error('Run pnpm local:init and use pnpm dev');
delete process.env.RDWS_AUTHORITY_TICKET_FILE;
const app = buildApp({
  databaseUrl: DATABASE_URL,
  secret: BETTER_AUTH_SECRET,
  origin: RDWS_ORIGIN,
  authorityTicket:
    RDWS_AUTHORITY_TICKET_FILE === undefined
      ? undefined
      : await readAuthorityTicket(RDWS_AUTHORITY_TICKET_FILE),
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.stopRuntime().then(
      () => process.exit(0),
      () => {
        console.error('RDWS API shutdown was not confirmed');
        process.exit(1);
      },
    );
  });
try {
  const address = await app.listen({
    host: '127.0.0.1',
    port: Number(RDWS_API_PORT),
  });
  console.log(`RDWS API listening on ${address}`);
} catch (error) {
  await app.stopRuntime();
  throw error;
}
