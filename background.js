// MV3 只能有一個 service worker，各模組的背景邏輯在這裡一起載入。
// 這些檔案共用同一個全域範圍：最外層的變數與函式名稱不能重複。
importScripts('shopee/background.js', 'github/background.js');
