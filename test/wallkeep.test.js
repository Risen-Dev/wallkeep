import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { WallpaperStore } from '../lib/store.js';
import { createWallpaperServer } from '../lib/server.js';

const fixture = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#41654c' } }).png().toBuffer();
const replacement = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#a8b8bc' } }).webp().toBuffer();
const input = { title: 'Garden', filename: 'garden.png', description: 'First light', alt: 'Green garden', author: 'Ari', image: fixture };

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wallkeep-test-'));
  const store = new WallpaperStore({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test('immutable snapshots, metadata revisions, restore, persistence, and deduplication', async t => {
  const { store, directory } = repository(t);
  const first = await store.create(input);
  assert.equal(first.latest.number, 1);
  assert.equal(first.latest.width, 96);
  assert.deepEqual(readFileSync(store.asset(first.id, 1).path), fixture);
  const second = await store.revise(first.id, { expectedVersion: 1, title: 'Garden at dusk', description: 'Evening', alt: 'Blue garden', filename: 'dusk.webp', image: replacement, author: 'Bo' });
  assert.equal(second.id, first.id);
  assert.equal(second.latest.mime, 'image/webp');
  assert.equal(second.latest.width, 120);
  assert.equal(store.getVersion(first.id, 1).title, 'Garden');
  assert.equal(store.getVersion(first.id, 1).author, 'Ari');
  const third = await store.revise(first.id, { expectedVersion: 2, description: 'New description', author: 'Ari' });
  assert.equal(third.latest.hash, second.latest.hash);
  assert.equal(third.latest.filename, 'dusk.webp');
  const restored = store.restore(first.id, 1, { expectedVersion: 3, author: 'Cia' });
  assert.equal(restored.latest.number, 4);
  for (const key of ['hash', 'title', 'description', 'alt', 'filename']) assert.equal(restored.latest[key], first.latest[key]);
  assert.equal(restored.latest.author, 'Cia');
  assert.equal(restored.latest.restoredFrom, 1);
  assert.deepEqual(store.history(first.id, { limit: 2, offset: 1 }).items.map(v => v.number), [3, 2]);
  await store.create({ ...input, title: '100% green' });
  assert.equal(readdirSync(join(directory, 'originals')).length, 2);
  assert.equal(readdirSync(join(directory, 'previews')).length, 2);
  assert.equal(store.list({ query: '%' }).items[0].latest.title, '100% green');
  assert.equal(store.list({ query: '%' }).total, 1);
  assert.equal(store.list({ query: 'Garden' }).items.length, 1);
  const reopened = new WallpaperStore({ directory });
  try { assert.equal(reopened.get(first.id).latest.number, 4); } finally { reopened.close(); }
  const db = new DatabaseSync(join(directory, 'wallkeep.sqlite'));
  try {
    assert.throws(() => db.exec("UPDATE versions SET title = 'Tampered'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM versions'), /immutable/);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

test('stale writes and invalid input leave existing history intact', async t => {
  const { store } = repository(t);
  const first = await store.create(input);
  const results = await Promise.allSettled([
    store.revise(first.id, { expectedVersion: 1, image: replacement, title: 'Revision A' }),
    store.revise(first.id, { expectedVersion: 1, image: fixture, title: 'Revision B' }),
  ]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(results.find(v => v.status === 'rejected').reason.status, 409);
  assert.throws(() => store.restore(first.id, 1, { expectedVersion: 1 }), error => error.status === 409);
  assert.throws(() => store.restore(first.id, 99, { expectedVersion: 2 }), error => error.status === 404);
  await assert.rejects(store.revise(first.id, { title: 'No base version' }), /version number/);
  await assert.rejects(store.create({ ...input, title: '' }), /required/);
  await assert.rejects(store.create({ ...input, image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }), /Invalid image/);
  await assert.rejects(store.create({ ...input, image: fixture.subarray(0, 40) }), /Invalid image/);
  await assert.rejects(store.create({ ...input, image: Buffer.alloc(25 * 1024 * 1024 + 1) }), /25 MiB/);
  const huge = await sharp({ create: { width: 10100, height: 10000, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(store.create({ ...input, image: huge }), /100 megapixels/);
  assert.throws(() => store.list({ limit: -1 }), /limit/);
  assert.equal(store.get(first.id).versionCount, 2);
  assert.equal(store.list().total, 1);
  const second = await store.create({ ...input, title: 'Second' });
  assert.deepEqual(store.neighbors(second.id), { previous: null, next: first.id });
  assert.deepEqual(store.neighbors(first.id), { previous: second.id, next: null });
});

test('HTTP public browsing, admin sessions, CSRF protection, upload, restore, and downloads', async t => {
  const { store } = repository(t);
  const token = 'test-only-admin-token-with-at-least-32-characters';
  const server = createWallpaperServer({ store, adminToken: token, adminName: 'Owner' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(`${base}${path}`, options);
  const json = data => ({ headers: { 'Content-Type': 'application/json', 'X-Wallkeep-Request': '1' }, body: JSON.stringify(data) });
  assert.equal((await request('/api/wallpapers')).status, 200);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await request('/api/wallpapers', { method: 'POST', ...json({}) })).status, 401);
  assert.equal((await request('/api/session', { method: 'POST', ...json({ token: 'wrong' }) })).status, 401);
  const crossOrigin = json({ token });
  crossOrigin.headers.Origin = 'https://other.example';
  assert.equal((await request('/api/session', { method: 'POST', ...crossOrigin })).status, 403);
  const login = await request('/api/session', { method: 'POST', ...json({ token }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(session.authenticated, true);
  assert.equal((await request('/api/wallpapers', { method: 'POST', headers: { Cookie: cookie, Authorization: 'Bearer invalid' } })).status, 403);
  const form = new FormData();
  form.set('image', new Blob([fixture], { type: 'image/jpeg' }), '../../garden.png');
  form.set('title', '<img src=x onerror=alert(1)>');
  form.set('author', 'Spoofed author');
  const upload = await request('/api/wallpapers', { method: 'POST', headers: { Cookie: cookie, 'X-Wallkeep-Request': '1', Origin: base }, body: form });
  assert.equal(upload.status, 201);
  const first = await upload.json();
  assert.equal(first.latest.author, 'Owner');
  assert.equal(first.latest.mime, 'image/png');
  assert.equal(first.latest.filename, 'garden.png');
  const route = `/api/wallpapers/${first.id}`;
  const bearer = { ...json({ expectedVersion: 1, title: 'Metadata update' }), method: 'POST' };
  bearer.headers.Authorization = `Bearer ${token}`;
  delete bearer.headers['X-Wallkeep-Request'];
  assert.equal((await request(`${route}/versions`, bearer)).status, 201);
  const stale = { method: 'POST', ...json({ expectedVersion: 1 }) };
  stale.headers.Authorization = `Bearer ${token}`;
  assert.equal((await request(`${route}/versions/1/restore`, stale)).status, 409);
  const restore = { method: 'POST', ...json({ expectedVersion: 2 }) };
  restore.headers.Authorization = `Bearer ${token}`;
  const restored = await request(`${route}/versions/1/restore`, restore);
  assert.equal(restored.status, 201);
  assert.equal((await restored.json()).latest.number, 3);
  const download = await request(`${route}/versions/1/image?download`);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture);
  assert.equal((await request(`${route}/versions/1/preview`)).headers.get('content-type'), 'image/webp');
  assert.equal((await request(`/wallpapers/${first.id}?v=1`)).status, 200);
  assert.equal((await request('/api/wallpapers?limit=9000')).status, 400);
  const broken = await request(`${route}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
  const oversized = await request(`${route}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'x'.repeat(17_000) }) });
  assert.equal(oversized.status, 413);
  const logout = await request('/api/session', { method: 'DELETE', headers: { Cookie: cookie, 'X-Wallkeep-Request': '1' } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
