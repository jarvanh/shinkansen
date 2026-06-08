// Regression / forcing function: iOS 觸控版 popup(runtime-ios-touch,zoom 1.35)在
// YouTube 頁全展開時高度必須壓在 iPad mini 直立 popover 上限下(v1.10.37)。
//
// 根因:觸控版把桌面 ~600px 上限調校過的版面整體 zoom 1.35 放大。YouTube 頁多出三列
// (YouTube 字幕翻譯 / 字幕雙語對照 / 字幕大小),全展開後 scaled 高度 ~629px,超過
// iPad mini 直立 popover 高度上限 → footer(設定 + 操作提示)被切、需捲動(Jimmy 實機回報)。
//
// 修法:popup.css 只壓 body.runtime-ios-touch 的垂直節奏(main / .row / .display-mode-row
// / .cache-row / .status / button.primary / footer 的 margin / padding),不動字級
// (zoom / --sk-fz 保留 → 可讀性不變),水平 16px 不動(保對齊 grid)。修前 629 → 修後 528px。
//
// 訊號層次(CLAUDE.md 工作流原則 §3):
//   驗:加上 runtime-ios + runtime-ios-touch + zoom 1.35,且 un-hide YouTube 頁三列
//       (yt-subtitle-row / bilingual-row / yt-caption-size-row)後的真實 rendered
//       高度 ≤ 560px。
//   不驗:iPad mini 真實 Safari popover 的逐 px 上限——Chromium ≠ WebKit,本條只鎖
//       「我們的觸控版版面高度有壓進保守門檻」,不鎖各機型 popover 上限精確值。
//       真機(iPad mini)footer 不被切的最終驗收靠 Jimmy 實機(harness 無法重現
//       iOS popover sizing,CLAUDE.md §11 已列為盲區)。
//   也不驗:welcome-banner / update-banner 兩條一次性提示橫幅(非穩態設定面板)。
//
// SANITY 紀錄(已驗證 2026-06-09):
//   暫時把修法 block 的 .row margin-top 從 5px 改回 10px(等同未修)→ 629px > 560 fail;
//   還原 5px → 528px pass。

import { test, expect } from '../fixtures/extension.js';

// 觸控版在 @media (min-width: 350px) 走 width:auto(max 480),給足寬度量自然高度
const VIEWPORT_W = 480;
// YouTube 頁實際多出的三列(非 Drive——YT vs Drive 互斥,不疊算)
const YT_ROW_IDS = ['yt-subtitle-row', 'bilingual-row', 'yt-caption-size-row'];

test('iOS 觸控版 popup(zoom 1.35)YouTube 頁全展開高度 ≤ 560px,壓在 iPad mini popover 上限下', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: VIEWPORT_W, height: 1200 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const height = await page.evaluate((ids) => {
    // 模擬 iOS 觸控 build:popup.js 在 IS_IOS_BUILD + 觸控裝置時掛這兩個 class,
    // 測試 build(chrome)IS_IOS_BUILD=false 不會自動掛 → 手動加以重現觸控版面
    document.body.classList.add('runtime-ios', 'runtime-ios-touch');
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    });
    return Math.round(document.body.getBoundingClientRect().height);
  }, YT_ROW_IDS);

  expect(height).toBeLessThanOrEqual(560);
});
