import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { WallpaperStore } from '../lib/store.js';
import { GitHubImporter, parseGitHubURL } from '../lib/github.js';
import { createAccountService, configuredProviders } from '../lib/accounts.js';
import { createWallpaperServer } from '../lib/server.js';

const imageA = await sharp({ create: { width: 32, height: 20, channels: 3, background: 'green' } }).png().toBuffer();
const imageB = await sharp({ create: { width: 48, height: 30, channels: 3, background: 'blue' } }).png().toBuffer();
const gitHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const commit = number => String(number).repeat(40);
function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wallkeep-integrations-'));
  const store = new WallpaperStore({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test('GitHub mirrors append changes, archive removals, preserve history, and detach', async t => {
  const { store, directory } = temporaryStore(t);
  let revision = 1, files = { 'garden.png': imageA }, truncated = false, invalidDownload = false;
  let downloads = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(['api.github.com', 'raw.githubusercontent.com'].includes(new URL(url).hostname));
    if (url.includes('raw.githubusercontent.com')) {
      assert.equal(options.headers.Authorization, undefined);
      downloads++;
      return new Response(invalidDownload ? imageB : files[decodeURIComponent(new URL(url).pathname.split('/').pop())]);
    }
    if (/\/commits\//.test(url)) return Response.json({ sha: commit(revision), commit: { tree: { sha: commit(9) } } });
    if (/\/git\/trees\//.test(url)) return Response.json({ truncated, tree: Object.entries(files).map(([path, data]) => ({ path, type: 'blob', mode: '100644', sha: gitHash(data), size: data.length })) });
    return Response.json({ private: false, default_branch: 'main' });
  };
  const importer = new GitHubImporter({ store, fetcher, token: 'api-only-test-token' });
  const source = store.addImport({ owner: 'example', repository: 'wallpapers', mode: 'mirror', intervalMinutes: 5 });
  assert.equal((await importer.sync(source.id)).status, 'synced');
  const wallpaper = store.list().items[0];
  assert.equal(wallpaper.source.mode, 'mirror');
  assert.equal(wallpaper.latest.number, 1);
  assert.equal(store.getImport(source.id).lastCommit, commit(1));
  await importer.sync(source.id);
  assert.equal(downloads, 1);
  assert.equal(store.get(wallpaper.id).versionCount, 1);
  await assert.rejects(store.revise(wallpaper.id, { expectedVersion: 1, title: 'Local edit' }), error => error.status === 409);
  assert.throws(() => store.restore(wallpaper.id, 1, { expectedVersion: 1 }), error => error.status === 409);
  const described = store.editDetails(wallpaper.id, { expectedVersion: 1, description: 'Morning fog' });
  assert.equal(described.versionCount, 1, 'a description edit does not create a version');
  assert.equal(described.latest.description, 'Morning fog');
  assert.throws(() => new DatabaseSync(join(directory, 'wallkeep.sqlite')).exec(`UPDATE versions SET title = 'x'`), /immutable/);
  assert.throws(() => store.editDetails(wallpaper.id, { expectedVersion: 2, description: 'stale' }), /newer version/);
  assert.throws(() => store.editDetails(wallpaper.id, { expectedVersion: 1 }), /title or description/);
  files = { 'garden.png': imageB, 'new image.png': imageA }; revision = 2;
  const changed = await importer.sync(source.id);
  assert.equal(changed.report.updated, 1);
  assert.equal(changed.report.added, 1);
  assert.equal(store.get(wallpaper.id).latest.number, 2);
  assert.equal(store.get(wallpaper.id).latest.description, 'Morning fog', 'mirror updates keep the local description');
  assert.equal(store.getVersion(wallpaper.id, 1).width, 32);
  files = { 'new image.png': imageA }; revision = 3;
  truncated = true;
  assert.equal((await importer.sync(source.id)).status, 'error');
  assert.equal(store.get(wallpaper.id).archived, false, 'incomplete inventories must never archive images');
  truncated = false;
  assert.equal((await importer.sync(source.id)).report.archived, 1);
  assert.equal(store.list().total, 1);
  assert.equal(store.list({ archived: true }).items[0].id, wallpaper.id);
  assert.equal(store.getVersion(wallpaper.id, 1).width, 32);
  files['garden.png'] = imageB; revision = 4;
  await importer.sync(source.id);
  assert.equal(store.get(wallpaper.id).archived, false);
  assert.equal(store.get(wallpaper.id).versionCount, 2);
  store.detachImport(source.id);
  await store.revise(wallpaper.id, { expectedVersion: 2, title: 'Independent now' });
  assert.equal(store.get(wallpaper.id).latest.title, 'Independent now');
  await assert.rejects(importer.sync(source.id), /independent copy/);

  files = { 'corrupted.png': imageA }; invalidDownload = true;
  const copy = store.addImport({ owner: 'example', repository: 'second', mode: 'copy' });
  const partial = await importer.sync(copy.id);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.fileCount, 0);
  assert.match(partial.report.errors[0].error, /Git blob/);
  assert.deepEqual(partial.report.failedPaths, ['corrupted.png']);
  assert.throws(() => store.queueImport(source.id, { retry: true }), /independent copy/);
  invalidDownload = false;
  files['extra.png'] = imageB;
  store.queueImport(copy.id, { retry: true });
  const before = downloads;
  const retried = await importer.sync(copy.id);
  assert.equal(downloads - before, 1, 'a retry downloads only the failed file');
  assert.equal(retried.fileCount, 1);
  assert.deepEqual(retried.report.failedPaths, []);
  assert.throws(() => store.queueImport(copy.id, { retry: true }), /independent copy|no failed files/);
  delete files['extra.png'];
  assert.equal(store.getImport(copy.id).status, 'synced');
  // Removing a repository deletes its wallpapers, versions, and files no other wallpaper uses.
  const kept = await store.create({ title: 'Local twin', image: imageA, filename: 'twin.png' });
  const removedId = store.importedFiles(copy.id)[0].wallpaperId;
  const removedHash = store.get(removedId).latest.hash;
  const sharedPreviews = readdirSync(join(directory, 'previews')).length;
  assert.deepEqual(store.removeImport(copy.id), { id: copy.id, repository: 'example/second', removed: 1 });
  assert.throws(() => store.get(removedId), /not found/);
  assert.throws(() => store.getImport(copy.id), /not found/i);
  assert.equal(store.get(kept.id).latest.hash, removedHash, 'identical bytes stay for the local wallpaper');
  assert.equal(readdirSync(join(directory, 'previews')).length, sharedPreviews);
  assert.equal(store.removeImport(source.id).removed, 2, 'detached and archived wallpapers are removed too');
  assert.equal(readdirSync(join(directory, 'previews')).length, sharedPreviews - 1, 'the image only that repository used is deleted');
  assert.equal(readdirSync(join(directory, 'originals')).length, sharedPreviews - 1);
  assert.throws(() => new DatabaseSync(join(directory, 'wallkeep.sqlite')).exec(`DELETE FROM versions WHERE wallpaper_id = '${kept.id}'`), /immutable/);
  const leaseSource = store.addImport({ owner: 'example', repository: 'lease', mode: 'mirror' });
  assert.equal(store.claimImport(leaseSource.id, 'first-worker'), true);
  assert.equal(store.claimImport(leaseSource.id, 'other-worker'), false);
  assert.throws(() => store.detachImport(leaseSource.id), /current sync/);
  assert.throws(() => store.removeImport(leaseSource.id), /current sync/);
  const db = new DatabaseSync(join(directory, 'wallkeep.sqlite'));
  db.prepare('UPDATE import_sources SET lease_until = 0 WHERE id = ?').run(leaseSource.id);
  db.close();
  assert.throws(() => store.renewImport(leaseSource.id, 'first-worker'), /lease expired/);
  assert.ok(store.dueImports().includes(leaseSource.id));
  assert.equal(store.claimImport(leaseSource.id, 'recovered-worker'), true);
  assert.throws(() => store.renewImport(leaseSource.id, 'first-worker'), /lease expired/);
});

test('large imports exceed 500 images and 500 MiB while renewing the worker lease', async t => {
  const { store } = temporaryStore(t);
  // A valid PNG with trailing padding crosses the actual download budget while sharing one disk blob.
  const image = Buffer.alloc(1024 * 1024);
  imageA.copy(image);
  const sha = gitHash(image);
  let now = Date.now(), downloads = 0;
  t.mock.method(Date, 'now', () => now);
  const source = store.addImport({ owner: 'example', repository: 'large', mode: 'mirror' });
  const files = Array.from({ length: 501 }, (_, index) => ({ path: `${index}.png`, type: 'blob', mode: '100644', sha, size: image.length }));
  const importer = new GitHubImporter({ store, fetcher: async url => {
    if (url.includes('raw.githubusercontent.com')) {
      // Simulate a long-running import without waiting in real time.
      now += 20_000;
      assert.equal(store.claimImport(source.id, 'competing-worker'), false);
      downloads++;
      return new Response(image);
    }
    if (/\/commits\//.test(url)) return Response.json({ sha: commit(1), commit: { tree: { sha: commit(9) } } });
    if (/\/git\/trees\//.test(url)) return Response.json({ truncated: false, tree: files });
    return Response.json({ private: false, default_branch: 'main' });
  } });
  const result = await importer.sync(source.id);
  assert.equal(result.status, 'synced', JSON.stringify(result.report));
  assert.equal(result.report.added, 501);
  assert.equal(result.fileCount, 501);
  assert.equal(downloads * image.length, 501 * 1024 * 1024);
  assert.equal(store.list().total, 501);
  const repeat = await importer.sync(source.id);
  assert.equal(repeat.report.unchanged, 501);
  assert.equal(downloads, 501, 'unchanged files must not download again');
});

test('GitHub URL validation prevents arbitrary hosts and supports folder URLs', () => {
  assert.deepEqual(parseGitHubURL('https://github.com/example/walls/tree/main/nature'), { owner: 'example', repository: 'walls', branch: 'main', folder: 'nature' });
  assert.deepEqual(parseGitHubURL('https://github.com/example/walls.git'), { owner: 'example', repository: 'walls', branch: '', folder: '' });
  assert.equal(parseGitHubURL('https://github.com/example/walls/tree/feature/photos/nature', { branch: 'feature/photos' }).folder, 'nature');
  for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:pass@github.com/a/b', 'http://127.0.0.1/', 'file:///etc/passwd', 'https://github.com/a/b?token=secret', 'https://github.com/a/b/blob/main/test.png', 'https://github.com/a/%2e%2e']) {
    assert.throws(() => parseGitHubURL(url));
  }
  assert.equal(configuredProviders({ APPLE_CLIENT_ID: 'id', APPLE_CLIENT_SECRET: 'secret' }, 'http://localhost:3000').apple, undefined);
});

test('email login, explicit multi-provider linking, ownership, admin access, and logout', async t => {
  const { store, directory } = temporaryStore(t);
  const messages = [];
  // Only these test providers bypass external token verification; production uses Better Auth's verifiers.
  const fakeProvider = (id, email) => ({
    clientId: `test-${id}`, clientSecret: 'test-client-secret',
    verifyIdToken: async token => token === `verified-${id}`,
    getUserInfo: async () => ({ user: { name: 'Test owner', email, emailVerified: true }, data: { sub: `${id}-subject`, id: `${id}-subject` } }),
  });
  const accounts = await createAccountService({ directory, secret: 'test-only-secret-with-more-than-32-characters', baseURL: 'http://localhost:3000', env: {}, sendEmail: async message => messages.push(message),
    socialProviders: { google: fakeProvider('google', 'owner@example.test'), github: fakeProvider('github', 'other-provider@example.test') },
  });
  const adminToken = 'test-admin-token-with-more-than-32-characters';
  const importer = new GitHubImporter({ store });
  const server = createWallpaperServer({ store, accounts, importer, adminToken, publicUrl: 'http://localhost:3000' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); accounts.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookies = '';
  const request = (path, body, cookie = cookies) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Wallkeep-Request': '1', Origin: 'http://localhost:3000', Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const collectCookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const sendLink = async email => {
    const response = await request('/api/auth/sign-in/magic-link', { email, callbackURL: '/account' });
    assert.equal(response.status, 200, await response.text());
    const url = new URL(messages.at(-1).text.match(/https?:\/\/\S+/)[0]);
    const verified = await request(`${url.pathname}${url.search}`);
    assert.equal(verified.status, 302);
    return { cookie: collectCookies(verified), path: `${url.pathname}${url.search}` };
  };
  // Admin-token login from the request's own host works even when it differs from PUBLIC_URL.
  const tokenLogin = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wallkeep-Request': '1', Origin: base }, body: JSON.stringify({ token: adminToken }) });
  assert.equal(tokenLogin.status, 200, await tokenLogin.text());
  const emailLogin = await sendLink('owner@example.test');
  cookies = emailLogin.cookie;
  let session = await (await request('/api/session')).json();
  const ownerId = session.user.id;
  assert.equal(session.user.emailVerified, true);
  assert.equal(session.isAdmin, false);
  assert.equal((await request('/api/wallpapers', {})).status, 403);
  assert.equal((await request('/api/imports')).status, 403);
  const replay = await request(emailLogin.path, undefined, '');
  assert.match(replay.headers.get('location'), /error=/);
  assert.equal(collectCookies(replay), '');
  const implicit = await request('/api/auth/sign-in/social', { provider: 'google', idToken: { token: 'verified-google' } }, '');
  assert.notEqual(implicit.status, 200, 'same-email social sign-in must not implicitly link');
  assert.equal((await request('/api/auth/link-social', { provider: 'google', idToken: { token: 'verified-google' } }, '')).status, 401);
  for (const provider of ['google', 'github']) {
    const linked = await request('/api/auth/link-social', { provider, idToken: { token: `verified-${provider}` } });
    assert.equal(linked.status, 200, await linked.text());
  }
  const links = await (await request('/api/auth/list-accounts')).json();
  assert.deepEqual(links.map(account => account.providerId).sort(), ['github', 'google']);
  const githubLogin = await request('/api/auth/sign-in/social', { provider: 'github', idToken: { token: 'verified-github' } }, '');
  assert.equal(githubLogin.status, 200, await githubLogin.clone().text());
  assert.equal((await githubLogin.json()).user.id, ownerId);
  assert.equal((await request('/api/account/claim-admin', { token: 'wrong' })).status, 401);
  assert.equal((await request('/api/account/claim-admin', { token: adminToken })).status, 200);
  assert.equal((await (await request('/api/session')).json()).accountAdmin, true);
  assert.equal((await request('/api/imports')).status, 200);
  const other = await sendLink('another@example.test');
  assert.equal((await request('/api/auth/link-social', { provider: 'github', idToken: { token: 'verified-github' } }, other.cookie)).status, 409);
  const google = links.find(account => account.providerId === 'google');
  assert.equal((await request('/api/auth/unlink-account', { accountId: google.id })).status, 200);
  assert.equal((await request('/api/auth/unlink-account', { accountId: links.find(account => account.providerId === 'github').id })).status, 400);
  assert.equal((await request('/api/auth/sign-out', {})).status, 200);
  assert.equal((await (await request('/api/session')).json()).authenticated, false);
});

test('a stalled image download is aborted on shutdown and the import is re-queued', async t => {
  const { store } = temporaryStore(t);
  let downloading;
  const started = new Promise(resolve => { downloading = resolve; });
  const fetcher = async url => {
    if (url.includes('raw.githubusercontent.com')) {
      downloading();
      // Sends one byte, then never finishes and ignores the fetch signal, like the stuck GitHub download.
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }));
    }
    if (/\/commits\//.test(url)) return Response.json({ sha: commit(1), commit: { tree: { sha: commit(9) } } });
    if (/\/git\/trees\//.test(url)) return Response.json({ truncated: false, tree: [{ path: 'stuck.png', type: 'blob', mode: '100644', sha: gitHash(imageA), size: imageA.length }] });
    return Response.json({ private: false, default_branch: 'main' });
  };
  const importer = new GitHubImporter({ store, fetcher });
  const source = store.addImport({ owner: 'example', repository: 'stuck', mode: 'mirror' });
  const run = importer.sync(source.id);
  await started;
  const stopped = Date.now();
  await importer.stop();
  const result = await run;
  assert.ok(Date.now() - stopped < 2000, 'stop must not wait for the stalled download');
  assert.equal(result.status, 'queued');
  assert.equal(store.claimImport(source.id, 'next-start'), true, 'the lease was released');
});
