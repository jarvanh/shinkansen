// content-floating-icon.js — 懸浮翻譯控制按鈕（floating action button）
//
// 設計（SPEC-PRIVATE §28）：
// - 頁面左／右緣的常駐浮動 icon，用 menu bar「新」icon（icons/icon-128.png 經
//   chrome.runtime.getURL 載入；該檔已列入 manifest web_accessible_resources）。
// - 短按（放開前長按計時器未觸發、未拖移）= popupButtonSlot 對應的預設翻譯，走
//   SK.handleTranslatePreset(slot)。與 popup 工具列按鈕同一份事實（popupButtonSlot）、
//   同一條 path，本身含 toggle：未譯→翻、已譯→還原、翻譯中→中止。
// - 長按（壓住達 LONGPRESS_MS、未拖移）= 跳出三 preset 選單，點任一列 →
//   handleTranslatePreset(該 slot) + 收選單；點選單外 / 捲動 = 收選單。
// - 拖移（pointermove 超過 DRAG_THRESHOLD_PX）= 進入拖移模式，放開時吸附最近的左／右
//   緣，垂直位置存比例（floatingIconPos = { edge, offsetY }），視窗縮放後按比例還原。
// - enable / 透明度 / 尺寸 / 位置走 storage.sync，onChanged 即時生效（比照 content-toast.js）。
//   floatingIcon 預設值：未設過（非 boolean）時一律預設開啟（不分平台），使用者在 options
//   明確設過則尊重該設定。floatingIconSize：icon 邊長 16（預設）/ 32（觸控好點）。
//   長按開選單時暫時拉到全不透明，收起再還原使用者設定的透明度。
// - 比照 toast 用獨立 Shadow DOM host（closed）+ adoptedStyleSheets（CSP-safe），掛在
//   documentElement，不注入文章內容 → 不破壞 Readwise 擷取（CLAUDE.md §15）。
// - 只在 top frame 放一顆（window === window.top）；iframe / SK.disabled / 非 HTML
//   文件（XMLDocument，attachShadow 會 throw）一律早退。
(function (SK) {
  'use strict';
  if (!SK || SK.disabled) return;        // iframe gate（content-ns.js）
  if (window !== window.top) return;     // 只在主 frame 放一顆

  const LONGPRESS_MS = 500;              // 壓住達此毫秒 = 長按 → 開選單；之前放開 = 短按
  const DRAG_THRESHOLD_PX = 8;           // pointer 位移超過此距離 = 進入拖移（取消短按 / 長按）
  const DEFAULT_ICON_SIZE = 16;          // icon 視覺尺寸預設（方形 icon 顯示邊長）；使用者可選 32
  const HIT_PADDING = 16;                // icon 外圍透明可點 padding（觸控好點）
  const EDGE_MARGIN = 6;                 // 吸附邊緣時與視窗邊的間距
  const DEFAULT_OPACITY = 0.7;
  // icon 尺寸為使用者可調（floatingIconSize：16 / 32），故 hitSize 跟著變動（非常數）。
  let iconSize = DEFAULT_ICON_SIZE;      // 目前 icon 邊長
  let hitSize = iconSize + HIT_PADDING;  // 目前按鈕可點 footprint（= icon + 透明 padding）

  // ─── Shadow DOM host（CSP-safe，比照 content-toast.js）──────────────────
  let host, shadow, btn, menuEl;
  try {
    host = document.createElement('div');
    host.id = 'shinkansen-floating-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483600; display: none;';
    shadow = host.attachShadow({ mode: 'closed' });
  } catch (_e) {
    // 非 HTML 文件（XMLDocument 等）attachShadow / style 會 throw → 不放 icon
    return;
  }

  const iconUrl = (() => {
    // icon-48.png = 工具列「新」方形 icon（icon-128.png 是火車商店圖，不是這顆）
    try { return browser.runtime.getURL('icons/icon-48.png'); }
    catch (_e) { return ''; }
  })();

  const CSS = `
    :host, * { box-sizing: border-box; }
    .fab {
      position: relative;
      width: var(--fab-hit, 32px);
      height: var(--fab-hit, 32px);
      border: none;
      padding: 0;
      background: none;            /* 不加圓框 / 白底，直接用工具列方形 icon 本體 */
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      touch-action: none;          /* 自行處理拖移，禁瀏覽器捲動 / 手勢介入 */
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      transition: transform .15s ease, filter .15s ease;
    }
    .fab:active { transform: scale(.92); }
    .fab img {
      width: var(--fab-icon, 16px);
      height: var(--fab-icon, 16px);
      display: block;
      /* drop-shadow 讓 icon 在淺色 / 同色頁面也看得見，但不是圓框 */
      filter: drop-shadow(0 1px 3px rgba(0,0,0,.4));
      pointer-events: none;
      -webkit-user-drag: none;
      user-drag: none;
    }
    .fab.dragging img { filter: drop-shadow(0 4px 10px rgba(0,0,0,.45)); }
    /* 長按選單 */
    .menu {
      position: absolute;
      bottom: 0;
      min-width: 168px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.22);
      padding: 6px;
      display: none;
      flex-direction: column;
      gap: 2px;
      font: 13px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
    }
    .menu.show { display: flex; }
    .menu.side-left  { left: calc(var(--fab-hit, 32px) + 8px); }
    .menu.side-right { right: calc(var(--fab-hit, 32px) + 8px); }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-radius: 8px;
      background: none;
      border: none;
      width: 100%;
      text-align: left;
      color: #1d1d1f;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .menu-item:hover { background: #f0f0f3; }
    .menu-item .slot {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: #0071e3;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .menu-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  `;

  shadow.innerHTML = `
    <button class="fab" id="fab" type="button" aria-label="Shinkansen">
      ${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}
    </button>
    <div class="menu" id="menu" role="menu"></div>
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (_e) {
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    shadow.prepend(styleEl);
  }
  btn = shadow.getElementById('fab');
  menuEl = shadow.getElementById('menu');
  document.documentElement.appendChild(host);

  // ─── 設定狀態 ───────────────────────────────────────────────────────────
  let pos = { edge: 'right', offsetY: 0.5 };   // offsetY = 0(頂)…1(底) 比例
  let currentOpacity = DEFAULT_OPACITY;        // 使用者設定的透明度（選單開啟時暫時拉到 1，關閉還原）

  function resolveEnabled(v) {
    // 未設過（非 boolean）→ 一律預設開啟（不分平台）
    return typeof v === 'boolean' ? v : true;
  }

  function applyEnabled(enabled) {
    host.style.display = enabled ? 'block' : 'none';
    if (!enabled) closeMenu();
  }

  function applyOpacity(v) {
    if (typeof v === 'number') currentOpacity = Math.max(0.1, Math.min(1, v));
    // 選單開啟時保持全不透明，讓使用者看清選單；關閉後才套回使用者設定值
    host.style.opacity = menuOpen ? '1' : String(currentOpacity);
  }

  // floatingIconSize：16 / 32。設 CSS 變數驅動 .fab 與 .fab img 尺寸，並更新 hitSize
  // 供 applyPos / 拖移 clamp 計算。
  function applySize(v) {
    iconSize = v === 32 ? 32 : DEFAULT_ICON_SIZE;
    hitSize = iconSize + HIT_PADDING;
    host.style.setProperty('--fab-icon', iconSize + 'px');
    host.style.setProperty('--fab-hit', hitSize + 'px');
    applyPos(pos);   // 尺寸變了重貼邊，避免超出視窗
  }

  function sanitizePos(p) {
    const edge = (p && (p.edge === 'left' || p.edge === 'right')) ? p.edge : 'right';
    let offsetY = p && typeof p.offsetY === 'number' ? p.offsetY : 0.5;
    if (!(offsetY >= 0 && offsetY <= 1)) offsetY = 0.5;
    return { edge, offsetY };
  }

  // 依 pos 把 host 貼到邊緣（offsetY 比例 → top px）
  function applyPos(p) {
    pos = sanitizePos(p);
    const top = Math.round(pos.offsetY * Math.max(0, window.innerHeight - hitSize));
    host.style.top = top + 'px';
    host.style.bottom = 'auto';
    if (pos.edge === 'left') {
      host.style.left = EDGE_MARGIN + 'px';
      host.style.right = 'auto';
    } else {
      host.style.right = EDGE_MARGIN + 'px';
      host.style.left = 'auto';
    }
    // 選單開口方向：icon 在右緣 → 往左展；在左緣 → 往右展
    menuEl.classList.toggle('side-left', pos.edge === 'left');
    menuEl.classList.toggle('side-right', pos.edge === 'right');
  }

  function persistPos() {
    try { browser.storage.sync.set({ floatingIconPos: pos }); } catch (_e) {}
  }

  // ─── 長按選單 ───────────────────────────────────────────────────────────
  let menuOpen = false;
  let outsideHandler = null;

  function pickPopupSlot(raw) {
    const n = Number(raw);
    return [1, 2, 3].includes(n) ? n : 2;   // 與 lib/storage.js pickPopupSlot 同義（content script 不能 import）
  }

  async function buildMenu() {
    let presets = SK.DEFAULT_PRESETS || [];
    try {
      const { translatePresets } = await browser.storage.sync.get('translatePresets');
      if (Array.isArray(translatePresets) && translatePresets.length > 0) presets = translatePresets;
    } catch (_e) {}
    const ordered = [1, 2, 3].map(slot => presets.find(p => p.slot === slot)).filter(Boolean);
    menuEl.textContent = '';
    for (const p of ordered) {
      const item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.dataset.slot = String(p.slot);
      const slotBadge = document.createElement('span');
      slotBadge.className = 'slot';
      slotBadge.textContent = String(p.slot);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = p.label || p.model || p.engine || ('Preset ' + p.slot);
      item.appendChild(slotBadge);
      item.appendChild(label);
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        runPreset(p.slot);
      });
      menuEl.appendChild(item);
    }
  }

  async function openMenu() {
    if (host.style.display === 'none') return;
    await buildMenu();
    menuEl.classList.add('show');
    menuOpen = true;
    host.style.opacity = '1';   // 選單開啟時拉到全不透明，讓使用者看清選單（task：長按降透明度）
    // 點選單外 / 捲動 → 收
    outsideHandler = (ev) => {
      const path = ev.composedPath ? ev.composedPath() : [];
      if (path.includes(host)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', outsideHandler, true);
    window.addEventListener('scroll', closeMenu, { passive: true, capture: true });
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuEl.classList.remove('show');
    menuOpen = false;
    host.style.opacity = String(currentOpacity);   // 選單收起，還原使用者設定的透明度
    if (outsideHandler) {
      document.removeEventListener('pointerdown', outsideHandler, true);
      outsideHandler = null;
    }
    window.removeEventListener('scroll', closeMenu, true);
  }

  // ─── 翻譯觸發 ───────────────────────────────────────────────────────────
  function runPreset(slot) {
    if (typeof SK.handleTranslatePreset === 'function') {
      SK.handleTranslatePreset(slot);
    }
  }

  async function handleShortPress() {
    let slot = 2;
    try {
      const { popupButtonSlot } = await browser.storage.sync.get('popupButtonSlot');
      slot = pickPopupSlot(popupButtonSlot);
    } catch (_e) {}
    runPreset(slot);
  }

  // ─── pointer 狀態機（短按 / 拖移吸附 / 長按）─────────────────────────────
  let press = null;  // { id, startX, startY, timer, moved, longFired }

  function clearPressTimer() {
    if (press && press.timer) { clearTimeout(press.timer); press.timer = null; }
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;  // 只認主鍵
    e.preventDefault();
    closeMenu();
    try { btn.setPointerCapture(e.pointerId); } catch (_e) {}
    press = { id: e.pointerId, startX: e.clientX, startY: e.clientY, timer: null, moved: false, longFired: false };
    press.timer = setTimeout(() => {
      if (!press || press.moved) return;
      press.longFired = true;
      press.timer = null;
      openMenu();
    }, LONGPRESS_MS);
  });

  btn.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;
    if (!press.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      press.moved = true;
      clearPressTimer();
      closeMenu();
      btn.classList.add('dragging');
    }
    if (press.moved) {
      // 自由跟手（拖移期間），放開再吸附
      const half = hitSize / 2;
      const left = Math.max(0, Math.min(window.innerWidth - hitSize, e.clientX - half));
      const top = Math.max(0, Math.min(window.innerHeight - hitSize, e.clientY - half));
      host.style.left = left + 'px';
      host.style.right = 'auto';
      host.style.top = top + 'px';
      host.style.bottom = 'auto';
    }
  });

  function endPress(e) {
    if (!press || e.pointerId !== press.id) return;
    clearPressTimer();
    try { btn.releasePointerCapture(e.pointerId); } catch (_e) {}
    const { moved, longFired } = press;
    press = null;
    btn.classList.remove('dragging');
    if (moved) {
      // 吸附最近邊緣：pointer 在視窗左半 → 左緣，右半 → 右緣
      const edge = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      const offsetY = Math.max(0, Math.min(1,
        (e.clientY - hitSize / 2) / Math.max(1, window.innerHeight - hitSize)));
      applyPos({ edge, offsetY });
      persistPos();
      return;
    }
    if (longFired) return;        // 長按已開選單，放開不再短按
    handleShortPress();
  }

  btn.addEventListener('pointerup', endPress);
  btn.addEventListener('pointercancel', (e) => {
    if (!press || e.pointerId !== press.id) return;
    clearPressTimer();
    press = null;
    btn.classList.remove('dragging');
  });

  // 視窗縮放：按既有比例重新貼邊（拖移中不干擾）
  window.addEventListener('resize', () => {
    if (press && press.moved) return;
    applyPos(pos);
  }, { passive: true });

  // ─── 初始化：讀 storage + onChanged 即時生效 ─────────────────────────────
  browser.storage.sync.get(['floatingIcon', 'floatingIconOpacity', 'floatingIconSize', 'floatingIconPos']).then((s) => {
    applyOpacity(s.floatingIconOpacity);
    applySize(s.floatingIconSize);
    applyPos(s.floatingIconPos);
    applyEnabled(resolveEnabled(s.floatingIcon));
  }).catch(() => {
    applyOpacity(undefined);
    applySize(undefined);
    applyPos(undefined);
    applyEnabled(resolveEnabled(undefined));
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.floatingIcon) applyEnabled(resolveEnabled(changes.floatingIcon.newValue));
    if (changes.floatingIconOpacity) applyOpacity(changes.floatingIconOpacity.newValue);
    if (changes.floatingIconSize) applySize(changes.floatingIconSize.newValue);
    if (changes.floatingIconPos) applyPos(changes.floatingIconPos.newValue);
  });

  // regression spec（isolated world）用：暴露內部 handler 與狀態
  SK._floating = {
    host, btn, menuEl,
    openMenu, closeMenu, buildMenu,
    handleShortPress,
    runPreset,
    applyEnabled, applyOpacity, applySize, applyPos,
    resolveEnabled, pickPopupSlot,
    isMenuOpen: () => menuOpen,
    getOpacity: () => host.style.opacity,
    getIconSize: () => iconSize,
    getPos: () => ({ ...pos }),
  };
})(window.__SK);
