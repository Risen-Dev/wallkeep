# Wallkeep

A self-hosted wallpaper gallery and Node.js library. Every wallpaper has a permanent URL, immutable versions, and restorable history. Import collections from GitHub as an **independent copy** or a **one-way mirror**. One account can connect to Google, GitHub, Apple, and email sign-in.

The project name is provisional. The package has not been published to npm.

## Get started in two steps

Requires **Node.js 24+**.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:3000**. The gallery starts empty. Use **Add wallpaper** or **Import from GitHub**.

To get initial admin access:

1. Read `data/admin-token` on your computer or server.
2. Click **Sign in → Server admin token** and enter the token.
3. If account sign-in is configured, sign in to your account, open **Account**, and enter the token under **Enable admin access**. This permanently grants admin access to the account, so you do not need the token each time you sign in.

The gallery, original images, and all version history are public. New accounts are **viewers**, not automatically admins. Each instance hosts one shared collection; private per-user workspaces are not available yet.

## Server configuration

Copy `.env.example` to `.env` and fill in the options you need. The CLI reads `.env` at startup. Restart the application after changing its configuration.

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1`; use `0.0.0.0` for network or container access |
| `PORT` | `3000` |
| `DATA_DIR` | `./data` |
| `PUBLIC_URL` | `http://127.0.0.1:3000` (the port follows `PORT`); canonical origin without a path |
| `ADMIN_TOKEN` | Random token saved to `data/admin-token` if unset; at least 32 characters |
| `ADMIN_NAME` | `Admin`; author name for admin-token sessions and API requests |
| `ADMIN_EMAILS` | Comma-separated admin email addresses; only matching verified emails qualify |
| `AUTH_SECRET` | Random secret saved to `data/auth-secret` if unset; at least 32 characters |
| `GITHUB_IMPORT_TOKEN` | Optional; increases the GitHub API quota and is separate from OAuth sign-in |
| `ANTHROPIC_API_KEY` | Optional; enables the "Suggest a name with AI" button on wallpaper pages. The wallpaper preview is sent to the Claude API only when an admin clicks it |

Use the same origin in your browser, `PUBLIC_URL`, and OAuth callback URLs. `localhost` and `127.0.0.1` are different origins. For public hosting, use an HTTPS reverse proxy and set `PUBLIC_URL=https://walls.example.com`; cookies will use `Secure`.

The admin token and auth secret are not printed to logs. Do not commit `.env`, the data directory, or private keys. The admin token remains available for server-owner access and API authentication even when account sign-in is not configured.

### Docker Compose

```sh
docker compose up --build -d
docker compose exec wallkeep cat /app/data/admin-token
```

Compose reads `.env` if it exists. Data is stored in the `wallkeep-data` volume; the port is bound to the host's localhost by default. Point your reverse proxy to port 3000. For Apple, mount the `.p8` file into the container when using `APPLE_PRIVATE_KEY_FILE`.

Docker configuration is provided but has not been tested in this workspace because Docker is unavailable.

## Import from GitHub

Open **Import from GitHub**, enter a public repository URL, and choose a mode:

| Mode | Behavior |
| --- | --- |
| **Independent copy** | Copies the snapshot at import time. Edit freely in Wallkeep; subsequent GitHub changes are not tracked once the import completes. |
| **Mirror GitHub** | Imports the snapshot, then checks the branch periodically. Image changes create new versions; identical files do not. Local edits and restores are locked while the source remains a mirror. |

Supported URLs:

```text
https://github.com/owner/wallpapers
https://github.com/owner/wallpapers.git
https://github.com/owner/wallpapers/tree/main/nature
```

- An empty branch uses the repository's default branch. An empty folder includes all subfolders.
- For branch names containing `/`, fill in **Branch** explicitly, for example `feature/photos`.
- The UI offers mirror intervals of 15 minutes, 1 hour, or 1 day. The API accepts 5–10080 minutes. Scheduling runs on the server; no browser tab needs to remain open.
- **Imports** shows the status, last fully synced commit, image count, sync results, and errors. **Sync now** starts a manual sync.
- **Make independent** stops mirroring and enables local edits. All images and history are preserved. Archived images remain archived; after detaching, restore a version from the detail page to make an image visible again.
- When an image disappears from a complete upstream snapshot, Wallkeep **archives it**. Open **View archived** to find it; all versions remain downloadable. If the same path reappears, the image becomes active again.
- If GitHub returns a truncated listing, a request times out, or an image fails to process, Wallkeep does not archive files based on incomplete results. Successfully imported files are kept, and the status reports the failures.
- Retries use paths and hashes to avoid duplicate wallpapers. An independent copy retries the original pinned commit; a mirror uses the latest branch head.

### Import limits

- **Public repositories on github.com**, including folders within them. Private repositories and GitHub Enterprise are not supported; the gallery is public.
- Static JPEG, PNG, and WebP images; up to 25 MiB and 100 megapixels per image.
- No Wallkeep limit on the total image count or combined image size per source/snapshot. Images are processed one at a time; available disk space and GitHub API limits still apply. GitHub must return a complete tree listing before an import can proceed.
- Symlinks and submodules are not downloaded, Git LFS pointers are not resolved, and repository code is never executed.
- **Imports the current snapshot, not the entire Git commit history.** Later changes observed during sync become Wallkeep history. A renamed path is treated as a new image; the old path is archived in mirror mode.
- Imports run one at a time without a total sync time limit. Individual network requests time out after 30 seconds. The worker renews its database lease as it processes files; interrupted jobs can resume after the lease expires, up to 15 minutes after the last renewal.
- All downloads are pinned to a commit SHA. Original bytes are checked against the Git blob hash. Downloads are restricted to GitHub API/raw hosts, and redirects are not followed.

`GITHUB_IMPORT_TOKEN` is sent only to the GitHub API; it is not an account sign-in token and is never sent to the browser. Imports also work without a token while the unauthenticated GitHub quota is available.

## Sign-in and multiple providers per account

Wallkeep uses Better Auth for sessions, OAuth, magic links, and account linking. Unconfigured providers appear disabled; there are no demo logins or built-in credentials.

### Email: magic link

```dotenv
SMTP_URL=smtps://user:password@mail.example.com:465
SMTP_FROM=Wallkeep <no-reply@example.com>
```

Click **Sign in**, enter your email address, and open the link you receive. Links expire after 10 minutes and can be used once. An account is created after email ownership is verified. URL-encode any special characters in the SMTP username or password.

An account's primary email can also be used for magic-link sign-in when the account was originally created through Google, GitHub, or Apple. No local password is required. Separate alternate email addresses or aliases are not supported yet.

### Google

Create a web application OAuth client in Google Cloud, then set:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Authorized redirect URI:

```text
https://walls.example.com/api/auth/callback/google
```

For local development, use the `PUBLIC_URL` origin, for example `http://127.0.0.1:3000/api/auth/callback/google`, and register that URL with your OAuth client.

### GitHub

Create a GitHub OAuth App, then set:

```dotenv
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Homepage URL: the `PUBLIC_URL` origin. Authorization callback URL:

```text
https://walls.example.com/api/auth/callback/github
```

GitHub sign-in establishes account identity only; it does not automatically grant Wallkeep access to private repositories.

### Apple

Apple requires an Apple Developer account, a Services ID for the web, an HTTPS domain, and a return URL:

```text
https://walls.example.com/api/auth/callback/apple
```

```dotenv
APPLE_CLIENT_ID=com.example.wallkeep.web
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY_FILE=/secure/path/AuthKey.p8
```

The server generates a one-hour ES256 client-secret JWT from the private key when the provider is used. Alternatively, set `APPLE_CLIENT_SECRET` to a valid Apple JWT and rotate it before it expires. `APPLE_PRIVATE_KEY` also accepts a PEM key through the environment.

Apple is disabled on localhost or HTTP. Apple does not accept localhost or non-HTTPS callbacks. For Private Relay addresses, configure email delivery according to Apple's requirements before relying on magic links to those addresses.

### Link providers

1. Sign in using an existing sign-in method.
2. Open **Account**.
3. Click **Connect** for Google, GitHub, or Apple, then authenticate with that provider.
4. Once linked, the provider signs in to the same Wallkeep user ID, even when its email address differs.

Matching email addresses **do not automatically merge accounts**. If you see `account_not_linked`, sign in using your original method and link the provider explicitly. A provider identity already owned by another account cannot be taken over. Linking changes require a session created within the last 10 minutes; sign out and sign back in if needed. The last linked social provider cannot be disconnected.

An account becomes an admin through the token form on the Account page or a verified email listed in `ADMIN_EMAILS`. Signing up does not automatically grant upload, import, or restore permissions. Write requests use the account name as the author; clients cannot spoof it.

## Developer library

The library runs on a Node.js server and does not depend on the UI or a frontend framework. Applications in other languages can use the HTTP API.

Install the local checkout from another project:

```sh
npm install /path/to/wallkeep
```

```js
import { readFile } from 'node:fs/promises';
import { WallpaperStore } from 'wallkeep';

const store = new WallpaperStore({ directory: './wallpaper-data' });
try {
  const wallpaper = await store.create({
    image: await readFile('./garden.png'), filename: 'garden.png',
    title: 'Garden', alt: 'A garden in morning light', author: 'Ari',
  });
  await store.revise(wallpaper.id, {
    expectedVersion: 1, title: 'Morning garden', author: 'Ari', message: 'Updated title',
  });
  const restored = store.restore(wallpaper.id, 1, { expectedVersion: 2, author: 'Ari' });
  console.log(restored.latest.number); // 3; v1 and v2 are preserved.
} finally {
  store.close();
}
```

| Method | Purpose |
| --- | --- |
| `await store.create(input)` | Create a wallpaper at version 1 |
| `await store.revise(id, input)` | Create a version; requires `expectedVersion`, with an optional image for metadata-only updates |
| `store.restore(id, number, input)` | Create a version from an older snapshot; requires `expectedVersion` |
| `store.get(id)` | `{ id, createdAt, archived, source, versionCount, latest }` |
| `store.getVersion(id, number)` | Retrieve a specific snapshot |
| `store.list({ query, archived, limit, offset })` | `{ items, total, limit, offset }`; `archived: true` returns archived images only |
| `store.history(id, { limit, offset })` | List snapshots newest first, with pagination |
| `store.asset(id, number, { preview })` | `{ path, mime, filename, hash }` |
| `store.imports()` / `store.getImport(id)` | Retrieve import source status |
| `store.importedFiles(id)` | Map repository paths to wallpaper IDs |
| `store.queueImport(id)` / `store.detachImport(id)` | Requeue an import / turn it into an independent copy |
| `store.close()` | Close the store after operations finish |

`limit` defaults to 40, with a maximum of 100. `latest` and other snapshots contain `number`, `hash`, `title`, `description`, `alt`, `filename`, `author`, `message`, `createdAt`, `restoredFrom`, `width`, `height`, `size`, and `mime`. Sizes are in bytes; timestamps use ISO 8601 UTC. `WallkeepError.status`: `400` for invalid input, `404` for missing resources, and `409` for version conflicts or locked mirrors.

The library does not authorize callers. Protect write methods in your application. The built-in HTTP server checks admin permissions.

### Import through the library

```js
import { WallpaperStore } from 'wallkeep';
import { GitHubImporter, parseGitHubURL } from 'wallkeep/github';

const store = new WallpaperStore({ directory: './data' });
const importer = new GitHubImporter({ store, token: process.env.GITHUB_IMPORT_TOKEN });
try {
  const source = store.addImport({
    ...parseGitHubURL('https://github.com/owner/wallpapers'), mode: 'copy',
  });
  console.log(await importer.sync(source.id));
} finally {
  await importer.stop();
  store.close();
}
```

For a continuous worker, call `importer.start()`. `importer.add({ url, mode, branch?, folder?, intervalMinutes? })` creates a source and starts processing the queue in the background. After `store.queueImport(id)`, call `importer.kick()` to process the queue immediately. On shutdown, `await importer.stop()` before closing the store.

`wallkeep/server` exports `createWallpaperServer({ store, adminToken, adminName?, publicUrl?, accounts?, importer? })`, which returns a Node HTTP server without starting a listener. `wallkeep/accounts` exports the async function `createAccountService({ directory, secret, baseURL, env?, sendEmail?, socialProviders? })`. See `cli.js` for complete setup and shutdown handling. `sendEmail` receives `{ to, subject, text }` for custom email delivery; the default configuration uses SMTP.

## HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/wallpapers?q=&limit=20&offset=0&archived=0` | List and search |
| GET | `/api/wallpapers/:id` | Latest details |
| GET | `/api/wallpapers/:id/versions?limit=40&offset=0` | Version history |
| GET | `/api/wallpapers/:id/versions/:number` | Snapshot |
| GET | `/api/wallpapers/:id/versions/:number/image` | Original; add `?download` for an attachment |
| GET | `/api/wallpapers/:id/versions/:number/preview` | WebP preview |
| POST | `/api/wallpapers` | Multipart upload |
| POST | `/api/wallpapers/:id/versions` | Multipart revision or JSON metadata update |
| POST | `/api/wallpapers/:id/versions/:number/restore` | JSON `{ expectedVersion, message? }` |
| GET / POST | `/api/imports` | List sources / start an import; admin only |
| GET | `/api/imports/:id` | Status and report |
| GET | `/api/imports/:id/files` | File mappings |
| POST | `/api/imports/:id/sync` | Queue a sync or retry |
| POST | `/api/imports/:id/detach` | Stop mirroring and enable local edits |
| GET | `/api/session` | Sign-in status, role, and enabled providers |
| POST / DELETE | `/api/session` | Token sign-in `{ token }` / clear the token cookie |
| POST | `/api/account/claim-admin` | Grant the signed-in account admin access using `{ token }` |
| POST | `/api/auth/sign-in/magic-link` | `{ email, callbackURL: '/account' }` |
| POST | `/api/auth/sign-in/social` | Start OAuth `{ provider, callbackURL, disableRedirect: true }` |
| POST | `/api/auth/link-social` | Link a provider from a fresh account session |
| GET | `/api/auth/list-accounts` | List the signed-in account's linked providers |
| POST | `/api/auth/unlink-account` | Unlink `{ accountId }`, using the record ID from list-accounts |
| POST | `/api/auth/sign-out` | Revoke the current account session |

Admin API requests use `Authorization: Bearer <ADMIN_TOKEN>`. Browser requests use cookies, the same origin, and the `X-Wallkeep-Request: 1` header. Better Auth handles OAuth and magic-link callbacks; do not add this header to provider callback URLs. CORS is disabled. Keep the admin token on the server; never embed it in a public frontend.

```sh
curl http://127.0.0.1:3000/api/imports \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/owner/wallpapers","mode":"mirror","intervalMinutes":60}'
```

Import and sync requests return `202`; poll the status endpoint for progress. Status values: `queued`, `running`, `synced`, `partial`, and `error`. `lastCommit` is the last fully synced commit; `targetCommit` is the commit currently being attempted. Reports contain result counts and up to 20 file errors. Successful wallpaper revisions return `201`. Wallkeep API errors use `{ "error": "message" }`; Better Auth endpoints use their own structured errors.

## Storage, backups, and limitations

- `wallkeep.sqlite`: wallpapers, versions, import sources, repository mappings, the queue, and mirror leases.
- `accounts.sqlite`: accounts, providers, sessions, verification tokens, and admin grants. OAuth tokens are encrypted using `AUTH_SECRET`.
- `originals/`: originals addressed by SHA-256; identical bytes share a file. Different encodings count as different files.
- `previews/`: separate WebP previews that leave originals unchanged.
- `admin-token` and `auth-secret`: local secrets when not set through the environment.

**Consistent backups:** stop the server, copy the entire data directory or volume along with any secrets set through the environment, then restart it. Preserve the auth secret so stored provider tokens remain readable. Do not copy only the database or images separately while writes are in progress.

Designed for a single host with local storage. S3 storage, cross-host databases, private per-user workspaces, Git push/pull/merge, garbage collection, and history deletion are not available yet. Files written before a failed transaction may remain unreferenced. This is a Git-style snapshot system, not a Git repository server.

Sign-in rate limits use the socket IP determined by the server, not client-supplied IP headers. Users behind a reverse proxy share the proxy's IP bucket; larger deployments can add trusted-proxy configuration before changing this policy.

## Tests and verification

```sh
npm test
```

Tests use `node:test`, temporary SQLite databases, local servers, image fixtures, simulated GitHub responses, and authentication providers used only in tests. Coverage includes:

- immutable snapshots, restore, deduplication, persistence, concurrent-write conflicts, and image validation;
- idempotent mirrors, file changes, archiving and reappearance, listing failures, retries, leases, and detachment;
- imports of 501 images totaling 501 MiB, lease renewal during simulated long-running imports, and skipping unchanged downloads;
- URL validation, download hosts, and Git blob integrity;
- single-use magic links, explicit account linking, different provider emails on one account, provider ownership protection, admin access, and logout.

Simulated tests do not replace testing real OAuth and SMTP credentials in your deployment. Configure provider callbacks and SMTP before enabling public sign-in.

Implementation references: [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees), [Better Auth account linking](https://better-auth.com/docs/concepts/users-accounts), [email magic link](https://better-auth.com/docs/plugins/magic-link), [Apple sign-in](https://better-auth.com/docs/authentication/apple), [Node SQLite](https://nodejs.org/api/sqlite.html), and [Sharp](https://sharp.pixelplumbing.com/api-constructor/).
