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

### 蝦皮網站內的入口

`shopee/menu.js` 會在 shopee.tw 右上角頭像的使用者下拉選單（我的帳戶 / 購買清單 / 登出）裡，「購買清單」下方插入「按讚好物」。點了和按工具列圖示一樣：viewer 分頁已經開著就切過去，沒有就開新分頁（共用 `shopee/background.js` 的 `openViewer()`）。

- 選單是滑過頭像才動態產生的，靠 MutationObserver 偵測後插入，不會重複插入
- 辨識方式不靠蝦皮混淆過的 class：同一層同時有 `/user/account`、`/user/purchase` 連結與「登出」按鈕，才當作是使用者選單
- 重新載入擴充後，已開著的蝦皮分頁要重新整理，選項才會有反應

## 安裝

1. 下載這個 repo：`git clone https://github.com/Sadivo/my-site-tools.git`，或在 GitHub 頁面按 Code → Download ZIP 後解壓縮
2. Chrome 開 `chrome://extensions`，開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇下載下來的資料夾（裝著 `manifest.json` 那一層）

## 來源

- 原本的獨立資料夾（bella-extension、gq-extension、verse-date-extension、shopee-likes-extension）已於 2026-10-17 刪除
- GQ 的舊版與 `data/gq_scraper.py` 在 GitHub：https://github.com/Sadivo/gq-extension
- 不再支援 Firefox / 油猴；`bella/bella-more.user.js` 開頭仍保留 UserScript 標頭，要用油猴可以直接貼上

## 測試

```
node --test tests/shopee-api.test.mjs
```
