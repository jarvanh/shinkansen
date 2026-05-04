// Regression: v1.8.40 YouTube 字幕原文已是繁中時跳過 Gemini 翻譯
//
// 痛點:使用者勾「自動翻譯字幕」後,即使影片字幕本身已是繁中(zh-Hant /
// zh-TW / zh-HK / zh-MO),Shinkansen 仍照送 Gemini 翻譯一次,浪費 token。
//
// 修法位置:shinkansen/content-youtube.js
//   1. shinkansen-yt-captions listener 從 caption URL 抓 lang 存進 YT.captionLang
//   2. translateWindowFrom 入口加 _shouldSkipBecauseAlreadyTraditionalChinese()
//      命中就 return + log 'skip translate: caption already traditional chinese'
//   3. SKIP_TRANSLATE_LANGS_TW = { zh-Hant, zh-TW, zh-HK, zh-MO }
//
// 不在範圍(維持送 Gemini):
//   zh-Hans / zh-CN(簡中,讓 LLM 簡轉繁更精準)
//   zh(泛中,無從區分繁簡)
//   其他語言
//
// 結構通則:本 spec 鎖「URL 帶明確繁中 lang 代碼 → 不送 TRANSLATE_SUBTITLE_BATCH」
// 行為,不依賴 class/id 名稱啟發式。
//
// SANITY CHECK 紀錄(已驗證,2026-05-04):
//   把 _shouldSkipBecauseAlreadyTraditionalChinese 改成永遠回 false → 即使
//   captionLang=zh-Hant,translateWindowFrom 仍會跑 → TRANSLATE_SUBTITLE_BATCH
//   被呼叫 → spec fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

const MOCK_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0,    segs: [{ utf8: '這是繁體中文字幕第一句' }] },
    { tStartMs: 3000, segs: [{ utf8: '這是繁體中文字幕第二句' }] },
    { tStartMs: 6000, segs: [{ utf8: '這是繁體中文字幕第三句' }] },
  ],
});

test.describe('youtube-skip-already-zh-hant', () => {
  for (const lang of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO']) {
    test(`captionLang=${lang} → 不送 TRANSLATE_SUBTITLE_BATCH`, async ({ context, localServer }) => {
      const page = await context.newPage();
      await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

      const { evaluate } = await getShinkansenEvaluator(page);
      await evaluate(`window.__SK.isYouTubePage = () => true`);

      // Mock TRANSLATE_SUBTITLE_BATCH:應該不被呼叫
      await evaluate(`
        window.__translateBatchCalled = 0;
        chrome.runtime.sendMessage = async function(msg) {
          if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
            window.__translateBatchCalled++;
            const texts = (msg.payload && msg.payload.texts) || [];
            return { ok: true, result: texts.map(t => '[ZH] ' + t),
              usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                       billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
          }
          if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
            return { ok: false, error: 'streaming disabled in test' };
          }
          return { ok: true };
        };
      `);

      await evaluate(`window.__SK.translateYouTubeSubtitles()`);

      // 觸發 caption 攔截:URL 含 lang=${lang}
      await evaluate(`
        window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
          detail: {
            url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${lang}',
            responseText: ${JSON.stringify(MOCK_JSON3)},
          }
        }));
      `);

      // 等可能的翻譯路徑跑完(skip 路徑只 ~50ms,送 API 路徑 ~500ms)
      await page.waitForTimeout(800);

      const calls = await evaluate(`window.__translateBatchCalled`);
      expect(
        calls,
        `captionLang=${lang} 應 skip 翻譯,TRANSLATE_SUBTITLE_BATCH 不該被呼叫,實際 ${calls} 次`,
      ).toBe(0);

      // captionLang 應已被 listener 抓到並存進 YT state
      const captionLang = await evaluate(`window.__SK.YT.captionLang`);
      expect(captionLang, `YT.captionLang 應為 '${lang}'`).toBe(lang);

      await page.close();
    });
  }

  test('captionLang=en → 仍送 TRANSLATE_SUBTITLE_BATCH(對照組,確保 skip 條件不誤殺)', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);
    await evaluate(`window.__SK.isYouTubePage = () => true`);

    await evaluate(`
      window.__translateBatchCalled = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          window.__translateBatchCalled++;
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[ZH] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
    `);

    await evaluate(`window.__SK.translateYouTubeSubtitles()`);

    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en',
          responseText: ${JSON.stringify(MOCK_JSON3)},
        }
      }));
    `);

    // 等翻譯啟動(en 應該真的送 API)
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = await evaluate(`window.__translateBatchCalled`);
      if (c > 0) break;
      await page.waitForTimeout(50);
    }

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `captionLang=en 應送 TRANSLATE_SUBTITLE_BATCH,實際 ${calls} 次`,
    ).toBeGreaterThan(0);

    await page.close();
  });

  test('captionLang=zh-Hans(簡中)→ 仍送 TRANSLATE_SUBTITLE_BATCH(讓 LLM 簡轉繁)', async ({ context, localServer }) => {
    const page = await context.newPage();
    await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

    const { evaluate } = await getShinkansenEvaluator(page);
    await evaluate(`window.__SK.isYouTubePage = () => true`);

    await evaluate(`
      window.__translateBatchCalled = 0;
      chrome.runtime.sendMessage = async function(msg) {
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
          window.__translateBatchCalled++;
          const texts = (msg.payload && msg.payload.texts) || [];
          return { ok: true, result: texts.map(t => '[ZH] ' + t),
            usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                     billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 }};
        }
        if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
          return { ok: false, error: 'streaming disabled in test' };
        }
        return { ok: true };
      };
    `);

    await evaluate(`window.__SK.translateYouTubeSubtitles()`);

    await evaluate(`
      window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
        detail: {
          url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=zh-Hans',
          responseText: ${JSON.stringify(MOCK_JSON3)},
        }
      }));
    `);

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = await evaluate(`window.__translateBatchCalled`);
      if (c > 0) break;
      await page.waitForTimeout(50);
    }

    const calls = await evaluate(`window.__translateBatchCalled`);
    expect(
      calls,
      `captionLang=zh-Hans 應送 TRANSLATE_SUBTITLE_BATCH(簡中讓 LLM 簡轉繁),實際 ${calls} 次`,
    ).toBeGreaterThan(0);

    await page.close();
  });
});
