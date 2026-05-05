// pdf-renderer.js drawTranslatedOverlay 的 mask 順序保證
//
// 修法:從「mask → drawText 交替 loop」改成「Pass 1 全部 mask → Pass 2 全部 drawText」。
// Why:單階段交替 loop 在 sub-block 緊貼(line gap = 0)時,後一 block 的 mask
// (padding ≈ fontSize × 0.3pt)會蓋住前一 block 已畫的字身底部 → 字尾被切。
// 觸發場景:layout-analyzer narrow-multi-line split 切出的緊貼 sub-block 群
// (聯絡資訊區「姓名 / 職稱 / 部門 / 電話 / email」)。
//
// SANITY 紀錄(已驗證):暫時把 Pass 1 / Pass 2 改回單階段交替 loop,「所有 mask
// 在所有 drawText 之前」spec fail。還原 two-pass 後 pass。

import { test, expect } from '@playwright/test';

// 安裝 window.PDFLib mock(drawTranslatedOverlay 內部 destructure rgb)
globalThis.window = globalThis.window || {};
globalThis.window.PDFLib = {
  rgb: (r, g, b) => ({ r, g, b }),
};

const { drawTranslatedOverlay } = await import('../../shinkansen/translate-doc/pdf-renderer.js');

// fake font:固定每 char 寬度 = fontSize × 0.5pt
function makeFont() {
  return {
    widthOfTextAtSize: (text, fontSize) => text.length * fontSize * 0.5,
  };
}

// 記錄 page.draw* 呼叫順序的 mock
function makeRecordingPage() {
  const calls = [];
  return {
    drawRectangle: (opts) => calls.push({ kind: 'rect', opts }),
    drawText: (text, opts) => calls.push({ kind: 'text', text, opts }),
    drawLine: (opts) => calls.push({ kind: 'line', opts }),
    node: { addAnnot: () => {} },
    calls,
  };
}

// 模擬 6 個緊貼的 sub-block(聯絡資訊區形狀):每行 lineH=11、line gap=0
function makeContactStackLayoutPage() {
  const blocks = [];
  const baseY = 665;
  const lineH = 11;
  const texts = [
    'Person Name',
    'Director',
    'Media Relations',
    'Ph. (555) 123-4567',
    'Mo. (555) 987-6543',
    'press@example.org',
  ];
  for (let i = 0; i < texts.length; i++) {
    const y0 = baseY + i * lineH;
    const y1 = y0 + lineH;
    blocks.push({
      blockId: `b${i}`,
      type: 'paragraph',
      bbox: [54, y0, 142, y1],
      column: 0,
      fontSize: 11,
      lineCount: 1,
      runCount: 1,
      plainText: texts[i],
      translation: `譯文${i}`,
      translationSegments: [{ text: `譯文${i}`, isBold: false, isItalic: false, linkUrl: null }],
    });
  }
  return {
    pageIndex: 0,
    viewport: { width: 612, height: 792 },
    blocks,
    medianLineHeight: lineH,
    columnCount: 1,
  };
}

test.describe('drawTranslatedOverlay mask 順序', () => {
  test('所有 mask drawRectangle 都在所有 drawText 之前(Pass 1 → Pass 2)', () => {
    const layoutPage = makeContactStackLayoutPage();
    const page = makeRecordingPage();
    const font = makeFont();

    drawTranslatedOverlay(page, layoutPage, font, font, []);

    const rectIdx = page.calls.map((c, i) => (c.kind === 'rect' ? i : -1)).filter((i) => i >= 0);
    const textIdx = page.calls.map((c, i) => (c.kind === 'text' ? i : -1)).filter((i) => i >= 0);

    expect(rectIdx.length).toBe(6); // 6 個 block 各畫 1 個白底
    expect(textIdx.length).toBeGreaterThanOrEqual(6); // 至少 6 個 drawText(每 block 1 個 piece)

    const lastRectAt = rectIdx[rectIdx.length - 1];
    const firstTextAt = textIdx[0];
    expect(lastRectAt).toBeLessThan(firstTextAt);
  });

  test('沒 translation 的 block 不畫 mask 也不畫字', () => {
    const layoutPage = makeContactStackLayoutPage();
    layoutPage.blocks[2].translation = ''; // 第三條清空
    layoutPage.blocks[2].translationSegments = [];
    const page = makeRecordingPage();
    const font = makeFont();

    drawTranslatedOverlay(page, layoutPage, font, font, []);
    const rectCount = page.calls.filter((c) => c.kind === 'rect').length;
    const textCount = page.calls.filter((c) => c.kind === 'text').length;
    expect(rectCount).toBe(5);
    expect(textCount).toBeGreaterThanOrEqual(5);
  });

  test('non-translatable type(table)不畫', () => {
    const layoutPage = makeContactStackLayoutPage();
    layoutPage.blocks[1].type = 'table';
    const page = makeRecordingPage();
    const font = makeFont();

    drawTranslatedOverlay(page, layoutPage, font, font, []);
    const rectCount = page.calls.filter((c) => c.kind === 'rect').length;
    expect(rectCount).toBe(5);
  });
});
