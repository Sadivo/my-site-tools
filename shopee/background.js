/* ============================================================
   background.js — service worker
   ------------------------------------------------------------
   兩件事：
   1. 點工具列圖示，或蝦皮頁面上使用者選單的「按讚好物」
      → 開啟 viewer.html 分頁（已開就切過去）
   2. RISK-1 備案：viewer 直接 fetch 拿不到 Cookie 時，
      改由這裡用 chrome.scripting.executeScript 注入 shopee.tw
      分頁執行 fetch（同源，Cookie 必定帶上），再回傳結果。
   ============================================================ */

const VIEWER_URL = chrome.runtime.getURL('shopee/viewer.html');
const SHOPEE_MATCH = 'https://shopee.tw/*';
const SHOPEE_HOME = 'https://shopee.tw/';

// ---------- 1. 開啟 viewer ----------
// 工具列圖示與蝦皮頁面上的「按讚好物」選單（menu.js 送 'openViewer'）共用
async function openViewer() {
  const existing = await chrome.tabs.query({ url: VIEWER_URL });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: VIEWER_URL });
}

chrome.action.onClicked.addListener(() => openViewer());

// ---------- 2. 代理抓取 ----------

/** 注入到 shopee.tw 分頁執行。必須完全自足，不能引用外部變數。 */
function injectedFetch(url) {
  return fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
    .then(r => r.text())
    .then(t => {
      try {
        return { ok: true, json: JSON.parse(t) };
      } catch (e) {
        return { ok: false, error: 'API 未回傳 JSON（可能被導向登入頁）', body: t.slice(0, 300) };
      }
    })
    .catch(e => ({ ok: false, error: String(e && e.message ? e.message : e) }));
}

/** 找一個現成的 shopee.tw 分頁；沒有就開一個背景分頁，並標記為暫時的。 */
async function acquireShopeeTab() {
  const tabs = await chrome.tabs.query({ url: SHOPEE_MATCH });
  const ready = tabs.find(t => t.status === 'complete');
  if (ready) return { tabId: ready.id, temporary: false };

  const tab = await chrome.tabs.create({ url: SHOPEE_HOME, active: false });
  await waitForComplete(tab.id);
  return { tabId: tab.id, temporary: true };
}

function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('開啟蝦皮分頁逾時'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    // 有可能在掛上 listener 前就載完了
    chrome.tabs.get(tabId).then(t => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }).catch(reject);
  });
}

/**
 * 一次 session 內重複使用同一個暫時分頁，避免每翻一頁就開關一次。
 * viewer 抓完後會送 'releaseProxy' 來收掉。
 */
let proxyTab = null; // { tabId, temporary }

async function proxyFetch(url) {
  if (proxyTab) {
    // 確認分頁還在
    try {
      await chrome.tabs.get(proxyTab.tabId);
    } catch {
      proxyTab = null;
    }
  }
  if (!proxyTab) proxyTab = await acquireShopeeTab();

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: proxyTab.tabId },
    func: injectedFetch,
    args: [url],
    world: 'MAIN',
  });

  const r = result?.result;
  if (!r) throw new Error('注入執行沒有回傳結果');
  if (!r.ok) throw new Error(r.error || '注入抓取失敗');
  return r.json;
}

async function releaseProxy() {
  if (proxyTab?.temporary) {
    try {
      await chrome.tabs.remove(proxyTab.tabId);
    } catch { /* 使用者可能已手動關掉 */ }
  }
  proxyTab = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'openViewer') {
    openViewer()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === 'proxyFetch') {
    proxyFetch(msg.url)
      .then(json => sendResponse({ ok: true, json }))
      .catch(err => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // 非同步回覆
  }
  if (msg?.type === 'releaseProxy') {
    releaseProxy().finally(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
