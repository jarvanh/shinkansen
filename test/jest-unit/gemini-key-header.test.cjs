'use strict';

/**
 * dev tail 2.0.8.1（2026-07-09）：Gemini API key 從 URL query string 改走
 * `x-goog-api-key` request header。
 *
 * 背景：原本 5 個呼叫點（gemini.js 翻譯／glossary／summary／streaming ×4 +
 * background.js testGeminiKey ×1）都用 `?key=<apiKey>` 帶金鑰。URL 形式的風險是
 * 金鑰可能漏進會記 URL 的地方（proxy log、網路設備、錯誤訊息、debug log）。
 * Google 官方兩種都支援，建議 header。
 *
 * 測試手法（source 斷言 forcing function）：gemini.js / background.js 是 SW 模組
 * 難以 jest 整檔載入，改掃 source 文字——斷言 generativelanguage endpoint 附近
 * 不再出現 URL 帶 key 的寫法、且 header 寫法存在。防止日後新增呼叫點或改動時
 * 無意識退回 URL 形式。
 *
 * 訊號層界定：驗「source 沒有 URL 帶 key 的寫法 + header 寫法在」。不驗真實
 * fetch 的 request headers（那層由 debug harness 真翻譯驗過：2026-07-09 Kyoto
 * 976 段 + Shinkansen 987 段真 API 全通，token 計費正常）。
 *
 * SANITY 紀錄（已驗證，2026-07-09）：暫時把 gemini.js 主翻譯路徑 URL 改回
 * `:generateContent?key=${encodeURIComponent(apiKey)}` → 「gemini.js 無 URL 帶
 * key」case fail；還原 → pass。
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../shinkansen', p), 'utf8');

describe('Gemini API key 走 x-goog-api-key header（不放 URL）', () => {
  const geminiSrc = read('lib/gemini.js');
  const bgSrc = read('background.js');

  test('lib/gemini.js 無 URL 帶 key 的寫法', () => {
    // 任何 `?key=` / `&key=` 出現在 code（非註解行）都算退回
    const codeLines = geminiSrc.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const offenders = codeLines.filter((l) => /[?&]key=/.test(l));
    expect(offenders).toEqual([]);
  });

  test('background.js 無 URL 帶 key 的寫法', () => {
    const codeLines = bgSrc.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const offenders = codeLines.filter((l) => /[?&]key=/.test(l) && /generativelanguage|apiKey/.test(l));
    expect(offenders).toEqual([]);
  });

  test('lib/gemini.js 四個呼叫點都以 x-goog-api-key header 帶金鑰', () => {
    // 翻譯主路徑（fetchWithRetry 呼叫）+ glossary + summary + streaming 直接 fetch ×3
    const headerCount = (geminiSrc.match(/'x-goog-api-key': apiKey/g) || []).length;
    expect(headerCount).toBeGreaterThanOrEqual(4);
    // fetchWithRetry 支援 headers 傳遞（主翻譯路徑靠它把 header 帶進 fetch）。
    // v2.0.53 起呼叫多了 timeoutMs / timeoutRetries 選項改為多行——斷言錨定
    // 「同一個 fetchWithRetry 呼叫的 options 內含 x-goog-api-key header」即可,
    // 不鎖死參數排列
    expect(geminiSrc).toMatch(/fetchWithRetry\(url, body, \{[\s\S]{0,400}?headers: \{ 'x-goog-api-key': apiKey \}/);
    expect(geminiSrc).toMatch(/\.\.\.headers/);
  });

  test('background.js testGeminiKey 以 x-goog-api-key header 帶金鑰', () => {
    expect(bgSrc).toMatch(/'x-goog-api-key': apiKey/);
  });
});
