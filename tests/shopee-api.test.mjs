/* 針對 api.js 純函式的單元測試：node --test test/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUrl, itemUrl, imageUrl, normalizeItem, parsePage,
  fetchAllLikedItems, toTSV, toCSV, LikesError, EXPORT_HEADERS,
} from '../shopee/api.js';

const RAW = {
  itemid: 111, shopid: 222, name: '測試商品',
  image: 'abc123',
  price_min: 19900000, price_max: 45000000,
  historical_sold: 1234,
  item_rating: { rating_star: 4.8123 },
  cmt_count: 56, stock: 7, item_status: 'normal',
  shop_name: '測試賣場', is_official_shop: true,
};

test('buildUrl 一定帶 cursor（少帶會回 missing cursor）', () => {
  assert.match(buildUrl(0), /[?&]cursor=0(&|$)/);
  assert.match(buildUrl(20), /[?&]cursor=20(&|$)/);
  assert.match(buildUrl(0), /limit=50/);
});

test('網址與圖片組裝', () => {
  assert.equal(itemUrl(222, 111), 'https://shopee.tw/product/222/111');
  assert.equal(imageUrl('abc'), 'https://down-tw.img.susercontent.com/file/abc');
  assert.equal(imageUrl(undefined), '');
});

test('價格除以 100000', () => {
  const n = normalizeItem(RAW);
  assert.equal(n.priceMin, 199);
  assert.equal(n.priceMax, 450);
});

test('欄位正規化與商品頁網址', () => {
  const n = normalizeItem(RAW);
  assert.equal(n.name, '測試商品');
  assert.equal(n.sold, 1234);
  assert.equal(n.rating, 4.8123);
  assert.equal(n.cmtCount, 56);
  assert.equal(n.shopName, '測試賣場');
  assert.equal(n.isOfficial, true);
  assert.equal(n.url, 'https://shopee.tw/product/222/111');
  assert.equal(n.isDead, false);
});

test('下架判定：item_status 非 normal', () => {
  assert.equal(normalizeItem({ ...RAW, item_status: 'banned' }).isDead, true);
});

test('下架判定：stock 為 0', () => {
  assert.equal(normalizeItem({ ...RAW, stock: 0 }).isDead, true);
});

test('韌性：欄位全缺不得丟例外', () => {
  const n = normalizeItem({});
  assert.equal(n.name, '(無標題)');
  assert.equal(n.priceMin, 0);
  assert.equal(n.rating, null);
  assert.equal(n.isDead, true); // 缺 status/stock 視為異常
  assert.equal(normalizeItem(null), null);
});

test('rating 為 null 時保持 null（不變成 0）', () => {
  assert.equal(normalizeItem({ ...RAW, item_rating: { rating_star: null } }).rating, null);
});

const grab = fn => {
  try { fn(); } catch (e) { return e; }
  throw new Error('預期要丟例外，但沒有');
};

test('parsePage：error 10002 missing cursor 判為 shape', () => {
  const e = grab(() => parsePage({ error: 10002, error_msg: 'missing cursor' }));
  assert.ok(e instanceof LikesError);
  assert.equal(e.kind, 'shape');
});

test('parsePage：其他 error 判為 auth（未登入）', () => {
  const e = grab(() => parsePage({ error: 4, error_msg: 'error_not_login' }));
  assert.ok(e instanceof LikesError);
  assert.equal(e.kind, 'auth');
});

test('parsePage：缺 data.items 判為 shape', () => {
  const e = grab(() => parsePage({ error: 0, data: {} }));
  assert.ok(e instanceof LikesError);
  assert.equal(e.kind, 'shape');
});

test('parsePage：正常回應', () => {
  const p = parsePage({ error: 0, data: { items: [RAW], paging: { cursor: 20, nomore: false } } });
  assert.equal(p.items.length, 1);
  assert.equal(p.cursor, 20);
  assert.equal(p.nomore, false);
});

test('翻頁：靠 cursor 串接，nomore 結束', async () => {
  const seen = [];
  const pages = [
    { error: 0, data: { items: [RAW, RAW], paging: { cursor: 20, nomore: false } } },
    { error: 0, data: { items: [RAW], paging: { cursor: 40, nomore: true } } },
  ];
  let i = 0;
  const list = await fetchAllLikedItems({
    fetchJson: async url => { seen.push(url); return pages[i++]; },
  });
  assert.equal(list.length, 3);
  assert.match(seen[0], /cursor=0/);
  assert.match(seen[1], /cursor=20/);
  assert.equal(seen.length, 2);
});

test('翻頁：items 為空即停止', async () => {
  let i = 0;
  const pages = [
    { error: 0, data: { items: [RAW], paging: { cursor: 20, nomore: false } } },
    { error: 0, data: { items: [], paging: { cursor: 40, nomore: false } } },
  ];
  const list = await fetchAllLikedItems({ fetchJson: async () => pages[i++] });
  assert.equal(list.length, 1);
});

test('翻頁：cursor 未前進即停止（防無限迴圈）', async () => {
  let calls = 0;
  const list = await fetchAllLikedItems({
    fetchJson: async () => {
      calls++;
      return { error: 0, data: { items: [RAW], paging: { cursor: 0, nomore: false } } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(list.length, 1);
});

test('匯出 TSV：表頭與欄數一致', () => {
  const tsv = toTSV([normalizeItem(RAW)]);
  const lines = tsv.split('\n');
  assert.equal(lines[0].split('\t').length, EXPORT_HEADERS.length);
  assert.equal(lines[1].split('\t').length, EXPORT_HEADERS.length);
  assert.ok(lines[1].includes('測試商品'));
});

test('匯出 TSV：商品名含 tab / 換行不得破欄', () => {
  const tsv = toTSV([normalizeItem({ ...RAW, name: '壞\t商品\n第二行' })]);
  assert.equal(tsv.split('\n').length, 2);
  assert.equal(tsv.split('\n')[1].split('\t').length, EXPORT_HEADERS.length);
});

test('匯出 CSV：引號正確跳脫', () => {
  const csv = toCSV([normalizeItem({ ...RAW, name: '含"引號"的商品' })]);
  assert.ok(csv.includes('"含""引號""的商品"'));
});
