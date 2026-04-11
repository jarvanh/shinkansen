'use strict';

/**
 * v1.0.23 regression: SPA 續翻模式 (sticky translate)
 *
 * Bug：在 Gmail inbox 翻譯完成後，點進一封 email 不會自動翻譯信件內容；
 *      退出 email 回到 inbox 時，原本翻好的主旨/預覽恢復成英文。
 *
 * 修法：
 *   - 新增 STATE.stickyTranslate — 手動翻譯成功後自動開啟
 *   - hashchange 事件監聽（Gmail 用 hash-based 路由，不走 pushState）
 *   - handleSpaNavigation 中 stickyTranslate 優先於白名單，直接呼叫 translatePage
 *   - restorePage 時關閉 stickyTranslate
 *
 * 這組測試驗證上述四個修法的行為。
 */

const { createEnv } = require('./helpers/create-env.cjs');

describe('v1.0.23: SPA 續翻模式 (sticky translate)', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  test('hashchange + stickyTranslate=true → 觸發 translatePage', async () => {
    env = createEnv({ url: 'https://mail.google.com/mail/u/0/#inbox' });

    // 模擬：使用者已手動翻譯 → translated=true, stickyTranslate=true
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true });

    // 模擬 Gmail hash navigation（使用者點進一封 email）
    env.navigateHash('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKzgfBbGPNjKnGjTdbRMpNBFM');

    // handleSpaNavigation 是 async 函式，內部流程：
    //   1. resetForSpaNavigation()       — 立刻執行
    //   2. await setTimeout(800ms)        — 等 DOM 穩定 (SPA_NAV_SETTLE_MS)
    //   3. if (wasSticky) translatePage() — 因為 sticky=true，呼叫翻譯
    //   4. translatePage() → chrome.storage.sync.get([...]) — 讀取設定
    // 等 1200ms 確保所有 async 操作完成
    await new Promise(r => setTimeout(r, 1200));

    // translatePage 被呼叫的證據：它會去讀 chrome.storage.sync.get 取得 API key 等設定
    expect(env.chrome.storage.sync.get).toHaveBeenCalled();
  });

  test('hashchange + stickyTranslate=false → 不觸發 translatePage（無白名單）', async () => {
    env = createEnv({ url: 'https://mail.google.com/mail/u/0/#inbox' });

    // 翻譯完成但 sticky 模式關閉
    env.shinkansen.setTestState({ translated: true, stickyTranslate: false });

    // 清掉載入時的呼叫記錄，確保斷言精準
    env.chrome.storage.sync.get.mockClear();

    env.navigateHash('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKzgfBbGPNjKnGjTdbRMpNBFM');

    await new Promise(r => setTimeout(r, 1200));

    // handleSpaNavigation 會呼叫 chrome.storage.sync.get('domainRules') 做白名單檢查，
    // 但不會帶 translatePage 專用的 keys（apiKey、model 等）。
    // 我們的 mock 回傳空物件 → 不在白名單 → translatePage 不被呼叫。
    //
    // 驗證：STATE 不會進入 translating 狀態
    const state = env.shinkansen.getState();
    expect(state.translating).toBe(false);
    // resetForSpaNavigation 會把 translated 清掉
    expect(state.translated).toBe(false);
  });

  test('restorePage 關閉 stickyTranslate', async () => {
    env = createEnv({ url: 'https://example.com/' });

    // 建立一段有內容的段落，讓 testInject + restorePage 有東西操作
    const p = env.document.createElement('p');
    p.textContent = 'Hello world this is a long paragraph for testing purposes only.';
    env.document.body.appendChild(p);

    // 注入翻譯 + 開啟 sticky 模式
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true });
    expect(env.shinkansen.getState().stickyTranslate).toBe(true);

    // 透過 Debug Bridge 觸發 restorePage（等同使用者按 Option+S 還原）
    await new Promise(resolve => {
      env.window.addEventListener('shinkansen-debug-response', (e) => {
        resolve(e.detail);
      }, { once: true });
      env.window.dispatchEvent(new env.window.CustomEvent('shinkansen-debug-request', {
        detail: { action: 'RESTORE' },
      }));
    });

    // restorePage 會關閉 stickyTranslate（v1.0.23 修法的一部分）
    expect(env.shinkansen.getState().stickyTranslate).toBe(false);
    // 也會關閉 translated
    expect(env.shinkansen.getState().translated).toBe(false);
  });
});
