// reader.js — 雙頁並排閱讀器(W4)
//
// 左欄：逐頁 PDF.js render canvas(完整保留原 PDF 視覺)
// 右欄：逐頁用版面 IR + 譯文重建 HTML，每 block 一個絕對定位 div(以 bbox 比例對齊)
//
// 設計重點(W5-iter2 起)：右欄 = PDF canvas(從左欄 bitmap copy)+ 上層 overlay
// 譯文 div(absolute 對齊原 bbox，白底蓋原文字位置)。視覺上像「換成中文版的 PDF」
//   - 裝飾元素(banner / logo / 圖片 / 不可翻譯區)從 canvas 留下，不蓋
//   - 譯文 div 對應原 bbox 位置 + 字級階層(用 block.fontSize × renderScale × zoom)
//   - 不可翻譯 type(table / formula / figure / page-number)不蓋，讓原 canvas 文字 visible
//   - 翻譯失敗 block 不蓋，讓原文 visible + 紅虛線標記(實作：不 attach overlay div)
//   - 譯文長過 bbox 時 overflow visible 往下蓋下個 block，但都是 white 背景視覺上 OK
//   - W5 雙向 scroll sync：左欄 scroll → viewport 中心 y 對應 block → 右欄 scroll
//     對應 [data-block-id] 對齊；反向同理。scrollSyncSource flag 防迴圈觸發
//   - 段落 retry:failed block 在右欄 overlay 位置加 ↻ 按鈕(SPEC §17.6.3 / §17.7)

import { renderPageToCanvas } from './pdf-engine.js';
import { translateSingleBlock } from './translate.js';

const READER_RENDER_SCALE = 1.5;

const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

const SCROLL_SYNC_RESET_MS = 250; // sync 完成後 N ms 解開 source flag(避免抖動)

/**
 * 渲染雙頁並排閱讀器到指定容器。
 *
 * @param {LayoutDoc} doc                   — analyzeLayout 輸出 + translateDocument 寫回 .translation
 * @param {object}    pdfDoc                — PDF.js PDFDocumentProxy(供左欄 canvas render)
 * @param {HTMLElement} originalCol         — 左欄容器
 * @param {HTMLElement} translatedCol       — 右欄容器
 * @param {object}    [opts]
 * @param {string}    [opts.modelOverride]  — retry 用的 preset model id
 * @param {(failedCount: number) => void} [opts.onFailedCountChange]
 *                                          — 失敗 block 數量變化 callback(retry 成功 / 失敗時更新)
 * @returns {Promise<ReaderHandle>}
 */
export async function renderReader(doc, pdfDoc, originalCol, translatedCol, opts = {}) {
  const { modelOverride, onFailedCountChange = () => {} } = opts;
  let currentZoom = opts.initialZoom || 1.0;
  let syncEnabled = opts.initialSyncEnabled !== false;
  // 清空兩欄
  originalCol.innerHTML = '';
  translatedCol.innerHTML = '';

  if (!doc || !pdfDoc) {
    originalCol.innerHTML = '<div class="reader-empty">尚未上傳 PDF</div>';
    translatedCol.innerHTML = '<div class="reader-empty">尚未翻譯</div>';
    return null;
  }

  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const pageW = page.viewport.width;
    const pageH = page.viewport.height;

    // 左欄：render canvas
    const leftPage = document.createElement('div');
    leftPage.className = 'reader-page reader-page-original';
    leftPage.dataset.pageIndex = String(i);
    const leftCanvas = document.createElement('canvas');
    leftPage.appendChild(leftCanvas);
    originalCol.appendChild(leftPage);

    // 右欄：同一份 PDF canvas(bitmap copy)+ overlay 層放譯文 div
    const rightPage = document.createElement('div');
    rightPage.className = 'reader-page reader-page-translated';
    rightPage.dataset.pageIndex = String(i);
    const rightCanvas = document.createElement('canvas');
    const rightOverlay = document.createElement('div');
    rightOverlay.className = 'reader-translated-overlay';
    rightPage.appendChild(rightCanvas);
    rightPage.appendChild(rightOverlay);
    translatedCol.appendChild(rightPage);

    try {
      const renderInfo = await renderPageToCanvas(pdfDoc, i, leftCanvas, READER_RENDER_SCALE);
      // 從左 canvas bitmap 直接 copy 到右 canvas(避免 render PDF.js 兩次)
      rightCanvas.width = leftCanvas.width;
      rightCanvas.height = leftCanvas.height;
      rightCanvas.getContext('2d').drawImage(leftCanvas, 0, 0);

      leftPage.dataset.baseWidth = String(renderInfo.width);
      leftPage.dataset.baseHeight = String(renderInfo.height);
      rightPage.dataset.baseWidth = String(renderInfo.width);
      rightPage.dataset.baseHeight = String(renderInfo.height);
      applyZoomToPage(leftPage, currentZoom);
      applyZoomToPage(rightPage, currentZoom);

      // 譯文 overlay block:absolute 對齊原 bbox，白底蓋原文字位置
      for (const block of page.blocks) {
        renderOverlayBlock(block, rightOverlay, pageW, pageH, renderInfo.scale,
          { modelOverride, onAfterRetry });
      }
    } catch (err) {
      console.error('[Shinkansen] reader render page failed', i, err);
      leftPage.innerHTML = `<div class="reader-empty">第 ${i + 1} 頁 render 失敗</div>`;
    }
  }

  // 初始化 scroll sync(可由 handle 控制 enable/disable)
  let sync = setupScrollSync(doc, originalCol, translatedCol);
  sync.setEnabled(syncEnabled);

  // 通報初始失敗數量
  emitFailedCount();

  function emitFailedCount() {
    let n = 0;
    for (const p of doc.pages) {
      for (const b of p.blocks) {
        if (TRANSLATABLE_TYPES.has(b.type) && b.translationStatus === 'failed') n++;
      }
    }
    onFailedCountChange(n);
  }

  function onAfterRetry() {
    emitFailedCount();
  }

  return {
    setSyncEnabled(enabled) {
      syncEnabled = !!enabled;
      sync.setEnabled(syncEnabled);
    },
    setZoom(zoom) {
      const z = Math.max(0.5, Math.min(2.0, zoom));
      currentZoom = z;
      for (const el of originalCol.querySelectorAll('.reader-page-original')) {
        applyZoomToPage(el, z);
      }
      for (const el of translatedCol.querySelectorAll('.reader-page-translated')) {
        applyZoomToPage(el, z);
      }
      // page 尺寸變了 → leftBlocks 內 top/bottom 都失效，重建 sync
      sync.destroy();
      sync = setupScrollSync(doc, originalCol, translatedCol);
      sync.setEnabled(syncEnabled);
      return z;
    },
    getZoom() { return currentZoom; },
    async retryAllFailed() {
      // 收集 failed block 跟對應的 overlay container 重 render
      const failed = [];
      for (let i = 0; i < doc.pages.length; i++) {
        const p = doc.pages[i];
        const overlay = translatedCol.querySelectorAll('.reader-translated-overlay')[i];
        for (const b of p.blocks) {
          if (TRANSLATABLE_TYPES.has(b.type) && b.translationStatus === 'failed') {
            failed.push({ block: b, overlay, page: p });
          }
        }
      }
      let success = 0;
      for (const { block, overlay, page } of failed) {
        const oldBtn = overlay.querySelector(`[data-block-id="${block.blockId}"]`);
        if (oldBtn) oldBtn.disabled = true;
        const r = await translateSingleBlock(block, { modelOverride });
        // 移除舊的(不論 failed retry button 或 overlay div)
        if (oldBtn) oldBtn.remove();
        // 重 render(成功變白底譯文，失敗仍是 retry button)
        renderOverlayBlock(block, overlay,
          page.viewport.width, page.viewport.height, READER_RENDER_SCALE,
          { modelOverride, onAfterRetry });
        if (r.ok) success++;
      }
      emitFailedCount();
      return { total: failed.length, success };
    },
    destroy() { sync.destroy(); },
  };
}

// 對 reader-page 套用 zoom：讀 dataset.baseWidth/baseHeight 算 scaled 尺寸
// (canvas CSS width/height 100% 自然跟著縮放，不需改 canvas bitmap 解析度)
function applyZoomToPage(pageEl, zoom) {
  const baseW = parseFloat(pageEl.dataset.baseWidth) || 0;
  const baseH = parseFloat(pageEl.dataset.baseHeight) || 0;
  if (baseW === 0 || baseH === 0) return;
  pageEl.style.width = `${baseW * zoom}px`;
  // 兩欄 page 都用 fixed height(原本 reader-page-translated 用 min-height 是 flow
  // 模式遺跡;overlay 模式下 page 必須 height: ?px,內部 overlay 跟 block 用 % 才能算對)
  pageEl.style.height = `${baseH * zoom}px`;
}

// W5-iter2：譯文 overlay 對齊原 bbox，白底蓋原文字位置(裝飾元素留 canvas)
//
// 不可翻譯 type(table / formula / figure / page-number)→ 不蓋，讓原 canvas 文字 visible
// 翻譯失敗 / pending → 不蓋，讓原文 visible(failed 仍由 canvas 上的原文展示)
//   但 retry 按鈕需要顯示，所以 failed 時放小型 ↻ 在原 bbox 右上角(不蓋原文)
// 已翻 → 蓋白底 + 顯示譯文
function renderOverlayBlock(block, overlay, pageW, pageH, renderScale, opts = {}) {
  if (!TRANSLATABLE_TYPES.has(block.type)) return;
  const [x0, y0, x1, y1] = block.bbox;
  const leftPct = (x0 / pageW) * 100;
  const topPct = (y0 / pageH) * 100;
  const widthPct = ((x1 - x0) / pageW) * 100;
  const heightPct = ((y1 - y0) / pageH) * 100;

  if (block.translation) {
    const div = document.createElement('div');
    div.className = `reader-block reader-block-${block.type}`;
    div.dataset.blockId = block.blockId;
    div.style.left = `${leftPct}%`;
    div.style.top = `${topPct}%`;
    div.style.width = `${widthPct}%`;
    div.style.minHeight = `${heightPct}%`;
    // 字級用原 PDF block.fontSize × renderScale(對齊原版面字級階層；PDF pt → canvas px)
    // 略縮 0.85 讓中文塞進 bbox(中文比英文密)
    const fontPx = Math.max(9, block.fontSize * (renderScale || 1.5) * 0.85);
    div.style.fontSize = `${fontPx}px`;
    div.textContent = block.translation;
    overlay.appendChild(div);
  } else if (block.translationStatus === 'failed') {
    // 失敗：不蓋原文(讓原 canvas 文字 visible)，只在 bbox 右上角放 ↻ 按鈕
    const btn = document.createElement('button');
    btn.className = 'reader-block-retry reader-block-retry-overlay';
    btn.dataset.blockId = block.blockId;
    btn.type = 'button';
    btn.textContent = '↻';
    btn.title = `翻譯失敗：${block.translationError || ''}(點擊重試)`;
    // 放 bbox 右上角(top: top%, right: 100% - (left + width)%)
    btn.style.top = `${topPct}%`;
    btn.style.left = `calc(${leftPct + widthPct}% - 24px)`;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const { modelOverride, onAfterRetry = () => {} } = opts;
      await translateSingleBlock(block, { modelOverride });
      // 重新 render 該 block(成功變蓋白底譯文，失敗仍是 retry 按鈕)
      btn.remove();
      renderOverlayBlock(block, overlay, pageW, pageH, renderScale, opts);
      onAfterRetry();
    });
    overlay.appendChild(btn);
  }
  // pending / cancelled / done 但 translation 為空：不蓋(原文 visible)
}


// ---------- W5 雙向 scroll sync ----------
//
// 設計(W5-iter2 起改用 page-level + 頁內相對 y 比例):
//   - 兩欄 page 高度套同 zoom + baseW/H，所以「左 page X 內相對 y 比例 = 右 page X 內相對 y 比例」
//   - 左 scroll → viewport 中心 y 對應 (pageIdx, ratioInPage) → 右欄計算同 pageIdx
//     的 page offset + ratio × pageHeight → scrollTo 對齊 viewport 中心
//   - 反向同理
//   - scrollSyncSource flag 防迴圈；requestAnimationFrame 節流；250ms 後解鎖
//   - 為什麼不用 block-id 對應(原始 SPEC §17.6.2)：右欄 overlay 模型下，失敗 / 不可
//     翻譯 / pending 的 block 沒 overlay div,querySelector 找不到 → 跨頁時若中間
//     viewport 中心落在這類 block,sync 直接斷掉。page+ratio 不依賴具體 block 存在
//     於兩欄，跨頁 100% 可靠。代價：同頁段落對應有少量偏移，W7 polish 可進細修
function setupScrollSync(doc, leftCol, rightCol) {
  let enabled = true;
  let source = null;
  let resetTimer = null;
  let leftRaf = null;
  let rightRaf = null;

  function findColumnPageAndRatio(col, pageSelector) {
    const center = col.scrollTop + col.clientHeight / 2;
    const pages = col.querySelectorAll(pageSelector);
    if (pages.length === 0) return null;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const top = p.offsetTop;
      const bottom = top + p.clientHeight;
      if (center >= top && center <= bottom) {
        const ratio = p.clientHeight > 0 ? (center - top) / p.clientHeight : 0;
        return { pageIdx: i, ratio };
      }
    }
    // viewport 中心在第一頁之前 / 最後一頁之後 → 取最近的 edge
    const firstTop = pages[0].offsetTop;
    const lastBottom = pages[pages.length - 1].offsetTop + pages[pages.length - 1].clientHeight;
    if (center < firstTop) return { pageIdx: 0, ratio: 0 };
    if (center > lastBottom) return { pageIdx: pages.length - 1, ratio: 1 };
    return null;
  }

  function applyToColumn(col, pageSelector, info) {
    const pages = col.querySelectorAll(pageSelector);
    const target = pages[info.pageIdx];
    if (!target) return;
    const targetCenter = target.offsetTop + target.clientHeight * info.ratio;
    const targetScrollTop = targetCenter - col.clientHeight / 2;
    col.scrollTo({ top: targetScrollTop, behavior: 'auto' });
  }

  function resetSourceAfter() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { source = null; }, SCROLL_SYNC_RESET_MS);
  }

  function onLeftScroll() {
    if (!enabled) return;
    if (source && source !== 'left') return;
    if (leftRaf) return;
    leftRaf = requestAnimationFrame(() => {
      leftRaf = null;
      const info = findColumnPageAndRatio(leftCol, '.reader-page-original');
      if (!info) return;
      source = 'left';
      applyToColumn(rightCol, '.reader-page-translated', info);
      resetSourceAfter();
    });
  }

  function onRightScroll() {
    if (!enabled) return;
    if (source && source !== 'right') return;
    if (rightRaf) return;
    rightRaf = requestAnimationFrame(() => {
      rightRaf = null;
      const info = findColumnPageAndRatio(rightCol, '.reader-page-translated');
      if (!info) return;
      source = 'right';
      applyToColumn(leftCol, '.reader-page-original', info);
      resetSourceAfter();
    });
  }

  leftCol.addEventListener('scroll', onLeftScroll, { passive: true });
  rightCol.addEventListener('scroll', onRightScroll, { passive: true });

  return {
    setEnabled(v) { enabled = !!v; },
    destroy() {
      leftCol.removeEventListener('scroll', onLeftScroll);
      rightCol.removeEventListener('scroll', onRightScroll);
      clearTimeout(resetTimer);
      if (leftRaf) cancelAnimationFrame(leftRaf);
      if (rightRaf) cancelAnimationFrame(rightRaf);
    },
  };
}

/**
 * 把所有翻譯後的 block plainText / translation 整理成純文字輸出(複製譯文用)。
 */
export function buildPlainTextDump(doc) {
  if (!doc) return '';
  const lines = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    lines.push(`=== 第 ${i + 1} 頁 ===`);
    for (const block of page.blocks) {
      const t = block.translation || block.plainText;
      if (!t) continue;
      lines.push(t);
      lines.push('');
    }
  }
  return lines.join('\n');
}
