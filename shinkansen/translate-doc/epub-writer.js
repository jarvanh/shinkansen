// epub-writer.js — 譯文 EPUB 重建（v2.0.11 起）
//
// 職責：
//   1. 把已翻譯 block 的譯文（translationRaw，含 ⟦N⟧）反序列化回 XHTML DOM
//      （重用 content-serialize.js 的 SK.deserializeWithPlaceholders，
//      frag 是頁面 HTML document 的節點，importNode 進章節 XHTML document）
//   2. 更新語言 metadata（OPF dc:language + 修改過章節的 html@lang/@xml:lang，
//      Apple Books / Kobo 依此選字型與斷行規則）
//   3. fflate 重打包：mimetype 必須是第一個 entry 且不壓縮（EPUB/OCF 規範），
//      其餘未修改 entry 原樣 bit-for-bit 帶過（CSS / 圖片 / 字型不動，
//      譯本在閱讀器的樣式與原書一致）
//
// 未翻章節 / 失敗 block：保留原文原樣（部分譯本下載天然支援）。

const XML_SER = new XMLSerializer();
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>\n';

function getSK() {
  const SK = window.__SK;
  if (!SK || typeof SK.deserializeWithPlaceholders !== 'function') {
    throw new Error('serializer not loaded');
  }
  return SK;
}

// 使用者在預覽頁 contenteditable 編輯過的 HTML → 消毒後 parse 成頁面 frag。
// 消毒：剝 script / style / template 元素與 on* 事件屬性（貼上內容可能夾帶）
function editedHtmlToFrag(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  for (const bad of container.querySelectorAll('script, style, template')) bad.remove();
  for (const el of container.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  const frag = document.createDocumentFragment();
  while (container.firstChild) frag.appendChild(container.firstChild);
  return frag;
}

// 譯文寫回單一 block。優先序：
//   1. block.editedHtml（使用者在預覽頁手動編輯過，最終版）
//   2. override?.translationRaw ?? block.translationRaw 反序列化（機器譯文，含 ⟦N⟧）
//   3. 純文字 fallback（override?.translation ?? block.translation，已去除標記）
// override 來自 computeAnnotationDedupe（「對照只出現一次」後處理版本），
// raw 與 plain 兩路都要吃 override——反序列化失敗走 fallback 時不可漏掉後處理
function applyBlockTranslation(SK, xhtmlDoc, block, override) {
  const el = block.el;
  if (!el) return false;
  if (typeof block.editedHtml === 'string' && block.editedHtml.length > 0) {
    el.replaceChildren(xhtmlDoc.importNode(editedHtmlToFrag(block.editedHtml), true));
    return true;
  }
  const raw = override?.translationRaw ?? block.translationRaw;
  if (typeof raw === 'string' && raw.length > 0 && Array.isArray(block.slots)) {
    // cloneReuse：frag 不注回序列化來源（HTML clone），slot 一律 clone 殼重建
    const { frag, ok } = SK.deserializeWithPlaceholders(raw, block.slots, { cloneReuse: true });
    if (ok || (block.slots.length === 0 && frag.childNodes.length > 0)) {
      const imported = xhtmlDoc.importNode(frag, true);
      el.replaceChildren(imported);
      return true;
    }
  }
  const plain = override?.translation ?? block.translation;
  if (typeof plain === 'string' && plain.length > 0) {
    el.replaceChildren(xhtmlDoc.createTextNode(plain));
    return true;
  }
  return false;
}

// ─── 「譯文（原文）」對照只出現一次（v2.0.11）───────────────
// glossary entry 帶 dedupeAnnotation 時：整本書（按 spine 閱讀順序）第一次出現
// 「譯文（原文）」保留完整對照，後續出現替換成譯文或原文（dedupeKeep）。
// 確定性後處理：不改已存的 block 資料，回傳 blockId → 替換後字串的 map，
// 下載（buildTranslatedEpub）與預覽（openEpubPreview）共用同一份計算。
// 手動編輯過（editedHtml）的 block 不套用——使用者文字為最終版。
const ANNOTATED_RE = /^(.+)（(.+)）\s*$/;

// 替換片段左右的 CJK↔拉丁邊界補空格（台灣排版慣例）。「後續用原文」時替換進去的
// 是拉丁字串（如 Alpha），直接貼著中文會擠成一團（2026-07-10 Jimmy 回報 bug）
const CJK_EDGE_RE = /[㐀-鿿豈-﫿]/;
const LATIN_EDGE_RE = /[A-Za-z0-9]/;

function spliceWithCjkSpacing(text, start, end, keep) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  let mid = keep;
  if (before && CJK_EDGE_RE.test(before[before.length - 1]) && LATIN_EDGE_RE.test(mid[0] || '')) {
    mid = ' ' + mid;
  }
  if (after && LATIN_EDGE_RE.test(mid[mid.length - 1] || '') && CJK_EDGE_RE.test(after[0])) {
    mid = mid + ' ';
  }
  return before + mid + after;
}

// text 內 full 的所有出現替換成 keep（含邊界補空格）；skipFirst 時第一個出現保留
function replaceOccurrences(text, full, keep, skipFirst) {
  if (!text || !text.includes(full)) return { text, changed: false, sawAny: false };
  let out = text;
  let from = 0;
  let first = true;
  let changed = false;
  while (true) {
    const idx = out.indexOf(full, from);
    if (idx === -1) break;
    if (skipFirst && first) {
      first = false;
      from = idx + full.length;
      continue;
    }
    out = spliceWithCjkSpacing(out, idx, idx + full.length, keep);
    changed = true;
    from = idx + keep.length + 2; // +2 = 最多補兩個空格的餘裕（保守前進即可）
  }
  return { text: out, changed, sawAny: true };
}

export function computeAnnotationDedupe(epubDoc, glossary) {
  const out = new Map(); // blockId → { translation, translationRaw }
  const rules = [];
  for (const e of glossary || []) {
    if (!e || e.dedupeAnnotation !== true || typeof e.target !== 'string') continue;
    const m = e.target.match(ANNOTATED_RE);
    if (!m) continue;
    // 預設「後續用原文」（2026-07-10 Jimmy 指定；明確選 target 才用譯文）
    rules.push({ full: e.target, keep: e.dedupeKeep === 'target' ? m[1] : m[2], seen: false });
  }
  if (rules.length === 0) return out;

  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.editedHtml === 'string' && b.editedHtml.length > 0) continue;
      let t = b.translation || '';
      let raw = b.translationRaw || '';
      let changed = false;
      for (const rule of rules) {
        // seen 以 plain translation 為準（raw 同步替換；佔位符不會落在對照字串
        // 中間——對照整段是同一文字節點的內容）。首次出現保留完整對照
        const seenBefore = rule.seen;
        const rt = replaceOccurrences(t, rule.full, rule.keep, !seenBefore);
        t = rt.text;
        if (rt.sawAny) rule.seen = true;
        if (rt.changed) changed = true;
        if (raw) {
          const rr = replaceOccurrences(raw, rule.full, rule.keep, !seenBefore);
          if (rr.changed) { raw = rr.text; changed = true; }
        }
      }
      if (changed) out.set(b.blockId, { translation: t, translationRaw: raw });
    }
  }
  return out;
}

// 段落間距注入（2026-07-10 Jimmy 需求）：小說常見「margin:0 + 只靠 text-indent」
// 的傳統排版，讀者反映段落擠成一團。
//
// 「最少 0.5em」的實作靠 CSS margin collapse：相鄰段落間距 = max(前段
// margin-bottom, 後段 margin-top)。只注入 margin-top、不動 margin-bottom——
// 原書 margin:0 → 間距變 0.5em；原書 bottom / 對稱 margin ≥0.5em → max 取原值，
// 排版不變 = 真正的下限語意。!important 是因為很多書明確寫 margin:0，弱規則
// 蓋不過。已知邊角：罕見的「只用 margin-top 撐段距」的書會被壓到 0.5em。
// idempotent：每次 build 先移除舊注入再按當前設定加回
const SPACING_STYLE_ID = 'sk-paragraph-spacing';
const SPACING_CSS = '\np { margin-top: 0.5em !important; }\n';

function applyParagraphSpacing(xhtmlDoc, enabled) {
  const existing = xhtmlDoc.getElementById
    ? xhtmlDoc.getElementById(SPACING_STYLE_ID)
    : null;
  if (existing) existing.remove();
  if (!enabled) return;
  const head = xhtmlDoc.getElementsByTagNameNS('*', 'head')[0];
  if (!head) return;
  const style = xhtmlDoc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.setAttribute('id', SPACING_STYLE_ID);
  style.setAttribute('type', 'text/css');
  style.textContent = SPACING_CSS;
  head.appendChild(style);
}

// 修改過的章節：更新 <html lang / xml:lang>（閱讀器字型 / 斷行 / 辭典行為依此）
function updateChapterLang(xhtmlDoc, targetLanguage) {
  const html = xhtmlDoc.documentElement;
  if (!html || !targetLanguage) return;
  html.setAttribute('lang', targetLanguage);
  html.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', targetLanguage);
}

function serializeChapter(ch) {
  let out = XML_SER.serializeToString(ch.xhtmlDoc);
  if (ch.hadXmlDeclaration && !/^\s*<\?xml/i.test(out)) out = XML_DECL + out;
  return out;
}

// OPF 更新（每次從 opf.text 重新 parse，不依賴外部狀態）：
//   - dc:language → target
//   - upgradeTo3：package@version → 3.0 + 補 dcterms:modified（EPUB3 必填）+
//     manifest 加 nav 文件 item（properties="nav"，EPUB3 必備；NCX 保留向下相容）
function buildUpdatedOpf(opfText, targetLanguage, { upgradeTo3 = false, navFilename = null } = {}) {
  const doc = new DOMParser().parseFromString(opfText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const OPF_NS = 'http://www.idpf.org/2007/opf';

  if (targetLanguage) {
    const langEls = doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language');
    if (langEls.length > 0) {
      langEls[0].textContent = targetLanguage;
      for (let i = langEls.length - 1; i >= 1; i--) langEls[i].remove();
    } else {
      const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
      if (metadata) {
        const el = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
        el.textContent = targetLanguage;
        metadata.appendChild(el);
      }
    }
  }

  if (upgradeTo3) {
    doc.documentElement.setAttribute('version', '3.0');
    const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
    if (metadata) {
      // dcterms:modified（EPUB3 必填）：既有的更新，沒有就補
      let modified = null;
      for (const m of metadata.getElementsByTagNameNS('*', 'meta')) {
        if (m.getAttribute('property') === 'dcterms:modified') { modified = m; break; }
      }
      if (!modified) {
        modified = doc.createElementNS(OPF_NS, 'meta');
        modified.setAttribute('property', 'dcterms:modified');
        metadata.appendChild(modified);
      }
      modified.textContent = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    if (navFilename) {
      const manifest = doc.getElementsByTagNameNS('*', 'manifest')[0];
      if (manifest) {
        const item = doc.createElementNS(OPF_NS, 'item');
        item.setAttribute('id', 'sk-nav');
        item.setAttribute('href', navFilename);
        item.setAttribute('media-type', 'application/xhtml+xml');
        item.setAttribute('properties', 'nav');
        manifest.appendChild(item);
      }
    }
  }

  let out = XML_SER.serializeToString(doc);
  if (/^\s*<\?xml/i.test(opfText) && !/^\s*<\?xml/i.test(out)) out = XML_DECL + out;
  return out;
}

// EPUB2 → 3 升級用：manifest 是否已有 properties 含 nav 的 item（有就不生成）
function opfHasNavItem(opfText) {
  const doc = new DOMParser().parseFromString(opfText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return false;
  for (const item of doc.getElementsByTagNameNS('*', 'item')) {
    if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) return true;
  }
  return false;
}

// 章節 href（zip 內完整路徑）→ 相對 OPF 目錄的 href（nav 文件放 OPF 同層）
function hrefRelativeToOpfDir(fullPath, opfDir) {
  if (!opfDir) return fullPath;
  if (fullPath.startsWith(opfDir + '/')) return fullPath.slice(opfDir.length + 1);
  // 章節不在 OPF 目錄底下（罕見）：用 ../ 回到 zip root 再走全路徑
  const ups = opfDir.split('/').filter(Boolean).map(() => '..').join('/');
  return ups + '/' + fullPath;
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// EPUB2 → 3 升級：從章節清單（TOC 標題已解析）生成 EPUB3 必備的 nav 文件
function buildNavDoc(epubDoc, targetLanguage) {
  const items = epubDoc.chapters
    .filter((c) => c.title)
    .map((c) => `      <li><a href="${escapeXml(hrefRelativeToOpfDir(c.href, epubDoc.opf.dir))}">${escapeXml(c.title)}</a></li>`)
    .join('\n');
  const lang = escapeXml(targetLanguage || epubDoc.meta.language || 'en');
  return `${XML_DECL}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><title>${escapeXml(epubDoc.meta.title)}</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

/**
 * 產出譯本 EPUB bytes。
 * @param {EpubDoc} epubDoc — parseEpub 輸出（blocks 已帶翻譯結果）
 * @param {string}  targetLanguage — 例 'zh-TW'
 * @param {object}  [opts]
 * @param {boolean} [opts.upgradeTo3] — EPUB2 來源升級輸出 EPUB3（version 3.0 +
 *   dcterms:modified + 生成 nav 文件；NCX 與章節內文保留不動，向下相容）
 * @param {Array}   [opts.glossary] — 術語表原始 entries（含 dedupeAnnotation flag，
 *   「對照只出現一次」後處理用；不傳 = 不後處理）
 * @param {boolean} [opts.paragraphSpacing] — 段落間距 0.5em 注入（設定 toggle）
 * @returns {{ bytes: Uint8Array, translatedChapters: number, appliedBlocks: number }}
 */
export function buildTranslatedEpub(epubDoc, targetLanguage, opts = {}) {
  const SK = getSK();
  const { strToU8, zipSync } = window.fflate;
  const { upgradeTo3 = false, glossary = null, paragraphSpacing = false } = opts;

  // 0)「譯文（原文）」對照只出現一次的後處理 map（不改動 block 存檔資料）
  const dedupe = computeAnnotationDedupe(epubDoc, glossary);

  // 1) 譯文寫回各章 DOM，收集修改過的章節序列化結果
  const modified = new Map(); // path → string
  let translatedChapters = 0;
  let appliedBlocks = 0;
  for (const ch of epubDoc.chapters) {
    if (!ch.xhtmlDoc || ch.parseFailed) continue;
    let chApplied = 0;
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (applyBlockTranslation(SK, ch.xhtmlDoc, b, dedupe.get(b.blockId))) chApplied++;
    }
    if (chApplied > 0) {
      updateChapterLang(ch.xhtmlDoc, targetLanguage);
      applyParagraphSpacing(ch.xhtmlDoc, paragraphSpacing);
      modified.set(ch.href, serializeChapter(ch));
      translatedChapters++;
      appliedBlocks += chApplied;
    }
  }

  // 2) EPUB2 → 3 升級：生成 nav 文件（既有 nav item 就不重複生成）
  let navFilename = null;
  let navPath = null;
  if (upgradeTo3 && !opfHasNavItem(epubDoc.opf.text)) {
    navFilename = 'sk-nav.xhtml';
    navPath = epubDoc.opf.dir ? `${epubDoc.opf.dir}/${navFilename}` : navFilename;
    // 防呆：撞名時換名（幾乎不會發生）
    while (epubDoc.zip.entries[navPath]) {
      navFilename = 'sk-' + navFilename;
      navPath = epubDoc.opf.dir ? `${epubDoc.opf.dir}/${navFilename}` : navFilename;
    }
    modified.set(navPath, buildNavDoc(epubDoc, targetLanguage));
  }

  // 3) OPF 更新（語言 + 可選升級）
  const updatedOpf = buildUpdatedOpf(epubDoc.opf.text, targetLanguage, { upgradeTo3, navFilename });
  if (updatedOpf) modified.set(epubDoc.opf.path, updatedOpf);

  // 4) 重打包。mimetype 第一且 STORED（level 0），其餘依原 zip 順序。
  const entries = epubDoc.zip.entries;
  const zipInput = {};
  const mimetypeU8 = entries['mimetype'] || strToU8('application/epub+zip');
  zipInput['mimetype'] = [mimetypeU8, { level: 0 }];
  for (const path of Object.keys(entries)) {
    if (path === 'mimetype') continue;
    if (path.endsWith('/')) continue; // 目錄 entry 不需重建
    zipInput[path] = modified.has(path) ? strToU8(modified.get(path)) : entries[path];
  }
  // 新增的 nav 文件（原 zip 沒有的 entry）
  if (navPath && !zipInput[navPath]) zipInput[navPath] = strToU8(modified.get(navPath));
  const bytes = zipSync(zipInput, { level: 6 });
  return { bytes, translatedChapters, appliedBlocks };
}

/** 下載檔名：<原檔名>-shinkansen.epub */
export function translatedEpubFilename(originalName) {
  return (originalName || 'book').replace(/\.epub$/i, '') + '-shinkansen.epub';
}
