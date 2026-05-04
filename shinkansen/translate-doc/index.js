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

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEBUG_RENDER_SCALE = 1.5;

const $ = (id) => document.getElementById(id);

const stages = {
  upload: $('stage-upload'),
  parsing: $('stage-parsing'),
  result: $('stage-result'),
  translating: $('stage-translating'),
  translated: $('stage-translated'),
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
  $('debug-btn').addEventListener('click', () => {
    if (!currentDoc) return;
    currentDebugPage = 0;
    showStage('debug');
    renderDebugPage();
  });
  $('translate-btn').addEventListener('click', () => startTranslate());
}

function bindTranslatedUI() {
  $('translate-cancel-btn').addEventListener('click', () => {
    if (translateAbortController) {
      translateAbortController.abort();
    }
  });
  $('translated-open-reader-btn').addEventListener('click', () => openReader());
  $('translated-view-overlay-btn').addEventListener('click', () => {
    if (!currentDoc) return;
    currentDebugPage = 0;
    showStage('debug');
    renderDebugPage();
  });
  $('translated-reupload-btn').addEventListener('click', () => {
    releaseCurrentDoc();
    showStage('upload');
  });
}

function bindReaderUI() {
  $('reader-back-overlay-btn').addEventListener('click', () => {
    currentDebugPage = 0;
    showStage('debug');
    renderDebugPage();
  });
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
  $('reader-title').textContent = currentDoc.meta.filename || '(未命名)';
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
    showStage('result');
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
  bindTranslatedUI();
  bindReaderUI();
  bindDebugUI();
  showStage('upload');
}

// ---------- 翻譯流程(W3) ----------

async function startTranslate() {
  if (!currentDoc) return;

  // 讀使用者預設 preset。MVP 先用 slot 1 (translatePresets[0])，通常是 Flash Lite。
  // W3-iter2 加 UI 讓使用者選 slot，目前 hardcoded 取第一組 gemini engine 的 preset。
  let modelOverride = undefined;
  try {
    const settings = await chrome.storage.sync.get(['translatePresets']);
    const presets = settings.translatePresets || [];
    const geminiPreset = presets.find((p) => p && p.engine === 'gemini' && p.model);
    if (geminiPreset) modelOverride = geminiPreset.model;
  } catch (err) {
    console.warn('[Shinkansen] 讀 translatePresets 失敗，改用 background 預設模型', err);
  }
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

  translateAbortController = new AbortController();
  let summary;
  try {
    summary = await translateDocument(currentDoc, {
      modelOverride,
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

  // 顯示完成頁
  $('translated-count').textContent = `${summary.translatedBlocks - summary.failedBlocks} / ${summary.totalBlocks}`;
  $('translated-failed').textContent = summary.failedBlocks
    ? `${summary.failedBlocks} 段`
    : '0';
  const cacheHits = summary.cacheHits || 0;
  $('translated-cache-hits').textContent = cacheHits > 0
    ? `${cacheHits} 段(${((cacheHits / summary.totalBlocks) * 100).toFixed(0)}%)`
    : '0';
  $('translated-input-tokens').textContent = summary.cumulativeInputTokens.toLocaleString('en-US');
  $('translated-output-tokens').textContent = summary.cumulativeOutputTokens.toLocaleString('en-US');
  $('translated-cost').textContent = `$${summary.cumulativeCostUSD.toFixed(4)} USD`;

  // dev probe expose 翻譯結果
  if (window.__skLayoutDoc) {
    window.__skLayoutDoc.translateSummary = summary;
  }

  showStage('translated');
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
