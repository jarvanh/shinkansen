// Regression: iOS 四指 tap 觸發翻譯 toggle(content-touch.js,SPEC-PRIVATE §26.1)
//
// 行為:四指同時輕點(tap)= Alt+S 完整 toggle。手勢偵測在 content-touch.js
// (isolated world),命中後送 FOUR_FINGER_TAP 給 background,由 background 轉發
// TRANSLATE_PRESET slot 2(跟 commands onCommand 的 Alt+S 同一條派送路徑)。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗「synthetic TouchEvent → content-touch 手勢判定 → background FOUR_FINGER_TAP
//   relay → TRANSLATE_PRESET onMessage → handleTranslatePreset → SK.translatePage」
//   整條跨 isolated world + service worker 的真實訊息路徑,以及 IS_IOS_BUILD gate、
//   swipe / 五指 / 長按三種不該觸發的手勢分支。
//   不驗:真實 iOS Safari 的 touch 事件派發行為與 iPadOS 系統手勢搶占(Playwright
//   Chromium 無法模擬,Phase 3 真機驗收)、translatePage 後續翻譯流程(其他 spec 鎖)。
//
// SANITY CHECK 紀錄(已驗證,2026-06-05):
//   暫時把 content-touch.js 的 isEnabled() 改成永遠回 false → 「四指 tap →
//   translatePage(slot 2)」case fail(0 call),還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'ios-four-finger-tap';

// 在 page main world 派發 synthetic touch 手勢。
// content-touch.js 的 listener 掛在 isolated world 的 window 上,但 DOM 事件
// 跨 world 共享,main world dispatch 的 TouchEvent 兩邊都收得到。
const DISPATCH_HELPERS = `
  window.__mkTouches = (n, dx = 0) => Array.from({ length: n }, (_, i) =>
    new Touch({ identifier: i, target: document.body, clientX: 100 + i * 30 + dx, clientY: 200 }));
  window.__touch = (type, touches) =>
    window.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true }));
`;

async function setupPage(context, localServer, { iosBuild }) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  if (iosBuild) {
    // 模擬 iOS build:distribution-cs.js 在 iOS build 被 safari-build-ios.sh
    // override 成 true。content-touch.js 的 isEnabled() 動態讀,runtime 翻 flag 即生效。
    await evaluate(`window.__SK.IS_IOS_BUILD = true`);
  }
  // Stub 掉 translatePage:本 spec 只鎖「手勢 → preset 派送」路徑,
  // 不讓真實翻譯流程(API call / toast)跑起來
  await evaluate(`
    window.__tapCalls = [];
    window.__SK.translatePage = (opts) => { window.__tapCalls.push(opts || {}); };
    window.__SK.translatePageGoogle = (opts) => { window.__tapCalls.push({ google: true, ...(opts || {}) }); };
  `);
  await page.evaluate(DISPATCH_HELPERS);
  return { page, evaluate };
}

// 派發後輪詢 call 數(訊息要過 background round-trip,非同步)
async function readCalls(page, evaluate, expectAtLeast) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const calls = await evaluate(`window.__tapCalls`);
    if (calls.length >= expectAtLeast) return calls;
    await page.waitForTimeout(50);
  }
  return await evaluate(`window.__tapCalls`);
}

test('四指 tap → 走 TRANSLATE_PRESET slot 2 → translatePage 被呼叫', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  const calls = await readCalls(page, evaluate, 1);
  expect(calls.length, 'translatePage 應被呼叫恰好 1 次').toBe(1);
  expect(calls[0].slot, '應走主要預設 slot 2(= Alt+S)').toBe(2);
  expect(calls[0].google, 'DEFAULT preset slot 2 是 gemini,不該走 translatePageGoogle').toBeUndefined();
});

test('IS_IOS_BUILD=false(桌面 build 預設)→ 四指 tap 不觸發', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: false });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '桌面 build gate 應擋下手勢').toBe(0);
});

test('四指 swipe(移動超過容差)→ 不觸發', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  await page.evaluate(`
    (() => {
      const ts = window.__mkTouches(4);
      window.__touch('touchstart', ts);
      // 全部手指平移 80px(> MOVE_TOLERANCE_PX 30)= iPadOS 多工 swipe 型手勢
      window.__touch('touchmove', window.__mkTouches(4, 80));
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, 'swipe 不該觸發翻譯').toBe(0);
});

test('五指落下 → 不觸發(讓位 iPadOS 系統手勢)', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  await page.evaluate(`
    (() => {
      window.__touch('touchstart', window.__mkTouches(4));
      window.__touch('touchstart', window.__mkTouches(5)); // 第五指落下
      window.__touch('touchend', []);
    })()
  `);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '五指手勢不該觸發翻譯').toBe(0);
});

test('長按超過 TAP_MAX_MS → 不觸發', async ({ context, localServer }) => {
  const { page, evaluate } = await setupPage(context, localServer, { iosBuild: true });

  await page.evaluate(`window.__touch('touchstart', window.__mkTouches(4))`);
  await page.waitForTimeout(700); // > TAP_MAX_MS 500
  await page.evaluate(`window.__touch('touchend', [])`);

  await page.waitForTimeout(800);
  const calls = await evaluate(`window.__tapCalls`);
  expect(calls.length, '長按不該觸發翻譯').toBe(0);
});
