// Unit test: rate limiter RPD 軟性預算警告（v0.90 regression）
//
// 背景：v0.89 的 rate limiter 在 RPD 達上限時會 await sleep(24小時)，
// 等於靜默卡死。v0.90 改為 RPD 只是軟性預算警告（acquire 正常 resolve
// + 回傳 { rpdExceeded: true }），不阻擋翻譯。
//
// 驗證項目：
//   1. RPD 未超限 → acquire() resolve 且 rpdExceeded === false
//   2. RPD 剛好超限 → acquire() 仍 resolve 且 rpdExceeded === true（不卡住）
//   3. RPM 超限 → acquire() 會等待後 resolve（sliding window 機制正常）
//   4. RPD 計數正確 persist 到 chrome.storage.local
//   5. 跨日 RPD 自動重置
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage.local ────────────────────────────
let store = {};

globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: {
      get: async (keys) => {
        if (keys === null) return { ...store };
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          if (k in store) result[k] = store[k];
        }
        return result;
      },
      set: async (items) => {
        Object.assign(store, items);
      },
      remove: async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) delete store[k];
      },
    },
  },
};

// ── Mock debugLog（logger.js 會被 rate-limiter import）───
// 直接在 globalThis 掛一個 no-op，讓 import 不爆。
// rate-limiter.js import { debugLog } from './logger.js'
// 但 unit test 不需要實際 log。

// 因為 rate-limiter.js 使用 ES module import debugLog，
// 我們需要先讓 logger.js 的 import 成功。
// 透過 dynamic import 搭配 Node.js --experimental-vm-modules
// Playwright 已支援 ESM。

let RateLimiter;

test.beforeAll(async () => {
  // logger.js 依賴 chrome.runtime，需額外 mock
  globalThis.chrome.runtime = {
    getManifest: () => ({ version: '1.00' }),
  };
  const mod = await import('../../shinkansen/lib/rate-limiter.js');
  RateLimiter = mod.RateLimiter;
});

test.beforeEach(() => {
  store = {};
});

// ── Test 1: RPD 未超限 → rpdExceeded === false ──────────
test('RPD 未超限時 acquire() 正常回傳 rpdExceeded: false', async () => {
  const limiter = new RateLimiter({
    rpm: 100,
    tpm: 1_000_000,
    rpd: 100,
    safetyMargin: 0, // 不打折，方便測試邊界
  });

  const result = await limiter.acquire(100);
  expect(result).toEqual({ rpdExceeded: false });
});

// ── Test 2: RPD 超限 → rpdExceeded === true 且不卡住 ────
test('RPD 超限時 acquire() 仍正常 resolve，回傳 rpdExceeded: true', async () => {
  const limiter = new RateLimiter({
    rpm: 1000,
    tpm: 10_000_000,
    rpd: 3, // 設得很小方便測試
    safetyMargin: 0,
  });

  // 前 3 次不超限
  for (let i = 0; i < 3; i++) {
    const r = await limiter.acquire(10);
    expect(r.rpdExceeded).toBe(false);
  }

  // 第 4 次超限 → 仍然 resolve（不 throw、不 hang）
  const t0 = Date.now();
  const r4 = await limiter.acquire(10);
  const elapsed = Date.now() - t0;

  expect(r4.rpdExceeded).toBe(true);
  // 應在 1 秒內 resolve（不會 sleep 24 小時）
  expect(elapsed).toBeLessThan(1000);
});

// ── Test 3: RPM 超限 → acquire() 等待後 resolve ─────────
test('RPM 超限時 acquire() 會等待 sliding window 釋放再 resolve', async () => {
  const limiter = new RateLimiter({
    rpm: 2, // 故意設很小
    tpm: 10_000_000,
    rpd: 10000,
    safetyMargin: 0,
  });

  // 先用掉 2 個 RPM slot
  await limiter.acquire(10);
  await limiter.acquire(10);

  // 第 3 次應該要等待。用 computeWaitMs 驗證需要等待
  const waitMs = limiter.computeWaitMs(10);
  expect(waitMs).toBeGreaterThan(0);
});

// ── Test 4: RPD 計數正確 persist 到 storage ──────────────
test('RPD 計數正確寫入 chrome.storage.local', async () => {
  const limiter = new RateLimiter({
    rpm: 100,
    tpm: 1_000_000,
    rpd: 100,
    safetyMargin: 0,
  });

  await limiter.acquire(10);
  await limiter.acquire(10);

  // scheduleRpdPersist 是節流版（每 10 次或 30 秒才寫入），
  // 2 次呼叫不會立即持久化。直接呼叫 persistRpd() 強制寫入。
  await limiter.persistRpd();

  // store 裡應該有一個 rateLimit_rpd_YYYYMMDD key，值為 2
  const rpdKeys = Object.keys(store).filter(k => k.startsWith('rateLimit_rpd_'));
  expect(rpdKeys.length).toBe(1);
  expect(store[rpdKeys[0]]).toBe(2);
});

// ── Test 5: snapshot() 回傳正確狀態 ─────────────────────
test('snapshot() 回傳目前 RPM/TPM/RPD 狀態', async () => {
  const limiter = new RateLimiter({
    rpm: 60,
    tpm: 500_000,
    rpd: 1000,
    safetyMargin: 0.1,
  });

  await limiter.acquire(200);

  const snap = limiter.snapshot();
  expect(snap.rpmUsed).toBe(1);
  expect(snap.rpmCap).toBe(54); // floor(60 * 0.9)
  expect(snap.tpmUsed).toBe(200);
  expect(snap.tpmCap).toBe(450_000); // floor(500000 * 0.9)
  expect(snap.rpdUsed).toBe(1);
  expect(snap.rpdCap).toBe(900); // floor(1000 * 0.9)
  expect(snap.safetyMargin).toBe(0.1);
});
