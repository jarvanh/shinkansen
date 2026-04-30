// Regression: cross-mutation reapply + mutation-driven inner restore
//
// 兩個 case 都對應 YouTube hover description 觸發 yt-attributed-string re-render 的真實
// burst pattern(Chrome for Claude 模擬 hover 抓到):一次 hover 約 80 個 mutation events
// 在 1 秒內,且 remove 跟 add 常拆成不同 mutation event(mutation A:removedNodes=N
// addedNodes=0;mutation B:removedNodes=0 addedNodes=M),Content Guard 1 秒一次 sweep
// 完全跟不上,reapply 也因「同 mutation 內找不到配對」漏掉。
//
// Test 1 — 跨 mutation 累積配對:reapply 必須把整批 mutations 的 removed + added 累積後
// 統一比對,而非 per-mutation 配對。
//
// Test 2 — mutation-driven inner restore:當 STATE.translatedHTML 的 key 自身的
// childList 在 mutation 中被改、innerHTML 偏離 savedHTML 時,callback 入口要當下回寫,
// 不能等下一次 sweep。
//
// SANITY:
//   Test 1 — 暫時把 reapply 改回「per-mutation 配對」(if removed.length === 0 ||
//     added.length === 0 continue),spec fail;還原後 pass。
//   Test 2 — 暫時把 restoreOnInnerMutation 改成 no-op return,spec fail;還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'spa-detach-reattach';
const TARGET_SELECTOR = 'p#target';
const PARENT_SELECTOR = 'div#parent';

test('cross-mutation reapply: 跨 mutation 累積 removed/added 仍能配對', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const STATE = SK.STATE;
      const parent = document.querySelector(${JSON.stringify(PARENT_SELECTOR)});
      const oldEl = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const oldElRef = oldEl;
      const savedOriginalText = STATE.originalText.get(oldEl);

      const newEl = document.createElement('p');
      newEl.id = 'target';
      newEl.textContent = savedOriginalText;
      parent.removeChild(oldEl);
      parent.appendChild(newEl);

      // 真實 framework pattern:remove 跟 add 拆成兩個獨立 mutation event(觀察 YouTube
      // yt-attributed-string hover re-render 抓到的)。reapply 必須跨 mutation 累積才配得到。
      const mutA = { type: 'childList', target: parent, removedNodes: [oldElRef], addedNodes: [] };
      const mutB = { type: 'childList', target: parent, removedNodes: [], addedNodes: [newEl] };
      SK._reapplyOnDetachReattach([mutA, mutB]);

      const newElInDom = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      return {
        newElText: newElInDom ? newElInDom.textContent : null,
        newElDataSk: newElInDom ? newElInDom.getAttribute('data-shinkansen-translated') : null,
        translatedHTMLHasNew: STATE.translatedHTML.has(newElInDom),
      };
    })()
  `);

  expect(
    result.newElText,
    `跨 mutation 配對失敗:新 element textContent 應為中文,實際=${JSON.stringify(result.newElText)}`,
  ).toContain('棕色狐狸');
  expect(result.newElDataSk).toBe('1');
  expect(result.translatedHTMLHasNew).toBe(true);

  await page.close();
});

test('mutation-driven inner restore: STATE.key 自身 childList 變動立即回寫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const STATE = SK.STATE;
      const target = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});

      // 模擬 framework 把譯後 element 內部子節點砍掉再 rebuild 成原文(典型 YouTube
      // yt-attributed-string hover 觸發,host span 自身 childList 大量 mutation)
      const savedHTMLSnapshot = STATE.translatedHTML.get(target);
      target.innerHTML = 'The quick brown fox jumps over the lazy dog near the riverbank on a sunny afternoon';

      // 模擬 mutation callback 餵入 mutations(類型對齊真實 MutationRecord)
      const fakeMutation = {
        type: 'childList',
        target,
        removedNodes: [],
        addedNodes: [],
      };
      SK._restoreOnInnerMutation([fakeMutation]);

      return {
        textAfterRestore: target.textContent,
        innerHTMLEqualsSaved: target.innerHTML === savedHTMLSnapshot,
      };
    })()
  `);

  expect(
    result.textAfterRestore,
    `inner restore 失敗:target 應被 restore 為中文,實際=${JSON.stringify(result.textAfterRestore)}`,
  ).toContain('棕色狐狸');
  expect(result.innerHTMLEqualsSaved).toBe(true);

  await page.close();
});

test('mutation-driven inner restore 安全閘:innerHTML 已等於 savedHTML 不應重寫', async ({
  context,
  localServer,
}) => {
  // forcing function:確保我們不會在每次自我觸發的 mutation callback 都無限重寫
  // (寫進 innerHTML 觸發新 mutation → 進入 callback → 應該看到 innerHTML===savedHTML
  // 直接跳過,避免迴圈)
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const STATE = SK.STATE;
      const target = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});

      // target 已是中文(剛 inject 完),不要動 innerHTML。直接餵 mutation。
      const beforeHTML = target.innerHTML;
      const fakeMutation = {
        type: 'childList',
        target,
        removedNodes: [],
        addedNodes: [],
      };
      SK._restoreOnInnerMutation([fakeMutation]);
      return {
        unchanged: target.innerHTML === beforeHTML,
      };
    })()
  `);

  expect(result.unchanged, 'innerHTML 未偏離 savedHTML 時 restoreOnInnerMutation 不應動 DOM').toBe(true);

  await page.close();
});
