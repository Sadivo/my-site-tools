# 我的網站小工具

替幾個常逛的網站補功能的 Chrome 擴充（Manifest V3），各網站的功能合在同一個擴充裡，只要載入這一個資料夾。

| 資料夾 | 作用 |
|---|---|
| `bella/` | bella.tw 首頁「Most Popular」下方列出近幾天新文章 |
| `gq/` | gq.com.tw 首頁顯示更多最新文章 |
| `vogue/` | vogue.com.tw 首頁「Top Stories」下方加一個 Latest 區塊，全站文章由新到舊，可一直載入更多 |
| `verse/` | verse.com.tw 文章列表補上發布日期 |
| `bazaar/` | harpersbazaar.com/tw 全站的文章卡片標題下方補上發布日期；首頁 LATEST 移到封面故事下方，並從 12 篇加長到近 7 天的文章（先多 24 篇，按鈕每次再 +12） |
| `shopee/` | 點工具列圖示，或蝦皮右上角頭像選單裡的「按讚好物」，開啟蝦皮按讚清單 |
| `github/` | GitHub Size Lens：github.com 上顯示 repo 大小、資料夾列表每個檔案的大小，以及單檔下載按鈕 |

### 蝦皮網站內的入口

`shopee/menu.js` 會在 shopee.tw 右上角頭像的使用者下拉選單（我的帳戶 / 購買清單 / 登出）裡，「購買清單」下方插入「按讚好物」。點了和按工具列圖示一樣：viewer 分頁已經開著就切過去，沒有就開新分頁（共用 `shopee/background.js` 的 `openViewer()`）。

- 選單是滑過頭像才動態產生的，靠 MutationObserver 偵測後插入，不會重複插入
- 辨識方式不靠蝦皮混淆過的 class：同一層同時有 `/user/account`、`/user/purchase` 連結與「登出」按鈕，才當作是使用者選單
- 重新載入擴充後，已開著的蝦皮分頁要重新整理，選項才會有反應

### GitHub Size Lens

- **Repo 大小**：repo 首頁在 Sponsor / Watch / Fork / Star 那一排的最前面；子資料夾和檔案頁顯示在上方路徑的 repo 名稱旁邊
- **檔案大小**：資料夾列表多一欄「Size」
- **單檔下載**：Size 欄裡的下載按鈕，按了直接存檔，不會開新分頁

**設定頁**：在工具列圖示上按右鍵 →「選項」（工具列圖示左鍵是蝦皮清單）。API 額度用完時，頁面上的提示也有「開啟設定」按鈕。設定頁可以開關上面三項、貼 GitHub token、清除快取。

**Token（選填）**：沒有 token 時 GitHub API 每小時只能呼叫 60 次，也看不到私有 repo。每換一頁大約用 1～2 次，結果快取 5 分鐘，一般瀏覽通常夠用。要設定的話到 GitHub → Settings → Developer settings → Fine-grained personal access tokens 建立：只看公開 repo 選「Public repositories」、不用勾權限；要看私有 repo 就開放指定 repo 的 **Contents: Read-only**。Token 只存在這台電腦的 `chrome.storage.local`（不會同步），只會送到 `api.github.com`，GitHub 網頁上的程式碼碰不到它。

運作方式：每個資料夾只呼叫一次 `contents` API 就拿到所有檔案大小；用每一列的連結比對檔名，不靠列的順序；branch 名稱有斜線（例如 `feature/x`）也能判斷；下載走 GitHub 自己的 `/raw/` 連結，私有 repo 沿用瀏覽器裡的登入狀態。不會連到任何第三方伺服器。

GitHub 改版時，通常只要調整 `github/content.js` 裡這幾個選擇器：

- `table[aria-labelledby="folders-and-files"]`：資料夾列表
- `tr.react-directory-row`：每一列
- `ul[data-testid="repo-header-actions"]`：repo 首頁的按鈕列
- `[data-testid="breadcrumbs-repo-link"]` / `nav[aria-label="Breadcrumbs"]`：子頁面的路徑列

## 權限

| 權限 | 用途 |
|---|---|
| `scripting`、`tabs` | 蝦皮清單抓不到 Cookie 時，改在 shopee.tw 分頁內代為抓取 |
| `storage` | GitHub Size Lens 的設定、token、5 分鐘快取 |
| `downloads` | GitHub 單檔下載按鈕直接存檔 |
| `https://shopee.tw/*`、`https://www.gq.com.tw/*` | 蝦皮 API、GQ sitemap |
| `https://api.github.com/*` | 查詢 repo 與資料夾大小 |

## 安裝

1. 下載這個 repo：`git clone https://github.com/Sadivo/my-site-tools.git`，或在 GitHub 頁面按 Code → Download ZIP 後解壓縮
2. Chrome 開 `chrome://extensions`，開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇下載下來的資料夾（裝著 `manifest.json` 那一層）

需要 Chrome 116 以上。如果裝過 Enhanced GitHub 之類同樣會在 GitHub 頁面加大小資訊的擴充，建議停用，免得兩邊同時往頁面裡加東西。

## 來源

- 原本的獨立資料夾（bella-extension、gq-extension、verse-date-extension、shopee-likes-extension）已於 2026-10-17 刪除
- GQ 的舊版與 `data/gq_scraper.py` 在 GitHub：https://github.com/Sadivo/gq-extension
- 不再支援 Firefox / 油猴；`bella/bella-more.user.js` 開頭仍保留 UserScript 標頭，要用油猴可以直接貼上

## 測試

```
node --test tests/shopee-api.test.mjs
```
