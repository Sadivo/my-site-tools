// Harper's BAZAAR 台灣 文章日期顯示 - content script
// 在列表卡片（a[data-theme-key="custom-item"]）的標題下方加上發布日期。
// 日期來源依序為：
//   1. 頁面內嵌的 #__NEXT_DATA__（每篇的 display_id 對應 publish_from，零請求）
//   2. 站內換頁後 __NEXT_DATA__ 會過期，改抓目前網址的 HTML 重讀一次
//   3. 仍找不到的（例如文章頁下方的推薦卡片）逐篇抓文章頁，只讀到 <head> 的 meta 就中斷
// 網站本身文章頁顯示的「Published」就是 publish_from，對應 meta article:modified_time
// （article:published_time 是最初建立時間，舊文改版重推時會差很多）。
//
// 另外首頁的 LATEST 區塊只有 12 篇，這裡把各頻道首頁 __NEXT_DATA__ 裡的文章合併、
// 依 publish_from 排序接在原本的格子下方，整個區塊並移到封面故事下面（見「首頁 LATEST 加長」）。
// 網站自己的 /tw/api/feed-content 分頁 API 對首頁與頻道頁都回 500，所以不用它。

(function () {
  const root = document.documentElement;
  if (root.dataset.myToolsBazaar) return;
  root.dataset.myToolsBazaar = '1';

  const CARD_SEL = 'a[data-theme-key="custom-item"]';
  const ID_RE = /\/tw\/(?:[^/?#]+\/)*[ag](\d{5,})\//;
  const CACHE_KEY = 'my-tools-bazaar-dates';
  const CACHE_MAX = 3000;
  const CONCURRENCY = 4;

  const dates = new Map(loadCache()); // display_id -> ISO 字串
  const failed = new Set();           // 抓過但拿不到日期的，不重試
  const queued = new Set();
  const harvestedUrls = new Set([location.href]);

  harvest(parseJSON(document.getElementById('__NEXT_DATA__')?.textContent));

  // ---------- 資料來源 ----------

  function parseJSON(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // 頁面約 500KB，直接切字串比 DOMParser 整頁解析省
  function nextDataFromHtml(html) {
    const start = html.indexOf('<script id="__NEXT_DATA__"');
    if (start < 0) return null;
    const from = html.indexOf('>', start) + 1;
    return parseJSON(html.slice(from, html.indexOf('</script>', from)));
  }

  async function fetchNextData(url) {
    const res = await fetch(new URL(url, location.href));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return nextDataFromHtml(await res.text());
  }

  // 走訪 __NEXT_DATA__，對每個帶 display_id + publish_from 的文章物件呼叫 fn
  function eachResource(data, fn) {
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.display_id && typeof o.publish_from === 'string') fn(o);
      for (const k in o) walk(o[k]);
    })(data);
  }

  function harvest(data) {
    let added = false;
    eachResource(data, (r) => {
      const id = String(r.display_id);
      if (dates.get(id) !== r.publish_from) { dates.set(id, r.publish_from); added = true; }
    });
    if (added) saveCache();
  }

  async function harvestCurrentPage() {
    const url = location.href;
    if (harvestedUrls.has(url)) return;
    harvestedUrls.add(url);
    try {
      harvest(await fetchNextData(url));
    } catch { /* 交給逐篇抓 */ }
  }

  // 串流讀文章頁，拿到要的 meta（found 回傳非空）就 cancel，不用下載整頁（一頁約 500KB）
  async function readHead(url, found) {
    const res = await fetch(new URL(url, location.href));
    if (!res.ok || !res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (found(buf) || buf.includes('</head>') || buf.length > 400000) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return buf;
  }

  async function fetchArticleDate(url) {
    const head = await readHead(url, (buf) => metaProp(buf, 'article:modified_time'));
    return metaProp(head, 'article:modified_time') || metaProp(head, 'article:published_time');
  }

  function metaProp(html, prop) {
    const tag = html.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*>`));
    return tag?.[0].match(/content="([^"]+)"/)?.[1].replace(/&amp;/g, '&') || null;
  }

  // ---------- 畫面 ----------

  function cardId(a) {
    return a.getAttribute('href')?.match(ID_RE)?.[1] || null;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  function render(a, id) {
    const text = formatDate(dates.get(id));
    if (!text) return;
    let el = a.querySelector(':scope .bz-date');
    if (el && el.dataset.id === id) return;
    if (!el) {
      el = document.createElement('span');
      el.className = 'bz-date';
      el.style.cssText = [
        'display: block',
        'font-size: 0.75rem',
        'line-height: 1.4',
        'color: #888',
        'margin-top: 4px',
        'letter-spacing: 0.05em',
      ].join(';');
      const content = a.querySelector('[data-theme-key="custom-item-content"]') || a;
      content.appendChild(el);
    }
    el.dataset.id = id;
    el.textContent = text;
  }

  function scan() {
    ensureLatest();
    const missing = [];
    for (const a of document.querySelectorAll(CARD_SEL)) {
      const id = cardId(a);
      if (!id) continue;
      if (dates.has(id)) render(a, id);
      else if (!failed.has(id) && !queued.has(id)) missing.push([id, a.href]);
    }
    if (missing.length) resolve(missing);
  }

  async function resolve(missing) {
    for (const [id] of missing) queued.add(id);

    await harvestCurrentPage();
    const rest = missing.filter(([id]) => !dates.has(id));

    let i = 0;
    const worker = async () => {
      while (i < rest.length) {
        const [id, url] = rest[i++];
        try {
          const iso = await fetchArticleDate(url);
          if (iso) dates.set(id, iso);
          else failed.add(id);
        } catch {
          failed.add(id);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    for (const [id] of missing) queued.delete(id);
    saveCache();
    scan();
  }

  // ---------- 首頁 LATEST 加長 ----------
  // 各頻道首頁的區塊合起來，近 7 天的文章約 100 篇，和 Google News sitemap 比對過沒有漏掉新文。
  // starsigns（每日星座運勢，publish_from 還會是未來時間）與 special-topic（策展舊文）不抓。

  const LATEST_SECTIONS = ['fashion', 'beauty', 'celebrity', 'life', 'culture', 'luxury'];
  const LATEST_KEY = 'my-tools-bazaar-latest';
  const LATEST_TTL = 10 * 60 * 1000;
  const LATEST_DAYS = 7;
  const LATEST_STEP = 12;

  let latestPool = null; // Promise<item[]>，同一頁只抓一次
  let latestShown = LATEST_STEP * 2; // 原本 12 篇之外先多顯示 24 篇，按鈕每次再加 12

  function toLatestItem(r) {
    const section = r.section?.slug;
    if (!r.slug || !section || section === 'starsigns' || section === 'special-topic') return null;
    // 網址規則：Listicle → g、其他（Standard / Long Form Article）→ a，路徑是 section/subsection
    const prefix = /listicle|gallery/i.test(r.display_type?.title || '') ? 'g' : 'a';
    const path = [section, r.subsection?.slug].filter(Boolean).join('/');
    const img = r.media?.find((m) => m.role === 12 && m.hips_url) || r.media?.find((m) => m.hips_url);
    const crop = img?.metadata?.crops?.['1x1'];
    const title = document.createElement('template');
    title.innerHTML = r.metadata?.short_title || r.metadata?.index_title || r.title || '';
    return {
      id: String(r.display_id),
      url: `/tw/${path}/${prefix}${r.display_id}/${r.slug}/`,
      title: title.content.textContent.trim(),
      img: img ? `${img.hips_url}?${crop ? `crop=${crop}&` : ''}resize=360:*` : '',
      date: r.publish_from,
    };
  }

  function loadLatestPool() {
    latestPool ||= (async () => {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(LATEST_KEY)); } catch { /* 無快取 */ }
      let items = cached && Date.now() - cached.at < LATEST_TTL ? cached.items : null;

      if (!items) {
        const pages = await Promise.allSettled(LATEST_SECTIONS.map((s) => fetchNextData(`/tw/${s}/`)));
        const byId = new Map();
        for (const p of pages) {
          if (p.status !== 'fulfilled') continue;
          harvest(p.value);
          eachResource(p.value, (r) => {
            const it = toLatestItem(r);
            // 同一篇可能出現在多個區塊，純文字區塊的 media 是空的，留有圖的那份
            if (it && (!byId.get(it.id)?.img || it.img)) byId.set(it.id, it);
          });
        }
        const now = Date.now();
        const since = now - LATEST_DAYS * 864e5;
        items = [...byId.values()]
          .filter((it) => { const t = Date.parse(it.date); return t > since && t <= now; })
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        if (items.length) {
          try { localStorage.setItem(LATEST_KEY, JSON.stringify({ at: now, items })); } catch { /* 略過 */ }
        }
      }

      for (const it of items) if (!dates.has(it.id)) dates.set(it.id, it.date);
      if (!items.length) latestPool = null; // 全部失敗就讓下次重試
      return items;
    })();
    return latestPool;
  }

  // 網站原本的 LATEST 區塊（不含我們複製出來的那個）
  function findLatestSection() {
    for (const h of document.querySelectorAll('[data-theme-key="block-heading"]')) {
      if (h.textContent.trim().toUpperCase() !== 'LATEST') continue;
      const section = h.closest('section');
      if (section && !section.classList.contains('bz-latest-section') && section.querySelector(CARD_SEL)) return section;
    }
    return null;
  }

  // 拿掉 data-vars-*，免得點擊被 GA 記成原本那篇
  function stripTracking(root) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const { name } of [...el.attributes]) if (name.startsWith('data-vars-')) el.removeAttribute(name);
    }
  }

  // 複製原本的卡片沿用網站樣式
  function makeLatestCard(template, it) {
    const a = template.cloneNode(true);
    stripTracking(a);
    a.querySelector('.bz-date')?.remove();
    a.querySelectorAll('picture source').forEach((s) => s.remove());
    a.setAttribute('href', it.url);
    const img = a.querySelector('img');
    if (img) {
      img.removeAttribute('srcset');
      img.removeAttribute('src');
      img.alt = it.title;
      img.title = it.title;
      if (it.img) img.src = it.img;
      else fillOgImage(img, it); // 只出現在純文字區塊的文章，到文章頁 <head> 拿 og:image
    }
    const text = a.querySelector('[data-theme-key="custom-item-title-text"]');
    if (text) text.textContent = it.title;
    return a;
  }

  async function fillOgImage(img, it) {
    try {
      const head = await readHead(it.url, (buf) => metaProp(buf, 'og:image'));
      const og = metaProp(head, 'og:image');
      if (!og) return;
      img.style.aspectRatio = '1 / 1'; // og:image 是橫幅裁切，其他卡片是 1x1
      img.style.objectFit = 'cover';
      img.src = og.replace(/resize=\d+:\*/, 'resize=360:*');
    } catch { /* 沒圖就空著 */ }
  }

  // 原本的 LATEST 在首頁倒數第二個區塊，React 管的節點不好搬也不好往裡面塞東西，
  // 所以整個複製一份放到封面故事下方、原本的藏起來。複製品是靜態的，被重繪拿掉時 scan() 會再補回來。
  // 區塊本身是 CSS grid（areas: header / content），格子佔 grid-area: content；
  // 多出來的格子和按鈕要跟原格子一起包進同一個 content 容器，否則會疊在同一格。
  function ensureLatest() {
    if (location.pathname !== '/tw/') return;
    const orig = findLatestSection();
    if (!orig) return;
    orig.style.display = 'none';
    if (document.querySelector('.bz-latest-section')) return;

    const section = orig.cloneNode(true);
    section.style.display = '';
    section.classList.add('bz-latest-section');
    section.removeAttribute('data-lazy-id');
    stripTracking(section);

    const grid = section.querySelector(CARD_SEL).parentElement;
    const content = document.createElement('div');
    content.style.cssText = 'grid-area: content; min-width: 0';
    grid.before(content);

    const more = grid.cloneNode(false);
    more.classList.add('bz-latest-grid');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bz-latest-btn';
    btn.style.cssText = [
      'display: block',
      'margin: 24px auto 0',
      'padding: 10px 32px',
      'border: 1px solid currentColor',
      'background: transparent',
      'color: inherit',
      'font: inherit',
      'font-size: 0.875rem',
      'letter-spacing: 0.1em',
      'cursor: pointer',
    ].join(';');
    btn.textContent = '載入更多 LATEST…';
    btn.disabled = true;

    content.append(grid, more, btn);

    // 第一個 <section> 是封面故事，放在它下面；找不到就留在原位
    const cover = orig.parentElement.querySelector(':scope > section');
    if (cover && cover !== orig) cover.after(section);
    else orig.before(section);

    more.style.marginTop = getComputedStyle(grid).rowGap || '1.8rem';
    fillLatest(grid, more, btn);
  }

  async function fillLatest(grid, more, btn) {
    const items = await loadLatestPool();
    if (!more.isConnected) return;

    const template = grid.querySelector(CARD_SEL);
    const onPage = new Set([...grid.querySelectorAll(CARD_SEL)].map(cardId));
    const list = items.filter((it) => !onPage.has(it.id));

    const show = () => {
      const target = Math.min(latestShown, list.length);
      while (more.children.length < target) more.append(makeLatestCard(template, list[more.children.length]));
      const left = list.length - more.children.length;
      btn.disabled = false;
      btn.style.display = left > 0 ? 'block' : 'none'; // 有自訂 display，[hidden] 會被蓋掉
      btn.textContent = `再顯示 ${Math.min(LATEST_STEP, left)} 篇（還有 ${left} 篇）`;
    };
    btn.addEventListener('click', () => {
      latestShown += LATEST_STEP;
      show();
    });

    if (!list.length) {
      btn.textContent = '抓不到更多文章';
      return;
    }
    show();
  }

  // ---------- 快取（存在 harpersbazaar.com 的 localStorage） ----------

  function loadCache() {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY)) || {});
    } catch {
      return [];
    }
  }

  function saveCache() {
    try {
      const entries = [...dates].slice(-CACHE_MAX); // Map 依插入順序，丟掉最舊的
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* 容量滿或被封鎖就算了 */ }
  }

  // ---------- 啟動 ----------

  scan();

  // 區塊是捲動時才渲染（data-lazy-id），站內換頁也會整批換掉卡片
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
