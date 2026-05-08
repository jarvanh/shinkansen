'use strict';

/**
 * v1.8.60 unit:lib/rate-limit-init-log-dedup.js 的 shouldLogInit() 純函式邏輯。
 *
 * 為什麼這條 spec 存在:
 *   - MV3 SW idle-die → background.js initLimiter() 每 5-25 分鐘 cold start 跑一次,
 *     原本每次都 debugLog 一條 'rate limiter initialized' → Debug 分頁 24h 內可能累
 *     50 條一模一樣的 log,使用者實際關心的事件被淹沒。
 *   - 修法:dedup 邏輯抽到 lib/rate-limit-init-log-dedup.js 純函式,background 寫
 *     storage.local 的 prev 紀錄 + 比對。本 spec 鎖死 4 個邊界:
 *       (1) prev=null 第一次 → 寫
 *       (2) 同 payload + 24h 內 → 跳過
 *       (3) 不同 payload(tier 切換)→ 即使 < 24h 仍寫
 *       (4) 同 payload + 24h 過期 → 寫(刷新時間戳)
 *
 * SANITY 紀錄(已驗證 2026-05-08):把 shouldLogInit 永遠 return true → (2) 與
 * (4) 邊界都會「寫 log」拿不到 dedup 效果, spec 內 (2) 斷言 fail。還原 → pass。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

function loadEsmAsSandbox(relPath, sandbox = {}) {
  const src = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const ctx = vm.createContext({
    console, JSON, Number,
    ...sandbox,
  });
  vm.runInContext(stripped, ctx);
  return ctx;
}

const ctx = loadEsmAsSandbox('../../shinkansen/lib/rate-limit-init-log-dedup.js');
const { shouldLogInit } = ctx;

const SAMPLE_PAYLOAD = {
  tier: 'tier1',
  model: 'gemini-3-flash-preview',
  rpm: 2000, tpm: 4000000, rpd: 50000,
  safetyMargin: 0.1,
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('shouldLogInit', () => {
  test('prev=null/undefined 第一次 init → 寫 log', () => {
    expect(shouldLogInit(null, Date.now(), SAMPLE_PAYLOAD)).toBe(true);
    expect(shouldLogInit(undefined, Date.now(), SAMPLE_PAYLOAD)).toBe(true);
  });

  test('同 payload + 24h 內 → 跳過(dedup)', () => {
    const now = 1_700_000_000_000;
    const prev = { payload: { ...SAMPLE_PAYLOAD }, timestamp: now - 5 * HOUR };
    expect(shouldLogInit(prev, now, SAMPLE_PAYLOAD)).toBe(false);
    // 邊界:23:59:59 仍 dedup
    const prev2 = { payload: { ...SAMPLE_PAYLOAD }, timestamp: now - DAY + 1000 };
    expect(shouldLogInit(prev2, now, SAMPLE_PAYLOAD)).toBe(false);
  });

  test('payload 變化(tier 切換)→ 即使 < 24h 仍寫', () => {
    const now = 1_700_000_000_000;
    const prev = { payload: { ...SAMPLE_PAYLOAD, tier: 'free' }, timestamp: now - 1 * HOUR };
    expect(shouldLogInit(prev, now, SAMPLE_PAYLOAD)).toBe(true);
  });

  test('payload 變化(model 換)→ 寫', () => {
    const now = 1_700_000_000_000;
    const prev = { payload: { ...SAMPLE_PAYLOAD, model: 'gemini-3-pro-preview' }, timestamp: now - 30_000 };
    expect(shouldLogInit(prev, now, SAMPLE_PAYLOAD)).toBe(true);
  });

  test('payload 變化(rpm/tpm/rpd 任一動)→ 寫', () => {
    const now = 1_700_000_000_000;
    const base = { payload: SAMPLE_PAYLOAD, timestamp: now - 30_000 };
    expect(shouldLogInit(base, now, { ...SAMPLE_PAYLOAD, rpm: 9999 })).toBe(true);
    expect(shouldLogInit(base, now, { ...SAMPLE_PAYLOAD, tpm: 9999 })).toBe(true);
    expect(shouldLogInit(base, now, { ...SAMPLE_PAYLOAD, rpd: 9999 })).toBe(true);
    expect(shouldLogInit(base, now, { ...SAMPLE_PAYLOAD, safetyMargin: 0.2 })).toBe(true);
  });

  test('同 payload + 24h 過期 → 寫(刷新)', () => {
    const now = 1_700_000_000_000;
    const prev = { payload: { ...SAMPLE_PAYLOAD }, timestamp: now - DAY };
    expect(shouldLogInit(prev, now, SAMPLE_PAYLOAD)).toBe(true);
    const prev2 = { payload: { ...SAMPLE_PAYLOAD }, timestamp: now - 2 * DAY };
    expect(shouldLogInit(prev2, now, SAMPLE_PAYLOAD)).toBe(true);
  });

  test('prev.timestamp 缺漏(舊版 storage 殘料)→ 視為 0,過期 24h 寫', () => {
    const prev = { payload: { ...SAMPLE_PAYLOAD } }; // 無 timestamp
    expect(shouldLogInit(prev, 1_700_000_000_000, SAMPLE_PAYLOAD)).toBe(true);
  });
});
