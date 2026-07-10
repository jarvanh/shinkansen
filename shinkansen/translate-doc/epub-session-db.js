// epub-session-db.js — EPUB 翻譯工作階段存檔（v2.0.11）
//
// 需求（2026-07-10 Jimmy）：翻譯到一半離開頁面，下次載入同一檔案可以繼續翻，
// 且**不受「清除翻譯快取」影響**——工作進度（譯文 / 手動編輯 / 術語表 / 本書
// 禁用詞）是使用者的工作成果，跟機器翻譯快取（tc_ / gloss_，可隨時重建）是
// 不同性質的資料。
//
// 存放位置：translate-doc 頁自己的 IndexedDB（chrome-extension:// origin）。
// 不放 chrome.storage.local——整本書譯文可達數 MB（storage.local 有 10MB 總額
// 上限且被翻譯快取共用），且 clearDocTranslationCache 掃的是 storage.local。
//
// key = 書指紋（全書 plainText 的 sha1，同 bookgloss_ 的指紋）。
// value shape：
//   { title, updatedAt,
//     glossary: [...] | null,        // 全書術語表（含選項 flag）
//     forbidden: [...] | null,       // 本書獨立禁用詞
//     blocks: { [blockId]: { raw, plain, edited, status } } }  // 只存 done block

const DB_NAME = 'shinkansen-epub-sessions';
const STORE = 'sessions';
const VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 連線失效自我重建（同 lib/usage-db.js 的教訓：瀏覽器可能主動關閉閒置連線）
      db.onclose = () => { _dbPromise = null; };
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @returns {Promise<object|null>} 沒有存檔回 null；任何錯誤靜默回 null（存檔是加值功能，不可擋主流程） */
export async function loadEpubSession(bookHash) {
  if (!bookHash) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const got = await reqAsPromise(tx.objectStore(STORE).get(bookHash));
    return got || null;
  } catch (err) {
    console.warn('[Shinkansen] epub session load failed', err && err.message);
    return null;
  }
}

export async function saveEpubSession(bookHash, data) {
  if (!bookHash || !data) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...data, updatedAt: Date.now() }, bookHash);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn('[Shinkansen] epub session save failed', err && err.message);
    return false;
  }
}

export async function deleteEpubSession(bookHash) {
  if (!bookHash) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(bookHash);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn('[Shinkansen] epub session delete failed', err && err.message);
    return false;
  }
}

/** 從 epubDoc 收集 session 的 blocks payload（只存 done block，控制體積） */
export function collectSessionBlocks(epubDoc) {
  const blocks = {};
  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      blocks[b.blockId] = {
        raw: b.translationRaw ?? null,
        plain: b.translation ?? null,
        edited: b.editedHtml ?? null,
      };
    }
  }
  return blocks;
}

/** 把 session 的 blocks 灌回 epubDoc（blockId 由內容指紋派生，同書必對齊） */
export function hydrateSessionBlocks(epubDoc, blocks) {
  if (!blocks) return 0;
  let restored = 0;
  for (const ch of epubDoc.chapters) {
    for (const b of ch.blocks) {
      const saved = blocks[b.blockId];
      if (!saved) continue;
      if (saved.raw == null && saved.plain == null && saved.edited == null) continue;
      b.translationRaw = saved.raw ?? null;
      b.translation = saved.plain ?? null;
      b.editedHtml = saved.edited ?? null;
      b.translationStatus = 'done';
      restored++;
    }
  }
  return restored;
}
