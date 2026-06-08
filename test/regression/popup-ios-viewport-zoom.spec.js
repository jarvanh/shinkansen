// Regression: iOS popup viewport / 放大撐滿（v1.10.22 viewport meta + 寫死 zoom，
// 本輪改 popup.js 動態 zoom）。
//
// Bug 歷程：
//   1. v1.10.22 前：popup.html 沒 viewport meta → iOS WebKit 用 ~980px 桌面虛擬
//      viewport，固定 280px body 縮在 sheet 左側（SPEC-PRIVATE §26.7）
//   2. v1.10.22：加 meta + popup.css `body.runtime-ios` zoom 1.5 / media query
//      (min-width: 350) 降 1.435（= 402 / 280）——只在 402pt 寬機型剛好撐滿
//   3. 本輪：430 / 440pt 寬機型（Pro Max 級）右側留 ~38pt 白 → popup.js 依
//      window.innerWidth 動態算 zoom = 寬 / 280（applyIosZoom，初跑 + resize
//      重算；module 初跑時 iOS sheet 還沒定尺寸，innerWidth 不可靠）
//
// 訊號層次：本 spec 驗（a）popup.html viewport meta 存在（整條 iOS 縮放修正的
// 根本）（b）popup.css 的 runtime-ios zoom fallback 規則在真實 render 下生效
// （寬 viewport 套 1.435、窄 viewport 套 1.5,body 維持 280px）（c）popup.js
// 內 applyIosZoom 動態 zoom 結構存在（source 結構 forcing function：初跑 +
// resize listener + / 280 公式）。
// 不驗：iOS WebKit 對 zoom / viewport meta 的實際渲染與 sheet 尺寸時序
// （IS_IOS_BUILD=false 的 repo source 在 Chromium 不會跑 applyIosZoom，且
// desktop extension popup 一律忽略 viewport meta）——這層只能 iOS Simulator /
// 真機驗，sim 驗證紀錄見 SPEC-PRIVATE §26.7（iPhone 17 Pro Max 440pt 按鈕
// 左右邊距 96px / 96px 對稱 + iPad Pro 11" popover 1.5x 無換行）。
//
// SANITY 紀錄（已驗證 2026-06-07）:
//   1. 拿掉 popup.html viewport meta →（a）fail；還原 → pass。
//   2. comment 掉 popup.css `@media (min-width: 350px)` 的 zoom 1.435 →（b）
//      寬 viewport 斷言 fail（computed zoom 1.5）；還原 → pass。
//   3. 把 popup.js applyIosZoom 的 resize listener 行換掉 →（c）fail；還原 → 全綠。

import { test, expect } from '../fixtures/extension.js';

test('popup.html 有 viewport meta（iOS sheet 縮左修正的根本）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const content = await page.getAttribute('meta[name="viewport"]', 'content');
  expect(content).toContain('width=device-width');
});

test('body.runtime-ios-touch 寬 viewport 套 zoom 1.435 fallback、窄 viewport 套 1.5,body 固定 280px', async ({ context, extensionId }) => {
  const page = await context.newPage();

  // 寬 viewport（iPhone sheet 級，≥ 350）:media query 命中 → 1.435。
  // 放大規則掛 runtime-ios-touch（真觸控裝置）；iOS build 跑在 Mac 只加 runtime-ios
  // 不加 -touch → 不放大（見 lib/platform.js）
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.evaluate(() => document.body.classList.add('runtime-ios-touch'));
  const wide = await page.evaluate(() => ({
    zoom: getComputedStyle(document.body).zoom,
    width: getComputedStyle(document.body).width,
  }));
  expect(parseFloat(wide.zoom)).toBeCloseTo(1.435, 3);
  // zoom 下 computed width 有次像素 rounding（實測 279.998px），容差 ±0.5
  expect(parseFloat(wide.width)).toBeCloseTo(280, 0);

  // 窄 viewport（iPad popover 級，< 350）:base 規則 → 1.5
  await page.setViewportSize({ width: 280, height: 700 });
  const narrow = await page.evaluate(() => getComputedStyle(document.body).zoom);
  expect(parseFloat(narrow)).toBeCloseTo(1.5, 3);
});

test('popup.js 有 applyIosZoom 動態 zoom 結構（初跑 + resize 重算 + / 280 公式）', async ({ context, extensionId }) => {
  // iOS WebKit 實際 zoom 行為 Chromium 驗不到（IS_IOS_BUILD gate + WebKit 渲染）,
  // 這條鎖 source 結構當 forcing function：誤刪 applyIosZoom / resize listener
  // 會在這裡 fail，提醒去 SPEC-PRIVATE §26.7 看 sim 驗證流程
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const src = await page.evaluate(async () => {
    const r = await fetch('popup.js');
    return r.text();
  });
  expect(src).toContain('applyIosZoom');
  expect(src).toMatch(/addEventListener\('resize',\s*applyIosZoom\)/);
  expect(src).toMatch(/vw \/ 280/);
});
