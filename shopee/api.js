/* ============================================================
   api.js — 蝦皮「按讚好物」端點封裝
   ------------------------------------------------------------
   對外只輸出「正規化後」的商品物件（見 normalizeItem）。
   UI 層一律不碰蝦皮的原始欄位。
   ============================================================ */

const API_ORIGIN = 'https://shopee.tw';
const API_PATH = '/api/v4/pages/get_liked_items';

const PAGE_LIMIT = 50;        // 實測 50 可用
const THROTTLE_MS = 300;      // §8 節流：翻頁之間至少 300ms
const MAX_PAGES = 100;        // 防呆迴圈上限
const PRICE_SCALE = 100000;   // 價格單位是 元 × 100000
const IMG_BASE = 'https://down-tw.img.susercontent.com/file/';

/** 錯誤型別，讓 UI 能分辨該顯示哪一種狀態 */
class LikesError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LikesError';
    this.kind = kind; // 'auth' | 'shape' | 'network'
    this.detail = detail ?? null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildUrl(cursor, limit = PAGE_LIMIT) {
  return `${API_ORIGIN}${API_PATH}?limit=${limit}&cursor=${cursor}`;
}

/** 商品頁網址 */
function itemUrl(shopid, itemid) {
  return `${API_ORIGIN}/product/${shopid}/${itemid}`;
}

/** 圖片 hash → 完整網址 */
function imageUrl(hash) {
  return hash ? IMG_BASE + hash : '';
}

/**
 * 原始 item → 正規化物件。
 * §8 韌性：所有欄位一律給預設值，單筆異常不得讓整份清單崩潰。
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const priceMinRaw = raw.price_min ?? raw.price ?? 0;
  const priceMaxRaw = raw.price_max ?? raw.price ?? priceMinRaw;

  const stock = Number(raw.stock ?? 0);
  const status = raw.item_status ?? 'unknown';

  return {
    itemid: raw.itemid ?? null,
    shopid: raw.shopid ?? null,
    name: raw.name ?? '(無標題)',
    image: imageUrl(raw.image),
    priceMin: Math.round(Number(priceMinRaw) / PRICE_SCALE) || 0,
    priceMax: Math.round(Number(priceMaxRaw) / PRICE_SCALE) || 0,
    sold: Number(raw.historical_sold ?? raw.sold ?? 0) || 0,
    rating: typeof raw.item_rating?.rating_star === 'number' ? raw.item_rating.rating_star : null,
    cmtCount: Number(raw.cmt_count ?? 0) || 0,
    stock,
    status,
    shopName: raw.shop_name ?? '',
    isOfficial: !!raw.is_official_shop,
    // §3.3 判定「已下架 / 售完」
    isDead: status !== 'normal' || stock === 0,
    url: itemUrl(raw.shopid, raw.itemid),
  };
}

/**
 * 檢查單頁回應結構是否符合預期，不符就丟 shape 錯誤（§7 不得靜默失敗）。
 */
function parsePage(json) {
  if (!json || typeof json !== 'object') {
    throw new LikesError('shape', '蝦皮 API 回傳格式無法解析', json);
  }
  // 未登入 / 缺 cursor 等，HTTP 仍是 200，靠 error 欄位判斷
  if (json.error) {
    const kind = String(json.error_msg ?? '').includes('cursor') ? 'shape' : 'auth';
    throw new LikesError(kind, `蝦皮 API 回應錯誤 ${json.error}：${json.error_msg ?? ''}`, json);
  }
  const data = json.data;
  if (!data || !Array.isArray(data.items)) {
    throw new LikesError('shape', '蝦皮 API 回傳結構已改變（找不到 data.items）', json);
  }
  return {
    items: data.items,
    cursor: data.paging?.cursor ?? null,
    nomore: data.paging?.nomore === true,
  };
}

/**
 * 抓完整清單。
 * @param {object} opts
 * @param {(url:string)=>Promise<any>} opts.fetchJson  取得單頁 JSON 的函式（可換成注入代理）
 * @param {(n:number, pages:number)=>void} [opts.onProgress]
 * @returns {Promise<Array>} 正規化商品陣列
 */
async function fetchAllLikedItems({ fetchJson, onProgress } = {}) {
  if (typeof fetchJson !== 'function') {
    throw new LikesError('network', '未提供 fetchJson 實作');
  }

  const out = [];
  let cursor = 0; // 首頁必填 cursor=0

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(buildUrl(cursor));
    const { items, cursor: next, nomore } = parsePage(json);

    for (const raw of items) {
      try {
        const n = normalizeItem(raw);
        if (n) out.push(n);
      } catch {
        /* 單筆異常直接略過，不讓整份清單崩潰 */
      }
    }

    onProgress?.(out.length, page + 1);

    if (!items.length || nomore || next == null || next === cursor) break;
    cursor = next;
    await sleep(THROTTLE_MS);
  }

  return out;
}

/** 匯出用：TSV 表頭與列 */
const EXPORT_HEADERS = ['商品', '最低價', '最高價', '評分', '評價數', '已售', '庫存', '狀態', '賣場', '商城', '連結'];

function toRow(i) {
  return [
    i.name,
    i.priceMin,
    i.priceMax,
    i.rating ?? '',
    i.cmtCount,
    i.sold,
    i.stock,
    i.isDead ? '已下架/售完' : '正常',
    i.shopName,
    i.isOfficial ? 'Y' : '',
    i.url,
  ];
}

const clean = v => String(v).replace(/[\t\r\n]+/g, ' ');

function toTSV(list) {
  return [EXPORT_HEADERS.join('\t')]
    .concat(list.map(i => toRow(i).map(clean).join('\t')))
    .join('\n');
}

function toCSV(list) {
  const q = v => `"${String(v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
  return [EXPORT_HEADERS.map(q).join(',')]
    .concat(list.map(i => toRow(i).map(q).join(',')))
    .join('\r\n');
}

export {
  API_ORIGIN,
  PAGE_LIMIT,
  THROTTLE_MS,
  MAX_PAGES,
  LikesError,
  buildUrl,
  itemUrl,
  imageUrl,
  normalizeItem,
  parsePage,
  fetchAllLikedItems,
  toTSV,
  toCSV,
  EXPORT_HEADERS,
};
