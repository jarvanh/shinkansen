// reader.js — 雙頁並排閱讀器(W4)
//
// 左欄:逐頁 PDF.js render canvas(完整保留原 PDF 視覺)
// 右欄:逐頁用版面 IR + 譯文重建 HTML,每 block 一個絕對定位 div(以 bbox 比例對齊)
//
// 設計重點(W4-iter2,改用 flow layout):
//   - 左欄保持 PDF.js canvas(原版面)
//   - 右欄改用 flow layout(順序排列,非 absolute):中文比英文密、原 bbox 容不下時
//     會跟 W4-iter1 absolute 版本一樣往下溢出撞到下一段。flow 自動往下流不重疊
//     且可選字。代價:段內位置不嚴格對齊,只「整頁」對齊
//   - 不送翻譯類型(table / formula / figure / page-number)右欄保留原文,加灰底
//   - 翻譯失敗 block 顯示原文 + 紅色虛線下劃線(SPEC §17.6.3)
//   - 字級不再用 PDF pt 換算,改 reader 統一字級基礎(讀者習慣 + 可讀性)

import { renderPageToCanvas } from './pdf-engine.js';

const READER_RENDER_SCALE = 1.5;

const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

/**
 * 渲染雙頁並排閱讀器到指定容器。
 *
 * @param {LayoutDoc} doc                   — analyzeLayout 輸出 + translateDocument 寫回 .translation
 * @param {object}    pdfDoc                — PDF.js PDFDocumentProxy(供左欄 canvas render)
 * @param {HTMLElement} originalCol         — 左欄容器
 * @param {HTMLElement} translatedCol       — 右欄容器
 */
export async function renderReader(doc, pdfDoc, originalCol, translatedCol) {
  // 清空兩欄
  originalCol.innerHTML = '';
  translatedCol.innerHTML = '';

  if (!doc || !pdfDoc) {
    originalCol.innerHTML = '<div class="reader-empty">尚未上傳 PDF</div>';
    translatedCol.innerHTML = '<div class="reader-empty">尚未翻譯</div>';
    return;
  }

  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const pageW = page.viewport.width;
    const pageH = page.viewport.height;

    // 左欄:render canvas
    const leftPage = document.createElement('div');
    leftPage.className = 'reader-page reader-page-original';
    leftPage.dataset.pageIndex = String(i);
    const canvas = document.createElement('canvas');
    leftPage.appendChild(canvas);
    originalCol.appendChild(leftPage);

    // 右欄:譯文 page,先預留結構
    const rightPage = document.createElement('div');
    rightPage.className = 'reader-page reader-page-translated';
    rightPage.dataset.pageIndex = String(i);
    translatedCol.appendChild(rightPage);

    try {
      const renderInfo = await renderPageToCanvas(pdfDoc, i, canvas, READER_RENDER_SCALE);
      // canvas 顯示寬高(scale 後 px),設給 leftPage 讓 layout 不抖
      leftPage.style.width = `${renderInfo.width}px`;
      leftPage.style.height = `${renderInfo.height}px`;
      // 右欄 page 寬度對齊左欄 canvas,高度由 flow content 決定(可比左欄高,讓內容
      // 完整流動不擠壓);整頁對齊靠頁邊界,不靠 block 位置
      rightPage.style.width = `${renderInfo.width}px`;
      rightPage.style.minHeight = `${renderInfo.height}px`;
      rightPage.style.background = '#fff';

      // 譯文 block:flow layout 順序排列,各 block 為段落 div
      for (const block of page.blocks) {
        renderBlock(block, rightPage);
      }
    } catch (err) {
      console.error('[Shinkansen] reader render page failed', i, err);
      leftPage.innerHTML = `<div class="reader-empty">第 ${i + 1} 頁 render 失敗</div>`;
    }
  }
}

function renderBlock(block, container) {
  const div = document.createElement('div');
  div.className = `reader-block reader-block-${block.type}`;
  div.dataset.blockId = block.blockId;

  // 內容:translation 優先;無譯文(失敗 / 不送翻 / pending)顯示原文
  let content;
  if (TRANSLATABLE_TYPES.has(block.type)) {
    if (block.translation) {
      content = block.translation;
    } else if (block.translationStatus === 'failed' || block.translationError) {
      div.classList.add('reader-block-failed');
      div.title = `翻譯失敗:${block.translationError || ''}`;
      content = block.plainText;
    } else {
      // pending / cancelled → 顯示原文不加標記
      content = block.plainText;
    }
  } else {
    // table / formula / figure / page-number:不送翻譯,保留原文
    content = block.plainText;
  }

  div.textContent = content || '';
  container.appendChild(div);
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
