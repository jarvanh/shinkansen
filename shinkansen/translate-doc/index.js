// index.js — translate-doc 頁面主協調層
//
// W2-iter1：上傳 → parsePdf → analyzeLayout → 顯示版面 IR 摘要 + 提供 debug overlay 預覽
// (SVG 疊在 PDF.js canvas 上，可肉眼驗 block 切分是否合理)。
// 完整翻譯 / 閱讀器 / 下載走後續週次。

import { parsePdf, preflightFile, renderPageToCanvas, closeDocument, PdfParseError } from './pdf-engine.js';
import { analyzeLayout } from './layout-analyzer.js';
import { translateDocument } from './translate.js';
import { renderReader, buildPlainTextDump } from './reader.js';
import { downloadBilingualPdf } from './pdf-renderer.js';
import { formatMoney } from '../lib/format.js';
import { getCachedRate, FALLBACK_USD_TWD_RATE } from '../lib/exchange-rate.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEBUG_RENDER_SCALE = 1.5;

const $ = (id) => document.getElementById(id);

const stages = {
  upload: $('stage-upload'),
  parsing: $('stage-parsing'),
  result: $('stage-result'),
  translating: $('stage-translating'),
  reader: $('stage-reader'),
  debug: $('stage-debug'),
};

let parseAbortController = null;
let translateAbortController = null;
let currentDoc = null;       // analyzeLayout 輸出
let currentPdfDoc = null;    // PDF.js PDFDocumentProxy（記得 destroy）
let currentDebugPage = 0;
let currentReaderHandle = null;
let currentModelOverride = null;
let currentOriginalArrayBuffer = null; // W6：留 PDF 原 ArrayBuffer 給 pdf-lib 重組譯文 PDF 用
let lastTranslateSummary = null;       // 翻譯紀錄 modal 顯示用
// 翻譯設定：選定 preset slot(1 / 2 / 3)，從 storage.local.translateDocPresetSlot 讀，
// 預設 1。對應 storage.sync.translatePresets[slot - 1] 的 model 當 modelOverride
let currentPresetSlot = 1;
let cachedPresets = null;
let currentApplyGlossary = false;

function showStage(name) {
  for (const [key, el] of Object.entries(stages)) {
    el.hidden = key !== name;
  }
}

function setVersionFooter() {
  try {
    const v = chrome.runtime.getManifest().version;
    $('footer-version').textContent = `Shinkansen v${v}`;
  } catch (_) {
    /* manifest 拿不到時靜默 */
  }
}

function showError(msg) {
  const el = $('upload-error');
  el.textContent = msg;
  el.hidden = false;
  showStage('upload');
}

function clearError() {
  const el = $('upload-error');
  el.textContent = '';
  el.hidden = true;
}

function setParsingDetail(text) {
  $('parsing-detail').textContent = text;
}

function releaseCurrentDoc() {
  if (currentReaderHandle) {
    try { currentReaderHandle.destroy(); } catch (_) { /* ignore */ }
    currentReaderHandle = null;
  }
  if (currentPdfDoc) {
    closeDocument(currentPdfDoc);
    currentPdfDoc = null;
  }
  currentDoc = null;
  currentDebugPage = 0;
  currentModelOverride = null;
  currentOriginalArrayBuffer = null;
  lastTranslateSummary = null;
  if (window.__skLayoutDoc) delete window.__skLayoutDoc;
}

async function handleFile(file) {
  clearError();

  const pre = preflightFile(file);
  if (pre.level === 'error') {
    showError(pre.message);
    return;
  }
  // softWarn（超過 5MB 但未達 10MB）目前先不做 modal，直接繼續解析
  // 軟警告完整 modal 走 W7 UX polish

  // 切新檔前釋放舊 pdfDoc(避免 PDF.js Worker 累積)
  releaseCurrentDoc();

  showStage('parsing');
  setParsingDetail('讀取檔案內容…');

  try {
    // W6：讀一次 file.arrayBuffer() cache 起來，給後續 pdf-renderer 重組譯文 PDF 用
    // (parsePdf 內也讀一次，但 PDF.js 內部消費掉，不能 reuse；這裡多 read 一次)
    currentOriginalArrayBuffer = await file.arrayBuffer();
    const rawDoc = await parsePdf(file, (progress) => {
      switch (progress.stage) {
        case 'reading':
          setParsingDetail('讀取檔案內容…');
          break;
        case 'opening':
          setParsingDetail('開啟 PDF 文件…');
          break;
        case 'page':
          setParsingDetail(`抽取第 ${progress.current} / ${progress.total} 頁的文字…`);
          break;
        default:
          break;
      }
    });

    setParsingDetail('版面分析中…');
    const doc = analyzeLayout(rawDoc);
    currentDoc = doc;
    currentPdfDoc = rawDoc.pdfDoc;

    // dev probe: expose 給 tools/pdf-layout-harness.js 用 page.evaluate 讀
    // 不影響使用者(只是多一個 global ref;memory 釋放交給 releaseCurrentDoc)
    window.__skLayoutDoc = {
      meta: doc.meta,
      stats: doc.stats,
      warnings: doc.warnings,
      pages: doc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        columnCount: p.columnCount,
        medianLineHeight: p.medianLineHeight,
        bodyFontSize: p.bodyFontSize,
        blocks: p.blocks,
      })),
      // dev probe(W2-iter3 期間留著，iter4 移除):raw text runs 也 expose 供 harness 抓
      _rawPages: rawDoc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        textRuns: p.textRuns,
      })),
    };

    // dev hook for tools/pdf-structure-verify.js — 不影響 production,
    // 只暴露操作 module-scope state 的函式,供 harness 注入 fake translation
    // + 攔截 downloadBilingualPdf 的 PDF bytes 做版面結構核對
    window.__skVerify = {
      hasDoc: () => !!currentDoc,
      injectPlainTextAsTranslation: () => {
        if (!currentDoc) return null;
        let count = 0;
        for (const page of currentDoc.pages) {
          for (const block of page.blocks) {
            if (TRANSLATABLE_TYPES_SET.has(block.type) && block.plainText && block.plainText.trim()) {
              block.translation = block.plainText;
              block.translationStatus = 'done';
              count++;
            }
          }
        }
        return { translatableCount: count };
      },
      generateAndVerifyPdf: async () => {
        if (!currentDoc || !currentOriginalArrayBuffer) return null;
        let capturedBytes = null;
        const origCreateObjectURL = URL.createObjectURL;
        const origAppendChild = document.body.appendChild.bind(document.body);
        URL.createObjectURL = function (blob) {
          if (blob && typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then((buf) => { capturedBytes = new Uint8Array(buf); });
          }
          return 'blob:verify-stub';
        };
        document.body.appendChild = function (el) {
          if (el && el.tagName === 'A' && el.download) el.click = () => {};
          return origAppendChild(el);
        };
        let result = null;
        let error = null;
        const t0 = performance.now();
        try {
          result = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {});
          for (let i = 0; i < 200 && !capturedBytes; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }
        } catch (err) {
          error = (err && err.message) || String(err);
        } finally {
          URL.createObjectURL = origCreateObjectURL;
          document.body.appendChild = origAppendChild;
        }
        const elapsedMs = Math.round(performance.now() - t0);
        if (!result || !capturedBytes) {
          return { ok: false, error: error || 'no-bytes-captured', elapsedMs };
        }
        // 重 parse 驗證頁數 + 文字 run 數量
        const pdfjsLib = await import('../lib/vendor/pdfjs/pdf.min.mjs');
        let reparsed = null;
        let reparseError = null;
        try {
          const loadingTask = pdfjsLib.getDocument({ data: capturedBytes.slice(0).buffer, disableFontFace: false });
          const pdfDoc = await loadingTask.promise;
          const pageDiagnostics = [];
          for (let i = 0; i < pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i + 1);
            const tc = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1 });
            pageDiagnostics.push({
              pageIndex: i,
              width: Math.round(viewport.width),
              height: Math.round(viewport.height),
              runCount: tc.items.length,
            });
          }
          reparsed = { numPages: pdfDoc.numPages, pages: pageDiagnostics };
          await pdfDoc.destroy();
        } catch (err) {
          reparseError = (err && err.message) || String(err);
        }
        return {
          ok: true,
          error: null,
          byteLength: result.byteLength,
          captured: capturedBytes.byteLength,
          elapsedMs,
          reparsed,
          reparseError,
        };
      },
      computeStructureDiagnostics: () => {
        if (!currentDoc) return null;
        return computeStructureDiagnostics(currentDoc);
      },
    };

    // W2 暫定：把版面 IR 印到 console 供肉眼驗
    const totalBlocks = doc.pages.reduce((sum, p) => sum + p.blocks.length, 0);
    console.group('[Shinkansen] PDF 版面分析完成');
    console.log('meta:', doc.meta);
    console.log('stats:', doc.stats);
    console.log('warnings:', doc.warnings);
    console.log('總 block 數：', totalBlocks);
    console.log('pages:', doc.pages);
    if (doc.pages[0]) {
      console.log('首頁 blocks:', doc.pages[0].blocks);
    }
    console.groupEnd();

    // UI 摘要
    $('result-filename').textContent = doc.meta.filename || '（未命名）';
    $('result-pages').textContent = `${doc.meta.pageCount} 頁`;
    $('result-runs').textContent = doc.stats.totalRuns.toLocaleString('en-US');
    $('result-chars').textContent = doc.stats.totalChars.toLocaleString('en-US');
    $('result-blocks').textContent = totalBlocks.toLocaleString('en-US');

    if (doc.warnings.length > 0) {
      const warnEl = $('upload-error');
      warnEl.textContent = doc.warnings.map((w) => `提醒：${w.message}`).join(' / ');
      warnEl.hidden = false;
    }

    showStage('result');
  } catch (err) {
    if (err instanceof PdfParseError) {
      showError(err.message);
    } else {
      console.error('[Shinkansen] PDF 解析失敗', err);
      showError(`解析失敗：${(err && err.message) || String(err)}`);
    }
    releaseCurrentDoc();
  }
}

// ---------- Debug overlay ----------

// 給每個 block 配個穩定色相(reading order * 黃金比例 mod 360 → 視覺分散)
function blockHue(readingOrder) {
  return (readingOrder * 137.508) % 360;
}

// type 對應的色盤(HSL 三元組：hue, saturation, lightness)
const BLOCK_TYPE_COLORS = {
  heading: [0, 75, 50],       // 紅暖色：標題
  paragraph: [210, 70, 50],   // 藍：正文
  'list-item': [140, 60, 42], // 綠：條列
  footnote: [40, 60, 45],     // 橙：腳註
  'page-number': [0, 0, 60],  // 灰：頁碼
  table: [280, 60, 50],       // 紫：表格
  formula: [320, 60, 45],     // 洋紅：公式(W2-iter6)
  caption: [180, 60, 40],     // 青：說明(W2-iter6)
  figure: [0, 0, 75],         // 淡灰：圖
};

function blockColorForType(type) {
  const c = BLOCK_TYPE_COLORS[type] || BLOCK_TYPE_COLORS.paragraph;
  return {
    stroke: `hsl(${c[0]}, ${c[1]}%, ${c[2]}%)`,
    fill: `hsl(${c[0]}, ${c[1]}%, ${c[2] + 10}%)`,
  };
}

function blockColorForOrder(order) {
  const hue = blockHue(order);
  return {
    stroke: `hsl(${hue}, 70%, 45%)`,
    fill: `hsl(${hue}, 70%, 55%)`,
  };
}

function renderTypeLegend(blocks) {
  const el = $('debug-type-legend');
  if (!el) return;
  // 統計這頁出現的 types
  const counts = {};
  for (const b of blocks) counts[b.type] = (counts[b.type] || 0) + 1;
  const order = ['heading', 'paragraph', 'list-item', 'footnote', 'page-number', 'table', 'formula', 'caption', 'figure'];
  el.innerHTML = '';
  for (const t of order) {
    if (!counts[t]) continue;
    const span = document.createElement('span');
    const color = BLOCK_TYPE_COLORS[t];
    span.style.color = `hsl(${color[0]}, ${color[1]}%, ${color[2]}%)`;
    const swatch = document.createElement('i');
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(`${t} (${counts[t]})`));
    el.appendChild(span);
  }
}

function setBlockDetail(block) {
  const el = $('debug-detail');
  el.innerHTML = '';
  if (!block) {
    el.innerHTML = '<span class="debug-detail-empty">把游標移到 bbox 上看該 block 的 plainText</span>';
    return;
  }
  const idSpan = document.createElement('span');
  idSpan.className = 'debug-detail-id';
  const statusSuffix = block.translationStatus ? ` · ${block.translationStatus}` : '';
  idSpan.textContent = `#${block.readingOrder} ${block.blockId} · ${block.type}${statusSuffix}`;
  const metaSpan = document.createElement('span');
  metaSpan.className = 'debug-detail-meta';
  metaSpan.textContent = `column ${block.column} · ${block.lineCount} 行 · ${block.fontSize.toFixed(1)}pt`;

  el.appendChild(idSpan);
  el.appendChild(metaSpan);
  el.appendChild(document.createElement('br'));

  const previewText = (txt) =>
    !txt ? '（空）' : (txt.length > 280 ? txt.slice(0, 280) + '…' : txt);

  // 原文
  const origLabel = document.createElement('span');
  origLabel.style.color = 'var(--text-faint)';
  origLabel.textContent = '原文：';
  el.appendChild(origLabel);
  const origText = document.createElement('span');
  origText.textContent = ' ' + previewText(block.plainText);
  el.appendChild(origText);

  // 譯文(若有)
  if (block.translation) {
    el.appendChild(document.createElement('br'));
    const trLabel = document.createElement('span');
    trLabel.style.color = 'var(--primary)';
    trLabel.textContent = '譯文：';
    el.appendChild(trLabel);
    const trText = document.createElement('span');
    trText.textContent = ' ' + previewText(block.translation);
    el.appendChild(trText);
  } else if (block.translationError) {
    el.appendChild(document.createElement('br'));
    const errLabel = document.createElement('span');
    errLabel.style.color = 'var(--error-text)';
    errLabel.textContent = `翻譯失敗： ${block.translationError}`;
    el.appendChild(errLabel);
  }
}

async function renderDebugPage() {
  if (!currentDoc || !currentPdfDoc) return;
  const pageIndex = currentDebugPage;
  const layoutPage = currentDoc.pages[pageIndex];
  if (!layoutPage) return;

  const total = currentDoc.pages.length;
  $('debug-page-indicator').textContent = `第 ${pageIndex + 1} / ${total} 頁`;
  $('debug-prev').disabled = pageIndex === 0;
  $('debug-next').disabled = pageIndex >= total - 1;
  const bodyFs = layoutPage.bodyFontSize ? `${layoutPage.bodyFontSize.toFixed(1)}pt` : 'N/A';
  $('debug-page-stats').textContent =
    `block 數 ${layoutPage.blocks.length} · column 數 ${layoutPage.columnCount} · ` +
    `medianLineHeight ${layoutPage.medianLineHeight.toFixed(1)}pt · body fontSize ${bodyFs}`;
  renderTypeLegend(layoutPage.blocks);

  const canvas = $('debug-canvas');
  let renderInfo;
  try {
    renderInfo = await renderPageToCanvas(currentPdfDoc, pageIndex, canvas, DEBUG_RENDER_SCALE);
  } catch (err) {
    console.error('[Shinkansen] render page 失敗', err);
    return;
  }

  // SVG overlay 對齊 canvas 像素尺寸
  const svg = $('debug-svg');
  svg.setAttribute('width', String(renderInfo.width));
  svg.setAttribute('height', String(renderInfo.height));
  svg.setAttribute('viewBox', `0 0 ${renderInfo.width} ${renderInfo.height}`);
  svg.style.width = `${renderInfo.width}px`;
  svg.style.height = `${renderInfo.height}px`;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const showBbox = $('debug-show-bbox').checked;
  const showOrder = $('debug-show-order').checked;
  const isolateRaw = $('debug-isolate-input').value.trim();
  const isolateOrder = isolateRaw === '' ? null : Number.parseInt(isolateRaw, 10);

  // bbox 已是 canvas 座標(y 由上往下，套過 viewport.transform)，直接乘 scale 即可
  const scale = renderInfo.scale;

  setBlockDetail(null);

  // dev probe:exposed 給 harness / 手動 console inspect
  window.__skDebugSvg = svg;
  window.__skDebugBlocks = layoutPage.blocks;

  for (const block of layoutPage.blocks) {
    if (isolateOrder !== null && !Number.isNaN(isolateOrder) && block.readingOrder !== isolateOrder) continue;

    const [left, top, right, bottom] = block.bbox;
    const rectX = left * scale;
    const rectY = top * scale;
    const rectW = Math.max(1, (right - left) * scale);
    const rectH = Math.max(1, (bottom - top) * scale);

    const colorMode = $('debug-color-mode')?.value || 'type';
    const { stroke, fill } = colorMode === 'type'
      ? blockColorForType(block.type)
      : blockColorForOrder(block.readingOrder);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'debug-block-group');
    group.dataset.blockId = block.blockId;

    if (showBbox) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(rectX));
      rect.setAttribute('y', String(rectY));
      rect.setAttribute('width', String(rectW));
      rect.setAttribute('height', String(rectH));
      rect.setAttribute('class', 'debug-block-rect');
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('fill', fill);
      group.appendChild(rect);
    }

    if (showOrder) {
      const labelText = `#${block.readingOrder}`;
      const padX = 4;
      const labelH = 13;
      const estW = labelText.length * 7 + padX * 2;
      // label 放 bbox 內右上角(跟前一個 block 的 bbox 不互相重疊)
      const labelX = Math.max(0, rectX + rectW - estW);
      const labelY = rectY;

      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('x', String(labelX));
      bg.setAttribute('y', String(labelY));
      bg.setAttribute('width', String(estW));
      bg.setAttribute('height', String(labelH));
      bg.setAttribute('rx', '2');
      bg.setAttribute('class', 'debug-block-label-bg');
      bg.setAttribute('fill', '#fff');
      bg.setAttribute('stroke', stroke);
      group.appendChild(bg);

      const txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('x', String(labelX + padX));
      txt.setAttribute('y', String(labelY + labelH - 3));
      txt.setAttribute('class', 'debug-block-label');
      txt.setAttribute('fill', stroke);
      txt.textContent = labelText;
      group.appendChild(txt);
    }

    group.addEventListener('mouseenter', () => setBlockDetail(block));
    group.addEventListener('mouseleave', () => setBlockDetail(null));
    group.addEventListener('click', () => {
      // click 鎖定 detail，再 click 同一個解鎖
      if (group.classList.contains('is-active')) {
        group.classList.remove('is-active');
        setBlockDetail(null);
      } else {
        svg.querySelectorAll('.debug-block-group.is-active').forEach((g) => g.classList.remove('is-active'));
        group.classList.add('is-active');
        setBlockDetail(block);
      }
    });

    svg.appendChild(group);
  }
}

// ---------- 事件綁定 ----------

function bindUploadUI() {
  const dropzone = $('dropzone');
  const fileInput = $('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      handleFile(file);
      fileInput.value = ''; // reset 讓同一檔案可重選
    }
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

function bindResultUI() {
  $('reupload-btn').addEventListener('click', () => {
    clearError();
    releaseCurrentDoc();
    showStage('upload');
  });
  $('cancel-btn').addEventListener('click', () => {
    if (parseAbortController) {
      parseAbortController.abort();
      parseAbortController = null;
    }
    releaseCurrentDoc();
    showStage('upload');
  });
  $('translate-btn').addEventListener('click', () => startTranslate());
}

function bindTranslatingUI() {
  // 翻譯中 stage 的「取消」按鈕(原 bindTranslatedUI 內含此 binding,
  // stage-translated 砍掉後該 binding 仍要保留)
  $('translate-cancel-btn').addEventListener('click', () => {
    if (translateAbortController) {
      translateAbortController.abort();
    }
  });
}

const TRANSLATABLE_TYPES_SET = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);
const GLOSSARY_INPUT_MAX_CHARS = 60_000;

// 結構面診斷:純從 layout doc 推 reader / pdf-renderer 注入後的版面正確性。
// 不需要真的 render UI / 生成 PDF 就能 catch 大部分 IR 問題。供 __skVerify hook 用。
function computeStructureDiagnostics(doc) {
  const issues = [];
  const PCT_EPSILON = 0.5; // 容忍 0.5% 邊緣誤差(round 進位)
  const BBOX_OUTSIDE_TOL = 1.5; // 容忍 1.5pt 邊緣誤差
  for (const page of doc.pages) {
    const pageW = page.viewport.width;
    const pageH = page.viewport.height;
    if (!(pageW > 0 && pageH > 0)) {
      issues.push({ pageIndex: page.pageIndex, blockId: '-', code: 'invalid-page-size', detail: `${pageW}x${pageH}` });
      continue;
    }
    const seenOrders = new Set();
    for (const block of page.blocks) {
      if (!Array.isArray(block.bbox) || block.bbox.length !== 4) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId || '-', code: 'no-bbox', detail: '' });
        continue;
      }
      const [x0, y0, x1, y1] = block.bbox;
      if (!(x0 < x1 && y0 < y1)) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'invalid-bbox', detail: `[${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}]` });
        continue;
      }
      if (x0 < -BBOX_OUTSIDE_TOL || y0 < -BBOX_OUTSIDE_TOL || x1 > pageW + BBOX_OUTSIDE_TOL || y1 > pageH + BBOX_OUTSIDE_TOL) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'bbox-outside-page', detail: `[${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}] page=${pageW.toFixed(0)}x${pageH.toFixed(0)}` });
      }
      if (TRANSLATABLE_TYPES_SET.has(block.type)) {
        if (!block.plainText || !block.plainText.trim()) {
          issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'empty-plain-text', detail: block.type });
        }
      }
      if (typeof block.fontSize === 'number' && (block.fontSize < 0 || block.fontSize > 200)) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'extreme-font-size', detail: `${block.fontSize.toFixed(1)}pt` });
      }
      // reader.js renderOverlayBlock 算的 % 必須合法
      const leftPct = (x0 / pageW) * 100;
      const topPct = (y0 / pageH) * 100;
      const widthPct = ((x1 - x0) / pageW) * 100;
      const heightPct = ((y1 - y0) / pageH) * 100;
      if (leftPct < -PCT_EPSILON || topPct < -PCT_EPSILON
          || leftPct + widthPct > 100 + PCT_EPSILON
          || topPct + heightPct > 100 + PCT_EPSILON) {
        issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'overlay-pct-overflow', detail: `L=${leftPct.toFixed(1)} T=${topPct.toFixed(1)} W=${widthPct.toFixed(1)} H=${heightPct.toFixed(1)}` });
      }
      // readingOrder duplicate 檢查
      if (typeof block.readingOrder === 'number') {
        if (seenOrders.has(block.readingOrder)) {
          issues.push({ pageIndex: page.pageIndex, blockId: block.blockId, code: 'duplicate-reading-order', detail: String(block.readingOrder) });
        }
        seenOrders.add(block.readingOrder);
      }
    }
  }
  return { issueCount: issues.length, issues };
}

// 對整份 PDF 送 EXTRACT_GLOSSARY 拿 [{source, target}] 對照表(術語表一致化)
async function extractGlossaryForDoc(doc) {
  const parts = [];
  let acc = 0;
  for (const page of doc.pages) {
    for (const b of page.blocks) {
      if (!TRANSLATABLE_TYPES_SET.has(b.type)) continue;
      const t = b.plainText && b.plainText.trim();
      if (!t) continue;
      if (acc + t.length > GLOSSARY_INPUT_MAX_CHARS) {
        parts.push(t.slice(0, GLOSSARY_INPUT_MAX_CHARS - acc));
        acc = GLOSSARY_INPUT_MAX_CHARS;
        break;
      }
      parts.push(t);
      acc += t.length + 1;
    }
    if (acc >= GLOSSARY_INPUT_MAX_CHARS) break;
  }
  const compressedText = parts.join('\n');
  if (compressedText.length < 200) {
    console.log('[Shinkansen] glossary skipped (text too short)', { chars: compressedText.length });
    return null;
  }
  const inputHash = await sha1(compressedText);
  console.log('[Shinkansen] glossary extracting', { chars: compressedText.length, hash: inputHash.slice(0, 8) });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXTRACT_GLOSSARY',
      payload: { compressedText, inputHash },
    });
    if (res?.ok && Array.isArray(res.glossary) && res.glossary.length > 0) {
      return res.glossary;
    }
    if (res?.ok) {
      console.log('[Shinkansen] glossary returned empty');
      return null;
    }
    console.warn('[Shinkansen] glossary not ok', res?.error);
    return null;
  } catch (err) {
    console.warn('[Shinkansen] glossary extract failed', err && err.message);
    return null;
  }
}

async function sha1(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 翻譯設定：讀使用者選定 slot，取對應 preset 的 model 當 modelOverride。
// 不存在 / Google MT(model 為 null)時 modelOverride = undefined，讓 background
// 走全域 geminiConfig.model 預設
async function resolveModelOverride() {
  const presets = await loadPresets();
  const idx = (currentPresetSlot || 1) - 1;
  const p = presets[idx];
  if (p && p.engine === 'gemini' && p.model) return p.model;
  return undefined;
}

async function loadPresets() {
  if (cachedPresets) return cachedPresets;
  try {
    const r = await chrome.storage.sync.get(['translatePresets']);
    cachedPresets = Array.isArray(r.translatePresets) ? r.translatePresets : [];
  } catch (err) {
    console.warn('[Shinkansen] 讀 translatePresets 失敗', err);
    cachedPresets = [];
  }
  return cachedPresets;
}

async function loadCurrentPresetSlot() {
  try {
    const r = await chrome.storage.local.get(['translateDocPresetSlot', 'translateDocApplyGlossary']);
    const slot = parseInt(r.translateDocPresetSlot, 10);
    if (slot >= 1 && slot <= 3) currentPresetSlot = slot;
    else currentPresetSlot = 1;
    currentApplyGlossary = r.translateDocApplyGlossary === true;
  } catch (err) {
    currentPresetSlot = 1;
    currentApplyGlossary = false;
  }
}

async function openSettingsDialog() {
  const presets = await loadPresets();
  const dlg = $('translate-settings-dialog');
  $('settings-apply-glossary').checked = currentApplyGlossary;
  const list = $('settings-preset-list');
  list.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const p = presets[i] || { slot: i + 1, engine: 'gemini', model: null, label: `Slot ${i + 1}` };
    const slot = i + 1;
    const row = document.createElement('label');
    row.className = 'settings-preset-row' + (slot === currentPresetSlot ? ' is-selected' : '');
    row.innerHTML = `
      <input type="radio" name="preset-slot" value="${slot}" ${slot === currentPresetSlot ? 'checked' : ''}>
      <span class="preset-label">Slot ${slot} · ${p.label || '(未命名)'}</span>
      <span class="preset-engine">${p.engine === 'gemini' ? (p.model || 'gemini') : (p.engine === 'google' ? 'Google MT' : p.engine)}</span>
    `;
    row.addEventListener('click', () => {
      list.querySelectorAll('.settings-preset-row').forEach((el) => el.classList.remove('is-selected'));
      row.classList.add('is-selected');
      row.querySelector('input').checked = true;
    });
    list.appendChild(row);
  }
  dlg.showModal();
}

function bindSettingsDialogUI() {
  const dlg = $('translate-settings-dialog');
  $('translate-settings-cancel-btn').addEventListener('click', () => dlg.close());
  $('translate-settings-save-btn').addEventListener('click', async () => {
    const checked = dlg.querySelector('input[name="preset-slot"]:checked');
    const slot = checked ? parseInt(checked.value, 10) : currentPresetSlot;
    const applyGlossary = $('settings-apply-glossary').checked;
    currentPresetSlot = slot;
    currentApplyGlossary = applyGlossary;
    try {
      await chrome.storage.local.set({
        translateDocPresetSlot: slot,
        translateDocApplyGlossary: applyGlossary,
      });
    } catch (_) { /* ignore */ }
    dlg.close();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  // stage-result + reader-toolbar 兩個按鈕都開同一個 dialog
  $('result-settings-btn').addEventListener('click', () => openSettingsDialog());
  $('reader-settings-btn').addEventListener('click', () => openSettingsDialog());
}

function bindSummaryDialogUI() {
  const dlg = $('translate-summary-dialog');
  $('translate-summary-close-btn').addEventListener('click', () => dlg.close());
  $('translate-summary-overlay-btn').addEventListener('click', () => {
    dlg.close();
    if (!currentDoc) return;
    currentDebugPage = 0;
    showStage('debug');
    renderDebugPage();
  });
  // 點 backdrop(對話框外)關閉
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

function bindReaderUI() {
  $('reader-reupload-btn').addEventListener('click', () => {
    releaseCurrentDoc();
    showStage('upload');
  });
  $('reader-copy-btn').addEventListener('click', async () => {
    if (!currentDoc) return;
    const txt = buildPlainTextDump(currentDoc);
    const btn = $('reader-copy-btn');
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(txt);
      btn.textContent = `已複製 ${(txt.length / 1024).toFixed(1)} KB`;
    } catch (err) {
      console.error('clipboard 失敗', err);
      btn.textContent = '複製失敗';
    }
    setTimeout(() => { btn.textContent = orig; }, 2500);
  });
  $('reader-sync-toggle').addEventListener('change', (e) => {
    if (currentReaderHandle) {
      currentReaderHandle.setSyncEnabled(e.target.checked);
    }
  });
  $('reader-zoom-out').addEventListener('click', () => stepZoom(-0.1));
  $('reader-zoom-in').addEventListener('click', () => stepZoom(+0.1));
  $('reader-summary-btn').addEventListener('click', async () => {
    if (!lastTranslateSummary) return;
    await fillSummaryDialog(lastTranslateSummary);
    $('translate-summary-dialog').showModal();
  });
  $('reader-download-pdf-btn').addEventListener('click', async () => {
    if (!currentDoc || !currentOriginalArrayBuffer) return;
    const btn = $('reader-download-pdf-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '產生 PDF 中…';
    try {
      const result = await downloadBilingualPdf(currentOriginalArrayBuffer, currentDoc, {
        onProgress: (p) => {
          if (p.stage === 'page') {
            btn.textContent = `處理第 ${p.current} / ${p.total} 頁…`;
          } else if (p.stage === 'saving') {
            btn.textContent = '寫檔中…';
          } else if (p.stage === 'font') {
            btn.textContent = '載入字型…';
          }
        },
      });
      const sizeMB = (result.byteLength / 1024 / 1024).toFixed(1);
      btn.textContent = `已下載 ${sizeMB} MB`;
    } catch (err) {
      console.error('[Shinkansen] 下載譯文 PDF 失敗', err);
      btn.textContent = `失敗：${(err && err.message) || '未知錯誤'}`;
    }
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 3000);
  });
  $('reader-retry-all-btn').addEventListener('click', async () => {
    if (!currentReaderHandle) return;
    const btn = $('reader-retry-all-btn');
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = '重試中…';
    try {
      const r = await currentReaderHandle.retryAllFailed();
      btn.textContent = `${r.success}/${r.total} 成功`;
    } catch (err) {
      console.error('retryAll 失敗', err);
      btn.textContent = '重試失敗';
    }
    setTimeout(() => {
      btn.textContent = origText;
      // updateRetryAllUI 會在 onAfterRetry 內被呼叫，這裡不用手動 reset hidden
    }, 2500);
  });
}

async function openReader() {
  if (!currentDoc || !currentPdfDoc) return;
  showStage('reader');
  // 等 stage 切換 + layout 確定後再 render(canvas size 才對)
  await new Promise((r) => requestAnimationFrame(r));
  if (currentReaderHandle) {
    try { currentReaderHandle.destroy(); } catch (_) { /* ignore */ }
    currentReaderHandle = null;
  }
  currentReaderHandle = await renderReader(
    currentDoc,
    currentPdfDoc,
    $('reader-col-original'),
    $('reader-col-translated'),
    {
      modelOverride: currentModelOverride,
      onFailedCountChange: updateRetryAllUI,
    }
  );
  // 套用 sync toggle + 重設 zoom 顯示
  if (currentReaderHandle) {
    currentReaderHandle.setSyncEnabled($('reader-sync-toggle').checked);
    $('reader-zoom-level').textContent = `${Math.round(currentReaderHandle.getZoom() * 100)}%`;
  }
}

function updateRetryAllUI(failedCount) {
  const btn = $('reader-retry-all-btn');
  $('reader-failed-count').textContent = String(failedCount);
  btn.hidden = failedCount === 0;
  btn.disabled = false;
}

function stepZoom(delta) {
  if (!currentReaderHandle) return;
  const cur = currentReaderHandle.getZoom();
  const next = currentReaderHandle.setZoom(cur + delta);
  $('reader-zoom-level').textContent = `${Math.round(next * 100)}%`;
}

function bindDebugUI() {
  $('debug-prev').addEventListener('click', () => {
    if (currentDebugPage > 0) {
      currentDebugPage--;
      renderDebugPage();
    }
  });
  $('debug-next').addEventListener('click', () => {
    if (currentDoc && currentDebugPage < currentDoc.pages.length - 1) {
      currentDebugPage++;
      renderDebugPage();
    }
  });
  $('debug-show-bbox').addEventListener('change', () => renderDebugPage());
  $('debug-show-order').addEventListener('change', () => renderDebugPage());
  $('debug-isolate-input').addEventListener('input', () => renderDebugPage());
  $('debug-color-mode').addEventListener('change', () => renderDebugPage());

  $('debug-copy-json-btn').addEventListener('click', async () => {
    if (!currentDoc) return;
    // 序列化：剝掉 pdfDoc(PDF.js proxy 不可序列化)，保留所有 layout 資訊
    const dump = {
      meta: currentDoc.meta,
      stats: currentDoc.stats,
      warnings: currentDoc.warnings,
      pages: currentDoc.pages.map((p) => ({
        pageIndex: p.pageIndex,
        viewport: p.viewport,
        columnCount: p.columnCount,
        medianLineHeight: p.medianLineHeight,
        blocks: p.blocks,
      })),
    };
    const json = JSON.stringify(dump, null, 2);
    const btn = $('debug-copy-json-btn');
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(json);
      btn.textContent = `已複製 ${(json.length / 1024).toFixed(1)}KB`;
    } catch (err) {
      console.error('clipboard 失敗', err);
      console.log('[Shinkansen] dump JSON:', json);
      btn.textContent = '失敗，看 console';
    }
    setTimeout(() => { btn.textContent = orig; }, 2500);
  });
  $('debug-back-btn').addEventListener('click', () => {
    // 已翻譯過 → 回閱讀器；尚未翻譯(只解析過)→ 回 stage-result
    if (currentReaderHandle && lastTranslateSummary) {
      showStage('reader');
    } else {
      showStage('result');
    }
  });

  // 鍵盤左右切頁
  document.addEventListener('keydown', (e) => {
    if (stages.debug.hidden) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      $('debug-prev').click();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      $('debug-next').click();
    }
  });
}

function init() {
  setVersionFooter();
  bindUploadUI();
  bindResultUI();
  bindTranslatingUI();
  bindSummaryDialogUI();
  bindSettingsDialogUI();
  bindReaderUI();
  bindDebugUI();
  // 啟動讀使用者選定的 preset slot
  loadCurrentPresetSlot();
  showStage('upload');
}

// ---------- 翻譯流程(W3) ----------

async function startTranslate() {
  if (!currentDoc) return;

  // 從翻譯設定選定的 preset slot 拿 modelOverride
  const modelOverride = await resolveModelOverride();
  currentModelOverride = modelOverride;

  showStage('translating');
  setProgress({
    totalBlocks: 0,
    translatedBlocks: 0,
    failedBlocks: 0,
    estimatedRemainingSec: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeCostUSD: 0,
  });

  // 術語表一致化:翻譯前先送整份 PDF 給 background 的 EXTRACT_GLOSSARY,拿 [{source, target}]
  // 對照表後傳進 translateDocument,每個 chunk 都帶 glossary 進 prompt 確保各段譯名一致
  let glossary = null;
  if (currentApplyGlossary) {
    setParsingDetail('術語表一致化:萃取對照表中…');
    $('translate-progress-count').textContent = '建立術語表中…';
    glossary = await extractGlossaryForDoc(currentDoc);
    if (glossary) {
      console.log('[Shinkansen] glossary extracted:', glossary.length, 'terms');
    }
  }

  translateAbortController = new AbortController();
  let summary;
  try {
    summary = await translateDocument(currentDoc, {
      modelOverride,
      glossary,
      signal: translateAbortController.signal,
      onProgress: setProgress,
    });
  } catch (err) {
    console.error('[Shinkansen] translateDocument 失敗', err);
    summary = {
      totalBlocks: 0,
      translatedBlocks: 0,
      failedBlocks: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUSD: 0,
      cancelled: false,
      error: (err && err.message) || String(err),
    };
  }
  translateAbortController = null;

  // 存進 module state 供 reader-toolbar「翻譯紀錄」按鈕開的 dialog 顯示
  lastTranslateSummary = summary;

  // dev probe expose 翻譯結果
  if (window.__skLayoutDoc) {
    window.__skLayoutDoc.translateSummary = summary;
  }

  // 直接進雙頁閱讀器(原本中介的 stage-translated 已砍掉)
  await openReader();
}

async function fillSummaryDialog(summary) {
  if (!summary) return;
  const filename = (currentDoc && currentDoc.meta && currentDoc.meta.filename) || '(未命名)';
  $('translated-filename').textContent = filename;
  $('translated-count').textContent = `${summary.translatedBlocks - summary.failedBlocks} / ${summary.totalBlocks}`;
  $('translated-failed').textContent = summary.failedBlocks ? `${summary.failedBlocks} 段` : '0';
  const cacheHits = summary.cacheHits || 0;
  $('translated-cache-hits').textContent = cacheHits > 0 && summary.totalBlocks > 0
    ? `${cacheHits} 段(${((cacheHits / summary.totalBlocks) * 100).toFixed(0)}%)`
    : '0';
  $('translated-input-tokens').textContent = summary.cumulativeInputTokens.toLocaleString('en-US');
  $('translated-output-tokens').textContent = summary.cumulativeOutputTokens.toLocaleString('en-US');
  // 跟主設定的 displayCurrency + cached rate 一致(USD / TWD 切換)
  $('translated-cost').textContent = await formatCostStr(summary.cumulativeCostUSD);
}

async function formatCostStr(usd) {
  try {
    const [{ displayCurrency = 'TWD' }, rateInfo] = await Promise.all([
      chrome.storage.sync.get('displayCurrency'),
      getCachedRate(),
    ]);
    return formatMoney(usd, { currency: displayCurrency, rate: rateInfo?.rate || FALLBACK_USD_TWD_RATE });
  } catch (_) {
    return formatMoney(usd, { currency: 'USD' });
  }
}

function setProgress(p) {
  const ratio = p.totalBlocks > 0 ? (p.translatedBlocks / p.totalBlocks) : 0;
  $('translate-progress-fill').style.width = `${(ratio * 100).toFixed(1)}%`;
  $('translate-progress-count').textContent = `${p.translatedBlocks} / ${p.totalBlocks} 段`;
  $('translate-progress-eta').textContent = p.estimatedRemainingSec > 0
    ? `預估剩餘 ${formatSec(p.estimatedRemainingSec)}`
    : '';
  $('translate-progress-cost').textContent = p.cumulativeCostUSD > 0
    ? `累計 $${p.cumulativeCostUSD.toFixed(4)}`
    : '';
  if (p.failedBlocks > 0) {
    $('translate-progress-failed').textContent = `${p.failedBlocks} 段失敗(完成後可在 overlay 看每段錯誤)`;
    $('translate-progress-failed').hidden = false;
  } else {
    $('translate-progress-failed').hidden = true;
  }
}

function formatSec(sec) {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} 分 ${s} 秒`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
