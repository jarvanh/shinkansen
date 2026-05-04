// translate.js — 文件翻譯 pipeline 協調(W3 起)
//
// 職責：
//   1. 從版面 IR 收集所有「送翻譯」類 block(SPEC §17.4.4)
//   2. 切 chunk(預設 CHUNK_SIZE = 20，跟 content.js 對齊)
//   3. 逐 chunk 透過 chrome.runtime.sendMessage 送 background 的 TRANSLATE_DOC_BATCH
//   4. 結果寫回 IR(每 block.translation / .translationStatus / .translationError)
//   5. 每完成一批 emit progress(SPEC §17.5.4 結構)
//
// 不在這裡：
//   - preset 選擇(由 caller 傳入 modelOverride)
//   - cache key blockType / fontSize 桶位(W3-iter2)
//   - 段落級 retry UI(W5)

// 跟 content.js 共用相同 chunk size，行為一致(rate limiter / token cost / cache 命中規則一致)
export const DOC_CHUNK_SIZE = 20;

// SPEC §17.4.4：這幾種 block type 送翻；其他(formula / table / figure / page-number) 不送
const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

/**
 * 翻譯整份 layout doc，結果寫回每個 block。
 *
 * @param {LayoutDoc} doc                  — analyzeLayout 輸出
 * @param {object}    options
 * @param {string}    [options.modelOverride] — preset 對應的 Gemini model id
 * @param {Array}     [options.glossary]      — 額外術語表(可選)
 * @param {AbortSignal} [options.signal]      — 取消信號
 * @param {(progress: TranslateProgress) => void} [options.onProgress]
 * @returns {Promise<TranslateSummary>}
 */
export async function translateDocument(doc, options = {}) {
  const { modelOverride, glossary, signal, onProgress = () => {} } = options;
  const startTime = Date.now();

  // 1) 收集所有需翻譯 block(扁平化，保 order 用 readingOrder + page)
  const queue = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (TRANSLATABLE_TYPES.has(block.type) && block.plainText && block.plainText.trim().length > 0) {
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
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCostUSD = 0;
  const batchTimes = [];

  console.log('[Shinkansen] translateDocument start', {
    filename: doc.meta?.filename,
    totalBlocks,
    chunks: Math.ceil(totalBlocks / DOC_CHUNK_SIZE),
    chunkSize: DOC_CHUNK_SIZE,
    modelOverride: modelOverride || '(default)',
    pages: doc.pages.length,
  });

  emit();

  // 2) 切 chunk 逐批送
  for (let start = 0; start < queue.length; start += DOC_CHUNK_SIZE) {
    if (signal?.aborted) {
      // 標 cancelled，剩下 block 保留 pending(UI 顯示原文)
      for (let j = start; j < queue.length; j++) {
        queue[j].translationStatus = 'cancelled';
      }
      break;
    }

    const chunk = queue.slice(start, start + DOC_CHUNK_SIZE);
    const texts = chunk.map((b) => b.plainText);

    chunk.forEach((b) => { b.translationStatus = 'translating'; });
    emit();

    const t0 = Date.now();
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_DOC_BATCH',
        payload: { texts, modelOverride, glossary },
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
      const msg = (response && response.error) || 'no response';
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
    cumulativeInputTokens += usage.billedInputTokens || usage.inputTokens || 0;
    cumulativeOutputTokens += usage.outputTokens || 0;
    cumulativeCostUSD += usage.billedCostUSD || usage.costUSD || 0;
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
        b.translation = tr;
        b.translationStatus = 'done';
      } else {
        b.translation = null;
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
    cumulativeOutputTokens,
    cumulativeCostUSD: Number(cumulativeCostUSD.toFixed(6)),
    durationMs,
    cancelled: !!signal?.aborted,
  });

  // 用量寫進「用量紀錄」(IndexedDB，跟網頁翻譯共用 LOG_USAGE handler)
  // 全 cache hit 場景 background 端 shouldSkipUsageRecord 會自動跳過，不污染列表
  try {
    const filename = (doc.meta && doc.meta.filename) || 'unknown.pdf';
    await chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url: `pdf://${filename}`,
        title: filename,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        cachedTokens: 0,
        billedInputTokens: cumulativeInputTokens,
        billedCostUSD: cumulativeCostUSD,
        segments: totalBlocks,
        cacheHits,
        durationMs,
        timestamp: Date.now(),
        engine: 'gemini',
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
    const remainingChunks = Math.max(0, Math.ceil((totalBlocks - translatedBlocks) / DOC_CHUNK_SIZE));
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
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function translateSingleBlock(block, options = {}) {
  const { modelOverride, glossary } = options;
  if (!block || !block.plainText) return { ok: false, error: 'no plainText' };

  console.log('[Shinkansen] retry block', block.blockId, 'modelOverride=', modelOverride || '(default)');

  block.translationStatus = 'translating';
  block.translationError = null;
  const startTime = Date.now();

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_DOC_BATCH',
      payload: { texts: [block.plainText], modelOverride, glossary },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    block.translationStatus = 'failed';
    block.translationError = msg;
    console.warn('[Shinkansen] retry sendMessage 失敗', block.blockId, msg);
    return { ok: false, error: msg };
  }

  if (!response || !Array.isArray(response.result) || response.result.length === 0) {
    const msg = (response && response.error) || 'no response';
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
        inputTokens: usage.billedInputTokens || usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cachedTokens: 0,
        billedInputTokens: usage.billedInputTokens || 0,
        billedCostUSD: usage.billedCostUSD || 0,
        segments: 1,
        cacheHits: usage.cacheHits || 0,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
        engine: 'gemini',
        model: modelOverride || null,
        source: 'translate-doc-retry',
      },
    });
  } catch (_) { /* swallow */ }

  const tr = response.result[0];
  if (typeof tr === 'string' && tr.length > 0) {
    block.translation = tr;
    block.translationStatus = 'done';
    block.translationError = null;
    console.log('[Shinkansen] retry block done', block.blockId, 'tr=', tr.slice(0, 40));
    return { ok: true };
  } else {
    block.translation = null;
    block.translationStatus = 'failed';
    block.translationError = 'empty translation';
    console.warn('[Shinkansen] retry empty translation', block.blockId);
    return { ok: false, error: 'empty translation' };
  }
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
 * @property {number} cumulativeInputTokens
 * @property {number} cumulativeOutputTokens
 * @property {number} cumulativeCostUSD
 * @property {boolean} cancelled
 */
