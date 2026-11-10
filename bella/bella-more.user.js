// ==UserScript==
// @name         Bella 更多最新文章
// @namespace    bella-more
// @version      1.0.0
// @description  在 bella.tw 首頁「Most Popular」區塊下方，列出最近幾天所有分類的新文章
// @match        https://www.bella.tw/
// @match        https://bella.tw/
// @match        https://www.bella.tw/?*
// @match        https://bella.tw/?*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// 同一份檔案同時是 Chrome/Firefox 擴充功能的 content script 與油猴腳本。

(() => {
  'use strict';
  if (location.pathname !== '/' || document.getElementById('bmx-root')) return;

  const ORIGIN = location.origin;
  const CHANNELS = ['fashion', 'accessories', 'beauty', 'lifestyle', 'people'];
  const MAX_PAGES = 20;          // 每個頻道最多翻幾頁，避免無限抓
  const CACHE_MIN = 10;          // 快取幾分鐘
  const DEFAULT_DAYS = 3;
  const MORE_DAYS = 3;           // 每按一次「載入更早」多幾天
  const REPUBLISH_GAP = 3000;    // 文章 id 比最新一篇小這麼多，視為重新發布的舊文

  const CATS = {
    skincare: '保養', makeup: '彩妝', hair: '髮型', perfumes: '香水', 'body&soul': '身心靈', other: '其他',
    news: '時尚新聞', trends: '流行趨勢', lookbook: '穿搭', designers: '設計師', shops: '店舖',
    handbags: '包款', shoes: '鞋款', jewelry: '珠寶', watches: '腕錶', eyewear: '眼鏡', accessories: '配件',
    celebrities: '名人', 'b-insider': 'B Insider',
    horoscope: '星座', music: '音樂', novelty: '新奇', sexuality: '兩性',
    'movies&culture': '影劇', 'design&gadget': '設計', 'travel&foodies': '旅遊美食',
  };
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const WEEK = '日一二三四五六';

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- 資料 ----------

  // 一律用台灣時間，避免電腦時區不同造成日期錯位
  const twFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const tw = ts => Object.fromEntries(twFmt.formatToParts(ts).map(p => [p.type, p.value]));
  const twDay = ts => { const p = tw(ts); return `${p.year}-${p.month}-${p.day}`; };
  const pad = n => String(n).padStart(2, '0');
  const ART_RE = /\/articles\/([^/]+)\/(\d+)/;

  function parseItem(li) {
    const link = li.querySelector('h2 a, .h4-to-div a') || li.querySelector('a.imgBox');
    const m = link && decodeURI(link.getAttribute('href') || '').replace(/&amp;/g, '&').match(ART_RE);
    if (!m) return null;
    const dm = [...li.querySelectorAll('.authorBtn li')].map(x => x.textContent.trim())
      .map(t => t.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/)).find(Boolean);
    if (!dm) return null;
    const img = li.querySelector('img');
    return {
      id: m[2],
      cat: m[1],
      url: link.href,
      title: (link.textContent || img?.alt || '').trim(),
      image: (img?.getAttribute('src') || '').replace(/([?&])h=\d+/, '$1h=240'),
      day: `${dm[3]}-${pad(MONTHS[dm[2]] + 1)}-${pad(dm[1])}`,
    };
  }

  async function getHTML(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // 頻道頁前 7 篇依時間排序，廣告之後的 3 篇是重複的熱門文章，不列入判斷
  async function fetchChannel(ch, cutoffDay, onProgress) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const doc = await getHTML(`${ORIGIN}/${ch}/all?page=${page}`);
      const ul = doc.getElementById('channel-articles-ul');
      if (!ul) break;
      const lis = [];
      for (const li of ul.children) {
        if (li.id === 'channel-ad-fix') break;
        if (li.classList.contains('index-sub-item')) lis.push(li);
      }
      const items = lis.map(parseItem).filter(Boolean);
      if (!items.length) break;
      out.push(...items);
      onProgress();
      const oldest = items.reduce((a, b) => (a.day < b.day ? a : b)).day;
      if (oldest < cutoffDay) break;
    }
    return out;
  }

  // feed/google 有最新約 20 篇的精確時間
  async function fetchFeedTimes() {
    try {
      const res = await fetch(`${ORIGIN}/feed/google`);
      const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
      const times = {};
      for (const item of xml.querySelectorAll('item')) {
        const id = item.querySelector('guid')?.textContent.trim();
        let pub = item.querySelector('pubDate')?.textContent.trim() || '';
        pub = pub.replace(/(\d{1,2} \w{3} )(\d{2}) /, '$120$2 '); // "16 Oct 26" -> "16 Oct 2026"
        const t = new Date(pub);
        if (id && !isNaN(t)) times[id] = t.getTime();
      }
      return times;
    } catch {
      return {};
    }
  }

  async function loadArticles(days, onProgress) {
    const cached = store.get('bmx-cache');
    if (cached && cached.days >= days && Date.now() - cached.ts < CACHE_MIN * 60e3) return cached.items;

    const cutoffDay = twDay(Date.now() - (days - 1) * 864e5);
    let done = 0;
    const tick = () => onProgress(++done);
    const [times, ...lists] = await Promise.all([
      fetchFeedTimes(),
      ...CHANNELS.map(ch => fetchChannel(ch, cutoffDay, tick).catch(e => { console.warn('[bella-more]', e); return []; })),
    ]);
    const byId = new Map();
    for (const it of lists.flat()) if (it.day >= cutoffDay && !byId.has(it.id)) byId.set(it.id, it);
    const items = [...byId.values()].map(it => ({ ...it, time: times[it.id] || null }));
    items.sort((a, b) => (b.day.localeCompare(a.day)) || ((b.time || 0) - (a.time || 0)) || (b.id - a.id));
    store.set('bmx-cache', { ts: Date.now(), days, items });
    return items;
  }

  // ---------- 畫面 ----------

  const CSS = `
  #bmx-root { margin-top: 10px; }
  #bmx-root .bmx-sub { color: #888; font-size: 13px; margin: -6px 0 14px; }
  #bmx-root .bmx-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
  #bmx-root .bmx-chip { border: 1px solid #ccc; background: #fff; color: #222; border-radius: 999px;
    padding: 3px 11px; font-size: 13px; cursor: pointer; line-height: 1.6; }
  #bmx-root .bmx-chip small { color: #999; margin-left: 3px; font-size: 11px; }
  #bmx-root .bmx-chip.on { background: #000; border-color: #000; color: #fff; }
  #bmx-root .bmx-chip.on small { color: #bbb; }
  #bmx-root .bmx-opt { font-size: 13px; color: #555; margin: 8px 0 0; display: flex; gap: 14px; flex-wrap: wrap; }
  #bmx-root .bmx-opt label { cursor: pointer; }
  #bmx-root .bmx-day { font-size: 16px; font-weight: 700; margin: 22px 0 10px; padding-bottom: 6px;
    border-bottom: 1px solid #ddd; letter-spacing: .03em; }
  #bmx-root .bmx-day span { font-weight: 400; color: #888; font-size: 13px; margin-left: 8px; }
  #bmx-root .bmx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px 18px;
    list-style: none; margin: 0; padding: 0; }
  #bmx-root .bmx-card { display: flex; gap: 12px; color: inherit; text-decoration: none; align-items: flex-start; }
  #bmx-root .bmx-card img { width: 120px; height: 80px; object-fit: cover; flex: none; background: #eee; }
  #bmx-root .bmx-meta { font-size: 12px; color: #888; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 3px; }
  #bmx-root .bmx-cat { color: #b0345a; font-weight: 600; }
  #bmx-root .bmx-new { background: #b0345a; color: #fff; font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 3px; }
  #bmx-root .bmx-re { border: 1px solid #ccc; padding: 0 4px; border-radius: 3px; font-size: 11px; }
  #bmx-root .bmx-title { font-size: 15px; line-height: 1.45; color: #111; }
  #bmx-root .bmx-card:hover .bmx-title { text-decoration: underline; }
  #bmx-root .bmx-card:visited .bmx-title { color: #888; }
  #bmx-root .bmx-more { display: block; margin: 24px auto 8px; padding: 10px 28px; border: 1px solid #000;
    background: #fff; color: #000; font-size: 14px; cursor: pointer; letter-spacing: .05em; }
  #bmx-root .bmx-more:hover { background: #000; color: #fff; }
  #bmx-root .bmx-more[disabled] { opacity: .5; cursor: default; background: #fff; color: #000; }
  #bmx-root .bmx-empty { color: #888; padding: 24px 0; text-align: center; }
  @media (max-width: 600px) {
    #bmx-root .bmx-grid { grid-template-columns: 1fr; }
    #bmx-root .bmx-card img { width: 96px; height: 68px; }
    #bmx-root .bmx-title { font-size: 14px; }
  }`;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mount() {
    const anchor = document.getElementById('mainListBoxSilde-popular1')?.closest('.isd_mainListContainer')
      || document.querySelector('.isd_mainListContainer');
    if (!anchor) { console.warn('[bella-more] 找不到首頁文章區塊'); return null; }
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'bmx-root';
    box.className = 'isd_style isd_mainContainer isd_mainListContainer';
    box.innerHTML = `<div class="mainContentBox">
      <div class="mainTitle">More Updates</div>
      <p class="bmx-sub" id="bmx-sub">載入中…</p>
      <div class="bmx-bar" id="bmx-chips"></div>
      <div class="bmx-opt">
        <label><input type="checkbox" id="bmx-onlynew"> 只看上次來之後的新文章（<span id="bmx-newcount">0</span>）</label>
        <label><input type="checkbox" id="bmx-hideshown"> 隱藏上方已顯示的文章</label>
      </div>
      <div id="bmx-list"></div>
      <button class="bmx-more" id="bmx-more" type="button">載入更早的文章</button>
    </div>`;
    anchor.after(box);
    return box;
  }

  const root = mount();
  if (!root) return;
  const $ = id => root.querySelector('#' + id);

  const shownAbove = new Set(
    [...document.querySelectorAll('#mainListBoxSilde-popular1 a, #mainListBoxSilde-popular2 a')]
      .map(a => (a.getAttribute('href') || '').match(ART_RE)?.[2]).filter(Boolean)
  );
  const prevSeen = store.get('bmx-seen');           // 上次來時看過的文章 id
  const firstVisit = !Array.isArray(prevSeen);
  const seenSet = new Set(prevSeen || []);
  const prefs = store.get('bmx-prefs') || {};

  let days = Math.max(DEFAULT_DAYS, store.get('bmx-cache')?.days || 0);
  let items = [];
  let activeCat = 'all';
  $('bmx-hideshown').checked = prefs.hideShown !== false;

  const isNew = it => !firstVisit && !seenSet.has(it.id);
  const label = cat => CATS[cat] || cat;

  function render() {
    const maxId = items.reduce((m, it) => Math.max(m, +it.id), 0);
    const hideShown = $('bmx-hideshown').checked;
    const onlyNew = $('bmx-onlynew').checked;
    const base = items.filter(it => !(hideShown && shownAbove.has(it.id)));

    const counts = new Map();
    for (const it of base) counts.set(it.cat, (counts.get(it.cat) || 0) + 1);
    if (activeCat !== 'all' && !counts.has(activeCat)) activeCat = 'all';
    $('bmx-chips').innerHTML = [['all', base.length], ...[...counts].sort((a, b) => b[1] - a[1])]
      .map(([c, n]) => `<button type="button" class="bmx-chip${c === activeCat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c === 'all' ? '全部' : label(c))}<small>${n}</small></button>`)
      .join('');

    $('bmx-newcount').textContent = base.filter(isNew).length;
    const list = base.filter(it => (activeCat === 'all' || it.cat === activeCat) && (!onlyNew || isNew(it)));
    if (!list.length) { $('bmx-list').innerHTML = '<p class="bmx-empty">沒有符合的文章</p>'; return; }

    const groups = new Map();
    for (const it of list) (groups.get(it.day) || groups.set(it.day, []).get(it.day)).push(it);
    $('bmx-list').innerHTML = [...groups].map(([day, arr]) => {
      const d = new Date(day + 'T00:00:00Z');
      return `<div class="bmx-day">${d.getUTCMonth() + 1}/${d.getUTCDate()} 週${WEEK[d.getUTCDay()]}<span>${arr.length} 篇</span></div>
        <ul class="bmx-grid">${arr.map(it => {
          const t = it.time ? tw(it.time) : null;
          const hhmm = t ? `${t.hour}:${t.minute}` : '';
          return `<li><a class="bmx-card" href="${esc(it.url)}">
            <img src="${esc(it.image)}" alt="" loading="lazy">
            <div>
              <div class="bmx-meta"><span class="bmx-cat">${esc(label(it.cat))}</span>${hhmm ? `<span>${hhmm}</span>` : ''}${+it.id < maxId - REPUBLISH_GAP ? '<span class="bmx-re" title="網站重新發布的舊文章">舊文更新</span>' : ''}${isNew(it) ? '<span class="bmx-new">NEW</span>' : ''}</div>
              <div class="bmx-title">${esc(it.title)}</div>
            </div></a></li>`;
        }).join('')}</ul>`;
    }).join('');
  }

  async function load() {
    const btn = $('bmx-more');
    btn.disabled = true;
    btn.textContent = '載入中…';
    try {
      items = await loadArticles(days, n => { $('bmx-sub').textContent = `載入中…（已讀取 ${n} 頁）`; });
      $('bmx-sub').textContent = `最近 ${days} 天，所有分類共 ${items.length} 篇`;
      // 記下這次看過的文章，下次來時沒看過的就標 NEW
      const all = new Set([...seenSet, ...items.map(it => it.id), ...shownAbove]);
      store.set('bmx-seen', [...all].slice(-3000));
      render();
    } catch (e) {
      console.error('[bella-more]', e);
      $('bmx-sub').textContent = '載入失敗，請重新整理頁面再試一次';
    }
    btn.disabled = false;
    btn.textContent = `載入更早的文章（再 ${MORE_DAYS} 天）`;
  }

  $('bmx-chips').addEventListener('click', e => {
    const b = e.target.closest('.bmx-chip');
    if (!b) return;
    activeCat = b.dataset.cat;
    render();
  });
  $('bmx-onlynew').addEventListener('change', render);
  $('bmx-hideshown').addEventListener('change', () => {
    store.set('bmx-prefs', { ...prefs, hideShown: $('bmx-hideshown').checked });
    render();
  });
  $('bmx-more').addEventListener('click', () => { days += MORE_DAYS; load(); });

  load();
})();
