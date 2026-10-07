import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_BYTES, WallkeepError } from './store.js';
import { fromNodeHeaders } from 'better-auth/node';

const PUBLIC = new URL('../public/', import.meta.url);
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const COOKIE = 'wallkeep_session';
const digest = value => createHash('sha256').update(value).digest();
const equal = (left, right) => timingSafeEqual(digest(left), digest(right));

async function body(request, max) {
  if (Number(request.headers['content-length']) > max) throw new WallkeepError('Request is too large.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new WallkeepError('Request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request, max = 16_384) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new WallkeepError('Expected application/json.', 415);
  try {
    const data = JSON.parse((await body(request, max)).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid object');
    return data;
  } catch (error) {
    if (error instanceof WallkeepError) throw error;
    throw new WallkeepError('Invalid JSON object.');
  }
}

async function uploadBody(request) {
  const type = request.headers['content-type'] ?? '';
  if (type.startsWith('application/json')) return jsonBody(request);
  if (!type.startsWith('multipart/form-data;')) throw new WallkeepError('Expected multipart/form-data.', 415);
  const bytes = await body(request, MAX_IMAGE_BYTES + 32_768);
  let form;
  try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new WallkeepError('Invalid upload form.'); }
  const result = {};
  for (const key of ['title', 'description', 'alt', 'message', 'expectedVersion']) {
    if (!form.has(key)) continue;
    const value = form.get(key);
    if (typeof value !== 'string') throw new WallkeepError(`Invalid ${key}.`);
    result[key] = key === 'expectedVersion' ? Number(value) : value;
  }
  const file = form.get('image');
  if (file && typeof file !== 'string' && file.size) {
    result.image = new Uint8Array(await file.arrayBuffer());
    result.filename = file.name;
  } else if (typeof file === 'string') throw new WallkeepError('Image must be a file.');
  return result;
}

function pagination(url) {
  return { limit: Number(url.searchParams.get('limit') ?? 40), offset: Number(url.searchParams.get('offset') ?? 0) };
}

/** Return an unbound Node HTTP server. The caller owns the store's lifecycle. */
export function createWallpaperServer({ store, adminToken, adminName = 'Admin', publicUrl, accounts, importer } = {}) {
  if (!store || typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('A store and an admin token of at least 32 characters are required.');
  const configuredOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const secureCookies = configuredOrigin?.startsWith('https:') ?? false;
  const signature = expiry => createHmac('sha256', adminToken).update(`session:${expiry}`).digest('hex');
  let uploads = 0;

  function authenticated(request) {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') && equal(authorization.slice(7), adminToken)) return true;
    const session = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!session) return false;
    const [expiry, signed, extra] = session.split('.');
    return !extra && /^\d{13}$/.test(expiry) && Number(expiry) > Date.now() && !!signed && equal(signed, signature(expiry));
  }

  function checkBrowserRequest(request) {
    // Explicit header blocks cross-site form posts; the browser also enforces same-origin fetch.
    if (request.headers['x-wallkeep-request'] !== '1') throw new WallkeepError('Missing request protection header.', 403);
    const origin = request.headers.origin;
    const expected = configuredOrigin ?? `http://${request.headers.host}`;
    if (origin && origin !== expected) throw new WallkeepError('Cross-origin writes are not allowed.', 403);
  }

  const accountSession = request => accounts?.auth.api.getSession({ headers: fromNodeHeaders(request.headers) }) ?? null;
  async function requireAdmin(request, { read = false } = {}) {
    const legacy = authenticated(request);
    const user = legacy ? null : (await accountSession(request))?.user;
    if (!legacy && !user) throw new WallkeepError('Sign in as admin to make changes.', 401);
    if (!legacy && !accounts.isAdmin(user)) throw new WallkeepError('This account can browse. An admin account is required to change this library.', 403);
    const authorization = request.headers.authorization;
    if (!read && !(authorization?.startsWith('Bearer ') && equal(authorization.slice(7), adminToken))) checkBrowserRequest(request);
    return user ? (user.name || 'Member').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : adminName;
  }

  function cookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  }

  const server = createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      if (path.startsWith('/api/auth/')) {
        if (!accounts) throw new WallkeepError('Account login is not configured.', 503);
        const action = path.slice('/api/auth'.length);
        const callback = /^\/callback\/(google|github|apple)$/.test(action);
        const getPaths = ['/get-session', '/list-accounts', '/magic-link/verify'];
        const postPaths = ['/sign-in/social', '/sign-in/magic-link', '/sign-out', '/link-social', '/unlink-account'];
        if (!(callback && ['GET', 'POST'].includes(method)) && !(method === 'GET' && getPaths.includes(action)) && !(method === 'POST' && postPaths.includes(action))) throw new WallkeepError('Not found.', 404);
        if (method === 'POST' && !callback) checkBrowserRequest(request);
        if (['/link-social', '/unlink-account'].includes(action)) {
          const session = await accountSession(request);
          if (!session) throw new WallkeepError('Sign in before connecting a provider.', 401);
          if (Date.now() - new Date(session.session.createdAt).getTime() > 600_000) throw new WallkeepError('Sign out and sign in again before changing linked providers.', 403);
        }
        if (action === '/sign-in/magic-link' && !accounts.emailEnabled) throw new WallkeepError('Email login requires SMTP configuration on this server.', 503);
        const headers = fromNodeHeaders(request.headers);
        // Never trust a client-supplied IP header for authentication rate limits.
        headers.set('x-wallkeep-client-ip', request.socket.remoteAddress || '127.0.0.1');
        const result = await accounts.auth.handler(new Request(`${accounts.baseURL}${path}${url.search}`, {
          method, headers, ...(method === 'POST' ? { body: await body(request, 32_768) } : {}),
        }));
        for (const [key, value] of result.headers) if (key !== 'set-cookie') response.setHeader(key, value);
        const cookies = result.headers.getSetCookie();
        if (cookies.length) response.setHeader('Set-Cookie', cookies);
        response.setHeader('Cache-Control', 'no-store');
        response.statusCode = result.status;
        return response.end(Buffer.from(await result.arrayBuffer()));
      }
      if (path === '/api/session' && method === 'GET') {
        const signed = await accountSession(request);
        const legacy = authenticated(request);
        return send(200, {
          authenticated: legacy || !!signed, isAdmin: legacy || !!accounts?.isAdmin(signed?.user),
          accountAdmin: !!accounts?.isAdmin(signed?.user),
          adminName: signed?.user?.name || adminName,
          user: signed ? { id: signed.user.id, name: signed.user.name, email: signed.user.email, emailVerified: signed.user.emailVerified } : null,
          providers: accounts?.providers ?? [], emailEnabled: accounts?.emailEnabled ?? false,
        });
      }
      if (path === '/api/account/claim-admin' && method === 'POST') {
        checkBrowserRequest(request);
        const signed = await accountSession(request);
        if (!signed) throw new WallkeepError('Sign in to an account first.', 401);
        const { token } = await jsonBody(request, 4096);
        if (typeof token !== 'string' || !equal(token, adminToken)) throw new WallkeepError('Incorrect admin token.', 401);
        accounts.grantAdmin(signed.user.id);
        return send(200, { isAdmin: true });
      }
      if (path === '/api/session' && method === 'POST') {
        checkBrowserRequest(request);
        const { token } = await jsonBody(request, 4096);
        if (typeof token !== 'string' || !equal(token, adminToken)) throw new WallkeepError('Incorrect admin token.', 401);
        const expiry = String(Date.now() + 12 * 60 * 60 * 1000);
        response.setHeader('Set-Cookie', cookie(`${expiry}.${signature(expiry)}`, 43_200));
        return send(200, { authenticated: true, adminName });
      }
      if (path === '/api/session' && method === 'DELETE') {
        checkBrowserRequest(request);
        response.setHeader('Set-Cookie', cookie('', 0));
        return send(200, { authenticated: false });
      }
      if (path === '/api/wallpapers' && method === 'GET') return send(200, store.list({ query: url.searchParams.get('q') ?? '', archived: url.searchParams.get('archived') === '1', ...pagination(url) }));

      const importRoute = path.match(/^\/api\/imports(?:\/([a-f0-9-]{36})(?:\/(sync|detach|files))?)?$/);
      if (importRoute) {
        await requireAdmin(request, { read: method === 'GET' });
        if (!importer) throw new WallkeepError('GitHub imports are not configured.', 503);
        const [, id, action] = importRoute;
        if (method === 'GET' && !id) return send(200, { items: store.imports() });
        if (method === 'GET' && id) return send(200, action === 'files' ? { items: store.importedFiles(id) } : store.getImport(id));
        if (method === 'POST' && !id) return send(202, importer.add(await jsonBody(request)));
        if (method === 'POST' && action === 'sync') {
          const source = store.queueImport(id);
          importer.kick();
          return send(202, source);
        }
        if (method === 'POST' && action === 'detach') return send(200, store.detachImport(id));
        throw new WallkeepError('Not found.', 404);
      }

      const item = path.match(/^\/api\/wallpapers\/([a-f0-9-]{36})(?:\/versions(?:\/(\d+)(?:\/(image|preview|restore))?)?)?$/);
      if (item && method === 'GET') {
        const [, id, number, action] = item;
        if (number && ['image', 'preview'].includes(action)) {
          const asset = store.asset(id, Number(number), { preview: action === 'preview' });
          const info = await stat(asset.path);
          response.setHeader('Content-Type', asset.mime);
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.setHeader('Content-Length', info.size);
          if (url.searchParams.has('download')) response.setHeader('Content-Disposition', `attachment; filename="wallpaper"; filename*=UTF-8''${encodeURIComponent(asset.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`);
          const stream = createReadStream(asset.path);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          return stream.pipe(response);
        }
        if (action) throw new WallkeepError('Not found.', 404);
        return send(200, number ? store.getVersion(id, Number(number)) : path.endsWith('/versions') ? store.history(id, pagination(url)) : store.get(id));
      }

      if (method === 'POST' && (path === '/api/wallpapers' || item)) {
        const author = await requireAdmin(request);
        if (item?.[3] === 'restore') {
          const input = await jsonBody(request);
          return send(201, store.restore(item[1], Number(item[2]), { ...input, author }));
        }
        if (item && !path.endsWith('/versions')) throw new WallkeepError('Not found.', 404);
        // ponytail: two concurrent decodes cap memory on a small host; add a worker queue if needed.
        if (uploads >= 2) throw new WallkeepError('Two uploads are already processing. Try again shortly.', 429);
        uploads++;
        try {
          const input = { ...await uploadBody(request), author };
          return send(201, item ? await store.revise(item[1], input) : await store.create(input));
        } finally { uploads--; }
      }

      const staticFile = STATIC[path] ?? (/^\/wallpapers\/[a-f0-9-]{36}$/.test(path) || ['/account', '/imports'].includes(path) ? STATIC['/'] : null);
      if (method === 'GET' && staticFile) {
        const file = fileURLToPath(new URL(staticFile[0], PUBLIC));
        const info = await stat(file);
        response.writeHead(200, { 'Content-Type': `${staticFile[1]}; charset=utf-8`, 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
        const stream = createReadStream(file);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        return stream.pipe(response);
      }
      throw new WallkeepError('Not found.', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) return response.destroy();
      if (!(error instanceof WallkeepError)) console.error(error);
      send(error instanceof WallkeepError ? error.status : 500, { error: error instanceof WallkeepError ? error.message : 'Something went wrong on the server.' });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}
