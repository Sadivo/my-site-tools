// Vogue Taiwan 首頁「最新文章」區塊 - content script
// 資料來源是站內搜尋頁不帶關鍵字、依最新排序：/search?q=&sort=publishdate+desc&page=N
// 這頁涵蓋全站所有分類、嚴格依 pubDate 由新到舊，一頁 24 篇，可以一直翻頁
// （和 /feed/rss 的 30 篇比對過，沒有漏）。
// 文章清單在頁面的 window.__PRELOADED_STATE__.transformed.search.items，
// 不用解析 DOM，所以網站改 class 名稱不影響資料，只影響插入位置。
// 區塊插在「Top Stories」那一列下方，找不到就放在 multi-packages 最前面。

(function () {
  const root = document.documentElement;
  if (root.dataset.myToolsVogue) return;
  root.dataset.myToolsVogue = '1';

  const SEARCH_URL = '/search?q=&sort=publishdate+desc';

  let nextPage = 1;
  let loading = false;
  const seen = new Set(); // 翻頁期間有新文章發布，整批會往後推，用 url 去重

  // ---------- 資料 ----------

  function stateFromHtml(html) {
    const mark = html.indexOf('window.__PRELOADED_STATE__');
    if (mark < 0) return null;
    const from = html.indexOf('{', mark);
    const text = html.slice(from, html.indexOf('</script>', from)).trim().replace(/;$/, '');
    try { return JSON.parse(text); } catch { return null; }
  }

  async function fetchPage(page) {
    const res = await fetch(new URL(`${SEARCH_URL}&page=${page}`, location.href));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const search = stateFromHtml(await res.text())?.transformed?.search;
    if (!Array.isArray(search?.items)) throw new Error('搜尋頁結構改了，找不到 transformed.search.items');
    return { items: search.items, hasMore: Boolean(search.nextPageURL) };
  }

  // ---------- 畫面 ----------

  function plainText(html) {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    return t.content.textContent.trim();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function makeCard(item) {
    const title = plainText(item.dangerousHed || item.hed);
    const a = el('a', 'vg-card');
    a.href = new URL(item.url, location.origin).href;

    const src = item.image?.sources?.sm || item.image?.sources?.md;
    const thumb = el('div', 'vg-card-thumb');
    if (src?.url) {
      const img = el('img');
      img.src = src.url;
      if (src.srcset) {
        img.srcset = src.srcset;
        img.sizes = '(max-width: 600px) 50vw, 320px';
      }
      img.alt = item.image.altText || title;
      img.loading = 'lazy';
      img.decoding = 'async';
      thumb.append(img);
    }
    a.append(thumb);

    const rubric = item.rubric?.name;
    if (rubric) a.append(el('span', 'vg-card-rubric', rubric));
    a.append(el('div', 'vg-card-title', title));
    a.append(el('time', 'vg-card-time', formatTime(item.pubDate)));
    return a;
  }

  function buildSection() {
    const section = el('section');
    section.id = 'vg-latest';
    section.append(el('h2', 'vg-heading', 'Latest'));
    const grid = el('div', 'vg-grid');
    const status = el('div', 'vg-status', '載入中…');
    const btn = el('button', 'vg-more', '載入更多');
    btn.type = 'button';
    btn.style.display = 'none';
    section.append(grid, status, btn);

    btn.addEventListener('click', () => loadNext(grid, status, btn));
    return { section, grid, status, btn };
  }

  async function loadNext(grid, status, btn) {
    if (loading) return;
    loading = true;
    btn.disabled = true;
    btn.textContent = '載入中…';
    try {
      const { items, hasMore } = await fetchPage(nextPage);
      nextPage += 1;
      let added = 0;
      for (const item of items) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        grid.append(makeCard(item));
        added += 1;
      }
      status.textContent = grid.children.length ? '' : '沒有找到文章';
      btn.style.display = hasMore ? 'block' : 'none';
      btn.textContent = '載入更多';
      if (!added && hasMore) btn.textContent = '這頁都看過了，再載入下一頁';
    } catch (e) {
      status.textContent = `抓不到最新文章（${e.message}）`;
      btn.style.display = 'block';
      btn.textContent = '重試';
    } finally {
      btn.disabled = false;
      loading = false;
    }
  }

  // ---------- 插入位置 ----------

  function findAnchor() {
    const packages = document.querySelector('.multi-packages');
    if (!packages) return null;
    for (const row of packages.children) {
      const h = row.querySelector('h2, h3');
      if (h && /top stories/i.test(h.textContent)) return { after: row };
    }
    return { before: packages.firstElementChild, parent: packages };
  }

  function place(section) {
    if (section.isConnected) return true;
    const anchor = findAnchor();
    if (!anchor) return false;
    if (anchor.after) anchor.after.after(section);
    else anchor.parent.insertBefore(section, anchor.before);
    return true;
  }

  // ---------- 啟動 ----------

  const ui = buildSection();
  let started = false;
  const tryPlace = () => {
    if (!place(ui.section) || started) return;
    started = true; // 失敗時交給「重試」按鈕，不在這裡自動重抓
    loadNext(ui.grid, ui.status, ui.btn);
  };
  tryPlace();

  // 首頁是 React，水合或重繪可能把插進去的節點拿掉；保留同一個節點，掉了就放回去
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(tryPlace, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
