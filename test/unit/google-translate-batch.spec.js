// Unit test: lib/google-translate.js（v1.4.0 regression）
//
// 驗證 translateGoogleBatch 的兩條核心行為：
//   (1) SEP 串接：多段文字合成單一 fetch 請求，回應後正確拆回對應數量
//   (2) URL 長度分塊：encodeURIComponent 後超過 5500 chars 的批次自動分多次 fetch
//
// Mock 策略：替換 globalThis.fetch，根據 URL 中的 q= 參數拆 SEP 計算批次內文字數，
// 回傳對應數量的假譯文片段（每段以 SEP 串接）。回傳結構模擬 Google Translate 的
// [[[chunk, ...], ...]] 格式。
//
// 為什麼用 globalThis.fetch 而不是 page.route：google-translate.js 是 ES module，
// 直接呼叫 globalThis.fetch；Node 環境下替換 globalThis.fetch 即可，不需要瀏覽器。
import { test, expect } from '@playwright/test';

const SEP = '\n\u2063\u2063\u2063\n';

// fetch 呼叫紀錄，每測試清空
let fetchCalls = [];

globalThis.fetch = async (url) => {
  fetchCalls.push(url);

  // 從 URL 抽出 q= 後的內容，decode 後依 SEP 拆出原文片段數量
  const match = String(url).match(/[?&]q=([^&]*)/);
  const q = match ? decodeURIComponent(match[1]) : '';
  const sourceParts = q.split(SEP);

  // 假譯文：每段固定為「[ZH] <原文>」，再以 SEP 串成單一字串模擬 Google 的回傳
  const translatedJoined = sourceParts.map(s => `[ZH] ${s}`).join(SEP);

  // Google Translate 回應格式：[[[chunk, source, ...], ...], ...]
  // _fetchTranslate 取 data[0] 中所有陣列的第一個欄位串接
  // 這裡把整段譯文塞進單一 chunk 裡，符合最簡 case。
  return {
    ok: true,
    json: async () => [[[translatedJoined, q, null, null, 1]]],
  };
};

const { translateGoogleBatch } = await import('../../shinkansen/lib/google-translate.js');

test.beforeEach(() => {
  fetchCalls = [];
});

test('translateGoogleBatch: 3 段文字 → 1 次 fetch → 拆回 3 段譯文', async () => {
  const inputs = ['Hello', 'World', 'Goodbye'];
  const { translations, chars } = await translateGoogleBatch(inputs);

  expect(fetchCalls.length).toBe(1);
  expect(translations.length).toBe(3);
  expect(translations[0]).toBe('[ZH] Hello');
  expect(translations[1]).toBe('[ZH] World');
  expect(translations[2]).toBe('[ZH] Goodbye');
  expect(chars).toBe('Hello'.length + 'World'.length + 'Goodbye'.length);
});

test('translateGoogleBatch: 空陣列 → 不發 fetch', async () => {
  const { translations, chars } = await translateGoogleBatch([]);
  expect(fetchCalls.length).toBe(0);
  expect(translations).toEqual([]);
  expect(chars).toBe(0);
});

test('translateGoogleBatch: 長文字超過 URL 上限 → 自動分多次 fetch', async () => {
  // MAX_URL_ENCODED_CHARS = 5500。每段 1500 字 ASCII（encode 後仍 1500），
  // 4 段 = 6000，超過上限 → 應分成至少 2 批
  const long = 'A'.repeat(1500);
  const inputs = [long, long, long, long];
  const { translations } = await translateGoogleBatch(inputs);

  expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
  expect(translations.length).toBe(4);
  // 每段譯文應該都對應到原文（mock 加 [ZH] 前綴後等於原文）
  for (const t of translations) {
    expect(t).toBe(`[ZH] ${long}`);
  }
});

test('translateGoogleBatch: 索引保留正確（多批次 result 依 idx 寫回）', async () => {
  // 用第三個測試的長度結構，但每段給不同前綴以便辨識索引
  const inputs = [
    'A' + 'x'.repeat(1499),
    'B' + 'x'.repeat(1499),
    'C' + 'x'.repeat(1499),
    'D' + 'x'.repeat(1499),
  ];
  const { translations } = await translateGoogleBatch(inputs);

  expect(translations.length).toBe(4);
  expect(translations[0].startsWith('[ZH] A')).toBe(true);
  expect(translations[1].startsWith('[ZH] B')).toBe(true);
  expect(translations[2].startsWith('[ZH] C')).toBe(true);
  expect(translations[3].startsWith('[ZH] D')).toBe(true);
});

// v1.8.61: targetLanguage 必須帶進 URL 的 tl= 參數（之前寫死 zh-TW,
// 導致 zh-CN / en / ja 等其他 target 都翻成繁中)。
test('translateGoogleBatch: 預設不帶 target → URL tl=zh-TW', async () => {
  await translateGoogleBatch(['Hello']);
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(tlMatch).not.toBeNull();
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-TW');
});

test('translateGoogleBatch: target=ja → URL tl=ja', async () => {
  await translateGoogleBatch(['Hello'], 'ja');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('ja');
});

test('translateGoogleBatch: target=zh-CN → URL tl=zh-CN', async () => {
  await translateGoogleBatch(['Hello'], 'zh-CN');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-CN');
});

test('translateGoogleBatch: 不認得的 target → fallback tl=zh-TW', async () => {
  await translateGoogleBatch(['Hello'], 'xx-YY');
  expect(fetchCalls.length).toBe(1);
  const tlMatch = String(fetchCalls[0]).match(/[?&]tl=([^&]*)/);
  expect(decodeURIComponent(tlMatch[1])).toBe('zh-TW');
});

// v1.9.5: per-unit retry on echo —— Google MT 對某些 batch 會把 unit 原樣回傳,
// 整批跑完後逐筆 retry 補救。下面 3 條測試覆蓋此邏輯。
//
// fetch mock 策略:用 callCount 區分「initial batch」(callCount=1) vs「retry singleton」
// (callCount=2+),initial 對指定 unit 回傳 source 不變(echo),retry 走真翻譯。
// 透過 try/finally 還原 globalThis.fetch 避免污染後續測試。

test('translateGoogleBatch: 批次內某 unit 被 echo 原文 → 觸發 per-unit retry → 救回譯文', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    callCount++;
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);

    if (callCount === 1) {
      // initial batch:"Echo me" 原文 echo,其他段正常翻
      const translatedParts = sourceParts.map(s =>
        s === 'Echo me' ? s : `[ZH] ${s}`
      );
      const joined = translatedParts.join(SEP);
      return { ok: true, json: async () => [[[joined, q]]] };
    }
    // retry:單筆送進來真翻
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] };
  };

  try {
    const inputs = ['Hello', 'Echo me', 'World'];
    const { translations } = await translateGoogleBatch(inputs);

    // 1 initial + 1 retry(只有 "Echo me" 需 retry)
    expect(fetchCalls.length).toBe(2);
    expect(translations[0]).toBe('[ZH] Hello');
    expect(translations[1]).toBe('[ZH] Echo me'); // 救回
    expect(translations[2]).toBe('[ZH] World');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translateGoogleBatch: 整批全 echo → 全部逐筆 retry', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    callCount++;
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';

    if (callCount === 1) {
      // initial:整批 echo
      return { ok: true, json: async () => [[[q, q]]] };
    }
    return { ok: true, json: async () => [[[`[ZH] ${q}`, q]]] };
  };

  try {
    const inputs = ['A', 'B', 'C'];
    const { translations } = await translateGoogleBatch(inputs);

    // 1 initial + 3 retry(每段都需 retry)
    expect(fetchCalls.length).toBe(4);
    expect(translations).toEqual(['[ZH] A', '[ZH] B', '[ZH] C']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translateGoogleBatch: retry 仍 echo(genuinely already in target)→ 維持 echo 值,不阻擋整批', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const match = String(url).match(/[?&]q=([^&]*)/);
    const q = match ? decodeURIComponent(match[1]) : '';
    const sourceParts = q.split(SEP);
    // initial AND retry 都 echo(任何 fetch 都回 source 不變)
    const translated = sourceParts.map(s => s).join(SEP);
    return { ok: true, json: async () => [[[translated, q]]] };
  };

  try {
    const inputs = ['已是繁中一', '已是繁中二'];
    const { translations } = await translateGoogleBatch(inputs);

    // initial(1)+ retry 2 筆(2)= 3
    expect(fetchCalls.length).toBe(3);
    // retry 仍 echo → 結果維持原 echo 值,不 throw、不阻擋整批
    expect(translations).toEqual(['已是繁中一', '已是繁中二']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// SANITY check（手動驗證紀錄，已在 Claude Code 端跑過）：
//   把 google-translate.js line 33 的條件 `cur.length > 0 && curEncodedLen + eLen > MAX_URL_ENCODED_CHARS`
//   改為 `false`（永不切批），第三條測試 fetchCalls.length 會降為 1，斷言 fail。
//   還原後 pass。已驗證。
//
// v1.8.61 SANITY check：
//   把 google-translate.js 的 `tl=${encodeURIComponent(tl)}` 改回 `tl=zh-TW` 寫死,
//   "target=ja" / "target=zh-CN" / "fallback" 三條測試會 fail(實際 tl 都是 zh-TW)。
//   還原後 4 條 target language 測試全 pass。已驗證。
//
// v1.9.5 SANITY check(per-unit retry):
//   把 google-translate.js translateGoogleBatch 內整段 `if (needsRetry.length > 0) { ... }`
//   區塊註解掉(讓 echo 直接寫回 result 不 retry)→
//   「批次內某 unit 被 echo 原文」測試 fetchCalls 從 2 降到 1、translations[1] 變成 'Echo me'(沒救回),
//   「整批全 echo」測試 fetchCalls 從 4 降到 1、translations 全為原文,
//   「retry 仍 echo」測試 fetchCalls 從 3 降到 1。
//   還原後 3 條全 pass。已驗證。
