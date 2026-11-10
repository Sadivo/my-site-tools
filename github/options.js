'use strict';

const DEFAULTS = { showRepoSize: true, showFileSize: true, showDownload: true };
const TOKEN_KEY = 'githubToken';
const $ = id => document.getElementById(id);
const statusEl = $('status');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function describeError(res) {
  switch (res && res.reason) {
    case 'auth': return 'GitHub 拒絕了這個 token（無效或已過期）。';
    case 'rate-limit': return 'API 額度已用完，請稍後再試或設定 token。';
    case 'ext': return '擴充功能內部連線失敗，請重新整理此頁。';
    default: return `檢查失敗${res && res.status ? `（HTTP ${res.status}）` : ''}${res && res.error ? `：${res.error}` : ''}`;
  }
}

async function refreshTokenState() {
  const saved = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  const has = typeof saved === 'string' && saved.trim() !== '';
  $('token').placeholder = has ? '已儲存 token。輸入新的 token 會取代舊的。' : 'github_pat_… 或 ghp_…';
  return has;
}

async function check() {
  const btn = $('check');
  btn.disabled = true;
  setStatus('檢查中…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CHECK_STATUS' });
    if (res && res.ok) {
      const who = res.authenticated ? (res.login ? `已驗證為 ${res.login}` : '已使用 token') : '未設定 token（匿名）';
      const reset = new Date(res.reset).toLocaleTimeString();
      setStatus(`${who}：本小時剩 ${res.remaining.toLocaleString()} / ${res.limit.toLocaleString()} 次，${reset} 重置。`, 'ok');
    } else {
      setStatus(describeError(res), 'err');
    }
  } catch (e) {
    setStatus(describeError({ reason: 'other', error: e.message }), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const box = $(key);
    box.checked = !!s[key];
    box.addEventListener('change', () => chrome.storage.sync.set({ [key]: box.checked }));
  }

  const has = await refreshTokenState();
  setStatus(has ? '已儲存 token。' : '尚未設定 token。');

  $('token-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const value = $('token').value.trim();
    if (!value) { setStatus('請先貼上 token。', 'err'); return; }
    if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]{20,}$/.test(value)) {
      setStatus('這看起來不像 GitHub token（應以 github_pat_ 或 ghp_ 開頭）。', 'err');
      return;
    }
    await chrome.storage.local.set({ [TOKEN_KEY]: value });
    $('token').value = '';
    await refreshTokenState();
    await check();
  });

  $('clear').addEventListener('click', async () => {
    await chrome.storage.local.remove(TOKEN_KEY);
    $('token').value = '';
    await refreshTokenState();
    setStatus('已清除 token。', 'ok');
  });

  $('check').addEventListener('click', check);

  $('clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    setStatus('已清除快取。', 'ok');
  });
}

init().catch(e => setStatus(describeError({ reason: 'other', error: e.message }), 'err'));
