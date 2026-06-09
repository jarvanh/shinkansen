// content-touch.js — 四指 tap 觸發翻譯 toggle（iOS / iPadOS Safari 專用）
//
// 設計（SPEC-PRIVATE §26.1）：
// - 四指輕點 = Alt+S 完整 toggle：未翻譯 → 翻譯；翻譯中或已翻譯 → 中止並還原原文
// - 不另開單向分支：偵測到手勢後送 FOUR_FINGER_TAP 給 background，由 background
//   轉發 TRANSLATE_PRESET slot 2（跟 commands onCommand 的 Alt+S 完全同一條路徑，
//   含 all_frames broadcast 行為——避免「手勢」跟「快速鍵」兩條 path drift）
// - 「tap」判定：四指同時落下、任一指移動 < MOVE_TOLERANCE_PX、全部抬起且
//   歷時 < TAP_MAX_MS。四指 swipe / pinch（iPadOS 系統多工手勢）會因移動量
//   超過容差被取消，不誤觸發
// - 本檔列在 manifest 全平台載入（維持 manifest 單一來源 + Playwright 可測）,
//   但 handler 開頭以 IS_IOS_BUILD gate 早退：桌面 build（Chrome / Firefox /
//   macOS Safari）為 no-op，只有 safari-build-ios.sh override 的 iOS build 啟用。
//   桌面觸控螢幕（Windows touch laptop 等）不啟用——四指 tap 在各桌面 OS 另有
//   系統手勢語意，誤觸發風險高
// - 不加 options 開關（avoid redundant toggle 原則，§26.1）
(function (SK) {
  'use strict';
  if (!SK) return;

  const TAP_MAX_MS = 500;        // 落下到全部抬起的最長歷時，超過視為長按 / 手勢
  const MOVE_TOLERANCE_PX = 30;  // 任一指移動超過此距離視為 swipe / pinch，取消

  // 進行中的四指手勢：{ t0, pts: Map<identifier, {x, y}> };null = 無候選手勢
  let gesture = null;

  function isEnabled() {
    // IS_IOS_BUILD 由 lib/distribution-cs.js 寫入（iOS build override 為 true）。
    // 動態讀（不在載入期快照）讓 regression spec 可在 runtime 翻 flag 測手勢邏輯。
    return SK.IS_IOS_BUILD === true;
  }

  window.addEventListener('touchstart', (e) => {
    if (!isEnabled()) return;
    if (e.touches.length === 4) {
      const pts = new Map();
      for (const t of e.touches) pts.set(t.identifier, { x: t.clientX, y: t.clientY });
      gesture = { t0: Date.now(), pts };
    } else if (e.touches.length > 4) {
      // 第五指落下 → 不是四指 tap（iPadOS 五指 pinch 等系統手勢）
      gesture = null;
    }
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', (e) => {
    if (!gesture) return;
    for (const t of e.touches) {
      const start = gesture.pts.get(t.identifier);
      if (!start) continue;
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE_PX) {
        gesture = null; // swipe / pinch，取消候選
        return;
      }
    }
  }, { passive: true, capture: true });

  window.addEventListener('touchend', (e) => {
    if (!gesture) return;
    if (e.touches.length > 0) return; // 還有指頭沒抬起，等下一個 touchend
    const elapsed = Date.now() - gesture.t0;
    gesture = null;
    if (elapsed > TAP_MAX_MS) return;
    SK.sendLog('info', 'system', 'four-finger tap detected', { elapsedMs: elapsed });
    SK.safeSendMessage({ type: 'FOUR_FINGER_TAP' }).catch(() => {});
  }, { passive: true, capture: true });

  window.addEventListener('touchcancel', () => {
    gesture = null;
  }, { passive: true, capture: true });

  // ── iOS background keep-alive（SPEC-PRIVATE §26.14）─────────────────────
  // iOS Safari 的擴充功能 background（即使宣告成 event page）閒置一段時間後會被
  // 系統「永久回收」且叫不醒：sendMessage 叫不醒、開關 Safari 也沒用，只有強制
  // 關閉 Safari 才復活（Apple Developer Forums thread 758346，iOS 17.4 起、迄今
  // 未修；只發生在真機，模擬器 / macOS 不會）。表現為「用一陣子後四指 / popup 按
  // 翻譯失效」——因為四指與 popup 翻譯最後都要送請求給 background 做 API 呼叫。
  //
  // 死後救不回，所以修法不是「死了再救」而是「不讓它睡到被回收」：開一條長連線
  // port + 每 20s ping，讓 background 一直保持非閒置（收訊息會重置系統的閒置計時）。
  // 只在「分頁可見」時 ping（切到背景就斷，省電）；只在 iOS build + top frame 啟用
  // （每個分頁一條 port 就夠，iframe 不重複開）。桌面 build 不啟用——桌面的 SW
  // 生命週期正常，不需要這個 workaround。
  const KEEPALIVE_PORT_NAME = 'shinkansen-keepalive';
  const KEEPALIVE_PING_MS = 20000; // < iOS ~30s 回收窗，留餘裕
  let kaPort = null;
  let kaTimer = null;

  function stopKeepAlive() {
    if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
    if (kaPort) { try { kaPort.disconnect(); } catch (_) {} kaPort = null; }
  }

  function startKeepAlive() {
    if (kaPort || document.hidden) return;        // 已連線 / 分頁不可見 → 不開
    if (!browser.runtime?.id) return;             // context 失效（extension reload 中）
    try {
      kaPort = browser.runtime.connect({ name: KEEPALIVE_PORT_NAME });
    } catch (_) { kaPort = null; return; }
    // background 回 pong → 記錄「背景還活著」（spec 驗 port round-trip；production
    // 不依賴此值，純粹讓自動化測得到真實 content↔background 連線）
    kaPort.onMessage.addListener(() => { SK._keepAliveAlive = true; });
    // 背景被回收 / 重啟 → port 斷。仍可見就重連（context 失效時 startKeepAlive 自會早退，
    // 1s 延遲避免 reload 期間緊迴圈）
    kaPort.onDisconnect.addListener(() => {
      kaPort = null;
      if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
      if (!document.hidden) setTimeout(startKeepAlive, 1000);
    });
    const ping = () => {
      if (!kaPort) return;
      try { kaPort.postMessage({ t: Date.now() }); }
      catch (_) { stopKeepAlive(); if (!document.hidden) setTimeout(startKeepAlive, 1000); }
    };
    ping();                                       // 連線即送首 ping，不等 20s 第一輪
    kaTimer = setInterval(ping, KEEPALIVE_PING_MS);
  }

  // iOS build + top frame 才啟用。動態讀 SK.IS_IOS_BUILD（不在載入期快照），讓
  // regression spec 可 runtime 翻 flag 後手動觸發。
  function maybeStartKeepAlive() {
    if (SK.IS_IOS_BUILD !== true || window !== window.top) return;
    startKeepAlive();
  }
  SK.maybeStartKeepAlive = maybeStartKeepAlive;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopKeepAlive();
    else maybeStartKeepAlive();
  });
  maybeStartKeepAlive();

  // Phase 2（SPEC-PRIVATE §26.12）：頁面載入時請 background 拉一次 host app 設定。
  // host app onboarding / 設定畫面剛存的 API Key + 預設模型寫在 App Group，background
  // 經 native messaging 拉走套用。在「四指 tap 翻譯」之前（頁面載入 → 使用者點，有人為
  // 延遲）就完成套用，避免第一次 tap 還用到舊設定。iOS only（桌面 background 也有
  // IS_IOS_BUILD gate，這裡再 gate 一層省掉桌面的無謂訊息）。distribution-cs.js 在本檔
  // 之前載入，IS_IOS_BUILD 此時已就緒。
  if (SK.IS_IOS_BUILD === true) {
    SK.safeSendMessage({ type: 'PULL_HOST_SETTINGS' });
  }
})(window.__SK);
