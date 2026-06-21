// Regression: toast host 改用 visual viewport 定位（修 iOS Safari fixed 元素在
// 捲動 / 網址列收合 / 雙指縮放後 toast 跑到可見區外、看不到的問題）
//
// Fixture: test/regression/fixtures/toast-viewport-host.html
// 結構：任意頁面即可——#shinkansen-toast-host 由 content-toast.js 載入時自動建立。
// Bug：toast 內層 .toast 原本 position:fixed，相對 layout viewport 定位，不跟
//      visual viewport 走。iOS Safari 上閱讀一段時間後（捲動 / 工具列收合 / 縮放）
//      toast 被定位到可見區外，使用者看不到 toast（但翻譯本身正常）。
// 修法：host 改成「覆蓋 visual viewport 的 fixed 容器」，由 syncViewportBox() 依
//      window.visualViewport 同步 left/top/width/height；內層 .toast 改 absolute
//      錨在 host 上。host pointer-events:none 不擋頁面點擊，.toast 設回 auto。
//
// ── 這條 spec 驗哪一層 / 不驗哪一層（CLAUDE.md §3）──────────────────────────
//   驗：host 的「wiring」——載入後 host 確實被同步成 visual viewport 大小、
//       position:fixed、pointer-events:none（= 不擋頁面點擊的結構前提）。
//   不驗：iOS Safari 真機上「toast 回到可見邊角」這個視覺症狀——Playwright
//       Chromium 的 visualViewport offset 不會像 iOS 那樣偏移，無法在 harness
//       重現。該層由桌面截圖（toast 右下角正常顯示 + elementFromPoint 穿透）
//       + iPhone 實機驗收涵蓋，不在本 spec 範圍。
//
// SANITY 紀錄（已驗證）：
//   把 content-toast.js 的初始 `syncViewportBox();` 呼叫註解掉 → host.style.width
//   停在 '0px'（cssText 初值），第一條 width 斷言 fail；還原後 pass。
//   另把 host cssText 的 `pointer-events: none` 拿掉 → pointerEvents 斷言 fail；
//   還原後 pass。

import { test, expect } from '../fixtures/extension.js';

test('toast-viewport-host: host 同步成 visual viewport 大小 + pointer-events:none', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/toast-viewport-host.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#target', { timeout: 10_000 });

  // host 在 content-toast.js 載入時同步建立 + syncViewportBox()。輪詢等它就緒
  // （extension content-script 注入相對頁面 load 有微小延遲）。
  const start = Date.now();
  let host = null;
  while (Date.now() - start < 5000) {
    host = await page.evaluate(() => {
      const h = document.getElementById('shinkansen-toast-host');
      if (!h) return null;
      const cs = window.getComputedStyle(h);
      return {
        width: h.style.width,
        height: h.style.height,
        pointerEvents: h.style.pointerEvents,
        position: cs.position,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        vvW: Math.round(window.visualViewport?.width ?? -1),
        vvH: Math.round(window.visualViewport?.height ?? -1),
      };
    });
    if (host && host.width && host.width !== '0px') break;
    await page.waitForTimeout(50);
  }

  expect(host).not.toBeNull();
  // 被同步成 visual viewport 大小（非初始 '0px'），桌面下 vv ≈ innerWidth/Height
  expect(host.width).not.toBe('0px');
  expect(host.width).toBe(host.vvW + 'px');
  expect(host.height).toBe(host.vvH + 'px');
  // 結構前提：fixed 容器 + pointer-events:none（覆蓋全螢幕也不擋頁面點擊）
  expect(host.position).toBe('fixed');
  expect(host.pointerEvents).toBe('none');

  // pointer-events:none 的實際效果：host 覆蓋的區域，elementFromPoint 應穿透到
  // 頁面元素，不會回傳 toast host（= 不攔截頁面點擊）。
  const hitsHost = await page.evaluate(() => {
    const el = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    );
    return el?.id === 'shinkansen-toast-host';
  });
  expect(hitsHost).toBe(false);

  await page.close();
});
