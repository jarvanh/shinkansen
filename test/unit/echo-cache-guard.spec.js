// Regression: echo-cache-guard（對應 v2.0.52 修的「日文書短感嘆詞永遠不翻」bug）
//
// Bug：模型偶發對批內短句（「えっ？」類感嘆詞）echo 原文不翻，echo 被以
// per-segment tc_ key 寫進快取後,高頻短句在整本書 / 整站每一處命中同一條壞快取,
// 重翻也治不好（真 API probe 實測 gemini-3.5-flash 對新請求 3/3 正確翻「蛤？」——
// 症狀來源是快取,不是模型必然 echo）。
// 修法：cache.setBatch 前過濾「譯文=原文且原文含明確非 target 字系（假名/諺文）」
// 的 segment——結果照樣回給呼叫端顯示,只是不寫快取,下次翻譯自然重試。
// 合法原樣保留（數字 / URL / 英文品牌 / 日文漢字人名）不含這些字系特徵,不受影響。
//
// SANITY 紀錄（已驗證）：暫時把 system-instruction.js isSuspectEchoTranslation
// 改成 `return false` → 「echo 假名感嘆詞」與 filterEchoPairsForCache 過濾斷言 fail
// → 還原 → pass。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  storage: {
    sync:  { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

const {
  isSuspectEchoTranslation,
  filterEchoPairsForCache,
} = await import('../../shinkansen/lib/system-instruction.js');

test.describe('isSuspectEchoTranslation', () => {
  test('zh target:假名感嘆詞 echo → true（本案例）', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「えっ？」', 'zh-TW')).toBe(true);
    expect(isSuspectEchoTranslation('「えっ？」', ' 「えっ？」 ', 'zh-CN')).toBe(true);
  });

  test('zh target:合法原樣保留不誤殺（漢字人名 / 數字 / 英文 / URL）', () => {
    expect(isSuspectEchoTranslation('勝又', '勝又', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('2024', '2024', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('Taylor Swift', 'Taylor Swift', 'zh-TW')).toBe(false);
    expect(isSuspectEchoTranslation('https://example.com/あ', 'https://example.com/あ', 'zh-TW')).toBe(false); // 假名 <2
  });

  test('有翻譯（譯文 ≠ 原文）→ false', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「蛤？」', 'zh-TW')).toBe(false);
  });

  test('ja target:假名 echo 合法（目標就是日文）；諺文 echo 仍算錯', () => {
    expect(isSuspectEchoTranslation('「えっ？」', '「えっ？」', 'ja')).toBe(false);
    expect(isSuspectEchoTranslation('안녕하세요', '안녕하세요', 'ja')).toBe(true);
  });

  test('拉丁 target:CJK echo → true', () => {
    expect(isSuspectEchoTranslation('供品不見了。', '供品不見了。', 'en')).toBe(true);
    expect(isSuspectEchoTranslation('Hello world', 'Hello world', 'en')).toBe(false);
  });
});

test.describe('filterEchoPairsForCache', () => {
  test('echo segment 被剔除,其餘照寫,skipped 計數正確', () => {
    const texts = ['「えっ？」', '「誰かが供え物を食べてしまったの。」', '2024'];
    const translations = ['「えっ？」', '「有人把供品偷吃了。」', '2024'];
    const out = filterEchoPairsForCache(texts, translations, 'zh-TW');
    expect(out.skipped).toBe(1);
    expect(out.texts).toEqual(['「誰かが供え物を食べてしまったの。」', '2024']);
    expect(out.translations).toEqual(['「有人把供品偷吃了。」', '2024']);
  });

  test('falsy translation 跳過但不算 echo skipped', () => {
    const out = filterEchoPairsForCache(['a', 'b'], [null, 'B 譯'], 'zh-TW');
    expect(out.skipped).toBe(0);
    expect(out.texts).toEqual(['b']);
  });
});

test.describe('background.js 三個寫快取點都有接 echo 防護（source 斷言）', () => {
  test('gemini / custom 走 filterEchoPairsForCache,streaming 走 isSuspectEchoTranslation', () => {
    const src = readFileSync(new URL('../../shinkansen/background.js', import.meta.url), 'utf-8');
    // gemini(handleTranslate)+ custom(handleTranslateCustom)各一次 filter 呼叫
    expect((src.match(/filterEchoPairsForCache\(/g) || []).length).toBeGreaterThanOrEqual(2);
    // streaming writable 迴圈逐段判 echo
    expect((src.match(/isSuspectEchoTranslation\(/g) || []).length).toBeGreaterThanOrEqual(1);
    // 防退化:不再存在「未過濾直接 setBatch(missingTexts, fresh」的殘留(Google MT 路徑除外,
    // 該路徑無 LLM echo 問題;它的 setBatch 用 effectiveCacheSuffix 變數名區分)
    expect(src).not.toMatch(/setBatch\(missingTexts, fresh, glossaryKeySuffix\)/);
    expect(src).not.toMatch(/setBatch\(missingTexts, fresh, suffix\)/);
  });
});
