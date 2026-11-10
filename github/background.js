'use strict';

// All GitHub API traffic happens here, so the token never reaches github.com pages.
const API = 'https://api.github.com';
const TOKEN_KEY = 'githubToken';
const CACHE_TTL_MS = 5 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_REF_SPLITS = 6;

const inflight = new Map();

async function getToken() {
  const value = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function ghFetch(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API + path, { headers, cache: 'no-store', credentials: 'omit' });
}

function errorFrom(res) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || null;
  if (res.status === 401) return { ok: false, status: 401, reason: 'auth' };
  if (res.status === 429 || (res.status === 403 && (remaining === '0' || res.headers.has('retry-after')))) {
    return { ok: false, status: res.status, reason: 'rate-limit', reset };
  }
  if (res.status === 404) return { ok: false, status: 404, reason: 'not-found' };
  return { ok: false, status: res.status, reason: 'other' };
}

// --- small cache in chrome.storage.session (survives service-worker restarts) ---
async function cacheGet(key) {
  try {
    const hit = (await chrome.storage.session.get(key))[key];
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  } catch (_) { /* ignore */ }
  return undefined;
}

async function cacheSet(key, value) {
  try {
    await chrome.storage.session.set({ [key]: { t: Date.now(), v: value } });
  } catch (_) {
    // Quota hit: drop the cache and move on.
    try { await chrome.storage.session.clear(); } catch (_) { /* ignore */ }
  }
}

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function validRepo(owner, repo) {
  return typeof owner === 'string' && typeof repo === 'string' && NAME_RE.test(owner) && NAME_RE.test(repo);
}

function encodePath(segments) {
  return segments.map(encodeURIComponent).join('/');
}

// --- handlers ---
async function getRepo(owner, repo) {
  if (!validRepo(owner, repo)) return { ok: false, reason: 'invalid' };
  const key = `repo:${owner}/${repo}`.toLowerCase();
  const cached = await cacheGet(key);
  if (cached) return cached;
  return dedupe(key, async () => {
    const res = await ghFetch(`/repos/${owner}/${repo}`);
    if (!res.ok) return errorFrom(res);
    const data = await res.json();
    if (typeof data.size !== 'number') return { ok: false, reason: 'other' };
    const out = { ok: true, size: data.size * 1024, private: !!data.private, defaultBranch: data.default_branch };
    await cacheSet(key, out);
    return out;
  });
}

function toEntries(list) {
  return list.map(e => ({ name: e.name, type: e.type, size: typeof e.size === 'number' ? e.size : null }));
}

// `rest` is everything after /tree/ in the URL: "<ref>/<path>". Branch names may contain
// slashes, so try ref splits from shortest to longest (most refs have no slash, so the
// first attempt usually wins). The last working split is remembered per repo.
async function getDir(owner, repo, rest) {
  if (!validRepo(owner, repo) || typeof rest !== 'string') return { ok: false, reason: 'invalid' };
  const segs = rest.split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  });
  const repoKey = `${owner}/${repo}`.toLowerCase();
  const key = `dir:${repoKey}:${segs.join('/')}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const attempts = [];
    if (segs.length === 0) {
      attempts.push({ ref: null, path: [] });
    } else {
      const hint = await cacheGet(`refhint:${repoKey}`);
      if (hint) {
        const h = hint.split('/');
        if (h.length <= segs.length && h.every((p, i) => p === segs[i])) {
          attempts.push({ ref: hint, path: segs.slice(h.length) });
        }
      }
      for (let i = 1; i <= Math.min(segs.length, MAX_REF_SPLITS); i++) {
        const ref = segs.slice(0, i).join('/');
        if (!attempts.some(a => a.ref === ref)) attempts.push({ ref, path: segs.slice(i) });
      }
    }

    let last = { ok: false, reason: 'not-found' };
    for (const a of attempts) {
      const qs = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : '';
      const res = await ghFetch(`/repos/${owner}/${repo}/contents/${encodePath(a.path)}${qs}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const out = { ok: true, entries: toEntries(data) };
          await cacheSet(key, out);
          if (a.ref) await cacheSet(`refhint:${repoKey}`, a.ref);
          return out;
        }
        continue; // resolved to a file, not a directory: try the next split
      }
      last = errorFrom(res);
      if (last.reason !== 'not-found') return last; // rate limit / auth: stop right away
    }
    return last;
  });
}

async function checkStatus() {
  const token = await getToken();
  const res = await ghFetch('/rate_limit'); // does not count against the limit
  if (!res.ok) return errorFrom(res);
  const core = (await res.json()).resources?.core;
  if (!core) return { ok: false, reason: 'other' };
  let login = null;
  if (token) {
    const u = await ghFetch('/user');
    if (u.ok) login = (await u.json()).login || null;
  }
  return { ok: true, authenticated: !!token, login, limit: core.limit, remaining: core.remaining, reset: core.reset * 1000 };
}

function safeFilename(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200);
  return !cleaned || /^\.+$/.test(cleaned) ? 'download' : cleaned;
}

async function download(url, filename) {
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, reason: 'invalid' }; }
  // Only GitHub's own /owner/repo/raw/... links; they use the browser's GitHub login for private repos.
  const parts = u.pathname.split('/');
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || parts[3] !== 'raw' || !validRepo(parts[1], parts[2])) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const id = await chrome.downloads.download({ url: u.href, filename: safeFilename(filename), conflictAction: 'uniquify' });
    return { ok: true, id };
  } catch (_) {
    // Chrome rejects some names (e.g. reserved on Windows); let it pick the name itself.
    const id = await chrome.downloads.download({ url: u.href, conflictAction: 'uniquify' });
    return { ok: true, id };
  }
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'GET_REPO': return getRepo(msg.owner, msg.repo);
    case 'GET_DIR': return getDir(msg.owner, msg.repo, msg.rest);
    case 'DOWNLOAD': return download(msg.url, msg.filename);
    case 'CHECK_STATUS': return checkStatus();
    case 'CLEAR_CACHE': await chrome.storage.session.clear(); return { ok: true };
    case 'OPEN_OPTIONS': await chrome.runtime.openOptionsPage(); return { ok: true };
    default: return { ok: false, reason: 'unknown' };
  }
}

// 和其他模組共用同一個 service worker：只接自己的訊息類型，其餘回 false 讓別的 listener 回覆。
// 若這裡對所有訊息都回 true，會搶先回 'unknown'，蝦皮的 proxyFetch 就拿不到結果。
const HANDLED_TYPES = new Set(['GET_REPO', 'GET_DIR', 'DOWNLOAD', 'CHECK_STATUS', 'CLEAR_CACHE', 'OPEN_OPTIONS']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !HANDLED_TYPES.has(msg && msg.type)) return false;
  handle(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, reason: 'other', error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// 工具列圖示歸蝦皮模組使用；設定頁從圖示右鍵的「選項」或額度提示的「開啟設定」進入。

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && TOKEN_KEY in changes) chrome.storage.session.clear().catch(() => {});
});

// Exported for unit tests under Node; ignored in the browser.
if (typeof module !== 'undefined') module.exports = { getRepo, getDir, checkStatus, download, safeFilename, errorFrom };
