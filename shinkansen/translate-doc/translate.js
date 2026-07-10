// translate.js — 文件翻譯 pipeline 協調(W3 起)
//
// 職責：
//   1. 從版面 IR 收集所有「送翻譯」類 block(SPEC §17.4.4)
//   2. 切 chunk(預設 CHUNK_SIZE = 20，跟 content.js 對齊)
//   3. 逐 chunk 透過 chrome.runtime.sendMessage 送 background 的文件翻譯 handler
//      (Gemini = TRANSLATE_DOC_BATCH / custom provider = TRANSLATE_DOC_BATCH_CUSTOM)
//   4. 結果寫回 IR(每 block.translation / .translationStatus / .translationError)
//   5. 每完成一批 emit progress(SPEC §17.5.4 結構)
//
// 不在這裡：
//   - preset 選擇(由 caller 傳入 modelOverride)
//   - cache key blockType / fontSize 桶位(W3-iter2)
//   - 段落級 retry UI(W5)

import { TRANSLATABLE_TYPES } from './block-types.js';
import { normalizeNameSeparators } from './epub-engine.js';

// 背景端錯誤的本地化（error code 協定，lib/bg-error.js）。lib/i18n.js 由 index.html
// <script src> 載入 attach 到 window.__SK.i18n；還沒載入（init race）或沒帶 code 的
// 錯誤 fallback 原字串原樣顯示
const bgErrMsg = (response) => {
  const i18n = window.__SK?.i18n;
  if (i18n && typeof i18n.bgErrorMessage === 'function') return i18n.bgErrorMessage(response);
  return (response && response.error) || '';
};

// 跟 content.js 共用相同 chunk size，行為一致(rate limiter / token cost / cache 命中規則一致)
export const DOC_CHUNK_SIZE = 20;

/**
 * 文章術語表的輸入取樣:按 reading order 收 translatable block 的 plainText,
 * 累計達 maxChars 截斷。給 index.js extractGlossaryForDoc 用(抽出來可 unit 測)。
 *
 * 邊界:acc 含 join('\n') 分隔符預算(+1),可以超過 maxChars——所以剩餘空間用
 * `room = maxChars - acc` 算且 room <= 0 直接停,不可用 `t.slice(0, maxChars - acc)`
 * (負值 slice 會變成「整塊只去尾字元」,預算直接吹破)
 *
 * @param {LayoutDoc} doc
 * @param {number}    maxChars
 * @returns {string[]} parts — caller 自行 join('\n')
 */
export function collectGlossaryInputParts(doc, maxChars) {
  const parts = [];
  let acc = 0;
  for (const page of doc.pages) {
    for (const b of page.blocks) {
      if (!TRANSLATABLE_TYPES.has(b.type)) continue;
      const t = b.plainText && b.plainText.trim();
      if (!t) continue;
      const room = maxChars - acc;
      if (room <= 0) break;
      if (t.length > room) {
        parts.push(t.slice(0, room));
        acc = maxChars;
        break;
      }
      parts.push(t);
      acc += t.length + 1; // +1 = join('\n') 分隔符預算
    }
    if (acc >= maxChars) break;
  }
  return parts;
}

/**
 * 翻譯整份 layout doc，結果寫回每個 block。
 *
 * @param {LayoutDoc} doc                  — analyzeLayout 輸出
 * @param {object}    options
 * @param {string}    [options.modelOverride] — preset 對應的 Gemini model id
 * @param {Array}     [options.glossary]      — 額外術語表(可選)
 * @param {string}    [options.engine]        — 'gemini' | 'openai-compat'，預設 gemini
 * @param {AbortSignal} [options.signal]      — 取消信號
 * @param {(block, page) => boolean} [options.blockFilter] — EPUB 章節選翻：回 false 的
 *   block 完全不動（不重設狀態、不送翻）。續翻時用它跳過未勾選章節與已 done 的 block
 * @param {boolean}   [options.filterGlossary] — EPUB 全書術語表批次級過濾：每批只注入
 *   該批原文實際出現的條目（全書數百條全量注入太燒 token；substring 過濾是確定性
 *   動作，不影響譯名一致性——glossary 本身在翻譯前已鎖定）
 * @param {(progress: TranslateProgress) => void} [options.onProgress]
 * @returns {Promise<TranslateSummary>}
 */
export async function translateDocument(doc, options = {}) {
  const {
    modelOverride, glossary, signal, onProgress = () => {}, engine = 'gemini',
    blockFilter, filterGlossary,
    // EPUB 本書獨立禁用詞（2026-07-10）：background 與 options 共通清單合併注入
    extraForbiddenTerms = null,
    // 每批段數（2026-07-10）：settings.translateDoc.batchSize（預設 50）。
    // 同一值也隨 payload.docBatchSize 送 background 覆蓋 maxUnitsPerBatch，
    // 讓「一批」= 一次 API 請求（否則 adapter 端仍按預設 20 重切）
    batchSize = null,
  } = options;
  const chunkSize = (Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 100)
    ? batchSize : DOC_CHUNK_SIZE;
  // v1.9.6: Google MT 沒 doc handler（沒 batch-aware marker / glossary 注入機制），
  // 早期擋 + throw，避免 silent fall-through 跑 Gemini 用錯 key / 錯 model。
  // UI 層（index.js startTranslate）會在更早攔下並顯示提示，這裡是防禦深度。
  if (engine === 'google') {
    throw new Error('translate-doc: Google Translate engine 不支援文件翻譯');
  }
  const startTime = Date.now();

  // 1) 收集所有需翻譯 block(扁平化，保 order 用 readingOrder + page)
  const queue = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim().length > 0) {
        if (blockFilter && !blockFilter(block, page)) continue;
        queue.push(block);
        block.translationStatus = 'pending';
        block.translation = null;
        block.translationError = null;
      }
    }
  }

  const totalBlocks = queue.length;
  let translatedBlocks = 0;
  let failedBlocks = 0;
  let cacheHits = 0;
  // raw 與 billed 分開累計:raw(inputTokens)是對帳 Google 帳單時看 cache 折扣
  // 幅度的分母,billed 是折扣後實際計費 token。混寫會讓「inputTokens vs
  // billedInputTokens 差距」維度永遠歸零
  let cumulativeInputTokens = 0;
  let cumulativeBilledInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCostUSD = 0;
  const batchTimes = [];

  console.log('[Shinkansen] translateDocument start', {
    filename: doc.meta?.filename,
    totalBlocks,
    chunks: Math.ceil(totalBlocks / chunkSize),
    chunkSize,
    modelOverride: modelOverride || '(default)',
    pages: doc.pages.length,
  });

  emit();

  // 2) 切 chunk 逐批送
  for (let start = 0; start < queue.length; start += chunkSize) {
    if (signal?.aborted) {
      // 標 cancelled，剩下 block 保留 pending(UI 顯示原文)
      for (let j = start; j < queue.length; j++) {
        queue[j].translationStatus = 'cancelled';
      }
      break;
    }

    const chunk = queue.slice(start, start + chunkSize);
    // W7:送 LLM 的文字含 inline style marker(⟦b⟧/⟦i⟧/⟦l:N⟧)。fallback:
    // 沒 styleSegments 的 block(舊 fixture / parser 失敗等)用 plainText。
    const texts = chunk.map((b) => buildMarkedText(b));

    chunk.forEach((b) => { b.translationStatus = 'translating'; });
    emit();

    // EPUB 全書術語表批次級過濾（見 options doc）；PDF 路徑不帶 filterGlossary，
    // 行為不變（整份 glossary 每批注入）
    const chunkGlossary = filterGlossary
      ? filterGlossaryForTexts(glossary, texts)
      : glossary;

    const t0 = Date.now();
    let response;
    try {
      const messageType = engine === 'openai-compat' ? 'TRANSLATE_DOC_BATCH_CUSTOM' : 'TRANSLATE_DOC_BATCH';
      response = await chrome.runtime.sendMessage({
        type: messageType,
        payload: { texts, modelOverride, glossary: chunkGlossary, preferArticleGlossary: true, extraForbiddenTerms, docBatchSize: chunkSize },
      });
    } catch (err) {
      // background 完全沒回應(extension reload / service worker crash 等)
      const msg = (err && err.message) || String(err);
      chunk.forEach((b) => {
        b.translationStatus = 'failed';
        b.translationError = msg;
      });
      failedBlocks += chunk.length;
      translatedBlocks += chunk.length;
      emit();
      continue;
    }
    batchTimes.push(Date.now() - t0);

    if (!response || !Array.isArray(response.result)) {
      // background handler 拋了(API key 缺 / Gemini 回 error 等)
      const msg = bgErrMsg(response) || 'no response';
      chunk.forEach((b) => {
        b.translationStatus = 'failed';
        b.translationError = msg;
      });
      failedBlocks += chunk.length;
      translatedBlocks += chunk.length;
      emit();
      continue;
    }

    const usage = response.usage || {};
    // `??` 而非 `||`:billedInputTokens === 0(全 cache hit / 全免費)是合法值,
    // `||` 會 fallback 到另一邊,語意相反
    cumulativeInputTokens += usage.inputTokens ?? usage.billedInputTokens ?? 0;
    cumulativeBilledInputTokens += usage.billedInputTokens ?? usage.inputTokens ?? 0;
    cumulativeOutputTokens += usage.outputTokens ?? 0;
    cumulativeCostUSD += usage.billedCostUSD ?? usage.costUSD ?? 0;
    cacheHits += usage.cacheHits || 0;
    console.log('[Shinkansen] chunk done', {
      chunkStart: start,
      chunkSize: chunk.length,
      batchMs: Date.now() - t0,
      usage: {
        billedInputTokens: usage.billedInputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheHits: usage.cacheHits || 0,
        billedCostUSD: Number((usage.billedCostUSD || 0).toFixed(6)),
      },
    });

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      const tr = response.result[i];
      if (typeof tr === 'string' && tr.length > 0) {
        // EPUB block：原始譯文（含 ⟦N⟧ 佔位符）留給 epub-writer 反序列化；
        // translation 欄位存去除標記後的純文字（預覽 / 複製用）
        if (b.epubSerializedText != null) {
          // 人名間隔號正規化（CJK·CJK → CJK・CJK，2026-07-10）——確定性保證，
          // 不靠 LLM 服從；也讓 dedupe 的 target 比對兩端形式一致
          const norm = normalizeNameSeparators(tr);
          b.translationRaw = norm;
          b.translation = stripPlaceholderTokens(norm);
          b.editedHtml = null; // 重翻覆蓋預覽頁的手動編輯（UI 有提示）
          b.translationStatus = 'done';
          translatedBlocks++;
          continue;
        }
        // W7:譯文 parse 出 inline segments,寫回 block.translationSegments。
        // parser 失敗(marker 對不齊)會 fallback 整段 plain regular,不破渲染。
        // block.translation 保留為「parser 還原後的純文字」(複製譯文用),
        // 不留 marker(避免使用者複製到帶 ⟦…⟧ 標記)
        const parsed = parseMarkedTranslation(tr, b.linkUrls || []);
        b.translationSegments = parsed.segments;
        b.translation = parsed.plainText;
        b.translationStatus = 'done';
      } else {
        b.translation = null;
        b.translationSegments = null;
        b.translationStatus = 'failed';
        b.translationError = 'empty translation';
        failedBlocks++;
      }
      translatedBlocks++;
    }
    emit();
  }


  const durationMs = Date.now() - startTime;

  console.log('[Shinkansen] translateDocument done', {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeBilledInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD: Number(cumulativeCostUSD.toFixed(6)),
    durationMs,
    cancelled: !!signal?.aborted,
  });

  // 用量寫進「用量紀錄」(IndexedDB，跟網頁翻譯共用 LOG_USAGE handler)
  // 全 cache hit 場景 background 端 shouldSkipUsageRecord 會自動跳過，不污染列表
  try {
    const filename = (doc.meta && doc.meta.filename) || 'unknown.pdf';
    const urlScheme = doc.kind === 'epub' ? 'epub' : 'pdf';
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: `${urlScheme}://${filename}`,
        title: filename,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        cachedTokens: 0,
        billedInputTokens: cumulativeBilledInputTokens,
        billedCostUSD: cumulativeCostUSD,
        segments: totalBlocks,
        cacheHits,
        durationMs,
        timestamp: Date.now(),
        engine: engine || 'gemini',
        model: modelOverride || null,
        source: 'translate-doc',
      },
    });
  } catch (err) {
    console.warn('[Shinkansen] LOG_USAGE 失敗', err && err.message);
  }

  return {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeBilledInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD,
    durationMs,
    cancelled: !!signal?.aborted,
  };

  // ---- helpers ----

  function emit() {
    const avgBatchMs = batchTimes.length > 0
      ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length
      : 0;
    const remainingChunks = Math.max(0, Math.ceil((totalBlocks - translatedBlocks) / chunkSize));
    const estimatedRemainingSec = avgBatchMs > 0
      ? Math.round((remainingChunks * avgBatchMs) / 1000)
      : 0;
    onProgress({
      totalBlocks,
      translatedBlocks,
      failedBlocks,
      estimatedRemainingSec,
      cumulativeInputTokens,
      cumulativeOutputTokens,
      cumulativeCostUSD,
    });
  }
}

/**
 * 重新翻譯單一 block(W5 段落級 retry)。
 *
 * @param {LayoutBlock} block — 要重翻的 block，結果會寫回 block.translation / .translationStatus
 * @param {object} options
 * @param {string} [options.modelOverride]
 * @param {Array}  [options.glossary]
 * @param {string} [options.engine]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function translateSingleBlock(block, options = {}) {
  const { modelOverride, glossary, engine = 'gemini' } = options;
  // v1.9.6: Google MT 不支援文件翻譯，retry 路徑同步擋（理論上 UI 層已先擋掉走不到這，
  // 但 currentEngine 是 module state，測試 / 程式錯誤造成 stale 時這裡是最後守門）
  if (engine === 'google') {
    return { ok: false, error: 'translate-doc: Google Translate engine 不支援文件翻譯' };
  }
  if (!block || !block.plainText) return { ok: false, error: 'no plainText' };

  console.log('[Shinkansen] retry block', block.blockId, 'modelOverride=', modelOverride || '(default)');

  block.translationStatus = 'translating';
  block.translationError = null;
  const startTime = Date.now();

  let response;
  try {
    const messageType = engine === 'openai-compat' ? 'TRANSLATE_DOC_BATCH_CUSTOM' : 'TRANSLATE_DOC_BATCH';
    response = await chrome.runtime.sendMessage({
      type: messageType,
      payload: { texts: [buildMarkedText(block)], modelOverride, glossary, preferArticleGlossary: true },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry sendMessage 失敗', block.blockId, msg);
    return { ok: false, error: msg };
  }

  if (!response || !Array.isArray(response.result) || response.result.length === 0) {
    const msg = bgErrMsg(response) || 'no response';
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry response 異常', block.blockId, msg);
    return { ok: false, error: msg };
  }

  // 用量寫進紀錄(retry 通常很小，但仍計入)
  const usage = response.usage || {};
  try {
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: 'pdf://retry',
        title: `(retry ${block.blockId})`,
        // raw / billed 分開記(同 translateDocument);`??` 而非 `||`,billed===0 合法
        inputTokens: usage.inputTokens ?? usage.billedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedTokens: 0,
        billedInputTokens: usage.billedInputTokens ?? usage.inputTokens ?? 0,
        billedCostUSD: usage.billedCostUSD ?? 0,
        segments: 1,
        cacheHits: usage.cacheHits || 0,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        engine: engine || 'gemini',
        model: modelOverride || null,
        source: 'translate-doc-retry',
      },
    });
  } catch (_) { /* swallow */ }

  const tr = response.result[0];
  if (typeof tr === 'string' && tr.length > 0) {
    // EPUB block：同 translateDocument 的 epub 分支
    if (block.epubSerializedText != null) {
      const norm = normalizeNameSeparators(tr);
      block.translationRaw = norm;
      block.translation = stripPlaceholderTokens(norm);
      block.editedHtml = null; // 重翻覆蓋預覽頁的手動編輯
      block.translationStatus = 'done';
      block.translationError = null;
      return { ok: true };
    }
    const parsed = parseMarkedTranslation(tr, block.linkUrls || []);
    block.translationSegments = parsed.segments;
    block.translation = parsed.plainText;
    block.translationStatus = 'done';
    block.translationError = null;
    console.log('[Shinkansen] retry block done', block.blockId, 'tr=', parsed.plainText.slice(0, 40));
    return { ok: true };
  } else {
    block.translation = null;
    block.translationSegments = null;
    block.translationStatus = 'failed';
    block.translationError = 'empty translation';
    console.warn('[Shinkansen] retry empty translation', block.blockId);
    return { ok: false, error: 'empty translation' };
  }
}

// ============================================================================
// EPUB 專用 helpers
// ============================================================================

// 去除譯文中的 ⟦N⟧ / ⟦/N⟧ / ⟦*N⟧ 佔位符標記（預覽 / 複製用純文字）。
// 反序列化重建走 epub-writer 的 SK.deserializeWithPlaceholders，不用這個。
export function stripPlaceholderTokens(s) {
  const SK = (typeof window !== 'undefined' && window.__SK) || null;
  if (SK && typeof SK.stripStrayPlaceholderMarkers === 'function') {
    return SK.stripStrayPlaceholderMarkers(s).replace(/\s{2,}/g, ' ').trim();
  }
  return (s || '').replace(/⟦\*?\/?\d+⟧/g, '').replace(/\s{2,}/g, ' ').trim();
}

// EPUB 全書術語表的批次級過濾：只保留該批原文實際出現的條目（大小寫不敏感）。
// 確定性動作：glossary 在翻譯前已鎖定，此處只是「這批用不到的條目不送」省 token，
// 不改變任何譯名決策。
//
// 部分比對規則（2026-07-09 真書實測補）：多詞條目（如 Richard Enfield）在章節內
// 常以末詞（姓氏 Enfield）單獨出現——只比對完整 source 會把這條濾掉，LLM 對姓氏
// 自由發揮造成譯名漂移（實測 Jekyll & Hyde：恩菲爾德 → 恩菲爾）。所以多詞條目
// 改成「完整 source 或末詞（≥3 字元）出現」都算命中——多送一條無害（LLM 拿到
// 全名對照能推姓氏譯法），漏送才是漂移來源。
export function filterGlossaryForTexts(glossary, texts) {
  if (!Array.isArray(glossary) || glossary.length === 0) return glossary;
  const haystack = texts.join('\n').toLowerCase();
  const hit = glossary.filter((e) => {
    const src = (e && e.source || '').toLowerCase().trim();
    if (!src) return false;
    if (haystack.includes(src)) return true;
    const words = src.split(/\s+/);
    if (words.length >= 2) {
      const last = words[words.length - 1];
      if (last.length >= 3 && haystack.includes(last)) return true;
    }
    return false;
  });
  return hit.length > 0 ? hit : null;
}

// ============================================================================
// W7 inline rich text marker 協定
// ============================================================================
//
// marker 設計(沿用既有段落佔位符 ⟦…⟧ 格式,LLM 已熟悉):
//   ⟦b⟧粗體段⟦/b⟧
//   ⟦i⟧斜體段⟦/i⟧
//   ⟦l:N⟧連結文字⟦/l⟧   N = block.linkUrls 內的 1-based index
//
// 巢狀順序(由外到內):bold → italic → link
// 例:**Editor's Note:** *Go to [Plano.gov](url) for ...*
// →  ⟦b⟧Editor's Note:⟦/b⟧ ⟦i⟧Go to ⟦l:1⟧Plano.gov⟦/l⟧ for ...⟦/i⟧
//
// link 在最內層的理由:link 是錨點,跨樣式邊界比連續性重要;bold/italic 純樣式
// 可被 wrap 邏輯切散。
//
// parser 失敗策略:tag 不成對 / 巢狀錯誤 / link index 越界 → 整 block 退回 plain
// regular(translationSegments 為單一 piece),不破渲染。

const MARKER_TAG_RE = /⟦(?:b|i|l:\d+|\/b|\/i|\/l)⟧/g;

/**
 * 從 block.styleSegments 構出帶 marker 的字串送 LLM。
 * 沒 styleSegments 的 block(舊資料 / fallback)直接回傳 plainText。
 *
 * @param {LayoutBlock} block
 * @returns {string}
 */
export function buildMarkedText(block) {
  if (!block) return '';
  // EPUB block：送 ⟦N⟧ 佔位符序列化文字（epub-engine 產出；system-instruction
  // 偵測到 ⟦ 會自動注入佔位符協定規則）。W7 styleSegments 是 PDF 專用路徑
  if (block.epubSerializedText != null) return block.epubSerializedText;
  const segs = block.styleSegments;
  const linkUrls = block.linkUrls || [];
  if (!Array.isArray(segs) || segs.length === 0) {
    return block.plainText || '';
  }
  let out = '';
  for (const s of segs) {
    let t = s.text;
    if (s.linkUrl) {
      const idx = linkUrls.indexOf(s.linkUrl) + 1;
      if (idx > 0) t = `⟦l:${idx}⟧${t}⟦/l⟧`;
    }
    if (s.isItalic) t = `⟦i⟧${t}⟦/i⟧`;
    if (s.isBold) t = `⟦b⟧${t}⟦/b⟧`;
    out += t;
  }
  return out;
}

/**
 * 解 LLM 回的 marker 字串成 segments 陣列 + 純文字。
 * 走簡化 stack 解法:遇 ⟦b⟧/⟦i⟧/⟦l:N⟧ push、遇 ⟦/b⟧/⟦/i⟧/⟦/l⟧ pop。
 * 任一錯誤(tag 不成對 / link 編號越界)→ fallback 整段 plain regular。
 *
 * @param {string}   text
 * @param {string[]} linkUrls — 對應 block.linkUrls
 * @returns {{ segments: StyleSegment[], plainText: string }}
 */
export function parseMarkedTranslation(text, linkUrls) {
  const fallback = () => {
    const cleaned = (text || '').replace(MARKER_TAG_RE, '');
    return {
      segments: [{ text: cleaned, isBold: false, isItalic: false, linkUrl: null }],
      plainText: cleaned,
    };
  };
  if (typeof text !== 'string' || text.length === 0) {
    return { segments: [], plainText: '' };
  }

  const stack = []; // entries: 'b' | 'i' | { type: 'l', url }
  const segments = [];
  const tagRe = /⟦(\/?[bi]|l:(\d+)|\/l)⟧/g;
  let lastIndex = 0;

  function flushPlain(plain) {
    if (!plain) return;
    let isBold = false, isItalic = false, linkUrl = null;
    for (const e of stack) {
      if (e === 'b') isBold = true;
      else if (e === 'i') isItalic = true;
      else if (e && e.type === 'l') linkUrl = e.url;
    }
    // 同 style 連續 segment 合一(LLM 譯文可能在同 style 內多次切 segment)
    const last = segments[segments.length - 1];
    if (last && last.isBold === isBold && last.isItalic === isItalic && last.linkUrl === linkUrl) {
      last.text += plain;
    } else {
      segments.push({ text: plain, isBold, isItalic, linkUrl });
    }
  }

  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const plain = text.slice(lastIndex, m.index);
    flushPlain(plain);
    lastIndex = tagRe.lastIndex;
    const tag = m[1];
    if (tag === 'b' || tag === 'i') {
      stack.push(tag);
    } else if (tag === '/b' || tag === '/i') {
      const want = tag === '/b' ? 'b' : 'i';
      const top = stack[stack.length - 1];
      if (top !== want) return fallback();
      stack.pop();
    } else if (m[2] !== undefined) {
      // ⟦l:N⟧
      const idx = parseInt(m[2], 10) - 1;
      if (idx < 0 || idx >= linkUrls.length) return fallback();
      stack.push({ type: 'l', url: linkUrls[idx] });
    } else if (tag === '/l') {
      const top = stack[stack.length - 1];
      if (!top || top.type !== 'l') return fallback();
      stack.pop();
    }
  }
  flushPlain(text.slice(lastIndex));
  if (stack.length !== 0) return fallback();

  return {
    segments,
    plainText: segments.map((s) => s.text).join(''),
  };
}

// ============================================================================
// v1.8.49 譯文編輯頁:markdown ⇄ segments 互轉
// ============================================================================
//
// 給編輯頁(stage-edit)使用的輕量 markdown 協定,跟 LLM 用的 ⟦…⟧ marker 區分:
//   **粗體**          → segment.isBold = true
//   *斜體*            → segment.isItalic = true
//   [連結文字](url)   → segment.linkUrl = url
//
// 為什麼不直接重用 ⟦b⟧/⟦i⟧/⟦l:N⟧:那組是 LLM 友善的字面 marker,讓 user 直接看
// 到很怪。markdown 直觀,user 改完一目了然。轉換點只有「載入編輯頁」與「儲存」
// 兩處,segments 仍是 block 內部的 source of truth,renderer / cache 邏輯不動。
//
// 不支援 escape:user 譯文裡放字面 `**` / `*` / `[]()` 會被當成 markdown 解析。
// 編輯頁底部 hint 會說明這個限制(MVP 取捨)。
// 巢狀:bold > italic > link(對齊 buildMarkedText / parseMarkedTranslation 設計)。
// 解析失敗一律 fallback 整段 plain regular,不 throw。

/**
 * Block.translationSegments → markdown 字串供編輯頁 textarea 顯示。
 * @param {Array<{text:string, isBold:boolean, isItalic:boolean, linkUrl:string|null}>} segments
 * @returns {string}
 */
export function segmentsToMarkdown(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments.map((s) => {
    let t = s.text || '';
    if (s.linkUrl) t = `[${t}](${s.linkUrl})`;
    if (s.isItalic) t = `*${t}*`;
    if (s.isBold) t = `**${t}**`;
    return t;
  }).join('');
}

/**
 * 編輯頁 markdown → segments 陣列。失敗(罕見)fallback 整段 plain regular,不 throw。
 * @param {string} text
 * @returns {{ segments: Array<{text:string, isBold:boolean, isItalic:boolean, linkUrl:string|null}>, linkUrls: string[] }}
 */
export function markdownToSegments(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { segments: [], linkUrls: [] };
  }
  const segments = [];
  const linkUrls = [];
  let isBold = false;
  let isItalic = false;
  let buffer = '';
  let i = 0;

  function pushSeg(t, b, ital, url) {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last && last.isBold === b && last.isItalic === ital && last.linkUrl === url) {
      last.text += t;
    } else {
      segments.push({ text: t, isBold: b, isItalic: ital, linkUrl: url });
    }
  }
  function flush() {
    if (buffer.length === 0) return;
    pushSeg(buffer, isBold, isItalic, null);
    buffer = '';
  }

  while (i < text.length) {
    if (text.slice(i, i + 2) === '**') {
      flush();
      isBold = !isBold;
      i += 2;
      continue;
    }
    if (text[i] === '*') {
      flush();
      isItalic = !isItalic;
      i += 1;
      continue;
    }
    if (text[i] === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(') {
        const closeP = text.indexOf(')', close + 2);
        if (closeP > close + 1) {
          flush();
          const linkText = text.slice(i + 1, close);
          const url = text.slice(close + 2, closeP);
          pushSeg(linkText, isBold, isItalic, url);
          if (!linkUrls.includes(url)) linkUrls.push(url);
          i = closeP + 1;
          continue;
        }
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return { segments, linkUrls };
}

/**
 * @typedef {Object} TranslateProgress
 * @property {number} totalBlocks
 * @property {number} translatedBlocks
 * @property {number} failedBlocks
 * @property {number} estimatedRemainingSec
 * @property {number} cumulativeInputTokens
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 *
 * @typedef {Object} TranslateSummary
 * @property {number} totalBlocks
 * @property {number} translatedBlocks
 * @property {number} failedBlocks
 * @property {number} cumulativeInputTokens        raw input tokens(折扣前)
 * @property {number} cumulativeBilledInputTokens  billed input tokens(cache 折扣後)
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 * @property {boolean} cancelled
 */
