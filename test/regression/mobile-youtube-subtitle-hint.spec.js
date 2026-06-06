// Regression: m.youtube.com 啟用字幕翻譯 → toast 提示切電腦版,不啟動 YT pipeline
// (SPEC-PRIVATE §26.6,iOS Phase 2)
//
// 痛點:行動版 YouTube(m.youtube.com)沒有字幕翻譯管線——timedtext 攔截
// (content-youtube-main.js)的 manifest match 只有 https://www.youtube.com/*。
// 修法前在 m.youtube watch 頁從 popup 開字幕翻譯,SET_SUBTITLE 會照啟動
// translateYouTubeSubtitles → YT.active=true 之後永遠等不到字幕(zombie session)。
// 修法(content.js SET_SUBTITLE handler):enabled && hostname === 'm.youtube.com'
// → showToast(toast.mobileYtHint)提示切換電腦版網站,直接 return 不啟動。
//
// 本 spec 鎖的訊號層次(CLAUDE.md 工作流原則 3):
//   驗「SW tabs.sendMessage(SET_SUBTITLE) → content.js handler 的 m.youtube 分支」
//   真實訊息路徑:toast 內容 key、YT.active 不被翻面、www.youtube.com 對照組不受影響。
//   不驗:popup toggle UI 到 sendMessage 那段(popup spec 範疇)、真實 m.youtube
//   DOM(用 route 模擬 hostname,DOM 內容與此 bug 無關——hostname 是唯一分支條件)。
//
// SANITY CHECK 紀錄(已驗證,2026-06-05):
//   暫時把 content.js SET_SUBTITLE handler 的 m.youtube guard 整段註解掉 →
//   「m.youtube + enabled → toast」case fail(toast 未出現且 YT.active=true),
//   還原後全綠。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>watch fixture</title></head>
<body><main><p id="para">video page placeholder</p></main></body></html>`;

// 用 route 模擬 youtube hostname:content script 注入與 content.js 的
// hostname 分支都吃真實 URL,route 只負責回 200 HTML(DOM 內容無關)
async function openRoutedPage(context, url) {
  const page = await context.newPage();
  await page.route('https://m.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#para', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  // Stub showToast(content-toast 是 closed shadow DOM,從外面查不到內容,
  // 改攔 SK.showToast 呼叫紀錄)+ stub 字幕翻譯入口避免真的啟動
  await evaluate(`
    window.__toasts = [];
    window.__SK.showToast = (kind, msg, opts) => { window.__toasts.push({ kind, msg }); };
  `);
  return { page, evaluate };
}

// 從 background service worker 送 SET_SUBTITLE 給指定 URL 的 tab —
// 跟 popup yt-subtitle-toggle 的 browser.tabs.sendMessage 同一條真實路徑
async function sendSetSubtitle(context, urlPattern, enabled) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(async ({ urlPattern, enabled }) => {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    if (!tabs.length) throw new Error(`no tab matches ${urlPattern}`);
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_SUBTITLE', payload: { enabled } });
  }, { urlPattern, enabled });
}

test('m.youtube + enabled=true → toast 提示切電腦版,YT pipeline 不啟動', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://m.youtube.com/*', true);

  // toast 應出現且走 toast.mobileYtHint key(對齊 zh-TW dict 文案)
  const start = Date.now();
  let toasts = [];
  while (Date.now() - start < 3000) {
    toasts = await evaluate(`window.__toasts`);
    if (toasts.length > 0) break;
    await page.waitForTimeout(50);
  }
  expect(toasts.length, '應顯示 1 則提示 toast').toBe(1);
  expect(toasts[0].kind).toBe('error');
  const expected = await evaluate(`window.__SK.t('toast.mobileYtHint')`);
  expect(toasts[0].msg, 'toast 文案應走 toast.mobileYtHint dict key').toBe(expected);
  expect(toasts[0].msg).toContain('www.youtube.com');

  // 不可啟動 YT pipeline(zombie session 防護)
  const active = await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`);
  expect(active, 'YT.active 不該被翻成 true').toBe(false);
});

test('m.youtube + enabled=false → 不提示、不啟動(no-op)', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://m.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://m.youtube.com/*', false);
  await page.waitForTimeout(800);

  expect(await evaluate(`window.__toasts.length`), 'enabled=false 不該跳提示').toBe(0);
  expect(await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`)).toBe(false);
});

test('www.youtube.com 對照組:enabled=true 照常啟動,不跳行動版提示', async ({ context, localServer }) => {
  const { page, evaluate } = await openRoutedPage(context, 'https://www.youtube.com/watch?v=test1234567');

  await sendSetSubtitle(context, 'https://www.youtube.com/*', true);

  // translateYouTubeSubtitles 入口同步把 YT.active 翻 true(後續等字幕屬正常流程)
  const start = Date.now();
  let active = false;
  while (Date.now() - start < 3000) {
    active = await evaluate(`!!(window.__SK.YT && window.__SK.YT.active)`);
    if (active) break;
    await page.waitForTimeout(50);
  }
  expect(active, '桌面版 YouTube 應照常啟動字幕翻譯').toBe(true);

  const toasts = await evaluate(`window.__toasts`);
  const hint = await evaluate(`window.__SK.t('toast.mobileYtHint')`);
  expect(
    toasts.some((t) => t.msg === hint),
    '桌面版不該出現行動版提示',
  ).toBe(false);
});
