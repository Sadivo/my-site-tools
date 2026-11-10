// VERSE 文章日期顯示 - content script
// 從每篇文章頁面抓取發布日期，注入到列表卡片中

(function () {
  // 找所有文章卡片的連結（h3 > a）
  const articleLinks = document.querySelectorAll('h3 a[href*="/article/"]');
  if (!articleLinks.length) return;

  articleLinks.forEach(async (link) => {
    const url = link.href;
    const h3 = link.closest('h3');
    if (!h3) return;

    try {
      const res = await fetch(url);
      const text = await res.text();

      // 日期格式為 YYYY/MM/DD，出現在文章頁面 hero 圖下方
      const match = text.match(/(\d{4}\/\d{2}\/\d{2})/);
      if (!match) return;

      const dateStr = match[1]; // e.g. "2026/05/29"

      // 建立日期標籤並插入到 h3 前面
      const dateEl = document.createElement('span');
      dateEl.textContent = dateStr;
      dateEl.style.cssText = [
        'display: inline-block',
        'font-size: 0.75rem',
        'color: #888',
        'margin-bottom: 4px',
        'letter-spacing: 0.05em',
      ].join(';');

      h3.parentNode.insertBefore(dateEl, h3);
    } catch (e) {
      // 靜默失敗，不影響頁面
    }
  });
})();
