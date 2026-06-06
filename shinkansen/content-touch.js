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
})(window.__SK);
