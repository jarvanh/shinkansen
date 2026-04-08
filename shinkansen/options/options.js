// options.js — 設定頁邏輯

const DEFAULT_SYSTEM_PROMPT = `你是一位專業的翻譯助理。請將使用者提供的文字翻譯成繁體中文（台灣用語），遵守以下規則：
1. 只輸出譯文，不要加任何解釋、前言或後記。
2. 保留原文中的專有名詞、產品名、人名、程式碼、網址、數字與符號。
3. 使用台灣慣用的翻譯（例如 software → 軟體、而非「軟件」;database → 資料庫、而非「數據庫」)。
4. 若輸入包含多段文字（以特定分隔符號區隔），請逐段翻譯並以相同分隔符號輸出。
5. 語氣自然流暢，避免直譯與機械感。`;

const DEFAULTS = {
  apiKey: '',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 0.3,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  pricing: {
    inputPerMTok: 0.30,
    outputPerMTok: 2.50,
  },
  targetLanguage: 'zh-TW',
  domainRules: { whitelist: [], blacklist: [] },
  autoTranslate: true,
  debugLog: false,
  tier: 'tier1',
  safetyMargin: 0.1,
  maxRetries: 3,
  rpmOverride: null,
  tpmOverride: null,
  rpdOverride: null,
  maxConcurrentBatches: 10,
};

// Tier 對照表(與 lib/tier-limits.js 內容一致。options.js 是普通 script 不走 ES module,
// 只能複製一份)
const TIER_LIMITS = {
  free: {
    'gemini-2.5-pro':        { rpm: 5,   tpm: 250000,   rpd: 100 },
    'gemini-2.5-flash':      { rpm: 10,  tpm: 250000,   rpd: 250 },
    'gemini-2.5-flash-lite': { rpm: 15,  tpm: 250000,   rpd: 1000 },
    'gemini-2.0-flash':      { rpm: 15,  tpm: 1000000,  rpd: 200 },
  },
  tier1: {
    'gemini-2.5-pro':        { rpm: 150, tpm: 1000000,  rpd: 1000 },
    'gemini-2.5-flash':      { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-2.5-flash-lite': { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-2.0-flash':      { rpm: 300, tpm: 4000000,  rpd: 1500 },
  },
  tier2: {
    'gemini-2.5-pro':        { rpm: 1000, tpm: 2000000, rpd: 10000 },
    'gemini-2.5-flash':      { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-2.5-flash-lite': { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-2.0-flash':      { rpm: 2000, tpm: 4000000, rpd: 10000 },
  },
};

function applyTierToInputs(tier, model) {
  const rpmEl = $('rpm');
  const tpmEl = $('tpm');
  const rpdEl = $('rpd');
  if (tier === 'custom') {
    rpmEl.readOnly = false;
    tpmEl.readOnly = false;
    rpdEl.readOnly = false;
    return;
  }
  rpmEl.readOnly = true;
  tpmEl.readOnly = true;
  rpdEl.readOnly = true;
  const table = TIER_LIMITS[tier] || {};
  const limits = table[model] || { rpm: 60, tpm: 1000000, rpd: 1000 };
  rpmEl.value = limits.rpm;
  tpmEl.value = limits.tpm;
  rpdEl.value = limits.rpd;
}

const $ = (id) => document.getElementById(id);

async function load() {
  const saved = await chrome.storage.sync.get(null);
  const s = {
    ...DEFAULTS,
    ...saved,
    geminiConfig: { ...DEFAULTS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULTS.pricing, ...(saved.pricing || {}) },
  };
  $('apiKey').value = s.apiKey;
  $('model').value = s.geminiConfig.model;
  $('serviceTier').value = s.geminiConfig.serviceTier;
  $('temperature').value = s.geminiConfig.temperature;
  $('topP').value = s.geminiConfig.topP;
  $('topK').value = s.geminiConfig.topK;
  $('maxOutputTokens').value = s.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = s.geminiConfig.systemInstruction;
  $('inputPerMTok').value = s.pricing.inputPerMTok;
  $('outputPerMTok').value = s.pricing.outputPerMTok;
  $('whitelist').value = (s.domainRules.whitelist || []).join('\n');
  $('blacklist').value = (s.domainRules.blacklist || []).join('\n');
  $('debugLog').checked = s.debugLog;

  // 效能與配額
  $('tier').value = s.tier || 'tier1';
  applyTierToInputs($('tier').value, s.geminiConfig.model);
  // 若有 override 則把 override 填進去覆蓋 tier 預設
  if (s.rpmOverride) $('rpm').value = s.rpmOverride;
  if (s.tpmOverride) $('tpm').value = s.tpmOverride;
  if (s.rpdOverride) $('rpd').value = s.rpdOverride;
  const marginPct = Math.round((s.safetyMargin || 0.1) * 100);
  $('safetyMargin').value = marginPct;
  $('safetyMarginLabel').textContent = marginPct;
  $('maxConcurrentBatches').value = s.maxConcurrentBatches || 10;
  $('maxRetries').value = s.maxRetries || 3;
}

async function save() {
  const settings = {
    apiKey: $('apiKey').value.trim(),
    geminiConfig: {
      model: $('model').value,
      serviceTier: $('serviceTier').value,
      temperature: Number($('temperature').value),
      topP: Number($('topP').value),
      topK: Number($('topK').value),
      maxOutputTokens: Number($('maxOutputTokens').value),
      systemInstruction: $('systemInstruction').value,
    },
    pricing: {
      inputPerMTok: Number($('inputPerMTok').value) || 0,
      outputPerMTok: Number($('outputPerMTok').value) || 0,
    },
    domainRules: {
      whitelist: $('whitelist').value.split('\n').map(s => s.trim()).filter(Boolean),
      blacklist: $('blacklist').value.split('\n').map(s => s.trim()).filter(Boolean),
    },
    debugLog: $('debugLog').checked,
    tier: $('tier').value,
    safetyMargin: Number($('safetyMargin').value) / 100,
    maxRetries: Number($('maxRetries').value) || 3,
    maxConcurrentBatches: Number($('maxConcurrentBatches').value) || 10,
    // 只有 custom tier 才寫入 override(其他 tier 的數字從對照表讀,不存)
    rpmOverride: $('tier').value === 'custom' ? (Number($('rpm').value) || null) : null,
    tpmOverride: $('tier').value === 'custom' ? (Number($('tpm').value) || null) : null,
    rpdOverride: $('tier').value === 'custom' ? (Number($('rpd').value) || null) : null,
  };
  await chrome.storage.sync.set(settings);
  $('save-status').textContent = '✓ 已儲存';
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
}

$('save').addEventListener('click', save);

// Tier 或 Model 變更 → 自動更新 RPM/TPM/RPD 顯示
$('tier').addEventListener('change', () => {
  applyTierToInputs($('tier').value, $('model').value);
});
$('model').addEventListener('change', () => {
  applyTierToInputs($('tier').value, $('model').value);
});
$('safetyMargin').addEventListener('input', () => {
  $('safetyMarginLabel').textContent = $('safetyMargin').value;
});

$('reset-defaults').addEventListener('click', async () => {
  if (!confirm('確定要回復所有預設設定嗎？\n\nAPI Key 會被保留，翻譯快取與累計使用統計不受影響。\n此操作無法復原。')) return;
  // 保留 API Key，其餘欄位全部重設回 DEFAULTS
  const { apiKey = '' } = await chrome.storage.sync.get('apiKey');
  // 先清空 sync，再只寫回 API Key；接著 load() 會把 DEFAULTS 填進表單
  await chrome.storage.sync.clear();
  if (apiKey) await chrome.storage.sync.set({ apiKey });
  await load();
  $('save-status').textContent = '✓ 已回復預設設定';
  $('save-status').style.color = '#34c759';
  setTimeout(() => {
    $('save-status').textContent = '';
    $('save-status').style.color = '';
  }, 3000);
});

$('view-logs').addEventListener('click', async () => {
  const { shinkansenLogs = [] } = await chrome.storage.local.get('shinkansenLogs');
  const view = $('log-view');
  view.hidden = false;
  view.textContent = shinkansenLogs.length
    ? shinkansenLogs.slice(-100).map(l => JSON.stringify(l)).join('\n')
    : '(尚無 Log)';
});

$('export-icloud').addEventListener('click', async () => {
  const all = await chrome.storage.sync.get(null);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `shinkansen-settings-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  alert('請在存檔對話框中，選擇「iCloud 雲碟」底下的位置即可完成備份。\n建議路徑：iCloud 雲碟 → Shinkansen/');
});

$('import-file').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    await chrome.storage.sync.set(data);
    await load();
    alert('匯入成功');
  } catch (err) {
    alert('匯入失敗：' + err.message);
  }
});

$('open-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

load();
