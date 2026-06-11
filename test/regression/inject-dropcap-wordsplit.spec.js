// Regression: inject-dropcap-wordsplit(v1.10.48 Layer A3.5,對應「文章中間
// 兩段沒翻到」bug — framework-managed 段落 A3 配對失敗時掉 dual visible)
//
// Fixture: test/regression/fixtures/inject-dropcap-wordsplit.html
// 結構:dropcap 首字下沉段 — TEXT("F") + SPAN.smallcaps("inding a way") +
// TEXT(其餘)。單字 "Finding" 從字母中間被切開。
//
// Bug:CJK 譯文沒有「首字母」可對應,LLM 兩種輸出都無法同構還原 source 序列:
//   1. 丟掉佔位符(純文字)→ deserializeWithPlaceholders ok=false
//   2. 佔位符保留但首字併進 span → 譯文 [SPAN, TEXT] 2 項 vs source
//      [TEXT, SPAN, TEXT] 3 項 → collectA3Mutations 對齊 fail
// framework-managed 分支(isFrameworkManaged=true)原本兩種都直接 fallback
// dual visible:原文保留 + 譯文 sibling wrapper,使用者看起來「沒翻到」。
//
// 修法(content-inject.js Layer A3.5,結構性通則):slots 全為 styling-only
// inline(paired Element shell,非 <a> / atomic / reuseNode)時,
// stripStrayPlaceholderMarkers 剝掉佔位符 → 以 slots=[] 重走 nodeValue
// mutate。只動 text node nodeValue 不動元素結構,fiber-safe 同 Layer A1,
// 視覺等同 single 原地替換(§15)。
//
// SANITY 紀錄(已驗證):暫時把 content-inject.js Layer A3.5 整段 if block
// 用 `if (false &&` 關閉 → 前兩條 spec fail(textContent 仍含英文 +
// shinkansen-translation wrapper 出現,nv-mutated attr 沒設),guard 對照組
// 仍 pass → 還原 → 3 條全 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'inject-dropcap-wordsplit';

// 兩種 LLM 失敗模式的 canned 譯文(對應真實案例兩段各踩一種)
const TRANSLATION_DROPPED = '想找到前進的方向，花的時間比預期更久，但旅程本身成了所有人的回報。';
const TRANSLATION_ECHOED = '⟦0⟧等到冬天來臨⟦/0⟧，氣氛已然轉變，一股更寧靜的感受籠罩著這棟老房子。';
const TRANSLATION_LINK_DROPPED = '閱讀完整報告以了解更多研究結果細節。';

async function setupPage(context, localServer) {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-dropped', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);
  // fixture Chromium 沒 React fiber,mock 成 framework-managed 走 v1.9.27 分支
  await evaluate(`window.__SK.isFrameworkManaged = () => true`);
  return { page, evaluate };
}

async function probeTarget(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    const span = el.querySelector('span, a');
    return {
      textContent: el.textContent,
      hasEnglishWords: /[A-Za-z]{3,}/.test(el.textContent || ''),
      isChinese: /[一-鿿]/.test(el.textContent || ''),
      strayPlaceholder: /[⟦⟧]/.test(el.textContent || ''),
      inlineStillPresent: !!span,
      nvMutated: el.hasAttribute('data-shinkansen-nodevalue-mutated'),
      translated: el.hasAttribute('data-shinkansen-translated'),
      dualSource: el.hasAttribute('data-shinkansen-dual-source'),
      wrapperPresent: !!document.querySelector('shinkansen-translation'),
    };
  }, sel);
}

test('dropcap word-split + LLM 丟佔位符 → A3.5 純文字 nodeValue mutate(不掉 dual)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  // 抓 inject 前 span ref,驗結構不動(fiber-safe)
  await page.evaluate(() => {
    window.__probeSpan = document.querySelector('#target-dropped span');
  });

  await runTestInject(evaluate, '#target-dropped', TRANSLATION_DROPPED);

  const r = await probeTarget(page, '#target-dropped');
  expect(r.isChinese, '段落應為中文譯文').toBe(true);
  expect(r.hasEnglishWords, '英文原文不應殘留(原地替換,非 dual 並列)').toBe(false);
  expect(r.strayPlaceholder, '不應殘留佔位符字元').toBe(false);
  expect(r.wrapperPresent, '不應出現 shinkansen-translation sibling wrapper').toBe(false);
  expect(r.dualSource, '不應標 data-shinkansen-dual-source').toBe(false);
  expect(r.nvMutated, '應標 data-shinkansen-nodevalue-mutated').toBe(true);
  expect(r.translated, '應標 data-shinkansen-translated').toBe(true);
  expect(r.inlineStillPresent, 'smallcaps span 元素結構應保留(只清 text)').toBe(true);

  const spanSameRef = await page.evaluate(
    () => document.querySelector('#target-dropped span') === window.__probeSpan
  );
  expect(spanSameRef, 'span 物件 ref 應保留(React fiber identity)').toBe(true);

  await page.close();
});

test('dropcap word-split + LLM 佔位符序列不同構 → A3.5 純文字 nodeValue mutate(不掉 dual)', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target-echoed', TRANSLATION_ECHOED);

  const r = await probeTarget(page, '#target-echoed');
  expect(r.isChinese, '段落應為中文譯文').toBe(true);
  expect(r.hasEnglishWords, '英文原文不應殘留').toBe(false);
  expect(r.strayPlaceholder, '不應殘留佔位符字元').toBe(false);
  expect(r.wrapperPresent, '不應出現 shinkansen-translation sibling wrapper').toBe(false);
  expect(r.nvMutated, '應標 data-shinkansen-nodevalue-mutated').toBe(true);

  await page.close();
});

test('guard:含 <a> slot 的段落 A3 失敗時不走 A3.5(flatten 會吃掉連結文字)→ 維持 dual fallback', async ({
  context,
  localServer,
}) => {
  const { page, evaluate } = await setupPage(context, localServer);

  await runTestInject(evaluate, '#target-link', TRANSLATION_LINK_DROPPED);

  const r = await probeTarget(page, '#target-link');
  // 連結文字必須還在(沒被 A3.5 清空)
  const linkText = await page.evaluate(
    () => document.querySelector('#target-link a')?.textContent || ''
  );
  expect(linkText.length > 0, '<a> 連結文字不可被清空').toBe(true);
  expect(r.nvMutated, '不應走 nodeValue mutate(A3.5 對 <a> slot 必須讓路)').toBe(false);
  expect(r.wrapperPresent, '應 fallback dual visible(wrapper sibling)').toBe(true);
  expect(r.dualSource, '應標 data-shinkansen-dual-source').toBe(true);

  await page.close();
});
