// pdf-renderer.js — 譯文 PDF 下載(W6,SPEC §17.8)
//
// 流程(W6-iter2):
//   1. 讀原 PDF ArrayBuffer
//   2. pdf-lib 創新 PDFDocument + registerFontkit + embedFont(NotoSansTC TTF)
//   3. 對每頁 i:
//      - addPage 創新頁(同 viewport size)
//      - embedPages 把原 page i 變成 form XObject + drawPage 畫到新頁底層
//      - 對每個 translatable block:drawRectangle 白底蓋原文位置 + drawText 譯文(用 cjkFont)
//      - 不可翻譯 type / failed block → 不蓋，讓底層原文 visible
//   4. PDFDocument.save() → Uint8Array → Blob → trigger download
//
// 視覺等同 reader 那種「換成中文版的 PDF」(裝飾元素留 / 譯文蓋原文位置),
// 而非雙頁並排對照。原本 W6-iter1 設計每頁 [原頁 + 譯文頁] 雙頁並排，W6-iter2 改成
// 「只譯文頁(原頁當底層裝飾)」，因為使用者實際需求是看譯文版，原頁可隨時開原 PDF 看。
//
// 字型：vendor 的 NotoSansTC-Regular.ttf(SIL OFL,11.4MB TrueType Variable Font);
// pdf-lib subset: true 在最終 PDF 內只 embed 譯文用到的字，通常 100-300KB,
// 不影響譯文 PDF 大小。
// (原本 vendor OTF/CFF 版本，fontkit 1.1.1 對 CFF-based OTF subset 是已知問題，
//  輸出 PDF 中文字會 render 成 broken glyphs;TTF/TrueType 沒此 issue)
//
// 依賴：window.PDFLib(pdf-lib UMD)、window.fontkit(fontkit UMD，給 embedFont 用)
//   — 由 index.html 用 <script src> 載入 vendor min.js,page 級 globals

const FONT_PATH = 'lib/vendor/fonts/NotoSansTC-Regular.ttf';

let cachedFontBytes = null;
async function loadCJKFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;
  const url = chrome.runtime.getURL(FONT_PATH);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字型載入失敗：${res.status}`);
  cachedFontBytes = await res.arrayBuffer();
  return cachedFontBytes;
}

/**
 * 產生雙頁並排對照 PDF Blob 並觸發下載。
 *
 * @param {ArrayBuffer} originalArrayBuffer — 原 PDF 的 ArrayBuffer(handleFile 已 cache)
 * @param {LayoutDoc}   layoutDoc           — analyzeLayout + translateDocument 寫回 .translation
 * @param {object}      [options]
 * @param {(p: { stage: string, current?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ filename: string, byteLength: number }>}
 */
export async function downloadBilingualPdf(originalArrayBuffer, layoutDoc, options = {}) {
  const { onProgress = () => {} } = options;
  if (!window.PDFLib) throw new Error('pdf-lib 未載入(index.html <script> 標籤少？)');
  if (!window.fontkit) throw new Error('fontkit 未載入');
  const { PDFDocument } = window.PDFLib;

  onProgress({ stage: 'init' });
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(window.fontkit);

  // load + embed CJK 字型(subset: true 讓最終 PDF 只含譯文用到的字)
  onProgress({ stage: 'font' });
  const fontBytes = await loadCJKFontBytes();
  const cjkFont = await newDoc.embedFont(fontBytes, { subset: true });

  onProgress({ stage: 'parsing' });
  const origDoc = await PDFDocument.load(originalArrayBuffer);
  const pageCount = layoutDoc.pages.length;
  // 一次 embedPages 全部頁(比 for-loop 內逐頁 embedPage 快；pdf-lib 內部 batch parse)
  const origPages = origDoc.getPages().slice(0, pageCount);
  const embeddedPages = await newDoc.embedPages(origPages);

  for (let i = 0; i < pageCount; i++) {
    onProgress({ stage: 'page', current: i + 1, total: pageCount });
    const layoutPage = layoutDoc.pages[i];
    const pageW = layoutPage.viewport.width;
    const pageH = layoutPage.viewport.height;
    // 創新頁 + 把原 page 嵌進去當底層(裝飾 / 圖 / 不可翻譯區留；譯文 overlay 在上)
    const newPage = newDoc.addPage([pageW, pageH]);
    newPage.drawPage(embeddedPages[i], { x: 0, y: 0, width: pageW, height: pageH });
    // 上層蓋譯文(白底 + 中文，只對 translatable block + 有 translation 才蓋)
    drawTranslatedOverlay(newPage, layoutPage, cjkFont);
  }

  onProgress({ stage: 'saving' });
  const pdfBytes = await newDoc.save();

  // trigger download
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const baseName = (layoutDoc.meta.filename || 'document').replace(/\.pdf$/i, '');
  const filename = `${baseName}-shinkansen.pdf`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { filename, byteLength: pdfBytes.byteLength };
}

// ----- 譯文頁 layout 渲染 -----

const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

// 對每個 translatable + has translation 的 block 在新 page 上蓋白底 + 寫譯文。
// 不可翻譯 type(table / formula / figure / page-number)/ failed block / pending →
// 不蓋(讓底層 embeddedPage 的原 PDF 文字 visible)，跟 reader overlay 模式一致。
function drawTranslatedOverlay(page, layoutPage, font) {
  const { rgb } = window.PDFLib;
  const pageH = layoutPage.viewport.height;
  for (const block of layoutPage.blocks) {
    if (!TRANSLATABLE_TYPES.has(block.type)) continue;
    if (!block.translation || block.translation.trim().length === 0) continue;

    const [x0, y0, x1, y1] = block.bbox;
    const blockW = x1 - x0;
    const blockH = y1 - y0;
    if (blockW <= 0 || blockH <= 0) continue;

    // canvas 座標(y 由上往下)→ PDF 座標(y 由下往上)
    // bbox 上邊 y0 對應 PDF y = pageH - y0；下邊 y1 對應 PDF y = pageH - y1
    const pdfTop = pageH - y0;
    const pdfBottom = pageH - y1;

    // 1) 蓋白底 — 蓋住原 PDF 該位置的文字(向外擴 2pt 蓋住 ascender / descender 殘影)
    const padding = 2;
    page.drawRectangle({
      x: x0 - padding,
      y: pdfBottom - padding,
      width: blockW + padding * 2,
      height: blockH + padding * 2,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });

    // 2) 寫譯文 — 字級用原 block fontSize × 0.9 略縮讓中文塞進 bbox
    const fontSize = Math.max(7, block.fontSize * 0.9);
    const lineHeight = fontSize * 1.3;
    const lines = wrapTextToWidth(block.translation, font, fontSize, blockW);

    let cy = pdfTop - fontSize; // text baseline 起點(PDF 座標，從 top 往下走)
    for (const line of lines) {
      if (cy < 0) break; // 極度溢出超過 page 邊就停
      try {
        page.drawText(line, { x: x0, y: cy, font, size: fontSize });
      } catch (err) {
        // 字型不含的 glyph(極少見，Noto Sans TC 含 95%+ 常用字)
        console.warn('[Shinkansen] drawText 跳過：', line.slice(0, 30), err.message);
      }
      cy -= lineHeight;
    }
  }
}

// 中文按字斷，英文按詞斷，累加字寬超過 maxWidth 即斷行
function wrapTextToWidth(text, font, fontSize, maxWidth) {
  if (!text) return [];
  // 分 segments:CJK 字逐字、ASCII 詞按空白切、空白獨立 segment
  const segments = [];
  let buf = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const isCJK =
      (cp >= 0x3000 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0xFF00 && cp <= 0xFFEF); // 全形標點 / 全形 ASCII
    const isWS = /\s/.test(ch);
    if (isCJK || isWS) {
      if (buf) { segments.push(buf); buf = ''; }
      segments.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) segments.push(buf);

  const lines = [];
  let current = '';
  let currentWidth = 0;

  function widthOf(s) {
    try { return font.widthOfTextAtSize(s, fontSize); }
    catch { return s.length * fontSize * 0.5; }
  }

  for (const seg of segments) {
    const segW = widthOf(seg);
    // 如果當前 line 是純空白起頭跳過(避免新行開頭一個空白)
    if (current === '' && /^\s+$/.test(seg)) continue;
    if (currentWidth + segW > maxWidth && current.length > 0) {
      lines.push(current);
      current = /^\s+$/.test(seg) ? '' : seg;
      currentWidth = current ? widthOf(current) : 0;
    } else {
      current += seg;
      currentWidth += segW;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
