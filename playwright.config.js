// Shinkansen 自動化測試的 Playwright 設定
// 注意事項（MV3 extension 的地雷）：
//   1. 必須用 launchPersistentContext，普通 launch() 載不了 extension
//   2. Playwright 的 headless: true（舊 headless）會 disable service worker，
//      所以走 Chrome 原生 --headless=new（見 test/fixtures/extension.js，
//      v1.5.2 起預設；SHINKANSEN_HEADED=1 切回 headed）
//   3. workers 鎖 1 不是隔離問題（fixture 用 mkdtemp 各自獨立 user data dir，
//      平行在原理上安全），是實測沒收益：2026-06-11 在 8 核 16GB 上拿 12 個
//      detect spec 對照，workers=4 只從 30.3s 縮到 26.3s（1.15 倍），且每條
//      test 時間從 ~1.2s 膨脹到 3.3–6.4s（多個 Chromium 多進程互搶 CPU）。
//      suite 內有 200+ 處固定 waitForTimeout，test 時間膨脹會侵蝕時序餘裕、
//      把穩定的 suite 推向 flaky。除非換更多核的機器重測，不要調高。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // jest-unit/ 由 jest.config.cjs 跑，不進 Playwright
  testIgnore: ['**/jest-unit/**'],
  // 平行化實測無收益（理由見檔頭第 3 點），維持單 worker
  workers: 1,
  fullyParallel: false,
  // 探查工具，不重試
  retries: 0,
  // Wikipedia 在台灣有時較慢，給寬一點
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // 預設不擷圖、不錄影；個別 spec 需要時自行開
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
