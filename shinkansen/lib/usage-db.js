// usage-db.js — 翻譯用量紀錄 IndexedDB 封裝（v0.86 新增）
// 職責：持久化每次翻譯的 token 用量、費用、網站資訊，
//       並提供時間範圍查詢、聚合統計、CSV 匯出。
// 選用 IndexedDB 而非 chrome.storage.local，因為後者 10MB 上限
// 已被翻譯快取佔用大部分，而 IndexedDB 容量遠大於此。

const DB_NAME = 'shinkansen-usage';
const DB_VERSION = 1;
const STORE_NAME = 'translations';

/** 取得或建立 IndexedDB 連線（singleton Promise） */
let _dbPromise = null;
function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

/**
 * 寫入一筆翻譯用量紀錄。
 * @param {Object} record
 * @param {string} record.url — 翻譯頁面的完整 URL
 * @param {string} record.title — 頁面標題
 * @param {string} record.model — Gemini 模型 ID
 * @param {number} record.inputTokens — 原始輸入 token 數
 * @param {number} record.outputTokens — 輸出 token 數
 * @param {number} record.cachedTokens — Gemini implicit cache 命中 token 數
 * @param {number} record.billedInputTokens — 計費輸入 token 數
 * @param {number} record.billedCostUSD — 實際計費金額（USD）
 * @param {number} record.segments — 翻譯段落數
 * @param {number} record.cacheHits — 本地快取命中段落數
 * @param {number} record.durationMs — 翻譯耗時（毫秒）
 * @param {number} record.timestamp — Date.now()
 * @param {string} [record.engine] — v1.4.0: 翻譯引擎 'gemini' | 'google'（舊紀錄無此欄位則為 Gemini）
 * @param {number} [record.chars] — v1.4.0: Google Translate 用，翻譯字元數
 */
export async function logTranslation(record) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 依時間範圍查詢紀錄（按時間倒序）。
 * @param {Object} opts
 * @param {number} [opts.from] — 起始 timestamp（含）
 * @param {number} [opts.to] — 結束 timestamp（含）
 * @returns {Promise<Array>}
 */
export async function query({ from, to } = {}) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const lower = from ?? 0;
    const upper = to ?? Date.now();
    const range = IDBKeyRange.bound(lower, upper);
    const results = [];
    const req = index.openCursor(range, 'prev'); // 倒序
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 依時間範圍取得彙總統計。
 * @returns {Promise<{ count, totalInputTokens, totalOutputTokens, totalBilledCostUSD, byModel }>}
 */
export async function getStats({ from, to } = {}) {
  const records = await query({ from, to });
  const stats = {
    count: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalBilledInputTokens: 0,
    totalBilledCostUSD: 0,
    totalSegments: 0,
    byModel: {},
  };
  for (const r of records) {
    stats.totalInputTokens += r.inputTokens || 0;
    stats.totalOutputTokens += r.outputTokens || 0;
    stats.totalBilledInputTokens += r.billedInputTokens || 0;
    stats.totalBilledCostUSD += r.billedCostUSD || 0;
    stats.totalSegments += r.segments || 0;
    const m = r.model || 'unknown';
    if (!stats.byModel[m]) stats.byModel[m] = { count: 0, billedCostUSD: 0 };
    stats.byModel[m].count++;
    stats.byModel[m].billedCostUSD += r.billedCostUSD || 0;
  }
  return stats;
}

/**
 * 依時間範圍與粒度（日/週/月）聚合資料，供折線圖使用。
 * @param {Object} opts
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {'day'|'week'|'month'} opts.groupBy
 * @returns {Promise<Array<{ period: string, totalTokens: number, billedCostUSD: number, count: number }>>}
 */
export async function getAggregated({ from, to, groupBy = 'day' } = {}) {
  const records = await query({ from, to });
  const buckets = new Map(); // period string → aggregated data

  for (const r of records) {
    const d = new Date(r.timestamp);
    let period;
    if (groupBy === 'day') {
      period = fmtDate(d);
    } else if (groupBy === 'week') {
      period = fmtWeekStart(d);
    } else {
      period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    if (!buckets.has(period)) {
      buckets.set(period, { period, totalTokens: 0, billedCostUSD: 0, count: 0 });
    }
    const b = buckets.get(period);
    b.totalTokens += (r.billedInputTokens || 0) + (r.outputTokens || 0);
    b.billedCostUSD += r.billedCostUSD || 0;
    b.count++;
  }

  // 填補空白期間（讓折線圖不跳空）
  const result = fillGaps(buckets, from, to, groupBy);
  return result;
}

/**
 * 匯出 CSV 字串。
 */
export async function exportCSV({ from, to } = {}) {
  const records = await query({ from, to });
  // 按時間正序（CSV 慣例）
  records.reverse();
  const header = '時間,網站標題,URL,模型,輸入 tokens,輸出 tokens,計費輸入 tokens,費用（USD）,段落數,本地快取命中,耗時（秒）';
  const rows = records.map(r => {
    const time = new Date(r.timestamp).toLocaleString('zh-TW', { hour12: false });
    // CSV 欄位含逗號或引號時需要 escape
    const title = csvEscape(r.title || '');
    const url = csvEscape(r.url || '');
    const model = r.model || '';
    const duration = r.durationMs ? (r.durationMs / 1000).toFixed(1) : '';
    const cost = r.billedCostUSD ? r.billedCostUSD.toFixed(6) : '0';
    return `${time},${title},${url},${model},${r.inputTokens || 0},${r.outputTokens || 0},${r.billedInputTokens || 0},${cost},${r.segments || 0},${r.cacheHits || 0},${duration}`;
  });
  // 加 BOM 讓 Excel 正確辨識 UTF-8
  return '\uFEFF' + header + '\n' + rows.join('\n');
}

/**
 * 刪除指定時間之前的紀錄。
 * @param {number} beforeTimestamp
 * @returns {Promise<number>} 刪除筆數
 */
export async function clearBefore(beforeTimestamp) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(beforeTimestamp);
    let count = 0;
    const req = index.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      } else {
        resolve(count);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 清除所有紀錄。
 * @returns {Promise<void>}
 */
export async function clearAll() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── 工具函式 ───────────────────────────────────────────

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取得該日期所在週的週一日期字串 */
function fmtWeekStart(d) {
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day === 0 ? -6 : 1) - day; // 回推到週一
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return fmtDate(monday);
}

/** 填補空白期間，讓折線圖不跳空 */
function fillGaps(buckets, fromTs, toTs, groupBy) {
  const result = [];
  const from = new Date(fromTs || Date.now() - 30 * 86400000);
  const to = new Date(toTs || Date.now());

  if (groupBy === 'day') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (d <= to) {
      const key = fmtDate(d);
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setDate(d.getDate() + 1);
    }
  } else if (groupBy === 'week') {
    // 從 from 的週一開始
    const d = new Date(from);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    while (d <= to) {
      const key = fmtDate(d);
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setDate(d.getDate() + 7);
    }
  } else {
    // month
    const d = new Date(from.getFullYear(), from.getMonth(), 1);
    while (d <= to) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      result.push(buckets.get(key) || { period: key, totalTokens: 0, billedCostUSD: 0, count: 0 });
      d.setMonth(d.getMonth() + 1);
    }
  }
  return result;
}

function csvEscape(str) {
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
