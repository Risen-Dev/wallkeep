import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { magicLink } from 'better-auth/plugins';
import nodemailer from 'nodemailer';

export function configuredProviders(env, baseURL) {
  const providers = {};
  for (const name of ['google', 'github']) {
    const prefix = name.toUpperCase();
    if (env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`]) {
      providers[name] = { clientId: env[`${prefix}_CLIENT_ID`], clientSecret: env[`${prefix}_CLIENT_SECRET`] };
    }
  }
  const origin = new URL(baseURL);
  const appleHTTPS = origin.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const appleKey = env.APPLE_PRIVATE_KEY_FILE ? readFileSync(env.APPLE_PRIVATE_KEY_FILE, 'utf8') : env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (env.APPLE_CLIENT_ID && appleHTTPS && (env.APPLE_CLIENT_SECRET || (appleKey && env.APPLE_TEAM_ID && env.APPLE_KEY_ID))) {
    if (env.APPLE_CLIENT_SECRET) providers.apple = { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET };
    else {
      const key = createPrivateKey(appleKey);
      if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Apple requires a P-256 private key.');
      providers.apple = async () => {
        const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const payload = `${encode({ alg: 'ES256', kid: env.APPLE_KEY_ID })}.${encode({ iss: env.APPLE_TEAM_ID, sub: env.APPLE_CLIENT_ID, aud: 'https://appleid.apple.com', iat: now, exp: now + 3600 })}`;
        const signature = sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        return { clientId: env.APPLE_CLIENT_ID, clientSecret: `${payload}.${signature}` };
      };
    }
  }
  return providers;
}

/** Stateful authentication, independent of wallpaper data and of the UI. */
export async function createAccountService({ directory, secret, baseURL, env = process.env, sendEmail, socialProviders } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 random characters.');
  const origin = new URL(baseURL);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path.');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'accounts.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const providers = socialProviders ?? configuredProviders(env, baseURL);
  const mailer = env.SMTP_URL && env.SMTP_FROM ? nodemailer.createTransport(env.SMTP_URL, { from: env.SMTP_FROM }) : null;
  const send = sendEmail ?? (mailer ? message => mailer.sendMail(message) : null);
  const options = {
    appName: 'Wallkeep', database: db, secret, baseURL: origin.origin,
    trustedOrigins: [origin.origin, ...(providers.apple ? ['https://appleid.apple.com'] : [])],
    socialProviders: providers,
    session: { expiresIn: 7 * 24 * 3600, freshAge: 600 },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true, allowUnlinkingAll: false },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: { ipAddress: { ipAddressHeaders: ['x-wallkeep-client-ip'] } },
    onAPIError: { errorURL: '/account?error=authentication_failed' },
    plugins: send ? [magicLink({
      expiresIn: 600, storeToken: 'hashed',
      sendMagicLink: async ({ email, url }) => {
        await send({ to: email, subject: 'Sign in to Wallkeep', text: `Sign in to your Wallkeep account:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.` });
      },
    })] : [],
  };
  try {
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    db.exec('CREATE TABLE IF NOT EXISTS wallkeep_admins (user_id TEXT PRIMARY KEY REFERENCES user(id))');
    const auth = betterAuth(options);
    await (await auth.$context).checkSchema?.();
    const adminEmails = new Set((env.ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
    return {
      auth, baseURL: origin.origin, emailEnabled: !!send,
      providers: ['google', 'github', 'apple'].map(id => ({ id, enabled: !!providers[id] })),
      isAdmin(user) {
        return !!user && (!!db.prepare('SELECT user_id FROM wallkeep_admins WHERE user_id = ?').get(user.id)
          || (user.emailVerified && adminEmails.has(user.email.toLowerCase())));
      },
      grantAdmin(userId) { db.prepare('INSERT OR IGNORE INTO wallkeep_admins VALUES (?)').run(userId); },
      close() { mailer?.close(); db.close(); },
    };
  } catch (error) { mailer?.close(); db.close(); throw error; }
}
