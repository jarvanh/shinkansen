// pdf-renderer.js — 譯文 PDF 下載(W6,SPEC §17.8)
//
// 流程：
//   1. 讀原 PDF ArrayBuffer
//   2. pdf-lib 創新 PDFDocument
//   3. 對每頁 i:
//      - copyPages 把原 page i embed 進新 doc 第 2N 頁(原樣保留向量 / 點陣 / 文字)
//      - addPage 創新空白頁(2N+1 頁)，用版面 IR 在對應 bbox 比例位置畫譯文
//   4. PDFDocument.save() → Uint8Array → Blob → trigger download
//
// 字型：vendor 的 NotoSansTC-Regular.otf(SIL OFL,16MB OTF;pdf-lib subset: true 在
// 最終 PDF 內只 embed 譯文用到的字，通常 100-300KB，不影響譯文 PDF 大小)
//
// 依賴：window.PDFLib(pdf-lib UMD)、window.fontkit(fontkit UMD，給 embedFont 用)
//   — 由 index.html 用 <script src> 載入 vendor min.js,page 級 globals

const FONT_PATH = 'lib/vendor/fonts/NotoSansTC-Regular.otf';

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

  for (let i = 0; i < pageCount; i++) {
    onProgress({ stage: 'page', current: i + 1, total: pageCount });

    // 偶數頁(2i):copy 原 page，完整保留向量 / 點陣 / 文字
    const [copiedPage] = await newDoc.copyPages(origDoc, [i]);
    newDoc.addPage(copiedPage);

    // 奇數頁(2i+1)：創新頁畫譯文
    const layoutPage = layoutDoc.pages[i];
    const trPage = newDoc.addPage([layoutPage.viewport.width, layoutPage.viewport.height]);
    drawTranslatedPage(trPage, layoutPage, cjkFont);
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

function drawTranslatedPage(page, layoutPage, font) {
  const pageH = layoutPage.viewport.height;
  for (const block of layoutPage.blocks) {
    // 翻譯失敗 / 不可翻譯類型：用原文輸出(SPEC §17.7「下載譯文 PDF 時 failed
    // 段落以原文輸出，不留空、不留錯誤標記」)
    const text = (TRANSLATABLE_TYPES.has(block.type) && block.translation)
      ? block.translation
      : block.plainText;
    if (!text || text.trim().length === 0) continue;

    const [x0, y0, x1, y1] = block.bbox;
    // canvas 座標(y 由上往下)→ PDF 座標(y 由下往上，page.drawText 用)
    const pdfTop = pageH - y0;
    const pdfBottom = pageH - y1;
    const fontSize = Math.max(7, block.fontSize * 0.9); // 略縮讓中文塞進 bbox
    const lineHeight = fontSize * 1.3;
    const maxWidth = x1 - x0;
    if (maxWidth <= 0) continue;

    // line wrap
    const lines = wrapTextToWidth(text, font, fontSize, maxWidth);

    let cy = pdfTop - fontSize; // text baseline 起點(PDF 座標，從 top 往下走)
    for (const line of lines) {
      // 容許往下溢出 bbox(SPEC §17.10 已知限制 4)，但極度溢出超過 page 邊就停
      if (cy < 0) break;
      try {
        page.drawText(line, {
          x: x0,
          y: cy,
          font,
          size: fontSize,
        });
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
