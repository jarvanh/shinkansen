// Unit test: lib/logger.js PERSIST_CATEGORIES 涵蓋 translate(v1.8.56)
//
// 動機:v1.8.55 撈 yt_debug_log 排查「翻譯卡 88 秒」事件,只有 api / rate-limit 類 log
// 被 persist,看不到 translate 主流程的 main flow start / batch start / batch done /
// stream firstChunkOrTimeout 等訊號,診斷盲區明顯。translate 是翻譯流程核心,加進
// PERSIST_CATEGORIES 讓跨 SW 重啟也能查根因。
//
// SANITY 紀錄(2026-05-07):把 PERSIST_CATEGORIES 內 'translate' 拿掉 → 第 #2 條
// fail(yt_debug_log 不含 translate 類)。還原後 pass。
//
// 注意:logger.js 的 persistLog 走 _persistQueue Promise chain,呼叫 debugLog 後
// 必須 await 該 promise 才能讀到 storage(否則拿到空)。本 spec 用 trampoline
// helper 讓 fake browser.storage.local 紀錄寫入次序。
import { test, expect } from '@playwright/test';

// ─── Fake browser.storage.local ─────────────────────────
const fakeStore = {};
let _writeCount = 0;
let _resolveWrites = [];

const fakeBrowser = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return { [key]: fakeStore[key] };
        return { ...fakeStore };
      },
      set: async (obj) => {
        Object.assign(fakeStore, obj);
        _writeCount++;
        for (const r of _resolveWrites.splice(0)) r();
      },
      remove: async (key) => { delete fakeStore[key]; },
    },
  },
};

globalThis.chrome = fakeBrowser;
// 等所有當前 in-flight persist write 完成
async function flushPersistQueue(targetWrites) {
  while (_writeCount < targetWrites) {
    await new Promise(r => _resolveWrites.push(r));
  }
}

// 必須先 mock 再 import
const { debugLog, getPersistedLogs, clearPersistedLogs } = await import('../../shinkansen/lib/logger.js');

test.beforeEach(async () => {
  await clearPersistedLogs();
  _writeCount = 0;
});

test.describe('PERSIST_CATEGORIES routing', () => {
  test('translate 類進 yt_debug_log(v1.8.56 新加)', async () => {
    debugLog('info', 'translate', 'main flow start', { jobsCount: 5 });
    debugLog('info', 'translate', 'batch 1/5 start', { units: 11 });
    await flushPersistQueue(2);

    const logs = await getPersistedLogs();
    expect(logs.length).toBe(2);
    expect(logs[0].category).toBe('translate');
    expect(logs[0].message).toBe('main flow start');
    expect(logs[1].message).toBe('batch 1/5 start');
  });

  test('api / rate-limit / youtube 類仍進 yt_debug_log', async () => {
    debugLog('info', 'api', 'gemini request', { segments: 11 });
    debugLog('warn', 'rate-limit', 'acquire start', {});
    debugLog('info', 'youtube', 'asr boundary', {});
    await flushPersistQueue(3);

    const logs = await getPersistedLogs();
    const cats = logs.map(l => l.category);
    expect(cats).toContain('api');
    expect(cats).toContain('rate-limit');
    expect(cats).toContain('youtube');
  });

  test('cache / spa / system / glossary 類不進 yt_debug_log(只在記憶體 buffer)', async () => {
    debugLog('info', 'cache', 'cache hit', {});
    debugLog('info', 'spa', 'rescan triggered', {});
    debugLog('info', 'system', 'extension started', {});
    debugLog('info', 'glossary', 'extracted', {});
    debugLog('info', 'translate', 'flush trigger', {}); // 觸發一次 persist 寫入(我們等的是這次)

    await flushPersistQueue(1);
    const logs = await getPersistedLogs();
    const cats = logs.map(l => l.category);
    expect(cats).not.toContain('cache');
    expect(cats).not.toContain('spa');
    expect(cats).not.toContain('system');
    expect(cats).not.toContain('glossary');
    expect(cats).toContain('translate');
  });

  test('PERSIST_MAX 100 環形 buffer:超過 100 筆推出舊的', async () => {
    for (let i = 0; i < 105; i++) {
      debugLog('info', 'translate', `entry ${i}`, { i });
    }
    await flushPersistQueue(105);

    const logs = await getPersistedLogs();
    expect(logs.length).toBe(100);
    // 應該保留最新 100 筆(entry 5 ~ entry 104)
    expect(logs[0].message).toBe('entry 5');
    expect(logs[99].message).toBe('entry 104');
  });
});
