#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { WallpaperStore } from './lib/store.js';
import { createWallpaperServer } from './lib/server.js';
import { createAccountService } from './lib/accounts.js';
import { GitHubImporter } from './lib/github.js';
import { createCodexNamer, createNamer, createRouterNamer } from './lib/naming.js';

if (existsSync('.env')) loadEnvFile('.env');

const directory = resolve(process.env.DATA_DIR || './data');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be from 1 to 65535.');
mkdirSync(directory, { recursive: true });
function localSecret(variable, filename) {
  if (process.env[variable]) return process.env[variable];
  const tokenFile = join(directory, filename);
  try { return readFileSync(tokenFile, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  }
}
const adminToken = localSecret('ADMIN_TOKEN', 'admin-token');
if (!process.env.ADMIN_TOKEN) console.log(`Admin token saved in ${join(directory, 'admin-token')}`);
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${port}`;
const accounts = await createAccountService({ directory, secret: localSecret('AUTH_SECRET', 'auth-secret'), baseURL: publicUrl });
const store = new WallpaperStore({ directory });
const importer = new GitHubImporter({ store, token: process.env.GITHUB_IMPORT_TOKEN });
const aiNamer = process.env.AI_NAMER || (process.env.ANTHROPIC_API_KEY ? 'claude' : '');
const namers = {
  claude: () => createNamer(),
  codex: () => createCodexNamer({ model: process.env.CODEX_MODEL || undefined }),
  '9router': () => createRouterNamer({ baseURL: process.env.NINEROUTER_URL || undefined, apiKey: process.env.NINEROUTER_API_KEY, model: process.env.NINEROUTER_MODEL }),
};
if (aiNamer && !namers[aiNamer]) throw new Error('AI_NAMER must be claude, codex, or 9router.');
const namer = aiNamer ? namers[aiNamer]() : null;
const server = createWallpaperServer({ store, adminToken, adminName: process.env.ADMIN_NAME || 'Admin', publicUrl, accounts, importer, namer });
server.on('error', async error => { console.error(error.message); await importer.stop(); accounts.close(); store.close(); process.exitCode = 1; });
server.listen(port, host, () => { importer.start(); console.log(`Wallkeep is running at ${publicUrl}`); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  setTimeout(() => process.exit(1), 10_000).unref();
  // Stop the importer first so an interrupted sync releases its lease; keep-alive browser polling would otherwise stall server.close.
  await importer.stop();
  server.close(() => { accounts.close(); store.close(); process.exit(0); });
  server.closeAllConnections();
});
