import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MAX_IMAGE_BYTES, WallkeepError } from './store.js';

export function parseGitHubURL(value, { branch = '', folder = '' } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new WallkeepError('Enter a GitHub repository URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new WallkeepError('Use an https://github.com/owner/repository URL.');
  }
  let parts;
  try { parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent); }
  catch { throw new WallkeepError('Invalid repository URL.'); }
  const [owner, rawRepository, kind, ...tail] = parts;
  const repository = rawRepository?.replace(/\.git$/, '');
  if (!owner || !repository || !/^[a-z\d-]{1,39}$/i.test(owner) || !/^[\w.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository)) throw new WallkeepError('Invalid GitHub repository.');
  if (kind) {
    if (kind !== 'tree' || !tail.length) throw new WallkeepError('Use a repository or folder URL, not an individual file.');
    if (branch) {
      const suffix = tail.join('/');
      if (suffix !== branch && !suffix.startsWith(`${branch}/`)) throw new WallkeepError('The branch does not match this folder URL.');
      folder ||= suffix.slice(branch.length).replace(/^\//, '');
    } else {
      branch = tail[0];
      folder ||= tail.slice(1).join('/');
    }
  }
  return { owner, repository, branch, folder };
}

async function limitedBody(response, max, signal) {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new WallkeepError('GitHub response exceeds the size limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  // Cancel the reader on abort ourselves: a stalled read() was seen to ignore the fetch signal and hang the import.
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('aborted');
      if (done) break;
      length += value.length;
      if (length > max) throw new WallkeepError('GitHub response exceeds the size limit.');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WallkeepError) throw error;
    throw new WallkeepError('GitHub download failed or timed out. Check the URL and retry.', 502);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return Buffer.concat(chunks);
}

/** Public GitHub imports, plus optional pushes of new uploads into mirrors. Only allowlisted hosts are ever requested. */
export class GitHubImporter {
  #store;
  #fetch;
  #token;
  #pushToken;
  #timer;
  #working;
  #stopped = false;
  #abort = new AbortController();

  constructor({ store, token, pushToken, fetcher = fetch }) { this.#store = store; this.#token = token; this.#pushToken = pushToken; this.#fetch = fetcher; }

  get canPush() { return !!this.#pushToken; }

  /** Commit a wallpaper's original into a mirror's folder and map it, so the next sync sees it as unchanged. */
  async push(id, wallpaperId) {
    if (!this.#pushToken) throw new WallkeepError('Set GITHUB_PUSH_TOKEN on the server to push uploads to GitHub.', 503);
    const source = this.#store.getImport(id);
    if (source.mode !== 'mirror') throw new WallkeepError('Only a mirrored repository can receive uploads.', 409);
    const asset = this.#store.asset(wallpaperId, this.#store.get(wallpaperId).latest.number);
    const path = [source.folder, asset.filename].filter(Boolean).join('/');
    if (this.#store.importedFiles(id).some(file => file.path === path)) throw new WallkeepError(`${path} already exists in this repository. Rename the file and upload again.`, 409);
    let response;
    try {
      response = await this.#fetch(`https://api.github.com/repos/${source.owner}/${source.repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT', redirect: 'error', signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(180_000)]),
        headers: { 'User-Agent': 'Wallkeep', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${this.#pushToken}` },
        body: JSON.stringify({ message: `Add ${path} from Wallkeep`, content: (await readFile(asset.path)).toString('base64'), ...(source.branch && { branch: source.branch }) }),
      });
    } catch { throw new WallkeepError('GitHub push failed or timed out. Retry later.', 502); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 422) throw new WallkeepError(`${path} already exists on GitHub. Rename the file and upload again.`, 409);
    if (!response.ok) throw new WallkeepError(`GitHub rejected the push (HTTP ${response.status}). Check that GITHUB_PUSH_TOKEN can write contents to ${source.owner}/${source.repository}.`, 502);
    if (!/^[a-f\d]{40}$/.test(data.content?.sha)) throw new WallkeepError('GitHub returned an invalid file.', 502);
    // ponytail: a sync already running on an older commit may archive this until the next sync restores it; lock the source if that flicker matters.
    this.#store.linkFile(id, path, wallpaperId, data.content.sha);
    return path;
  }

  add(input) {
    const parsed = parseGitHubURL(input.url, input);
    const source = this.#store.addImport({ ...parsed, mode: input.mode, intervalMinutes: input.intervalMinutes });
    this.kick();
    return source;
  }

  start() {
    this.#stopped = false;
    this.#timer ??= setInterval(() => this.kick(), 5000).unref();
    this.kick();
  }

  kick() {
    if (this.#working || this.#stopped) return;
    this.#working = (async () => {
      // ponytail: one import at a time bounds memory; use dedicated workers for large installations.
      while (!this.#stopped) {
        const [id] = this.#store.dueImports();
        if (!id) break;
        await this.sync(id);
      }
    })().catch(error => console.error('GitHub import worker:', error.message)).finally(() => { this.#working = null; });
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#abort.abort();
    await this.#working;
  }

  /** Fetch an allowlisted GitHub URL and return its body, at most `max` bytes. */
  async #request(url, { raw = false, signal, max }) {
    const host = new URL(url).hostname;
    if (!['api.github.com', 'raw.githubusercontent.com'].includes(host) || !url.startsWith('https://')) throw new WallkeepError('Unsupported download host.');
    const headers = { 'User-Agent': 'Wallkeep', Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json' };
    if (host === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    }
    // A plain timer, cleared when done, covers both the request and reading the whole body.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), raw ? 180_000 : 30_000);
    const combined = AbortSignal.any([this.#abort.signal, signal, deadline.signal].filter(Boolean));
    try {
      let response;
      try {
        response = await this.#fetch(url, { headers, redirect: 'error', signal: combined });
      } catch { throw new WallkeepError('GitHub download failed or timed out. Check the URL and retry.', 502); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new WallkeepError([403, 429].includes(response.status)
          ? 'GitHub rate limit or access restriction. Retry later or configure GITHUB_IMPORT_TOKEN.'
          : `GitHub returned HTTP ${response.status}. Check repository, branch, and file access.`, 502);
      }
      return await limitedBody(response, max, combined);
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(url, signal) {
    const body = await this.#request(url, { signal, max: 9 * 1024 * 1024 });
    try { return JSON.parse(body.toString()); }
    catch (error) { if (error instanceof WallkeepError) throw error; throw new WallkeepError('GitHub returned invalid repository data.', 502); }
  }

  async sync(id) {
    const source = this.#store.getImport(id);
    if (source.mode === 'copy' && source.status === 'synced') throw new WallkeepError('An independent copy does not sync.', 409);
    // A retry reprocesses only the previously failed paths at the same commit and keeps the earlier totals.
    const retry = source.report.retry && source.targetCommit ? new Set(source.report.failedPaths) : null;
    const lease = randomUUID();
    if (!this.#store.claimImport(id, lease)) return;
    const report = { added: 0, updated: 0, unchanged: 0, archived: 0, ...(retry ? source.report : {}), failed: 0, errors: [], failedPaths: [] };
    delete report.retry;
    const signal = this.#abort.signal;
    let commit;
    try {
      const api = `https://api.github.com/repos/${source.owner}/${source.repository}`;
      const repository = await this.#json(api, signal);
      if (repository.private !== false) throw new WallkeepError('Only public GitHub repositories can be imported into this public gallery.');
      const branch = source.branch || repository.default_branch;
      const ref = (source.mode === 'copy' || retry) && source.targetCommit ? source.targetCommit : branch;
      const revision = await this.#json(`${api}/commits/${encodeURIComponent(ref)}`, signal);
      commit = revision.sha;
      let treeSha = revision.commit?.tree?.sha;
      if (!/^[a-f\d]{40}$/.test(commit) || !/^[a-f\d]{40}$/.test(treeSha)) throw new WallkeepError('Invalid GitHub commit.');
      this.#store.pinImport(id, lease, branch, commit);
      const folderParts = source.folder ? source.folder.split('/') : [];
      if (folderParts.length > 20) throw new WallkeepError('Choose a folder no more than 20 levels deep.');
      for (const part of folderParts) {
        const parent = await this.#json(`${api}/git/trees/${treeSha}`, signal);
        if (parent.truncated) throw new WallkeepError('GitHub truncated this folder listing. Choose a smaller repository.');
        const child = parent.tree?.find(entry => entry.path === part && entry.type === 'tree');
        if (!child) throw new WallkeepError('Folder not found. Check the folder path; existing images were kept.');
        treeSha = child.sha;
        if (!/^[a-f\d]{40}$/.test(treeSha)) throw new WallkeepError('Invalid GitHub tree.');
      }
      const tree = await this.#json(`${api}/git/trees/${treeSha}?recursive=1`, signal);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new WallkeepError('GitHub could not return the complete tree. Choose a smaller folder.');
      const files = tree.tree.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && /\.(png|jpe?g|webp)$/i.test(entry.path));
      if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0)) {
        throw new WallkeepError('GitHub returned an invalid image size.');
      }
      const previous = new Map(this.#store.importedFiles(id).map(file => [file.path, file]));
      const present = [];
      for (const file of files) {
        if (signal.aborted) throw new WallkeepError('Import interrupted. Retry to continue without duplicating images.');
        this.#store.renewImport(id, lease, report);
        const path = [source.folder, file.path].filter(Boolean).join('/');
        present.push(path);
        if (retry && !retry.has(path)) continue;
        try {
          if (!file.path || file.path.split('/').some(part => ['.', '..', ''].includes(part)) || /[\x00-\x1f\x7f\\]/.test(path) || !/^[a-f\d]{40}$/.test(file.sha)) throw new WallkeepError('Invalid repository path.');
          let image;
          if (previous.get(path)?.gitSha !== file.sha) {
            if (file.size > MAX_IMAGE_BYTES) throw new WallkeepError('Image exceeds 25 MiB.');
            const rawUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repository}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
            image = await this.#request(rawUrl, { raw: true, signal, max: MAX_IMAGE_BYTES });
            const hash = createHash('sha1').update(`blob ${image.length}\0`).update(image).digest('hex');
            if (hash !== file.sha) throw new WallkeepError('Image does not match its Git blob. Git LFS downloads are not supported.');
          }
          const result = await this.#store.applyImportedFile(id, lease, { path, gitSha: file.sha, commit, image });
          report[result]++;
        } catch (error) {
          // A shutdown is not a file failure: stop the run so it is re-queued.
          if (signal.aborted) throw new WallkeepError('Import interrupted. Retry to continue without duplicating images.');
          report.failed++;
          report.failedPaths.push(path);
          if (report.errors.length < 20) report.errors.push({ path, error: error instanceof WallkeepError ? error.message : 'Could not store image.' });
        }
      }
      if (!report.failed) report.archived = this.#store.archiveMissing(id, lease, present);
      this.#store.finishImport(id, lease, { status: report.failed ? 'partial' : 'synced', commit, report });
    } catch (error) {
      report.errors.push({ error: error instanceof WallkeepError ? error.message : 'Import failed. Existing wallpaper history was kept.' });
      // A shutdown re-queues the import so the next start resumes it.
      this.#store.finishImport(id, lease, { status: this.#stopped ? 'queued' : 'error', commit, report });
    }
    return this.#store.getImport(id);
  }
}
