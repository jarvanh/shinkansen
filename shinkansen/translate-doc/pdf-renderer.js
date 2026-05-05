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
// 字型:vendor 的 NotoSansTC-Regular.ttf(SIL OFL,11.4MB TrueType Variable Font);
// pdf-lib subset: true 在最終 PDF 內只 embed 譯文用到的字,通常 100-300KB,
// 不影響譯文 PDF 大小。
// (原本 vendor OTF/CFF 版本,fontkit 1.1.1 對 CFF-based OTF subset 是已知問題,
//  輸出 PDF 中文字會 render 成 broken glyphs;TTF/TrueType 沒此 issue)
//
// 依賴:window.PDFLib(@cantoo/pdf-lib UMD,hopding/pdf-lib 1.17.1 的活躍 fork,
// 補上 mozilla/pdf.js port 的 AES decrypt 支援)、window.fontkit(fontkit UMD,
// 給 embedFont 用)— 由 index.html 用 <script src> 載入 vendor min.js,page 級 globals
//
// 加密 PDF 處理:`PDFDocument.load(...)` 必須帶 `{ ignoreEncryption: true,
// password: '' }`。
//   - 不帶 password 參數:cantoo 走「強制忽略加密但物件仍是密」分支,後續
//     embedPages 會在 `PDFContext.lookup(pagesRef)` 拿到 undefined 而炸
//   - 帶 password='' 觸發 cantoo 的 decryption 路徑,實測對 AESv2 + R=4 + 空
//     user pwd + owner-only 限制的 PDF(如 Trimble 系列 spec sheet)可順利
//     解開,生成譯文 PDF
//
// Link annotation preservation:embedPages 把原 page 嵌成 form XObject 時不會
// 自動拷貝 /Annots,所以原 PDF 的 link 在譯文 PDF 完全消失。修法是另外用 PDF.js
// 在原 PDF 上跑 page.getAnnotations() 拿 Link list (rect + url),再用
// pdf-lib 在新 page 上構造對等的 Link annotation dict,呼叫 page.node.addAnnot
// 加進新 page 的 /Annots
//
// Bold preservation:vendor 兩把字型 NotoSansTC-Regular.ttf + NotoSansTC-Bold.ttf,
// 用 PDF.js commonObjs 拿原 PDF 每個 fontName 的 .bold 屬性 / name regex,把
// textContent items 標 isBold,對每個 layout block 算 bold 字符比例 ≥ 50% 為
// bold block,drawTranslatedOverlay 對 bold block 用 boldFont 寫

import * as pdfjsLib from '../lib/vendor/pdfjs/pdf.min.mjs';

const FONT_PATH_REGULAR = 'lib/vendor/fonts/NotoSansTC-Regular.ttf';
const FONT_PATH_BOLD = 'lib/vendor/fonts/NotoSansTC-Bold.ttf';

let cachedRegularBytes = null;
let cachedBoldBytes = null;
async function loadFontBytes(path, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const url = chrome.runtime.getURL(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字型載入失敗：${res.status} (${path})`);
  cacheRef.value = await res.arrayBuffer();
  return cacheRef.value;
}
const regularRef = { value: null };
const boldRef = { value: null };
const loadCJKRegularBytes = () => loadFontBytes(FONT_PATH_REGULAR, regularRef);
const loadCJKBoldBytes = () => loadFontBytes(FONT_PATH_BOLD, boldRef);

/**
 * 生成譯文 PDF 的核心 pipeline(供 reader WYSIWYG render + 下載按鈕共用)。
 * 不觸發 download,只回傳 bytes 與 filename
 *
 * @param {ArrayBuffer} originalArrayBuffer
 * @param {LayoutDoc}   layoutDoc
 * @param {object}      [options]
 * @param {(p: { stage: string, current?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ bytes: Uint8Array, filename: string, byteLength: number }>}
 */
export async function buildBilingualPdf(originalArrayBuffer, layoutDoc, options = {}) {
  const { onProgress = () => {} } = options;
  if (!window.PDFLib) throw new Error('pdf-lib 未載入(index.html <script> 標籤少？)');
  if (!window.fontkit) throw new Error('fontkit 未載入');
  const { PDFDocument } = window.PDFLib;

  onProgress({ stage: 'init' });
  const newDoc = await PDFDocument.create();
  newDoc.registerFontkit(window.fontkit);

  // load + embed CJK 字型 Regular + Bold(兩把都 subset: true,最終 PDF 只含
  // 譯文實際用到的字。Regular 11.4MB / Bold 6.8MB,subset 後通常各 100-300KB)
  onProgress({ stage: 'font' });
  const [regularBytes, boldBytes] = await Promise.all([loadCJKRegularBytes(), loadCJKBoldBytes()]);
  const cjkFontRegular = await newDoc.embedFont(regularBytes, { subset: true });
  const cjkFontBold = await newDoc.embedFont(boldBytes, { subset: true });

  onProgress({ stage: 'parsing' });
  // password: '' 是 cantoo 解密路徑的 trigger;對非加密 PDF 無副作用
  // (cantoo 內部會先檢查 isEncrypted 才走 decrypt branch)
  const origDoc = await PDFDocument.load(originalArrayBuffer, { ignoreEncryption: true, password: '' });
  const pageCount = layoutDoc.pages.length;
  // 一次 embedPages 全部頁(比 for-loop 內逐頁 embedPage 快；pdf-lib 內部 batch parse)
  const origPages = origDoc.getPages().slice(0, pageCount);
  const embeddedPages = await newDoc.embedPages(origPages);

  // 並行抽原 PDF 每頁的 link + 字型 metadata(PDF.js 一次解全頁,內部會 cache,
  // 比 link / bold 各跑一次省一半)
  const pdfMetaByPage = await extractPdfMetaForOverlay(originalArrayBuffer, pageCount);

  for (let i = 0; i < pageCount; i++) {
    onProgress({ stage: 'page', current: i + 1, total: pageCount });
    const layoutPage = layoutDoc.pages[i];
    const pageW = layoutPage.viewport.width;
    const pageH = layoutPage.viewport.height;
    const meta = pdfMetaByPage[i] || { links: [], items: [] };
    // 創新頁 + 把原 page 嵌進去當底層(裝飾 / 圖 / 不可翻譯區留；譯文 overlay 在上)
    const newPage = newDoc.addPage([pageW, pageH]);
    newPage.drawPage(embeddedPages[i], { x: 0, y: 0, width: pageW, height: pageH });
    // 上層蓋譯文(白底 + 中文，只對 translatable block + 有 translation 才蓋)。
    // W7:回傳譯文 link piece 對應的 device rect(PDF y-up),addLinkAnnotations
    // 用譯文 rect 而非原 PDF rect(譯文長度跟原文不同,原 rect 對不到譯文位置)。
    // 沒對應到譯文的 link(原 PDF link 在 non-translatable 區 / translation 失敗)
    // fallback 用原 PDF rect 保留 click hit
    const translatedLinkRects = drawTranslatedOverlay(newPage, layoutPage, cjkFontRegular, cjkFontBold, meta.items);
    const coveredUrls = new Set(translatedLinkRects.map((l) => l.url));
    const fallbackLinks = meta.links.filter((l) => !coveredUrls.has(l.url));
    addLinkAnnotations(newDoc, newPage, [...translatedLinkRects, ...fallbackLinks]);
  }

  onProgress({ stage: 'saving' });
  const pdfBytes = await newDoc.save();
  const baseName = (layoutDoc.meta.filename || 'document').replace(/\.pdf$/i, '');
  const filename = `${baseName}-shinkansen.pdf`;
  return { bytes: pdfBytes, filename, byteLength: pdfBytes.byteLength };
}

/**
 * 產生譯文 PDF Blob 並觸發下載(thin wrapper over buildBilingualPdf)。
 * 也可預先傳入已生成的 bytes 跳過重做(reader 已有 cache 時用)
 *
 * @param {ArrayBuffer}  originalArrayBuffer
 * @param {LayoutDoc}    layoutDoc
 * @param {object}       [options]
 * @param {Uint8Array}   [options.prebuiltBytes] — 已生成的 bytes,免重做
 * @param {(p: { stage: string, current?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ filename: string, byteLength: number }>}
 */
export async function downloadBilingualPdf(originalArrayBuffer, layoutDoc, options = {}) {
  let result;
  if (options.prebuiltBytes) {
    const baseName = (layoutDoc.meta.filename || 'document').replace(/\.pdf$/i, '');
    result = {
      bytes: options.prebuiltBytes,
      filename: `${baseName}-shinkansen.pdf`,
      byteLength: options.prebuiltBytes.byteLength,
    };
  } else {
    result = await buildBilingualPdf(originalArrayBuffer, layoutDoc, options);
  }
  const blob = new Blob([result.bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { filename: result.filename, byteLength: result.byteLength };
}

// ----- 譯文頁 layout 渲染 -----

const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

// W7:italic 用 pdf-lib drawText `matrix` 做 12° skew transform(業界標準做法,
// CSS font-synthesis-style 預設 14°、FontForge -10°~-15°,折衷 12°)。matrix 走
// PDF text rendering matrix 規格,skew x 軸:[1, 0, tan(12°), 1, tx, ty]
const ITALIC_SKEW = Math.tan(12 * Math.PI / 180);
// 連結色 = 接近 #00468C 的偏深藍,跟黑字有對比但不過度螢光
const LINK_RGB = [0, 0.27, 0.55];
// link underline:baseline 下 fontSize × 0.12 處,thickness fontSize × 0.06
const UNDERLINE_OFFSET_RATIO = 0.12;
const UNDERLINE_THICKNESS_RATIO = 0.06;

// 對每個 translatable + has translation 的 block 在新 page 上蓋白底 + 寫譯文。
// 不可翻譯 type(table / formula / figure / page-number)/ failed block / pending →
// 不蓋(讓底層 embeddedPage 的原 PDF 文字 visible)，跟 reader overlay 模式一致。
//
// W7:走 piece-by-piece 渲染:每個 block 的 translationSegments 切成 wrap line,
// 每 line 內走 piece 列表逐個 drawText。bold piece 用 fontBold、italic piece 用
// matrix skew、link piece 藍色 + drawLine underline + 收集譯文 device rect 給
// addLinkAnnotations。
//
// items:從 PDF.js 抽出的 textContent items(canvas 座標),只用於 expandBoxToCoverItems
// 算 mask box(W7 起 isBold 從 styleSegments 走,不再用 items 反推 block-level bold)
//
// @returns {Array<{ url: string, rect: [number,number,number,number] }>}
//          回傳譯文 link piece 對應的 PDF y-up rect,給 addLinkAnnotations 用
function drawTranslatedOverlay(page, layoutPage, fontRegular, fontBold, items) {
  const { rgb } = window.PDFLib;
  const pageH = layoutPage.viewport.height;
  const translatedLinkRects = [];
  for (const block of layoutPage.blocks) {
    if (!TRANSLATABLE_TYPES.has(block.type)) continue;
    if (!block.translation || block.translation.trim().length === 0) continue;

    const [origX0, origY0, origX1, origY1] = block.bbox;
    if (origX1 <= origX0 || origY1 <= origY0) continue;

    // W7:取 translationSegments(parser 失敗 / 舊資料 → fallback 整段 plain regular)
    let segs = Array.isArray(block.translationSegments) && block.translationSegments.length > 0
      ? block.translationSegments
      : [{ text: block.translation, isBold: false, isItalic: false, linkUrl: null }];

    // 1) fit-to-box:從 scale 1.0 起步,塞不下時依序試縮 + 擴 box,回傳最終 box +
    //    字級 + 行(每行帶 pieces 陣列)
    const { fontSize, lineHeight, lines, finalBox } = fitSegmentsToBox(
      segs, fontRegular, fontBold, block.fontSize, block, layoutPage,
    );

    // 2) 蓋白底 — mask box 取 finalBox 跟「該 block 在 PDF 實際 text item bbox
    //    union」的聯集,padding 用字級 30%(link underline / hanging 標點 / ascent
    //    略超出 line bbox 等情況)
    const padding = Math.max(2, (block.fontSize || 12) * 0.3);
    const maskBox = expandBoxToCoverItems(finalBox, block, items);
    const { x0: mx0, y0: my0, x1: mx1, y1: my1 } = maskBox;
    const pdfMaskBottom = pageH - my1;
    page.drawRectangle({
      x: mx0 - padding,
      y: pdfMaskBottom - padding,
      width: (mx1 - mx0) + padding * 2,
      height: (my1 - my0) + padding * 2,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });
    const { x0, y0, y1 } = finalBox;
    const pdfTop = pageH - y0;
    const pdfBottom = pageH - y1;

    // 3) drawText piece-by-piece
    let cy = pdfTop - fontSize; // baseline 起點(PDF y-up)
    for (const line of lines) {
      if (cy < pdfBottom - lineHeight) break;
      let cx = x0;
      for (const piece of line.pieces) {
        if (!piece.text) continue;
        const pieceFont = piece.isBold ? fontBold : fontRegular;
        const color = piece.linkUrl ? rgb(LINK_RGB[0], LINK_RGB[1], LINK_RGB[2]) : rgb(0, 0, 0);
        const opts = { font: pieceFont, size: fontSize, color };
        if (piece.isItalic) {
          // pdf-lib drawText 接 matrix 後會用 matrix 取代 x/y,把 cx/cy 寫進 matrix.tx/ty
          opts.matrix = [1, 0, ITALIC_SKEW, 1, cx, cy];
        } else {
          opts.x = cx;
          opts.y = cy;
        }
        try {
          page.drawText(piece.text, opts);
        } catch (err) {
          console.warn('[Shinkansen] drawText 跳過：', piece.text.slice(0, 30), err.message);
        }
        const pieceWidth = pieceFont.widthOfTextAtSize(piece.text, fontSize);
        if (piece.linkUrl) {
          // underline:baseline 下方
          const underlineY = cy - fontSize * UNDERLINE_OFFSET_RATIO;
          try {
            page.drawLine({
              start: { x: cx, y: underlineY },
              end: { x: cx + pieceWidth, y: underlineY },
              thickness: fontSize * UNDERLINE_THICKNESS_RATIO,
              color: rgb(LINK_RGB[0], LINK_RGB[1], LINK_RGB[2]),
            });
          } catch (_) { /* underline 失敗不破整體 */ }
          // 收集譯文 link rect(PDF y-up,給 addLinkAnnotations 用)。rect 涵蓋
          // baseline 上下幾 pt 讓點擊 hit area 寬鬆些
          translatedLinkRects.push({
            url: piece.linkUrl,
            rect: [cx, cy - fontSize * 0.2, cx + pieceWidth, cy + fontSize * 0.9],
          });
        }
        cx += pieceWidth;
      }
      cy -= lineHeight;
    }
  }
  return translatedLinkRects;
}

// fit-to-box(港 BabelDOC `_find_optimal_scale_and_layout` 演算法到 JS):
//   Phase A: 原 box scale 1.0 → 0.7 試
//   Phase B: 擴 box 往下(找最近下方阻擋 block,留 buffer)→ 重試 1.0 → 0.7
//   Phase C: 再擴 box 往右(找最近右側阻擋 block)→ 重試 1.0 → 0.7
//   Phase D: 0.65 → MIN_SCALE 繼續縮(極端 case)
//
// CJK line_skip 用 1.5(原文是英文 1.3 vs 中文 1.5 的 BabelDOC 經驗值,中文
// ascender + descender 比英文多,行間距要大一點才不視覺擠)
//
// 高度估算:Noto Sans TC ascent ≈ 0.88 + |descent| ≈ 0.21 + 餘裕 0.12
// → 第 1 行視覺占用 = fontSize × FIRST_LINE_VISUAL_RATIO(1.21)
const MIN_FONT_SIZE = 5;
const MIN_SCALE = 0.5;
const PHASE_A_SCALES = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7];
const PHASE_D_SCALES = [0.65, 0.55, 0.5];
const FIRST_LINE_VISUAL_RATIO = 1.21;

// W7:segment-aware 版本。input 接 styleSegments + 兩種 font(regular/bold),
// 內部用 wrapSegmentsToWidth 取代 wrapTextToWidth。回傳 lines 結構也變
// [{ pieces: [{ text, isBold, isItalic, linkUrl }] }] 給 drawTranslatedOverlay
// piece-by-piece drawText 用。
function fitSegmentsToBox(segments, fontRegular, fontBold, originalFontSize, currentBlock, layoutPage) {
  // 全段 text 拼起來判斷 CJK(影響 line_skip)
  const fullText = segments.map((s) => s.text).join('');
  const isCJKText = hasCJK(fullText);
  const lineSkipRatio = isCJKText ? 1.5 : 1.3;
  const [origX0, origY0, origX1, origY1] = currentBlock.bbox;
  let box = { x0: origX0, y0: origY0, x1: origX1, y1: origY1 };

  function tryFit(b, scale) {
    const fontSize = Math.max(MIN_FONT_SIZE, originalFontSize * scale);
    const lineHeight = fontSize * lineSkipRatio;
    const blockW = b.x1 - b.x0;
    const blockH = b.y1 - b.y0;
    if (blockW <= 0 || blockH <= 0) return null;
    const lines = wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, blockW);
    const requiredH = fontSize * FIRST_LINE_VISUAL_RATIO + (lines.length - 1) * lineHeight;
    if (requiredH <= blockH + 1) return { fontSize, lineHeight, lines, finalBox: b };
    return null;
  }

  // Phase A: 原 box,scale 1.0 → 0.7
  for (const scale of PHASE_A_SCALES) {
    const r = tryFit(box, scale);
    if (r) return r;
  }

  // Phase B: 擴 box 往下
  const expandedBottom = getMaxBottomY(currentBlock, layoutPage);
  if (expandedBottom > box.y1 + 0.5) {
    const expanded = { ...box, y1: expandedBottom };
    for (const scale of PHASE_A_SCALES) {
      const r = tryFit(expanded, scale);
      if (r) return r;
    }
    box = expanded;
  }

  // Phase C: 擴 box 往右
  const expandedRight = getMaxRightX(currentBlock, layoutPage);
  if (expandedRight > box.x1 + 0.5) {
    const expanded = { ...box, x1: expandedRight };
    for (const scale of PHASE_A_SCALES) {
      const r = tryFit(expanded, scale);
      if (r) return r;
    }
    box = expanded;
  }

  // Phase D: 繼續縮(極端 case)
  for (const scale of PHASE_D_SCALES) {
    const r = tryFit(box, scale);
    if (r) return r;
  }

  // fallback:用 MIN_SCALE 算一次,可能仍 overflow,讓 drawText loop 自己擋
  const fontSize = Math.max(MIN_FONT_SIZE, originalFontSize * MIN_SCALE);
  const lineHeight = fontSize * lineSkipRatio;
  const lines = wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, box.x1 - box.x0);
  return { fontSize, lineHeight, lines, finalBox: box };
}

// 判字串是否含 CJK(影響 line_skip)
function hasCJK(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) return true;
  }
  return false;
}

// 港 BabelDOC `get_max_bottom_space` 到 JS。canvas 座標(y 由上往下),所以
// 「下方」= y 較大。對當前 block,找頁面所有「在當前 block 下方且水平有重疊」
// 的其他 block,取最小的 y0 為阻擋邊界,留 2pt buffer
function getMaxBottomY(currentBlock, layoutPage) {
  const [cx0, , cx1, cy1] = currentBlock.bbox;
  const pageH = layoutPage.viewport.height;
  let minBlockerY0 = pageH; // 頁面底
  for (const b of layoutPage.blocks) {
    if (b === currentBlock) continue;
    if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue;
    const [bx0, by0, bx1] = b.bbox;
    if (by0 <= cy1) continue; // 不在下方
    if (bx0 >= cx1 || bx1 <= cx0) continue; // 沒水平重疊
    if (by0 < minBlockerY0) minBlockerY0 = by0;
  }
  return Math.max(cy1, minBlockerY0 - 2);
}

// 港 BabelDOC `get_max_right_space`。對當前 block,找頁面所有「在當前 block
// 右側且垂直有重疊」的其他 block,取最小的 x0 為阻擋邊界,留 5pt buffer
function getMaxRightX(currentBlock, layoutPage) {
  const [, cy0, cx1, cy1] = currentBlock.bbox;
  const pageW = layoutPage.viewport.width;
  let minBlockerX0 = pageW;
  for (const b of layoutPage.blocks) {
    if (b === currentBlock) continue;
    if (!Array.isArray(b.bbox) || b.bbox.length !== 4) continue;
    const [bx0, by0, , by1] = b.bbox;
    if (bx0 <= cx1) continue; // 不在右側
    if (by0 >= cy1 || by1 <= cy0) continue; // 沒垂直重疊
    if (bx0 < minBlockerX0) minBlockerX0 = bx0;
  }
  return Math.max(cx1, minBlockerX0 - 5);
}

// 對「bbox 跟 block.bbox 有重疊」的 text items 算 union bbox,跟 finalBox 聯集回傳。
// 用於擴展白底 mask 範圍,確保原 PDF text 的 ascent / descent / inline 標點
// 不會在 block.bbox 邊緣漏出。中心點判定會漏掉 block 邊緣的 item(中心點略出
// block.bbox 但大半字身仍在 block 內),改用 bbox overlap 判定才包得到。
// 沒命中任何 item 直接回傳 finalBox。
function expandBoxToCoverItems(finalBox, block, items) {
  if (!items || items.length === 0) return finalBox;
  const [bx0, by0, bx1, by1] = block.bbox;
  let { x0, y0, x1, y1 } = finalBox;
  for (const it of items) {
    const [ix0, iy0, ix1, iy1] = it.bbox;
    // 任意 bbox 交集即算屬於本 block
    if (ix1 < bx0 || ix0 > bx1 || iy1 < by0 || iy0 > by1) continue;
    if (ix0 < x0) x0 = ix0;
    if (iy0 < y0) y0 = iy0;
    if (ix1 > x1) x1 = ix1;
    if (iy1 > y1) y1 = iy1;
  }
  return { x0, y0, x1, y1 };
}

// 判斷 block 在原 PDF 是否「多數 bold」(字符數加權,bold ratio ≥ 0.5)。
// 用 textContent items 的 bbox 中心點落入 block bbox 為判定範圍
function isBlockBold(block, items) {
  if (!items || items.length === 0) return false;
  const [bx0, by0, bx1, by1] = block.bbox;
  let boldChars = 0;
  let totalChars = 0;
  for (const it of items) {
    const [ix0, iy0, ix1, iy1] = it.bbox;
    const cx = (ix0 + ix1) / 2;
    const cy = (iy0 + iy1) / 2;
    if (cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1) {
      const n = it.str.length;
      totalChars += n;
      if (it.isBold) boldChars += n;
    }
  }
  return totalChars > 0 && boldChars / totalChars >= 0.5;
}

// ----- 從原 PDF 抽 link + 字型 metadata -----

// 用 PDF.js 一輪解全頁,每頁回傳:
//   - links: { rect, url }  (rect PDF y-up 直接給 pdf-lib 用;新 page 同 size + 1:1 嵌)
//   - items: [{ str, bbox, isBold }]  (bbox canvas 座標,同 layout-analyzer 用的座標系)
// items 用於 drawTranslatedOverlay 的 isBlockBold 判定;判 bold 走兩條:
//   1. font.bold === true (PDF 字型物件直接帶)
//   2. font.name regex /Bold|Black|Heavy|Demi|Semi/  (subset 過的字型常無 .bold flag,
//      但 name 通常仍含 weight 字串,例:'BCDFEE+Arial-Black')
async function extractPdfMetaForOverlay(arrayBuffer, pageCount) {
  try {
    const task = pdfjsLib.getDocument({
      data: arrayBuffer.slice(0),
      disableFontFace: false,
      password: '',
    });
    const pdfDoc = await task.promise;
    const out = [];
    const n = Math.min(pageCount, pdfDoc.numPages);
    for (let i = 0; i < n; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });

      // links
      const annotations = await page.getAnnotations();
      const links = annotations
        .filter((a) => a.subtype === 'Link')
        .map((a) => ({ rect: a.rect, url: a.url || a.unsafeUrl || null }))
        .filter((l) => !!l.url);

      // items + bold flag(getOperatorList 觸發 worker font load,後續 commonObjs.get 才有資料)
      await page.getOperatorList();
      const tc = await page.getTextContent();
      const styles = tc.styles || {};
      const fontIsBold = {};
      for (const fn of Object.keys(styles)) {
        try {
          const font = await new Promise((resolve) => page.commonObjs.get(fn, resolve));
          const name = (font && font.name) || '';
          fontIsBold[fn] = (font && font.bold === true) || /Bold|Black|Heavy|Demi|Semi/i.test(name);
        } catch {
          fontIsBold[fn] = false;
        }
      }

      const items = tc.items
        .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
        .map((it) => {
          // 套 viewport.transform × item.transform → canvas 座標(同 pdf-engine.js 邏輯)
          const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
          const fontSize = Math.hypot(m[2], m[3]);
          const left = m[4];
          const baselineY = m[5];
          const top = baselineY - fontSize;
          const right = left + (it.width || 0);
          const bottom = baselineY;
          return {
            str: it.str,
            bbox: [left, top, right, bottom],
            isBold: fontIsBold[it.fontName] || false,
          };
        });

      out.push({ links, items });
    }
    await pdfDoc.destroy();
    return out;
  } catch (err) {
    // 抽取失敗不該卡住整份 PDF 生成,降級成「沒 link / 沒 bold」
    console.warn('[Shinkansen] extractPdfMetaForOverlay 失敗,譯文 PDF 將不含 link / bold:', err && err.message);
    return [];
  }
}

// 對單一新 page 加回 Link annotations。每條 Link 構造一個 PDFDict 註冊成
// indirect object 後 push 進 page 的 /Annots。新 page 跟原 page 同 size 而且
// embedPages 是 1:1 嵌入,原 rect (PDF y-up) 直接套用
function addLinkAnnotations(newDoc, newPage, links) {
  if (!links || links.length === 0) return;
  const { PDFName, PDFString } = window.PDFLib;
  const ctx = newDoc.context;
  for (const link of links) {
    if (!link.url || !Array.isArray(link.rect) || link.rect.length !== 4) continue;
    // ctx.obj 對 string value 一律當 PDFName(看 cantoo 9387:obj 行為),
    // 但 URI 必須是 PDFString(literal 形式),所以手動 set
    const annotDict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: link.rect,
      Border: [0, 0, 0],
    });
    const actionDict = ctx.obj({
      Type: 'Action',
      S: 'URI',
    });
    actionDict.set(PDFName.of('URI'), PDFString.of(link.url));
    annotDict.set(PDFName.of('A'), actionDict);
    const annotRef = ctx.register(annotDict);
    newPage.node.addAnnot(annotRef);
  }
}

// 不可行首的標點(中文全形 + 半形,新行起頭看到這些字符會把它拉回上一行末)。
// 涵蓋:句號逗號、頓號、分號冒號、感嘆問號、右括號、右引號、書名號右半
const FORBIDDEN_LINE_START = '、。，：；！？」』）〕】》〉,.;:!?)]}';

// 後處理:把違規行首字符拉回上一行末。視覺上輕微拉長上一行,但中文標點
// 全形寬通常 fontSize 以內,且 PDF reader 不嚴格 clip,可接受
function applyCJKPunctuationRules(lines) {
  if (!lines || lines.length < 2) return lines;
  const out = [...lines];
  // 多 pass:單 pass 後若 line 開頭仍違規(罕見,連續兩個禁標點),再做一次
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 1; i < out.length; i++) {
      const ln = out[i];
      if (!ln.length) continue;
      const firstCh = ln[0];
      if (FORBIDDEN_LINE_START.includes(firstCh)) {
        out[i - 1] = out[i - 1] + firstCh;
        out[i] = ln.slice(1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out.filter((l) => l.length > 0);
}

// W7:segment-aware wrap。對每 styleSegment 切 chunks(同 wrapTextToWidth 的
// CJK 逐字 / ASCII 詞 / 空白獨立 切法),chunks 帶 segment 的 style;累加 chunk
// 寬超過 maxWidth 就斷新行。同 line 內合併連續同 style chunks 成 piece。
//
// @returns {Array<{ pieces: Array<{ text, isBold, isItalic, linkUrl }> }>}
export function wrapSegmentsToWidth(segments, fontRegular, fontBold, fontSize, maxWidth) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  // 1) 對每 segment 切 chunks(每個 chunk 是 CJK 單字 / ASCII 詞 / 空白)
  // chunks: [{ text, isBold, isItalic, linkUrl, isWS }]
  const chunks = [];
  for (const seg of segments) {
    if (!seg || !seg.text) continue;
    let buf = '';
    const flushBuf = () => {
      if (buf) {
        chunks.push({
          text: buf,
          isBold: !!seg.isBold,
          isItalic: !!seg.isItalic,
          linkUrl: seg.linkUrl || null,
          isWS: false,
        });
        buf = '';
      }
    };
    for (const ch of seg.text) {
      const cp = ch.codePointAt(0);
      const isCJK =
        (cp >= 0x3000 && cp <= 0x9FFF) ||
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0xFF00 && cp <= 0xFFEF);
      const isWS = /\s/.test(ch);
      if (isCJK || isWS) {
        flushBuf();
        chunks.push({
          text: ch,
          isBold: !!seg.isBold,
          isItalic: !!seg.isItalic,
          linkUrl: seg.linkUrl || null,
          isWS,
        });
      } else {
        buf += ch;
      }
    }
    flushBuf();
  }

  function fontFor(c) { return c.isBold ? fontBold : fontRegular; }
  function widthOf(c) {
    try { return fontFor(c).widthOfTextAtSize(c.text, fontSize); }
    catch { return c.text.length * fontSize * 0.5; }
  }

  // 2) wrap chunks 成 lines(lineChunks: chunks[],尚未合併成 pieces)
  const lineChunks = [];
  let current = [];
  let currentWidth = 0;
  for (const c of chunks) {
    const w = widthOf(c);
    if (current.length === 0 && c.isWS) continue; // 跳新行開頭的純空白
    if (currentWidth + w > maxWidth && current.length > 0) {
      lineChunks.push(current);
      current = c.isWS ? [] : [c];
      currentWidth = c.isWS ? 0 : w;
    } else {
      current.push(c);
      currentWidth += w;
    }
  }
  if (current.length > 0) lineChunks.push(current);

  // 3) 合併連續同 style 的 chunks 成 pieces;CJK 標點規則(跨 piece)
  const lines = lineChunks.map((cs) => ({ pieces: mergeChunksToPieces(cs) }));
  return applyCJKPunctuationRulesPieces(lines);
}

// 把 chunks 陣列合併成 pieces:連續同 (isBold, isItalic, linkUrl) 合一段
function mergeChunksToPieces(chunks) {
  const pieces = [];
  for (const c of chunks) {
    const last = pieces[pieces.length - 1];
    if (last && last.isBold === c.isBold && last.isItalic === c.isItalic && last.linkUrl === c.linkUrl) {
      last.text += c.text;
    } else {
      pieces.push({ text: c.text, isBold: c.isBold, isItalic: c.isItalic, linkUrl: c.linkUrl });
    }
  }
  return pieces;
}

// piece 版的 CJK 標點規則:每行第一個 piece 第一個 char 違規 → 挪到上行最後
// piece 末尾(若同 style 合一,不同 style 則插個新 piece 保 style)
function applyCJKPunctuationRulesPieces(lines) {
  if (!lines || lines.length < 2) return lines;
  const out = lines.map((l) => ({ pieces: l.pieces.map((p) => ({ ...p })) }));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 1; i < out.length; i++) {
      const line = out[i];
      const firstP = line.pieces[0];
      if (!firstP || !firstP.text) continue;
      const firstCh = firstP.text[0];
      if (!FORBIDDEN_LINE_START.includes(firstCh)) continue;
      // 移到上一行
      const prevLine = out[i - 1];
      const prevLast = prevLine.pieces[prevLine.pieces.length - 1];
      if (prevLast && prevLast.isBold === firstP.isBold && prevLast.isItalic === firstP.isItalic && prevLast.linkUrl === firstP.linkUrl) {
        prevLast.text += firstCh;
      } else {
        prevLine.pieces.push({
          text: firstCh, isBold: firstP.isBold, isItalic: firstP.isItalic, linkUrl: firstP.linkUrl,
        });
      }
      firstP.text = firstP.text.slice(1);
      if (firstP.text.length === 0) line.pieces.shift();
      moved = true;
    }
    if (!moved) break;
  }
  // 過濾空 line + 空 piece
  return out
    .map((l) => ({ pieces: l.pieces.filter((p) => p.text.length > 0) }))
    .filter((l) => l.pieces.length > 0);
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
  return applyCJKPunctuationRules(lines);
}
