import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FORMATS = { jpeg: ['jpg', 'image/jpeg'], png: ['png', 'image/png'], webp: ['webp', 'image/webp'] };

export class WallkeepError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'WallkeepError'; this.status = status; }
}

function text(value, label, max, fallback = '') {
  value ??= fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new WallkeepError(`${label} must be text of at most ${max} characters.`);
  }
  return value.trim();
}

function metadata(input, previous = {}) {
  const title = text(input.title ?? previous.title, 'Title', 160);
  const author = text(input.author, 'Author', 80, 'Admin');
  if (!title || !author) throw new WallkeepError('Title and author are required.');
  const filename = text(input.filename ?? previous.filename, 'Filename', 255, 'wallpaper').split(/[\\/]/).pop();
  if (!filename) throw new WallkeepError('Filename is required.');
  return {
    title, author, filename,
    description: text(input.description ?? previous.description, 'Description', 5000),
    alt: text(input.alt ?? previous.alt, 'Alt text', 500, title),
    message: text(input.message, 'Change note', 500, 'Updated wallpaper'),
  };
}

function page({ limit = 40, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw new WallkeepError('Use a limit from 1 to 100 and a non-negative offset.');
  }
  return { limit, offset };
}

function versionNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new WallkeepError('A positive version number is required.');
  return number;
}

const VERSION_SELECT = `SELECT v.*, b.width, b.height, b.size, b.mime, b.extension
  FROM versions v JOIN blobs b ON b.hash = v.hash`;

function version(row) {
  if (!row) throw new WallkeepError('Version not found.', 404);
  return {
    number: row.number, hash: row.hash, title: row.title, description: row.description, alt: row.alt,
    filename: row.filename, author: row.author, message: row.message, createdAt: row.created_at,
    restoredFrom: row.restored_from, width: row.width, height: row.height,
    size: row.size, mime: row.mime,
  };
}

/** Local-disk wallpaper repository. Version records are append-only. */
export class WallpaperStore {
  #db;
  #directory;

  constructor({ directory = './data' } = {}) {
    this.#directory = resolve(directory);
    for (const folder of ['originals', 'previews']) mkdirSync(join(this.#directory, folder), { recursive: true });
    this.#db = new DatabaseSync(join(this.#directory, 'wallkeep.sqlite'));
    // ponytail: synchronous SQLite suits a single-host gallery; use a server DB for multiple hosts.
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS wallpapers (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, extension TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id), number INTEGER NOT NULL CHECK(number > 0),
        hash TEXT NOT NULL REFERENCES blobs(hash), title TEXT NOT NULL, description TEXT NOT NULL,
        alt TEXT NOT NULL, filename TEXT NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL,
        created_at TEXT NOT NULL, restored_from INTEGER,
        PRIMARY KEY (wallpaper_id, number),
        FOREIGN KEY (wallpaper_id, restored_from) REFERENCES versions(wallpaper_id, number)
      );
      -- Everything in a version is immutable except its description, which can be corrected in place.
      DROP TRIGGER IF EXISTS versions_no_update;
      CREATE TRIGGER versions_no_update BEFORE UPDATE OF wallpaper_id, number, hash, title, alt, filename, author, message, created_at, restored_from ON versions
        BEGIN SELECT RAISE(ABORT, 'Versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON versions
        BEGIN SELECT RAISE(ABORT, 'Versions are immutable'); END;
      CREATE TABLE IF NOT EXISTS import_sources (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, repository TEXT NOT NULL,
        branch TEXT NOT NULL, folder TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('copy', 'mirror')),
        interval_minutes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL, last_synced_at TEXT, last_commit TEXT, target_commit TEXT,
        next_run INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
        report TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS import_files (
        source_id TEXT NOT NULL REFERENCES import_sources(id), path TEXT NOT NULL,
        wallpaper_id TEXT NOT NULL UNIQUE REFERENCES wallpapers(id), git_sha TEXT NOT NULL,
        PRIMARY KEY(source_id, path)
      );
    `);
    if (!this.#db.prepare('PRAGMA table_info(wallpapers)').all().some(column => column.name === 'archived')) {
      this.#db.exec('ALTER TABLE wallpapers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
  }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  #write(folder, filename, bytes) {
    const destination = join(this.#directory, folder, filename);
    if (existsSync(destination)) return;
    const temp = `${destination}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, destination); }
    finally { rmSync(temp, { force: true }); }
  }

  async #image(image) {
    if (!(image instanceof Uint8Array) || !image.length || image.length > MAX_IMAGE_BYTES) {
      throw new WallkeepError('Provide a JPEG, PNG, or WebP image up to 25 MiB.');
    }
    // Own the bytes so callers cannot mutate the buffer while it is being decoded.
    const bytes = Buffer.from(image);
    let info, preview;
    try {
      const decoder = sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'warning' });
      info = await decoder.metadata();
      if (!FORMATS[info.format] || (info.pages ?? 1) > 1) throw new Error('Unsupported image');
      preview = await decoder.rotate().resize({ width: 1600, height: 1000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    } catch {
      throw new WallkeepError('Invalid image. Use a still JPEG, PNG, or WebP of at most 100 megapixels.');
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const [extension, mime] = FORMATS[info.format];
    const swap = [5, 6, 7, 8].includes(info.orientation);
    const blob = { hash, extension, mime, size: bytes.length, width: swap ? info.height : info.width, height: swap ? info.width : info.height };
    this.#write('originals', `${hash}.${extension}`, bytes);
    this.#write('previews', `${hash}.webp`, preview);
    return blob;
  }

  #insertBlob(blob) {
    this.#db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?, ?, ?, ?, ?)')
      .run(blob.hash, blob.extension, blob.mime, blob.size, blob.width, blob.height);
  }

  #insert(id, number, hash, fields, restoredFrom = null) {
    this.#db.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, number, hash, fields.title, fields.description, fields.alt, fields.filename,
        fields.author, fields.message, new Date().toISOString(), restoredFrom);
    return this.get(id);
  }

  #checkHead(id, expectedVersion) {
    const current = this.get(id);
    if (versionNumber(expectedVersion) !== current.latest.number) {
      throw new WallkeepError('A newer version exists. Refresh the wallpaper before saving.', 409);
    }
    return current.latest;
  }

  async create(input = {}) {
    const fields = metadata({ ...input, message: input.message ?? 'Initial upload' });
    const blob = await this.#image(input.image);
    return this.#transaction(() => {
      const id = randomUUID();
      this.#db.prepare('INSERT INTO wallpapers(id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
      this.#insertBlob(blob);
      return this.#insert(id, 1, blob.hash, fields);
    });
  }

  async revise(id, input = {}) {
    this.#assertEditable(id);
    const previous = this.#checkHead(id, input.expectedVersion);
    const fields = metadata(input, previous);
    const blob = input.image === undefined ? null : await this.#image(input.image);
    return this.#transaction(() => {
      this.#checkHead(id, input.expectedVersion);
      if (blob) this.#insertBlob(blob);
      this.#db.prepare('UPDATE wallpapers SET archived = 0 WHERE id = ?').run(id);
      return this.#insert(id, previous.number + 1, blob?.hash ?? previous.hash, fields);
    });
  }

  /**
   * Title and description are local metadata, so they stay editable on mirrors; mirror syncs keep the latest values.
   * A description-only edit updates the latest version in place; a title change records a new version.
   */
  editDetails(id, input = {}) {
    return this.#transaction(() => {
      const previous = this.#checkHead(id, input.expectedVersion);
      const changed = ['title', 'description'].filter(key => input[key] !== undefined);
      if (!changed.length) throw new WallkeepError('Provide a title or description.');
      if (input.title === undefined) {
        const { description } = metadata({ description: input.description, author: input.author }, previous);
        this.#db.prepare('UPDATE versions SET description = ? WHERE wallpaper_id = ? AND number = ?').run(description, id, previous.number);
        return this.get(id);
      }
      const fields = metadata({ title: input.title, description: input.description, author: input.author, message: `Updated ${changed.join(' and ')}` }, previous);
      return this.#insert(id, previous.number + 1, previous.hash, fields);
    });
  }

  restore(id, number, input = {}) {
    this.#assertEditable(id);
    return this.#transaction(() => {
      const latest = this.#checkHead(id, input.expectedVersion);
      const source = this.getVersion(id, number);
      const fields = metadata({ ...source, author: input.author ?? 'Admin', message: input.message ?? `Restored from v${number}` });
      this.#db.prepare('UPDATE wallpapers SET archived = 0 WHERE id = ?').run(id);
      return this.#insert(id, latest.number + 1, source.hash, fields, number);
    });
  }

  get(id) {
    if (typeof id !== 'string' || id.length > 100) throw new WallkeepError('Invalid wallpaper ID.');
    const row = this.#db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id);
    if (!row) throw new WallkeepError('Wallpaper not found.', 404);
    const latest = version(this.#db.prepare(`${VERSION_SELECT} WHERE wallpaper_id = ? ORDER BY number DESC LIMIT 1`).get(id));
    const imported = this.#db.prepare(`SELECT s.id, s.owner, s.repository, s.mode, f.path
      FROM import_files f JOIN import_sources s ON s.id = f.source_id WHERE f.wallpaper_id = ?`).get(id);
    const source = imported ? { ...imported, url: `https://github.com/${imported.owner}/${imported.repository}` } : null;
    return { id, createdAt: row.created_at, archived: !!row.archived, source, versionCount: latest.number, latest };
  }

  getVersion(id, number) {
    this.get(id);
    return version(this.#db.prepare(`${VERSION_SELECT} WHERE wallpaper_id = ? AND number = ?`).get(id, versionNumber(number)));
  }

  list({ query = '', archived = false, ...options } = {}) {
    const { limit, offset } = page(options);
    const needle = `%${text(query, 'Search', 160).replace(/[\\%_]/g, '\\$&')}%`;
    const where = `FROM wallpapers w JOIN versions v ON v.wallpaper_id = w.id
      AND v.number = (SELECT MAX(number) FROM versions WHERE wallpaper_id = w.id)
      WHERE w.archived = ? AND (v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`;
    const total = this.#db.prepare(`SELECT COUNT(*) AS total ${where}`).get(archived ? 1 : 0, needle, needle).total;
    const items = this.#db.prepare(`SELECT w.id ${where} ORDER BY v.created_at DESC, w.id LIMIT ? OFFSET ?`)
      .all(archived ? 1 : 0, needle, needle, limit, offset).map(({ id }) => this.get(id));
    return { items, total, limit, offset };
  }

  /** Adjacent wallpapers in library order (newest first), within the same active/archived list. */
  neighbors(id) {
    const { archived } = this.get(id);
    const row = this.#db.prepare(`WITH ordered AS (SELECT w.id, LAG(w.id) OVER o AS previous, LEAD(w.id) OVER o AS next
      FROM wallpapers w JOIN versions v ON v.wallpaper_id = w.id AND v.number = (SELECT MAX(number) FROM versions WHERE wallpaper_id = w.id)
      WHERE w.archived = ? WINDOW o AS (ORDER BY v.created_at DESC, w.id)) SELECT previous, next FROM ordered WHERE id = ?`).get(archived ? 1 : 0, id);
    return { previous: row.previous, next: row.next };
  }

  history(id, options) {
    const current = this.get(id);
    const { limit, offset } = page(options);
    const items = this.#db.prepare(`${VERSION_SELECT} WHERE wallpaper_id = ? ORDER BY number DESC LIMIT ? OFFSET ?`)
      .all(id, limit, offset).map(version);
    return { items, total: current.versionCount, limit, offset };
  }

  asset(id, number, { preview = false } = {}) {
    const item = this.getVersion(id, number);
    const extension = this.#db.prepare('SELECT extension FROM blobs WHERE hash = ?').get(item.hash).extension;
    return {
      path: join(this.#directory, preview ? 'previews' : 'originals', `${item.hash}.${preview ? 'webp' : extension}`),
      mime: preview ? 'image/webp' : item.mime,
      filename: `${item.filename.replace(/\.[^.]*$/, '') || 'wallpaper'}.${preview ? 'webp' : extension}`,
      hash: item.hash,
    };
  }

  #assertEditable(id) {
    if (this.get(id).source?.mode === 'mirror') {
      throw new WallkeepError('This wallpaper is mirrored from GitHub. Detach the mirror before editing or restoring.', 409);
    }
  }

  addImport({ owner, repository, branch = '', folder = '', mode = 'copy', intervalMinutes = 60 }) {
    if (typeof owner !== 'string' || typeof repository !== 'string' || !/^[a-z\d-]{1,39}$/i.test(owner) || !/^[\w.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository)) throw new WallkeepError('Invalid GitHub repository.');
    if (!['copy', 'mirror'].includes(mode)) throw new WallkeepError('Choose copy or mirror.');
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10080) throw new WallkeepError('Sync interval must be 5–10080 minutes.');
    branch = text(branch, 'Branch', 200);
    folder = text(folder, 'Folder', 1000).replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some(part => ['.', '..'].includes(part)) || /[\r\n\\]/.test(folder + branch)) throw new WallkeepError('Invalid branch or folder.');
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO import_sources(id, owner, repository, branch, folder, mode, interval_minutes, created_at, next_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner, repository, branch, folder, mode, intervalMinutes, new Date().toISOString(), Date.now());
    return this.getImport(id);
  }

  getImport(id) {
    const row = this.#db.prepare('SELECT * FROM import_sources WHERE id = ?').get(id);
    if (!row) throw new WallkeepError('Import not found.', 404);
    return {
      id: row.id, url: `https://github.com/${row.owner}/${row.repository}`, owner: row.owner, repository: row.repository,
      branch: row.branch, folder: row.folder, mode: row.mode, intervalMinutes: row.interval_minutes,
      status: row.status, createdAt: row.created_at, lastSyncedAt: row.last_synced_at, lastCommit: row.last_commit,
      targetCommit: row.target_commit, nextRun: row.mode === 'mirror' ? row.next_run : null,
      report: JSON.parse(row.report),
      fileCount: this.#db.prepare('SELECT COUNT(*) AS n FROM import_files WHERE source_id = ?').get(id).n,
    };
  }

  imports() {
    return this.#db.prepare('SELECT id FROM import_sources ORDER BY created_at DESC').all().map(row => this.getImport(row.id));
  }

  importedFiles(id) {
    this.getImport(id);
    return this.#db.prepare(`SELECT f.path, f.git_sha AS gitSha, f.wallpaper_id AS wallpaperId, w.archived
      FROM import_files f JOIN wallpapers w ON w.id = f.wallpaper_id WHERE source_id = ? ORDER BY f.path`).all(id);
  }

  queueImport(id, { retry = false } = {}) {
    const source = this.getImport(id);
    if (source.mode === 'copy' && source.status === 'synced') throw new WallkeepError('This is an independent copy; it no longer syncs.', 409);
    if (retry && !source.report.failedPaths?.length) throw new WallkeepError('There are no failed files to retry.', 409);
    // The retry flag rides on the report; the worker reads it before claiming, then the run rewrites the report.
    const report = JSON.stringify(retry ? { ...source.report, retry: true } : source.report);
    const updated = this.#db.prepare("UPDATE import_sources SET status = 'queued', next_run = ?, report = ? WHERE id = ? AND lease_until <= ?").run(Date.now(), report, id, Date.now());
    if (!updated.changes) throw new WallkeepError('This import is already running.', 409);
    return this.getImport(id);
  }

  dueImports() {
    return this.#db.prepare(`SELECT id FROM import_sources WHERE lease_until <= ? AND
      (status IN ('queued', 'running') OR (mode = 'mirror' AND next_run <= ?)) ORDER BY next_run`).all(Date.now(), Date.now()).map(row => row.id);
  }

  claimImport(id, lease) {
    // A bounded lease recovers interrupted work and excludes another server's import worker.
    return !!this.#db.prepare("UPDATE import_sources SET status = 'running', report = '{}', lease_token = ?, lease_until = ? WHERE id = ? AND lease_until <= ?")
      .run(lease, Date.now() + 15 * 60_000, id, Date.now()).changes;
  }

  #checkLease(id, lease) {
    if (!this.#db.prepare('SELECT id FROM import_sources WHERE id = ? AND lease_token = ? AND lease_until > ?').get(id, lease, Date.now())) {
      throw new WallkeepError('The import lease expired. Retry this import.', 409);
    }
  }

  renewImport(id, lease, report = {}) {
    const now = Date.now();
    const updated = this.#db.prepare('UPDATE import_sources SET lease_until = ?, report = ? WHERE id = ? AND lease_token = ? AND lease_until > ?')
      .run(now + 15 * 60_000, JSON.stringify(report), id, lease, now);
    if (!updated.changes) throw new WallkeepError('The import lease expired. Retry this import.', 409);
  }

  pinImport(id, lease, branch, commit) {
    this.#checkLease(id, lease);
    this.#db.prepare('UPDATE import_sources SET branch = ?, target_commit = ? WHERE id = ?').run(branch, commit, id);
  }

  async applyImportedFile(id, lease, { path, gitSha, commit, image }) {
    this.#checkLease(id, lease);
    const source = this.getImport(id);
    path = text(path, 'Repository path', 1000);
    if (!path || !/^[a-f\d]{40}$/.test(gitSha) || !/^[a-f\d]{40}$/.test(commit)) throw new WallkeepError('Invalid GitHub file identity.');
    const existing = this.#db.prepare('SELECT * FROM import_files WHERE source_id = ? AND path = ?').get(id, path);
    if (existing?.git_sha === gitSha) {
      this.#db.prepare('UPDATE wallpapers SET archived = 0 WHERE id = ?').run(existing.wallpaper_id);
      return 'unchanged';
    }
    const previous = existing ? this.get(existing.wallpaper_id).latest : null;
    const filename = path.split('/').pop();
    const fields = metadata({
      filename, title: previous?.title ?? filename.replace(/\.[^.]+$/, '').slice(0, 160),
      description: previous?.description ?? `Imported from ${source.url}\n${path}`,
      alt: previous?.alt, author: 'GitHub mirror', message: `${source.owner}/${source.repository}@${commit.slice(0, 12)} · ${path}`.slice(0, 500),
    });
    const blob = await this.#image(image);
    return this.#transaction(() => {
      this.#checkLease(id, lease);
      const wallpaperId = existing?.wallpaper_id ?? randomUUID();
      if (!existing) this.#db.prepare('INSERT INTO wallpapers(id, created_at) VALUES (?, ?)').run(wallpaperId, new Date().toISOString());
      this.#insertBlob(blob);
      if (previous?.hash !== blob.hash) this.#insert(wallpaperId, (previous?.number ?? 0) + 1, blob.hash, fields);
      this.#db.prepare(`INSERT INTO import_files VALUES (?, ?, ?, ?) ON CONFLICT(source_id, path) DO UPDATE SET git_sha = excluded.git_sha`).run(id, path, wallpaperId, gitSha);
      this.#db.prepare('UPDATE wallpapers SET archived = 0 WHERE id = ?').run(wallpaperId);
      return existing ? 'updated' : 'added';
    });
  }

  archiveMissing(id, lease, presentPaths) {
    this.#checkLease(id, lease);
    if (this.getImport(id).mode !== 'mirror') return 0;
    const present = new Set(presentPaths);
    return this.#transaction(() => {
      let count = 0;
      for (const file of this.importedFiles(id)) if (!present.has(file.path) && !file.archived) {
        this.#db.prepare('UPDATE wallpapers SET archived = 1 WHERE id = ?').run(file.wallpaperId);
        count++;
      }
      return count;
    });
  }

  finishImport(id, lease, { status, commit, report }) {
    this.#checkLease(id, lease);
    const source = this.getImport(id);
    this.#db.prepare(`UPDATE import_sources SET status = ?, last_synced_at = ?, last_commit = COALESCE(?, last_commit),
      next_run = ?, report = ?, lease_token = NULL, lease_until = 0 WHERE id = ?`)
      .run(status, new Date().toISOString(), status === 'synced' ? commit : null, Date.now() + source.intervalMinutes * 60_000, JSON.stringify(report), id);
  }

  detachImport(id) {
    this.getImport(id);
    const updated = this.#db.prepare("UPDATE import_sources SET mode = 'copy', status = 'synced' WHERE id = ? AND lease_until <= ?").run(id, Date.now());
    if (!updated.changes) throw new WallkeepError('Wait for the current sync to finish before detaching.', 409);
    return this.getImport(id);
  }

  close() { this.#db.close(); }
}
