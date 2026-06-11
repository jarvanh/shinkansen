// Unit test: RateLimiter estTokens >= tpmCap 不得永久 sleep loop(v1.10.46 批次 2-1)
//
// 原 bug:computeWaitMs 的 TPM 檢查在 estTokens 單獨就超過 tpmCap 時(使用者設了極小
// 的 tpmOverride、或單批估算特大),「等視窗釋放」永遠湊不出足夠空間——視窗全空仍是
// `0 + est > cap` → 走「released < needToRelease」分支回 WINDOW_MS + 5 → acquire sleep
// 60 秒後重算結果相同 → 無限等待、不報錯、翻譯永久卡住。
//
// 修法:TPM 檢查開頭加 guard——estTokens >= tpmCap 時改成「等視窗清空即放行」
// (超量讓 API 端 429 把關,fetchWithRetry 有退避兜底),放行前記一條 warn。
//
// 429 Retry-After cap(同批 2-1 另一半)以 source 斷言鎖在本檔下半。
//
// SANITY 紀錄(已驗證,2026-06-11):暫時把 computeWaitMs 的
// `if (estTokens >= this.tpmCap)` guard 整段註解掉 → 「空視窗應立即放行」與
// 「視窗內有舊 entry 應等到它過期,不是固定 WINDOW_MS+5」兩 case fail → 還原 → pass。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// stub chrome storage(RateLimiter 間接 import logger/compat 需要 chrome)
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

const { RateLimiter } = await import('../../shinkansen/lib/rate-limiter.js');

// safetyMargin 0 → tpmCap = tpm,數字好算
function makeLimiter() {
  return new RateLimiter({ rpm: 100, tpm: 1000, rpd: 10000, safetyMargin: 0 });
}

test('estTokens >= tpmCap + 空視窗 → computeWaitMs 回 0(立即放行,不再無限等)', () => {
  const lim = makeLimiter();
  expect(lim.tpmCap).toBe(1000);
  // 原 bug:這裡回 WINDOW_MS + 5 = 60005,且永遠不會變小
  expect(lim.computeWaitMs(5000)).toBe(0);
});

test('estTokens >= tpmCap + 視窗內有舊 entry → 等到視窗清空,不是固定 WINDOW_MS+5', () => {
  const lim = makeLimiter();
  const now = Date.now();
  // 30 秒前的 entry,30 秒後過期 → 預期 wait ≈ 30000 + 5
  lim.tokens.push({ t: now - 30_000, n: 500 });
  lim._tokenSum += 500;
  const wait = lim.computeWaitMs(5000);
  expect(wait).toBeGreaterThan(25_000);
  expect(wait).toBeLessThan(35_000); // 原 bug 固定回 60005
});

test('estTokens >= tpmCap 不豁免 RPM 上限(RPM 滿仍要等)', () => {
  const lim = new RateLimiter({ rpm: 2, tpm: 1000, rpd: 10000, safetyMargin: 0 });
  const now = Date.now();
  lim.requests.push(now - 1000, now - 500); // RPM 已滿
  const wait = lim.computeWaitMs(5000);
  expect(wait).toBeGreaterThan(0);
});

test('acquire(estTokens >= tpmCap) 空視窗下直接 resolve(整條 acquire 路徑不卡)', async () => {
  const lim = makeLimiter();
  const t0 = Date.now();
  const r = await lim.acquire(5000);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(r).toHaveProperty('rpdExceeded');
});

test('一般情況(estTokens < tpmCap)行為不變:視窗有空間立即放行、不足時等部分釋放', () => {
  const lim = makeLimiter();
  expect(lim.computeWaitMs(800)).toBe(0);
  const now = Date.now();
  lim.tokens.push({ t: now - 10_000, n: 600 });
  lim._tokenSum += 600;
  // 600 + 800 > 1000 → 等 10 秒前那筆過期(約 50 秒後)
  const wait = lim.computeWaitMs(800);
  expect(wait).toBeGreaterThan(45_000);
  expect(wait).toBeLessThan(55_000);
});

// ── 2-1 後半:429 Retry-After 等待上限(source 斷言)──
//
// provider 可能回數百秒的 Retry-After,MV3 SW 等不到那麼久(30 秒 idle 即可能被回收),
// 無上限等待等於永久卡批次。cap 在 30s,等完仍 429 走 maxRetries 放棄。
// 行為測試需真等 30s+,不適合 unit test,改鎖 source 結構(同 fetch-timeout spec 前例)。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

for (const lib of ['gemini', 'openai-compat']) {
  test(`${lib}.js: 429 Retry-After 等待有 RETRY_AFTER_CAP_MS = 30_000 上限`, () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, `../../shinkansen/lib/${lib}.js`), 'utf-8',
    );
    expect(
      SRC,
      `${lib}.js 缺 \`const RETRY_AFTER_CAP_MS = 30_000\``,
    ).toMatch(/const\s+RETRY_AFTER_CAP_MS\s*=\s*30_000\s*;/);
    expect(
      SRC,
      `${lib}.js 的 Retry-After 等待缺 Math.min(..., RETRY_AFTER_CAP_MS) cap`,
    ).toMatch(/Math\.min\s*\(\s*retryAfterSec\s*\*\s*1000\s*\+\s*100\s*,\s*RETRY_AFTER_CAP_MS\s*\)/);
  });
}
