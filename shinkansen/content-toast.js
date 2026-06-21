// content-toast.js — Shinkansen Toast 提示系統
// Shadow DOM 隔離的 Toast UI，提供翻譯進度、成功/失敗/還原提示。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）
  // ─── Toast 提示 （Shadow DOM 隔離） ─────────────────────
  const toastHost = document.createElement('div');
  toastHost.id = 'shinkansen-toast-host';
  // host 改成「覆蓋 visual viewport 的定位容器」:position:fixed + 由 JS 依
  // window.visualViewport 同步 left/top/width/height(見下方 syncViewportBox)。
  // 內層 .toast 改用 position:absolute 錨在這個容器上,bottom/right 24px 就會貼齊
  // visual viewport 的可見邊角,而不是 layout viewport ——修 iOS Safari fixed 元素
  // 在捲動 / 網址列收合 / 雙指縮放後跑到可見區外、toast 看不到的問題。
  // pointer-events:none 讓覆蓋全螢幕的 host 不攔頁面點擊(只有 .toast 設 auto)。
  toastHost.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .toast {
        /* absolute 錨在 host(host 由 JS 同步成 visual viewport 大小);host 為
           pointer-events:none,toast 自己要設回 auto 才能點關閉 / action 按鈕。 */
        position: absolute;
        pointer-events: auto;
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
      /* v1.8.7 / v1.8.8: action button（節省模式翻完後「翻譯剩餘段落」按鈕用）
         配色對齊 toast 白底深字風格 + 既有進度條品牌藍 #0071e3 */
      .toast-action {
        display: inline-block;
        margin-top: 8px;
        background: #0071e3;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s ease;
      }
      .toast-action:hover { background: #0058b8; }
      .toast-action:active { background: #004a99; }
      .toast-action[hidden] { display: none; }
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
      <button class="toast-action" id="toast-action" type="button" hidden></button>
      <div class="bar"><div class="bar-fill" id="fill"></div></div>
    </div>
  `;
  document.documentElement.appendChild(toastHost);

  // ─── visual viewport 同步（iOS Safari fixed 元素定位修正） ───────────────
  // 把 host 的 fixed 方框同步成 window.visualViewport 的可見矩形。iOS Safari 的
  // fixed 元素相對 layout viewport 定位、不跟 visual viewport 走,捲動 / 網址列
  // 收合 / 雙指縮放後 toast 會被定位到可見區外。內層 .toast 是 absolute,所以
  // host 對齊到 visual viewport,toast 的 bottom/right 24px 就永遠貼齊可見邊角。
  // 桌面瀏覽器 offsetLeft/Top 為 0、width/height ≈ innerWidth/Height,結果與
  // 原本 fixed bottom-right 視覺一致(host pointer-events:none 不影響點擊)。
  function syncViewportBox() {
    const vv = window.visualViewport;
    if (vv) {
      toastHost.style.left = vv.offsetLeft + 'px';
      toastHost.style.top = vv.offsetTop + 'px';
      toastHost.style.width = vv.width + 'px';
      toastHost.style.height = vv.height + 'px';
    } else {
      // 無 visualViewport API 的舊環境:退回覆蓋整個 layout viewport
      toastHost.style.left = '0px';
      toastHost.style.top = '0px';
      toastHost.style.width = '100%';
      toastHost.style.height = '100%';
    }
  }
  syncViewportBox();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportBox);
    window.visualViewport.addEventListener('scroll', syncViewportBox);
  }
  // 沒有 visualViewport 的環境靠 window resize 兜底;有 visualViewport 時這條也無害
  window.addEventListener('resize', syncViewportBox);

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
  // v1.6.8: Toast master switch — false 時 SK.showToast 入口直接 return
  let showProgressToast = true;

  browser.storage.sync.get(['toastOpacity', 'toastPosition', 'toastAutoHide', 'showProgressToast']).then((s) => {
    applyToastOpacity(s.toastOpacity);
    applyToastPosition(s.toastPosition);
    if (typeof s.toastAutoHide === 'boolean') toastAutoHide = s.toastAutoHide;
    if (typeof s.showProgressToast === 'boolean') showProgressToast = s.showProgressToast;
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
    if (area === 'sync' && changes.showProgressToast) {
      showProgressToast = changes.showProgressToast.newValue ?? true;
      // 切到 false 即時隱藏目前 toast（不等下一次 showToast 觸發）
      if (!showProgressToast && SK.hideToast) SK.hideToast();
    }
  });

  const toastEl = shadow.getElementById('toast');
  const toastMsgEl = shadow.getElementById('msg');
  const toastDetailEl = shadow.getElementById('detail');
  // v1.8.7: action button(opts.action = { label, onClick })
  const toastActionEl = shadow.getElementById('toast-action');
  let toastActionHandler = null;
  toastActionEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof toastActionHandler === 'function') {
      try { toastActionHandler(); } catch (err) { /* swallow */ }
    }
  });
  // v1.6.1: 更新提示元素 — showToast 用 opts.updateNotice 觸發；點擊「下載」連結
  // 與「×」都會送 UPDATE_NOTICE_DISMISSED 訊息標記今天已顯示，達成每日節流。
  const updateNoticeEl = shadow.getElementById('update-notice');
  const updateNoticeLink = shadow.getElementById('un-link');
  const updateNoticeDismiss = shadow.getElementById('un-dismiss');
  function dismissUpdateNotice() {
    updateNoticeEl.hidden = true;
    try { SK.safeSendMessage({ type: 'UPDATE_NOTICE_DISMISSED' }).catch(() => {}); }
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
    try { SK.safeSendMessage({ type: 'WELCOME_NOTICE_TOAST_SHOWN' }).catch(() => {}); }
    catch { /* runtime context invalidated when extension reload */ }
  }
  welcomeNoticeDismiss.addEventListener('click', (e) => { e.preventDefault(); dismissWelcomeNotice(); });
  const toastTimerEl = shadow.getElementById('timer');
  const toastFillEl = shadow.getElementById('fill');
  const toastCloseBtn = shadow.getElementById('close');
  toastCloseBtn.addEventListener('click', () => SK.hideToast());
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
    if (s < 60) return SK.t('toast.elapsedSec', { s });
    const m = Math.floor(s / 60);
    return SK.t('toast.elapsedMinSec', { m, s: s % 60 });
  };

  SK.formatTokens = function formatTokens(n) {
    return n.toLocaleString('en-US');
  };

  // 金額格式化走 lib/format-currency.js UMD 單一來源（manifest 在 content-toast.js 前載入），
  // 不在這裡重複定義 formatUSD / formatTWD，也不再硬編 31.6。
  const _F = window.__SKFormat;
  SK.formatUSD = _F.formatUSD;
  SK.formatTWD = _F.formatTWD;

  // v1.8.41：依 SK.currencyState 自動選擇 USD / TWD 顯示。
  // currencyState 由 content.js 從 storage 讀進來注入（預設 fallback 在這保險）。
  SK.formatMoney = function formatMoney(usd) {
    return _F.formatMoney(usd, SK.currencyState || { currency: 'TWD', rate: _F.FALLBACK_USD_TWD_RATE });
  };

  // 預設值——content.js init 時會用真實值覆蓋
  SK.currencyState = SK.currencyState || { currency: 'TWD', rate: _F.FALLBACK_USD_TWD_RATE };

  /**
   * kind: 'loading' | 'success' | 'error'
   * opts: { progress?, startTimer?, stopTimer?, autoHideMs?, detail?, mismatch? }
   */
  // v1.6.8: master switch 查詢函式，與 SK.shouldDisableInFrame 同 pattern
  // 暴露給呼叫端（例如未來 content.js fast-path 跳過 buildToastOptions）與 regression spec 用
  SK.shouldShowToast = function shouldShowToast() {
    return showProgressToast;
  };

  SK.showToast = function showToast(kind, msg, opts = {}) {
    // v1.6.8: master switch 關閉時完全不顯示（不渲染 DOM、不發訊息）
    if (!SK.shouldShowToast()) return;
    // tooltip 走 dict——模板在模組載入時建立（當時 uiLanguage 尚未就緒），改成每次顯示時刷新
    toastCloseBtn.title = SK.t('toast.close');
    updateNoticeDismiss.title = SK.t('toast.dismissToday');
    welcomeNoticeDismiss.title = SK.t('toast.dismissToday');
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

    // v1.8.7: action button — opts.action = { label, onClick }
    if (opts.action && opts.action.label) {
      toastActionEl.textContent = opts.action.label;
      toastActionEl.hidden = false;
      toastActionHandler = opts.action.onClick;
    } else {
      toastActionEl.hidden = true;
      toastActionEl.textContent = '';
      toastActionHandler = null;
    }

    // v1.6.1: 更新提示——僅在 success toast 且呼叫端有判斷今日尚未顯示時傳入
    if (opts.updateNotice && opts.updateNotice.version && opts.updateNotice.releaseUrl) {
      updateNoticeLink.textContent = SK.t('toast.updateNoticeLink', { version: opts.updateNotice.version });
      updateNoticeLink.href = opts.updateNotice.releaseUrl;
      updateNoticeEl.hidden = false;
    } else {
      updateNoticeEl.hidden = true;
    }

    // v1.6.5: welcome notice（CWS 剛升級提示，每日節流由呼叫端判斷）
    if (opts.welcomeNotice && opts.welcomeNotice.version) {
      // AMO source review: 靜態 template，內嵌的 version 來自 manifest 自己的 version 欄位
      // （本 extension 寫進 storage 後再讀回），格式為 semver 字串（已被 manifest 驗證），無 user input。
      welcomeNoticeMsg.innerHTML = SK.t('toast.welcomeNotice.html', { version: opts.welcomeNotice.version });
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
      toastTimerEl.textContent = SK.t('toast.elapsedSec', { s: 0 });
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

    // v1.8.7: 有 action button 時不 auto-hide，讓使用者有時間決定點按或關閉
    if (kind === 'success' && !opts.autoHideMs && !opts.action) {
      if (toastAutoHide) {
        toastHideHandle = setTimeout(() => {
          toastHideHandle = null;
          SK.hideToast();
        }, 5000);
      }
      setTimeout(() => {
        if (!toastEl.className.includes('show')) return;
        // 防 same-macrotask 連續 showToast(success) leak listener:兩次同步 showToast 各自 schedule
        // 一個 setTimeout(0),先跑的會把 handler1 寫進 toastOutsideHandler 並 addEventListener;
        // 後跑的若直接覆寫,handler1 會留在 document 上直到下次 hideToast 才 remove handler2,
        // handler1 永久 leak。在 add 前先 remove 舊 handler 確保 1:1 對應。
        removeOutsideClickHandler();
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
    // v1.8.7: 清 action button
    toastActionEl.hidden = true;
    toastActionEl.textContent = '';
    toastActionHandler = null;
    clearInterval(toastTickHandle);
    toastTickHandle = null;
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
    removeOutsideClickHandler();
  };

})(window.__SK);
