import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { and, eq, gt, type SQL } from 'drizzle-orm';
import { username } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { type connectDatabase, schema } from '@rdws/db';
import { OBSERVED_LOGIN_HEADER } from '@rdws/contracts/headers';
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
type Logout = { id?: string; notified: boolean };
export const logoutRevocationHeader = 'x-rdws-native-revocation';
export const logoutUnavailableMessage = '退出登录暂未确认，请重试';
const logoutUnavailable = () =>
  new APIError('SERVICE_UNAVAILABLE', { message: logoutUnavailableMessage });

export function createAuth(
  db: Database,
  options: {
    secret: string;
    origin: string;
    onLogout?: (id: string) => Promise<boolean>;
  },
) {
  async function findSessionId(condition: SQL) {
    try {
      const [session] = await db
        .select({ id: schema.session.id })
        .from(schema.session)
        .where(condition);
      return session?.id;
    } catch {
      throw logoutUnavailable();
    }
  }
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
        if (ctx.path === '/sign-out') {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          const id = token
            ? await findSessionId(eq(schema.session.token, token))
            : undefined;
          const observed = ctx.headers?.get(OBSERVED_LOGIN_HEADER);
          if (observed != null && observed !== id)
            throw new APIError('UNAUTHORIZED', {
              message: '登录已变化，请刷新后重试',
            });
          const notified = id
            ? ((await options.onLogout?.(id)) ?? false)
            : false;
          const rdwsLogout: Logout = { id, notified };
          return { context: { context: { rdwsLogout } } };
        }
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
        if (ctx.path === '/sign-out') {
          const result = ctx.context.returned as
            { success?: boolean } | undefined;
          if (result?.success !== true) return;
          const logout = (ctx.context as { rdwsLogout?: Logout }).rdwsLogout;
          if (
            !logout ||
            (logout.id &&
              (await findSessionId(eq(schema.session.id, logout.id))))
          )
            throw logoutUnavailable();
          ctx.setHeader(
            logoutRevocationHeader,
            logout.notified ? 'confirmed' : 'lease-expiry',
          );
          return;
        }
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
