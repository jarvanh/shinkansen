// lib/google-translate.js — Google Translate 非官方 API 封裝
// 使用 translate.googleapis.com/translate_a/single?client=gtx 端點（免費，不需 API Key）
// 此端點非官方，無公開文件；業界通例用於瀏覽器擴充功能（Immersive Translation、read-frog 等）。
// 注意：Google 可能隨時更動此端點，屬灰色地帶，不建議作為唯一翻譯引擎。

import { debugLog } from './logger.js';

// U+2063 INVISIBLE SEPARATOR × 3：翻譯過程中幾乎不會被 MT 引擎改動，用作批次分隔符。
const SEP = '\n\u2063\u2063\u2063\n';

// URL encode 後的 SEP 長度約 66 chars，保守上限設 5500，避免伺服器拒絕過長請求。
const MAX_URL_ENCODED_CHARS = 5500;

// Shinkansen targetLanguage → Google Translate `tl` 參數對映。
// Shinkansen 8 種 target(zh-TW / zh-CN / en / ja / ko / es / fr / de)Google
// Translate 端點代號完全一致,不需轉換;未識別的 target 退回 zh-TW(向下相容)。
const SUPPORTED_TL = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de']);

function _normalizeTl(targetLanguage) {
  return SUPPORTED_TL.has(targetLanguage) ? targetLanguage : 'zh-TW';
}

/**
 * 批次翻譯字串陣列（自動偵測語言 → targetLanguage）。
 * 內部用 SEP 串接多段文字為單一請求，若 URL 過長則自動拆多次請求後合併。
 * @param {string[]} texts
 * @param {string} [targetLanguage='zh-TW'] Shinkansen target language code
 * @returns {Promise<{ translations: string[], chars: number }>}
 */
export async function translateGoogleBatch(texts, targetLanguage = 'zh-TW') {
  if (!texts || texts.length === 0) return { translations: [], chars: 0 };

  const tl = _normalizeTl(targetLanguage);

  const totalChars = texts.reduce((s, t) => s + (t?.length || 0), 0);
  const result = new Array(texts.length).fill('');

  // ─── 依 URL 長度分組 ─────────────────────────────────────────
  const groups = [];
  let cur = [];
  let curEncodedLen = 0;
  const encodedSep = encodeURIComponent(SEP).length;

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] || '';
    const eLen = encodeURIComponent(t).length + encodedSep;
    if (cur.length > 0 && curEncodedLen + eLen > MAX_URL_ENCODED_CHARS) {
      groups.push(cur);
      cur = [];
      curEncodedLen = 0;
    }
    cur.push({ idx: i, text: t });
    curEncodedLen += eLen;
  }
  if (cur.length > 0) groups.push(cur);

  // ─── 逐組翻譯，合併回原索引 ──────────────────────────────────
  // needsRetry:暫存「翻完跟原文一樣」的 unit,整批跑完後逐筆 retry。
  // Why retry:Google MT 對「整組大半已經是 target 語言」的混合批次會整批 source 原樣
  // 回傳(自動偵測判定整批 ≈ target,連夾在裡面少數真正需要翻的 unit 也跳過)。
  // 真實案例:X(Twitter)推文討論串裡,引用推文是英文 + 多數回覆是簡中,簡中被偵測
  // 為已是 zh,整組 14 段全部原文 echo,連那段英文引用推文也沒翻。
  // 改 sl=auto → sl=fixed 解不掉(我們不知道每 unit 真實源語言);最穩的補救是
  // 每筆獨立再打一次:單筆送 sl=auto 偵測通常更準,真翻得出來。
  const needsRetry = [];
  for (const group of groups) {
    const joined = group.map(g => g.text).join(SEP);
    const parts = await _fetchTranslate(joined, tl);
    group.forEach((g, j) => {
      const tr = parts[j];
      if (tr == null) {
        // SEP 邊界丟失 → 用原文當 placeholder,稍後逐筆 retry
        result[g.idx] = g.text;
        needsRetry.push(g);
      } else if (tr.trim() === (g.text || '').trim()) {
        // Google MT echo 原文 → 寫入但標記 retry(retry 失敗仍維持此值,呼叫端
        // 會判讀成「已是 target,不需改」)
        result[g.idx] = tr;
        needsRetry.push(g);
      } else {
        result[g.idx] = tr;
      }
    });
  }

  // ─── 逐筆 retry ────────────────────────────────────────────
  if (needsRetry.length > 0) {
    let recoveredCount = 0;
    for (const g of needsRetry) {
      try {
        const single = await _fetchTranslate(g.text, tl);
        const tr = single[0];
        if (tr != null && tr.trim() !== (g.text || '').trim()) {
          result[g.idx] = tr;
          recoveredCount++;
        }
      } catch (_) {
        // 單筆失敗就放著,維持 echo 值;不阻擋整批
      }
    }
    await debugLog('info', 'api', 'google batch retry done', {
      attempted: needsRetry.length,
      recovered: recoveredCount,
    });
  }

  return { translations: result, chars: totalChars };
}

/**
 * 對 Google Translate 非官方端點發出單一 GET 請求，回傳用 SEP 分割的字串陣列。
 */
async function _fetchTranslate(text, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=` +
    encodeURIComponent(text);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Google Translate HTTP ${resp.status}`);

  const data = await resp.json();
  // 回應格式：[[[譯文片段, 原文片段, ...], ...], ...]
  // 取 data[0] 的所有陣列元素的第一個欄位串接即完整譯文
  const full = (data[0] || [])
    .filter(Array.isArray)
    .map(chunk => chunk[0] || '')
    .join('');

  return full.split(SEP);
}
