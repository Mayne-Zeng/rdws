import { buildApp } from './app.ts';
const {
  DATABASE_URL,
  BETTER_AUTH_SECRET,
  RDWS_ORIGIN = 'http://127.0.0.1:5173',
  RDWS_API_PORT = '3001',
} = process.env;
if (!DATABASE_URL || !BETTER_AUTH_SECRET)
  throw new Error('Run pnpm local:init and use pnpm dev');
const app = buildApp({
  databaseUrl: DATABASE_URL,
  secret: BETTER_AUTH_SECRET,
  origin: RDWS_ORIGIN,
});
await app.listen({ host: '127.0.0.1', port: Number(RDWS_API_PORT) });
console.log(`RDWS API listening on 127.0.0.1:${RDWS_API_PORT}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
