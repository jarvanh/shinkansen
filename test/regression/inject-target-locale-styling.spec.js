// Regression: inject-target-locale-styling
//
// Bug:single mode 注入後 el 不帶 lang attribute、也沒對 CJK target 的 locale 字體做
//   fallback,瀏覽器沿用站點 <html lang="zh-TW"> + 站點 hardcode 的繁中專屬字體 stack
//   (例 upmedia.mg 的 "Noto Serif TC" 開頭),日文 / 韓文等其他 target 譯文用到 zh-TW
//   Han 字形變體 → 視覺不協調(例:upmedia.mg 翻日文後「査」字字身為中文版而非日文版)。
//
// 修法:applyTargetLocaleStyling 在 el 設 lang=STATE.targetLanguage,並對「source locale
//   ≠ target locale」的 CJK target 把 LOCALE_FONT_PREPEND 對應字體 stack prepend 到
//   el.style.fontFamily(站點原 stack 保留在後面當 fallback)。同 locale 或 source
//   未知時不 prepend(避免覆寫站點 typography)。restorePage / abort 路徑用
//   STATE.originalLang + STATE.originalFontFamily map 還原。
//
// 斷言:
//   1. single mode no-slots 注入後 el lang === STATE.targetLanguage
//   2. single mode slots ok 注入後 el lang === STATE.targetLanguage
//   3. 原本就有 lang="en" 的 el 注入後 lang 被覆寫成 target、restore 後還原成 en
//   4. 原本沒設 lang 的 el restore 後 lang attribute 被移除
//   5. serif 站點 stack(body 第一字體 Noto Serif TC)注入後 prepend 走 serif locale stack
//      (ja serif 第一字體 Hiragino Mincho ProN),不會用 sans-serif Hiragino Sans
//   6. sans-serif 站點 stack(#sans-section 第一字體 Helvetica Neue)注入後 prepend 走
//      sans-serif locale stack(ja sans 第一字體 Hiragino Sans)
//   7. 原 inline fontFamily(Custom Font)會被 prepend、保留在後面當 fallback
//   8. restore 後 inline fontFamily 還原(原本沒設 → 清掉 inline;原本有 → 還原原值)
//   9. en target 不會 prepend fontFamily(歐語沒 Han variant 問題)
//  10. 同 locale(zh-TW 站 → zh-TW target)不會 prepend(避免覆寫站點 typography)
//  11. 重複 apply 不會 double-prepend(idempotent guard)
//
// SANITY 紀錄(已驗證):把 applyTargetLocaleStyling 整個函式 body 註解 → 條 1, 5
//   斷言 fail。把 SK.restoreLocaleStyling 中 fontFamily 還原段註解 → 條 8 fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-target-locale-styling';

test('single mode 注入時應設 lang + prepend locale 字體', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plain', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 模擬 translatePage 入口注入 targetLanguage(實機是 content.js translatePage 設的)
  await evaluate(`window.__SK.STATE.targetLanguage = 'ja'`);

  // 1. no-slots(plain) 路徑 + lang + fontFamily prepend
  const plainResult = await evaluate(`
    (() => {
      const el = document.querySelector('#plain');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, 'プレーンテキストの翻訳', []);
      return {
        lang: el.getAttribute('lang'),
        text: el.textContent,
        translatedAttr: el.getAttribute('data-shinkansen-translated'),
        fontFamily: el.style.fontFamily,
      };
    })()
  `);
  expect(plainResult.lang, 'no-slots 注入後 lang 應為 ja').toBe('ja');
  expect(plainResult.translatedAttr).toBe('1');
  expect(plainResult.text).toContain('プレーン');
  // body 第一字體 Noto Serif TC → 偵測 serif → ja serif 第一字體 Hiragino Mincho ProN
  expect(plainResult.fontFamily, 'serif 站點 stack 應 prepend ja serif 字體 Hiragino Mincho ProN').toMatch(/^"?Hiragino Mincho ProN"?/);
  expect(plainResult.fontFamily, '站點 Noto Serif TC 應保留在 prepend 之後當 fallback').toMatch(/Noto Serif TC/);

  // 2. slots ok 路徑
  const slotsResult = await evaluate(`
    (() => {
      const el = document.querySelector('#with-link');
      const anchor = el.querySelector('a');
      const slots = [anchor];
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, '詳細は⟦0⟧ドキュメント⟦/0⟧をご覧ください', slots);
      return {
        lang: el.getAttribute('lang'),
        innerHTML: el.innerHTML,
        fontFamily: el.style.fontFamily,
      };
    })()
  `);
  expect(slotsResult.lang, 'slots 注入後 lang 應為 ja').toBe('ja');
  expect(slotsResult.innerHTML).toContain('ドキュメント');
  expect(slotsResult.fontFamily, 'p 繼承 body serif → ja serif Hiragino Mincho ProN').toMatch(/^"?Hiragino Mincho ProN"?/);

  // 3. 原有 lang="en" 的 el 應被覆寫
  const overwriteResult = await evaluate(`
    (() => {
      const el = document.querySelector('#with-existing');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, '既存の英語段落の日本語訳', []);
      return { lang: el.getAttribute('lang') };
    })()
  `);
  expect(overwriteResult.lang, '原本 en 的 el 注入後 lang 應變 ja').toBe('ja');

  // 6. 原本就有 inline fontFamily 的 el → prepend 後保留原 inline 在 fallback
  const inlineResult = await evaluate(`
    (() => {
      const el = document.querySelector('#with-inline');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, 'カスタムフォント段落の翻訳', []);
      return { fontFamily: el.style.fontFamily };
    })()
  `);
  expect(inlineResult.fontFamily, 'prepend 後仍保留原 inline Custom Font').toMatch(/Custom Font/);
  // 'Custom Font' 不命中任何 serif marker → 走 sans-serif → ja sans Hiragino Sans
  expect(inlineResult.fontFamily, 'Hiragino Sans 應在 Custom Font 之前').toMatch(/Hiragino Sans.*Custom Font/);

  // 6. sans-serif 站點 stack(#sans-section)→ ja sans-serif Hiragino Sans
  const sansResult = await evaluate(`
    (() => {
      const el = document.querySelector('#sans-paragraph');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, 'サンセリフ段落の翻訳', []);
      return { fontFamily: el.style.fontFamily };
    })()
  `);
  expect(sansResult.fontFamily, 'sans-serif 站點 → 用 sans-serif locale stack').toMatch(/^"?Hiragino Sans"?/);
  expect(sansResult.fontFamily, '不應誤用 serif Mincho').not.toMatch(/Mincho/);

  // 11. 重複 apply 不應 double-prepend
  const idempotentResult = await evaluate(`
    (() => {
      const el = document.querySelector('#plain');
      const beforeRetry = el.style.fontFamily;
      // 模擬 SPA reapply / Content Guard 觸發第二次 inject
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, '再注入のテキスト', []);
      const afterRetry = el.style.fontFamily;
      return { beforeRetry, afterRetry };
    })()
  `);
  expect(idempotentResult.afterRetry, '第二次 inject 不應 double-prepend').toBe(idempotentResult.beforeRetry);

  // 4 + 7. restore 後 lang + fontFamily 還原
  const restoreResult = await evaluate(`
    (() => {
      const STATE = window.__SK.STATE;
      STATE.originalHTML.forEach((originalHTML, el) => {
        if (!el.isConnected) return;
        el.innerHTML = originalHTML;
        el.removeAttribute('data-shinkansen-translated');
        window.__SK.restoreLocaleStyling(el);
      });
      return {
        plainHasLang: document.querySelector('#plain').hasAttribute('lang'),
        plainFontFamily: document.querySelector('#plain').style.fontFamily,
        existingLang: document.querySelector('#with-existing').getAttribute('lang'),
        inlineFontFamily: document.querySelector('#with-inline').style.fontFamily,
      };
    })()
  `);
  expect(restoreResult.plainHasLang, '原本沒 lang 的 el restore 後不應有 lang attribute').toBe(false);
  expect(restoreResult.plainFontFamily, '原本沒 inline fontFamily 的 el restore 後應清掉 inline').toBe('');
  expect(restoreResult.existingLang, '原本 en 的 el restore 後應回到 en').toBe('en');
  expect(restoreResult.inlineFontFamily, '原本有 inline fontFamily 的 el restore 後應還原原值').toMatch(/Custom Font/);
  expect(restoreResult.inlineFontFamily, 'restore 後不應殘留 Hiragino prepend').not.toMatch(/Hiragino/);

  await page.close();
});

test('source locale === target locale 時不應 prepend(避免覆寫站點 typography)', async ({ context, localServer }) => {
  const page = await context.newPage();
  // fixture <html lang="zh-TW">,target 也設 zh-TW → 同 locale,prepend 應 skip
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plain', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = 'zh-TW'`);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#plain');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, '繁中譯文', []);
      return {
        lang: el.getAttribute('lang'),
        fontFamily: el.style.fontFamily,
      };
    })()
  `);
  expect(result.lang, '同 locale 仍應設 lang attribute').toBe('zh-TW');
  expect(result.fontFamily, '同 locale 不應 prepend(站點 CSS 已對)').toBe('');

  await page.close();
});

test('en target 不應 prepend fontFamily', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#plain', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.STATE.targetLanguage = 'en'`);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#plain');
      const unit = { kind: 'element', el };
      window.__SK.injectTranslation(unit, 'translated text', []);
      return {
        lang: el.getAttribute('lang'),
        fontFamily: el.style.fontFamily,
      };
    })()
  `);
  expect(result.lang, 'en target 仍應設 lang').toBe('en');
  expect(result.fontFamily, 'en target 不應 prepend(LOCALE_FONT_PREPEND 沒 en entry)').toBe('');

  await page.close();
});
