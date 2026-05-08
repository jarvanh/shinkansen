// Regression: v1.8.64 translate-doc UI i18n — PDF 文件翻譯 reader 介面 i18n 化
//
// 涵蓋:
//   1. translate-doc/index.html 載入後 data-i18n 元素被 applyI18n 替換成 dict 值
//   2. 切 uiLanguage → reader UI 即時 reapply(subscribeUiLanguageChange callback)
//   3. data-i18n-attr-* / data-i18n-html 兩種 hook 都有效
//
// SANITY 紀錄(已驗證):把 translate-doc/index.js 的 initI18n() 整段 await applyI18n
//   call 註解 → 切 uiLanguage 後文字仍維持 zh-TW 預設,「切 en → 文字英文」斷言 fail。

import { test, expect } from '../fixtures/extension.js';

async function setUi(context, ui) {
  const sw = context.serviceWorkers()[0]
    || (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  await sw.evaluate(async (u) => {
    await chrome.storage.sync.set({ uiLanguage: u });
  }, ui);
}

test('translate-doc index.html 依 uiLanguage 載入對應 dict', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('[data-i18n="doc.header"]');

  // zh-TW 載入確認
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('翻譯文件（beta）');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('拖放文件至此');
  await expect(page.locator('[data-i18n="doc.upload.constraint.value"]')).toHaveText('50 頁 / 10 MB');

  // 切 en → 文字立即更新
  await setUi(context, 'en');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('Translate Document (beta)');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('Drop a document here');

  // 切 ja → 同樣 reapply
  await setUi(context, 'ja');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('文書を翻訳（beta）');
  await expect(page.locator('[data-i18n="doc.upload.dropzone.title"]')).toHaveText('ここに文書をドロップ');

  await page.close();
});

test('translate-doc data-i18n-attr-* / data-i18n-html 正確 apply', async ({ context, extensionId }) => {
  await setUi(context, 'en');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`);
  await page.waitForSelector('[data-i18n="doc.header"]');
  await expect(page.locator('[data-i18n="doc.header"]')).toHaveText('Translate Document (beta)');

  // data-i18n-attr-aria-label(dropzone)
  const aria = await page.locator('#dropzone').getAttribute('aria-label');
  expect(aria).toBe('Drop or pick a document');

  // data-i18n-attr-title(button title)
  const title = await page.locator('#extract-glossary-btn').getAttribute('title');
  expect(title).toContain('glossary');

  // data-i18n-html(edit help 段含 <strong> / <code>)
  const editHelp = await page.locator('.edit-help').first().innerHTML();
  expect(editHelp).toContain('<strong>');
  expect(editHelp.toLowerCase()).toContain('bold');

  await page.close();
});

test('translate-doc settings.html 依 uiLanguage 載入對應 dict', async ({ context, extensionId }) => {
  await setUi(context, 'zh-TW');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/translate-doc/settings.html`);
  await page.waitForSelector('h1 span[data-i18n="doc.settingsPage.title"]');

  await expect(page.locator('h1 [data-i18n="doc.settingsPage.title"]')).toHaveText('文件翻譯設定');
  await expect(page.locator('[data-i18n="doc.settingsPage.section.quality.title"]')).toHaveText('翻譯品質');

  // 切 ko → reapply
  await setUi(context, 'ko');
  await expect(page.locator('h1 [data-i18n="doc.settingsPage.title"]')).toHaveText('문서 번역 설정');
  await expect(page.locator('[data-i18n="doc.settingsPage.section.quality.title"]')).toHaveText('번역 품질');

  await page.close();
});
