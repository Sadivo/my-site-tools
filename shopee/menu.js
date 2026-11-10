/* ============================================================
   menu.js — content script（shopee.tw）
   ------------------------------------------------------------
   在右上角頭像的使用者下拉選單（我的帳戶 / 購買清單 / 登出）
   插入「按讚好物」，點了請 background 開啟或切換到 viewer。

   蝦皮是 SPA，選單滑過頭像才動態產生，所以用 MutationObserver
   等它出現。不依賴混淆過的 class：以「同一層裡同時有連到
   /user/account 與 /user/purchase 的連結，外加登出按鈕」認出選單，
   這樣 /user/ 頁面左側欄（沒有登出）不會被誤插。
   ============================================================ */

(() => {
  const MARK = 'data-my-tools-likes';
  const LABEL = '按讚好物';
  const LOGOUT_RE = /^(登出|log ?out)$/i;

  function findMenus() {
    const menus = [];
    for (const purchase of document.querySelectorAll('a[href*="/user/purchase"]')) {
      const menu = purchase.parentElement;
      if (!menu || menus.includes(menu)) continue;
      const kids = [...menu.children];
      const hasAccount = kids.some(k => k.matches('a[href*="/user/account"]'));
      const hasLogout = kids.some(k => LOGOUT_RE.test(k.textContent.trim()));
      if (hasAccount && hasLogout) menus.push({ menu, purchase });
    }
    return menus;
  }

  function openViewer(e) {
    e.preventDefault();
    try {
      chrome.runtime.sendMessage({ type: 'openViewer' });
    } catch {
      // 擴充重新載入後，舊頁面的 content script 會失聯
      alert('擴充已更新，請重新整理蝦皮頁面後再試一次。');
    }
  }

  function inject() {
    for (const { menu, purchase } of findMenus()) {
      if (menu.querySelector(`:scope > [${MARK}]`)) continue;
      // 複製「購買清單」沿用蝦皮自己的樣式；cloneNode 不會帶走 React 的事件
      // 結構是 <a class="..."><span>購買清單</span></a>，深複製保留內層 span
      const item = purchase.cloneNode(true);
      item.setAttribute(MARK, '');
      item.setAttribute('href', '#');
      item.removeAttribute('target');
      (item.querySelector('span') || item).textContent = LABEL;
      item.addEventListener('click', openViewer);
      purchase.after(item);
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      inject();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  inject();
})();
