// translate.js — 文件翻譯 pipeline 協調(W3 起)
//
// 職責:
//   1. 從版面 IR 收集所有「送翻譯」類 block(SPEC §17.4.4)
//   2. 切 chunk(預設 CHUNK_SIZE = 20,跟 content.js 對齊)
//   3. 逐 chunk 透過 chrome.runtime.sendMessage 送 background 的 TRANSLATE_DOC_BATCH
//   4. 結果寫回 IR(每 block.translation / .translationStatus / .translationError)
//   5. 每完成一批 emit progress(SPEC §17.5.4 結構)
//
// 不在這裡:
//   - preset 選擇(由 caller 傳入 modelOverride)
//   - cache key blockType / fontSize 桶位(W3-iter2)
//   - 段落級 retry UI(W5)

// 跟 content.js 共用相同 chunk size,行為一致(rate limiter / token cost / cache 命中規則一致)
export const DOC_CHUNK_SIZE = 20;

// SPEC §17.4.4:這幾種 block type 送翻;其他(formula / table / figure / page-number) 不送
const TRANSLATABLE_TYPES = new Set(['paragraph', 'heading', 'list-item', 'caption', 'footnote']);

/**
 * 翻譯整份 layout doc,結果寫回每個 block。
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

  // 1) 收集所有需翻譯 block(扁平化,保 order 用 readingOrder + page)
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

  emit();

  // 2) 切 chunk 逐批送
  for (let start = 0; start < queue.length; start += DOC_CHUNK_SIZE) {
    if (signal?.aborted) {
      // 標 cancelled,剩下 block 保留 pending(UI 顯示原文)
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


  return {
    totalBlocks,
    translatedBlocks,
    failedBlocks,
    cacheHits,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    cumulativeCostUSD,
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
