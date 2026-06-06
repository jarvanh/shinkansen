// Regression: options 翻譯快速鍵 badge 被 applyI18n 清回 '—' placeholder
//
// 痛點(Jimmy Chrome 實機,2026-06-06):options「翻譯快速鍵」三張 preset card
// 右上角的鍵位 badge(Alt+S / Alt+A / Alt+D)全部顯示成 '—'。
//
// Root cause(v1.8.60 i18n 化埋下):#preset-key-* span 掛了
// data-i18n="options.preset.unset"(dict 8 語全是 '—' 純 placeholder)→ badge 有
// 兩個寫入者:refreshPresetKeyBindings()(寫實際鍵位)與 applyI18n()(寫回 '—')。
// load() 內兩者之間隔著 await storage.local.get,先後順序看 IPC 時序;UI 語言
// 切換的兩條 applyI18n 重跑 path 更是必定清掉(沒人補 refresh)。
//
// 修法(單一資料源,CLAUDE.md 工作流原則 5):
//   1. options.html 移除 3 個 span 的 data-i18n(applyI18n 從此不碰 badge)
//   2. i18n.js 刪 'options.preset.unset' × 8 語(無引用殘留)
//   3. applyI18n 重跑的兩條 path(#uiLanguage change handler /
//      subscribeUiLanguageChange callback)補呼叫 refreshPresetKeyBindings()
//
// 本 spec 鎖的訊號層次:
//   驗「options 載入後 badge 顯示實際鍵位」+「UI 語言切換(applyI18n 重跑)後
//   badge 不被清回 '—'」。不驗:Chrome 多 extension 鍵位衝突時 getAll 回空
//   (那是「未設定」路徑,屬正常行為)。
//
// SANITY CHECK 紀錄(已驗證,2026-06-06):
//   暫時把 options.html 三個 span 加回 data-i18n="options.preset.unset" +
//   i18n.js 加回該 key → 「UI 語言切換後 badge 不被清掉」case fail(badge 變
//   '—'),還原後全綠。
import { test, expect } from '../fixtures/extension.js';

const PLACEHOLDER = '—';

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  // 等 load() 跑完 + refreshPresetKeyBindings 寫入(badge 離開 placeholder)
  await page.waitForFunction(
    (ph) => {
      const el = document.getElementById('preset-key-2');
      return el && el.textContent.trim() !== ph && el.textContent.trim() !== '';
    },
    PLACEHOLDER,
    { timeout: 10_000 },
  );
  return page;
}

test('options 載入後三張 preset card badge 顯示實際鍵位(非 placeholder)', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  for (const slot of [1, 2, 3]) {
    const text = (await page.locator(`#preset-key-${slot}`).textContent()).trim();
    expect(text, `preset-key-${slot} 不該是 placeholder`).not.toBe(PLACEHOLDER);
    expect(text.length, `preset-key-${slot} 不該是空字串`).toBeGreaterThan(0);
  }
});

test('UI 語言切換(applyI18n 重跑)後 badge 不被清回 placeholder', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const before = (await page.locator('#preset-key-2').textContent()).trim();

  // 切 UI 語言 → change handler 同步 applyI18n + (修法後)補 refreshPresetKeyBindings
  await page.selectOption('#uiLanguage', 'en');
  // applyI18n 同步執行;refreshPresetKeyBindings 是 async(getAll round-trip),
  // 等它有機會寫回後再斷言(沒修法時 badge 此刻已是 '—' 且不會再恢復)
  await page.waitForTimeout(500);

  const after = (await page.locator('#preset-key-2').textContent()).trim();
  expect(after, 'applyI18n 重跑後 badge 不該被清回 placeholder').not.toBe(PLACEHOLDER);
  expect(after, 'badge 應維持原鍵位').toBe(before);

  // 三張 card 都驗(badge 清掉是整批的)
  for (const slot of [1, 3]) {
    const text = (await page.locator(`#preset-key-${slot}`).textContent()).trim();
    expect(text, `preset-key-${slot} 不該是 placeholder`).not.toBe(PLACEHOLDER);
  }
});
