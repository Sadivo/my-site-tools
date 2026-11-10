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
    case 'auth': return 'GitHub 不接受這組通行碼，可能貼錯了或已經過期，請重新申請一組。';
    case 'rate-limit': return '本小時的查詢次數用完了，請等一下再試，或設定通行碼。';
    case 'ext': return '擴充功能剛更新過，請重新整理這一頁再試。';
    default: return `查詢失敗${res && res.status ? `（HTTP ${res.status}）` : ''}${res && res.error ? `：${res.error}` : ''}`;
  }
}

async function refreshTokenState() {
  const saved = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  const has = typeof saved === 'string' && saved.trim() !== '';
  $('token').placeholder = has ? '已儲存通行碼。貼上新的會取代舊的。' : '貼上通行碼（github_pat_ 開頭）';
  return has;
}

async function check() {
  const btn = $('check');
  btn.disabled = true;
  setStatus('查詢中…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CHECK_STATUS' });
    if (res && res.ok) {
      const who = res.authenticated ? (res.login ? `已用 ${res.login} 的通行碼` : '已使用通行碼') : '沒有設定通行碼';
      const reset = new Date(res.reset).toLocaleTimeString();
      setStatus(`${who}：本小時還能查 ${res.remaining.toLocaleString()} 次（上限 ${res.limit.toLocaleString()} 次），${reset} 重新計算。`, 'ok');
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
  setStatus(has ? '已儲存通行碼。' : '還沒有設定通行碼（不設也能用）。');

  $('token-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const value = $('token').value.trim();
    if (!value) { setStatus('請先貼上通行碼。', 'err'); return; }
    if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]{20,}$/.test(value)) {
      setStatus('這看起來不像 GitHub 通行碼，應該是 github_pat_ 或 ghp_ 開頭的一長串文字。', 'err');
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
    setStatus('已刪除通行碼。', 'ok');
  });

  $('check').addEventListener('click', check);

  $('clear-cache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    setStatus('已清除暫存，重新整理 GitHub 頁面就會重新查詢。', 'ok');
  });
}

init().catch(e => setStatus(describeError({ reason: 'other', error: e.message }), 'err'));
