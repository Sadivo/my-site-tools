# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概要

這個 repo 是單一個 Chrome MV3 擴充（「我的網站小工具」），由原本四個獨立擴充合併而成，原資料夾已刪除。純前端、零依賴、沒有 build 步驟：直接在 `chrome://extensions` 以「載入未封裝項目」選 repo 根目錄（裝著 `manifest.json` 那一層）。改完程式按擴充的重新載入（↻），已開著的目標網站分頁要重新整理才會套用新的 content script。

GitHub：https://github.com/Sadivo/my-site-tools 。GQ 部分的原始歷史與 `gq_scraper.py` 在 https://github.com/Sadivo/gq-extension 。

## 指令

```
node --test tests/shopee-api.test.mjs                 # 蝦皮 api.js 單元測試（18 項）
node --test --test-name-pattern="匯出 CSV" tests/shopee-api.test.mjs  # 跑單一測試
node --check gq/content.js                            # 非 module 腳本的語法檢查
```

沒有 lint 設定。只有 `shopee/api.js`（純函式、ES module）有測試；content script 與 viewer 都要在真的 Chrome 裡驗證。內建瀏覽器無法載入未封裝擴充。

## 架構

`manifest.json` 是唯一把各模組串起來的地方：

- **bella / gq / vogue / verse / bazaar**：各自只是一支 content script，只在自己網站的特定頁面注入（matches 寫得很窄，例如 GQ 只有首頁 `https://www.gq.com.tw/`）。資料都從同源抓：Bella 抓頻道列表頁加 `/feed/google`，用 localStorage 快取；GQ 抓月份 sitemap `sitemap-YYYY-MM.xml`，再逐篇抓 meta；Vogue（和 GQ 同為 Condé Nast 平台）不用 sitemap，而是抓站內搜尋頁 `/search?q=&sort=publishdate+desc&page=N`，從 `window.__PRELOADED_STATE__.transformed.search.items` 拿現成的標題、圖片、分類與 pubDate，一頁 24 篇，區塊插在首頁「Top Stories」那列下方；VERSE 對列表上每篇文章各發一次 fetch 取日期；BAZAAR 例外，matches 涵蓋整個 `/tw/*`，日期優先讀頁面內嵌的 `#__NEXT_DATA__`（`display_id` → `publish_from`），找不到才逐篇串流抓文章頁、讀到 `article:modified_time` 就中斷（這個值才等於網站顯示的 Published 日期，`article:published_time` 是最初建立時間）。首頁 LATEST 加長則是抓 6 個頻道首頁（fashion、beauty、celebrity、life、culture、luxury）的 `__NEXT_DATA__` 合併排序，原本的 LATEST 區塊（React 管）整個藏起來，改把它複製一份放到封面故事下方再往裡加卡片。這個區塊是 CSS grid，卡片格子佔 `grid-area: content`，加的格子和按鈕必須跟原格子包進同一個 content 容器，直接當兄弟節點插入會疊在同一格。網站自己的 `/tw/api/feed-content` 分頁 API 會回 500，不能用。五者共同的弱點是依賴目標網站的 DOM 結構，網站改版就會失效。
- **shopee**：唯一用到 service worker、工具列按鈕與額外權限（`scripting`、`tabs`）的模組。`manifest.json` 的 `background.service_worker` 指向 `shopee/background.js`，若之後其他模組也需要背景邏輯，得在這支檔案上擴充，或改成一支總入口再 `importScripts`。

### 蝦皮按讚清單的資料流

1. 開啟入口有兩個，都走 `background.js` 的 `openViewer()`（已開就切過去）：工具列圖示（`chrome.action.onClicked`），以及 `shopee/menu.js`。後者在 shopee.tw 頭像下拉選單插入「按讚好物」，點擊時送出 `{type:'openViewer'}` 訊息。
2. `viewer.html` 載入 `viewer.js`（ES module，import `api.js`）。抓取時有兩條路徑，由 `pickTransport()` 開機時自動探測：
   - **direct**：從 `chrome-extension://` 頁面直接 `fetch(..., {credentials:'include'})`
   - **proxy**：如果 SameSite 讓 Cookie 帶不上，就送 `{type:'proxyFetch'}` 給 background。background 用 `chrome.scripting.executeScript`（world: MAIN）在 shopee.tw 分頁內執行同源 fetch；沒有現成的蝦皮分頁就開一個背景分頁，抓完再送 `releaseProxy` 收掉。
   - 探測用的第一頁會被快取重用（`withPrimed`）。探測時判斷出的錯誤原因（未登入或 API 改版）會保留下來，用來取代代理路徑回報的泛用錯誤。
3. `api.js` 負責 cursor 翻頁（每頁 50 筆、間隔 300ms、最多 100 頁）、欄位正規化（價格要除以 100000；下架有兩種判定條件）、錯誤分類（`LikesError` 的種類分為 shape、auth、network），以及 TSV/CSV 匯出。

### 修改時要注意

- background 注入的 `injectedFetch` 必須完全自足，不能引用外部變數。
- `menu.js` 刻意不用蝦皮混淆過的 class 來找選單：同一層裡要同時有 `/user/account`、`/user/purchase` 連結和「登出」才算數，這樣不會誤插到 `/user/` 頁面的左側欄。選單項目是複製「購買清單」那一項做出來的，用來沿用蝦皮的樣式。
- `viewer.css` 有 `[hidden] { display: none !important; }`。`.grid` 等元素自訂的 `display` 會蓋過瀏覽器預設的 hidden，拿掉這條，載入用的骨架卡片就會一直留在畫面上。
- `gq/content.js` 的變數宣告在最外層，沒有包在 IIFE 裡。同一擴充的 content script 在同一頁共用一個 isolated world，目前各模組的 matches 不重疊所以沒事；如果讓兩支腳本注入同一頁，可能會出現變數重複宣告錯誤。
- `bella/bella-more.user.js` 開頭保留了 UserScript 標頭，同一份檔案也能直接貼到油猴使用。
- 每支 content script 都要防止重複注入（例如 Bella 檢查 `#bmx-root`，menu.js 檢查 `data-my-tools-likes`）。
