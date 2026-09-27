/**
 * @fileoverview DriveVault -- app.js
 * Multi-tenant Google Drive media manager.
 * Auth: Google Identity Services (GIS) OAuth 2.0 implicit grant.
 * API:  Google Drive API v3 via fetch().
 *
 * BEFORE DEPLOYING:
 *   1. Replace CLIENT_ID with your OAuth 2.0 Client ID.
 *   2. Replace API_KEY with your HTTP-referrer-locked API Key.
 *   3. Set allowed origins in Google Cloud Console.
 */

'use strict';

const CONFIG = Object.freeze({
  CLIENT_ID: '207970775721-vuvundo4o5sdiqbvjj7ebprn88bt8die.apps.googleusercontent.com',
  API_KEY: 'AIzaSyAIFywynSWVspVWfiBe3qxxD0k8VfjWV6M',
  DRIVE_API: 'https://www.googleapis.com/drive/v3',
  SCOPES: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  MEDIA_MIME_TYPES: new Set([
    'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm',
    'video/mpeg', 'video/ogg', 'video/3gpp', 'video/x-flv',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'image/bmp', 'image/tiff', 'image/heic', 'image/avif',
  ]),
  PAGE_SIZE: 50,
  TOKEN_REFRESH_HEADROOM_S: 300,
  TOAST_DURATION_MS: 4000,
  SEARCH_DEBOUNCE_MS: 350,
});

// APPLICATION STATE
const state = {
  accounts: new Map(),
  activeAccountSub: null,
  currentFolderId: 'root',
  breadcrumb: [{ id: 'root', name: 'My Drive' }],
  allFiles: [],
  filteredFiles: [],
  nextPageToken: null,
  sortKey: 'modifiedTime',
  sortDir: 'desc',
  activeFilter: 'all',
  searchQuery: '',
  viewMode: 'grid',
  lightbox: { open: false, index: -1 },
  tokenClient: null,
  scrollObserver: null,
  loading: false,
};

// SESSION STORAGE -- tokens in sessionStorage only, never localStorage
const SESSION_KEY = 'dv_accounts';

function persistAccountMetaToSession() {
  try {
    const s = [];
    for (const [sub, a] of state.accounts) {
      s.push({ sub, email: a.email, name: a.name, picture: a.picture });
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch (_) { }
}

function restoreAccountMetaFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    for (const a of JSON.parse(raw)) {
      if (!a.sub || !a.email) continue;
      state.accounts.set(a.sub, { ...a, token: null, expiresAt: 0 });
    }
  } catch (_) { }
}

// DOM REFERENCES
const $ = id => document.getElementById(id);
const DOM = {};

function cacheDOM() {
  const ids = [
    'account-list', 'btn-add-account', 'btn-sign-out-all', 'folder-tree',
    'breadcrumb-list', 'quota-display', 'current-folder-title', 'media-count',
    'search-input', 'btn-search-clear', 'sort-select', 'btn-grid-view', 'btn-list-view',
    'media-grid', 'media-grid-wrapper', 'load-more-sentinel', 'load-more-spinner',
    'state-auth', 'state-loading', 'state-empty', 'state-error', 'error-message',
    'btn-retry', 'loading-message', 'btn-auth-primary', 'lightbox', 'lightbox-backdrop',
    'lightbox-stage', 'lightbox-filename', 'lightbox-details', 'lightbox-open-drive',
    'btn-lightbox-close', 'btn-lightbox-prev', 'btn-lightbox-next', 'toast-container', 'btn-theme-toggle',
  ];
  ids.forEach(id => { DOM[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id); });
  DOM.filterChips = document.querySelectorAll('.chip[data-filter]');
}

// SANITISATION -- all Drive API data sanitised before DOM insertion (XSS prevention)
const _san = document.createElement('div');

/**
 * Sanitises raw API string via browser textContent escaping.
 * @param {*} raw
 * @returns {string} HTML-safe string.
 */
function sanitiseText(raw) {
  if (raw == null) return '';
  _san.textContent = String(raw);
  return _san.innerHTML;
}

/**
 * Validates a URL is within expected Google domains.
 * @param {string} url
 * @returns {string}
 */
function sanitiseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const allowed = ['drive.google.com', 'lh3.googleusercontent.com', 'googleusercontent.com', 'www.googleapis.com'];
    return allowed.some(d => u.hostname === d || u.hostname.endsWith('.' + d)) ? url : '';
  } catch { return ''; }
}

// UTILITIES
function formatBytes(b) {
  const n = parseInt(b, 10);
  if (isNaN(n) || n < 0) return '--';
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d)) return '--';
  const diff = Date.now() - d.getTime();
  const m = 60000, h = 3600000, dy = 86400000;
  if (diff < m) return 'Just now';
  if (diff < h) return Math.floor(diff / m) + 'm ago';
  if (diff < dy) return Math.floor(diff / h) + 'h ago';
  if (diff < 7 * dy) return Math.floor(diff / dy) + 'd ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function mediaTypeFromMime(mime) {
  if (!mime) return 'unknown';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return 'unknown';
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// GIS AUTH
function initGIS() {
  if (!window.google?.accounts?.oauth2) {
    showState('error');
    DOM.errorMessage.textContent = 'Google Identity Services failed to load. Check your network.';
    return;
  }
  state.tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (res) => {
      if (res.error) {
        showToast(res.error === 'access_denied' ? 'Access denied. Allow Drive permissions.' : 'Auth error: ' + sanitiseText(res.error), 'error');
        return;
      }
      await handleTokenResponse(res);
    },
  });
}

function requestToken(hint) {
  if (!state.tokenClient) { showToast('Auth not ready. Refresh the page.', 'error'); return; }
  state.tokenClient.requestAccessToken({ prompt: hint ? '' : 'select_account', login_hint: hint || undefined });
}

async function handleTokenResponse(res) {
  const { access_token, expires_in } = res;
  const expiresAt = Date.now() + (parseInt(expires_in, 10) - CONFIG.TOKEN_REFRESH_HEADROOM_S) * 1000;
  let profile;
  try { profile = await fetchUserProfile(access_token); }
  catch (e) { showToast('Could not retrieve profile. Try again.', 'error'); return; }
  const sub = profile.sub || profile.id;
  if (!sub) { showToast('Invalid account response.', 'error'); return; }
  const account = {
    sub, email: sanitiseText(profile.email || ''),
    name: sanitiseText(profile.name || profile.email || 'Unknown'),
    picture: sanitiseUrl(profile.picture || ''),
    token: access_token, expiresAt,
  };
  state.accounts.set(sub, account);
  persistAccountMetaToSession();
  setActiveAccount(sub);
  renderAccountList();
  DOM.btnSignOutAll.hidden = false;
  showToast('Signed in as ' + account.name, 'success');
}

async function fetchUserProfile(token) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('Profile HTTP ' + r.status);
  return r.json();
}

function getActiveToken() {
  const a = state.accounts.get(state.activeAccountSub);
  if (!a || !a.token) return null;
  if (Date.now() > a.expiresAt) { requestToken(a.email); return null; }
  return a.token;
}

function setActiveAccount(sub) {
  state.activeAccountSub = sub;
  state.currentFolderId = 'root';
  state.breadcrumb = [{ id: 'root', name: 'My Drive' }];
  state.allFiles = [];
  state.filteredFiles = [];
  state.nextPageToken = null;
  renderBreadcrumb();
  loadFolder('root');
}

function removeAccount(sub) {
  const a = state.accounts.get(sub);
  if (!a) return;
  if (a.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(a.token, () => { });
  state.accounts.delete(sub);
  persistAccountMetaToSession();
  if (state.activeAccountSub === sub) {
    const rem = [...state.accounts.keys()];
    if (rem.length > 0) { setActiveAccount(rem[0]); }
    else { state.activeAccountSub = null; state.allFiles = []; state.filteredFiles = []; showState('auth'); DOM.btnSignOutAll.hidden = true; }
  }
  renderAccountList();
  showToast('Account removed.', 'info');
}

function signOutAll() {
  for (const [, a] of state.accounts) {
    if (a.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(a.token, () => { });
  }
  state.accounts.clear(); state.activeAccountSub = null;
  state.allFiles = []; state.filteredFiles = [];
  state.breadcrumb = [{ id: 'root', name: 'My Drive' }];
  sessionStorage.removeItem(SESSION_KEY);
  renderAccountList(); renderBreadcrumb();
  DOM.btnSignOutAll.hidden = true; DOM.quotaDisplay.innerHTML = '';
  showState('auth'); showToast('Signed out of all accounts.', 'info');
}

// DRIVE API LAYER
class DriveApiError extends Error {
  constructor(message, status) { super(message); this.name = 'DriveApiError'; this.status = status; }
}

async function driveRequest(endpoint, options = {}, isRetry = false) {
  const token = getActiveToken();
  if (!token) throw new DriveApiError('Not authenticated.', 401);
  const url = endpoint.startsWith('http') ? endpoint : (CONFIG.DRIVE_API + endpoint + '&key=' + encodeURIComponent(CONFIG.API_KEY));
  const r = await fetch(url, { ...options, headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', ...options.headers } });
  if (r.status === 401) { const a = state.accounts.get(state.activeAccountSub); requestToken(a?.email); throw new DriveApiError('Session expired.', 401); }
  if (r.status === 429 && !isRetry) { await new Promise(res => setTimeout(res, 1000)); return driveRequest(endpoint, options, true); }
  if (!r.ok) { let b = {}; try { b = await r.json(); } catch (_) { } throw new DriveApiError(b?.error?.message || 'Drive API error ' + r.status, r.status); }
  return r;
}

async function listDriveFiles(folderId, pageToken) {
  const mimeQ = [...CONFIG.MEDIA_MIME_TYPES].map(m => "mimeType='" + m + "'").join(' or ');
  const q = "'" + folderId + "' in parents and (" + mimeQ + ") and trashed=false";
  const p = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink)', pageSize: CONFIG.PAGE_SIZE, orderBy: state.sortKey + ' ' + state.sortDir, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  if (pageToken) p.set('pageToken', pageToken);
  const r = await driveRequest('/files?' + p.toString());
  return r.json();
}

async function listSubfolders(folderId) {
  const p = new URLSearchParams({ q: "'" + folderId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", fields: 'files(id,name)', pageSize: '50', orderBy: 'name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  const r = await driveRequest('/files?' + p.toString());
  const d = await r.json();
  return d.files || [];
}

async function fetchQuota() {
  const r = await driveRequest('/about?fields=storageQuota');
  const d = await r.json();
  return d.storageQuota || {};
}

async function createMediaBlobUrl(fileId) {
  const p = new URLSearchParams({ alt: 'media', key: CONFIG.API_KEY, supportsAllDrives: 'true' });
  const endpoint = CONFIG.DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?' + p;
  const r = await driveRequest(endpoint, {}, false);
  return URL.createObjectURL(await r.blob());
}

// FOLDER NAVIGATION
async function loadFolder(folderId, folderName) {
  if (state.loading) return;
  state.currentFolderId = folderId; state.allFiles = []; state.filteredFiles = []; state.nextPageToken = null;
  if (folderName && folderId !== 'root') { const last = state.breadcrumb[state.breadcrumb.length - 1]; if (last.id !== folderId) state.breadcrumb.push({ id: folderId, name: folderName }); }
  DOM.currentFolderTitle.textContent = folderName || (folderId === 'root' ? 'My Drive' : 'Folder');
  renderBreadcrumb(); renderFolderTree(folderId);
  showState('loading'); DOM.loadingMessage.textContent = 'Loading media...'; renderSkeletons(8);
  try { await fetchNextPage(); fetchQuota().then(renderQuota).catch(() => { }); }
  catch (err) { showState('error'); DOM.errorMessage.textContent = sanitiseText(err.message); console.error(err); }
}

async function fetchNextPage() {
  if (state.loading && state.allFiles.length > 0) return;
  state.loading = true;
  try {
    const data = await listDriveFiles(state.currentFolderId, state.nextPageToken || undefined);
    const newFiles = (data.files || []).map(f => ({ id: f.id, name: sanitiseText(f.name), mime: f.mimeType, type: mediaTypeFromMime(f.mimeType), size: f.size, modifiedTime: f.modifiedTime, thumbnail: sanitiseUrl(f.thumbnailLink || ''), driveUrl: sanitiseUrl(f.webViewLink || '') }));
    state.allFiles.push(...newFiles); state.nextPageToken = data.nextPageToken || null;
    applyFiltersAndSort();
    if (state.allFiles.length === 0) { showState('empty'); } else { showState('grid'); renderMediaGrid(); }
  } finally { state.loading = false; DOM.loadMoreSpinner.hidden = true; }
}

function navigateToBreadcrumb(folderId) {
  const idx = state.breadcrumb.findIndex(b => b.id === folderId);
  if (idx === -1) return;
  const entry = state.breadcrumb[idx];
  state.breadcrumb = state.breadcrumb.slice(0, idx + 1);
  state.allFiles = []; state.filteredFiles = []; state.nextPageToken = null;
  loadFolder(entry.id, entry.name);
}

// FILTERING & SORTING
function applyFiltersAndSort() {
  let r = [...state.allFiles];
  if (state.activeFilter !== 'all') r = r.filter(f => f.type === state.activeFilter);
  if (state.searchQuery) { const q = state.searchQuery.toLowerCase(); r = r.filter(f => f.name.toLowerCase().includes(q)); }
  r.sort((a, b) => {
    let va = a[state.sortKey] || '', vb = b[state.sortKey] || '';
    if (state.sortKey === 'size') { va = parseInt(va, 10) || 0; vb = parseInt(vb, 10) || 0; }
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  state.filteredFiles = r;
  const c = r.length;
  DOM.mediaCount.textContent = c > 0 ? (c + ' item' + (c !== 1 ? 's' : '')) : '';
}

// RENDERING
function showState(s) {
  DOM.stateAuth.hidden = s !== 'auth'; DOM.stateLoading.hidden = s !== 'loading';
  DOM.stateEmpty.hidden = s !== 'empty'; DOM.stateError.hidden = s !== 'error';
  DOM.mediaGridWrapper.hidden = s !== 'grid';
}

function renderSkeletons(count) {
  DOM.mediaGrid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const li = el('li', { className: 'media-card media-card--skeleton', 'aria-hidden': 'true' });
    li.innerHTML = '<div class="card-thumb skeleton skeleton-thumb"></div><div class="card-body"><div class="skeleton skeleton-line skeleton-line--long"></div><div class="skeleton skeleton-line skeleton-line--short"></div></div>';
    DOM.mediaGrid.appendChild(li);
  }
}

function renderMediaGrid() {
  const frag = document.createDocumentFragment();
  state.filteredFiles.forEach((file, idx) => frag.appendChild(buildMediaCard(file, idx)));
  DOM.mediaGrid.innerHTML = '';
  DOM.mediaGrid.appendChild(frag);
  DOM.mediaGrid.className = 'media-grid' + (state.viewMode === 'list' ? ' view-list' : '');
  if (state.nextPageToken) { DOM.loadMoreSentinel.hidden = false; setupScrollObserver(); }
  else { DOM.loadMoreSentinel.hidden = true; }
}

function buildMediaCard(file, idx) {
  const li = el('li', { className: 'media-card', 'data-type': file.type, 'data-id': file.id, 'data-index': idx, role: 'button', tabindex: '0', 'aria-label': (file.type === 'video' ? 'Video: ' : 'Image: ') + file.name });
  const thumb = el('div', { className: 'card-thumb' });
  if (file.thumbnail) {
    thumb.appendChild(el('img', { src: file.thumbnail, alt: '', loading: 'lazy', decoding: 'async' }));
  } else {
    thumb.innerHTML = '<svg style="position:absolute;inset:0;margin:auto;width:40px;height:40px;color:var(--color-text-muted)" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  }
  const play = el('div', { className: 'card-play', 'aria-hidden': 'true' });
  play.innerHTML = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="rgba(0,0,0,0.5)"/><path d="M19 16l14 8-14 8V16z" fill="white"/></svg>';
  thumb.appendChild(play);
  thumb.appendChild(el('span', { className: 'card-badge card-badge--' + file.type }, file.type.toUpperCase()));
  li.appendChild(thumb);
  const body = el('div', { className: 'card-body' });
  body.appendChild(el('p', { className: 'card-name', title: file.name }, file.name));
  const meta = el('p', { className: 'card-meta' });
  meta.innerHTML = '<span>' + (file.size ? formatBytes(file.size) : '--') + '</span><span class="card-meta-dot"></span><span>' + formatDate(file.modifiedTime) + '</span>';
  body.appendChild(meta);
  li.appendChild(body);
  const open = () => openLightboxAt(idx);
  li.addEventListener('click', open);
  li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return li;
}

function renderAccountList() {
  DOM.accountList.innerHTML = '';
  for (const [sub, a] of state.accounts) {
    const isActive = sub === state.activeAccountSub;
    const li = el('li', { className: 'account-pill', role: 'option', 'aria-selected': isActive ? 'true' : 'false', tabindex: '0' });
    const av = el('img', { className: 'account-avatar', src: a.picture || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(a.name) + '&background=6366f1&color=fff&size=64', alt: '' });
    const info = el('div', { className: 'account-info' });
    info.appendChild(el('span', { className: 'account-name' }, a.name));
    info.appendChild(el('span', { className: 'account-email' }, a.email));
    const rm = el('button', { className: 'account-remove', type: 'button', 'aria-label': 'Remove ' + a.email, tabindex: '-1' });
    rm.innerHTML = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    rm.addEventListener('click', e => { e.stopPropagation(); removeAccount(sub); });
    li.appendChild(av); li.appendChild(info); li.appendChild(rm);
    const activate = () => { if (!a.token || Date.now() > a.expiresAt) requestToken(a.email); else { setActiveAccount(sub); renderAccountList(); } };
    li.addEventListener('click', activate);
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    DOM.accountList.appendChild(li);
  }
}

function renderBreadcrumb() {
  DOM.breadcrumbList.innerHTML = '';
  state.breadcrumb.forEach((entry, idx) => {
    const li = el('li', { className: 'breadcrumb-item' });
    const isLast = idx === state.breadcrumb.length - 1;
    const link = el('a', { className: 'breadcrumb-link', href: '#', role: 'button', ...(isLast ? { 'aria-current': 'page' } : {}) }, entry.name);
    if (!isLast) link.addEventListener('click', e => { e.preventDefault(); navigateToBreadcrumb(entry.id); });
    li.appendChild(link); DOM.breadcrumbList.appendChild(li);
  });
}

async function renderFolderTree(folderId) {
  DOM.folderTree.innerHTML = '';
  const li = el('li', { className: 'folder-item', 'aria-busy': 'true' });
  li.innerHTML = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true" style="width:14px;height:14px"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 5h12" stroke="currentColor" stroke-width="1.2"/></svg><span style="color:var(--color-text-muted)">Loading...</span>';
  DOM.folderTree.appendChild(li);
  try {
    const folders = await listSubfolders(folderId);
    DOM.folderTree.innerHTML = '';
    if (folders.length === 0) { DOM.folderTree.appendChild(el('li', { className: 'folder-item', style: 'pointer-events:none;opacity:0.5' }, 'No subfolders')); return; }
    folders.forEach(f => {
      const fi = el('li', { className: 'folder-item', role: 'treeitem', tabindex: '0', 'aria-selected': f.id === state.currentFolderId ? 'true' : 'false' });
      fi.innerHTML = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true" style="width:14px;height:14px;flex-shrink:0"><path d="M1 4.5a1.5 1.5 0 011.5-1.5H5.5l1 1.5H11.5A1.5 1.5 0 0113 6v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 011 11V4.5z" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.1"/></svg>';
      fi.appendChild(document.createTextNode(f.name));
      const nav = () => { state.breadcrumb = [{ id: 'root', name: 'My Drive' }]; loadFolder(f.id, f.name); };
      fi.addEventListener('click', nav);
      fi.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(); } });
      DOM.folderTree.appendChild(fi);
    });
  } catch (e) { DOM.folderTree.innerHTML = ''; DOM.folderTree.appendChild(el('li', { className: 'folder-item', style: 'pointer-events:none' }, 'Could not load folders')); }
}

function renderQuota(q) {
  const used = parseInt(q.usage, 10) || 0, total = parseInt(q.limit, 10) || 0;
  if (!total) return;
  const pct = Math.min(100, Math.round(used / total * 100));
  DOM.quotaDisplay.innerHTML = '<div class="quota-label"><span>' + formatBytes(used) + ' used</span><span>' + pct + '%</span></div><div class="quota-bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><div class="quota-bar-fill" style="width:' + pct + '%"></div></div>';
}

// LIGHTBOX
let _preLightboxFocus = null;

async function openLightboxAt(idx) {
  if (idx < 0 || idx >= state.filteredFiles.length) return;
  _preLightboxFocus = document.activeElement;
  state.lightbox = { open: true, index: idx };
  const file = state.filteredFiles[idx];
  DOM.lightbox.hidden = false; DOM.lightbox.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  DOM.lightboxStage.innerHTML = '<div style="padding:48px;display:flex;align-items:center;justify-content:center"><div class="loader"><div class="loader-ring"></div></div></div>';
  DOM.lightboxFilename.textContent = file.name;
  DOM.lightboxDetails.textContent = file.type.toUpperCase() + ' - ' + formatBytes(file.size) + ' - ' + formatDate(file.modifiedTime);
  DOM.lightboxOpenDrive.href = file.driveUrl || '#';
  DOM.btnLightboxPrev.disabled = idx === 0;
  DOM.btnLightboxNext.disabled = idx === state.filteredFiles.length - 1;
  try {
    const blobUrl = await createMediaBlobUrl(file.id);
    if (file.type === 'video') {
      const v = el('video', { controls: '', playsinline: '', autoplay: '', 'aria-label': file.name });
      v.appendChild(el('source', { src: blobUrl, type: file.mime }));
      v.addEventListener('emptied', () => URL.revokeObjectURL(blobUrl), { once: true });
      DOM.lightboxStage.innerHTML = ''; DOM.lightboxStage.appendChild(v);
    } else {
      const img = el('img', { src: blobUrl, alt: file.name });
      img.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });
      DOM.lightboxStage.innerHTML = ''; DOM.lightboxStage.appendChild(img);
    }
    DOM.btnLightboxClose.focus();
  } catch (e) {
    DOM.lightboxStage.innerHTML = '<p style="padding:32px;color:var(--color-error)">Could not load media: ' + sanitiseText(e.message) + '</p>';
  }
}

function closeLightbox() {
  const v = DOM.lightboxStage.querySelector('video');
  if (v) { v.pause(); const s = v.querySelector('source')?.src; if (s?.startsWith('blob:')) URL.revokeObjectURL(s); }
  const img = DOM.lightboxStage.querySelector('img');
  if (img?.src?.startsWith('blob:')) URL.revokeObjectURL(img.src);
  DOM.lightboxStage.innerHTML = '';
  DOM.lightbox.hidden = true; DOM.lightbox.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  state.lightbox = { open: false, index: -1 };
  if (_preLightboxFocus) { _preLightboxFocus.focus(); _preLightboxFocus = null; }
}

// INFINITE SCROLL
function setupScrollObserver() {
  if (state.scrollObserver) state.scrollObserver.disconnect();
  state.scrollObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && state.nextPageToken && !state.loading) {
      DOM.loadMoreSpinner.hidden = false; fetchNextPage();
    }
  }, { rootMargin: '200px' });
  state.scrollObserver.observe(DOM.loadMoreSentinel);
}

// TOASTS
function showToast(msg, type = 'info') {
  const t = el('div', { className: 'toast toast--' + type });
  t.appendChild(el('span', { className: 'toast-dot', 'aria-hidden': 'true' }));
  t.appendChild(el('span', {}, sanitiseText(msg)));
  DOM.toastContainer.appendChild(t);
  const dismiss = () => { t.classList.add('toast--exit'); t.addEventListener('animationend', () => t.remove(), { once: true }); };
  setTimeout(dismiss, CONFIG.TOAST_DURATION_MS);
  t.addEventListener('click', dismiss);
}

// EVENT WIRING
function wireEvents() {
  DOM.btnAuthPrimary.addEventListener('click', () => requestToken());
  DOM.btnAddAccount.addEventListener('click', () => requestToken());
  DOM.btnSignOutAll.addEventListener('click', signOutAll);
  DOM.btnThemeToggle.addEventListener('click', () => ThemeManager.toggle());
  DOM.btnRetry.addEventListener('click', () => loadFolder(state.currentFolderId));

  const handleSearch = debounce(() => {
    state.searchQuery = DOM.searchInput.value.trim();
    DOM.btnSearchClear.hidden = !state.searchQuery;
    applyFiltersAndSort();
    if (state.allFiles.length > 0) { showState('grid'); renderMediaGrid(); }
  }, CONFIG.SEARCH_DEBOUNCE_MS);
  DOM.searchInput.addEventListener('input', handleSearch);
  DOM.btnSearchClear.addEventListener('click', () => {
    DOM.searchInput.value = ''; state.searchQuery = ''; DOM.btnSearchClear.hidden = true;
    applyFiltersAndSort();
    if (state.allFiles.length > 0) { showState('grid'); renderMediaGrid(); }
  });

  DOM.sortSelect.addEventListener('change', () => {
    const [k, d] = DOM.sortSelect.value.split(':'); state.sortKey = k; state.sortDir = d;
    applyFiltersAndSort();
    if (state.allFiles.length > 0) { showState('grid'); renderMediaGrid(); }
  });

  [DOM.btnGridView, DOM.btnListView].forEach(btn => btn.addEventListener('click', () => {
    state.viewMode = btn.dataset.view;
    DOM.btnGridView.classList.toggle('active', state.viewMode === 'grid');
    DOM.btnListView.classList.toggle('active', state.viewMode === 'list');
    DOM.btnGridView.setAttribute('aria-pressed', state.viewMode === 'grid' ? 'true' : 'false');
    DOM.btnListView.setAttribute('aria-pressed', state.viewMode === 'list' ? 'true' : 'false');
    if (state.filteredFiles.length > 0) renderMediaGrid();
  }));

  DOM.filterChips.forEach(chip => chip.addEventListener('click', () => {
    DOM.filterChips.forEach(c => { c.classList.remove('chip--active'); c.setAttribute('aria-pressed', 'false'); });
    chip.classList.add('chip--active'); chip.setAttribute('aria-pressed', 'true');
    state.activeFilter = chip.dataset.filter;
    applyFiltersAndSort();
    if (state.allFiles.length > 0) { showState(state.filteredFiles.length === 0 ? 'empty' : 'grid'); if (state.filteredFiles.length > 0) renderMediaGrid(); }
  }));

  DOM.btnLightboxClose.addEventListener('click', closeLightbox);
  DOM.lightboxBackdrop.addEventListener('click', closeLightbox);
  DOM.btnLightboxPrev.addEventListener('click', () => { if (state.lightbox.index > 0) openLightboxAt(state.lightbox.index - 1); });
  DOM.btnLightboxNext.addEventListener('click', () => { if (state.lightbox.index < state.filteredFiles.length - 1) openLightboxAt(state.lightbox.index + 1); });

  document.addEventListener('keydown', e => {
    if (!state.lightbox.open) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') DOM.btnLightboxPrev.click();
    if (e.key === 'ArrowRight') DOM.btnLightboxNext.click();
  });

  DOM.lightbox.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const foc = [...DOM.lightbox.querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')];
    if (!foc.length) return;
    if (e.shiftKey) { if (document.activeElement === foc[0]) { e.preventDefault(); foc[foc.length - 1].focus(); } }
    else { if (document.activeElement === foc[foc.length - 1]) { e.preventDefault(); foc[0].focus(); } }
  });
}


// ============================================================
// THEME MANAGER
// Implements: system preference detection, localStorage
// persistence, smooth icon animation, and tab-sync via
// the storage event. Theme preference is NOT a security
// secret -- localStorage is appropriate here (unlike tokens).
// ============================================================

/**
 * Reads, applies, persists, and toggles the UI colour theme.
 * @namespace ThemeManager
 */
const ThemeManager = (() => {
  const STORAGE_KEY = 'dv_theme';
  const ROOT = document.documentElement;

  /**
   * Returns the effective theme: reads localStorage first,
   * then falls back to the OS/browser colour-scheme preference.
   * @returns {'dark'|'light'}
   */
  function getPreferred() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  /**
   * Applies a theme to the document root and updates all
   * related UI affordances (button label, aria-label).
   * @param {'dark'|'light'} theme
   */
  function apply(theme) {
    ROOT.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    if (DOM.btnThemeToggle) {
      DOM.btnThemeToggle.setAttribute(
        'aria-label',
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
      );
      DOM.btnThemeToggle.title = theme === 'dark' ? 'Light mode' : 'Dark mode';
    }
  }

  /**
   * Toggles between dark and light, playing the icon spin animation.
   * Respects prefers-reduced-motion by checking the media query.
   */
  function toggle() {
    const current = ROOT.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';

    const btn = DOM.btnThemeToggle;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (btn && !reducedMotion) {
      btn.classList.add('is-animating');
      btn.addEventListener('animationend', () => btn.classList.remove('is-animating'), { once: true });
    }

    apply(next);
    showToast('Switched to ' + (next === 'dark' ? 'dark' : 'light') + ' theme', 'info');
  }

  /**
   * Initialises the ThemeManager.
   * Applies the correct theme on load and wires the storage event
   * so theme changes in other tabs are reflected immediately.
   */
  function init() {
    apply(getPreferred());

    // Sync theme if user changes it in another tab
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'dark' || e.newValue === 'light')) {
        apply(e.newValue);
      }
    });

    // React to OS theme change at runtime (e.g. auto dark mode at sunset)
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      // Only follow OS if user hasn't explicitly chosen a theme
      if (!localStorage.getItem(STORAGE_KEY)) {
        apply(e.matches ? 'light' : 'dark');
      }
    });
  }

  return { init, toggle, apply, getPreferred };
})();
// INIT
function init() {
  cacheDOM(); ThemeManager.init(); wireEvents(); showState('auth');
  restoreAccountMetaFromSession();
  if (state.accounts.size > 0) {
    renderAccountList(); DOM.btnSignOutAll.hidden = false;
    const first = state.accounts.get([...state.accounts.keys()][0]);
    showToast('Welcome back, ' + first.name + '. Please re-authenticate.', 'info');
  }
  let waited = 0;
  const poll = setInterval(() => {
    waited += 200;
    if (window.google?.accounts?.oauth2) { clearInterval(poll); initGIS(); }
    else if (waited > 10000) { clearInterval(poll); showState('error'); DOM.errorMessage.textContent = 'Google Identity Services could not be loaded. Check your network and CSP settings.'; }
  }, 200);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

