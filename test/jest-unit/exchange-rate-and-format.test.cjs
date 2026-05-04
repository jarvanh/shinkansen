'use strict';

/**
 * v1.8.41 unit:lib/format.js 的 formatTWD / formatMoney + lib/exchange-rate.js 的
 * fetch / cache fallback 路徑。
 *
 * 為什麼這條 spec 存在：
 *   - formatTWD 邊界值（0、極小值用 3 位小數、一般值一位小數）寫死在 source 內，容易
 *     被未來改 toFixed 改壞。spec 鎖死「< 0.1 NT$ 用 3 位、其他用 1 位」邏輯。
 *   - exchange-rate.js 的 fallback 三層（fresh fetch → cached → fallback 31.6）是
 *     安全網，不能被靜默拆掉——使用者離線 / API 故障時 popup 顯示「NaN」就是 fallback
 *     斷掉的徵兆。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// format.js / exchange-rate.js 是 ES module,jest cjs 環境不能直接 require 也不能
// dynamic import（會跳 --experimental-vm-modules 錯誤）。改用 vm.runInNewContext
// 在自建 sandbox 裡跑 source(strip `export` 把 named export 換成 sandbox 上的賦值）。
//
// 這個 pattern 跟 helpers/create-env.cjs 一樣——讀 source 字串 + eval 進可控 context。
function loadEsmAsSandbox(relPath, sandbox = {}) {
  const src = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
  // 剝掉 import / export keyword:
  //   import — 直接刪（由 sandbox 注入 browser / debugLog 等替身）
  //   export const/let — 換成 `var` (vm.runInNewContext 中 const/let 是 block-scoped,
  //                       不掛上 context object;var 才會掛，讓 spec 能讀到 FALLBACK_USD_TWD_RATE)
  //   export function — 留 function 即可（hoisted 到 context)
  const stripped = src
    .replace(/^import\s+[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(const|let)\s+/gm, 'var ')
    .replace(/^export\s+(function|async\s+function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, AbortController,
    Promise, Date, Number, String, Object, Array, Math, JSON,
    ...sandbox,
  });
  vm.runInNewContext(stripped, ctx, { filename: relPath });
  return ctx;
}

function loadFormat() {
  return loadEsmAsSandbox('../../shinkansen/lib/format.js');
}

describe('v1.8.41 formatTWD', () => {
  let format;
  beforeAll(() => { format = loadFormat(); });

  test('0 USD → NT$ 0（無小數）', () => {
    expect(format.formatTWD(0, 31.6)).toBe('NT$ 0');
  });

  test('極小值 < NT$ 0.1 用 3 位小數避免顯示 0.0', () => {
    // 0.001 USD × 31.6 = 0.0316 TWD < 0.1 → 'NT$ 0.032'
    const out = format.formatTWD(0.001, 31.6);
    expect(out).toMatch(/^NT\$ 0\.0\d{2}$/);
  });

  test('一般金額用一位小數', () => {
    // 0.01 USD × 31.6 = 0.316 TWD ≥ 0.1 → 'NT$ 0.3'
    expect(format.formatTWD(0.01, 31.6)).toBe('NT$ 0.3');
    // 1 USD × 31.6 = 31.6 TWD → 'NT$ 31.6'
    expect(format.formatTWD(1, 31.6)).toBe('NT$ 31.6');
    // 5.5 USD × 32 = 176 TWD → 'NT$ 176.0'
    expect(format.formatTWD(5.5, 32)).toBe('NT$ 176.0');
  });
});

describe('v1.8.41 formatMoney dispatcher', () => {
  let format;
  beforeAll(() => { format = loadFormat(); });

  test('預設（無 opts）走 USD 路徑', () => {
    expect(format.formatMoney(1.5)).toBe('$1.50');
  });

  test('currency=USD 走 formatUSD', () => {
    expect(format.formatMoney(0.005, { currency: 'USD' })).toBe('$0.0050');
  });

  test('currency=TWD 走 formatTWD，套上 rate', () => {
    expect(format.formatMoney(1, { currency: 'TWD', rate: 31.6 })).toBe('NT$ 31.6');
  });

  test('currency=TWD 但無 rate（意外狀態）→ 不爆，走 rate=0 顯示 NT$ 0', () => {
    // 防禦性：未來呼叫端忘記傳 rate 不應該丟例外讓 toast 整條炸掉
    expect(format.formatMoney(5, { currency: 'TWD' })).toBe('NT$ 0');
  });
});

describe('v1.8.41 exchange-rate getCachedRate fallback', () => {
  // exchange-rate.js 用 ./compat.js 拿 browser global + ./logger.js 的 debugLog,
  // 兩個 import 都被 loadEsmAsSandbox 剝掉，改 sandbox 注入。
  let exchangeRate;
  let fakeStore;
  let fakeFetch;

  beforeAll(() => {
    fakeStore = new Map();
    const browser = {
      storage: {
        local: {
          get: (keys) => Promise.resolve((() => {
            if (typeof keys === 'string') {
              return fakeStore.has(keys) ? { [keys]: fakeStore.get(keys) } : {};
            }
            return {};
          })()),
          set: (obj) => Promise.resolve(Object.entries(obj).forEach(([k, v]) => fakeStore.set(k, v))),
          remove: (key) => Promise.resolve(fakeStore.delete(key)),
        },
      },
    };
    const debugLog = () => {};
    fakeFetch = (...args) => globalThis.__nextFetch?.(...args);
    exchangeRate = loadEsmAsSandbox('../../shinkansen/lib/exchange-rate.js', {
      browser, debugLog, fetch: fakeFetch,
    });
  });

  beforeEach(() => {
    fakeStore.clear();
  });

  test('cache 不存在 → 走 fallback 31.6', async () => {
    const r = await exchangeRate.getCachedRate();
    expect(r.rate).toBe(31.6);
    expect(r.source).toBe('fallback');
    expect(r.fetchedAt).toBe(0);
  });

  test('cache 存在且 rate 合法 → 回 cached', async () => {
    fakeStore.set('exchangeRate', {
      rate: 32.45,
      fetchedAt: 1700000000000,
      source: 'open.er-api',
    });
    const r = await exchangeRate.getCachedRate();
    expect(r.rate).toBe(32.45);
    expect(r.source).toBe('open.er-api');
    expect(r.fetchedAt).toBe(1700000000000);
  });

  test('cache 損毀（rate=NaN)→ 走 fallback，不傳染壞資料給上游', async () => {
    fakeStore.set('exchangeRate', {
      rate: NaN,
      fetchedAt: Date.now(),
      source: 'open.er-api',
    });
    const r = await exchangeRate.getCachedRate();
    expect(r.rate).toBe(31.6);
    expect(r.source).toBe('fallback');
  });

  test('FALLBACK_USD_TWD_RATE 常數 = 31.6（專案約定值，不可未經同意修改）', () => {
    expect(exchangeRate.FALLBACK_USD_TWD_RATE).toBe(31.6);
  });

  test('isCacheFresh:fetchedAt 在 24h 內 → true', async () => {
    fakeStore.set('exchangeRate', {
      rate: 31.5,
      fetchedAt: Date.now() - 1000,
      source: 'open.er-api',
    });
    const fresh = await exchangeRate.isCacheFresh();
    expect(fresh).toBe(true);
  });

  test('isCacheFresh:fetchedAt 超過 24h → false', async () => {
    fakeStore.set('exchangeRate', {
      rate: 31.5,
      fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      source: 'open.er-api',
    });
    const fresh = await exchangeRate.isCacheFresh();
    expect(fresh).toBe(false);
  });

  test('isCacheFresh:cache 不存在 → false（觸發 alarm 主動 refetch)', async () => {
    const fresh = await exchangeRate.isCacheFresh();
    expect(fresh).toBe(false);
  });
});

describe('v1.8.41 exchange-rate fetchUsdTwdRate', () => {
  let exchangeRate;
  let fakeStore;

  beforeAll(() => {
    fakeStore = new Map();
    const browser = {
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
        },
      },
    };
    const debugLog = () => {};
    const fetchProxy = (...args) => globalThis.__nextFetch(...args);
    exchangeRate = loadEsmAsSandbox('../../shinkansen/lib/exchange-rate.js', {
      browser, debugLog, fetch: fetchProxy,
    });
  });

  test('open.er-api 200 + result=success + 合法 rate → 回 number', async () => {
    globalThis.__nextFetch = () => Promise.resolve({
      ok: true,
      json: async () => ({ result: 'success', rates: { TWD: 32.123 } }),
    });
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBe(32.123);
  });

  test('open.er-api HTTP 500 → 回 null（呼叫端走 fallback)', async () => {
    globalThis.__nextFetch = () => Promise.resolve({ ok: false, status: 500 });
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBeNull();
  });

  test('網路錯誤（fetch reject)→ 回 null', async () => {
    globalThis.__nextFetch = () => Promise.reject(new Error('network down'));
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBeNull();
  });

  test('result != success → 回 null（API 自報失敗）', async () => {
    globalThis.__nextFetch = () => Promise.resolve({
      ok: true,
      json: async () => ({ result: 'error', 'error-type': 'unknown-code' }),
    });
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBeNull();
  });

  test('JSON 結構異常（rates.TWD 缺失）→ 回 null', async () => {
    globalThis.__nextFetch = () => Promise.resolve({
      ok: true,
      json: async () => ({ result: 'success', rates: {} }),
    });
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBeNull();
  });

  test('rate 不合法（0 或負數）→ 回 null', async () => {
    globalThis.__nextFetch = () => Promise.resolve({
      ok: true,
      json: async () => ({ result: 'success', rates: { TWD: 0 } }),
    });
    const rate = await exchangeRate.fetchUsdTwdRate();
    expect(rate).toBeNull();
  });
});
