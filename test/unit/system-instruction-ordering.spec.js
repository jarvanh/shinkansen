// Unit test: systemInstruction 建構順序（v0.71 regression）
//
// 驗證 translateChunk 建構的 effectiveSystem 遵守以下順序：
//   1. 基礎翻譯指令（使用者在設定頁自訂的 systemInstruction）
//   2. 段落分隔規則（若文字含 \n）
//   3. 佔位符規則（若文字含 ⟦⟧）
//   4. 翻譯參考對（若有 referencePairs，「參考資料」放最末）
//
// v0.70 的 bug：術語/參考放在佔位符規則前面，稀釋了 LLM 對佔位符的注意力，
// 導致 ⟦*N⟧ 標記洩漏到譯文裡。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage（gemini.js → logger.js → storage.js 的依賴鏈）──
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// ── Mock fetch：攔截 Gemini API 呼叫，記錄 request body ──────
let capturedBodies = [];
globalThis.fetch = async (_url, options) => {
  capturedBodies.push(JSON.parse(options.body));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '翻譯結果' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
};

const { translateBatch } = await import('../../shinkansen/lib/gemini.js');

const BASE_SYSTEM = '基礎翻譯指令';
const settings = {
  apiKey: 'test-key',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: BASE_SYSTEM,
  },
  maxRetries: 0,
};

// v0.73: 第三參數從 glossary（術語對照表）改為 referencePairs（翻譯參考對）
// 搜尋標記也從「術語對照表」改為「翻譯範例」
const REFERENCE_MARKER = '翻譯範例';

/** 從最近一次 fetch 的 request body 取出 systemInstruction 文字 */
function lastSystemInstruction() {
  return capturedBodies.at(-1).systemInstruction.parts[0].text;
}

test.beforeEach(() => { capturedBodies = []; });

test.describe('systemInstruction 建構順序', () => {
  test('placeholder + referencePairs → placeholder rule before reference', async () => {
    await translateBatch(
      ['Some ⟦0⟧link text⟦/0⟧ here'],
      settings,
      [{ source: 'Einstein was born in Ulm.', target: '愛因斯坦出生於烏爾姆。' }],
    );
    const sys = lastSystemInstruction();

    const phPos = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const refPos = sys.indexOf(REFERENCE_MARKER);
    expect(phPos).toBeGreaterThan(-1);
    expect(refPos).toBeGreaterThan(-1);
    expect(phPos).toBeLessThan(refPos);
  });

  test('newline + referencePairs → newline rule before reference', async () => {
    await translateBatch(
      ['First line\nSecond line'],
      settings,
      [{ source: 'Paris is the capital.', target: '巴黎是首都。' }],
    );
    const sys = lastSystemInstruction();

    const nlPos = sys.indexOf('額外規則（段落分隔）');
    const refPos = sys.indexOf(REFERENCE_MARKER);
    expect(nlPos).toBeGreaterThan(-1);
    expect(refPos).toBeGreaterThan(-1);
    expect(nlPos).toBeLessThan(refPos);
  });

  test('newline + placeholder + referencePairs → base < newline < placeholder < reference', async () => {
    await translateBatch(
      ['Line one\n⟦0⟧link⟦/0⟧ here'],
      settings,
      [{ source: 'Tokyo is vibrant.', target: '東京充滿活力。' }],
    );
    const sys = lastSystemInstruction();

    const basePos = sys.indexOf(BASE_SYSTEM);
    const nlPos   = sys.indexOf('額外規則（段落分隔）');
    const phPos   = sys.indexOf('額外規則（極重要，處理佔位符標記）');
    const refPos  = sys.indexOf(REFERENCE_MARKER);

    expect(basePos).toBe(0);
    expect(nlPos).toBeGreaterThan(basePos);
    expect(phPos).toBeGreaterThan(nlPos);
    expect(refPos).toBeGreaterThan(phPos);
  });

  test('reference pair content embedded in system instruction', async () => {
    await translateBatch(
      ['Some text'],
      settings,
      [
        { source: 'Einstein was a physicist.', target: '愛因斯坦是物理學家。' },
        { source: 'Tokyo is the capital.', target: '東京是首都。' },
      ],
    );
    const sys = lastSystemInstruction();
    // v0.73 格式：原文：{source}\n譯文：{target}
    expect(sys).toContain('原文：Einstein was a physicist.');
    expect(sys).toContain('譯文：愛因斯坦是物理學家。');
    expect(sys).toContain('原文：Tokyo is the capital.');
    expect(sys).toContain('譯文：東京是首都。');
  });

  test('no referencePairs → no reference section', async () => {
    await translateBatch(['Some ⟦0⟧link⟦/0⟧ text'], settings);
    expect(lastSystemInstruction()).not.toContain(REFERENCE_MARKER);
  });

  test('plain text + referencePairs → only base + reference (no extra rules)', async () => {
    await translateBatch(
      ['Simple plain text'],
      settings,
      [{ source: 'AI is powerful.', target: '人工智慧很強大。' }],
    );
    const sys = lastSystemInstruction();
    expect(sys).toContain(BASE_SYSTEM);
    expect(sys).toContain(REFERENCE_MARKER);
    expect(sys).not.toContain('額外規則（段落分隔）');
    expect(sys).not.toContain('額外規則（極重要，處理佔位符標記）');
  });
});
