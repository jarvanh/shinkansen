// translate-doc/settings.js — 文件翻譯獨立 settings page（W7,2026-05-05 起）
//
// 為什麼有這頁：
//   1. 文件翻譯（PDF / 未來 Office）的 prompt 用 inline marker 協定 ⟦b⟧/⟦i⟧/⟦l:N⟧,
//      跟網頁翻譯分開，獨立 textarea 編輯空間需要大，modal 不適合
//   2. 為將來擴充 Office 格式（.docx/.xlsx/.pptx）做好結構；格式特別設定會以子
//      section 出現，共用 systemPrompt
//   3. 從 popup 設定 / options 一般設定搬出來，「文件翻譯」相關設定集中在這一頁
//
// 觸發：從 translate-doc/index.html 工具列「翻譯設定」modal 內「進階設定 →」
// 按鈕用 chrome.tabs.create 開新 tab 進來
//
// UI 風格對齊 options/options.js:button.primary 儲存按鈕 + save-bar 紅綠提示條,
// 任何 input/change 觸發 markDirty 在頂端顯示「有未儲存的變更」紅條,儲存後
// 換綠條「✓ 已儲存」3 秒後消失。

import { browser } from '../lib/compat.js';
import { getSettings, DEFAULT_SETTINGS, DEFAULT_DOC_SYSTEM_PROMPT } from '../lib/storage.js';
import * as cache from '../lib/cache.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await getSettings();
  const td = s.translateDoc || DEFAULT_SETTINGS.translateDoc;
  $('td-systemPrompt').value = td.systemPrompt || DEFAULT_DOC_SYSTEM_PROMPT;
  // applyFixedGlossary 預設 true(舊使用者 saved 沒 key 時走 default)
  $('td-applyFixedGlossary').checked = td.applyFixedGlossary !== false;
  $('td-temperature').value = (typeof td.temperature === 'number' && Number.isFinite(td.temperature))
    ? td.temperature : DEFAULT_SETTINGS.translateDoc.temperature;
  // 載入完成標記乾淨狀態(避免 load 觸發 input event 把 save-bar 點起來)
  initialLoaded = true;
  hideSaveBar();
}

async function save() {
  // 讀現有 settings 再 merge — 不踩到使用者其他設定
  const existing = (await browser.storage.sync.get(null)) || {};
  const td = existing.translateDoc || {};
  // temperature:空字串 / 非數字 → 退回預設,合法數字(含 0)保留
  const tempRaw = parseFloat($('td-temperature').value);
  const tempClean = (Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 2)
    ? tempRaw : DEFAULT_SETTINGS.translateDoc.temperature;
  const merged = {
    ...td,
    systemPrompt: $('td-systemPrompt').value || DEFAULT_DOC_SYSTEM_PROMPT,
    // v1.8.49: 移除 auto applyGlossary toggle(改走 stage-result「先建立文章術語表」按鈕);
    // saved.applyGlossary 留在既有使用者 storage 但不再讀寫,無害 orphan
    applyFixedGlossary: $('td-applyFixedGlossary').checked,
    temperature: tempClean,
  };
  await browser.storage.sync.set({ translateDoc: merged });
  showSaveBar('saved', '✓ 已儲存');
}

// ─── save-bar(對齊 options.js v0.94 同套機制)──────────────────
let initialLoaded = false;
let saveBarHideTimer = null;
function showSaveBar(state, text) {
  const bar = $('save-bar');
  bar.textContent = text;
  bar.className = 'save-bar ' + state;
  bar.hidden = false;
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  if (state === 'saved') {
    saveBarHideTimer = setTimeout(() => { bar.hidden = true; }, 3000);
  }
}
function hideSaveBar() {
  const bar = $('save-bar');
  bar.hidden = true;
  if (saveBarHideTimer) { clearTimeout(saveBarHideTimer); saveBarHideTimer = null; }
}
function markDirty() {
  if (!initialLoaded) return; // load() 階段觸發的 input 不算 dirty
  const bar = $('save-bar');
  if (bar.classList.contains('saved') && !bar.hidden) return;
  showSaveBar('dirty', '有未儲存的變更');
}
document.querySelector('.container').addEventListener('input', markDirty);
document.querySelector('.container').addEventListener('change', markDirty);

$('td-save-btn').addEventListener('click', save);

$('td-reset-prompt').addEventListener('click', () => {
  $('td-systemPrompt').value = DEFAULT_DOC_SYSTEM_PROMPT;
  markDirty();
});

$('td-clear-all-cache-btn').addEventListener('click', async () => {
  if (!confirm('確定要清掉所有文件翻譯記憶嗎？\n\n清除後,之前翻過的文件下次再翻會重新呼叫 AI（也會重新計費）。\n\n網頁翻譯、字幕翻譯不受影響。')) return;
  const status = $('td-clear-cache-status');
  try {
    const cleared = await cache.clearDocTranslationCache();
    status.textContent = `✓ 已清除 ${cleared} 筆翻譯記憶`;
    status.style.color = '#34c759';
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  } catch (err) {
    status.textContent = `✗ 清除失敗：${err && err.message}`;
    status.style.color = '#ef4444';
  }
});

load();
