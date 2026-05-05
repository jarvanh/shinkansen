// layout-analyzer.js — 把 raw text run 轉成版面 IR(SPEC §17.4.2 / §17.4.3)
//
// W2-iter4(目前):
//   1. text run → line:y_top 接近的 run merge 成「視覺行」+ 同 line 的 run x 不能
//      離既有右緣超過 X_GAP_RATIO × medianLineHeight (避免雙欄第一行被誤合併)
//   2. line → column:1-D K-means(k=1/2/3)+ silhouette score 選最佳 k,column 中心
//      過近時降階，並要求每欄至少有 MIN_COLUMN_LINE_RATIO 的 line(避免少量裝飾元素
//      觸發誤判雙欄)
//   3. column → block：同欄內按 y_top 由小到大(視覺由上往下)，垂直間距 >
//      FACTOR × medianLineHeight 切 block
//   4. reading order：跨欄 by column index、欄內 by y_top 升序
//   5. block type 啟發式：依 fontSize / 位置 / 第一字元 / 行寬 pattern 推 heading /
//      list-item / footnote / page-number / table / paragraph
//
// 座標系：全部 canvas 座標(y 由上往下，套過 viewport.transform)。bbox = [left, top, right, bottom]
//
// 後續 iter:
//   W2-iter5: plainText 構建加 de-hyphenation + 行尾續行銜接(SPEC §17.4.4)
//   W2-iter6: caption / formula / figure 偵測(需 getOperatorList 抓圖片框線 op)

// ----- 啟發式參數 -----

// 同視覺行的 y_top 容忍誤差(pt)。同一行 baseline 可能因上下標、字型差略有微差。
const SAME_LINE_Y_TOLERANCE = 2;

// 同視覺行的 run 與既有右緣的最大 x 間距(以 medianLineHeight 為單位)：超過視為
// 「跨欄同 y」不該合併。Wikipedia / 雙欄論文 / 兩欄聯絡資訊兩欄第一行 baseline 可能接近，
// 不加這條會被誤合併成單一跨欄 line。
const SAME_LINE_MAX_X_GAP_FACTOR = 4;

// 兩條相鄰 line 的「行間距 ÷ medianLineHeight」超過此倍數即切 block
// (1.5 為平衡點：1.3 切太細製造假陽性，1.6 對 spec sheet 太嚴。實測在 17 份 PDF
// 樣本上 1.5 是 short-paragraph 假陽性 / huge-block 漏切的最佳折衷)
const VERTICAL_GAP_FACTOR = 1.5;

// 兩條相鄰 line 的字級差超過此倍數的 medianLineHeight 即切 block(分離 heading / body)
// 同一 line 內不同字級的 run 在 groupIntoLines 已合成同 line，這條只看 line 之間
const LINE_FONT_SIZE_DELTA_FACTOR = 0.5;

// dominant fontName 純度閾值：line 內單一 fontName 字數佔比 ≥ 此值才認為「整行同字型」
// (低於此值代表 line 內混了 italic / bold 等 inline emphasis，不該觸發 fontName 切點)
const DOMINANT_FONT_NAME_PURITY_RATIO = 0.95;

// Column 偵測：中心相距 < pageWidth × COLUMN_MIN_GAP_RATIO 視為同欄(SPEC §17.4.3)
const COLUMN_MIN_GAP_RATIO = 0.3;

// Column 偵測：k=1 / k=2 / k=3 三組 silhouette score,score 差 < 此閾值時偏好較小 k
const SILHOUETTE_BIAS_TO_FEWER_COLUMNS = 0.08;

// Column 偵測：最弱欄 line 數佔比若 < MIN_COLUMN_LINE_RATIO 則降階(避免少量裝飾元素
// 觸發誤判雙欄；典型場景：Quotation 的「Quotation 標題 / TTL / Lucy Chou」三條右半 line
// 不該獨立成欄)
const MIN_COLUMN_LINE_RATIO = 0.18;

// K-means 收斂上限(text run 數量有限，實務 5-10 步即收斂)
const KMEANS_MAX_ITERS = 30;

// ----- Block type 分類啟發式參數 -----

// heading:fontSize > body × HEADING_FONT_SIZE_FACTOR + 字數 < HEADING_MAX_CHARS
const HEADING_FONT_SIZE_FACTOR = 1.2;
const HEADING_MAX_CHARS = 200;

// footnote:fontSize < body × FOOTNOTE_FONT_SIZE_FACTOR + 位於頁面下方 FOOTNOTE_BOTTOM_THRESHOLD
const FOOTNOTE_FONT_SIZE_FACTOR = 0.85;
const FOOTNOTE_BOTTOM_THRESHOLD = 0.75;

// page-number：位於頁首 / 頁尾 PAGE_NUMBER_EDGE_RATIO 內
const PAGE_NUMBER_EDGE_RATIO = 0.1;

// table:block 內 line 數 ≥ TABLE_MIN_LINES + 平均每行字數 < TABLE_MAX_AVG_CHARS
// + 行寬有規律的「跳躍」(line 之間 left 不單調) → 視為表格性 block
const TABLE_MIN_LINES = 4;
const TABLE_MAX_AVG_CHARS = 35;

// list-item sub-split：當 block 內 ≥ LIST_SUBSPLIT_MIN_LINES 行 + 多數行起首是 list
// marker 時，按 marker 切多個 block。處理「60 行 spec list 整段一個 block」場景。
const LIST_SUBSPLIT_MIN_LINES = 5;
const LIST_SUBSPLIT_MARKER_RATIO = 0.6; // 多數行起首必須是 marker 才切
const LIST_MARKER_RE = /^\s*(?:[-•·*–—]|\d+[.)]|\([a-zA-Z0-9]+\))\s/;

/**
 * 主入口：接受 W1 parsePdf 的 raw doc，回傳版面 IR doc。
 *
 * @param {RawPdfDocument} rawDoc — pdf-engine.js parsePdf 輸出
 * @returns {LayoutDoc}
 */
export function analyzeLayout(rawDoc) {
  const pages = rawDoc.pages.map((rawPage) => analyzePage(rawPage));
  return {
    meta: rawDoc.meta,
    pages,
    stats: rawDoc.stats,
    warnings: rawDoc.warnings,
    pdfDoc: rawDoc.pdfDoc,
  };
}

function analyzePage(rawPage) {
  const out = {
    pageIndex: rawPage.pageIndex,
    viewport: rawPage.viewport,
    blocks: [],
    medianLineHeight: 0,
    columnCount: 1,
  };
  const runs = (rawPage.textRuns || []).slice();
  if (runs.length === 0) return out;

  // 1) medianLineHeight：用 run height 中位數估，作為「同行容忍」與「切 block」的 baseline (forwarded)
  const runHeights = runs
    .map((r) => r.bbox[3] - r.bbox[1])
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianLineHeight = runHeights.length > 0
    ? runHeights[Math.floor(runHeights.length / 2)]
    : 12;
  out.medianLineHeight = medianLineHeight;

  // 2) 同視覺行 merge → lines(用 medianLineHeight 算 same-line max x gap)
  const lines = groupIntoLines(runs, medianLineHeight);
  if (lines.length === 0) return out;

  // 2.5) 標「同一視覺行」的兄弟 line — same-line x gap 太大被切散的多條 line(典型:
  //      News Release 第一行「For Immediate Release ............ February 12, 2024」
  //      左右分置)。後續 splitColumnIntoBlocks 對 siblingsInRow 強制切獨立 block,
  //      避免 plainText 把左右兩段 collapse 成單一字串送 LLM,譯文還原無法分置
  markSiblingsInRow(lines, medianLineHeight);

  // 3) Column 偵測：對每條 line 的 left 跑 K-means
  const pageWidth = rawPage.viewport.width || 0;
  const columnAssignments = detectColumns(lines, pageWidth);
  out.columnCount = columnAssignments.columnCount;

  // 4) 同 column 內切 block(canvas 座標，top 升序 = 視覺由上往下)
  const initialBlocks = [];
  for (let colIdx = 0; colIdx < columnAssignments.columnCount; colIdx++) {
    const colLines = lines.filter((_, i) => columnAssignments.assignment[i] === colIdx);
    colLines.sort((a, b) => a.bbox[1] - b.bbox[1]);
    const colBlocks = splitColumnIntoBlocks(colLines, medianLineHeight, colIdx);
    initialBlocks.push(...colBlocks);
  }

  // 4.5a) heading sub-split：掃 block 內每行，找「heading-shaped」line 切成獨立 block。
  //       條件：lines[i].dominantFontName 與 block majority 不同 + 字數短 + 前面有比正常
  //       leading 大的 gap(防 inline italic 引文整行誤切；heading 前通常多一行 spacing)
  const afterHeadingSplit = [];
  for (const b of initialBlocks) {
    afterHeadingSplit.push(...maybeSplitHeadingsAcrossBlock(b, medianLineHeight));
  }

  // 4.5b) list-item sub-split：大 block 內若多數行起首是 list marker，按 marker 切多個 block
  const blocks = [];
  for (const b of afterHeadingSplit) {
    const subBlocks = maybeSubsplitListBlock(b);
    blocks.push(...subBlocks);
  }

  // 5) reading order：跨欄按 column 升序、同欄按 top 升序(視覺由上往下)
  blocks.sort((a, b) => {
    if (a.column !== b.column) return a.column - b.column;
    return a.bbox[1] - b.bbox[1];
  });
  blocks.forEach((b, i) => { b.readingOrder = i; });

  // 給每個 block 配個穩定 id(reading order 排完才分配，確保 id 連續)
  blocks.forEach((b, i) => { b.blockId = `p${rawPage.pageIndex}-b${i}`; });

  // 6) block type 啟發式分類(SPEC §17.4.3)
  const bodyFontSize = computeBodyFontSize(blocks);
  const ctx = {
    bodyFontSize,
    pageWidth: rawPage.viewport.width,
    pageHeight: rawPage.viewport.height,
  };
  for (const b of blocks) {
    b.type = classifyBlockType(b, ctx);
  }

  // 7) reading order:footnote / page-number 一律排在該頁所有其他 block 之後
  // (SPEC §17.4.3「Reading order 例外」)
  const tail = blocks.filter((b) => b.type === 'footnote' || b.type === 'page-number');
  if (tail.length > 0 && tail.length < blocks.length) {
    const head = blocks.filter((b) => b.type !== 'footnote' && b.type !== 'page-number');
    const reordered = [...head, ...tail];
    reordered.forEach((b, i) => { b.readingOrder = i; });
    out.blocks = reordered;
  } else {
    out.blocks = blocks;
  }
  out.bodyFontSize = bodyFontSize;
  return out;
}

// ---------- Body fontSize estimate(供 type 分類比較) ----------

function computeBodyFontSize(blocks) {
  // 對每 block 的 fontSize 用 lineCount 加權(段落級 block 通常 line 多 → 是 body)
  // 取加權樣本的中位數
  const weighted = [];
  for (const b of blocks) {
    if (!b.fontSize) continue;
    for (let i = 0; i < b.lineCount; i++) weighted.push(b.fontSize);
  }
  if (weighted.length === 0) return 12;
  weighted.sort((a, b) => a - b);
  return weighted[Math.floor(weighted.length / 2)];
}

// ---------- Block type 分類 ----------

function classifyBlockType(block, ctx) {
  const { plainText = '', bbox, fontSize = 0, lineCount = 1 } = block;
  const { bodyFontSize, pageHeight, pageWidth } = ctx;
  const trimmed = plainText.trim();
  if (trimmed.length === 0) return 'paragraph';

  const blockTop = bbox[1];
  const blockBottom = bbox[3];
  const blockMidY = (blockTop + blockBottom) / 2;
  const blockWidth = bbox[2] - bbox[0];

  // 1) page-number：純數字 / "Page N" / "N of M" + 位於頁首或頁尾 + lineCount=1
  // 字級不限——某些 PDF 頁碼字級跟 body 接近
  const pageNumRe = /^(?:page\s+)?(\d+|\d+\s*\/\s*\d+|\d+\s+of\s+\d+)\.?$/i;
  if (lineCount === 1 && pageNumRe.test(trimmed)) {
    const inTopEdge = blockMidY < pageHeight * PAGE_NUMBER_EDGE_RATIO;
    const inBottomEdge = blockMidY > pageHeight * (1 - PAGE_NUMBER_EDGE_RATIO);
    if (inTopEdge || inBottomEdge) return 'page-number';
  }

  // 2) footnote:fontSize 比 body 小一截 + 位於頁面下方 1/4 + 第一字元為 footnote marker
  const footnoteMarkerRe = /^(?:[0-9]+[.)]|[\^*†‡§])/;
  if (
    fontSize > 0 &&
    bodyFontSize > 0 &&
    fontSize < bodyFontSize * FOOTNOTE_FONT_SIZE_FACTOR &&
    blockTop > pageHeight * FOOTNOTE_BOTTOM_THRESHOLD &&
    footnoteMarkerRe.test(trimmed)
  ) {
    return 'footnote';
  }

  // 3) heading:fontSize 比 body 大一截 + 字數短(短句不容易是長段落)
  if (
    fontSize > 0 &&
    bodyFontSize > 0 &&
    fontSize > bodyFontSize * HEADING_FONT_SIZE_FACTOR &&
    trimmed.length < HEADING_MAX_CHARS
  ) {
    return 'heading';
  }

  // 4) list-item：第一字元 ∈ bullet / dash / asterisk 集合，或開頭為 "1." / "1)"
  const firstChar = trimmed.charAt(0);
  if ('•·-–—*'.includes(firstChar)) return 'list-item';
  if (/^\d+[.)]\s/.test(trimmed)) return 'list-item';
  if (/^\(?[a-zA-Z]\)\s/.test(trimmed)) return 'list-item';

  // 5) table(layout-only，不依賴 operator list):
  //    block 內 line 數 ≥ 4 + 平均每行字數短 + line bbox left 不單調(同 row 中
  //    cell 排列規律但跳躍)→ 視為表格。這是粗判，W2-iter6 加 operator list 補強
  if (lineCount >= TABLE_MIN_LINES && (block._devLines || []).length > 0) {
    const lines = block._devLines;
    const avgChars = lines.reduce((s, l) => s + (l.text || '').length, 0) / lines.length;
    if (avgChars < TABLE_MAX_AVG_CHARS) {
      // 看 line left 是否有大跳躍(≥ blockWidth × 0.2)的次數；表格通常 cell 對齊不同欄
      let leftJumps = 0;
      for (let i = 1; i < lines.length; i++) {
        const dl = Math.abs(lines[i].bbox[0] - lines[i - 1].bbox[0]);
        if (dl > blockWidth * 0.2) leftJumps++;
      }
      // line 數的 ≥ 25% 出現 left 跳躍 = 規律切換 cell
      if (leftJumps >= Math.max(2, Math.floor(lines.length * 0.25))) {
        return 'table';
      }
    }
  }

  // 6) paragraph(預設)
  return 'paragraph';
}

// ---------- 1) 同視覺行 merge(canvas 座標) ----------

function groupIntoLines(runs, medianLineHeight) {
  // 先按 top 升序(canvas 座標 = 視覺由上往下);top 接近時按 left 升序
  const sorted = runs.slice().sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > SAME_LINE_Y_TOLERANCE) return dy;
    return a.bbox[0] - b.bbox[0];
  });

  const sameLineMaxXGap = medianLineHeight * SAME_LINE_MAX_X_GAP_FACTOR;

  const lines = [];
  let currentLine = null;
  for (const run of sorted) {
    if (!currentLine) {
      currentLine = newLineFromRun(run);
      continue;
    }
    // 1) y_top 必須在容忍範圍內(canvas 座標)
    const sameRowY = Math.abs(run.bbox[1] - currentLine.refTop) <= SAME_LINE_Y_TOLERANCE;
    // 2) x 不能距既有 line 的右緣太遠——避免雙欄第一行 baseline 接近時被誤合併
    //    把「x 與 currentLine 既有 bbox 重疊或相鄰一段距離」視為同行
    const xGap = run.bbox[0] - currentLine.bbox[2]; // 正值 = run 在 line 右邊有空白；負值 = 重疊
    const sameRowX = xGap <= sameLineMaxXGap;
    if (sameRowY && sameRowX) {
      currentLine.runs.push(run);
      currentLine.bbox = unionBBox(currentLine.bbox, run.bbox);
    } else {
      lines.push(finalizeLine(currentLine));
      currentLine = newLineFromRun(run);
    }
  }
  if (currentLine) lines.push(finalizeLine(currentLine));
  return lines;
}

function newLineFromRun(run) {
  return {
    runs: [run],
    bbox: run.bbox.slice(),
    refTop: run.bbox[1],
  };
}

function finalizeLine(line) {
  // line 內 run 按 x0 升序，讓拼字順序對
  line.runs.sort((a, b) => a.bbox[0] - b.bbox[0]);
  // line 級資訊
  const fontSizes = line.runs.map((r) => r.fontSize || 0).filter((s) => s > 0);
  const dominantFontSize = fontSizes.length > 0
    ? fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length
    : 0;
  // dominant fontName：只在「整行 ≥ DOMINANT_FONT_NAME_PURITY_RATIO 字數同一 fontName」
  // 時才設，否則設空字串。這條規則服務「heading 整行純粹單一字型 vs body 含 inline
  // italic 混字型」的辨識——body 含 italic emphasis 時 dominantFontName 會留空，
  // splitColumnIntoBlocks 比對時兩端都需有值才切，空字串不觸發誤切。
  const fontCounts = new Map();
  let totalChars = 0;
  for (const r of line.runs) {
    const fn = r.fontName || '';
    if (!fn) continue;
    const n = r.text ? r.text.length : 0;
    fontCounts.set(fn, (fontCounts.get(fn) || 0) + n);
    totalChars += n;
  }
  let dominantFontName = '';
  if (totalChars > 0) {
    let maxChars = 0;
    let candidate = '';
    for (const [fn, n] of fontCounts) {
      if (n > maxChars) { maxChars = n; candidate = fn; }
    }
    if (maxChars / totalChars >= DOMINANT_FONT_NAME_PURITY_RATIO) {
      dominantFontName = candidate;
    }
  }
  return {
    runs: line.runs,
    bbox: line.bbox,
    fontSize: dominantFontSize,
    dominantFontName,
    plainText: line.runs.map((r) => r.text).join(''),
  };
}

// ---------- 2) Column 偵測：1-D K-means + silhouette ----------

function detectColumns(lines, pageWidth) {
  // 每條 line 的 left 為 feature
  const xs = lines.map((l) => l.bbox[0]);

  // 候選 k 從 1 到 3
  const candidates = [];
  for (let k = 1; k <= 3; k++) {
    if (xs.length < k) break;
    const result = kmeans1d(xs, k);
    if (!result) continue;
    // 邊界 1：中心相距太近的 k 不採用(避免縮排被當多欄)
    const minGap = pageWidth > 0 ? pageWidth * COLUMN_MIN_GAP_RATIO : 0;
    if (k > 1 && minPairwiseGap(result.centers) < minGap) continue;
    // 邊界 2：最弱 cluster 的 line 數佔比 < MIN_COLUMN_LINE_RATIO 不採用
    // (避免少量裝飾元素 / 浮動標題觸發誤判；典型場景：Quotation 右半三條 single-line
    // 元素被 K-means 視為第二欄，但其實主內容仍是單欄)
    if (k > 1) {
      const counts = new Array(k).fill(0);
      for (const a of result.assignment) counts[a]++;
      const minRatio = Math.min(...counts) / xs.length;
      if (minRatio < MIN_COLUMN_LINE_RATIO) continue;
    }
    const score = k === 1 ? 0 : silhouetteScore(xs, result.assignment, result.centers);
    candidates.push({ k, ...result, score });
  }

  if (candidates.length === 0) {
    return {
      columnCount: 1,
      assignment: lines.map(() => 0),
      centers: [0],
    };
  }

  // 選分數最高的 k，但若多個 k 分數差距 < bias 則偏好較少欄
  candidates.sort((a, b) => b.score - a.score);
  let chosen = candidates[0];
  for (const c of candidates) {
    if (c.k < chosen.k && (chosen.score - c.score) < SILHOUETTE_BIAS_TO_FEWER_COLUMNS) {
      chosen = c;
    }
  }

  // 把 cluster id 重新 map 成「左 → 右」(以 center x 升序)
  const order = chosen.centers
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c - b.c)
    .map((e) => e.i);
  const idMap = new Map();
  order.forEach((origId, newId) => idMap.set(origId, newId));
  const assignment = chosen.assignment.map((id) => idMap.get(id));

  return {
    columnCount: chosen.k,
    assignment,
    centers: chosen.centers.slice().sort((a, b) => a - b),
  };
}

function kmeans1d(values, k) {
  if (k === 1) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { centers: [mean], assignment: values.map(() => 0) };
  }
  // 初始化：取 values 中按位置等距的 k 個 quantile 當 seed
  const sorted = values.slice().sort((a, b) => a - b);
  let centers = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((i + 0.5) * sorted.length / k);
    centers.push(sorted[Math.min(idx, sorted.length - 1)]);
  }

  let assignment = new Array(values.length).fill(0);
  for (let iter = 0; iter < KMEANS_MAX_ITERS; iter++) {
    let changed = false;
    // 1) 指派
    for (let i = 0; i < values.length; i++) {
      let bestK = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i] - centers[c]);
        if (d < bestD) { bestD = d; bestK = c; }
      }
      if (assignment[i] !== bestK) {
        assignment[i] = bestK;
        changed = true;
      }
    }
    // 2) 更新中心
    const sums = new Array(k).fill(0);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < values.length; i++) {
      sums[assignment[i]] += values[i];
      counts[assignment[i]] += 1;
    }
    const newCenters = centers.slice();
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) newCenters[c] = sums[c] / counts[c];
    }
    centers = newCenters;
    if (!changed) break;
  }

  // 若有 cluster 為空(初始化偏差)，退回 k-1
  const counts = new Array(k).fill(0);
  for (const a of assignment) counts[a]++;
  if (counts.some((c) => c === 0)) return null;

  return { centers, assignment };
}

function minPairwiseGap(centers) {
  let minGap = Infinity;
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const d = Math.abs(centers[i] - centers[j]);
      if (d < minGap) minGap = d;
    }
  }
  return minGap === Infinity ? 0 : minGap;
}

function silhouetteScore(values, assignment, centers) {
  // 1-D 簡化：a(i) = |x_i - own center|, b(i) = |x_i - 第二近 center|
  // s(i) = (b - a) / max(a, b)。整體取平均。
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const own = assignment[i];
    const a = Math.abs(values[i] - centers[own]);
    let b = Infinity;
    for (let c = 0; c < centers.length; c++) {
      if (c === own) continue;
      const d = Math.abs(values[i] - centers[c]);
      if (d < b) b = d;
    }
    if (b === Infinity) continue;
    const denom = Math.max(a, b);
    if (denom > 0) {
      sum += (b - a) / denom;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

// ---------- 3) Column → blocks ----------

// 同 visual row 兄弟 line 標記的 x gap 閾值(以 medianLineHeight 為單位):
//   line A.right → line B.left 的 gap 必須 ≥ MEDIAN × 此倍數,才認為「明顯左右分置」
//   實測:News Release「For Immediate Release ... February 12, 2024」gap ≈ 300pt
//   (對 11pt body = 27 倍);各 spec sheet 同 row 多 cell 表格 gap 通常 < 80pt,
//   設 8(對 11pt body ≈ 88pt)能精確抓 News Release 的左右分置而不誤切表格
const SIBLING_ROW_MIN_X_GAP_FACTOR = 8;

// 對所有 lines 標「同一視覺行的兄弟 line」(典型場景:News Release 第一行
// 「For Immediate Release ............ February 12, 2024」左右兩段分置)
//
// 條件(三條都要過):
//   1. 同 visual row(top 距 ≤ SAME_LINE_Y_TOLERANCE)
//   2. 該 row 內**剛好 2 條 line**(3+ 條 line 視為表格 cell,不該切)
//   3. 兩條 line 之間 x gap ≥ SIBLING_ROW_MIN_X_GAP_FACTOR × medianLineHeight
function markSiblingsInRow(lines, medianLineHeight) {
  const minGap = SIBLING_ROW_MIN_X_GAP_FACTOR * (medianLineHeight || 12);
  // 先按 top 分群(允許 SAME_LINE_Y_TOLERANCE 容忍)
  const sortedIdx = lines.map((_, i) => i).sort((a, b) => lines[a].bbox[1] - lines[b].bbox[1]);
  let groupStart = 0;
  while (groupStart < sortedIdx.length) {
    let groupEnd = groupStart;
    const refTop = lines[sortedIdx[groupStart]].bbox[1];
    while (groupEnd + 1 < sortedIdx.length &&
      Math.abs(lines[sortedIdx[groupEnd + 1]].bbox[1] - refTop) <= SAME_LINE_Y_TOLERANCE) {
      groupEnd++;
    }
    const groupSize = groupEnd - groupStart + 1;
    // 條件 2:剛好 2 條 line(>= 3 條視為表格 cell,不切)
    if (groupSize === 2) {
      const a = lines[sortedIdx[groupStart]];
      const b = lines[sortedIdx[groupEnd]];
      const left = a.bbox[0] < b.bbox[0] ? a : b;
      const right = a.bbox[0] < b.bbox[0] ? b : a;
      const xGap = right.bbox[0] - left.bbox[2];
      // 條件 3:x gap 夠大
      if (xGap >= minGap) {
        a.siblingsInRow = true;
        b.siblingsInRow = true;
      }
    }
    groupStart = groupEnd + 1;
  }
}

function splitColumnIntoBlocks(colLines, medianLineHeight, columnIdx) {
  if (colLines.length === 0) return [];
  const blocks = [];
  let currentLines = [colLines[0]];
  for (let i = 1; i < colLines.length; i++) {
    const prev = colLines[i - 1];
    const cur = colLines[i];
    // siblingsInRow：同視覺行被切散的多條 line(左右分置場景)，強制切獨立 block。
    // 不論 vertical gap / fontSize,prev / cur 任一是 sibling 都切——確保「左段」、
    // 「右段」各自一個 block 翻譯，譯文不會 collapse 成單一字串
    if (prev.siblingsInRow || cur.siblingsInRow) {
      blocks.push(buildBlockFromLines(currentLines, columnIdx));
      currentLines = [cur];
      continue;
    }
    // canvas 座標，colLines 已按 top 升序(視覺由上往下):
    // gap = cur.top - prev.bottom = 兩條 line 之間的真實垂直空白
    // 同行時 prev 與 cur 重疊 → gap < 0；緊鄰下一行 → gap ≈ leading;
    // 隔了一個段落 → gap ≈ medianLineHeight × N
    const gap = cur.bbox[1] - prev.bbox[3];
    const fontDelta = Math.abs((cur.fontSize || 0) - (prev.fontSize || 0));
    const splitOnGap = gap > VERTICAL_GAP_FACTOR * medianLineHeight;
    const splitOnFont = fontDelta > LINE_FONT_SIZE_DELTA_FACTOR * medianLineHeight;
    // dominantFontName 變化曾用作切點(分離 heading 跟 body)，但實測 Plano news release
    // body 中 italic 引文整行(如「Best Places to Live in Texas」)會誤切；且大段 paragraph
    // 內混 italic 變化會把段落切成 3-5 段。取消此規則：接受同 fontSize 不同字型的 heading
    // 跟 body 黏在一起 trade-off，讓 body 段落完整。
    if (splitOnGap || splitOnFont) {
      blocks.push(buildBlockFromLines(currentLines, columnIdx));
      currentLines = [cur];
    } else {
      currentLines.push(cur);
    }
  }
  blocks.push(buildBlockFromLines(currentLines, columnIdx));
  return blocks;
}

function buildBlockFromLines(lines, columnIdx) {
  let bbox = lines[0].bbox.slice();
  for (let i = 1; i < lines.length; i++) bbox = unionBBox(bbox, lines[i].bbox);

  // W7:styleSegments — 對所有 lines 內 runs 跑「同 style tuple (isBold, isItalic,
  // linkUrl) 連續合併」。跨 line 但 style 相同也合一(inline style 是字符屬性,
  // 不該被換行強切)。line 之間接 ASCII space 算進當前 segment;同 line 內 runs
  // 之間有 bbox gap 也補 space(W7 修:pdf-engine 階段純空白 run 已被丟,inline
  // style 切換邊界的視覺空白訊息靠 bbox gap 推)
  const { styleSegments, linkUrls } = buildStyleSegments(lines);

  // plainText 從 styleSegments 重建(讓 W7 bbox gap 補空白也貫穿 plainText)。
  // 收斂多重空白
  const plainText = styleSegments.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();

  // fontSize：對 line 的 fontSize 取平均(line 內已先做過平均)
  const fs = lines.map((l) => l.fontSize).filter((s) => s > 0);
  const fontSize = fs.length > 0 ? fs.reduce((a, b) => a + b, 0) / fs.length : 0;

  const runCount = lines.reduce((sum, l) => sum + l.runs.length, 0);

  const internalLines = lines.map((l) => ({
    bbox: l.bbox,
    plainText: l.plainText || '',
    fontSize: l.fontSize || 0,
    // 注意：sub-split path(maybeSplitHeadingFromBlock / maybeSubsplitListBlock)
    // 構造 lineLikes 時若漏傳 dominantFontName，這裡 fallback 為 ''——但實作上 sub-split
    // 拿 _lines 元素已含 dominantFontName，正常 path 會保留
    dominantFontName: l.dominantFontName || '',
    // W7:保留 runs 給 sub-split path 重建 styleSegments 用(若漏 runs,sub-split
    // 出來的 block.styleSegments 會空)
    runs: l.runs || [],
  }));

  return {
    blockId: '', // 由 analyzePage 在 reading order 排完後重編
    type: 'paragraph', // W2-iter4 加分類
    bbox,
    column: columnIdx,
    readingOrder: 0,
    plainText,
    styleSegments,
    linkUrls,
    fontSize,
    lineCount: lines.length,
    runCount,
    // 內部 lines 結構，供 list sub-split 與 type 啟發式用
    _lines: internalLines,
    // dev probe alias(harness summary 用，W3 移除)
    _devLines: internalLines.map((l) => ({ bbox: l.bbox, text: l.plainText.slice(0, 60) })),
  };
}

// W7:export 給 unit spec 驗
export { buildStyleSegments };
// W7:把 lines 內的 runs 合成 styleSegments 陣列。
//   - 同 (isBold, isItalic, linkUrl) tuple 連續合一
//   - 跨 line 但 style 相同也合一(換行不強切 segment)
//   - line 之間以 ASCII space 接續算進當前 segment(同既有 plainText 規則)
//   - 收斂多重空白 + trim 首尾
//   - 收集 linkUrls 去重保 order(marker 用 index 引用)
function buildStyleSegments(lines) {
  const segments = [];
  let cur = null;
  let prevRun = null;
  for (let li = 0; li < lines.length; li++) {
    const runs = (lines[li] && lines[li].runs) || [];
    for (const r of runs) {
      if (!r || !r.text) continue;
      // W7-fix:同 line 內 runs 之間若 bbox 有水平 gap、兩端皆無空白字元
      // → 補 ASCII space。pdf-engine 階段為防 cross-column spacer 黏欄丟掉純
      // 空白 run,同行 inline 切換處(常是 fontFamily 變動點)的視覺空白訊息
      // 只剩 bbox gap 可推,否則 plainText / 送 LLM 的 marked text 會在
      // bold→italic 邊界缺空白(觀察:Plano「Editor's Note:Go to」)。
      if (cur && prevRun && Array.isArray(r.bbox) && Array.isArray(prevRun.bbox)) {
        const gap = r.bbox[0] - prevRun.bbox[2];
        const fontSize = r.fontSize || prevRun.fontSize || 12;
        const prevEnd = cur.text.slice(-1);
        const curStart = r.text[0];
        if (gap > fontSize * 0.1 && !/\s/.test(prevEnd) && !/\s/.test(curStart)) {
          cur.text += ' ';
        }
      }
      const isBold = !!r.isBold;
      const isItalic = !!r.isItalic;
      const linkUrl = r.linkUrl || null;
      if (
        cur && cur.isBold === isBold && cur.isItalic === isItalic && cur.linkUrl === linkUrl
      ) {
        cur.text += r.text;
      } else {
        if (cur) segments.push(cur);
        cur = { text: r.text, isBold, isItalic, linkUrl };
      }
      prevRun = r;
    }
    // line 之間接 ASCII space — 算進當前 segment(不另開,以保 style 連續性)
    if (li < lines.length - 1 && cur) cur.text += ' ';
    prevRun = null; // 跨 line 不算 gap(line 之間已有上面的 ' ' 接續)
  }
  if (cur) segments.push(cur);
  // collapse 多重空白
  for (const s of segments) s.text = s.text.replace(/\s+/g, ' ');
  // trim 首尾
  if (segments.length > 0) {
    segments[0].text = segments[0].text.replace(/^\s+/, '');
    segments[segments.length - 1].text = segments[segments.length - 1].text.replace(/\s+$/, '');
  }
  const filtered = segments.filter((s) => s.text.length > 0);
  const linkUrls = [];
  for (const s of filtered) {
    if (s.linkUrl && !linkUrls.includes(s.linkUrl)) linkUrls.push(s.linkUrl);
  }
  return { styleSegments: filtered, linkUrls };
}

// block 第一行若是「heading-shaped」(字數短 + dominantFontName 跟餘段 majority 不同)
// 就切出獨立 heading block。設計：只切第一行，不切中間 / 結尾。
//
// 為什麼只切第一行(不通用 fontName 切點):
//   通用 fontName 切點對 body 段內的 italic 引文(如 "Best Places to Live in Texas")
//   會把該行整段切散。Plano news release p0 就出現過大段 February 12 paragraph 被切
//   成 3 段。「block 第一行 heading-shaped」是更窄的訊號，只在段首孤立短句 + 跟餘段
//   字型不同時觸發，既能抓 Plano「About Plano / About Sysgration」這類 heading，又不
//   傷段內 italic emphasis。
const HEADING_SHAPED_MIN_CHARS = 3;
const HEADING_SHAPED_MAX_CHARS = 60;
const HEADING_REST_PURITY_RATIO = 0.5; // 餘段 dominantFontName 純度需 ≥ 50% 才認 majority
                                        // (body 段內常混 italic / 引文，提到 70% 會擋掉 Plano p1 的合法 heading 切點)

// 掃 block 內每行，找「heading-shaped」line 切成獨立 heading block。
//
// 切點條件(任一行 i 視為 heading line):
//   - lines[i].dominantFontName 與 block 內 majority dominantFontName 不同
//   - 字數在 [HEADING_SHAPED_MIN_CHARS, HEADING_SHAPED_MAX_CHARS] 範圍
//   - 若 i > 0：前面 gap(lines[i].top - lines[i-1].bottom)≥ HEADING_PRECEDING_GAP_FACTOR ×
//     medianLineHeight，避免 body 中段內 italic 引文整行誤切(inline italic 通常緊貼前後 line,
//     gap < 1× medianLineHeight;heading 通常前面有 spacing)
//   - i === 0 不需 gap 條件(block 第一行天然從前一個 block 的「block 邊界」隔開)
const HEADING_PRECEDING_GAP_FACTOR = 1.0;

function maybeSplitHeadingsAcrossBlock(block, medianLineHeight) {
  const lines = block._lines || [];
  if (lines.length < 2) return [block];

  // block majority dominantFontName(char-weighted)
  const fontCounts = new Map();
  let totalChars = 0;
  for (const l of lines) {
    const fn = l.dominantFontName;
    if (!fn) continue;
    const n = (l.plainText || '').length;
    fontCounts.set(fn, (fontCounts.get(fn) || 0) + n);
    totalChars += n;
  }
  if (totalChars === 0) return [block];
  let majorityFn = '';
  let majorityMax = 0;
  for (const [fn, n] of fontCounts) {
    if (n > majorityMax) { majorityMax = n; majorityFn = fn; }
  }
  if (!majorityFn || majorityMax / totalChars < HEADING_REST_PURITY_RATIO) return [block];

  // 找 heading line indexes
  const headingIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.dominantFontName || l.dominantFontName === majorityFn) continue;
    const txt = l.plainText || '';
    if (txt.length < HEADING_SHAPED_MIN_CHARS || txt.length > HEADING_SHAPED_MAX_CHARS) continue;
    if (i > 0) {
      const gapBefore = l.bbox[1] - lines[i - 1].bbox[3];
      if (gapBefore < medianLineHeight * HEADING_PRECEDING_GAP_FACTOR) continue;
    }
    headingIdxs.push(i);
  }
  if (headingIdxs.length === 0) return [block];

  // 按 headingIdxs 把 lines 切成 segments：每個 heading line 自己是一段，
  // 中間/前後的非 heading line group 合併成一段
  const segments = []; // 每個 segment 是 line array
  let cursor = 0;
  for (const idx of headingIdxs) {
    if (idx > cursor) segments.push(lines.slice(cursor, idx)); // pre / between body
    segments.push([lines[idx]]); // heading line(獨立)
    cursor = idx + 1;
  }
  if (cursor < lines.length) segments.push(lines.slice(cursor));

  return segments
    .filter((seg) => seg.length > 0)
    .map((seg) =>
      buildBlockFromLines(
        seg.map((l) => ({
          bbox: l.bbox,
          // W7:把 _lines 帶下來的 runs 傳回 buildBlockFromLines,讓
          // styleSegments 能正確重建。原本傳 [] 會導致 sub-split heading 無 inline style
          runs: l.runs || [],
          fontSize: l.fontSize,
          plainText: l.plainText,
          dominantFontName: l.dominantFontName,
        })),
        block.column
      )
    );
}

// 大 block 若多數行起首為 list marker，按 marker 切多個 block。
// 目的：LD750EQF 之類 spec sheet 的「60 行 list-item 段」自動切成多個獨立段落，
// 翻譯時 LLM 拿到的單元更小、cache hit 更精準。
function maybeSubsplitListBlock(block) {
  const lines = block._lines || [];
  if (lines.length < LIST_SUBSPLIT_MIN_LINES) return [block];

  const isMarker = lines.map((l) => LIST_MARKER_RE.test(l.plainText || ''));
  const markerCount = isMarker.filter(Boolean).length;
  if (markerCount < lines.length * LIST_SUBSPLIT_MARKER_RATIO) return [block];
  // 起頭那行必須是 marker 才開始切；否則 marker 之間 cluster 不對齊
  if (!isMarker[0]) return [block];

  // 按 marker 起首切 group
  const groups = [];
  let current = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMarker[i] && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(lines[i]);
  }
  if (current.length > 0) groups.push(current);

  if (groups.length < 2) return [block];

  // 每個 group 變獨立 block。runs 從 _lines 帶下來(W7 起 styleSegments 需要),
  // runCount 從 parent 按 line 比例攤分(僅 stats / harness summary 顯示用)
  const totalLines = lines.length;
  const parentRunCount = block.runCount || 0;
  return groups.map((g) => {
    const lineLikes = g.map((l) => ({
      bbox: l.bbox,
      runs: l.runs || [],
      fontSize: l.fontSize,
      plainText: l.plainText,
      dominantFontName: l.dominantFontName,
    }));
    const subBlock = buildBlockFromLines(lineLikes, block.column);
    subBlock.runCount = Math.round(parentRunCount * (g.length / totalLines));
    return subBlock;
  });
}

function unionBBox(a, b) {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * @typedef {Object} StyleSegment
 * @property {string}  text
 * @property {boolean} isBold
 * @property {boolean} isItalic
 * @property {string|null} linkUrl
 *
 * @typedef {Object} LayoutBlock
 * @property {string} blockId
 * @property {string} type
 * @property {[number, number, number, number]} bbox
 * @property {number} column
 * @property {number} readingOrder
 * @property {string} plainText
 * @property {StyleSegment[]} styleSegments  W7:inline rich text 切段
 * @property {string[]} linkUrls             W7:去重保 order 的 link url 表(marker 用 1-based index 引用)
 * @property {number} fontSize
 * @property {number} lineCount
 * @property {number} runCount
 *
 * @typedef {Object} LayoutPage
 * @property {number} pageIndex
 * @property {{ width: number, height: number }} viewport
 * @property {LayoutBlock[]} blocks
 * @property {number} medianLineHeight
 * @property {number} columnCount
 *
 * @typedef {Object} LayoutDoc
 * @property {Object} meta
 * @property {LayoutPage[]} pages
 * @property {Object} stats
 * @property {Array<{code: string, message: string}>} warnings
 * @property {Object} pdfDoc — PDF.js PDFDocumentProxy
 */
