/**
 * GQ Taiwan - More Updates
 * 從月份 sitemap 抓最新文章，注入到首頁 MOST UPDATED 區塊下方
 *
 * GQ Taiwan sitemap 結構：
 *   sitemap.xml          → sitemapindex（月份索引）
 *   sitemap-YYYY-MM.xml  → 當月所有文章的 urlset
 */

const MAX_PER_LOAD = 8;
const MAX_TOTAL = 40;

let allArticles = [];
let displayedCount = 0;
let isLoading = false;

const LOG = (...args) => console.log("[GQ+]", ...args);
const ERR = (...args) => console.error("[GQ+]", ...args);

// ── sitemap 工具 ──────────────────────────────────────────

/** 回傳最近 2 個月的 {year, month}，最新的在前 */
function getRecentMonths() {
  const results = [];
  const d = new Date();
  for (let i = 0; i < 2; i++) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    results.push({ year: t.getFullYear(), month: t.getMonth() + 1 });
  }
  return results;
}

/** 抓單一月份的 sitemap，回傳符合條件的文章陣列 */
async function fetchMonthlySitemap(year, month) {
  const mm = String(month).padStart(2, "0");
  const url = `https://www.gq.com.tw/sitemap-${year}-${mm}.xml`;
  LOG(`fetchSitemap → ${url}`);

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    ERR(`  fetch 失敗: ${e.message}`);
    return [];
  }

  LOG(`  HTTP ${resp.status}`);
  if (!resp.ok) return [];

  const text = await resp.text();
  LOG(`  回傳長度: ${text.length} 字元，前 150 字:`, text.slice(0, 150));

  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) {
    ERR("  XML 解析失敗");
    return [];
  }

  const articles = [];
  for (const urlEl of xml.getElementsByTagName("url")) {
    const loc     = urlEl.getElementsByTagName("loc")[0]?.textContent?.trim() || "";
    const lastmod = urlEl.getElementsByTagName("lastmod")[0]?.textContent?.trim() || "";
    if (loc.includes("/article/") || loc.includes("/special/")) {
      articles.push({ url: loc, lastmod, title: "", category: "", image: "" });
    }
  }

  LOG(`  解析到 ${articles.length} 篇文章`);
  return articles;
}

async function fetchArticleMeta(article) {
  try {
    const resp = await fetch(article.url);
    if (!resp.ok) return article;
    const doc = new DOMParser().parseFromString(await resp.text(), "text/html");

    const h1 = doc.querySelector("h1");
    if (h1) article.title = h1.textContent.trim();

    const ogSection = doc.querySelector('meta[property="article:section"]');
    if (ogSection) article.category = ogSection.getAttribute("content") || "";

    const ogImage = doc.querySelector('meta[property="og:image"]');
    if (ogImage) article.image = ogImage.getAttribute("content") || "";
  } catch (e) {
    LOG(`fetchArticleMeta 失敗 (${article.url}): ${e.message}`);
  }
  return article;
}

// ── DOM 工具 ──────────────────────────────────────────────

function findMostUpdatedContainer() {
  for (const el of document.querySelectorAll("h2, h3")) {
    if (!el.textContent.trim().toUpperCase().includes("MOST UPDATED")) continue;

    LOG(`找到 MOST UPDATED 標題`);
    let node = el.parentElement;
    for (let i = 0; i < 10; i++) {
      if (!node) break;
      const cls = node.className || "";
      if (cls.includes("FeaturesRow") || cls.includes("featuresrow")) {
        LOG(`找到 FeaturesRow 容器 (往上 ${i + 1} 層)`);
        return node;
      }
      node = node.parentElement;
    }

    // fallback：往上 4 層
    let fallback = el.parentElement;
    for (let i = 0; i < 3; i++) fallback = fallback?.parentElement;
    return fallback || el.parentElement;
  }

  ERR("找不到含 'MOST UPDATED' 的 h2/h3");
  return null;
}

// ── 渲染 ──────────────────────────────────────────────────

function renderCard(article) {
  const a = document.createElement("a");
  a.className = "gq-article-card";
  a.href = article.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  const dateStr = article.lastmod
    ? new Date(article.lastmod).toLocaleDateString("zh-TW", {
        year: "numeric", month: "long", day: "numeric",
      })
    : "";

  const title = article.title || decodeURIComponent(article.url.split("/").pop());

  a.innerHTML = `
    ${article.image
      ? `<img src="${article.image}" alt="" style="width:100%;aspect-ratio:1/1;object-fit:cover;margin-bottom:10px;">`
      : ""}
    ${article.category ? `<span class="gq-card-category">${article.category}</span>` : ""}
    <div class="gq-card-title">${title}</div>
    ${dateStr ? `<div class="gq-card-date">${dateStr}</div>` : ""}
  `;
  return a;
}

function showNextBatch(grid, btn, statusEl) {
  const batch = allArticles.slice(displayedCount, displayedCount + MAX_PER_LOAD);
  batch.forEach(a => grid.appendChild(renderCard(a)));
  displayedCount += batch.length;

  const remaining = Math.min(allArticles.length, MAX_TOTAL) - displayedCount;
  if (remaining <= 0 || displayedCount >= MAX_TOTAL) {
    btn.style.display = "none";
    statusEl.textContent = `已顯示全部 ${displayedCount} 篇`;
  } else {
    btn.textContent = `載入更多（還有 ${remaining} 篇）`;
    btn.disabled = false;
  }
}

// ── 主流程 ────────────────────────────────────────────────

async function init() {
  LOG("init() 開始");

  const container = findMostUpdatedContainer();
  if (!container) return;

  // 建立 UI
  const section = document.createElement("div");
  section.id = "gq-more-section";
  section.innerHTML = `
    <h2>MORE UPDATES</h2>
    <div class="gq-article-grid" id="gq-grid"></div>
    <div id="gq-status">載入中...</div>
    <button id="gq-load-btn" disabled>載入更多</button>
  `;
  container.insertAdjacentElement("afterend", section);

  const grid     = section.querySelector("#gq-grid");
  const btn      = section.querySelector("#gq-load-btn");
  const statusEl = section.querySelector("#gq-status");

  // 抓最近 2 個月的 sitemap
  let rawArticles = [];
  const seen = new Set();
  const months = getRecentMonths();
  LOG("抓取月份:", months);

  for (const { year, month } of months) {
    try {
      const batch = await fetchMonthlySitemap(year, month);
      for (const a of batch) {
        const key = a.url.split("#")[0];
        if (!seen.has(key)) {
          seen.add(key);
          rawArticles.push(a);
        }
      }
    } catch (e) {
      ERR(`fetchMonthlySitemap 例外: ${e.message}`);
    }
    if (rawArticles.length >= MAX_TOTAL) break;
  }

  LOG(`共抓到 ${rawArticles.length} 篇（去重）`);

  // 按 lastmod 排序（最新在前），取前 MAX_TOTAL 篇
  allArticles = rawArticles
    .sort((a, b) => b.lastmod.localeCompare(a.lastmod))
    .slice(0, MAX_TOTAL);

  if (allArticles.length === 0) {
    statusEl.textContent = "沒有找到更多文章";
    btn.style.display = "none";
    ERR("allArticles 為空，請查閱上方 [GQ+] 日誌");
    return;
  }

  // 預先抓第一批 meta
  statusEl.textContent = "抓取文章資訊...";
  await Promise.all(allArticles.slice(0, MAX_PER_LOAD).map(a => fetchArticleMeta(a)));

  statusEl.textContent = "";
  showNextBatch(grid, btn, statusEl);
  LOG(`初始渲染完成，共 ${displayedCount} 篇`);

  btn.addEventListener("click", async () => {
    if (isLoading) return;
    isLoading = true;
    btn.disabled = true;
    btn.textContent = "載入中...";

    try {
      await Promise.all(
        allArticles.slice(displayedCount, displayedCount + MAX_PER_LOAD).map(a => fetchArticleMeta(a))
      );
      showNextBatch(grid, btn, statusEl);
    } catch (e) {
      ERR(`載入更多失敗: ${e.message}`);
      btn.disabled = false;
      btn.textContent = "重試";
    } finally {
      isLoading = false;
    }
  });
}

init();
