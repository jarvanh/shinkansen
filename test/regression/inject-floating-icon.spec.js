// Regression: inject-floating-icon（懸浮翻譯控制按鈕的接線正確性）
//
// Fixture: test/regression/fixtures/floating-icon.html
// 結構：最小頁面，懸浮 icon 不依賴頁面 DOM，只要 content script 注入即建立
//   SK._floating（Shadow DOM host + pointer 狀態機）。
//
// 驗的是「接線正確」這一層（content script isolated world 真實注入後）：
//   1. 短按 = popupButtonSlot 對應 preset（單一資料源，與 popup 工具列按鈕同 key）
//   2. 長按選單由 translatePresets / DEFAULT_PRESETS 建出三列，slot 1/2/3，點任一列
//      路由到對應 slot 並收選單
//   3. resolveEnabled：非 boolean（未設過）→ 一律預設開啟（不分平台），明確
//      設過則尊重 boolean 值
// 不驗：pointer 事件實體手勢消歧（門檻計時）/ 拖移吸附的視覺座標（那層需實機，
//   harness pointer 模擬與真機觸控時序不同）。
//
// SANITY 紀錄（已驗證）：把 handleShortPress 內 `slot = pickPopupSlot(popupButtonSlot)`
//   暫時改成寫死 `slot = 2` → 「短按路由到 popupButtonSlot=3」斷言 fail（收到 2）→
//   還原 → pass。另把 buildMenu 的 `[1,2,3].map` 暫改成 `[1,2]` → 「選單三列」斷言
//   fail（只 2 列）→ 還原 → pass。
// SANITY 紀錄（大小 / 選單透明度，已驗證）：把 applySize 的 `iconSize = v===32?32:16`
//   暫改成永遠 16 → 「大小切換」large.icon 斷言 fail（收到 16）→ 還原 → pass。
//   把 openMenu 的 `host.style.opacity='1'` 暫拿掉 → 「長按選單期間降透明度」
//   menuShown 斷言 fail（收到 0.5）→ 還原 → pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'floating-icon';

test('floating icon: 短按走 popupButtonSlot、長按選單三列路由正確、平台預設分流', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // content script 注入後 SK._floating 應存在（top frame 才建立）
  const hasFloating = await evaluate(`typeof window.__SK._floating === 'object' && !!window.__SK._floating`);
  expect(hasFloating).toBe(true);

  // (3) resolveEnabled：未設過（非 boolean）→ 一律預設開啟（不分平台）
  const resolved = await evaluate(`(() => {
    const f = window.__SK._floating;
    return {
      iosBuild: window.__SK.IS_IOS_BUILD === true,
      whenUnset: f.resolveEnabled(undefined),
      whenNull: f.resolveEnabled(null),
      whenTrue: f.resolveEnabled(true),
      whenFalse: f.resolveEnabled(false),
    };
  })()`);
  expect(resolved.iosBuild).toBe(false);          // 測試載入的是桌面 build
  expect(resolved.whenUnset).toBe(true);          // 未設過 → 一律預設開啟
  expect(resolved.whenNull).toBe(true);
  expect(resolved.whenTrue).toBe(true);           // 明確設過 → 尊重設定
  expect(resolved.whenFalse).toBe(false);

  // (1) 短按路由：popupButtonSlot=3 → handleTranslatePreset(3)
  const shortPress = await evaluate(`(async () => {
    const f = window.__SK._floating;
    await browser.storage.sync.set({ popupButtonSlot: 3 });
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      await f.handleShortPress();
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return calls;
  })()`);
  expect(shortPress).toEqual([3]);

  // 短按 fallback：popupButtonSlot 非法值 → slot 2（與 lib/storage.js pickPopupSlot 對齊）
  const shortPressFallback = await evaluate(`(async () => {
    const f = window.__SK._floating;
    await browser.storage.sync.set({ popupButtonSlot: 999 });
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      await f.handleShortPress();
    } finally {
      window.__SK.handleTranslatePreset = orig;
      await browser.storage.sync.remove('popupButtonSlot');
    }
    return calls;
  })()`);
  expect(shortPressFallback).toEqual([2]);

  // (2) 長按選單：建出三列、slot 1/2/3，點 slot-1 列 → handleTranslatePreset(1) + 收選單
  const menu = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);   // 桌面 build 預設關（display:none），openMenu 會早退；先開啟
    await f.openMenu();
    const items = Array.from(f.menuEl.querySelectorAll('.menu-item[data-slot]'));
    const slots = items.map((el) => Number(el.dataset.slot));
    const shown = f.isMenuOpen();
    const calls = [];
    const orig = window.__SK.handleTranslatePreset;
    window.__SK.handleTranslatePreset = (slot) => { calls.push(slot); };
    try {
      items.find((el) => el.dataset.slot === '1').click();
    } finally {
      window.__SK.handleTranslatePreset = orig;
    }
    return { count: items.length, slots, shown, calls, openAfterClick: f.isMenuOpen() };
  })()`);
  expect(menu.shown).toBe(true);
  expect(menu.count).toBe(3);
  expect(menu.slots).toEqual([1, 2, 3]);
  expect(menu.calls).toEqual([1]);         // 點 slot-1 列 → 路由到 slot 1
  expect(menu.openAfterClick).toBe(false); // 點選單列後收起

  await page.close();
});

// 第二層：真實 pointer 手勢 + 視覺 render（不是只測內部 handler）。
// Playwright page.mouse 產生真實 pointer 事件 → 驗 pointer 狀態機端到端：
// 短按 → handleTranslatePreset、長按 → 開選單、拖到左半 → 吸附左緣。
// 並截圖確認 icon 真的 render 出來（Shadow DOM host + icon-128.png via WAR）。
test('floating icon: 真實 pointer 手勢（短按 / 長按 / 拖移吸附）+ 視覺 render', async ({
  context,
  localServer,
}, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 開啟 icon（桌面 build 預設關）+ 裝 handleTranslatePreset 記錄器
  await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applyPos({ edge: 'right', offsetY: 0.5 });
    window.__SK._fabCalls = [];
    window.__SK.handleTranslatePreset = (slot) => { window.__SK._fabCalls.push(slot); };
  })()`);

  // icon 中心座標（host 在 isolated world，main world 量不到，走 evaluate）
  const rect = await evaluate(`(() => {
    const r = window.__SK._floating.host.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  expect(rect.w).toBeGreaterThan(0); // host 真的有版面（render 出來）

  // 視覺 ground truth：截圖 + Read（§11）
  const shotPath = testInfo.outputPath('floating-icon-rendered.png');
  await page.screenshot({ path: shotPath });

  // 短按：down → 立刻 up（< 長按門檻、無位移）→ handleTranslatePreset(預設 slot 2)
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const afterTap = await evaluate(`JSON.stringify(window.__SK._fabCalls)`);
  expect(JSON.parse(afterTap)).toEqual([2]); // popupButtonSlot 未設 → fallback 2

  // 長按：down → 壓住超過門檻（500ms）→ 開選單（不放開即觸發）
  await evaluate(`window.__SK._fabCalls = []`);
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.waitForTimeout(650);
  const menuOpen = await evaluate(`window.__SK._floating.isMenuOpen()`);
  await page.mouse.up();
  expect(menuOpen).toBe(true);
  await evaluate(`window.__SK._floating.closeMenu()`);

  // 拖移吸附：在 icon 上 down → 拖到視窗左半 → up → pos.edge 吸到 left
  await page.mouse.move(rect.cx, rect.cy);
  await page.mouse.down();
  await page.mouse.move(rect.cx - 50, rect.cy, { steps: 3 }); // 先超過拖移門檻進拖移模式
  await page.mouse.move(120, 300, { steps: 5 });             // 拖到左半
  await page.mouse.up();
  const posAfterDrag = await evaluate(`JSON.stringify(window.__SK._floating.getPos())`);
  expect(JSON.parse(posAfterDrag).edge).toBe('left');

  await page.close();
});

test('floating icon: 大小切換（16 / 32）+ 長按選單期間降透明度', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applyPos({ edge: 'right', offsetY: 0.5 });
  })()`);

  // (1) 大小切換：applySize(16) → icon 16、host footprint = 16+padding；applySize(32) → 變大
  const sizes = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applySize(16);
    const small = { icon: f.getIconSize(), w: f.host.getBoundingClientRect().width };
    f.applySize(32);
    const large = { icon: f.getIconSize(), w: f.host.getBoundingClientRect().width };
    return { small, large };
  })()`);
  expect(sizes.small.icon).toBe(16);
  expect(sizes.large.icon).toBe(32);
  expect(sizes.large.w).toBeGreaterThan(sizes.small.w); // 32 的 footprint 比 16 大

  // 非法值 fallback 回 16
  const fallback = await evaluate(`(() => { window.__SK._floating.applySize(999); return window.__SK._floating.getIconSize(); })()`);
  expect(fallback).toBe(16);

  // (6) 長按選單期間降透明度：設使用者透明度 0.5 → 平時 host.opacity=0.5；
  //     開選單時拉到 1（讓使用者看清選單）；收選單還原 0.5
  const opacity = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyOpacity(0.5);
    const idle = f.getOpacity();
    await f.openMenu();
    const menuShown = f.getOpacity();
    f.closeMenu();
    const afterClose = f.getOpacity();
    return { idle, menuShown, afterClose };
  })()`);
  expect(opacity.idle).toBe('0.5');       // 平時 = 使用者設定值
  expect(opacity.menuShown).toBe('1');    // 選單開啟 → 全不透明
  expect(opacity.afterClose).toBe('0.5'); // 收起 → 還原使用者設定值

  await page.close();
});

// 觸控裝置角落禁制區：iPadOS 視窗右下角是縮放拖曳把手，按鈕停太靠近角落會被 OS 攔走
// 觸控而拖不出來。渲染時把 top 夾離上下角落 CORNER_DEADZONE_PX；非觸控（桌面）不夾角落。
// 兩層驗：(A) 純函式 cornerClampTop 夾邊邏輯；(B) 真實 render path——setTouchForTest 覆寫
// 觸控旗標後 applyPos 寫進 host.style.top 的實際值（實機 Chromium maxTouchPoints=0，
// 故走覆寫；驗到「修法實際生效那條 path」而非只測純函式）。
//
// SANITY 紀錄（已驗證）：把 cornerClampTop 的觸控分支 `return Math.max(minTop,...)` 暫改成
//   `return Math.max(0, Math.min(maxFree, top))`（等同不夾角落）→ touchFlushBottom 斷言
//   fail（收到 668 而非 624）、整合 touchTop 斷言 fail（收到 668px）→ 還原 → pass。
test('floating icon: 觸控裝置角落禁制區（不卡 iPadOS 視窗縮放角）', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // (A) 純函式：H=700、hit=32 → free=668、D=44。觸控夾離上下角落，桌面只夾可視範圍。
  const pure = await evaluate(`(() => {
    const f = window.__SK._floating;
    const H = 700, hit = 32, free = H - hit;
    return {
      D: f.CORNER_DEADZONE_PX,
      deskFlushBottom: f.cornerClampTop(free, H, hit, false),  // 桌面貼底不夾 → free
      deskOver: f.cornerClampTop(9999, H, hit, false),         // 超出 → free
      deskNeg: f.cornerClampTop(-50, H, hit, false),           // 負 → 0
      touchFlushBottom: f.cornerClampTop(free, H, hit, true),  // 觸控貼底 → free - D
      touchFlushTop: f.cornerClampTop(0, H, hit, true),        // 觸控貼頂 → D
      touchMid: f.cornerClampTop(300, H, hit, true),           // 中段不變
      tinyCenter: f.cornerClampTop(0, 80, 32, true),           // 視窗太矮夾不出安全區 → 置中
    };
  })()`);
  expect(pure.D).toBe(44);
  expect(pure.deskFlushBottom).toBe(668);
  expect(pure.deskOver).toBe(668);
  expect(pure.deskNeg).toBe(0);
  expect(pure.touchFlushBottom).toBe(624);   // 668 - 44
  expect(pure.touchFlushTop).toBe(44);
  expect(pure.touchMid).toBe(300);
  expect(pure.tinyCenter).toBe(24);          // round((80-32)/2)

  // (B) 真實 render path：setTouchForTest 覆寫觸控旗標 → applyPos 渲染 host top
  const render = await evaluate(`(() => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    f.applySize(16);                          // 釘住 hit = 16 + padding = 32
    const H = window.innerHeight;
    const hit = f.host.getBoundingClientRect().height;
    // 桌面：預設右下角 offsetY=1 → 貼底（free），不夾角落
    f.setTouchForTest(false);
    f.applyPos({ edge: 'right', offsetY: 1 });
    const deskTop = f.getTop();
    // 觸控：同樣 offsetY=1 → 夾到 free - D（儘量靠底但不進右下角縮放區）
    f.setTouchForTest(true);
    f.applyPos({ edge: 'right', offsetY: 1 });
    const touchTop = f.getTop();
    // 觸控 + 拖到頂 offsetY=0 → 夾到 D，不進頂角
    f.applyPos({ edge: 'right', offsetY: 0 });
    const touchTopEdge = f.getTop();
    f.setTouchForTest(false);                 // 還原（本 test 結束，避免殘留）
    return { H, hit, deskTop, touchTop, touchTopEdge, D: f.CORNER_DEADZONE_PX };
  })()`);
  const free = render.H - render.hit;
  expect(render.deskTop).toBe(free + 'px');                 // 桌面貼底
  expect(render.touchTop).toBe(free - render.D + 'px');     // 觸控夾離底角
  expect(render.touchTopEdge).toBe(render.D + 'px');        // 觸控夾離頂角

  await page.close();
});

// 長按選單「功能選單」→ 在頁內用 iframe 載入真正的 popup.html?panel=1 當浮層。
// 驗:(1) 選單有「功能選單」item、label 取自 i18n 字典(非寫死、非漏翻 raw key)、不算進 preset 列;
//     (2) 點它 → 浮層 iframe 開啟、src 指向 popup/popup.html?panel=1 的 extension URL;
//     (3) closeFeaturePanel 收掉浮層。popup.js 端 ?panel=1 → 關閉改 postMessage 收浮層的
//     end-to-end(真 popup 按關閉 → 浮層收掉)需實機/整合,harness 驗到「iframe 正確掛上 + src 正確」。
//
// SANITY 紀錄(已驗證):把 buildMenu 末段 `menuEl.appendChild(featureItem)` 暫拿掉 →
//   「功能選單 item 存在」斷言 fail(exists=false)→ 還原 → pass。
test('floating icon: 長按選單「功能選單」叫出 popup 浮層（頁內 iframe）', async ({ context, localServer }, testInfo) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // (1) 開選單 → 找「功能選單」item（label 與 SK.t 同源比較，免綁特定語系）
  const item = await evaluate(`(async () => {
    const f = window.__SK._floating;
    f.applyEnabled(true);
    await f.openMenu();
    const el = f.menuEl.querySelector('.menu-item.feature');
    const expectLabel = (typeof window.__SK.t === 'function') ? window.__SK.t('floating.featureMenu') : null;
    return {
      exists: !!el,
      label: el ? el.querySelector('.label').textContent : null,
      expectLabel,
      presetCount: f.menuEl.querySelectorAll('.menu-item[data-slot]').length,
    };
  })()`);
  expect(item.exists).toBe(true);
  expect(item.label).toBe(item.expectLabel);            // 用 i18n 字典值
  expect(item.label && item.label.length).toBeGreaterThan(0);
  expect(item.label).not.toBe('floating.featureMenu');  // 非漏翻 raw key
  expect(item.presetCount).toBe(3);                     // 功能選單不算進 preset 列

  // (2) 點「功能選單」→ 開浮層 iframe，src 指向 popup.html?panel=1
  const opened = await evaluate(`(() => {
    const f = window.__SK._floating;
    f.menuEl.querySelector('.menu-item.feature').click();
    return { open: f.isPanelOpen(), src: f.getPanelFrameSrc() };
  })()`);
  expect(opened.open).toBe(true);
  expect(opened.src).toMatch(/\/popup\/popup\.html\?panel=1$/);
  expect(/^(chrome|moz|safari-web)-extension:\/\//.test(opened.src)).toBe(true);

  // 視覺 ground truth：等 iframe 載入真實 popup，截圖（§11）
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('floating-feature-panel.png') });

  // (3) 收浮層
  const closed = await evaluate(`(() => { window.__SK._floating.closeFeaturePanel(); return window.__SK._floating.isPanelOpen(); })()`);
  expect(closed).toBe(false);

  await page.close();
});
