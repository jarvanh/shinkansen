// cache.js — 持久化翻譯快取
// 存在 chrome.storage.local,key 為 SHA-1(原文） 加 'tc_' 前綴。
// 版本變更時會由 background.js 主動呼叫 clearAll() 清空。

const KEY_PREFIX = 'tc_';
const GLOSSARY_PREFIX = 'gloss_';   // v0.69: 術語表快取
const VERSION_KEY = '__cacheVersion';

async function hashText(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 一次取多段譯文。回傳與輸入等長的陣列，缺的位置為 null。
 * @param {string[]} texts 原文陣列
 * @param {string} [keySuffix=''] 可選的 key 後綴（v0.70: 用來區分有/無術語表的快取）
 */
export async function getBatch(texts, keySuffix = '') {
  if (!texts.length) return [];
  const hashes = await Promise.all(texts.map(hashText));
  const keys = hashes.map(h => KEY_PREFIX + h + keySuffix);
  const stored = await chrome.storage.local.get(keys);
  return keys.map(k => (k in stored ? stored[k] : null));
}

/**
 * 一次寫多段譯文。texts 與 translations 必須等長。
 * @param {string[]} texts 原文陣列
 * @param {string[]} translations 譯文陣列
 * @param {string} [keySuffix=''] 可選的 key 後綴（v0.70: 用來區分有/無術語表的快取）
 */
export async function setBatch(texts, translations, keySuffix = '') {
  if (!texts.length) return;
  const hashes = await Promise.all(texts.map(hashText));
  const updates = {};
  for (let i = 0; i < texts.length; i++) {
    if (translations[i]) {
      updates[KEY_PREFIX + hashes[i] + keySuffix] = translations[i];
    }
  }
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

/**
 * v0.69: 取得術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @returns {Promise<Array|null>} 快取命中時回傳術語陣列，否則 null
 */
export async function getGlossary(inputHash) {
  const key = GLOSSARY_PREFIX + inputHash;
  const stored = await chrome.storage.local.get(key);
  return (key in stored) ? stored[key] : null;
}

/**
 * v0.69: 寫入術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @param {Array} glossary 術語陣列
 */
export async function setGlossary(inputHash, glossary) {
  const key = GLOSSARY_PREFIX + inputHash;
  await chrome.storage.local.set({ [key]: glossary });
}

/** v0.69: 計算文字 SHA-1（匯出給 background 使用）。 */
export { hashText };

/**
 * 清除所有翻譯快取與術語表快取（保留版本標記等其他 local storage 內容）。
 */
export async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX) || k.startsWith(GLOSSARY_PREFIX));
  if (toRemove.length) {
    await chrome.storage.local.remove(toRemove);
  }
  return toRemove.length;
}

/**
 * 取得目前快取的條目數與大致大小（bytes)。
 * v0.69: 新增 glossaryCount / glossaryBytes 分開統計術語表快取。
 */
export async function stats() {
  const all = await chrome.storage.local.get(null);
  const tcEntries = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX));
  const glossEntries = Object.keys(all).filter(k => k.startsWith(GLOSSARY_PREFIX));
  let bytes = 0;
  for (const k of tcEntries) {
    bytes += k.length + (all[k] ? String(all[k]).length : 0);
  }
  let glossaryBytes = 0;
  for (const k of glossEntries) {
    glossaryBytes += k.length + (all[k] ? JSON.stringify(all[k]).length : 0);
  }
  return {
    count: tcEntries.length,
    bytes,
    glossaryCount: glossEntries.length,
    glossaryBytes,
  };
}

/**
 * 比對 manifest 版本與儲存版本，若不同則清空快取並更新版本標記。
 * 回傳 true 代表有清空動作。
 */
export async function checkVersionAndClear(currentVersion) {
  const stored = await chrome.storage.local.get(VERSION_KEY);
  if (stored[VERSION_KEY] !== currentVersion) {
    const removed = await clearAll();
    await chrome.storage.local.set({ [VERSION_KEY]: currentVersion });
    return { cleared: true, removed, oldVersion: stored[VERSION_KEY] };
  }
  return { cleared: false };
}
