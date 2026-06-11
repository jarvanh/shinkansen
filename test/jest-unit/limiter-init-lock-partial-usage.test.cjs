'use strict';

/**
 * v1.10.46 批次 2-3 / 2-5(code review 2026-06-11):background.js 兩條可靠性修復。
 *
 * 2-3: initLimiter 必須有單一 in-flight promise lock。
 *   原本 module top-level fire-and-forget + handler 內 `if (!limiter) await initLimiter()`
 *   在 SW 冷啟動並發兩個翻譯請求時會跑兩次 init,各自 new RateLimiter——後完成者用
 *   空視窗覆蓋前者已記帳的 RPM/TPM sliding window,限流形同重置。
 *
 * 2-5(background 半邊): handleTranslate 的 translateBatch 呼叫必須包 try/catch,
 *   catch 內用 err.usage(gemini.js 掛上的已付費累積 usage)直接寫 usage-db
 *   (partialFailure: true)再 rethrow——content 端收到 error 不會發 LOG_USAGE,
 *   不在這裡記就永遠漏帳。gemini.js 半邊(err.usage 附掛)由
 *   test/unit/gemini-partial-usage-on-error.spec.js 行為級驗證。
 *
 * 為什麼是 source 斷言而非行為測試(訊號層次,CLAUDE.md 工作流原則 §3;
 * 同 cache-key-stream-mismatch.test.cjs / alarm-dispatcher.test.cjs 前例):
 *   background.js 是 ES module,top-level 大量 side effect + 依賴 browser global,
 *   jest cjs 環境無法 representatively 載入整個 SW;initLimiter / handleTranslate
 *   皆非 export。本 spec 鎖「結構性事實」,不鎖「並發場景下 limiter 視窗真的不被
 *   覆蓋」「usage-db 真的寫入成功」——那要真 SW 環境。
 *
 * SANITY 紀錄(已驗證,2026-06-11):
 *   - 暫時把 initLimiter 開頭 `if (_limiterInitPromise) return _limiterInitPromise;`
 *     拿掉 → 2-3 lock 斷言 fail;還原 → pass
 *   - 暫時把 handleTranslate catch 內 `partialFailure: true` 改名 → 2-5 斷言 fail;
 *     還原 → pass
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../shinkansen/background.js'),
  'utf-8'
);

describe('2-3: initLimiter 單一 in-flight promise lock', () => {
  test('initLimiter 開頭有 `if (_limiterInitPromise) return _limiterInitPromise`', () => {
    expect(SRC).toMatch(
      /function initLimiter\(\) \{\s*\n\s*if \(_limiterInitPromise\) return _limiterInitPromise;/
    );
  });

  test('全檔只有 initLimiter 內一處 `new RateLimiter(`(不得有繞過 lock 的直接 new)', () => {
    const matches = SRC.match(/new RateLimiter\(/g) || [];
    expect(matches.length).toBe(1);
  });

  test('init 失敗時 reset lock(`_limiterInitPromise = null`)讓下次重試', () => {
    expect(SRC).toMatch(
      /_limiterInitPromise\.catch\(\(\) => \{ _limiterInitPromise = null; \}\);/
    );
  });

  test('storage.onChanged 的 limiter 為 null 分支走 initLimiter(不直接 new)', () => {
    // 「else { ... initLimiter().catch ... }」結構存在
    expect(SRC).toMatch(/\} else \{[\s\S]{0,300}?initLimiter\(\)\.catch\(\(\) => \{\}\);/);
  });
});

describe('2-5: translateBatch 中途失敗的已付費 usage 在 background 記帳', () => {
  test('handleTranslate 的 translateBatch 呼叫包在 try/catch 內', () => {
    expect(SRC).toMatch(
      /res = await translateBatch\(missingTexts, effectiveSettings, glossary, fixedGlossaryEntries, forbiddenTermsList\);\s*\n\s*\} catch \(err\)/
    );
  });

  test('catch 內讀 err.usage 並以 partialFailure: true 寫 usageDB.logTranslation', () => {
    const catchStart = SRC.indexOf('const partialUsage = err?.usage;');
    expect(catchStart).toBeGreaterThan(-1);
    const block = SRC.slice(catchStart, catchStart + 2500);
    expect(block).toMatch(/usageDB\.logTranslation\(\{/);
    expect(block).toMatch(/partialFailure: true/);
    expect(block).toMatch(/computeBilledCostUSD\(/);
  });

  test('記完帳仍 rethrow 原錯誤(不吞 error)', () => {
    const catchStart = SRC.indexOf('const partialUsage = err?.usage;');
    const block = SRC.slice(catchStart, catchStart + 3000);
    expect(block).toMatch(/\n\s+throw err;/);
  });
});
