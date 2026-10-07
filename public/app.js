const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const date = value => new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const size = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const imageUrl = (id, number, preview = true) => `/api/wallpapers/${id}/versions/${number}/${preview ? 'preview' : 'image'}`;
const params = new URLSearchParams(location.search);
let session = { authenticated: false }, current, selected, editing, restoreTarget, afterLogin, objectUrl, noticeTimer;
let view = params.get('view') === 'grid' ? 'grid' : 'list';
let historyOffset = 0;
let importTimer;
const providerName = id => ({ google: 'Google', github: 'GitHub', apple: 'Apple' }[id] ?? id);

async function api(path, options = {}) {
  const headers = { 'X-Wallkeep-Request': '1', ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || 'The request could not be completed.');
  return data;
}

function notice(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 5500);
}

function goToWallpaper(item, message) {
  try { sessionStorage.setItem('wallkeep-notice', message); } catch { /* Storage is optional. */ }
  location.assign(`/wallpapers/${item.id}`);
}

function accountLabel() {
  $('#account-button').textContent = session.authenticated ? `${session.adminName} · Account` : 'Sign in ↗';
  const providers = session.providers?.length ? session.providers : ['google', 'github', 'apple'].map(id => ({ id, enabled: false }));
  $('#social-signin').innerHTML = providers.map(provider => `<button class="button secondary" data-signin="${provider.id}" ${provider.enabled ? '' : 'disabled'}>Continue with ${providerName(provider.id)}${provider.enabled ? '' : ' · not configured'}</button>`).join('');
  $('#email-form').hidden = !session.emailEnabled;
  $('#provider-hint').textContent = providers.some(p => !p.enabled) || !session.emailEnabled ? 'The server owner enables social sign-in with OAuth credentials, and email sign-in with SMTP.' : '';
}

function formError(form, message = '') {
  const error = form.querySelector('.form-error');
  error.textContent = message;
  error.hidden = !message;
}

function busy(form, value) {
  form.dataset.busy = String(value);
  for (const button of form.querySelectorAll('button')) button.disabled = value;
  form.setAttribute('aria-busy', String(value));
}

function asAdmin(callback) {
  if (session.isAdmin) return callback();
  if (session.user) { notice('This library requires admin access. Manage access from your account.'); return location.assign('/account'); }
  openLogin(callback);
}

function openLogin(callback = () => render()) {
  afterLogin = callback;
  formError($('#login-form'));
  formError($('#email-form'));
  $('#login-dialog').showModal();
}

function openUpload(item = null) {
  editing = item;
  const form = $('#upload-form');
  form.reset();
  formError(form);
  $('#upload-title').textContent = item ? 'The next chapter.' : 'Add a wallpaper.';
  $('#upload-submit').textContent = item ? `Save version ${item.latest.number + 1} ↗` : 'Add to library ↗';
  $('#file-label').textContent = item ? 'Choose a new image (optional)' : 'Choose an image';
  $('#upload-hint').textContent = item ? `Saving creates v${item.latest.number + 1}. Leave the image unchanged to update only its details.` : 'Your original file will be preserved. This becomes version 1.';
  form.elements.image.required = !item;
  for (const key of ['title', 'description', 'alt']) form.elements[key].value = item?.latest[key] ?? '';
  form.elements.message.value = item ? '' : 'Initial upload';
  $('#upload-preview').hidden = true;
  $('#upload-dialog').showModal();
}

function row(item) {
  const v = item.latest;
  return `<a class="wallpaper-row" href="/wallpapers/${item.id}" aria-label="${esc(v.title)}, ${item.versionCount} versions">
    <div class="wallpaper-info"><h2 class="wallpaper-title">${esc(v.title)}<span class="version-badge">v${v.number}</span></h2><span class="filename">${esc(v.filename)}</span></div>
    <span class="resolution">${v.width} × ${v.height}<small>${v.width > v.height ? 'Landscape' : v.width === v.height ? 'Square' : 'Portrait'}</small></span>
    <span class="file-size">${size(v.size)}</span><span class="updated">${date(v.createdAt)}<small>${item.versionCount} version${item.versionCount === 1 ? '' : 's'} kept</small></span>
    <span class="author"><span class="avatar" aria-hidden="true">${esc(v.author[0]?.toUpperCase())}</span>${esc(v.author)}</span>
    <img class="row-preview" src="${imageUrl(item.id, v.number)}" alt="" loading="lazy">
  </a>`;
}

function pageLink(offset) {
  const next = new URLSearchParams(params);
  next.set('offset', offset);
  next.set('view', view);
  return `/?${esc(next.toString())}`;
}

async function renderLibrary() {
  const query = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const archived = params.get('archived') === '1';
  const data = await api(`/wallpapers?${new URLSearchParams({ q: query, offset, limit: 20, archived: archived ? '1' : '0' })}`);
  document.title = 'Wallkeep — A place for every version';
  $('#main').innerHTML = `
    <section class="hero"><div><span class="eyebrow">THE WALLPAPER ARCHIVE</span><h1>A place for<br>every <em>version.</em></h1><p>Good wallpapers deserve a home.<br>Collect them, make them yours, keep every chapter.</p></div><div class="hero-actions"><button class="button" data-action="upload"><span aria-hidden="true">＋</span> Add wallpaper</button><button class="button secondary" data-action="import">Import from GitHub ↗</button><a class="subtle-link" href="/imports">Manage imports & mirrors →</a></div></section>
    <div class="toolbar"><div class="collection-title">${query ? 'Search results' : archived ? 'Archived wallpapers' : 'All wallpapers'} <span class="count">${data.total}</span></div>
      <form role="search" action="/"><label><span class="search-icon" aria-hidden="true">⌕</span><input type="search" name="q" aria-label="Search wallpapers" placeholder="Find a wallpaper…" value="${esc(query)}" maxlength="160"></label><input type="hidden" name="view" value="${view}"><input type="hidden" name="archived" value="${archived ? '1' : '0'}"></form>
      <div class="view-toggle" role="group" aria-label="Display layout"><button aria-label="List view" title="List view" aria-pressed="${view === 'list'}" data-view="list">☷</button><button aria-label="Grid view" title="Grid view" aria-pressed="${view === 'grid'}" data-view="grid">⊞</button></div>
    </div>
    ${data.items.length ? `<div class="list-head" ${view === 'grid' ? 'hidden' : ''}><span>WALLPAPER / FILE NAME</span><span>RESOLUTION</span><span class="file-size">SIZE</span><span>LAST UPDATED</span><span class="author">ADDED BY</span><span>PREVIEW</span></div><div id="wallpaper-list" class="${view === 'grid' ? 'grid' : ''}">${data.items.map(row).join('')}</div>` : `<section class="empty"><div class="empty-art" aria-hidden="true"></div><h2>${query ? 'Nothing here by that name.' : 'Your collection starts here.'}</h2><p class="muted">${query ? 'Try another search, or return to the whole collection.' : 'A favorite landscape. A little color. Add your first wallpaper and give it a home.'}</p>${query || offset ? '<a class="button secondary" href="/">View all wallpapers →</a>' : '<button class="button secondary" data-action="upload">Add your first wallpaper <span aria-hidden="true">↗</span></button>'}</section>`}
    <div class="results-footer"><span>${data.total ? `${Math.min(offset + 1, data.total)}–${Math.min(offset + data.items.length, data.total)} of ${data.total} wallpapers` : 'Every version is kept.'} · <a href="${archived ? '/' : '/?archived=1'}">${archived ? 'Active library' : 'View archived'}</a></span><div class="pagination">${offset ? `<a class="button secondary small" href="${pageLink(Math.max(0, offset - 20))}">← Previous</a>` : ''}${offset + data.items.length < data.total ? `<a class="button secondary small" href="${pageLink(offset + 20)}">Next →</a>` : ''}</div></div>`;
}

function historyRow(v) {
  return `<li class="history-row ${selected.number === v.number ? 'selected' : ''}">
    <img class="history-thumb" src="${imageUrl(current.id, v.number)}" alt="" loading="lazy">
    <div class="history-summary"><strong>v${v.number} · ${esc(v.message || 'Updated wallpaper')}</strong>${v.number === current.latest.number ? '<span class="version-badge">LATEST</span>' : ''}
    <p>${date(v.createdAt)} · ${esc(v.author)}${v.restoredFrom ? ` · restored from v${v.restoredFrom}` : ''}</p></div>
    <a class="text-button" href="/wallpapers/${current.id}?v=${v.number}" ${selected.number === v.number ? 'aria-current="true"' : ''}>${selected.number === v.number ? 'Viewing' : 'View'} <span aria-hidden="true">↗</span></a>
    ${session.isAdmin && current.source?.mode !== 'mirror' && (v.number !== current.latest.number || current.archived) ? `<button class="text-button" data-restore="${v.number}">Restore</button>` : ''}</li>`;
}

async function renderDetail(id) {
  current = await api(`/wallpapers/${id}`);
  const number = params.has('v') ? Number(params.get('v')) : current.latest.number;
  const [v, history] = await Promise.all([number === current.latest.number ? current.latest : api(`/wallpapers/${id}/versions/${number}`), api(`/wallpapers/${id}/versions`)]);
  selected = v;
  historyOffset = history.items.length;
  document.title = `${v.title} · v${v.number} — Wallkeep`;
  $('#main').innerHTML = `<a class="back-link" href="/"><span aria-hidden="true">←</span> Back to the library</a>
    <div class="detail-heading"><div><span class="eyebrow">FROM YOUR COLLECTION · VERSION ${v.number}</span><h1>${esc(v.title)}</h1></div><div class="detail-actions">${session.isAdmin && current.source?.mode !== 'mirror' ? '<button class="button secondary" data-action="revise">＋ New version</button>' : ''}<a class="button" href="${imageUrl(id, v.number, false)}?download" download>Download original <span aria-hidden="true">↓</span></a></div></div>
    ${current.source ? `<div class="source-banner"><span>${current.archived ? 'Archived · removed upstream. History is preserved.' : current.source.mode === 'mirror' ? 'Mirrored from GitHub · local editing is locked.' : 'Independent copy imported from GitHub.'} <a href="${esc(current.source.url)}" target="_blank" rel="noreferrer">${esc(current.source.owner)}/${esc(current.source.repository)} ↗</a></span>${session.isAdmin ? '<a href="/imports">Manage source →</a>' : ''}</div>` : ''}
    ${v.number !== current.latest.number ? `<div class="old-version"><span>You’re viewing v${v.number}. The latest version is v${current.latest.number}.</span><a href="/wallpapers/${id}">View latest →</a></div>` : ''}
    <div class="detail-layout"><div><div class="image-stage"><img src="${imageUrl(id, v.number)}" alt="${esc(v.alt)}"></div><div class="image-caption"><span>${esc(v.alt || v.filename)}</span><span>${v.width} × ${v.height}</span></div>
      <section class="history"><div class="history-heading"><h2>Version history <span class="version-badge">${current.versionCount}</span></h2><p>Every chapter, right here.</p></div><ol class="timeline">${history.items.map(historyRow).join('')}</ol><button class="button secondary small" data-action="more-history" ${historyOffset >= history.total ? 'hidden' : ''}>Load older versions</button></section>
    </div><aside class="detail-sidebar"><div class="sidebar-description"><h2>About this wallpaper</h2><p class="description">${esc(v.description || 'No description yet. Sometimes the image says it all.')}</p></div>
      <dl class="properties"><div><dt>Resolution</dt><dd>${v.width} × ${v.height}</dd></div><div><dt>File size</dt><dd>${size(v.size)}</dd></div><div><dt>Format</dt><dd>${esc(v.mime.split('/')[1].toUpperCase())}</dd></div><div><dt>Added by</dt><dd>${esc(v.author)}</dd></div><div><dt>Version saved</dt><dd>${date(v.createdAt)}</dd></div><div><dt>First uploaded</dt><dd>${date(current.createdAt)}</dd></div><div><dt>File name</dt><dd>${esc(v.filename)}</dd></div></dl>
      <div class="change-note"><span class="eyebrow">VERSION ${v.number} NOTE</span><p>${esc(v.message || 'No change note.')}</p></div>
    </aside></div>`;
}

async function renderAccount() {
  document.title = 'Your account — Wallkeep';
  const linked = session.user ? await api('/auth/list-accounts') : [];
  $('#main').innerHTML = `<a class="back-link" href="/">← Back to the library</a>
    <section class="settings-heading"><span class="eyebrow">ONE ACCOUNT, YOUR CHOICE</span><h1>Your account.</h1><p class="muted">Connect your sign-in methods here. Your library stays in the same place.</p></section>
    ${session.user ? `<section class="settings-card"><h2>${esc(session.user.name)}</h2><p class="muted">${esc(session.user.email)} · ${session.accountAdmin ? 'Library admin' : 'Viewer'}</p><p class="hint">Connect another provider while signed in. Matching email addresses alone never merge accounts.</p>
      <div class="provider-list">${(session.providers ?? []).map(provider => {
        const matches = linked.filter(account => account.providerId === provider.id);
        return `<div class="provider-row"><div><strong>${providerName(provider.id)}</strong><small>${matches.length ? 'Connected to this account' : provider.enabled ? 'Not connected' : 'Needs server configuration'}</small></div><div class="provider-actions">${matches.map(account => `<button class="button secondary small" data-unlink="${esc(account.id)}">Disconnect</button>`).join('')}${!matches.length ? `<button class="button secondary small" data-link="${provider.id}" ${provider.enabled ? '' : 'disabled'}>Connect</button>` : ''}</div></div>`;
      }).join('')}<div class="provider-row"><div><strong>Email sign-in link</strong><small>${session.emailEnabled ? esc(session.user.email) : 'Needs SMTP configuration'}</small></div>${session.emailEnabled ? '<button class="button secondary small" data-action="email-self">Send link</button>' : ''}</div></div>
      <p class="hint">Reconnect by signing in again if your session is more than 10 minutes old. The last linked social provider cannot be disconnected.</p></section>
      ${!session.accountAdmin ? `<section class="settings-card"><h2>Own this server?</h2><p class="muted">Connect this account to your library’s admin access using the server admin token.</p><form id="claim-form"><label>Server admin token<input name="token" type="password" required minlength="32" autocomplete="off"></label><p class="form-error" role="alert" hidden></p><button class="button" type="submit">Enable admin access</button></form></section>` : ''}` : `<section class="settings-card"><h2>${session.isAdmin ? 'You’re using the server token.' : 'Make yourself at home.'}</h2><p class="muted">Sign in with email or a configured social provider to create a permanent account and connect more providers.</p><button class="button" data-action="signin-account">Sign in to an account ↗</button></section>`}
    ${session.authenticated ? '<button class="button secondary" data-action="signout">Sign out</button>' : ''}`;
}

function importCard(source) {
  const report = source.report;
  const active = ['queued', 'running'].includes(source.status);
  return `<article class="settings-card import-card"><div class="import-card-heading"><div><span class="eyebrow">${source.mode === 'mirror' ? 'GITHUB MIRROR' : 'INDEPENDENT COPY'}</span><h2><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.owner)}/${esc(source.repository)} ↗</a></h2><p class="hint">${esc(source.branch || 'Default branch')} · ${esc(source.folder || 'All folders')} · ${source.fileCount} images</p></div><span class="sync-status" role="status">${esc(source.status)}</span></div>
    <p class="muted">${active ? 'Working in the background. You can leave this page.' : source.lastSyncedAt ? `Last checked ${new Date(source.lastSyncedAt).toLocaleString()}` : 'Waiting for its first import.'}</p>
    ${report.added !== undefined ? `<p class="import-totals">${report.added} added · ${report.updated} updated · ${report.unchanged} unchanged · ${report.archived} archived · ${report.failed} failed</p>` : ''}
    ${source.lastCommit ? `<p class="hint">Last complete snapshot: <code>${esc(source.lastCommit.slice(0, 12))}</code></p>` : ''}
    ${source.mode === 'mirror' ? `<p class="hint">Checks every ${source.intervalMinutes} minutes while the server is running. Removed upstream images are archived; their history stays available.</p>` : '<p class="hint">Files live independently in Wallkeep. Future GitHub changes will not update a completed copy.</p>'}
    ${report.errors?.length ? `<details class="import-errors"><summary>${report.errors.length} issue${report.errors.length > 1 ? 's' : ''}${report.failed > report.errors.length ? ' (showing first 20)' : ''}</summary><ul>${report.errors.map(error => `<li>${error.path ? `<strong>${esc(error.path)}</strong><br>` : ''}${esc(error.error)}</li>`).join('')}</ul></details>` : ''}
    <div class="card-actions">${source.mode === 'mirror' || ['partial', 'error'].includes(source.status) ? `<button class="button secondary small" data-sync="${source.id}" ${active ? 'disabled' : ''}>${source.mode === 'mirror' ? 'Sync now' : 'Retry import'}</button>` : ''}${source.mode === 'mirror' ? `<button class="button secondary small" data-detach="${source.id}" ${active ? 'disabled' : ''}>Make independent</button>` : ''}<button class="text-button" data-files="${source.id}">View imported files →</button></div><div class="import-files" id="files-${source.id}"></div></article>`;
}

async function renderImports() {
  clearTimeout(importTimer);
  document.title = 'GitHub imports — Wallkeep';
  if (!session.isAdmin) {
    $('#main').innerHTML = '<section class="settings-heading"><span class="eyebrow">YOUR COLLECTION, CONNECTED</span><h1>GitHub imports.</h1><p class="muted">An admin account is required to manage this library’s imports and mirrors.</p><button class="button" data-action="signin-account">Sign in</button> <a class="button secondary" href="/account">Account settings</a></section>';
    return;
  }
  const { items } = await api('/imports');
  $('#main').innerHTML = `<a class="back-link" href="/">← Back to the library</a><section class="settings-heading"><span class="eyebrow">YOUR COLLECTION, CONNECTED</span><h1>GitHub imports.</h1><p class="muted">Bring a collection over once, or keep a mirror in step with its source.</p><div class="card-actions"><button class="button" data-action="import">Import a repository ↗</button><button class="button secondary" data-action="refresh-imports">Refresh status</button><a class="subtle-link" href="/?archived=1">View archived wallpapers →</a></div></section>
    <div id="import-list">${items.length ? items.map(importCard).join('') : '<section class="settings-card"><h2>No repositories connected yet.</h2><p class="muted">Paste a public GitHub repository URL to start your first import.</p></section>'}</div>`;
  if (items.some(source => ['queued', 'running'].includes(source.status))) importTimer = setTimeout(() => renderImports().catch(error => notice(error.message)), 5000);
}

async function social(provider, linking = false) {
  const data = await api(linking ? '/auth/link-social' : '/auth/sign-in/social', {
    method: 'POST', body: { provider, callbackURL: '/account', errorCallbackURL: '/account', disableRedirect: true },
  });
  if (!data.url) throw new Error('This provider did not return a sign-in URL.');
  location.assign(data.url);
}

async function render() {
  const match = location.pathname.match(/^\/wallpapers\/([a-f0-9-]{36})$/);
  try { if (match) await renderDetail(match[1]); else if (location.pathname === '/account') await renderAccount(); else if (location.pathname === '/imports') await renderImports(); else await renderLibrary(); }
  catch (error) { $('#main').innerHTML = `<section class="error-panel"><span class="eyebrow">LET’S TRY THAT AGAIN</span><h1>Couldn’t open this page.</h1><p class="muted">${esc(error.message)}</p><a class="button secondary" href="/">Back to the library →</a></section>`; }
}

$('#main').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) {
    view = button.dataset.view;
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    location.assign(url);
  }
  if (button.dataset.action === 'upload') asAdmin(() => openUpload());
  if (button.dataset.action === 'import') asAdmin(() => { formError($('#import-form')); $('#import-dialog').showModal(); });
  if (button.dataset.action === 'signin-account') openLogin();
  if (button.dataset.action === 'refresh-imports') await renderImports().catch(error => notice(error.message));
  if (button.dataset.link || button.dataset.unlink || button.dataset.sync || button.dataset.detach || button.dataset.files || ['signout', 'email-self'].includes(button.dataset.action)) {
    button.disabled = true;
    try {
      if (button.dataset.link) await social(button.dataset.link, true);
      if (button.dataset.unlink && confirm('Disconnect this sign-in provider from your account?')) {
        await api('/auth/unlink-account', { method: 'POST', body: { accountId: button.dataset.unlink } });
        await renderAccount(); notice('Provider disconnected.');
      }
      if (button.dataset.sync) { await api(`/imports/${button.dataset.sync}/sync`, { method: 'POST', body: {} }); await renderImports(); }
      if (button.dataset.detach && confirm('Make this mirror independent? Automatic sync will stop and local editing will become available. Existing history will stay.')) {
        await api(`/imports/${button.dataset.detach}/detach`, { method: 'POST', body: {} });
        await renderImports(); notice('Mirror is now an independent copy.');
      }
      if (button.dataset.files) {
        clearTimeout(importTimer);
        const { items } = await api(`/imports/${button.dataset.files}/files`);
        $(`#files-${button.dataset.files}`).innerHTML = items.length ? `<ul>${items.map(file => `<li><a href="/wallpapers/${file.wallpaperId}">${esc(file.path)}${file.archived ? ' · archived' : ''} ↗</a></li>`).join('')}</ul>` : '<p class="hint">No images imported yet.</p>';
      }
      if (button.dataset.action === 'signout') {
        if (session.user) await api('/auth/sign-out', { method: 'POST', body: {} });
        await api('/session', { method: 'DELETE' });
        location.assign('/');
      }
      if (button.dataset.action === 'email-self') {
        await api('/auth/sign-in/magic-link', { method: 'POST', body: { email: session.user.email, callbackURL: '/account' } });
        notice('Check your email for a sign-in link.');
      }
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  }
  if (button.dataset.action === 'revise') asAdmin(() => openUpload(current));
  if (button.dataset.restore) asAdmin(() => {
    restoreTarget = Number(button.dataset.restore);
    $('#restore-title').textContent = `Bring back version ${restoreTarget}?`;
    $('#restore-description').textContent = `The image and details from v${restoreTarget} will become v${current.latest.number + 1}. All ${current.versionCount} existing versions will stay in your history.`;
    $('#restore-form').elements.message.value = `Restored from v${restoreTarget}`;
    formError($('#restore-form'));
    $('#restore-dialog').showModal();
  });
  if (button.dataset.action === 'more-history') {
    button.disabled = true;
    try {
      const history = await api(`/wallpapers/${current.id}/versions?offset=${historyOffset}`);
      $('.timeline').insertAdjacentHTML('beforeend', history.items.map(historyRow).join(''));
      historyOffset += history.items.length;
      button.hidden = historyOffset >= history.total;
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  }
});

$('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
$('#account-button').addEventListener('click', async () => {
  if (!session.authenticated) return openLogin();
  location.assign('/account');
});

for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
  const dialog = button.closest('dialog');
  if (!dialog.querySelector('form[data-busy="true"]')) dialog.close();
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', event => {
  if (dialog.querySelector('form[data-busy="true"]')) event.preventDefault();
});
$('#login-dialog').addEventListener('close', () => { $('#login-form').reset(); afterLogin = null; });
$('#upload-dialog').addEventListener('close', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; });

$('#social-signin').addEventListener('click', async event => {
  const button = event.target.closest('[data-signin]');
  if (!button) return;
  button.disabled = true;
  try { await social(button.dataset.signin); }
  catch (error) { notice(error.message); button.disabled = false; }
});

$('#email-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form, true); formError(form);
  try {
    await api('/auth/sign-in/magic-link', { method: 'POST', body: { email: form.elements.email.value, callbackURL: '/account' } });
    $('#login-dialog').close(); notice('Check your email. The sign-in link expires in 10 minutes.');
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

$('#import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form, true); formError(form);
  try {
    const input = Object.fromEntries(new FormData(form));
    input.intervalMinutes = Number(input.intervalMinutes);
    await api('/imports', { method: 'POST', body: input });
    location.assign('/imports');
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

$('#main').addEventListener('submit', async event => {
  if (event.target.id !== 'claim-form') return;
  event.preventDefault();
  const form = event.target;
  busy(form, true); formError(form);
  try {
    await api('/account/claim-admin', { method: 'POST', body: { token: form.elements.token.value } });
    session = await api('/session'); accountLabel(); await renderAccount(); notice('This account now has admin access.');
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form, true); formError(form);
  try {
    await api('/session', { method: 'POST', body: { token: form.elements.token.value.trim() } });
    session = await api('/session');
    accountLabel();
    const callback = afterLogin;
    $('#login-dialog').close();
    if (callback) await callback();
    notice('Signed in. Make yourself at home.');
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

$('#upload-form').elements.image.addEventListener('change', event => {
  const file = event.target.files[0];
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  $('#upload-preview').hidden = !file;
  if (!file) return;
  $('#file-label').textContent = file.name;
  if (file.size > 25 * 1024 * 1024) {
    event.target.value = '';
    $('#upload-preview').hidden = true;
    return formError($('#upload-form'), 'Choose an image smaller than 25 MiB.');
  }
  formError($('#upload-form'));
  objectUrl = URL.createObjectURL(file);
  $('#upload-preview').src = objectUrl;
  const title = $('#upload-form').elements.title;
  if (!title.value) title.value = file.name.replace(/\.[^.]*$/, '').replace(/[-_]/g, ' ').slice(0, 160);
});

$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  if (editing) data.set('expectedVersion', editing.latest.number);
  if (!String(data.get('alt')).trim()) data.set('alt', data.get('title'));
  busy(form, true); formError(form);
  try {
    const item = await api(editing ? `/wallpapers/${editing.id}/versions` : '/wallpapers', { method: 'POST', body: data });
    goToWallpaper(item, `Version ${item.latest.number} saved. A little history, kept.`);
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

$('#restore-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form, true); formError(form);
  try {
    const item = await api(`/wallpapers/${current.id}/versions/${restoreTarget}/restore`, { method: 'POST', body: { expectedVersion: current.latest.number, message: form.elements.message.value } });
    goToWallpaper(item, `Version ${restoreTarget} restored as v${item.latest.number}. Nothing lost.`);
  } catch (error) { formError(form, error.message); }
  finally { busy(form, false); }
});

try {
  session = await api('/session');
  accountLabel();
  await render();
  if (params.has('error')) notice(params.get('error') === 'account_not_linked' ? 'Sign in with your existing method, then connect this provider from Account settings.' : 'Sign-in or account linking did not finish. Try again from Account settings.');
  const message = sessionStorage.getItem('wallkeep-notice');
  if (message) { notice(message); sessionStorage.removeItem('wallkeep-notice'); }
} catch (error) {
  notice(error.message);
  if (!$('#main').querySelector('.hero,.detail-heading,.error-panel')) await render();
}
