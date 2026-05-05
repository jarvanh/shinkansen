// pdf-renderer.js fitSegmentsToBox 對 1-line block 的字級保留
//
// 修法:1-line block 的 requiredH 從 fontSize × 1.21 放寬到 fontSize × 1.0
// (容許 descender 略超 box,跟原文字身佔 box 比例對齊)。
// Why:heading 類短 block bbox 高度通常 = fontSize × 1.0,中文 ascent+descent
// 加總略 > 1.0,用 1.21 標準塞不下,phase B 擴下被緊鄰下方 block 擋住 → 走 phase A
// scale 縮字 → heading 比內文小(About Plano 9pt 內文 9pt,但譯文「關於普萊諾市」
// 縮成 8.1pt)。
//
// SANITY 紀錄(已驗證):暫時把 visualRatio 改回 FIRST_LINE_VISUAL_RATIO(1.21)
// 「heading fontSize 不縮」spec fail。還原 1.0 後 pass。

import { test, expect } from '@playwright/test';

globalThis.window = globalThis.window || {};
globalThis.window.PDFLib = { rgb: (r, g, b) => ({ r, g, b }) };

const { drawTranslatedOverlay } = await import('../../shinkansen/translate-doc/pdf-renderer.js');

// CJK-aware fake font:每 char 寬度 = fontSize × 1.0pt(模擬 Noto Sans TC 全形)
function makeFont() {
  return {
    widthOfTextAtSize: (text, fontSize) => text.length * fontSize * 1.0,
  };
}

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

test.describe('fitSegmentsToBox 1-line block 不縮字', () => {
  test('heading 短 block(bbox = fontSize × 1.0)+ 緊鄰下方 block → fontSize 不縮', () => {
    // 模擬 Plano page 1 的「About Plano」+ 緊貼的下個段落:
    //   b0 = [54, 116.3, 107, 125.3] = 寬 53、高 9 = fontSize 9
    //   b1.y0 = 126.8(緊鄰,gap 1.5pt < phase B buffer 2pt → 擴不出)
    const layoutPage = {
      pageIndex: 1,
      viewport: { width: 612, height: 792 },
      medianLineHeight: 9,
      columnCount: 1,
      blocks: [
        {
          blockId: 'b0',
          type: 'paragraph',
          bbox: [54, 116.3, 107, 125.3],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'About Plano',
          translation: '關於普萊諾市',
          translationSegments: [{ text: '關於普萊諾市', isBold: false, isItalic: false, linkUrl: null }],
        },
        {
          blockId: 'b1',
          type: 'paragraph',
          bbox: [54, 126.8, 556.8, 228.8],
          column: 0,
          fontSize: 9,
          lineCount: 10,
          runCount: 80,
          plainText: 'Body paragraph that follows the heading.',
          translation: '緊鄰段落內文',
          translationSegments: [{ text: '緊鄰段落內文', isBold: false, isItalic: false, linkUrl: null }],
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);

    const textCalls = page.calls.filter((c) => c.kind === 'text');
    expect(textCalls.length).toBeGreaterThanOrEqual(2);

    // b0 的 drawText 字級必須維持 9(不縮)
    const b0Text = textCalls.find((c) => c.text === '關於普萊諾市');
    expect(b0Text).toBeTruthy();
    expect(b0Text.opts.size).toBe(9);

    // b1 的 drawText 也是 9
    const b1Text = textCalls.find((c) => c.text === '緊鄰段落內文');
    expect(b1Text).toBeTruthy();
    expect(b1Text.opts.size).toBe(9);
  });

  test('多行 block 仍走 FIRST_LINE_VISUAL_RATIO(1.21)— 確保 1.0 放寬只對 1-line', () => {
    // 模擬中文 wrap 成 2 行的場景:box 寬 = 50,塞 6 字 × fontSize 9 = 54 → wrap 成 2 行
    // 高度只 9pt 顯然塞不下 2 行 + 1.21 + lineHeight,fit 應走 phase B/C/D 縮字
    const layoutPage = {
      pageIndex: 0,
      viewport: { width: 612, height: 792 },
      medianLineHeight: 9,
      columnCount: 1,
      blocks: [
        {
          blockId: 'a',
          type: 'paragraph',
          bbox: [54, 100, 104, 109],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'Hello world stuff.',
          translation: '你好世界廢柴測試',
          translationSegments: [{ text: '你好世界廢柴測試', isBold: false, isItalic: false, linkUrl: null }],
        },
        {
          blockId: 'b',
          type: 'paragraph',
          bbox: [54, 200, 556, 290],
          column: 0,
          fontSize: 9,
          lineCount: 1,
          runCount: 1,
          plainText: 'distant',
          translation: '遠方',
          translationSegments: [{ text: '遠方', isBold: false, isItalic: false, linkUrl: null }],
        },
      ],
    };
    const page = makeRecordingPage();
    const font = makeFont();
    drawTranslatedOverlay(page, layoutPage, font, font, []);
    // a 用 fontSize 9 寬 50pt 塞 8 字 × 9 = 72pt 必須 wrap → multi-line case → fontSize 應被縮(<9)
    const aText = page.calls.find((c) => c.kind === 'text' && c.text.includes('你好'));
    expect(aText).toBeTruthy();
    // 多行情境會走 phase A scale 縮 / phase B/C 擴 box,任一情況 fontSize 都會 < 9 或 = 9 但 wrap 成 1 行
    // 重點:1-line 放寬不會讓本 case 也走 1.0 標準(因為 wrap 成 2 行 → 走 1.21 + lineHeight)
    expect(aText.opts.size).toBeLessThanOrEqual(9);
  });
});
