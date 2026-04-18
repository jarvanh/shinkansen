// Regression: v1.4.1 Google Translate 路徑的格式保留（⟦⟧ ↔ 【】 雙向替換）
//
// 根本問題：Google Translate 的 MT 引擎會亂動 ⟦⟧（數學符號），但會原樣保留
// 【】（CJK 標點）。content.js 的 translateUnitsGoogle 因此在送出前把
// ⟦N⟧/⟦/N⟧ 換成 【N】/【/N】，收回譯文後再換回 ⟦N⟧/⟦/N⟧ 走現有
// deserializeWithPlaceholders。
//
// 驗證流程（不打真實 Google API）：
//   1. fixture <p> 含 <a href>，本來會被序列化為 ⟦0⟧Tokyo travel guide⟦/0⟧
//   2. mock chrome.runtime.sendMessage 攔截 TRANSLATE_BATCH_GOOGLE，
//      回傳一段「假裝 Google MT 已翻成中文且【】標記原樣保留」的譯文：
//      "請參考【0】東京旅遊指南【/0】以了解更多。"
//   3. 觸發 SK.translateUnitsGoogle(units)
//   4. 預期：注入後 <p> 內仍有 <a href="https://example.com/tokyo">，
//      且 <a> 文字為「東京旅遊指南」（譯文已套進連結）
//
// 若 v1.4.1 的「【】 → ⟦⟧」反向 swap regex 被移除，譯文裡的 【0】 不會被
// 換回 ⟦0⟧，deserializeWithPlaceholders 找不到 ⟦⟧ → fallback 會把整段塞回，
// <a> 不會出現在 DOM 裡（或文字含可見的 【0】）。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'google-translate-format-preserve';
const TARGET_SELECTOR = 'p#target';

test('google-translate-format-preserve: 【N】 標記在 inject 前被換回 ⟦N⟧，<a> 連結保留', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入前 sanity：DOM 結構正確
  const before = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    return {
      linkCount: p.querySelectorAll('a').length,
      linkText: p.querySelector('a')?.textContent?.trim() ?? null,
      linkHref: p.querySelector('a')?.href ?? null,
    };
  })()`);
  expect(before.linkCount).toBe(1);
  expect(before.linkText).toBe('Tokyo travel guide');
  expect(before.linkHref).toBe('https://example.com/tokyo');

  // mock chrome.runtime.sendMessage 攔截 TRANSLATE_BATCH_GOOGLE，
  // 回傳含 【0】 標記的中文譯文（模擬 Google MT 把 【】 原樣保留的行為）
  await evaluate(`
    window.__sentMessages = [];
    chrome.runtime.sendMessage = async function(msg) {
      window.__sentMessages.push(msg);
      if (msg && msg.type === 'TRANSLATE_BATCH_GOOGLE') {
        const texts = msg.payload?.texts || [];
        // 假裝 Google MT 把每段譯成中文，且 【N】/【/N】 標記原樣保留
        const result = texts.map(t => {
          // 把 t 裡的 【0】…【/0】 段替換為「東京旅遊指南」（同樣包在 【0】…【/0】 內）
          return t.replace(/【0】.*?【\\/0】/g, '【0】東京旅遊指南【/0】')
                  .replace(/Visit the/g, '請參考')
                  .replace(/for more\\./g, '以了解更多。');
        });
        return { ok: true, result, usage: { chars: 10 } };
      }
      if (msg && msg.type === 'LOG') return;
      return { ok: true };
    };
  `);

  // 抓取段落並呼叫 translateUnitsGoogle
  await evaluate(`(async () => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const units = [{ kind: 'element', el: p }];
    await window.__SK.translateUnitsGoogle(units);
  })()`);

  // 注入後驗證
  const after = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    if (!p) return null;
    const allLinks = Array.from(p.querySelectorAll('a'));
    return {
      hasLink: !!p.querySelector('a'),
      linkCount: allLinks.length,
      linkText: allLinks[0]?.textContent?.trim() ?? null,
      linkHref: allLinks[0]?.href ?? null,
      totalText: p.textContent.trim(),
      // 若 swap-back 失效，譯文裡會有可見的 【0】 / ⟦0⟧ 殘留
      hasVisibleBracket: /[【】⟦⟧]/.test(p.textContent),
      pInnerHTMLPreview: p.innerHTML.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`);

  expect(after, '注入後 p 應仍存在').not.toBeNull();

  // 核心斷言：<a> 仍在，文字為譯文（連結結構完整保留）
  expect(
    after.linkCount,
    `p 內應有 1 個 <a>（連結被保留）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(1);
  expect(
    after.linkText,
    `<a> 文字應為「東京旅遊指南」（譯文已套進連結）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe('東京旅遊指南');
  expect(
    after.linkHref,
    `<a> href 必須維持原值\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe('https://example.com/tokyo');

  // 反向斷言：DOM 不應殘留可見的 【】 或 ⟦⟧（swap-back 失效時的症狀）
  expect(
    after.hasVisibleBracket,
    `DOM 不應留下可見的 【】 / ⟦⟧（swap-back 失效徵兆）\\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(false);

  await page.close();
});

// SANITY check（手動驗證紀錄，已在 Claude Code 端跑過）：
//   把 content.js translateUnitsGoogle 內 line ~707 的 .replace(/【(\\d+)】/g, '⟦$1⟧')
//   .replace(/【\\/(\\d+)】/g, '⟦/$1⟧') 兩個 swap-back regex 移除（直接用 tr），
//   核心斷言「linkText === '東京旅遊指南'」會 fail（因為 deserialize 找不到 ⟦⟧
//   → fallback 走純文字注入，整個段落被替換成含可見 【0】 的純文字）。還原後 pass。
//   已驗證。
