// Regression: epub-translate（v2.0.11 EPUB 電子書翻譯，SPEC-PRIVATE §30）
//
// Fixture: test/regression/fixtures/epub-mini-book.epub（+ epub-drm.epub）
// 結構：EPUB3，spine = cover(linear no) / nav / ch1 / ch2。ch1 含 <em>/<strong>、
//       註腳 noteref（<a epub:type="noteref"><sup>1</sup></a>）、pagebreak 錨點
//       （<span epub:type="pagebreak" id="page1"/>）與 aside 註腳；ch1 提及
//       「Lizzy」、ch2 提及「Elizabeth」（驗批次級術語表過濾）。
//
// 驗的層次：
//   1. 解析：章節清單（TOC 標題 / 附屬頁 suggestSkip 預設不勾 / nav 空章 disabled）
//   2. 章節選翻：只翻勾選章、⟦N⟧ 佔位符送出、完成後自動取消勾選、狀態聚合
//   3. 批次級術語表過濾：TRANSLATE_DOC_BATCH payload.glossary 只含該批出現的條目
//   4. epub-writer 重打包：mimetype 第一且 STORED、譯文寫回、inline 標記與
//      noteref / pagebreak 錨點屬性保留、未翻章節原樣、dc:language 與 html lang 更新
//   5. 全書術語表：EXTRACT_GLOSSARY 帶 promptSuffix（書籍模式）、bookgloss_ 持久化
//   6. DRM EPUB 拒收
//   不驗：真實 Gemini 譯文品質、真實閱讀器（Apple Books / Kobo）渲染 —— 後者靠
//   實機驗收（歷史紀錄見 SPEC-PRIVATE §30）。
//
// 注意：translate-doc 是 extension page，spec 直接跑在該頁 main world（沒有
// content script isolated world 問題），page.evaluate 可直接用。
//
// SANITY 紀錄（已驗證，2026-07-09）：
//   ① epub-writer.js applyBlockTranslation 的 `el.replaceChildren(imported)` 改
//     `if (false)` 跳過 → 「writer 重打包」case 的譯文斷言 fail（ch1 內容仍為原文）
//     → 還原後 pass
//   ② translate.js filterGlossaryForTexts 改為原樣回傳（不過濾）→ 「術語表批次
//     過濾」case 的 payload.glossary 長度斷言 fail（2 ≠ 1）→ 還原後 pass
//   ③ 2026-07-10 匯入合併：index.js 合併分支改 `if (false && ...)`（永遠覆蓋）→
//     「匯入合併」case 的條目數斷言 fail（4 ≠ 2）；epub-engine.js flag 保留兩行改
//     `if (false && ...)` → 「純函式」case 的 mergedFlags 斷言 fail → 還原後全 pass
//   ④ 2026-07-10 雙語對照：epub-writer.js 三處各自破壞各自 fail——內嵌策略改一律
//     sibling → 純函式 liCount 斷言 fail（2 ≠ 1）；剝 id 跳過 → fnref1 計數 fail
//     （2 ≠ 1）；快照還原跳過 → dual2 的「譯+原文片段」計數 fail（2 ≠ 1；此破壞
//     曾讓「片段計數 = 2」的弱斷言誤 pass——譯文+譯文也是 2，因此補強為驗
//     「帶譯前綴恰 1 份」）→ 還原後全 pass
//   ⑤ 2026-07-10 表格 block 收集：epub-engine.js htmlCloneFromXhtml 改回
//     「XMLSerializer → innerHTML」reparse → 「表格 / 定義清單 block 收集」case
//     的 texts toContain('Caption text about the specimens') fail（td/th/caption
//     全數不進 blocks）→ 還原 importNode 後 pass
//   ⑥ 2026-07-10 不翻譯空譯文列：index.js readGlossaryTable 改回
//     `if (!source || !target) continue`（要求 target 非空）→ 「術語表選項」case
//     的 manualEntry toEqual(Gandalf) fail（手動不翻譯列被默默丟棄）→ 還原後 pass
//   ⑦ 2026-07-10 雙語內嵌 holder：epub-writer.js insertDualTranslation 內嵌
//     holder 改回 'div' → 「雙語純函式」case 的 liInnerSpan 斷言 fail → 還原
//     span 後 pass（span + display:block 是為 XHTML 1.1 dt / caption 合法性）
//   ⑧ 2026-07-10 session flush：index.js releaseCurrentDoc 的
//     flushPendingSessionSave() 註解掉 → 「debounce flush」case 的 found 斷言
//     fail（編輯掉失）→ 還原後 pass
//   ⑨ 2026-07-10 合併結果告知：epub-engine.js dropped 改固定 0 → 「純函式」case
//     的 capped 斷言 fail；index.js 合併 alert 改 `if (false && ...)` →
//     「匯入合併」case 的 alerts.length 斷言 fail → 各自還原後 pass
//   ⑩ 2026-07-10 匯入重置掃描：index.js importEpubSession 的 epubScanGen++ /
//     epubScanState = null 拿掉 → 「一致性掃描：漂移」case 的 scanBtnHidden 斷言
//     fail（匯入後入口按鈕殘留過期發現）→ 還原後 pass
import { test, expect } from '../fixtures/extension.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_EPUB = path.join(__dirname, 'fixtures', 'epub-mini-book.epub');
const FIXTURE_DRM = path.join(__dirname, 'fixtures', 'epub-drm.epub');
// 一致性掃描 fixture：Poole 出現在 3 段（跨兩章）、Utterson 2 段
const FIXTURE_SCAN = path.join(__dirname, 'fixtures', 'epub-scan-book.epub');
// 表格 fixture：ch1 含 table（caption / th / td×2）+ dl（dt / dd）+ 控制組 <p>
const FIXTURE_TABLE = path.join(__dirname, 'fixtures', 'epub-table-book.epub');

// 攔 chrome.runtime.sendMessage：翻譯/術語表/一致性掃描回 canned、其餘放行到真 background。
// canned 譯文 = '譯' + 原文（⟦N⟧ 佔位符原樣保留 → 走完 deserialize/writer 全路徑）
// 選項：
//   drift = { term, renderings }：含 term 的文字逐段輪替譯名（製造譯名漂移）
//   scanKnown = [...]：SCAN_TERM_RENDERINGS 對每個取樣回「文中出現的第一個已知譯名」
//   glossaryEntries：覆蓋 EXTRACT_GLOSSARY 的 canned 術語表
async function installMessageStub(page, { cannedPrefix = '譯', drift = null, scanKnown = null, glossaryEntries = null } = {}) {
  await page.addInitScript((opts) => {
    const install = () => {
      if (!window.chrome?.runtime?.sendMessage) return false;
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sentMessages = [];
      let driftCounter = 0;
      const translateOne = (text) => {
        if (opts.drift && text.includes(opts.drift.term)) {
          const r = opts.drift.renderings[driftCounter++ % opts.drift.renderings.length];
          return opts.prefix + text.split(opts.drift.term).join(r);
        }
        return opts.prefix + text;
      };
      chrome.runtime.sendMessage = async (msg) => {
        window.__sentMessages.push(JSON.parse(JSON.stringify(msg)));
        if (msg?.type === 'TRANSLATE_DOC_BATCH' || msg?.type === 'TRANSLATE_DOC_BATCH_CUSTOM') {
          return {
            ok: true,
            result: msg.payload.texts.map(translateOne),
            usage: { inputTokens: 100, billedInputTokens: 100, outputTokens: 50, billedCostUSD: 0.001, cacheHits: 0 },
          };
        }
        if (msg?.type === 'EXTRACT_GLOSSARY' || msg?.type === 'EXTRACT_GLOSSARY_CUSTOM') {
          return {
            ok: true,
            glossary: opts.glossaryEntries || [
              // 刻意亂序：驗編輯器組內按原文字母排序（Elizabeth 應排在 Lizzy 前）
              { source: 'Lizzy', target: '莉茲', type: 'person' },
              { source: 'Elizabeth', target: '伊莉莎白', type: 'person' },
              { source: 'London', target: '倫敦', type: 'place' },
            ],
            // billedCostUSD：抽取費用要累進「本書累計費用」（v2.0.11 修）
            usage: { inputTokens: 500, outputTokens: 80, billedCostUSD: 0.002 },
          };
        }
        if (msg?.type === 'SCAN_TERM_RENDERINGS') {
          const known = opts.scanKnown || [];
          const renderings = (msg.payload?.items || []).map((item) => ({
            term: item.term,
            renderings: item.samples.map((s) => known.find((k) => s.text.includes(k)) || ''),
          }));
          return { ok: true, renderings, usage: { inputTokens: 120, outputTokens: 30, billedCostUSD: 0.0005 } };
        }
        if (msg?.type === 'LOG_USAGE') return { ok: true };
        return orig(msg);
      };
      return true;
    };
    if (!install()) document.addEventListener('DOMContentLoaded', install);
  }, { prefix: cannedPrefix, drift, scanKnown, glossaryEntries });
}

async function openDocPage(context, extensionId, { stub = true, ...stubOpts } = {}) {
  const page = await context.newPage();
  if (stub) await installMessageStub(page, stubOpts);
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  return page;
}

async function uploadEpub(page, fixture = FIXTURE_EPUB) {
  await page.setInputFiles('#file-input', fixture);
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
}

// 勾選狀態重設：全不選 → 勾第 idx 列
async function selectOnlyChapter(page, idx) {
  await page.click('#chapters-select-none-btn');
  await page.locator('.chapter-row').nth(idx).locator('input[type=checkbox]').check();
}

test('epub 解析：章節清單、TOC 標題、附屬頁預設不勾、nav 空章 disabled', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await uploadEpub(page);

  expect(await page.textContent('#chapters-book-title')).toBe('Mini Book');
  expect(await page.textContent('#chapters-author')).toBe('Test Author');
  expect(await page.textContent('#chapters-epub-version')).toBe('EPUB 3.0');

  const rows = page.locator('.chapter-row');
  expect(await rows.count()).toBe(4); // cover / nav / ch1 / ch2

  // TOC 標題
  expect(await rows.nth(0).locator('.chapter-title').textContent()).toBe('1. Cover');
  expect(await rows.nth(2).locator('.chapter-title').textContent()).toBe('3. Chapter One: The Beginning');

  // cover：附屬頁（linear no + 檔名）→ 預設不勾；ch1 / ch2 預設勾
  expect(await rows.nth(0).locator('input').isChecked()).toBe(false);
  expect(await rows.nth(2).locator('input').isChecked()).toBe(true);
  expect(await rows.nth(3).locator('input').isChecked()).toBe(true);

  // nav doc:blocks 為空（nav 子樹跳過）→ checkbox disabled
  expect(await rows.nth(1).locator('input').isDisabled()).toBe(true);

  // 可翻譯字數 > 0
  const chars = await page.textContent('#chapters-chars');
  expect(parseInt(chars.replace(/,/g, ''), 10)).toBeGreaterThan(400);
  await page.close();
});

test('epub 章節選翻 + writer 重打包 roundtrip', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  // 固定 target 語言，writer 斷言不受測試機 locale 影響
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);

  // 只翻 ch1(index 2)
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 狀態：ch1 done、ch2 未翻；整章完成自動取消勾選
  const rows = page.locator('.chapter-row');
  expect(await rows.nth(2).locator('.chapter-status').getAttribute('data-state')).toBe('done');
  expect(await rows.nth(3).locator('.chapter-status').getAttribute('data-state')).toBe('none');
  expect(await rows.nth(2).locator('input').isChecked()).toBe(false);

  // 送出的批次：含 ⟦N⟧ 佔位符的序列化文字（ch1 首段有 em/strong/noteref）
  const sent = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH'));
  expect(sent.length).toBeGreaterThan(0);
  const allTexts = sent.flatMap((m) => m.payload.texts);
  expect(allTexts.some((t) => t.includes('⟦0⟧'))).toBe(true); // ⟦0⟧
  // 只翻 ch1:Elizabeth（僅 ch2）不應出現在任何送出文字
  expect(allTexts.some((t) => t.includes('Elizabeth'))).toBe(false);

  // 下載按鈕出現
  expect(await page.locator('#chapters-download-btn').isHidden()).toBe(false);

  // writer roundtrip：頁內直接 build + fflate unzip 驗證（不經下載攔截）
  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW');
    const entries = window.fflate.unzipSync(bytes);
    const dec = (name) => window.fflate.strFromU8(entries[name]);
    return {
      entryNames: Object.keys(entries),
      firstLocalHeader: Array.from(bytes.slice(0, 38)),
      mimetype: dec('mimetype'),
      ch1: dec('OEBPS/ch1.xhtml'),
      ch2: dec('OEBPS/ch2.xhtml'),
      css: dec('OEBPS/style.css'),
      opf: dec('OEBPS/content.opf'),
    };
  });

  // OCF 規範：mimetype 是第一個 entry 且 STORED(local header offset 8 的
  // compression method = 0）、offset 30 起檔名 = mimetype
  expect(out.entryNames[0]).toBe('mimetype');
  expect(out.mimetype).toBe('application/epub+zip');
  expect(out.firstLocalHeader[8] | (out.firstLocalHeader[9] << 8)).toBe(0);
  expect(String.fromCharCode(...out.firstLocalHeader.slice(30, 38))).toBe('mimetype');

  // ch1：譯文寫回（canned '譯' 前綴）、inline 標記與錨點屬性保留
  expect(out.ch1).toContain('譯');
  expect(out.ch1).toContain('<em');
  expect(out.ch1).toContain('epub:type="noteref"');
  expect(out.ch1).toContain('id="page1"'); // pagebreak 錨點（零文字 atomic 保留）
  expect(out.ch1).toMatch(/<html[^>]*lang="zh-TW"/);

  // ch2 未翻：原文原樣
  expect(out.ch2).toContain('Elizabeth packed her bags');
  expect(out.ch2).not.toContain('譯');

  // CSS 原樣；OPF 語言更新
  expect(out.css).toContain('font-style: italic');
  expect(out.opf).toMatch(/<dc:language[^>]*>zh-TW<\/dc:language>/);
  await page.close();
});

test('epub 雙語對照輸出：原譯交錯 + id 剝除 + 單雙語切換重下載 idempotent', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 譯本內容 select 隨下載按鈕出現
  expect(await page.locator('#epub-dual-wrap').isHidden()).toBe(false);

  // 同一份 xhtmlDoc 連續三次 build：雙語 → 單語 → 雙語（驗 idempotency +
  // 單語 replaceChildren 後原文仍可從快照還原）
  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const dec = (bytes) => window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
    const dual1 = dec(mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW', { bilingual: true }).bytes);
    const single = dec(mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW', {}).bytes);
    const dual2 = dec(mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW', { bilingual: true }).bytes);
    return {
      dual1,
      single,
      dual2,
      filenameSingle: mod.translatedEpubFilename('book.epub'),
      filenameDual: mod.translatedEpubFilename('book.epub', { bilingual: true }),
    };
  });
  const count = (s, sub) => s.split(sub).length - 1;
  const PHRASE = 'Lizzy walked through the'; // ch1 首段開頭（canned 譯文 = '譯' + 原文，也含此片段）

  // 雙語：原文段 + 譯文段各一 → 片段出現 2 次；原文標 sk-dual-src、譯文 sk-dual-tr、
  // style 注入；h1 同 tag sibling
  expect(count(out.dual1, PHRASE)).toBe(2);
  expect(out.dual1).toContain('sk-dual-src');
  expect(out.dual1).toContain('sk-dual-tr');
  expect(out.dual1).toContain('id="sk-dual-style"');
  expect(count(out.dual1, '<h1')).toBe(2);
  // 譯文副本剝 id：noteref 錨點 / pagebreak 錨點各只出現一次（原文那份）
  expect(count(out.dual1, 'id="fnref1"')).toBe(1);
  expect(count(out.dual1, 'id="page1"')).toBe(1);
  expect(out.dual1).toMatch(/<html[^>]*lang="zh-TW"/);

  // 切回單語：雙語殘留全清、譯文取代原文（片段只剩譯文內那 1 次）
  expect(count(out.single, PHRASE)).toBe(1);
  expect(out.single).not.toContain('sk-dual-src');
  expect(out.single).not.toContain('sk-dual-tr');
  expect(out.single).not.toContain('sk-dual-style');

  // 再切雙語：原文從快照還原（單語 replaceChildren 沒有毀掉它）。
  // 片段計數 2 不夠強——快照還原壞掉時會變「譯文+譯文」一樣是 2，必須驗
  // 「不帶譯前綴的原文」恰好 1 份（帶譯前綴的譯文也恰好 1 份）
  expect(count(out.dual2, PHRASE)).toBe(2);
  expect(count(out.dual2, '譯' + PHRASE)).toBe(1);
  expect(count(out.dual1, '譯' + PHRASE)).toBe(1);
  expect(count(out.dual2, 'id="page1"')).toBe(1);

  // 檔名：雙語版 -shinkansen-dual 不與單語版互蓋
  expect(out.filenameSingle).toBe('book-shinkansen.epub');
  expect(out.filenameDual).toBe('book-shinkansen-dual.epub');
  await page.close();
});

test('epub 雙語純函式：li / td / dt / figcaption 內嵌 span（display:block），p 同 tag sibling，副本剝 id', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, { stub: false });
  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const doc = new DOMParser().parseFromString(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <p id="p1">para</p>
        <ul><li>item</li></ul>
        <table><tr><td>cell</td></tr></table>
        <dl><dt>term</dt><dd>def</dd></dl>
        <figure><img src="x.png" alt=""/><figcaption>cap</figcaption></figure>
      </body></html>`,
      'application/xhtml+xml',
    );
    const mk = (withId) => {
      const frag = doc.createDocumentFragment();
      frag.appendChild(doc.createTextNode('譯'));
      if (withId) {
        const span = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
        span.setAttribute('id', 'dup1');
        frag.appendChild(span);
      }
      return frag;
    };
    const q = (sel) => doc.querySelector(sel);
    mod.insertDualTranslation(doc, q('p'), mk(true));
    mod.insertDualTranslation(doc, q('li'), mk(false));
    mod.insertDualTranslation(doc, q('td'), mk(false));
    mod.insertDualTranslation(doc, q('dt'), mk(false));
    mod.insertDualTranslation(doc, q('figcaption'), mk(false));
    return {
      pSibling: q('p + p.sk-dual-tr') !== null,
      pSrcClass: (q('#p1').getAttribute('class') || '').includes('sk-dual-src'),
      liCount: doc.querySelectorAll('ul li').length,
      liInnerSpan: q('li > span.sk-dual-tr') !== null,
      tdCount: doc.querySelectorAll('td').length,
      tdInnerSpan: q('td > span.sk-dual-tr') !== null,
      dtCount: doc.querySelectorAll('dt').length,
      dtInnerSpan: q('dt > span.sk-dual-tr') !== null,
      figcapCount: doc.querySelectorAll('figcaption').length,
      figcapInnerSpan: q('figcaption > span.sk-dual-tr') !== null,
      idStripped: q('.sk-dual-tr [id]') === null && q('#dup1') === null,
    };
  });
  // p：同 tag sibling + 原文標 class；li / td / dt / figcaption：內嵌 span
  //（sibling 會弄壞列表編號 / 表格結構 / dl 配對 / figure 單一 figcaption；
  //  span 不用 div——XHTML 1.1 的 dt / caption 只收 inline，div 對 EPUB2 無效）
  expect(out.pSibling).toBe(true);
  expect(out.pSrcClass).toBe(true);
  expect(out.liCount).toBe(1);
  expect(out.liInnerSpan).toBe(true);
  expect(out.tdCount).toBe(1);
  expect(out.tdInnerSpan).toBe(true);
  expect(out.dtCount).toBe(1);
  expect(out.dtInnerSpan).toBe(true);
  expect(out.figcapCount).toBe(1);
  expect(out.figcapInnerSpan).toBe(true);
  expect(out.idStripped).toBe(true);
  await page.close();
});

test('epub 表格 / 定義清單 block 收集：td / th / caption / dt / dd 進翻譯單位並寫回譯本', async ({ context, extensionId }) => {
  // Bug（2026-07-10 修）：htmlCloneFromXhtml 走「XMLSerializer → div.innerHTML」
  // reparse，HTML parser 在 div context 直接丟棄 <td>/<th>/<caption> tag →
  // firstElementChild = null → 表格內文字永遠不進 block（整本書表格默默不翻）。
  // 修法：document.importNode(el, true)（同 namespace，tagName 恢復大寫、屬性保留）
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page, FIXTURE_TABLE);

  // 收集層：表格類與 dl 類 block 全數進翻譯單位
  const texts = await page.evaluate(() => {
    const ch1 = window.__skEpubDoc.chapters.find((c) => c.href.endsWith('ch1.xhtml'));
    return ch1.blocks.map((b) => b.plainText);
  });
  expect(texts).toContain('Caption text about the specimens');
  expect(texts).toContain('Header cell about species');
  expect(texts).toContain('Body cell describing the northern specimen');
  expect(texts).toContain('Second cell describing the southern specimen');
  expect(texts).toContain('Definition term entry');
  expect(texts).toContain('Definition description with several words');
  expect(texts).toContain('Control paragraph with enough words to count as body text.');

  // 翻譯 + writer 寫回：譯文落在原本的表格結構內（tag 不變、cell 不增減）
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW');
    return window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
  });
  expect(out).toContain('<td>譯Body cell describing the northern specimen</td>');
  expect(out).toContain('<th>譯Header cell about species</th>');
  expect(out).toContain('<caption>譯Caption text about the specimens</caption>');
  expect(out).toContain('<dt>譯Definition term entry</dt>');
  expect(out).toContain('<dd>譯Definition description with several words</dd>');
  await page.close();
});

test('epub 全書術語表：promptSuffix + 合併進 editor + bookgloss 持久化 + 批次過濾注入', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);

  // 建立全書術語表 → editor 顯示 stub 的 2 條
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page.waitForTimeout(50);
  }
  const sources = await page.locator('#glossary-grid .g-source').evaluateAll((els) => els.map((e) => e.value));
  expect(sources).toContain('Elizabeth');
  expect(sources).toContain('Lizzy');

  // 分組渲染（2026-07-10）：人名 / 地名群組 header 存在；組內按原文字母排序
  //（stub 刻意 Lizzy 在前，顯示應 Elizabeth 在前）
  const groups = await page.locator('.glossary-group-header').evaluateAll((els) => els.map((e) => e.dataset.group));
  expect(groups).toContain('person');
  expect(groups).toContain('place');
  expect(sources.indexOf('Elizabeth')).toBeLessThan(sources.indexOf('Lizzy'));
  // 「人名不翻譯」toggle 位於人名 group header 內（2026-07-10 指定位置）
  expect(await page.locator('.glossary-group-header[data-group="person"] #glossary-person-notrans').count()).toBe(1);

  // 「重新抽取」= 強制重跑（forceRefresh 繞過 gloss_ 快取）
  page.on('dialog', (d) => d.accept());
  await page.click('#glossary-reextract-btn');
  const start2 = Date.now();
  while (Date.now() - start2 < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page.waitForTimeout(50);
  }
  const lastExtract = await page.evaluate(() => {
    const list = window.__sentMessages.filter((m) => m.type === 'EXTRACT_GLOSSARY');
    return list[list.length - 1];
  });
  expect(lastExtract.payload.forceRefresh).toBe(true);
  // 首次自動抽取（editor 初開）不帶 forceRefresh
  const firstExtract = await page.evaluate(() => window.__sentMessages.find((m) => m.type === 'EXTRACT_GLOSSARY'));
  expect(firstExtract.payload.forceRefresh).toBe(false);

  // EXTRACT_GLOSSARY 帶書籍模式 promptSuffix
  const extractMsgs = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'EXTRACT_GLOSSARY'));
  expect(extractMsgs.length).toBeGreaterThan(0);
  expect(extractMsgs[0].payload.promptSuffix).toContain('書籍模式');

  // 儲存（2026-07-10 起 EPUB 入口按鈕 = 儲存，開始翻譯集中在主流程）→ 回章節
  // 清單。持久化改 IndexedDB session（不受清除翻譯快取影響）
  // 按鈕語意 = 儲存（data-i18n key 驗證，不綁 UI 語言）
  expect(await page.locator('#glossary-translate-btn').getAttribute('data-i18n')).toBe('doc.glossary.btn.save');
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const session = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0] || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  expect(session).not.toBeNull();
  expect(session.glossary.length).toBe(3);

  // 只勾 ch2 → 主流程「翻譯勾選章節」
  await page.evaluate(() => {
    for (const c of window.__skEpubDoc.chapters) c.selected = (c.index === 3);
  });
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 批次級過濾：ch2 只出現 Elizabeth → payload.glossary 只含 1 條
  const batches = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH'));
  expect(batches.length).toBeGreaterThan(0);
  for (const b of batches) {
    expect(Array.isArray(b.payload.glossary)).toBe(true);
    expect(b.payload.glossary.length).toBe(1);
    expect(b.payload.glossary[0].source).toBe('Elizabeth');
  }
  await page.close();
});

test('epub 純函式：分輪切割 / 合併 first-wins / resolvePath', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, { stub: false });
  const out = await page.evaluate(async () => {
    const eng = await import('/translate-doc/epub-engine.js');
    const mkDoc = (texts) => ({ chapters: [{ blocks: texts.map((t) => ({ plainText: t })) }] });
    const big = 'x'.repeat(40_000);
    return {
      oneRound: eng.buildBookGlossaryRounds(mkDoc(['hello', 'world'])).length,
      twoRounds: eng.buildBookGlossaryRounds(mkDoc([big, big])).length,
      merged: eng.mergeBookGlossaries([
        [{ source: 'Ann', target: '安' }],
        [{ source: 'ann', target: '安妮' }, { source: 'Bob', target: '鮑伯' }],
      ]),
      // 選項 flag 保留（「匯入 JSON 合併」路徑的條目形狀）：勝出條目的 flag 為準
      mergedFlags: eng.mergeBookGlossaries([
        [{ source: 'Poole', target: 'Poole', noTranslate: true }],
        [
          { source: 'poole', target: '普爾' },
          { source: 'Hyde', target: '海德（Hyde）', dedupeAnnotation: true, dedupeKeep: 'target' },
        ],
      ]),
      paths: [
        eng.resolvePath('OEBPS/text', '../images/a.png'),
        eng.resolvePath('OEBPS', 'ch1.xhtml#fn1'),
        eng.resolvePath('', 'a%20b.xhtml'),
      ],
      // 超過 cap 要回報 dropped（匯入合併路徑據此告知使用者，不靜默丟）
      capped: (() => {
        const many = Array.from({ length: 7 }, (_, i) => ({ source: `t${i}`, target: `譯${i}` }));
        const r = eng.mergeBookGlossaries([many], 5);
        return { kept: r.entries.length, dropped: r.dropped };
      })(),
    };
  });
  expect(out.oneRound).toBe(1);
  expect(out.twoRounds).toBe(2);
  // first-wins:Ann 保留第一輪的「安」，衝突計 1;Bob 正常收
  expect(out.merged.entries).toEqual([
    { source: 'Ann', target: '安' },
    { source: 'Bob', target: '鮑伯' },
  ]);
  expect(out.merged.conflicts).toBe(1);
  // flag 保留：noTranslate / dedupeAnnotation+dedupeKeep 跟著勝出條目走
  expect(out.mergedFlags.entries).toEqual([
    { source: 'Poole', target: 'Poole', noTranslate: true },
    { source: 'Hyde', target: '海德（Hyde）', dedupeAnnotation: true, dedupeKeep: 'target' },
  ]);
  expect(out.mergedFlags.conflicts).toBe(1);
  expect(out.paths).toEqual(['OEBPS/images/a.png', 'OEBPS/ch1.xhtml', 'a b.xhtml']);
  expect(out.capped).toEqual({ kept: 5, dropped: 2 });
  await page.close();
});

test('epub DRM 拒收：錯誤 banner + 停在 upload', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, { stub: false });
  await page.setInputFiles('#file-input', FIXTURE_DRM);
  await page.waitForSelector('#upload-error:not([hidden])', { timeout: 15_000 });
  expect(await page.textContent('#upload-error')).toContain('DRM');
  expect(await page.locator('#stage-upload').isHidden()).toBe(false);
  await page.close();
});

// ============================================================================
// v2.0.11 第二批：術語表選項 / 預覽編輯 / EPUB2→3 輸出
// ============================================================================
//
// SANITY 紀錄（已驗證，2026-07-10）：
//   ③ epub-writer.js computeAnnotationDedupe 改為固定回空 Map →「對照只出現一次」
//     case 的後續替換斷言 fail（第二次出現仍是完整對照）→ 還原後 pass
//   ④ epub-writer.js applyBlockTranslation 的 editedHtml 分支改 `if (false)` →
//     「預覽編輯 roundtrip」case 的編輯內容斷言 fail → 還原後 pass

const FIXTURE_EPUB2 = path.join(__dirname, 'fixtures', 'epub2-mini-book.epub');

test('術語表選項：不翻譯 toggle 注入映射成 原文→原文；清空按鈕清 UI + 持久化', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);

  // 建術語表（stub 回 Elizabeth / Lizzy 兩條）
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page.waitForTimeout(50);
  }

  // 「人名不翻譯」批次 toggle（2026-07-10）：人名組（Elizabeth / Lizzy）整組設為
  // 不翻譯，地名（London）不受影響
  await page.locator('#glossary-person-notrans').check();
  const rowIdx = await page.locator('#glossary-grid .g-source').evaluateAll(
    (els) => els.findIndex((e) => e.value === 'Elizabeth'));
  expect(rowIdx).toBeGreaterThanOrEqual(0);
  expect(await page.locator('#glossary-grid .g-options').nth(rowIdx).locator('.g-notranslate').isChecked()).toBe(true);
  // 不翻譯勾選後譯文欄 disabled
  expect(await page.locator('#glossary-grid .g-target').nth(rowIdx).isDisabled()).toBe(true);
  const londonIdx = await page.locator('#glossary-grid .g-source').evaluateAll(
    (els) => els.findIndex((e) => e.value === 'London'));
  expect(await page.locator('#glossary-grid .g-options').nth(londonIdx).locator('.g-notranslate').isChecked()).toBe(false);

  // 手動新增列 + 不翻譯 + 空譯文：儲存時不可默默丟棄（2026-07-10 修）——
  // 不翻譯狀態下譯文欄 disabled 使用者填不了，空 target 以 source 補
  await page.click('#glossary-add-row-btn');
  await page.locator('#glossary-grid .g-source').last().fill('Gandalf');
  await page.locator('#glossary-grid .g-options').last().locator('.g-notranslate').check();

  // 本書禁用詞（2026-07-10）：EPUB 顯示區塊 + 加一條
  expect(await page.locator('#book-forbidden-section').isHidden()).toBe(false);
  await page.click('#book-forbidden-add-btn');
  await page.locator('#book-forbidden-grid .bf-forbidden').first().fill('進行');
  await page.locator('#book-forbidden-grid .bf-replacement').first().fill('');

  // 儲存 → 主流程只翻 ch2（含 Elizabeth）→ payload 映射與禁用詞注入
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page.evaluate(() => {
    for (const c of window.__skEpubDoc.chapters) c.selected = (c.index === 3);
  });
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const batches = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH'));
  expect(batches.length).toBeGreaterThan(0);
  const entry = batches[0].payload.glossary.find((e) => e.source === 'Elizabeth');
  expect(entry).toBeTruthy();
  expect(entry.target).toBe('Elizabeth'); // 不翻譯 → 原文→原文
  // 本書禁用詞隨批次送出
  expect(batches[0].payload.extraForbiddenTerms).toEqual([{ forbidden: '進行', replacement: '' }]);

  // 手動不翻譯列存活：session 持久化的術語表含 Gandalf→Gandalf（noTranslate）
  const manualEntry = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve((get.result[0]?.glossary || []).find((e) => e.source === 'Gandalf') || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  expect(manualEntry).toEqual({ source: 'Gandalf', target: 'Gandalf', noTranslate: true });

  // 清空按鈕：回 editor 清空 → empty state + session 持久化清成空
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  await page.click('#glossary-clear-btn');
  expect(await page.locator('#glossary-grid .g-source').count()).toBe(0);
  expect(await page.locator('#glossary-grid .glossary-state').isVisible()).toBe(true);
  const persisted = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0]?.glossary?.length ?? null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  expect(persisted).toBe(0);
  await page.close();
});

test('對照只出現一次：writer 後處理首次保留、後續替換（keepTarget / keepSource）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2); // ch1
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const doc = window.__skEpubDoc;
    // 造「同對照出現三次、跨兩個 block」的場景（ch1 的兩個 filler 段）
    const blocks = doc.chapters[2].blocks.filter((b) => b.translationStatus === 'done');
    blocks[2].translationRaw = '甲（Alpha）走過古道，甲（Alpha）再度回望。';
    blocks[2].translation = blocks[2].translationRaw;
    // blocks[3] 模擬「被掃描替換 / 手動編輯過」的段落（editedHtml，含行內標記）：
    // 2026-07-10 起 dedupe 不再整段跳過 edited 段落，text node 級照樣後處理
    blocks[3].editedHtml = '眾人跟著<em>甲（Alpha）</em>前行。';
    blocks[3].translation = '眾人跟著甲（Alpha）前行。';
    const glossary = [{ source: 'Alpha', target: '甲（Alpha）', dedupeAnnotation: true, dedupeKeep: 'target' }];
    const { bytes } = mod.buildTranslatedEpub(doc, 'zh-TW', { glossary });
    const ch1 = window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
    // keepSource 對照組 + 預設值（不帶 dedupeKeep = 後續用原文）對照組（純函式）
    const m2 = mod.computeAnnotationDedupe(doc, [{ source: 'Alpha', target: '甲（Alpha）', dedupeAnnotation: true, dedupeKeep: 'source' }]);
    const m3 = mod.computeAnnotationDedupe(doc, [{ source: 'Alpha', target: '甲（Alpha）', dedupeAnnotation: true }]);
    return {
      ch1,
      keepSourceSecond: m2.get(blocks[2].blockId)?.translation || '',
      defaultSecond: m3.get(blocks[2].blockId)?.translation || '',
    };
  });
  // 全書第一次出現保留完整對照，其後（同段第二次 + 下一段 edited 段）只剩譯文
  expect(out.ch1.match(/甲（Alpha）/g)?.length).toBe(1);
  expect(out.ch1).toContain('再度回望');
  expect(out.ch1).toMatch(/，甲再度回望/);
  // edited 段落也被後處理（行內標記保留、對照移除）
  expect(out.ch1).toContain('眾人跟著<em>甲</em>前行');
  // keepSource：後續用原文 Alpha，CJK↔拉丁邊界補空格（2026-07-10 bug 修）
  expect(out.keepSourceSecond).toContain('甲（Alpha）走過古道');
  expect(out.keepSourceSecond).toContain('，Alpha 再度回望');
  expect(out.keepSourceSecond).not.toContain('Alpha再');
  // 預設值 = 後續用原文（2026-07-10 指定）
  expect(out.defaultSecond).toContain('，Alpha 再度回望');
  await page.close();
});

test('預覽編輯 roundtrip：contenteditable 修改 → editedHtml 優先寫進譯本', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 開預覽 → 段落 contenteditable + 富文本（em 保留）
  await page.locator('.chapter-preview-btn').first().click();
  await page.waitForSelector('#stage-epub-preview:not([hidden])', { timeout: 10_000 });
  const firstPara = page.locator('.epub-preview-block[data-state="done"]').nth(1);
  expect(await firstPara.getAttribute('contenteditable')).toBe('true');
  expect(await firstPara.locator('em').count()).toBeGreaterThan(0);

  // 編輯：改文字 + dispatch blur
  await firstPara.evaluate((el) => {
    el.innerHTML = '手動編輯後的<em>譯文</em>內容';
    el.dispatchEvent(new Event('blur'));
  });
  expect(await firstPara.evaluate((el) => el.classList.contains('is-edited'))).toBe(true);

  // 譯本輸出用編輯後內容（含保留的 em）
  const ch1 = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW');
    return window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
  });
  expect(ch1).toContain('手動編輯後的');
  expect(ch1).toMatch(/<em[^>]*>譯文<\/em>/);
  await page.close();
});

test('session save debounce flush：編輯後立即重新上傳，編輯不掉失', async ({ context, extensionId }) => {
  // Bug（2026-07-10 修）：預覽編輯 blur 走 800ms debounce 排程存檔；debounce 內
  // 按「重新上傳」（或關頁）→ timer 醒來時 currentDoc 已清 → persist no-op →
  // 最後一筆編輯掉失。修法：releaseCurrentDoc 先 flushPendingSessionSave 再清 state
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page.locator('.chapter-preview-btn').first().click();
  await page.waitForSelector('#stage-epub-preview:not([hidden])', { timeout: 10_000 });

  // 編輯 + blur + 返回 + 重新上傳全在同一個 JS task 內完成——事件迴圈拿不到
  // 控制權，800ms debounce timer 絕對來不及自然觸發，flush 是唯一存檔路徑
  await page.evaluate(() => {
    const el = document.querySelectorAll('.epub-preview-block[data-state="done"]')[1];
    el.innerHTML = '快速離開前的編輯';
    el.dispatchEvent(new Event('blur'));
    document.getElementById('epub-preview-back-btn').click();
    document.getElementById('chapters-reupload-btn').click();
  });
  await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 10_000 });

  // 編輯已隨 flush 落地 IndexedDB（輪詢等待非同步寫入完成）
  let found = false;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    found = await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('shinkansen-epub-sessions');
      req.onsuccess = () => {
        const get = req.result.transaction('sessions').objectStore('sessions').getAll();
        get.onsuccess = () => resolve((get.result || []).some((s) =>
          Object.values(s.blocks || {}).some((b) => b.edited === '快速離開前的編輯')));
        get.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    }));
    if (found) break;
    await page.waitForTimeout(100);
  }
  expect(found).toBe(true);
  await page.close();
});

test('EPUB 2 來源：輸出格式選項顯示；升級 EPUB 3 產 nav + version + dcterms:modified', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page, FIXTURE_EPUB2);

  // NCX 標題有進章節清單；EPUB 2 版本顯示
  const rows = page.locator('.chapter-row');
  expect(await rows.nth(0).locator('.chapter-title').textContent()).toBe('1. First Chapter');
  expect(await page.textContent('#chapters-epub-version')).toBe('EPUB 2.0');

  // 未翻譯前不顯示格式選項
  expect(await page.locator('#epub-output-format-wrap').isHidden()).toBe(true);

  await selectOnlyChapter(page, 0);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  // EPUB2 來源 + 有譯文 → 顯示格式選項
  expect(await page.locator('#epub-output-format-wrap').isHidden()).toBe(false);

  const out = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const doc = window.__skEpubDoc;
    const dec = (bytes, name) => {
      const e = window.fflate.unzipSync(bytes)[name];
      return e ? window.fflate.strFromU8(e) : null;
    };
    const orig = mod.buildTranslatedEpub(doc, 'zh-TW', { upgradeTo3: false });
    const up = mod.buildTranslatedEpub(doc, 'zh-TW', { upgradeTo3: true });
    return {
      origOpf: dec(orig.bytes, 'OEBPS/content.opf'),
      origNav: dec(orig.bytes, 'OEBPS/sk-nav.xhtml'),
      upOpf: dec(up.bytes, 'OEBPS/content.opf'),
      upNav: dec(up.bytes, 'OEBPS/sk-nav.xhtml'),
    };
  });
  // 原檔版本：維持 2.0、無 nav
  expect(out.origOpf).toContain('version="2.0"');
  expect(out.origNav).toBeNull();
  // 升級：3.0 + dcterms:modified + nav item + nav 文件含 NCX 來的章節標題
  expect(out.upOpf).toContain('version="3.0"');
  expect(out.upOpf).toContain('dcterms:modified');
  expect(out.upOpf).toMatch(/properties="nav"/);
  expect(out.upNav).toContain('epub:type="toc"');
  expect(out.upNav).toContain('First Chapter');
  expect(out.upNav).toContain('href="ch1.xhtml"');
  await page.close();
});

// ============================================================================
// v2.0.11 第三批（2026-07-10 Jimmy 11 項）：session 續翻 / 真重翻 / 預覽強化
// ============================================================================
//
// SANITY 紀錄（已驗證，2026-07-10）：
//   ⑤ epub-writer.js spliceWithCjkSpacing 改為直接回傳 keep 不補空格 →「對照只出現
//     一次」case 的「，Alpha 再度回望」斷言 fail → 還原後 pass
//   ⑥ epub-session-db.js hydrateSessionBlocks 改為固定回 0 且不寫回 →「session 續翻」
//     case 的已翻章節還原斷言 fail → 還原後 pass
//   ⑦ index.js clearEpubBlocksCache 改為 no-op →「重勾已翻章節」case 的快取 key
//     清除斷言 fail → 還原後 pass
//   ⑧ index.js session 還原的 costUSD 載回行移除 →「session 續翻」case 的累計
//     費用列斷言 fail（cost=0 → row hidden）→ 還原後 pass
//   ⑨ index.js reextractGlossary 拔掉 forceRefresh: true →「全書術語表」case 的
//     lastExtract.payload.forceRefresh 斷言 fail → 還原後 pass。訊號層：spec 驗
//     「重新抽取有把 flag 送出」；background 端「flag 繞過 gloss_ 快取讀取」是
//     單行 guard（payload.forceRefresh ? null : await cache.getGlossary），由
//     code review 把關，真實效果靠 harness --glossary 重跑實測

test('session 續翻：翻完關頁重開同檔，進度自 IndexedDB 還原、不重打 API', async ({ context, extensionId }) => {
  // 第一頁：翻 ch1
  const page1 = await openDocPage(context, extensionId);
  await page1.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page1);
  await selectOnlyChapter(page1, 2);
  await page1.click('#chapters-translate-btn');
  await page1.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page1.close();

  // 第二頁（同 profile = 同 IndexedDB）：重開同檔 → ch1 應直接是已翻譯
  const page2 = await openDocPage(context, extensionId);
  await page2.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page2);
  const rows = page2.locator('.chapter-row');
  expect(await rows.nth(2).locator('.chapter-status').getAttribute('data-state')).toBe('done');
  // 還原章節預設不勾（續翻節奏）
  expect(await rows.nth(2).locator('input').isChecked()).toBe(false);
  // 全程沒送任何翻譯批次（進度來自 session，不是 cache 也不是 API）
  const sent = await page2.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH'));
  expect(sent.length).toBe(0);
  // 本書累計翻譯費用也隨 session 還原（2026-07-10）
  expect(await page2.locator('#chapters-cumulative-row').isHidden()).toBe(false);
  expect((await page2.textContent('#chapters-cumulative-cost')).trim().length).toBeGreaterThan(0);
  // 譯本可直接下載且含 session 還原的譯文
  const ch1 = await page2.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW');
    return window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
  });
  expect(ch1).toContain('譯');
  await page2.close();
});

test('重勾已翻章節：confirm 後清該批翻譯快取（真重翻，不吃 cache）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 播種假快取 key（真實情境由 background 寫入；stub 攔掉了 background，這裡手動放）
  const seeded = await page.evaluate(async () => {
    const enc = new TextEncoder();
    const keys = [];
    for (const b of window.__skEpubDoc.chapters[2].blocks) {
      if (b.translationStatus !== 'done') continue;
      const buf = await crypto.subtle.digest('SHA-1', enc.encode(b.epubSerializedText || b.plainText));
      const hex = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
      keys.push(`tc_${hex}_doc_mfake-model`);
    }
    const obj = {};
    for (const k of keys) obj[k] = { v: 'stale', t: 1 };
    await chrome.storage.local.set(obj);
    return keys;
  });
  expect(seeded.length).toBeGreaterThan(0);

  // 重勾 ch1 → 翻譯（dialog 自動接受）→ 假快取 key 應被清掉
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const remaining = await page.evaluate(async (keys) => {
    const got = await chrome.storage.local.get(keys);
    return Object.keys(got).length;
  }, seeded);
  expect(remaining).toBe(0);
  await page.close();
});

test('預覽強化：原文對照 toggle / 搜尋取代寫進譯本 / 全書預覽', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  // 翻 ch1 + ch2
  await page.click('#chapters-select-none-btn');
  await page.locator('.chapter-row').nth(2).locator('input[type=checkbox]').check();
  await page.locator('.chapter-row').nth(3).locator('input[type=checkbox]').check();
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 全書預覽：兩章的章節標題都在
  expect(await page.locator('#chapters-preview-all-btn').isHidden()).toBe(false);
  await page.click('#chapters-preview-all-btn');
  await page.waitForSelector('#stage-epub-preview:not([hidden])', { timeout: 10_000 });
  const chapterTitles = await page.locator('.epub-preview-chapter-title').allTextContents();
  expect(chapterTitles.some((t2) => t2.includes('Chapter One'))).toBe(true);
  expect(chapterTitles.some((t2) => t2.includes('Chapter Two'))).toBe(true);

  // 原文對照 toggle：開 → 每個已翻段落下方有原文；關 → 消失
  await page.locator('#epub-preview-compare').check();
  expect(await page.locator('.epub-preview-original').count()).toBeGreaterThan(0);
  const firstOriginal = await page.locator('.epub-preview-original').first().textContent();
  expect(firstOriginal).not.toContain('譯'); // 原文區是原文，不是 canned 譯文
  await page.locator('#epub-preview-compare').uncheck();
  expect(await page.locator('.epub-preview-original').count()).toBe(0);

  // 搜尋取代：canned 譯文含原文字串，把 'Lizzy' 取代成 '小莉'
  await page.locator('#epub-sr-find').fill('Lizzy');
  await page.locator('#epub-sr-replace').fill('小莉');
  await page.click('#epub-sr-apply');
  expect(await page.locator('#epub-sr-status').textContent()).toContain('1');
  // 取代寫進譯本（editedHtml 路徑），且 inline 標記還在
  const ch1 = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW');
    return window.fflate.strFromU8(window.fflate.unzipSync(bytes)['OEBPS/ch1.xhtml']);
  });
  expect(ch1).toContain('小莉');
  expect(ch1).not.toContain('Lizzy');
  expect(ch1).toContain('<em');
  await page.close();
});

// ============================================================================
// v2.0.11 第五批（2026-07-10）：術語表按鈕動態標籤 / 放棄本書翻譯 / 工作階段匯出匯入
// ============================================================================
//
// SANITY 紀錄（已驗證，2026-07-10）：
//   ⑩ index.js discardBookTranslation 的 `releaseCurrentDoc(); showStage('upload')`
//     改 `if (false)`（留在章節頁）→「放棄本書翻譯」case 等 #stage-upload 可見
//     timeout fail → 還原後 pass（2026-07-10 行為改為放棄後立即回選取檔案畫面，
//     原 block 重置迴圈已隨之移除，清乾淨與否改由「重新上傳同書不載回進度」驗）
//   ⑫ translate.js chunkSize 改回固定 DOC_CHUNK_SIZE（忽略 options.batchSize）→
//     「每批段數」case 的批次大小斷言 fail → 還原後 pass。訊號層：spec 驗
//     translate-doc 端切批與 payload.docBatchSize 送出；background 端「覆蓋
//     maxUnitsPerBatch → packChunks 按 50 切 API 請求」是兩行 guard，真實 API
//     請求數靠 harness 實測
//   ⑬ index.js discardBookTranslation 的 deleteEpubSession 改 `if (false)` →
//    「放棄本書翻譯」case 的 session=null 斷言 fail（收到整包 session）→ 還原後
//     pass（重新上傳同書的「進度不載回」斷言由同一破壞覆蓋）
//   ⑭ index.js extractGlossaryForBook 的 billedCostUSD 累加改 `if (false)` →
//     roundtrip case 的 #chapters-cumulative-row toBeVisible fail（Received:
//     hidden）+ exported.costUSD 0.001 ≠ 0.003 → 還原後 pass。過程中發現
//     .result-row 顯式 display:flex 蓋掉 [hidden]（本頁同款陷阱第三次）——
//     未修 CSS 前 row 恆顯示、toBeVisible 驗不到，補 .result-row[hidden]
//     display:none 後斷言才有鑑別力。訊號層：stub 攔 sendMessage，只驗頁面端
//     累加；background 端「抽取回應 usage 帶 billedCostUSD」由真實 harness 驗
//   ⑮ index.js handleGlossaryFileImport 的 entry.type 保留改 `if (false)` →
//    「分類 type 保留」case 匯入後 person 組 count 0 ≠ 2 fail → 還原後 pass
//   ⑯ epub-scan.js checkGlossaryCompliance 開頭改 `if (true) return []` →
//    「一致性掃描」case 的符合度違規列斷言 fail（1 ≠ 0）→ 還原後 pass
//   ⑲ index.js clearBookGlossaryExtractionCache 的 remove 改 `if (false)` →
//     roundtrip case「放棄清本書 gloss_ 抽取快取」斷言 fail（種的 key 仍在）
//     → 還原後 pass。不相干 gloss_ key 存活斷言驗「不誤刪別人的快取」
//   ⑰ index.js applyScanCase 的 text node 取代改 `if (false)` →「一致性掃描」
//     case 的「全書不再有普勒」斷言 fail → 還原後 pass
//   ㉑ index.js runConsistencyScan 的 applyComplianceFixes 呼叫改 `[]`（停用
//     自動替換）→「漂移偵測」case 的 .scan-autofixed-row 計數斷言 fail（0 ≠ 1）
//     → 還原後 pass（2026-07-10 自動替換）
//   ㉒ index.js manualComplianceFix 的 statusEl.textContent 賦值註解掉 →
//    「嘗試替換無可替換」case 的 statusText.length > 0 斷言 fail → 還原後 pass
//   ㉓ index.js 漂移案例的 ctxWrap append 改 `if (false && …)` →「漂移偵測」
//     case 的 .scan-rendering-context 計數斷言 fail（0 ≠ 3）→ 還原後 pass
//     （2026-07-10 每譯名附出現處上下文摘錄）
//   ㉔ index.js 符合度違規列的 ctxList 迴圈改 `slice(0, 0)` →「嘗試替換」case
//     的 .scan-compliance-item 計數斷言 fail（0 ≠ 3）→ 還原後 pass
//     （2026-07-10 違規列逐段附原文摘錄（原詞加粗）+ 譯文摘錄（位置比例對位）；
//       「一鍵替換」2026-07-10 稍後更名「嘗試替換」，僅 label 改字）
//   ㉕ index.js triggerManualScan 開頭加 `if (true) return` →「option 關閉」case
//     的手動掃描斷言 fail（mode 停在 manual ≠ results）→ 還原後 pass
//     （2026-07-10 手動重新掃描：入口按鈕 manual 模式 + 結果頁重新掃描鈕，
//       option 只 gate 自動掃描）
//   ㉖ index.js applyScanCase 暫時加回 addScanCaseToGlossary 呼叫 →「漂移偵測」
//     case 的「套用後 session glossary 無 Poole」斷言 fail → 還原後 pass
//     （2026-07-10 套用預設不回填術語表）
//   ㉗ index.js addScanCaseToGlossary 開頭加 `if (true) return` →「漂移偵測」
//     case 的「加入術語表後 Poole→普爾」輪詢斷言 fail → 還原後 pass
//   ㉘ index.js 已套用狀態的 keep 參數改 `''` →「漂移偵測」case 的
//     「狀態文字含普爾」斷言 fail → 還原後 pass（2026-07-10 套用後顯示選定譯名）
//   ㉙ index.js customComplianceReplace 開頭加 `if (true) return` →「嘗試替換」
//     case 的「搜尋替換後違規清空 / 揭露列 / 譯文含波爾」斷言 fail → 還原後 pass
//     （2026-07-10 違規列輸入實際譯名直接搜尋替換）
//   ㉚ epub-scan.js spliceCjkAware 開頭改純拼接 early return →「替換空格規則」
//     case 的 latinToCjk 斷言 fail（殘留空格「去法拉利 車隊…」≠ 預期）→ 還原後
//     pass（2026-07-10 CJK↔拉丁邊界補 / 移空格）
//   ㉛ index.js filterIgnoredViolations 開頭改 no-op return →「違規列搜尋替換 +
//     略過」case 的「略過後待處理列清空」斷言 fail（1 ≠ 0）→ 還原後 pass
//     （2026-07-10 略過清單：session 持久化、重掃不列、可復原；同輪移除
//       「嘗試替換」按鈕——㉒ 的 SANITY 紀錄保留為歷史）
//   ㉜ epub-scan.js spliceCjkAware 開頭加 `ctx = {}`（忽略節點邊界 context）→
//     「替換空格規則」case 的 ctxPrev 斷言 fail（'Haas 車隊…' 缺前導空格）→
//     還原後 pass（2026-07-10 Jimmy 回報「贊助商Haas 車隊」跨節點漏補空格）
//   ㉝ epub-writer.js computeAnnotationDedupe 的 edited 分支開頭加 `continue`
//     （回到整段跳過舊行為）→「對照只出現一次」case 的對照計數斷言 fail
//     （甲（Alpha）×2 ≠ 1）→ 還原後 pass（2026-07-10 Jimmy 回報：掃描替換過
//       的段落退出 dedupe，對照原文清不掉；改 text node 級照樣後處理）
//   ㉞ index.js undoScanCase 開頭加 `if (true) return` →「漂移偵測」case 的
//     「復原後 radios 回來」斷言 fail（0 ≠ 2）→ 還原後 pass
//   ㉟ index.js 已套用卡的 resultWrap append 改 `if (false)` →「漂移偵測」case
//     的套用結果摘錄計數斷言 fail（0 ≥ 1 不成立）→ 還原後 pass
//     （2026-07-10 套用後顯示結果摘錄 + 略過收起 + 復原還原）
//   ㊱ index.js runConsistencyScan 的漂移候選過濾拿掉（不過濾 epubScanIgnoredDrift）
//     →「option 關閉」case 的「略過項不再送對照抽取」payload 計數斷言 fail →
//     還原後 pass（2026-07-10 漂移案例略過：持久化 + 跳過 LLM；第一版 spec 只驗
//     卡片數被 render 過濾遮住抓不到，補 SCAN payload 級斷言才有鑑別力）
//   ⑱ index.js maybeRunConsistencyScan 的 option gate 改 `if (false && …)` →
//    「option 關閉」case 的 SCAN 訊息數 0 ≠ 1 fail → 還原後 pass。開發途中
//     另抓一個真 bug：mineCandidates 的 lowerWords 誤用「整段 lowercase 後收集」
//     → 每個大寫詞的小寫形必然存在 → 候選全滅（漂移 case count 0 ≠ 1 抓到）
//   ⑪ index.js importEpubSession 的 bookHash 比對改 `if (false)` →「跨書匯入拒絕」
//     斷言 fail（空 blocks 假檔被接受 → 進度被換成空、done 斷言 fail）→ 還原後
//     pass。第一版假檔只改 hash、blocks 為真 → 破壞後結果相同咬不到，改「錯
//     hash + 空 blocks」才有鑑別力

test('術語表按鈕動態標籤 + 放棄本書翻譯 + 工作階段匯出匯入 roundtrip', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);

  // 尚無術語表 → 按鈕 =「先建立全書術語表」
  expect(await page.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossary');

  // 建術語表（儲存）→ 按鈕 =「編輯全書術語表」
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page.waitForTimeout(50);
  }
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  expect(await page.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossaryEdit');

  // 術語表抽取費用累進「本書累計費用」：還沒翻譯任何章節,row 就應出現(0.002)
  await expect(page.locator('#chapters-cumulative-row')).toBeVisible();

  // 翻 ch1 → 匯出工作階段（攔 download 讀 JSON）
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  expect(await page.locator('#chapters-discard-btn').isHidden()).toBe(false);
  const dlPromise = page.waitForEvent('download');
  await page.click('#chapters-export-session-btn');
  const dl = await dlPromise;
  const sessionPath = await dl.path();
  const fs = await import('node:fs');
  const exported = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  expect(exported.type).toBe('shinkansen-epub-session');
  expect(Object.keys(exported.blocks).length).toBeGreaterThan(0);
  expect(exported.glossary.length).toBe(3);
  // 累計費用 = 術語表抽取 0.002 + 翻譯一批 0.001（缺抽取那份 = v2.0.11 修的漏計）
  expect(exported.costUSD).toBeCloseTo(0.003, 6);

  // 放棄前種 gloss_ 抽取輪快取（key 用與 bookGlossaryRoundHash 同公式算——
  // 公式若改，這裡會 fail 提醒兩處要同步）+ 一個不相干的 gloss_ key，
  // 驗「放棄清這本書的抽取快取、不誤刪別人的」
  const seededGlossKeys = await page.evaluate(async () => {
    const eng = await import('/translate-doc/epub-engine.js');
    const rounds = eng.buildBookGlossaryRounds(window.__skEpubDoc);
    const buf = new TextEncoder().encode(rounds[0] + '\n#shinkansen-book-glossary-v3');
    const hash = await crypto.subtle.digest('SHA-1', buf);
    const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const mine = `gloss_${hex}`;
    const mineSuffixed = `gloss_${hex}_langen`;
    const other = 'gloss_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await chrome.storage.local.set({
      [mine]: { v: [{ source: 'X', target: 'Y' }], t: 1 },
      [mineSuffixed]: { v: [{ source: 'X', target: 'Z' }], t: 1 },
      [other]: { v: [{ source: 'A', target: 'B' }], t: 1 },
    });
    return { mine, mineSuffixed, other };
  });

  // 放棄本書翻譯（confirm 自動接受，2026-07-10 修訂語意 = 全部 WIP 清除 +
  // 立即離開本頁回選取檔案畫面）→ session 紀錄整筆刪除
  await page.click('#chapters-discard-btn');
  await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 5_000 });
  expect(await page.locator('#stage-chapters').isHidden()).toBe(true);
  const sessionAfterDiscard = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0] || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  expect(sessionAfterDiscard).toBeNull(); // session 整筆刪除

  // gloss_ 抽取輪快取：本書的（含 _lang 後綴）被清、不相干的存活
  const glossAfterDiscard = await page.evaluate(
    (keys) => chrome.storage.local.get([keys.mine, keys.mineSuffixed, keys.other]),
    seededGlossKeys,
  );
  expect(seededGlossKeys.mine in glossAfterDiscard).toBe(false);
  expect(seededGlossKeys.mineSuffixed in glossAfterDiscard).toBe(false);
  expect(seededGlossKeys.other in glossAfterDiscard).toBe(true);

  // 重新上傳同一本書：session / 快取已清 → 進度、術語表、費用都不載回
  //（用「真實重開同書」驗清乾淨，比斷 UI 重繪更貼近使用者路徑）
  await uploadEpub(page);
  const rows = page.locator('.chapter-row');
  expect(await rows.nth(2).locator('.chapter-status').getAttribute('data-state')).toBe('none');
  expect(await page.locator('#chapters-download-btn').isHidden()).toBe(true);
  expect(await page.locator('#chapters-discard-btn').isHidden()).toBe(true);
  expect(await page.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossary');

  // 匯入剛才的工作階段 → 進度 + 術語表整包還原（ch1 done、零 API 呼叫增量）
  const sentBefore = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH').length);
  await page.setInputFiles('#epub-session-import-file', sessionPath);
  await page.waitForTimeout(500);
  expect(await rows.nth(2).locator('.chapter-status').getAttribute('data-state')).toBe('done');
  expect(await page.locator('#chapters-download-btn').isHidden()).toBe(false);
  expect(await page.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossaryEdit');
  const sentAfter = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'TRANSLATE_DOC_BATCH').length);
  expect(sentAfter).toBe(sentBefore);

  // 跨書匯入拒絕：bookHash 不符 → alert（dialog 自動接受）+ 進度不變
  const bogusPath = sessionPath + '.bogus.json';
  // 空 blocks + 錯 hash：若 bookHash 檢查失效，匯入會把進度換成空 → done 斷言 fail
  fs.writeFileSync(bogusPath, JSON.stringify({ ...exported, bookHash: 'deadbeef', blocks: {} }));
  await page.setInputFiles('#epub-session-import-file', bogusPath);
  await page.waitForTimeout(300);
  expect(await rows.nth(2).locator('.chapter-status').getAttribute('data-state')).toBe('done');
  await page.close();
});

test('術語表 JSON 匯出匯入：分類 type 保留（人名 / 地名分組不掉「其他」）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 3) break;
    await page.waitForTimeout(50);
  }
  // 抽取結果分組：person ×2（Lizzy / Elizabeth）+ place ×1（London）
  expect(await page.locator('#glossary-grid .g-source[data-gtype="person"]').count()).toBe(2);

  // 匯出 JSON（攔 download）→ 檔案內容帶 type
  const dlPromise = page.waitForEvent('download');
  await page.click('#glossary-export-btn');
  const dl = await dlPromise;
  const jsonPath = await dl.path();
  const fs = await import('node:fs');
  const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  expect(exported.filter((e) => e.type === 'person').length).toBe(2);
  expect(exported.filter((e) => e.type === 'place').length).toBe(1);

  // 匯入同一份 → 匯入模式 dialog（現有表非空時三選），點「覆蓋」→ 分組維持，
  // 不掉進「其他」
  await page.setInputFiles('#glossary-import-file', jsonPath);
  await page.waitForSelector('#glossary-import-dialog[open]', { timeout: 5_000 });
  await page.click('#glossary-import-overwrite-btn');
  await page.waitForTimeout(300);
  expect(await page.locator('#glossary-grid .g-source').count()).toBe(3);
  expect(await page.locator('#glossary-grid .g-source[data-gtype="person"]').count()).toBe(2);
  expect(await page.locator('#glossary-grid .g-source[data-gtype="place"]').count()).toBe(1);
  await page.close();
});

test('術語表 JSON 匯入合併：匯入譯名優先、現有獨有條目保留、flag 存活、取消不動表', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 3) break;
    await page.waitForTimeout(50);
  }
  // 匯入檔（模擬系列作前作術語表）：Lizzy 撞現有原文（譯名不同 + noTranslate
  // flag）、Darcy 是現有表沒有的新條目
  const fs = await import('node:fs');
  const os = await import('node:os');
  const importPath = path.join(os.tmpdir(), 'sk-glossary-merge-import.json');
  fs.writeFileSync(importPath, JSON.stringify([
    { source: 'Lizzy', target: '麗滋', type: 'person', noTranslate: true },
    { source: 'Darcy', target: '達西', type: 'person' },
  ]));

  // 取消：dialog 關閉、表不動（仍 3 條）
  await page.setInputFiles('#glossary-import-file', importPath);
  await page.waitForSelector('#glossary-import-dialog[open]', { timeout: 5_000 });
  await page.click('#glossary-import-cancel-btn');
  await page.waitForTimeout(200);
  expect(await page.locator('#glossary-import-dialog[open]').count()).toBe(0);
  expect(await page.locator('#glossary-grid .g-source').count()).toBe(3);

  // 合併：4 條 —— Lizzy 用匯入譯名 + noTranslate 打勾；Darcy 新增；
  // Elizabeth / London（現有表獨有）保留。合併後 alert 告知結果
  //（總條數 + 衝突數；超限捨棄由純函式 case 的 dropped 欄位覆蓋）
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.evaluate(() => { document.getElementById('glossary-import-file').value = ''; });
  await page.setInputFiles('#glossary-import-file', importPath);
  await page.waitForSelector('#glossary-import-dialog[open]', { timeout: 5_000 });
  await page.click('#glossary-import-merge-btn');
  await page.waitForTimeout(200);
  expect(await page.locator('#glossary-grid .g-source').count()).toBe(4);
  // 合併結果告知：一則 alert，含總條數 4 與衝突數 1（Lizzy 譯名不同以匯入為準）
  expect(alerts.length).toBe(1);
  expect(alerts[0]).toContain('4');
  expect(alerts[0]).toContain('1');
  const entries = await page.evaluate(() => {
    const out = [];
    for (const s of document.querySelectorAll('#glossary-grid .g-source')) {
      const target = s.nextElementSibling;
      const options = target.nextElementSibling;
      out.push({
        source: s.value,
        target: target.value,
        noTranslate: options.querySelector('.g-notranslate')?.checked || false,
      });
    }
    return out;
  });
  const bySource = Object.fromEntries(entries.map((e) => [e.source, e]));
  expect(bySource.Lizzy.target).toBe('麗滋');
  expect(bySource.Lizzy.noTranslate).toBe(true);
  expect(bySource.Darcy.target).toBe('達西');
  expect(bySource.Elizabeth.target).toBe('伊莉莎白');
  expect(bySource.London.target).toBe('倫敦');
  await page.close();
});


test('翻譯設定：每批段數生效 / Google preset 禁選 / 換模型重算每章費用', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => Promise.all([
    chrome.storage.sync.set({
      targetLanguage: 'zh-TW',
      translateDoc: { batchSize: 2 },
      translatePresets: [
        { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite', label: 'lite' },
        { slot: 2, engine: 'gemini', model: 'gemini-3.5-flash', label: 'flash' },
        { slot: 3, engine: 'google', label: 'gt' },
      ],
    }),
    chrome.storage.local.set({ translateDocPresetSlot: 1 }),
  ]));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await installMessageStub(page); // reload 後 stub 要重掛
  await page.reload({ waitUntil: 'domcontentloaded' });
  await uploadEpub(page);

  // 每批段數 = 2：ch1 有 5 個 block → 至少 3 個批次、每批 ≤2 段、payload 帶 docBatchSize
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const batches = await page.evaluate(() => window.__sentMessages
    .filter((m) => m.type === 'TRANSLATE_DOC_BATCH')
    .map((m) => ({ n: m.payload.texts.length, size: m.payload.docBatchSize })));
  expect(batches.length).toBeGreaterThanOrEqual(3);
  for (const b of batches) {
    expect(b.n).toBeLessThanOrEqual(2);
    expect(b.size).toBe(2);
  }

  // 換模型重算費用：記下 lite 的每章估價 → dialog 選 flash（貴 6 倍）→ 儲存 → 估價變貴
  const costBefore = await page.locator('.chapter-row').nth(3).locator('.chapter-cost').textContent();
  await page.click('#chapters-settings-btn');
  await page.waitForSelector('#translate-settings-dialog[open]', { timeout: 10_000 });

  // Google preset（slot 3）禁選：radio disabled + 標注
  const rows3 = page.locator('.settings-preset-row');
  const gtRow = rows3.nth(2);
  expect(await gtRow.locator('input[type=radio]').isDisabled()).toBe(true);
  expect(await gtRow.locator('.preset-unsupported-note').count()).toBe(1);

  // 每批段數輸入顯示現值 2
  expect(await page.locator('#settings-doc-batch-size').inputValue()).toBe('2');

  // 段落間距 toggle：EPUB 時顯示,勾選後隨儲存持久化（2026-07-10 踩坑補鎖：
  // HTML 區塊漏部署時 save handler 曾整包被 TypeError 吞掉）
  expect(await page.locator('#settings-epub-paragraph-spacing').isVisible()).toBe(true);
  await page.locator('#settings-epub-paragraph-spacing').check();

  // PRESET_DISPLAY 顯示順序 slot 2 排最前（主要預設）→ nth(0) 才是 slot 2
  await rows3.nth(0).click(); // 選 slot 2（gemini-3.5-flash）
  await page.click('#translate-settings-save-btn');
  await page.waitForTimeout(400);
  const costAfter = await page.locator('.chapter-row').nth(3).locator('.chapter-cost').textContent();
  expect(costAfter).not.toBe(costBefore);
  // 儲存後兩個設定都持久化（batchSize 不被 toggle 儲存拖垮）
  const savedTd = await page.evaluate(async () => (await chrome.storage.sync.get('translateDoc')).translateDoc);
  expect(savedTd.epubParagraphSpacing).toBe(true);
  expect(savedTd.batchSize).toBe(2);
  await page.close();
});

// SANITY 紀錄（已驗證，2026-07-10）：
//   ⑭ index.js session 還原改回 `session.glossary.length > 0` 才接受 →「清空術語表
//     後重開」case 的按鈕標籤斷言 fail（legacy key 把舊術語表復活 → 顯示「編輯」
//     且 editor 有條目）→ 還原後 pass

test('清空術語表後重開同檔：不被 legacy bookgloss_ 復活（2026-07-10 Jimmy 回報）', async ({ context, extensionId }) => {
  // 第一頁：建術語表（stub 3 條）→ 清空 → 儲存。另外播種 legacy bookgloss_ key
  // 模擬 dev 期舊資料（真實情境：v2.0.11 dev 期翻過的書）
  const page1 = await openDocPage(context, extensionId);
  page1.on('dialog', (d) => d.accept());
  await page1.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page1);
  const bookHash = await page1.evaluate(() => window.__skEpubDoc && document.title ? null : null);
  // 播種 legacy key（用頁面內部的 hash 算法：直接從 session key 反推不可行，
  // 改用 chrome.storage 掃 key —— 先建術語表讓 session 落地拿 hash）
  await page1.click('#chapters-glossary-btn');
  await page1.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page1.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page1.waitForTimeout(50);
  }
  await page1.click('#glossary-translate-btn'); // 儲存（session 落地，可拿 bookHash）
  await page1.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const hash = await page1.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAllKeys();
      get.onsuccess = () => resolve(get.result[0] || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  expect(hash).toBeTruthy();
  // 播種殭屍 legacy key
  await page1.evaluate(async (h) => {
    await chrome.storage.local.set({
      ['bookgloss_' + h]: { glossary: [{ source: 'Zombie', target: '殭屍' }], updatedAt: 1 },
    });
  }, hash);

  // 清空 → 儲存
  await page1.click('#chapters-glossary-btn');
  await page1.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  await page1.click('#glossary-clear-btn');
  await page1.click('#glossary-translate-btn');
  await page1.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  // 清空儲存後按鈕退回「先建立」
  expect(await page1.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossary');
  await page1.close();

  // 第二頁：重開同檔 → 術語表維持空（按鈕「先建立」、editor 空、不自動抽取）
  const page2 = await openDocPage(context, extensionId);
  await page2.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page2);
  expect(await page2.locator('#chapters-glossary-btn').getAttribute('data-i18n')).toBe('doc.epub.btn.glossary');
  await page2.click('#chapters-glossary-btn');
  await page2.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  await page2.waitForTimeout(500);
  // 空 = 建過但清空（[]）→ 不觸發自動抽取、不從 legacy 復活
  expect(await page2.locator('#glossary-grid .g-source').count()).toBe(0);
  const extracts = await page2.evaluate(() => window.__sentMessages.filter((m) => m.type === 'EXTRACT_GLOSSARY').length);
  expect(extracts).toBe(0);
  await page2.close();
});

test('術語表欄位排序：點原文/譯文 header 排序、再點反向、分組結構不變', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 3) break;
    await page.waitForTimeout(50);
  }
  const personSources = async () => page.evaluate(() =>
    [...document.querySelectorAll('.g-source[data-gtype="person"]')].map((e) => e.value));

  // 預設：原文升冪（Elizabeth < Lizzy）
  expect(await personSources()).toEqual(['Elizabeth', 'Lizzy']);

  // 再點原文 → 反向
  await page.click('#g-sort-source');
  expect(await personSources()).toEqual(['Lizzy', 'Elizabeth']);

  // 點譯文 → 依譯文升冪（期望值用同環境 localeCompare 算，不寫死 collation）
  await page.click('#g-sort-target');
  const expected = await page.evaluate(() =>
    [['Elizabeth', '伊莉莎白'], ['Lizzy', '莉茲']]
      .sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()))
      .map((x) => x[0]));
  expect(await personSources()).toEqual(expected);

  // 排序不破壞分組（stub 只有人名×2 + 地名×1，群組 header 順序不變）
  const groups = await page.locator('.glossary-group-header').evaluateAll((els) => els.map((e) => e.dataset.group));
  expect(groups).toEqual(['person', 'place']);
  await page.close();
});


// SANITY 紀錄（已驗證，2026-07-10）：
//   ⑯ epub-engine.js normalizeNameSeparators 改為原樣回傳 →「人名間隔號」case 的
//     術語表 input 值與譯文輸出斷言 fail → 還原後 pass

test('人名間隔號正規化：術語表 target 與譯文輸出 CJK·CJK → 全形・', async ({ context, extensionId }) => {
  // canned 譯文帶半形間隔號人名（拉夫·舒馬克），驗輸出端正規化
  const page = await openDocPage(context, extensionId, { cannedPrefix: '拉夫·舒馬克說：' });
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);

  // 純函式：CJK 之間三種半形點都轉全形；URL / 拉丁不動
  const fn = await page.evaluate(async () => {
    const eng = await import('/translate-doc/epub-engine.js');
    return {
      basic: eng.normalizeNameSeparators('拉夫·舒馬克'),
      u2027: eng.normalizeNameSeparators('拉夫‧舒馬克'),
      latin: eng.normalizeNameSeparators('a·b example.com·path'),
      mixed: eng.normalizeNameSeparators('見 M·A·C 與 瑪麗·安'),
    };
  });
  expect(fn.basic).toBe('拉夫・舒馬克');
  expect(fn.u2027).toBe('拉夫・舒馬克');
  expect(fn.latin).toBe('a·b example.com·path'); // 拉丁兩側不動
  expect(fn.mixed).toContain('瑪麗・安');
  expect(fn.mixed).toContain('M·A·C'); // 拉丁縮寫不動

  // 術語表資料層：手動輸入半形 → readGlossaryTable 正規化
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 2) break;
    await page.waitForTimeout(50);
  }
  await page.click('#glossary-add-row-btn');
  const lastSource = page.locator('#glossary-grid .g-source').last();
  const lastTarget = page.locator('#glossary-grid .g-target').last();
  await lastSource.fill('Ralf Schumacher');
  await lastTarget.fill('拉夫·舒馬克');
  await page.click('#glossary-translate-btn'); // 儲存（經 readGlossaryTable 正規化）
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const saved = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0]?.glossary || []);
      get.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  }));
  expect(saved.find((e) => e.source === 'Ralf Schumacher')?.target).toBe('拉夫・舒馬克');

  // 譯文輸出：canned 帶「拉夫·舒馬克」→ 翻完的 block 譯文已是全形・
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  const sample = await page.evaluate(() => {
    const b = window.__skEpubDoc.chapters[2].blocks.find((x) => x.translationStatus === 'done');
    return { raw: b.translationRaw, plain: b.translation };
  });
  expect(sample.plain).toContain('拉夫・舒馬克說');
  expect(sample.plain).not.toContain('拉夫·舒馬克');
  expect(sample.raw).toContain('拉夫・舒馬克說');
  await page.close();
});

// SANITY 紀錄（已驗證，2026-07-10）：
//   ⑰ epub-writer.js applyParagraphSpacing 改為 no-op →「段落間距」case 的
//     style 注入斷言 fail → 還原後 pass

test('段落間距 toggle：開啟注入 0.5em style、關閉重下載會移除（idempotent）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await uploadEpub(page);
  await selectOnlyChapter(page, 2);
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  const build = (spacing) => page.evaluate(async (on) => {
    const mod = await import('/translate-doc/epub-writer.js');
    const { bytes } = mod.buildTranslatedEpub(window.__skEpubDoc, 'zh-TW', { paragraphSpacing: on });
    const entries = window.fflate.unzipSync(bytes);
    return {
      ch1: window.fflate.strFromU8(entries['OEBPS/ch1.xhtml']),
      ch2: window.fflate.strFromU8(entries['OEBPS/ch2.xhtml']),
    };
  }, spacing);

  // 開啟：有譯文的 ch1 注入 style；未翻的 ch2 原樣不動
  const on = await build(true);
  expect(on.ch1).toContain('sk-paragraph-spacing');
  // 只注入 margin-top（margin collapse 給出「最少 0.5em」語意：與原書
  // margin-bottom 取 max，原書段距 ≥0.5em 時排版不變）
  expect(on.ch1).toContain('margin-top: 0.5em !important');
  expect(on.ch1).not.toContain('margin-bottom');
  expect(on.ch2).not.toContain('sk-paragraph-spacing');

  // 關閉重下載：同一份 doc（xhtmlDoc 已被前次 build 變更過）→ style 被移除，
  // 且不殘留重複注入
  const off = await build(false);
  expect(off.ch1).not.toContain('sk-paragraph-spacing');
  const on2 = await build(true);
  expect(on2.ch1.match(/sk-paragraph-spacing/g).length).toBe(1);
  await page.close();
});

// ============================================================================
// v2.0.11 第六批（2026-07-10）：譯後一致性掃描（option 預設開啟）
// ============================================================================
//
// 訊號層：stub 攔 SCAN_TERM_RENDERINGS（對照抽取回「取樣文中出現的已知譯名」），
// 驗頁面端整條路徑（挖掘→批次→聚合→案例 UI→套用→術語表回填→session 落地）
// 與 option gate；background 端真 LLM 對照品質不在此 spec（靠真書 harness）。

test('一致性掃描：漂移偵測 → 套用統一譯名（預設不回填）+ 加入術語表按鈕；符合度違規自動替換', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, {
    drift: { term: 'Poole', renderings: ['普爾', '普勒'] },
    scanKnown: ['普爾', '普勒'],
    glossaryEntries: [{ source: 'Utterson', target: '厄特森', type: 'person' }],
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await page.setInputFiles('#file-input', FIXTURE_SCAN);
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 先鎖術語表（Utterson→厄特森；canned 譯文不含厄特森 → 製造符合度違規）
  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  let start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 1) break;
    await page.waitForTimeout(50);
  }
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  // 翻譯全書（預設全選）→ 掃描自動觸發（option 預設開啟）→ 入口按鈕出現
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  start = Date.now();
  while (Date.now() - start < 10_000) {
    const btn = page.locator('#chapters-scan-btn');
    if (!(await btn.isHidden()) && !(await btn.isDisabled())) break;
    await page.waitForTimeout(50);
  }
  expect(await page.locator('#chapters-scan-btn').isHidden()).toBe(false);

  // 掃描費用累進「本書累計費用」（stub 每批 0.0005）
  expect(await page.locator('#chapters-cumulative-row').isHidden()).toBe(false);

  await page.click('#chapters-scan-btn');
  await page.waitForSelector('#stage-scan:not([hidden])', { timeout: 5_000 });

  // 漂移案例：Poole → 普爾 ×2 / 普勒 ×1，預設勾最多數的（普爾）
  const cases = page.locator('#scan-drift-list .scan-case');
  expect(await cases.count()).toBe(1);
  expect(await cases.first().locator('.scan-case-term').textContent()).toBe('Poole');
  const radios = cases.first().locator('input[type=radio]');
  expect(await radios.count()).toBe(2);
  expect(await radios.first().getAttribute('value')).toBe('普爾');
  expect(await radios.first().isChecked()).toBe(true);

  // 每譯名附出現處的譯文摘錄（2026-07-10）：光看譯名無法決策，須帶上下文；
  // 普爾出現 2 段 + 普勒 1 段 = 3 條摘錄，各含章節標記與 <strong> 加粗譯名
  const ctxLines = cases.first().locator('.scan-rendering-context');
  expect(await ctxLines.count()).toBe(3);
  expect(await ctxLines.first().locator('strong').textContent()).toBe('普爾');
  expect(await ctxLines.last().locator('strong').textContent()).toBe('普勒');
  expect((await ctxLines.first().textContent()).length).toBeGreaterThan('普爾'.length + 4);

  // 符合度違規（2026-07-10 起自動替換）：canned 譯文殘留原文詞 Utterson →
  // 掃描完成時已確定性替換為厄特森，列為「已自動替換」揭露列，不留待處理違規列
  const autoRows = page.locator('#scan-compliance-list .scan-autofixed-row');
  expect(await autoRows.count()).toBe(1);
  const autoText = await autoRows.first().textContent();
  expect(autoText).toContain('Utterson');
  expect(autoText).toContain('厄特森');
  expect(await page.locator('#scan-compliance-list .scan-compliance-row:not(.scan-autofixed-row)').count()).toBe(0);

  // 自動替換已落到譯文：全書不再殘留 Utterson，被改段落走 editedHtml（手動編輯語意）
  const fixed = await page.evaluate(() => {
    const doc = window.__skEpubDoc;
    const done = [];
    for (const ch of doc.chapters) {
      for (const b of ch.blocks) {
        if (b.translationStatus === 'done') {
          done.push({ t: b.translation, edited: typeof b.editedHtml === 'string' && b.editedHtml.length > 0 });
        }
      }
    }
    return done;
  });
  expect(fixed.some((b) => b.t.includes('Utterson'))).toBe(false);
  const uttersonFixed = fixed.filter((b) => b.t.includes('厄特森'));
  expect(uttersonFixed.length).toBeGreaterThanOrEqual(2);
  expect(uttersonFixed.every((b) => b.edited)).toBe(true);

  // 套用 → 全書不再有普勒、被改段落走 editedHtml（手動編輯語意）
  await cases.first().locator('button:not(.scan-add-glossary-btn):not(.scan-drift-skip-btn)').click();
  await page.waitForTimeout(200);

  // 已套用狀態文字帶選定譯名（2026-07-10：不顯示套成了什麼會無從對帳）
  expect(await cases.first().locator('.scan-case-status').first().textContent()).toContain('普爾');
  const after = await page.evaluate(() => {
    const doc = window.__skEpubDoc;
    const done = [];
    for (const ch of doc.chapters) {
      for (const b of ch.blocks) {
        if (b.translationStatus === 'done') {
          done.push({ t: b.translation, edited: typeof b.editedHtml === 'string' && b.editedHtml.length > 0 });
        }
      }
    }
    return done;
  });
  expect(after.some((b) => b.t.includes('普勒'))).toBe(false);
  expect(after.filter((b) => b.t.includes('普爾')).length).toBeGreaterThanOrEqual(3);
  expect(after.some((b) => b.edited)).toBe(true);

  // 套用結果摘錄（2026-07-10）：每個被改段落列出當前譯文前後文、統一譯名加粗
  const appliedCtx = cases.first().locator('.scan-applied-contexts .scan-rendering-context');
  expect(await appliedCtx.count()).toBeGreaterThanOrEqual(1);
  expect(await appliedCtx.first().locator('strong').textContent()).toBe('普爾');

  // 復原（2026-07-10）：文字還原（普勒回來）、案例卡回到譯名選擇狀態
  await cases.first().locator('.scan-case-undo-btn').click();
  await page.waitForTimeout(100);
  expect(await cases.first().locator('input[type=radio]').count()).toBe(2);
  const undone = await page.evaluate(() => {
    const doc = window.__skEpubDoc;
    let hasPuLe = false;
    for (const ch of doc.chapters) {
      for (const b of ch.blocks) {
        if (b.translationStatus === 'done' && b.translation.includes('普勒')) hasPuLe = true;
      }
    }
    return hasPuLe;
  });
  expect(undone).toBe(true);

  // 重新套用（後續「加入術語表」/「略過」流程以套用後狀態繼續）
  await cases.first().locator('button:not(.scan-add-glossary-btn):not(.scan-drift-skip-btn)').click();
  await page.waitForTimeout(200);
  expect(await cases.first().locator('.scan-case-status').first().textContent()).toContain('普爾');

  // 套用預設不回填術語表（2026-07-10）：等 session 落地（debounce 800ms）後
  // 確認 glossary 無 Poole；再按獨立「加入術語表」按鈕 → 回填 + session 落地
  const readSessionGloss = () => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0]?.glossary || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  await page.waitForTimeout(1200);
  let sessionGloss = await readSessionGloss();
  expect((sessionGloss || []).some((e) => e.source === 'Poole')).toBe(false);

  await cases.first().locator('.scan-add-glossary-btn').click();
  start = Date.now();
  while (Date.now() - start < 5_000) {
    sessionGloss = await readSessionGloss();
    if (Array.isArray(sessionGloss) && sessionGloss.some((e) => e.source === 'Poole')) break;
    await page.waitForTimeout(100);
  }
  const pooleEntry = (sessionGloss || []).find((e) => e.source === 'Poole');
  expect(pooleEntry?.target).toBe('普爾');

  // 略過（已套用案例，2026-07-10）：人工確認結果沒問題 → 卡片收起
  await cases.first().locator('.scan-case-dismiss-btn').click();
  await page.waitForTimeout(100);
  expect(await cases.count()).toBe(0);

  // 套用後案例結案 → 入口按鈕只剩自動替換揭露列計數（仍可見）
  await page.click('#scan-back-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 5_000 });
  expect(await page.locator('#chapters-scan-btn').isHidden()).toBe(false);

  // 匯入工作階段 = 整包取代進度 → 舊掃描結果一併重置（2026-07-10 修），
  // 不留指向被取代譯文的過期發現；入口按鈕轉為手動掃描模式
  //（2026-07-10 起書內有已翻段落即顯示，不再隱藏）
  const dlPromise = page.waitForEvent('download');
  await page.click('#chapters-export-session-btn');
  const dl = await dlPromise;
  await page.setInputFiles('#epub-session-import-file', await dl.path());
  let scanMode = '';
  start = Date.now();
  while (Date.now() - start < 5_000) {
    scanMode = await page.locator('#chapters-scan-btn').getAttribute('data-sk-mode');
    if (scanMode === 'manual') break;
    await page.waitForTimeout(100);
  }
  expect(scanMode).toBe('manual');
  await page.close();
});

test('一致性掃描：違規列搜尋替換 + 略過（session 持久化、重掃不列、可復原）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, {
    // 術語表指定 Poole→波爾，但 canned 譯文把 Poole 全譯成「普爾」（drift 單一譯名）
    // → 譯文既無指定譯名也未殘留原文詞 → 自動替換無從下手，違規留在待處理清單
    drift: { term: 'Poole', renderings: ['普爾'] },
    scanKnown: ['普爾'],
    glossaryEntries: [{ source: 'Poole', target: '波爾', type: 'person' }],
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({ targetLanguage: 'zh-TW' }));
  await page.setInputFiles('#file-input', FIXTURE_SCAN);
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });

  await page.click('#chapters-glossary-btn');
  await page.waitForSelector('#stage-glossary:not([hidden])', { timeout: 15_000 });
  let start = Date.now();
  while (Date.now() - start < 10_000) {
    if ((await page.locator('#glossary-grid .g-source').count()) >= 1) break;
    await page.waitForTimeout(50);
  }
  await page.click('#glossary-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  start = Date.now();
  while (Date.now() - start < 10_000) {
    const btn = page.locator('#chapters-scan-btn');
    if (!(await btn.isHidden()) && !(await btn.isDisabled())) break;
    await page.waitForTimeout(50);
  }
  await page.click('#chapters-scan-btn');
  await page.waitForSelector('#stage-scan:not([hidden])', { timeout: 5_000 });

  // 違規未被自動替換（譯文只有「普爾」，無 Poole 也無波爾）→ 待處理列：
  // 輸入欄 + 搜尋替換 + 略過（「嘗試替換」已於 2026-07-10 移除——自動替換上線後
  // 留在待處理清單的違規必不含原文詞，該按鈕永遠替換不到）
  const row = page.locator('#scan-compliance-list .scan-compliance-row:not(.scan-autofixed-row):not(.scan-skipped-row)');
  expect(await row.count()).toBe(1);
  expect(await row.first().textContent()).toContain('Poole');
  expect(await page.locator('#scan-compliance-list .scan-autofixed-row').count()).toBe(0);
  expect(await row.locator('.scan-case-actions button').count()).toBe(2); // 搜尋替換 + 略過
  expect(await row.locator('.scan-custom-replace-btn').count()).toBe(1);
  expect(await row.locator('.scan-skip-btn').count()).toBe(1);
  expect(await row.locator('.scan-term-input').count()).toBe(1);

  // 每違規段附「原文摘錄（原詞加粗）+ 譯文摘錄」（2026-07-10）：
  // fixture Poole 3 段 → 3 組;譯文摘錄以位置比例對位，應看得到實際譯法「普爾」
  const ctxItems = row.locator('.scan-compliance-item');
  expect(await ctxItems.count()).toBe(3);
  const srcStrong = row.locator('.scan-compliance-item strong');
  expect(await srcStrong.count()).toBe(3);
  expect(await srcStrong.first().textContent()).toBe('Poole');
  const dstTexts = await row.locator('.scan-compliance-item .scan-rendering-context:nth-child(2)').allTextContents();
  expect(dstTexts.length).toBe(3);
  expect(dstTexts.some((s) => s.includes('普爾'))).toBe(true);

  // 略過（2026-07-10）：人工 review 認定不需替換 → 待處理列移除、
  // 揭露「已略過」列（可復原）、隨工作階段持久化
  await row.locator('.scan-skip-btn').click();
  await page.waitForTimeout(100);
  expect(await row.count()).toBe(0);
  const skippedRow = page.locator('#scan-compliance-list .scan-skipped-row');
  expect(await skippedRow.count()).toBe(1);
  expect(await skippedRow.first().textContent()).toContain('Poole');

  // 略過清單落地 session（debounce 800ms → 輪詢）
  const readSessionIgnored = () => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0]?.scanIgnored || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  start = Date.now();
  let ignored = null;
  while (Date.now() - start < 5_000) {
    ignored = await readSessionIgnored();
    if (Array.isArray(ignored) && ignored.some((e) => e.source === 'Poole')) break;
    await page.waitForTimeout(100);
  }
  expect((ignored || []).some((e) => e.source === 'Poole' && e.expected === '波爾')).toBe(true);

  // 重新掃描：已略過 entry 不再列出（也不被自動替換）
  await page.click('#scan-rescan-btn');
  start = Date.now();
  while (Date.now() - start < 10_000) {
    if (!(await page.locator('#scan-rescan-btn').isDisabled())) break;
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100);
  expect(await row.count()).toBe(0);
  expect(await page.locator('#scan-compliance-list .scan-skipped-row').count()).toBe(1);

  // 復原 → 待處理列回來
  await page.locator('.scan-skip-undo-btn').click();
  await page.waitForTimeout(100);
  expect(await row.count()).toBe(1);
  expect(await page.locator('#scan-compliance-list .scan-skipped-row').count()).toBe(0);

  // 使用者輸入實際譯名搜尋替換（2026-07-10）：普爾 → 波爾，違規清空、
  // 揭露列改列「已搜尋替換」、譯文更新
  await row.locator('.scan-term-input').fill('普爾');
  await row.locator('.scan-custom-replace-btn').click();
  await page.waitForTimeout(100);
  expect(await page.locator('#scan-compliance-list .scan-compliance-row:not(.scan-autofixed-row)').count()).toBe(0);
  const fixedRows = page.locator('#scan-compliance-list .scan-autofixed-row');
  expect(await fixedRows.count()).toBe(1);
  const fixedText = await fixedRows.first().textContent();
  expect(fixedText).toContain('Poole');
  expect(fixedText).toContain('波爾');
  const after = await page.evaluate(() => {
    const doc = window.__skEpubDoc;
    let pooleBlockHasPu = false;
    let hasBo = false;
    for (const ch of doc.chapters) {
      for (const b of ch.blocks) {
        if (b.translationStatus !== 'done') continue;
        if (b.plainText.includes('Poole') && b.translation.includes('普爾')) pooleBlockHasPu = true;
        if (b.translation.includes('波爾')) hasBo = true;
      }
    }
    return { pooleBlockHasPu, hasBo };
  });
  expect(after.pooleBlockHasPu).toBe(false);
  expect(after.hasBo).toBe(true);
  await page.close();
});

test('替換空格規則：CJK↔拉丁邊界補 / 移空格（replaceTermInText 純函式）', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, { stub: false });
  const res = await page.evaluate(async () => {
    const mod = await import('/translate-doc/epub-scan.js');
    const r = (text, term, rep) => mod.replaceTermInText(text, term, rep);
    return {
      latinToCjk: r('去 Ferrari 車隊看看', 'Ferrari', '法拉利'),      // 前後空格都該移除
      latinToCjkHead: r('Ferrari 車隊出發了', 'Ferrari', '法拉利'),   // 句首，只有後空格
      cjkToLatin: r('去法拉利車隊看看', '法拉利', 'Ferrari'),          // 反向：兩側補空格
      latinToLatin: r('the Ferrari team', 'Ferrari', 'Enzo'),          // 純英文：原空格保留、不多不少
      wordBoundary: r('Ferraris 車隊', 'Ferrari', '法拉利'),           // 詞邊界：不可命中 Ferraris
      punctAfter: r('這是法拉利，很快', '法拉利', 'Ferrari'),          // 標點前不補空格
      // 節點邊界 context（2026-07-10 Jimmy 回報「贊助商Haas 車隊」）：
      // 詞在 text node 開頭，前一個節點結尾是 CJK → 靠 ctx.prevChar 補前空格
      ctxPrev: mod.replaceTermInText('哈斯車隊就會倒', '哈斯', 'Haas', { prevChar: '商' }),
      ctxNext: mod.replaceTermInText('支持哈斯', '哈斯', 'Haas', { nextChar: '的' }),
    };
  });
  expect(res.latinToCjk.text).toBe('去法拉利車隊看看');
  expect(res.latinToCjk.count).toBe(1);
  expect(res.latinToCjkHead.text).toBe('法拉利車隊出發了');
  expect(res.cjkToLatin.text).toBe('去 Ferrari 車隊看看');
  expect(res.latinToLatin.text).toBe('the Enzo team');
  expect(res.wordBoundary.count).toBe(0);
  expect(res.punctAfter.text).toBe('這是 Ferrari，很快');
  expect(res.ctxPrev.text).toBe(' Haas 車隊就會倒');
  expect(res.ctxNext.text).toBe('支持 Haas ');

  // DOM 接線：詞整顆在 inline 節點內，前後 CJK 在相鄰節點——
  // replaceInTextNodes 要把相鄰節點字元交給空格規則
  const dom = await page.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '這個贊助商<em>哈斯</em>車隊就會倒';
    const hits = window.__skReplaceInTextNodes(div, '哈斯', 'Haas');
    return { hits, text: div.textContent };
  });
  expect(dom.hits).toBe(1);
  expect(dom.text).toBe('這個贊助商 Haas 車隊就會倒');
  await page.close();
});

test('一致性掃描 option 關閉：翻譯完成後不自動掃描；手動掃描不受 option 限制', async ({ context, extensionId }) => {
  const page = await openDocPage(context, extensionId, {
    drift: { term: 'Poole', renderings: ['普爾', '普勒'] },
    scanKnown: ['普爾', '普勒'],
  });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => chrome.storage.sync.set({
    targetLanguage: 'zh-TW',
    translateDoc: { consistencyScan: false },
  }));
  await page.setInputFiles('#file-input', FIXTURE_SCAN);
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page.click('#chapters-translate-btn');
  await page.waitForSelector('#stage-chapters:not([hidden])', { timeout: 15_000 });
  await page.waitForTimeout(800); // 若誤觸發，掃描早該送出 SCAN 訊息
  const scanMsgs = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'SCAN_TERM_RENDERINGS').length);
  expect(scanMsgs).toBe(0);

  // 入口按鈕不因 option 關閉而消失：顯示手動掃描模式（2026-07-10）
  const btn = page.locator('#chapters-scan-btn');
  expect(await btn.isHidden()).toBe(false);
  expect(await btn.getAttribute('data-sk-mode')).toBe('manual');

  // 手動觸發不受 option 限制：點擊 → 送 SCAN 訊息 → 漂移發現 → 轉結果模式
  await btn.click();
  let mode = '';
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    mode = await btn.getAttribute('data-sk-mode');
    if (mode === 'results') break;
    await page.waitForTimeout(50);
  }
  expect(mode).toBe('results');
  const scanMsgsAfter = await page.evaluate(() => window.__sentMessages.filter((m) => m.type === 'SCAN_TERM_RENDERINGS').length);
  expect(scanMsgsAfter).toBeGreaterThan(0);
  await btn.click();
  await page.waitForSelector('#stage-scan:not([hidden])', { timeout: 5_000 });
  expect(await page.locator('#scan-drift-list .scan-case').count()).toBe(1);

  // 漂移案例「略過」（2026-07-10）：未套用卡收起 → 揭露列（可復原）→
  // session 持久化 → 重掃連候選都不進（不再偵測）→ 復原後重掃回來
  await page.locator('#scan-drift-list .scan-drift-skip-btn').click();
  await page.waitForTimeout(100);
  expect(await page.locator('#scan-drift-list .scan-case').count()).toBe(0);
  const driftSkipped = page.locator('#scan-drift-list .scan-drift-skipped-row');
  expect(await driftSkipped.count()).toBe(1);
  expect(await driftSkipped.first().textContent()).toContain('Poole');

  // session 落地輪詢
  const readIgnoredDrift = () => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('shinkansen-epub-sessions');
    req.onsuccess = () => {
      const get = req.result.transaction('sessions').objectStore('sessions').getAll();
      get.onsuccess = () => resolve(get.result[0]?.scanIgnoredDrift || null);
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }));
  let ignoredDrift = null;
  const start3 = Date.now();
  while (Date.now() - start3 < 5_000) {
    ignoredDrift = await readIgnoredDrift();
    if (Array.isArray(ignoredDrift) && ignoredDrift.includes('Poole')) break;
    await page.waitForTimeout(100);
  }
  expect(ignoredDrift).toContain('Poole');

  // 重掃：Poole 不再進候選（案例 0、揭露列仍在），且不送 LLM 對照抽取（省費用）
  const countPooleScanItems = () => page.evaluate(() =>
    window.__sentMessages.filter((m) => m.type === 'SCAN_TERM_RENDERINGS')
      .flatMap((m) => (m.payload?.items || []).map((it) => it.term))
      .filter((term) => term === 'Poole').length);
  const pooleScansBefore = await countPooleScanItems();
  await page.click('#scan-rescan-btn');
  const start4 = Date.now();
  while (Date.now() - start4 < 10_000) {
    if (!(await page.locator('#scan-rescan-btn').isDisabled())) break;
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100);
  expect(await page.locator('#scan-drift-list .scan-case').count()).toBe(0);
  expect(await page.locator('#scan-drift-list .scan-drift-skipped-row').count()).toBe(1);
  expect(await countPooleScanItems()).toBe(pooleScansBefore); // 略過項不再送對照抽取

  // 復原 → 揭露列消失；再重掃 → 案例回來
  await page.locator('.scan-drift-skip-undo-btn').click();
  await page.waitForTimeout(100);
  expect(await page.locator('#scan-drift-list .scan-drift-skipped-row').count()).toBe(0);
  await page.click('#scan-rescan-btn');
  const start5 = Date.now();
  while (Date.now() - start5 < 10_000) {
    if (!(await page.locator('#scan-rescan-btn').isDisabled())) break;
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100);
  expect(await page.locator('#scan-drift-list .scan-case').count()).toBe(1);
  await page.close();
});
