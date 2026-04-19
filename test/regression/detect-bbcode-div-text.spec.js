// Regression: bbcode-div-text (對應 v1.4.7 修的「XenForo BBCode DIV 文字漏翻」bug)
//
// Fixture: test/regression/fixtures/bbcode-div-text.html
//
// Case A — 有 block 子孫（UL/LI）:
//   結構: <div class="bbWrapper">intro text<br>Pros:<ul><li>...</li></ul>Overall...</div>
//   Bug：DIV 不在 BLOCK_TAGS_SET，collectParagraphs walker 直接 FILTER_SKIP，
//        containsBlockDescendant / extractInlineFragments 都沒被呼叫。
//   修法 (v1.4.7)：非 BLOCK_TAGS_SET 分支若有直接 TEXT 子節點 + block 子孫，
//        補做 extractInlineFragments，把文字抽成 fragment。
//
// 註：fixture 內的 #target-b（純文字 + BR，無 block 子孫的 Case B）對應
//     PENDING_REGRESSION 內的 v1.4.8 條目，目前未涵蓋（v1.4.8 嘗試的 else
//     分支太寬鬆會踩既有 nav-anchor / leaf-content-div spec，已回退）。
//
// SANITY 紀錄（已驗證）：移除 v1.4.7 新增的 !BLOCK_TAGS_SET 分支補做邏輯，
//   fragmentCount=0（intro 文字沒被偵測到），斷言 1 fail。還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE_HTML = 'bbcode-div-text';

test('bbcode-div-text Case A: 有 block 子孫的 bbWrapper intro 文字應被偵測為 fragment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE_HTML}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-a', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-a');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const elements = units.filter(u => u.kind === 'element');
      const hasIntroFrag = fragments.some(f =>
        (f.el ? f.el.textContent : '').includes('1700 SQFT')
      );
      return {
        fragmentCount: fragments.length,
        elementCount: elements.length,
        hasIntroFrag,
        stats,
      };
    })()
  `);

  // 斷言 1: intro 文字應被偵測為 fragment
  expect(
    result.hasIntroFrag,
    `Case A: intro 段落應被偵測為 fragment，fragmentCount=${result.fragmentCount}\nstats: ${JSON.stringify(result.stats)}`,
  ).toBe(true);

  // 斷言 2: LI 仍被正常偵測為 element
  expect(
    result.elementCount,
    `Case A: 應有 >= 2 個 element unit（LI），實際 ${result.elementCount}`,
  ).toBeGreaterThanOrEqual(2);

  await page.close();
});
