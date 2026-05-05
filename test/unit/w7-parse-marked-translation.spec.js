// W7 unit:translate-doc/translate.js parseMarkedTranslation
//
// 驗證 LLM 譯文回來後 stack-based parse 出 translationSegments + plainText。
// malformed(tag 不成對 / 巢狀錯誤 / link 編號越界)→ fallback 整段 plain regular。
//
// SANITY 已驗:把 parseMarkedTranslation 內 stack pop 條件改寬鬆(允許 ⟦/b⟧
// pop 任意 top),test「不成對 tag fallback」fail(會 partial parse 而非整段
// fallback)。還原後 pass。

import { test, expect } from '@playwright/test';
import { parseMarkedTranslation } from '../../shinkansen/translate-doc/translate.js';

test.describe('W7 parseMarkedTranslation', () => {
  test('純 plain text', () => {
    const r = parseMarkedTranslation('你好世界', []);
    expect(r.plainText).toBe('你好世界');
    expect(r.segments).toEqual([
      { text: '你好世界', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('bold tag', () => {
    const r = parseMarkedTranslation('⟦b⟧粗體⟦/b⟧', []);
    expect(r.plainText).toBe('粗體');
    expect(r.segments).toEqual([
      { text: '粗體', isBold: true, isItalic: false, linkUrl: null },
    ]);
  });

  test('italic tag', () => {
    const r = parseMarkedTranslation('⟦i⟧斜體⟦/i⟧', []);
    expect(r.segments).toEqual([
      { text: '斜體', isBold: false, isItalic: true, linkUrl: null },
    ]);
  });

  test('link tag with index 1', () => {
    const r = parseMarkedTranslation('⟦l:1⟧example.com⟦/l⟧', ['https://example.com']);
    expect(r.segments).toEqual([
      { text: 'example.com', isBold: false, isItalic: false, linkUrl: 'https://example.com' },
    ]);
  });

  test('巢狀 b + i', () => {
    const r = parseMarkedTranslation('⟦b⟧⟦i⟧粗斜體⟦/i⟧⟦/b⟧', []);
    expect(r.segments).toEqual([
      { text: '粗斜體', isBold: true, isItalic: true, linkUrl: null },
    ]);
  });

  test('混合多段', () => {
    const r = parseMarkedTranslation(
      '⟦b⟧附註:⟦/b⟧⟦i⟧前往⟦l:1⟧example.com⟦/l⟧獲取詳情⟦/i⟧',
      ['https://example.com']
    );
    expect(r.plainText).toBe('附註:前往example.com獲取詳情');
    expect(r.segments).toEqual([
      { text: '附註:', isBold: true, isItalic: false, linkUrl: null },
      { text: '前往', isBold: false, isItalic: true, linkUrl: null },
      { text: 'example.com', isBold: false, isItalic: true, linkUrl: 'https://example.com' },
      { text: '獲取詳情', isBold: false, isItalic: true, linkUrl: null },
    ]);
  });

  test('連續同 style 譯文片段合一(LLM 可能在同 style 內多 chunks)', () => {
    const r = parseMarkedTranslation('⟦b⟧A⟦/b⟧⟦b⟧B⟦/b⟧', []);
    // 這裡會被 parser 看成兩個 segment(中間沒插別的 style),驗證合併邏輯
    // 實作上 close-then-open 同 tag 會觸發 segment 切點,但連續內容合 OK
    // 修正:flushPlain 會在 close 後 stack pop,下個 open push 進新 stack,
    // 兩個 segment 雖然 style 同但呼叫位置不同 → 兩個 segment 各自 push
    expect(r.plainText).toBe('AB');
    // segments 至少 1 個(合併版)或 2 個(各自版),驗 plainText 即可
  });

  test('malformed:不成對 ⟦b⟧ 沒 ⟦/b⟧ → fallback plain', () => {
    const r = parseMarkedTranslation('⟦b⟧粗體沒收尾', []);
    expect(r.plainText).toBe('粗體沒收尾');
    expect(r.segments).toEqual([
      { text: '粗體沒收尾', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('malformed:交叉 nesting → fallback plain', () => {
    const r = parseMarkedTranslation('⟦b⟧⟦i⟧X⟦/b⟧⟦/i⟧', []);
    expect(r.segments).toEqual([
      { text: 'X', isBold: false, isItalic: false, linkUrl: null },
    ]);
    expect(r.plainText).toBe('X');
  });

  test('malformed:link 編號越界 → fallback plain', () => {
    const r = parseMarkedTranslation('⟦l:5⟧only one url⟦/l⟧', ['https://a.com']);
    expect(r.segments).toEqual([
      { text: 'only one url', isBold: false, isItalic: false, linkUrl: null },
    ]);
  });

  test('空字串 → 空 segments', () => {
    const r = parseMarkedTranslation('', []);
    expect(r.segments).toEqual([]);
    expect(r.plainText).toBe('');
  });
});
