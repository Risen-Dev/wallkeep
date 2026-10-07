import { createHash, randomUUID } from 'node:crypto';
import { MAX_IMAGE_BYTES, WallkeepError } from './store.js';

const MAX_FILES = 500;
const MAX_BYTES = 500 * 1024 * 1024;

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

async function limitedBody(response, max) {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new WallkeepError('GitHub response exceeds the size limit.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > max) throw new WallkeepError('GitHub response exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One-way public GitHub imports. Only allowlisted hosts are ever requested. */
export class GitHubImporter {
  #store;
  #fetch;
  #token;
  #timer;
  #working;
  #stopped = false;
  #abort = new AbortController();

  constructor({ store, token, fetcher = fetch }) { this.#store = store; this.#token = token; this.#fetch = fetcher; }

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

  async #request(url, { raw = false, signal } = {}) {
    const host = new URL(url).hostname;
    if (!['api.github.com', 'raw.githubusercontent.com'].includes(host) || !url.startsWith('https://')) throw new WallkeepError('Unsupported download host.');
    const headers = { 'User-Agent': 'Wallkeep', Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json' };
    if (host === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    }
    let response;
    try {
      response = await this.#fetch(url, { headers, redirect: 'error', signal: AbortSignal.any([this.#abort.signal, signal, AbortSignal.timeout(30_000)].filter(Boolean)) });
    } catch { throw new WallkeepError('GitHub download failed or timed out. Check the URL and retry.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WallkeepError([403, 429].includes(response.status)
        ? 'GitHub rate limit or access restriction. Retry later or configure GITHUB_IMPORT_TOKEN.'
        : `GitHub returned HTTP ${response.status}. Check repository, branch, and file access.`, 502);
    }
    return response;
  }

  async #json(url, signal) {
    const response = await this.#request(url, { signal });
    try { return JSON.parse((await limitedBody(response, 9 * 1024 * 1024)).toString()); }
    catch (error) { if (error instanceof WallkeepError) throw error; throw new WallkeepError('GitHub returned invalid repository data.', 502); }
  }

  async sync(id) {
    const source = this.#store.getImport(id);
    if (source.mode === 'copy' && source.status === 'synced') throw new WallkeepError('An independent copy does not sync.', 409);
    const lease = randomUUID();
    if (!this.#store.claimImport(id, lease)) return;
    const report = { added: 0, updated: 0, unchanged: 0, archived: 0, failed: 0, errors: [] };
    const signal = AbortSignal.timeout(10 * 60_000);
    let commit;
    try {
      const api = `https://api.github.com/repos/${source.owner}/${source.repository}`;
      const repository = await this.#json(api, signal);
      if (repository.private !== false) throw new WallkeepError('Only public GitHub repositories can be imported into this public gallery.');
      const branch = source.branch || repository.default_branch;
      const ref = source.mode === 'copy' && source.targetCommit ? source.targetCommit : branch;
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
      if (files.length > MAX_FILES) throw new WallkeepError(`This folder has ${files.length} images; the limit is ${MAX_FILES}. Import smaller folders separately.`);
      if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0) || files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) {
        throw new WallkeepError('This folder exceeds the 500 MiB image limit. Choose a smaller folder.');
      }
      const previous = new Map(this.#store.importedFiles(id).map(file => [file.path, file]));
      const present = [];
      let downloaded = 0;
      for (const file of files) {
        if (signal.aborted || this.#abort.signal.aborted) throw new WallkeepError('Import interrupted. Retry to continue without duplicating images.');
        const path = [source.folder, file.path].filter(Boolean).join('/');
        present.push(path);
        try {
          if (!file.path || file.path.split('/').some(part => ['.', '..', ''].includes(part)) || /[\x00-\x1f\x7f\\]/.test(path) || !/^[a-f\d]{40}$/.test(file.sha)) throw new WallkeepError('Invalid repository path.');
          let image;
          if (previous.get(path)?.gitSha !== file.sha) {
            if (file.size > MAX_IMAGE_BYTES) throw new WallkeepError('Image exceeds 25 MiB.');
            const rawUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repository}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
            image = await limitedBody(await this.#request(rawUrl, { raw: true, signal }), MAX_IMAGE_BYTES);
            downloaded += image.length;
            if (downloaded > MAX_BYTES) throw new WallkeepError('Download budget exceeded.');
            const hash = createHash('sha1').update(`blob ${image.length}\0`).update(image).digest('hex');
            if (hash !== file.sha) throw new WallkeepError('Image does not match its Git blob. Git LFS downloads are not supported.');
          }
          const result = await this.#store.applyImportedFile(id, lease, { path, gitSha: file.sha, commit, image });
          report[result]++;
        } catch (error) {
          report.failed++;
          if (report.errors.length < 20) report.errors.push({ path, error: error instanceof WallkeepError ? error.message : 'Could not store image.' });
        }
      }
      if (!report.failed) report.archived = this.#store.archiveMissing(id, lease, present);
      this.#store.finishImport(id, lease, { status: report.failed ? 'partial' : 'synced', commit, report });
    } catch (error) {
      report.errors.push({ error: error instanceof WallkeepError ? error.message : 'Import failed. Existing wallpaper history was kept.' });
      this.#store.finishImport(id, lease, { status: 'error', commit, report });
    }
    return this.#store.getImport(id);
  }
}
