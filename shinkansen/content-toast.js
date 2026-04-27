// content-toast.js — Shinkansen Toast 提示系統
// Shadow DOM 隔離的 Toast UI，提供翻譯進度、成功/失敗/還原提示。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）
  // ─── Toast 提示 （Shadow DOM 隔離） ─────────────────────
  const toastHost = document.createElement('div');
  toastHost.id = 'shinkansen-toast-host';
  toastHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .toast {
        position: fixed;
        width: 280px;
        padding: 14px 16px 12px 16px;
        background: #ffffff;
        color: #1d1d1f;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.18);
        font: 13px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      .toast.show { display: flex; }
      .toast.pos-bottom-right { bottom: 24px; right: 24px; }
      .toast.pos-bottom-left  { bottom: 24px; left: 24px; }
      .toast.pos-top-right    { top: 24px; right: 24px; }
      .toast.pos-top-left     { top: 24px; left: 24px; }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .msg {
        flex: 1;
        font-weight: 500;
        color: #1d1d1f;
      }
      .detail {
        font-size: 12px;
        color: #6e6e73;
        font-variant-numeric: tabular-nums;
        margin-top: -2px;
        white-space: pre-line;
        line-height: 1.4;
      }
      .detail[hidden] { display: none; }
      /* v1.6.1: 更新提示區塊（成功 toast 偶爾顯示一次，每日節流） */
      .update-notice {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 6px;
        padding: 6px 10px;
        background: #fff8e1;
        border: 1px solid #f5b800;
        border-radius: 6px;
        font-size: 12px;
        color: #2c2a1f;
      }
      .update-notice[hidden] { display: none; }
      /* v1.6.5: welcome notice — CWS 自動更新後翻譯成功 toast 順帶提示一次 */
      .welcome-notice {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 6px;
        padding: 6px 10px;
        background: #ecfdf3;
        border: 1px solid #b6efc9;
        border-radius: 6px;
        font-size: 12px;
        color: #1d3a26;
      }
      .welcome-notice[hidden] { display: none; }
      .welcome-notice strong { color: #117a3e; }
      .welcome-notice .wn-msg { flex: 1; }
      .welcome-notice .wn-dismiss {
        background: none;
        border: 0;
        color: #6e6e73;
        font-size: 11px;
        cursor: pointer;
        padding: 0 4px;
      }
      .welcome-notice .wn-dismiss:hover { color: #1d1d1f; }
      .update-notice .un-link {
        color: #0071e3;
        text-decoration: none;
        font-weight: 500;
      }
      .update-notice .un-link:hover { text-decoration: underline; }
      .update-notice .un-dismiss {
        margin-left: auto;
        background: none;
        border: 0;
        color: #6e6e73;
        font-size: 11px;
        cursor: pointer;
        padding: 0 4px;
      }
      .update-notice .un-dismiss:hover { color: #1d1d1f; }
      .timer {
        font-variant-numeric: tabular-nums;
        color: #86868b;
        font-size: 12px;
      }
      .close {
        cursor: pointer;
        background: none; border: 0;
        font-size: 18px; line-height: 1;
        color: #86868b;
        padding: 0 2px;
      }
      .close:hover { color: #1d1d1f; }
      .bar {
        position: relative;
        height: 4px;
        width: 100%;
        background: #e8e8ed;
        border-radius: 2px;
        overflow: hidden;
      }
      .bar-fill {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 0%;
        background: #0071e3;
        border-radius: 2px;
        transition: width .3s ease;
      }
      .toast.indeterminate .bar-fill {
        width: 30%;
        animation: slide 1.4s ease-in-out infinite;
      }
      @keyframes slide {
        0%   { left: -30%; }
        100% { left: 100%; }
      }
      .toast.success .bar-fill { background: #34c759; width: 100%; }
      .toast.error   .bar-fill { background: #ff3b30; width: 100%; }
      .toast.mismatch .bar-fill {
        background: #ff9500;
        animation: blink-yellow .6s ease-in-out infinite;
      }
      @keyframes blink-yellow {
        0%, 100% { opacity: 1; }
        50%      { opacity: .4; }
      }
    </style>
    <div class="toast" id="toast">
      <div class="row">
        <span class="msg" id="msg">翻譯中…</span>
        <span class="timer" id="timer"></span>
        <button class="close" id="close" title="關閉">×</button>
      </div>
      <div class="detail" id="detail" hidden></div>
      <div class="update-notice" id="update-notice" hidden>
        <span>📦</span>
        <a class="un-link" id="un-link" href="#" target="_blank" rel="noopener"></a>
        <button class="un-dismiss" id="un-dismiss" type="button" title="今天不再提示">×</button>
      </div>
      <div class="welcome-notice" id="welcome-notice" hidden>
        <span>🎉</span>
        <span class="wn-msg" id="wn-msg"></span>
        <button class="wn-dismiss" id="wn-dismiss" type="button" title="今天不再提示">×</button>
      </div>
      <div class="bar"><div class="bar-fill" id="fill"></div></div>
    </div>
  `;
  document.documentElement.appendChild(toastHost);

  // Toast 透明度
  function applyToastOpacity(opacity) {
    toastHost.style.opacity = Math.max(0.1, Math.min(1, opacity ?? 0.7));
  }

  // Toast 位置
  const VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  let currentToastPosition = 'bottom-right';
  function applyToastPosition(pos) {
    const toastInner = shadow.getElementById('toast');
    if (!toastInner) return;
    const p = VALID_POSITIONS.includes(pos) ? pos : 'bottom-right';
    currentToastPosition = p;
    toastInner.className = toastInner.className.replace(/\bpos-\S+/g, '').trim() + ' pos-' + p;
  }

  // Toast 自動關閉開關
  let toastAutoHide = true;

  browser.storage.sync.get(['toastOpacity', 'toastPosition', 'toastAutoHide']).then((s) => {
    applyToastOpacity(s.toastOpacity);
    applyToastPosition(s.toastPosition);
    if (typeof s.toastAutoHide === 'boolean') toastAutoHide = s.toastAutoHide;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.toastOpacity) {
      applyToastOpacity(changes.toastOpacity.newValue);
    }
    if (area === 'sync' && changes.toastPosition) {
      applyToastPosition(changes.toastPosition.newValue);
    }
    if (area === 'sync' && changes.toastAutoHide) {
      toastAutoHide = changes.toastAutoHide.newValue ?? true;
    }
  });

  const toastEl = shadow.getElementById('toast');
  const toastMsgEl = shadow.getElementById('msg');
  const toastDetailEl = shadow.getElementById('detail');
  // v1.6.1: 更新提示元素 — showToast 用 opts.updateNotice 觸發；點擊「下載」連結
  // 與「×」都會送 UPDATE_NOTICE_DISMISSED 訊息標記今天已顯示，達成每日節流。
  const updateNoticeEl = shadow.getElementById('update-notice');
  const updateNoticeLink = shadow.getElementById('un-link');
  const updateNoticeDismiss = shadow.getElementById('un-dismiss');
  function dismissUpdateNotice() {
    updateNoticeEl.hidden = true;
    try { browser.runtime.sendMessage({ type: 'UPDATE_NOTICE_DISMISSED' }).catch(() => {}); }
    catch { /* runtime context invalidated when extension reload */ }
  }
  updateNoticeLink.addEventListener('click', dismissUpdateNotice);
  updateNoticeDismiss.addEventListener('click', (e) => { e.preventDefault(); dismissUpdateNotice(); });

  // v1.6.5: welcome notice element + 「×」標記今日已顯示（每日節流）
  const welcomeNoticeEl = shadow.getElementById('welcome-notice');
  const welcomeNoticeMsg = shadow.getElementById('wn-msg');
  const welcomeNoticeDismiss = shadow.getElementById('wn-dismiss');
  function dismissWelcomeNotice() {
    welcomeNoticeEl.hidden = true;
    try { browser.runtime.sendMessage({ type: 'WELCOME_NOTICE_TOAST_SHOWN' }).catch(() => {}); }
    catch { /* runtime context invalidated when extension reload */ }
  }
  welcomeNoticeDismiss.addEventListener('click', (e) => { e.preventDefault(); dismissWelcomeNotice(); });
  const toastTimerEl = shadow.getElementById('timer');
  const toastFillEl = shadow.getElementById('fill');
  shadow.getElementById('close').addEventListener('click', () => SK.hideToast());
  let toastTickHandle = null;
  let toastStartTime = 0;
  let toastHideHandle = null;
  let toastOutsideHandler = null;

  function removeOutsideClickHandler() {
    if (toastOutsideHandler) {
      document.removeEventListener('mousedown', toastOutsideHandler, true);
      toastOutsideHandler = null;
    }
  }

  SK.formatElapsed = function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + (s % 60) + ' 秒';
  };

  SK.formatTokens = function formatTokens(n) {
    return n.toLocaleString('en-US');
  };

  SK.formatUSD = function formatUSD(n) {
    if (!n) return '$0';
    if (n < 0.01)  return '$' + n.toFixed(4);
    if (n < 1)     return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  };

  /**
   * kind: 'loading' | 'success' | 'error'
   * opts: { progress?, startTimer?, stopTimer?, autoHideMs?, detail?, mismatch? }
   */
  SK.showToast = function showToast(kind, msg, opts = {}) {
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
    removeOutsideClickHandler();

    const classes = ['toast', 'show', kind, 'pos-' + currentToastPosition];
    if (kind === 'loading' && opts.progress == null) classes.push('indeterminate');
    if (opts.mismatch) classes.push('mismatch');
    toastEl.className = classes.join(' ');
    toastMsgEl.textContent = msg;

    if (opts.detail) {
      toastDetailEl.textContent = opts.detail;
      toastDetailEl.hidden = false;
    } else {
      toastDetailEl.textContent = '';
      toastDetailEl.hidden = true;
    }

    // v1.6.1: 更新提示——僅在 success toast 且呼叫端有判斷今日尚未顯示時傳入
    if (opts.updateNotice && opts.updateNotice.version && opts.updateNotice.releaseUrl) {
      updateNoticeLink.textContent = `v${opts.updateNotice.version} 可下載 — 點此前往`;
      updateNoticeLink.href = opts.updateNotice.releaseUrl;
      updateNoticeEl.hidden = false;
    } else {
      updateNoticeEl.hidden = true;
    }

    // v1.6.5: welcome notice（CWS 剛升級提示，每日節流由呼叫端判斷）
    if (opts.welcomeNotice && opts.welcomeNotice.version) {
      welcomeNoticeMsg.innerHTML = `<strong>已升級至 v${opts.welcomeNotice.version}</strong> — 點工具列圖示看新功能`;
      welcomeNoticeEl.hidden = false;
    } else {
      welcomeNoticeEl.hidden = true;
    }

    if (opts.progress != null) {
      toastFillEl.style.width = Math.round(opts.progress * 100) + '%';
    } else if (kind === 'success' || kind === 'error') {
      toastFillEl.style.width = '100%';
    } else {
      toastFillEl.style.width = '0%';
    }

    if (opts.startTimer) {
      toastStartTime = Date.now();
      clearInterval(toastTickHandle);
      toastTimerEl.textContent = '0 秒';
      toastTickHandle = setInterval(() => {
        toastTimerEl.textContent = SK.formatElapsed(Date.now() - toastStartTime);
      }, 500);
    }
    if (opts.stopTimer) {
      clearInterval(toastTickHandle);
      toastTickHandle = null;
      if (toastStartTime) {
        toastTimerEl.textContent = SK.formatElapsed(Date.now() - toastStartTime);
      }
    }

    if (opts.autoHideMs) {
      toastHideHandle = setTimeout(() => {
        toastHideHandle = null;
        SK.hideToast();
      }, opts.autoHideMs);
    }

    if (kind === 'success' && !opts.autoHideMs) {
      if (toastAutoHide) {
        toastHideHandle = setTimeout(() => {
          toastHideHandle = null;
          SK.hideToast();
        }, 5000);
      }
      setTimeout(() => {
        if (!toastEl.className.includes('show')) return;
        toastOutsideHandler = (ev) => {
          const path = ev.composedPath ? ev.composedPath() : [];
          if (path.includes(toastHost)) return;
          SK.hideToast();
        };
        document.addEventListener('mousedown', toastOutsideHandler, true);
      }, 0);
    }
  };

  SK.hideToast = function hideToast() {
    toastEl.className = 'toast pos-' + currentToastPosition;
    toastDetailEl.hidden = true;
    clearInterval(toastTickHandle);
    toastTickHandle = null;
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
    removeOutsideClickHandler();
  };

})(window.__SK);
