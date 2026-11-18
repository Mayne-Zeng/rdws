import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { type connectDatabase, schema } from '@rdws/db';
export function createAuth(
  db: ReturnType<typeof connectDatabase>['db'],
  options: { secret: string; origin: string },
) {
  return betterAuth({
    appName: 'RDWS',
    baseURL: options.origin,
    secret: options.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    trustedOrigins: [options.origin],
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: {
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
