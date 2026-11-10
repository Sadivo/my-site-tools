/* ============================================================
   viewer.js — 抓取 + 渲染 + 互動
   ============================================================ */

import {
  API_ORIGIN,
  LikesError,
  buildUrl,
  parsePage,
  fetchAllLikedItems,
  toTSV,
  toCSV,
} from './api.js';

const $ = id => document.getElementById(id);

const el = {
  count: $('count'),
  q: $('q'),
  sort: $('sort'),
  hideDead: $('hideDead'),
  copy: $('copy'),
  csv: $('csv'),
  refresh: $('refresh'),
  state: $('state'),
  stateIcon: $('stateIcon'),
  stateTitle: $('stateTitle'),
  stateDesc: $('stateDesc'),
  stateActions: $('stateActions'),
  skeleton: $('skeleton'),
  grid: $('grid'),
};

let all = [];       // 正規化後的完整清單
let visible = [];   // 目前畫面上的清單（給匯出用）
let loading = false;

/* ============================================================
   RISK-1：Cookie 能不能帶上
   ------------------------------------------------------------
   先試從擴充頁面直接 fetch（credentials: 'include'）。
   若因 SameSite 拿不到登入身分，自動退回由 background 注入
   shopee.tw 分頁代理抓取（同源，Cookie 必定帶上）。
   ============================================================ */

let transport = null;    // 'direct' | 'proxy'
let probeError = null;   // 探測階段診斷出的 LikesError，用來蓋過代理路徑的泛用錯誤

async function directFetchJson(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new LikesError('shape', `HTTP ${res.status}：蝦皮 API 可能已改版`, res.status);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LikesError('shape', 'API 未回傳 JSON（可能被導向登入頁）', text.slice(0, 300));
  }
}

async function proxyFetchJson(url) {
  const resp = await chrome.runtime.sendMessage({ type: 'proxyFetch', url });
  if (!resp?.ok) {
    throw new LikesError('network', resp?.error || '透過蝦皮分頁抓取失敗');
  }
  return resp.json;
}

/**
 * 決定用哪條路徑。回傳 fetchJson 函式。
 * 探測用的第一頁會被快取起來給 fetchAllLikedItems 重用，不多打一次 API。
 */
async function pickTransport() {
  const base = transport === 'proxy' ? proxyFetchJson
    : transport === 'direct' ? directFetchJson
    : null;
  if (base) return base;

  // 最小驗證：打第一頁看看直接 fetch 帶不帶得上登入 Cookie
  const probeUrl = buildUrl(0);
  probeError = null;
  try {
    const json = await directFetchJson(probeUrl);
    if (!json.error && Array.isArray(json.data?.items)) {
      transport = 'direct';
      return withPrimed(directFetchJson, probeUrl, json);
    }
    // 拿得到回應但內容有問題 —— 記下診斷結果。
    // 這裡分不出「真的沒登入」和「Cookie 因 SameSite 沒被帶上」，
    // 所以仍要走代理路徑再確認一次；但先把判斷留著。
    probeError = classify(json);
  } catch (err) {
    if (err instanceof LikesError) probeError = err;
  }

  transport = 'proxy';
  console.info('[按讚好物] 直接 fetch 拿不到登入身分，改用 shopee.tw 分頁代理抓取。', probeError ?? '');
  return proxyFetchJson;
}

/** 把一份「有 error 欄位」的回應轉成 LikesError（與 api.js parsePage 同一套規則）。 */
function classify(json) {
  try {
    parsePage(json);
  } catch (e) {
    return e;
  }
  return null;
}

/** 第一次遇到 url 時直接回快取結果，之後照常打網路。 */
function withPrimed(fn, url, json) {
  let used = false;
  return async u => {
    if (!used && u === url) {
      used = true;
      return json;
    }
    return fn(u);
  };
}

/* ============================================================
   狀態畫面（§7）
   ============================================================ */

function showState(icon, title, desc, actions = []) {
  el.grid.hidden = true;
  el.skeleton.hidden = true;
  el.state.hidden = false;
  el.stateIcon.textContent = icon;
  el.stateTitle.textContent = title;
  el.stateDesc.textContent = desc;
  el.stateActions.replaceChildren(
    ...actions.map(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.ghost) b.className = 'ghost';
      b.addEventListener('click', a.onClick);
      return b;
    })
  );
}

function showSkeleton(n = 18) {
  el.state.hidden = true;
  el.grid.hidden = true;
  el.skeleton.hidden = false;
  el.skeleton.replaceChildren(
    ...Array.from({ length: n }, () => {
      const d = document.createElement('div');
      d.className = 'sk';
      d.innerHTML =
        '<div class="sk-img"></div><div class="sk-line"></div>' +
        '<div class="sk-line"></div><div class="sk-line short"></div>';
      return d;
    })
  );
}

function showGrid() {
  el.state.hidden = true;
  el.skeleton.hidden = true;
  el.grid.hidden = false;
}

function setControlsEnabled(on) {
  for (const c of [el.q, el.sort, el.hideDead, el.copy, el.csv]) c.disabled = !on;
  el.refresh.disabled = loading;
}

function openShopeeLogin() {
  chrome.tabs.create({ url: `${API_ORIGIN}/buyer/login` });
}

/* ============================================================
   載入
   ============================================================ */

async function load() {
  if (loading) return;
  loading = true;
  setControlsEnabled(false);
  el.refresh.disabled = true;
  el.count.textContent = '載入中…';
  showSkeleton();

  try {
    const fetchJson = await pickTransport();
    all = await fetchAllLikedItems({
      fetchJson,
      onProgress: (n, pages) => {
        el.count.textContent = `載入中… 已取得 ${n} 件（第 ${pages} 頁）`;
      },
    });

    if (!all.length) {
      el.count.textContent = '0 件';
      showState(
        '🫙',
        '按讚好物是空的',
        '這個帳號目前沒有按讚過的商品。\n如果你確定按過，請確認瀏覽器登入的是同一個帳號。',
        [{ label: '重新整理', onClick: load }]
      );
      return;
    }

    setControlsEnabled(true);
    render();
  } catch (err) {
    handleError(err);
  } finally {
    loading = false;
    el.refresh.disabled = false;
    // 用完就把暫時開的蝦皮分頁收掉
    if (transport === 'proxy') {
      chrome.runtime.sendMessage({ type: 'releaseProxy' }).catch(() => {});
    }
  }
}

function handleError(err) {
  console.error('[按讚好物]', err);
  el.count.textContent = '載入失敗';

  // 代理路徑本身失敗（例如開不了蝦皮分頁）會是泛用的 network 錯誤，
  // 這時探測階段的診斷比較有參考價值，優先顯示它（§7 不能讓使用者以為只是「沒按過讚」）。
  const kindOf = e => (e instanceof LikesError ? e.kind : 'network');
  if (kindOf(err) === 'network' && probeError && kindOf(probeError) !== 'network') {
    console.info('[按讚好物] 代理路徑失敗，改用探測階段的診斷：', probeError);
    err = probeError;
  }
  const kind = kindOf(err);

  if (kind === 'auth') {
    showState(
      '🔒',
      '請先登入蝦皮',
      '這個功能需要讀取你在蝦皮的按讚清單，請先在瀏覽器登入蝦皮帳號，再回到這裡重新整理。',
      [
        { label: '前往登入蝦皮', onClick: openShopeeLogin },
        { label: '我已登入，重試', ghost: true, onClick: load },
      ]
    );
    return;
  }

  if (kind === 'shape') {
    showState(
      '🧩',
      '蝦皮 API 可能已改版',
      `拿得到回應，但格式跟預期不同 —— 這通常代表蝦皮改了介面，而不是你沒按過讚。\n` +
        `請按 F12 開啟 Console 查看詳細診斷訊息。\n\n${err.message}`,
      [{ label: '重試', onClick: load }]
    );
    return;
  }

  showState(
    '📡',
    '連線失敗',
    `無法連上蝦皮，請確認網路狀態後重試。\n\n${err.message ?? err}`,
    [{ label: '重試', onClick: load }]
  );
}

/* ============================================================
   渲染
   ============================================================ */

const money = n => '$' + Number(n).toLocaleString('zh-TW');

const COMPARATORS = {
  pa: (a, b) => a.priceMin - b.priceMin,
  pd: (a, b) => b.priceMin - a.priceMin,
  r: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  s: (a, b) => b.sold - a.sold,
};

function render() {
  const q = el.q.value.trim().toLowerCase();
  const hideDead = el.hideDead.checked;

  let list = all;
  if (hideDead) list = list.filter(i => !i.isDead);
  if (q) list = list.filter(i => (i.name + ' ' + i.shopName).toLowerCase().includes(q));

  const cmp = COMPARATORS[el.sort.value];
  if (cmp) list = [...list].sort(cmp);

  visible = list;
  el.count.textContent = `${list.length} / ${all.length} 件`;

  if (!list.length) {
    showState('🔍', '沒有符合的商品', '換個關鍵字，或取消「隱藏已下架」試試。', [
      {
        label: '清除篩選',
        onClick: () => {
          el.q.value = '';
          el.hideDead.checked = false;
          render();
        },
      },
    ]);
    return;
  }

  showGrid();
  el.grid.replaceChildren(...list.map(buildCard));
}

function buildCard(i) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = i.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const imgwrap = document.createElement('div');
  imgwrap.className = 'imgwrap';

  const img = document.createElement('img');
  img.setAttribute('loading', 'lazy'); // §6 圖片延遲載入
  img.src = i.image;
  img.alt = '';
  imgwrap.append(img);

  if (i.isDead) {
    const d = document.createElement('div');
    d.className = 'dead';
    d.textContent = '已下架 / 售完';
    imgwrap.append(d);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const name = document.createElement('div');
  name.className = 'name';
  if (i.isOfficial) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '商城';
    name.append(tag);
  }
  name.append(document.createTextNode(i.name));

  const price = document.createElement('div');
  price.className = 'price';
  price.textContent = i.priceMax > i.priceMin
    ? `${money(i.priceMin)} - ${money(i.priceMax)}`
    : money(i.priceMin);

  const shop = document.createElement('div');
  shop.className = 'shop';
  shop.textContent = i.shopName;
  shop.title = i.shopName;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const rating = document.createElement('span');
  rating.textContent = i.rating ? `★ ${i.rating.toFixed(1)} (${i.cmtCount})` : '無評分';
  const sold = document.createElement('span');
  sold.textContent = `已售 ${i.sold.toLocaleString('zh-TW')}`;
  meta.append(rating, sold);

  body.append(name, price, shop, meta);
  a.append(imgwrap, body);
  return a;
}

/* ============================================================
   匯出（FR-9）
   ============================================================ */

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 2000);
}

async function copyTSV() {
  const tsv = toTSV(visible.length ? visible : all);
  try {
    await navigator.clipboard.writeText(tsv);
    flash(el.copy, '已複製 ✓');
  } catch {
    console.log(tsv);
    flash(el.copy, '已印在 Console');
  }
}

function downloadCSV() {
  const list = visible.length ? visible : all;
  // 加 BOM，Excel 才不會把中文變亂碼
  const blob = new Blob(['﻿' + toCSV(list)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `蝦皮按讚好物_${stamp}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(el.csv, '已下載 ✓');
}

/* ============================================================
   綁定
   ============================================================ */

el.q.addEventListener('input', render);
el.sort.addEventListener('change', render);
el.hideDead.addEventListener('change', render);
el.copy.addEventListener('click', copyTSV);
el.csv.addEventListener('click', downloadCSV);
el.refresh.addEventListener('click', () => {
  transport = null;  // 重新探測一次路徑
  probeError = null;
  load();
});

load();
