import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { and, eq, gt } from 'drizzle-orm';
import { username } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { type connectDatabase, schema } from '@rdws/db';
type Database = ReturnType<typeof connectDatabase>['db'];

export async function currentAccount(
  db: Database,
  sessionId: string,
  userId: string,
) {
  const [user] = await db
    .select({
      id: schema.user.id,
      platformAdmin: schema.user.platformAdmin,
      expiresAt: schema.session.expiresAt,
    })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.session.userId, schema.user.id))
    .where(
      and(
        eq(schema.session.id, sessionId),
        eq(schema.session.userId, userId),
        gt(schema.session.expiresAt, new Date()),
        eq(schema.user.active, true),
        eq(schema.user.authEpoch, schema.session.authEpoch),
      ),
    );
  if (!user || user.expiresAt <= new Date()) return;
  return { id: user.id, platformAdmin: user.platformAdmin };
}

type Login = { id: string; epoch: number };
export function createAuth(
  db: Database,
  options: { secret: string; origin: string },
) {
  return betterAuth({
    appName: 'RDWS',
    baseURL: options.origin,
    secret: options.secret,
    logger: { disabled: true },
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    trustedOrigins: [options.origin],
    emailAndPassword: { enabled: true, disableSignUp: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const field =
          ctx.path === '/sign-in/username'
            ? 'username'
            : ctx.path === '/sign-in/email'
              ? 'email'
              : undefined;
        if (!field) return;
        const value = ctx.body?.[field];
        if (typeof value !== 'string') return;
        const [login] = await db
          .select({ id: schema.user.id, epoch: schema.user.authEpoch })
          .from(schema.user)
          .where(eq(schema.user[field], value.toLowerCase()));
        return { context: { context: { rdwsLogin: login } } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/get-session') return;
        const data = ctx.context.returned as {
          session?: { id: string };
          user?: { id: string };
        } | null;
        if (
          data?.session &&
          data.user &&
          !(await currentAccount(db, data.session.id, data.user.id))
        )
          return ctx.json(null);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const login = (ctx?.context as { rdwsLogin?: Login } | undefined)
              ?.rdwsLogin;
            if (!login || login.id !== session.userId) return false;
            const [active] = await db
              .select({ id: schema.user.id })
              .from(schema.user)
              .where(
                and(
                  eq(schema.user.id, login.id),
                  eq(schema.user.active, true),
                  eq(schema.user.authEpoch, login.epoch),
                ),
              );
            if (!active) return false;
            return { data: { ...session, authEpoch: login.epoch } };
          },
        },
      },
    },
    session: {
      additionalFields: {
        authEpoch: {
          type: 'number',
          input: false,
          returned: false,
          defaultValue: 0,
        },
      },
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 30,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        active: { type: 'boolean', defaultValue: true, input: false },
        platformAdmin: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ['x-rdws-client-ip'] } },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: { '/sign-in/username': { window: 60, max: 10 } },
    },
    plugins: [username({ minUsernameLength: 2 })],
  });
}
