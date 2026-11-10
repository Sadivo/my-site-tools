(() => {
  'use strict';
  if (window.__gslLoaded) return;
  window.__gslLoaded = true;

  // First path segments on github.com that are never a user/org with repos.
  const RESERVED = new Set([
    'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories',
    'dashboard', 'enterprise', 'events', 'explore', 'features', 'gist', 'issues', 'join', 'login',
    'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls',
    'readme', 'resources', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'solutions',
    'sponsors', 'stars', 'team', 'topics', 'trending', 'users', 'watching'
  ]);
  const DEFAULTS = { showRepoSize: true, showFileSize: true, showDownload: true };
  const RETRY_AFTER_FAIL_MS = 60 * 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_DB = 'M1 3.5c0-.626.292-1.165.7-1.59.406-.422.956-.767 1.579-1.041C4.525.32 6.195 0 8 0c1.805 0 3.475.32 4.722.869.622.274 1.172.62 1.578 1.04.408.426.7.965.7 1.591v9c0 .626-.292 1.165-.7 1.59-.406.422-.956.767-1.579 1.041C11.476 15.68 9.806 16 8 16c-1.805 0-3.475-.32-4.721-.869-.623-.274-1.173-.62-1.579-1.04-.408-.426-.7-.965-.7-1.591Zm1.5 0c0 .133.058.318.282.551.227.237.591.483 1.101.707C4.898 5.205 6.353 5.5 8 5.5c1.646 0 3.101-.295 4.118-.742.508-.224.873-.471 1.1-.708.224-.232.282-.417.282-.55 0-.133-.058-.318-.282-.551-.227-.237-.591-.483-1.101-.707C11.102 1.795 9.647 1.5 8 1.5c-1.646 0-3.101.295-4.118.742-.508.224-.873.471-1.1.708-.224.232-.282.417-.282.55Zm0 4.5c0 .133.058.318.282.551.227.237.591.483 1.101.707C4.898 9.705 6.353 10 8 10c1.646 0 3.101-.295 4.118-.742.508-.224.873-.471 1.1-.708.224-.232.282-.417.282-.55V5.724c-.241.15-.503.286-.778.407C11.475 6.68 9.805 7 8 7c-1.805 0-3.475-.32-4.721-.869a6.15 6.15 0 0 1-.779-.407Zm0 2.225V12.5c0 .133.058.318.282.55.227.237.592.484 1.1.708 1.016.447 2.471.742 4.118.742 1.647 0 3.102-.295 4.117-.742.51-.224.874-.47 1.101-.707.224-.233.282-.418.282-.551v-2.275c-.241.15-.503.285-.778.406-1.247.549-2.917.869-4.722.869-1.805 0-3.475-.32-4.721-.869a6.327 6.327 0 0 1-.779-.406Z';
  const ICON_DL = 'M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z';

  let settings = { ...DEFAULTS };
  const failedUntil = new Map(); // request key -> timestamp
  const dirData = new Map(); // "owner/repo:rest" -> Map(name -> entry)
  const pending = new Set();
  const repoInfo = new Map(); // "owner/repo" -> GET_REPO result
  let noticeDismissed = false;

  // ---------- helpers ----------
  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) resolve({ ok: false, reason: 'ext', error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, reason: 'ext' });
        });
      } catch (e) {
        // Happens after the extension is reloaded while this tab stays open.
        resolve({ ok: false, reason: 'ext', error: String(e) });
      }
    });
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return i === 0 ? `${Math.round(n)} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function icon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'octicon');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
    return svg;
  }

  function parseRepo() {
    const [owner, repo] = location.pathname.split('/').filter(Boolean);
    if (!owner || !repo || RESERVED.has(owner.toLowerCase())) return null;
    return { owner, repo, key: `${owner}/${repo}` };
  }

  // Directory part of the URL: '' for the repo home, "<ref>/<path>" for /tree/... pages.
  function treeRest(r) {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return '';
    if (parts[2] === 'tree' && parts.length > 3) return parts.slice(3).join('/');
    return null;
  }

  function isFailed(key) {
    const t = failedUntil.get(key);
    return t && t > Date.now();
  }

  function markFailed(key, res) {
    const until = res && res.reason === 'rate-limit' && res.reset ? res.reset : Date.now() + RETRY_AFTER_FAIL_MS;
    failedUntil.set(key, until);
    if (res && (res.reason === 'rate-limit' || res.reason === 'auth')) showNotice(res);
  }

  // ---------- notice for rate limit / bad token ----------
  function showNotice(res) {
    if (noticeDismissed || document.getElementById('gsl-notice')) return;
    const box = document.createElement('div');
    box.id = 'gsl-notice';
    box.setAttribute('role', 'status');
    const text = document.createElement('span');
    if (res.reason === 'auth') {
      text.textContent = 'GitHub Size Lens：已儲存的 GitHub token 無效或已過期，請到設定頁更新。';
    } else {
      const when = res.reset ? `（約 ${new Date(res.reset).toLocaleTimeString()} 重置）` : '';
      text.textContent = `GitHub Size Lens：GitHub API 額度用完了${when}。設定 token 後每小時可用 5,000 次。`;
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-sm btn-primary';
    open.textContent = '開啟設定';
    open.addEventListener('click', () => send({ type: 'OPEN_OPTIONS' }));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-sm';
    close.textContent = '關閉';
    close.addEventListener('click', () => { noticeDismissed = true; box.remove(); });
    box.append(text, open, close);
    document.body.append(box);
  }

  // ---------- repo size ----------
  function findRepoSizeTarget(r) {
    const actions = document.querySelector('ul[data-testid="repo-header-actions"]');
    if (actions) return { kind: 'actions', el: actions };
    const crumb = document.querySelector('[data-testid="breadcrumbs-repo-link"]');
    if (crumb) return { kind: 'after', el: crumb };
    const want = `/${r.key}`.toLowerCase();
    const link = [...document.querySelectorAll('nav[aria-label="Breadcrumbs"] a[href]')]
      .find(a => a.getAttribute('href').toLowerCase() === want);
    return link ? { kind: 'after', el: link } : null;
  }

  function insertRepoSize(target, info, repoKey) {
    const label = formatBytes(info.size);
    const pill = document.createElement('span');
    pill.className = 'gsl-repo-size';
    pill.dataset.repo = repoKey;
    pill.title = `Repo 大小約 ${label}（GitHub API 回報的壓縮後 git 資料大小，僅供參考）`;
    pill.append(icon(ICON_DB), document.createTextNode(label));
    if (target.kind === 'actions') {
      const li = document.createElement('li');
      li.className = 'gsl-repo-size-li';
      li.dataset.repo = repoKey;
      li.append(pill);
      target.el.insertBefore(li, target.el.firstChild);
    } else {
      pill.classList.add('gsl-inline');
      target.el.after(pill);
    }
  }

  async function renderRepoSize() {
    const r = parseRepo();
    // Drop pills left over from another repo (SPA navigation).
    document.querySelectorAll('.gsl-repo-size, .gsl-repo-size-li').forEach(el => {
      if (!settings.showRepoSize || !r || el.dataset.repo !== r.key) el.remove();
    });
    if (!settings.showRepoSize || !r || document.querySelector('.gsl-repo-size')) return;
    if (!findRepoSizeTarget(r)) return;
    const reqKey = `repo:${r.key}`;
    if (pending.has(reqKey) || isFailed(reqKey)) return;

    let res = repoInfo.get(r.key);
    if (!res) {
      pending.add(reqKey);
      res = await send({ type: 'GET_REPO', owner: r.owner, repo: r.repo });
      pending.delete(reqKey);
      if (!res.ok) { markFailed(reqKey, res); return; }
      repoInfo.set(r.key, res);
    }

    const now = parseRepo();
    if (!now || now.key !== r.key || document.querySelector('.gsl-repo-size')) return;
    const target = findRepoSizeTarget(r);
    if (target) insertRepoSize(target, res, r.key);
  }

  // ---------- file sizes in the folder table ----------
  function rowLink(row) {
    return row.querySelector('a[href*="/blob/"][title], a[href*="/tree/"][title]') ||
           row.querySelector('a[href*="/blob/"], a[href*="/tree/"]');
  }

  function entryName(href) {
    const last = href.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(last); } catch (_) { return last; }
  }

  function ensureColumn(table) {
    const head = table.querySelector('thead tr');
    if (head && !head.querySelector('th.gsl-th')) {
      const th = document.createElement('th');
      th.className = 'gsl-th';
      const s = document.createElement('span');
      s.className = 'text-bold';
      s.textContent = 'Size';
      th.append(s);
      const last = head.querySelector('th:last-child');
      last ? head.insertBefore(th, last) : head.append(th);
    }
    // Rows that span the whole table ("..", "View all files") need one more column.
    table.querySelectorAll('tbody tr:not(.react-directory-row)').forEach(tr => {
      const td = tr.querySelector('td[colspan]');
      if (td && !td.dataset.gslSpan) {
        td.dataset.gslSpan = '1';
        td.setAttribute('colspan', String((parseInt(td.getAttribute('colspan'), 10) || 1) + 1));
      }
    });
  }

  function ensureCell(row) {
    let td = row.querySelector(':scope > td.gsl-td');
    if (!td) {
      td = document.createElement('td');
      td.className = 'gsl-td';
      const last = row.querySelector(':scope > td:last-child');
      last ? row.insertBefore(td, last) : row.append(td);
    }
    return td;
  }

  function setCell(td, forHref, build) {
    if (td.dataset.for === forHref && td.dataset.state === 'done') return;
    td.replaceChildren();
    build(td);
    td.dataset.for = forHref;
    td.dataset.state = 'done';
  }

  function fillRow(row, entries, fallbackText) {
    const td = ensureCell(row);
    const a = rowLink(row);
    if (!a) { setCell(td, '', () => {}); return; }
    const href = a.getAttribute('href');
    if (!entries) {
      if (td.dataset.for !== href || td.dataset.state !== fallbackText) {
        td.replaceChildren(document.createTextNode(fallbackText));
        td.dataset.for = href;
        td.dataset.state = fallbackText;
      }
      return;
    }
    const entry = entries.get(entryName(href));
    setCell(td, href, cell => {
      if (!entry || entry.type === 'dir' || entry.type === 'submodule') return;
      if (entry.type === 'symlink') {
        cell.append(document.createTextNode('symlink'));
        return;
      }
      if (settings.showFileSize) {
        const s = document.createElement('span');
        s.className = 'gsl-size';
        s.textContent = formatBytes(entry.size);
        s.title = `${entry.size.toLocaleString()} bytes`;
        cell.append(s);
      }
      if (settings.showDownload && href.includes('/blob/')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gsl-dl';
        btn.title = `下載 ${entry.name}`;
        btn.setAttribute('aria-label', `下載 ${entry.name}`);
        btn.append(icon(ICON_DL));
        btn.addEventListener('click', async ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const url = new URL(href.replace('/blob/', '/raw/'), location.origin).href;
          const res = await send({ type: 'DOWNLOAD', url, filename: entry.name });
          if (!res.ok) window.open(url, '_blank', 'noopener');
        });
        cell.append(btn);
      }
    });
  }

  async function renderFileSizes() {
    const table = document.querySelector('table[aria-labelledby="folders-and-files"]');
    const enabled = settings.showFileSize || settings.showDownload;
    if (!enabled) {
      document.querySelectorAll('.gsl-th, .gsl-td').forEach(el => el.remove());
      document.querySelectorAll('td[data-gsl-span]').forEach(td => {
        td.setAttribute('colspan', String(Math.max(1, (parseInt(td.getAttribute('colspan'), 10) || 2) - 1)));
        delete td.dataset.gslSpan;
      });
      return;
    }
    if (!table) return;
    const r = parseRepo();
    if (!r) return;
    const rest = treeRest(r);
    if (rest === null) return;

    ensureColumn(table);
    const rows = [...table.querySelectorAll('tbody tr.react-directory-row')];
    const dirKey = `${r.key}:${rest}`;
    const reqKey = `dir:${dirKey}`;
    const entries = dirData.get(dirKey);

    if (entries) { rows.forEach(row => fillRow(row, entries)); return; }
    if (isFailed(reqKey)) { rows.forEach(row => fillRow(row, null, '—')); return; }
    rows.forEach(row => fillRow(row, null, '…'));
    if (pending.has(reqKey)) return;

    pending.add(reqKey);
    const res = await send({ type: 'GET_DIR', owner: r.owner, repo: r.repo, rest });
    pending.delete(reqKey);
    if (res.ok) {
      dirData.set(dirKey, new Map(res.entries.map(e => [e.name, e])));
    } else {
      markFailed(reqKey, res);
    }
    schedule(); // re-render with the result (the page may have changed meanwhile)
  }

  // ---------- scheduling ----------
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      renderRepoSize();
      renderFileSizes();
    }, 150);
  }

  function resetAll() {
    document.querySelectorAll('.gsl-repo-size, .gsl-repo-size-li, .gsl-td').forEach(el => el.remove());
    dirData.clear();
    repoInfo.clear();
    failedUntil.clear();
    schedule();
  }

  chrome.storage.sync.get(DEFAULTS, stored => {
    settings = { ...DEFAULTS, ...stored };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const k of Object.keys(DEFAULTS)) if (k in changes) settings[k] = changes[k].newValue ?? DEFAULTS[k];
      resetAll();
    }
    if (area === 'local' && 'githubToken' in changes) {
      noticeDismissed = false;
      document.getElementById('gsl-notice')?.remove();
      resetAll();
    }
  });

})();
