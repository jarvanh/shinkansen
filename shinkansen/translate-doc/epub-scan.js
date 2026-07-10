// epub-scan.js — 譯後一致性掃描（v2.0.11，SPEC §17.10.10）
//
// 純函式模組：不碰 DOM / storage / 訊息層，掃描邏輯可單獨驗證。
// 兩層訊號（訊號層分工，工作流原則 §3）：
//   第一層 checkGlossaryCompliance —— 術語表符合度（確定性，零 API 費用）：
//     原文含術語表 source 的已翻段落，譯文必須含指定譯名（noTranslate 則含原文）
//   第二層 mineCandidates / buildScanBatches / aggregateRenderings ——
//     術語表外「同一原文多譯名」漂移。候選挖掘與聚合是確定性；
//     「譯名對照抽取」（原文詞在譯文中的實際譯法）由 background
//     SCAN_TERM_RENDERINGS 的 LLM 呼叫完成，本模組只負責前後處理
// 本模組驗「同一 source 多譯名 / 指定譯名缺席」，不驗「單一譯名但翻得差」
// （品質問題交給 prompt / 模型，不歸一致性掃描管）。

// 「譯文（原文）」對照式譯名（同 index.js ANNOTATED_TARGET_RE 語意）：
// 符合度比對取全形括號前的本體
const ANNOTATED_RE = /^(.+)（(.+)）\s*$/;

const RE_ASCII_ONLY = /^[\x20-\x7E]+$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 拉丁詞邊界（結構性通則：不讓 'Ann' 命中 'Announcement'）；
// 非拉丁 term 用純 substring。
// compileTermMatcher：term 只編譯一次回傳比對函式——checkGlossaryCompliance 是
// entry × block 雙迴圈（大書 500 條 × 數千段 = 百萬次比對），逐次 new RegExp
// 會造成主執行緒秒級卡頓；無 /g flag 的 RegExp.test 無狀態，可安全重用
function compileTermMatcher(term) {
  if (!term) return () => false;
  if (RE_ASCII_ONLY.test(term)) {
    const re = new RegExp(`(?<![A-Za-z])${escapeRe(term)}(?![A-Za-z])`);
    return (text) => !!text && re.test(text);
  }
  return (text) => !!text && text.includes(term);
}

function sourceHasTerm(text, term) {
  return compileTermMatcher(term)(text);
}

export { sourceHasTerm };

function doneBlocks(chapters) {
  const out = [];
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (b.translationStatus !== 'done') continue;
      if (typeof b.plainText !== 'string' || typeof b.translation !== 'string') continue;
      out.push({ ch, b });
    }
  }
  return out;
}

/**
 * 第一層：術語表符合度掃描（確定性）。
 * @returns [{ source, expected, noTranslate, chapterIndex, chapterTitle, blockId, excerpt }]
 */
export function checkGlossaryCompliance(chapters, glossary, { maxViolations = 200 } = {}) {
  const violations = [];
  if (!Array.isArray(glossary) || glossary.length === 0) return violations;
  const blocks = doneBlocks(chapters);
  for (const entry of glossary) {
    if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) continue;
    const source = entry.source.trim();
    // noTranslate：譯文須保留原文；一般 entry：譯文須含譯名本體
    //（entry.target 可能是「譯名（原文）」對照格式，取括號前本體；
    //  含本體即算符合——對照 dedupe 後處理去掉括號也不誤報）
    let expected;
    if (entry.noTranslate === true) {
      expected = source;
    } else {
      if (typeof entry.target !== 'string' || !entry.target.trim()) continue;
      const m = entry.target.trim().match(ANNOTATED_RE);
      expected = (m ? m[1] : entry.target).trim();
    }
    if (!expected) continue;
    const hasTerm = compileTermMatcher(source);
    for (const { ch, b } of blocks) {
      if (!hasTerm(b.plainText)) continue;
      if (b.translation.includes(expected)) continue;
      violations.push({
        source,
        expected,
        noTranslate: entry.noTranslate === true,
        chapterIndex: ch.index,
        chapterTitle: ch.title || '',
        blockId: b.blockId,
        excerpt: excerptAround(b.plainText, source),
      });
      if (violations.length >= maxViolations) return violations;
    }
  }
  return violations;
}

function excerptAround(text, term, radius = 60) {
  const idx = text.indexOf(term);
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// 拉丁專有名詞候選：連續 Capitalized 詞組；片假名連串（日文源書的人名/外來語）
const RE_LATIN_NAME = /[A-Z][A-Za-z''-]+(?:\s+[A-Z][A-Za-z''-]+)*/g;
const RE_KATAKANA = /[ァ-ヺー・]{2,}/g;

/**
 * 第二層前段：候選詞挖掘（確定性）。
 * 規則（全部結構性，不綁語言黑名單）：
 *   - 只看已翻段落的原文
 *   - 單詞候選長度 ≥3，且其小寫形不在全書詞彙表（過濾句首普通詞如 The / She）
 *   - 單詞候選若 >50% 出現時後面緊跟另一個大寫詞 → 視為稱謂前綴（Mr / Mrs /
 *     Lady…）丟棄——它是別的名字的一部分，不是獨立譯名單位
 *   - 已在術語表的 source 不重複掃（第一層管它們）
 *   - 出現於 ≥minBlocks 個不同段落才有「跨段漂移」可言
 * @returns [{ term, blocks: [{ chapterIndex, blockId }], count }]
 */
export function mineCandidates(chapters, glossary, { minBlocks = 2, maxCandidates = 120 } = {}) {
  const blocks = doneBlocks(chapters);
  if (blocks.length === 0) return [];

  // 全書「原文中以小寫出現過」的詞彙表（過濾「碰巧在句首被大寫」的普通詞：
  // The / She / When… 這些詞在書中其他位置必以小寫出現；真人名不會有小寫形）。
  // 注意不可把整段 lowercase 再收集——那會讓每個大寫詞的小寫形都「存在」
  const lowerWords = new Set();
  for (const { b } of blocks) {
    for (const m of b.plainText.matchAll(/(?<![A-Za-z])[a-z][a-z''-]*/g)) {
      lowerWords.add(m[0]);
    }
  }
  const glossSources = new Set(
    (Array.isArray(glossary) ? glossary : [])
      .filter((e) => e && typeof e.source === 'string')
      .map((e) => e.source.trim().toLowerCase()),
  );

  const map = new Map(); // term -> { blocks: Map(blockId -> ref), count }
  const addHit = (term, ch, b) => {
    let rec = map.get(term);
    if (!rec) {
      rec = { blocks: new Map(), count: 0 };
      map.set(term, rec);
    }
    rec.count++;
    if (!rec.blocks.has(b.blockId)) {
      rec.blocks.set(b.blockId, { chapterIndex: ch.index, blockId: b.blockId });
    }
  };

  const corpusParts = [];
  for (const { ch, b } of blocks) {
    corpusParts.push(b.plainText);
    for (const m of b.plainText.matchAll(RE_LATIN_NAME)) addHit(m[0], ch, b);
    for (const m of b.plainText.matchAll(RE_KATAKANA)) addHit(m[0], ch, b);
  }
  const corpus = corpusParts.join('\n');

  const out = [];
  for (const [term, rec] of map) {
    if (rec.blocks.size < minBlocks) continue;
    if (glossSources.has(term.toLowerCase())) continue;
    const isLatin = RE_ASCII_ONLY.test(term);
    const isSingleWord = isLatin && !/\s/.test(term);
    if (isSingleWord) {
      if (term.length < 3) continue;
      if (lowerWords.has(term.toLowerCase())) continue; // 句首大寫的普通詞
      // 稱謂前綴偵測：多數出現緊跟另一個大寫詞 → 是長名字的一部分
      const followedByCap = [...corpus.matchAll(new RegExp(`(?<![A-Za-z])${escapeRe(term)}\\.?\\s+[A-Z]`, 'g'))].length;
      if (rec.count > 1 && followedByCap / rec.count > 0.5) continue;
    }
    out.push({ term, blocks: [...rec.blocks.values()], count: rec.count });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, maxCandidates);
}

/**
 * 第二層中段：把候選詞 + 取樣譯文段組成送 LLM 的批次。
 * 取樣分散取（頭 / 尾 / 均勻），比取前 k 段更能抓到跨書漂移。
 * @param blockById Map(blockId -> block)
 * @returns [{ items: [{ term, samples: [{ blockId, text }] }] }]
 */
export function buildScanBatches(candidates, blockById, {
  samplePerTerm = 6, maxItemsPerBatch = 30, maxCharsPerBatch = 12000, sampleChars = 600,
} = {}) {
  const batches = [];
  let cur = { items: [] };
  let curChars = 0;
  for (const cand of candidates) {
    const picked = spreadPick(cand.blocks, samplePerTerm);
    const samples = [];
    for (const ref of picked) {
      const b = blockById.get(ref.blockId);
      if (!b || typeof b.translation !== 'string' || !b.translation) continue;
      samples.push({ blockId: ref.blockId, text: b.translation.slice(0, sampleChars) });
    }
    if (samples.length < 2) continue; // 只剩一段可比 → 無漂移可言
    const chars = samples.reduce((n, s) => n + s.text.length, cand.term.length);
    if (cur.items.length >= maxItemsPerBatch || (curChars + chars > maxCharsPerBatch && cur.items.length > 0)) {
      batches.push(cur);
      cur = { items: [] };
      curChars = 0;
    }
    cur.items.push({ term: cand.term, samples });
    curChars += chars;
  }
  if (cur.items.length > 0) batches.push(cur);
  return batches;
}

function spreadPick(arr, k) {
  if (arr.length <= k) return arr.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
  }
  // Math.round 可能重複取同 index，去重
  return [...new Map(out.map((x) => [x.blockId, x])).values()];
}

/**
 * 第二層後段：聚合 LLM 對照結果 → 漂移案例。
 * 防幻覺守門（確定性）：LLM 回的譯名必須真的出現在對應取樣譯文裡，否則丟棄。
 * @param collected [{ items, results }]：results 與 items 對齊
 *   （results = [{ term, renderings: [str] }]，renderings[i] 對應 samples[i]）
 * @returns [{ term, renderings: [{ text, blockIds, count }] }]（僅譯名 ≥2 種的）
 */
export function aggregateRenderings(collected) {
  const byTerm = new Map(); // term -> Map(rendering -> Set(blockId))
  for (const { items, results } of collected) {
    if (!Array.isArray(items) || !Array.isArray(results)) continue;
    for (const item of items) {
      const res = results.find((r) => r && r.term === item.term);
      if (!res || !Array.isArray(res.renderings)) continue;
      for (let i = 0; i < item.samples.length; i++) {
        const raw = res.renderings[i];
        if (typeof raw !== 'string') continue;
        const rendering = raw.trim();
        if (!rendering) continue;
        if (!item.samples[i].text.includes(rendering)) continue; // 幻覺守門
        let renderMap = byTerm.get(item.term);
        if (!renderMap) {
          renderMap = new Map();
          byTerm.set(item.term, renderMap);
        }
        let ids = renderMap.get(rendering);
        if (!ids) {
          ids = new Set();
          renderMap.set(rendering, ids);
        }
        ids.add(item.samples[i].blockId);
      }
    }
  }
  const cases = [];
  for (const [term, renderMap] of byTerm) {
    if (renderMap.size < 2) continue;
    // 互為子字串的譯名視為同一個（「普爾」⊂「老普爾」是稱謂 / 修飾差異，非漂移）
    const renderings = [...renderMap.entries()]
      .map(([text, ids]) => ({ text, blockIds: [...ids], count: ids.size }))
      .sort((a, b) => b.count - a.count);
    const distinct = renderings.filter((r, i) =>
      !renderings.some((other, j) => j < i && (other.text.includes(r.text) || r.text.includes(other.text))));
    if (distinct.length < 2) continue;
    cases.push({ term, renderings: distinct });
  }
  cases.sort((a, b) => b.renderings[0].count - a.renderings[0].count);
  return cases;
}
