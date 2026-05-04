#!/usr/bin/env node
// Cross-PDF analyzer:讀全部 .playwright-mcp/pdf-summaries/*.txt 對應的 dump JSON,
// 抓出系統性問題:type 誤判 / column 異常 / block 切分異常等。
//
// 由於 dump JSON 每跑一次 harness 就被覆寫(只保留最後一份),這個 analyzer 改成
// 重新 spawn harness 跑每份 PDF,把 dump 寫進獨立檔。
//
// 簡化版:直接讀已產生的 .txt summary,做 grep / 統計。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUMMARY_DIR = path.resolve(__dirname, '..', '.playwright-mcp', 'pdf-summaries');

const summaries = fs.readdirSync(SUMMARY_DIR).filter((f) => f.endsWith('.txt'));

const problems = [];

for (const file of summaries) {
  const filePath = path.join(SUMMARY_DIR, file);
  const txt = fs.readFileSync(filePath, 'utf-8');
  const pdfName = (txt.match(/^# PDF Layout Dump — (.+)$/m) || [])[1] || file;

  // 解析每頁
  const pageBlocks = txt.split(/^## /m).slice(1);
  for (const pageBlock of pageBlocks) {
    const headerLine = pageBlock.split('\n')[0];
    // 匹配:p0  595 × 842pt  · column 2  · medianLineHeight 6.4pt  · bodyFs 6.4pt  · blocks 14  (table 8 / paragraph 4 / heading 2)
    const m = headerLine.match(/^p(\d+)\s+(\d+)\s*×\s*(\d+)pt\s+·\s+column\s+(\d+)\s+·\s+medianLineHeight\s+([\d.]+)pt\s+·\s+bodyFs\s+([\d.]+)pt\s+·\s+blocks\s+(\d+)/);
    if (!m) continue;
    const [, pageIdx, w, h, col, mlh, bodyFs, blockCount] = m;
    const blocks = parseBlocks(pageBlock);

    const pageInfo = {
      pdf: pdfName,
      page: Number(pageIdx),
      pageWidth: Number(w),
      pageHeight: Number(h),
      columnCount: Number(col),
      medianLineHeight: Number(mlh),
      bodyFontSize: Number(bodyFs),
      blocks,
    };

    // 檢查問題
    const pageProbs = checkPage(pageInfo);
    for (const p of pageProbs) problems.push({ pdf: pdfName, page: pageInfo.page, ...p });
  }
}

// ---- 報告 ----

console.log(`分析 ${summaries.length} 份 PDF 的 summary,共抓到 ${problems.length} 個問題`);
console.log('');

// 按問題類型分組
const byType = {};
for (const p of problems) {
  if (!byType[p.type]) byType[p.type] = [];
  byType[p.type].push(p);
}

const typeOrder = [
  'huge-block-not-split',
  'big-bbox-but-empty-page-fs',
  'heading-too-large',
  'heading-mid-paragraph',
  'short-paragraph-1-line-many',
  'page-bodyFs-zero',
  'column-vs-block-conflict',
  'isolated-tiny-block',
  'table-but-only-2-rows',
];
const otherTypes = Object.keys(byType).filter((t) => !typeOrder.includes(t));

for (const t of [...typeOrder, ...otherTypes]) {
  if (!byType[t] || byType[t].length === 0) continue;
  console.log(`### ${t} (${byType[t].length} 條)`);
  // 印前 8 條
  for (const p of byType[t].slice(0, 8)) {
    console.log(`  - ${p.pdf} p${p.page}: ${p.detail}`);
  }
  if (byType[t].length > 8) console.log(`  ... 還有 ${byType[t].length - 8} 條`);
  console.log('');
}

// ---- 解析每頁 block ----

function parseBlocks(pageText) {
  const blocks = [];
  // line format: "  #0 p0-b0 paragraph col=0 bbox=[54,112,548,123] lines=2 fs=11.0pt | 文字..."
  const blockLineRe = /^  #(\d+)\s+(\S+)\s+(\S+)\s+col=(\d+)\s+bbox=\[([\d.,]+)\]\s+lines=(\d+)\s+fs=([\d.]+)pt\s*\|\s*(.*)$/gm;
  let m;
  while ((m = blockLineRe.exec(pageText)) !== null) {
    const [, order, blockId, type, col, bboxStr, lines, fs, text] = m;
    const [x0, y0, x1, y1] = bboxStr.split(',').map(Number);
    blocks.push({
      order: Number(order),
      blockId,
      type,
      column: Number(col),
      bbox: [x0, y0, x1, y1],
      lineCount: Number(lines),
      fontSize: Number(fs),
      text,
    });
  }
  return blocks;
}

// ---- 問題啟發式 ----

function checkPage(p) {
  const probs = [];
  const { columnCount, medianLineHeight, bodyFontSize, blocks, pageWidth, pageHeight } = p;

  // 1) 頁面 bodyFs 為 0(空白頁)
  if (blocks.length === 0) {
    probs.push({
      type: 'page-bodyFs-zero',
      detail: '空白頁 (0 blocks)',
    });
    return probs;
  }

  // 2) 巨 block lineCount > 30:極可能該切沒切
  for (const b of blocks) {
    if (b.lineCount > 30) {
      probs.push({
        type: 'huge-block-not-split',
        detail: `#${b.order} ${b.type} lines=${b.lineCount} | ${truncate(b.text, 60)}`,
      });
    }
  }

  // 3) heading 字體比 body 大太多(> 3×):可能是 logo / decoration 不該翻譯;
  //    但也可能是真實大標題,只標 hint 不算錯
  for (const b of blocks) {
    if (b.type === 'heading' && bodyFontSize > 0 && b.fontSize > bodyFontSize * 3 && b.lineCount === 1) {
      probs.push({
        type: 'heading-too-large',
        detail: `#${b.order} fs=${b.fontSize.toFixed(1)} (body=${bodyFontSize.toFixed(1)}) | ${truncate(b.text, 50)}`,
      });
    }
  }

  // 4) 同欄內中段冒出 heading:heading 通常在段落起頭;若前後都是同欄 paragraph
  //    且 heading 排在中間,可能是子標題或誤判
  // (這不算錯,只是 hint)
  for (let i = 1; i < blocks.length - 1; i++) {
    const cur = blocks[i];
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    if (cur.type === 'heading' && prev.type === 'paragraph' && next.type === 'paragraph' &&
        cur.column === prev.column && cur.column === next.column) {
      // 子標題很常見,只在 next paragraph lineCount 很小才標
      if (next.lineCount === 1) {
        probs.push({
          type: 'heading-mid-paragraph',
          detail: `#${cur.order} 中段 heading,後段只有 ${next.lineCount} 行`,
        });
      }
    }
  }

  // 5) 連續多個 1-line paragraph:可能該被合併成一個 list-item / bullet group
  let consecutive1Line = 0;
  for (const b of blocks) {
    if (b.type === 'paragraph' && b.lineCount === 1) {
      consecutive1Line++;
    } else {
      if (consecutive1Line >= 5) {
        probs.push({
          type: 'short-paragraph-1-line-many',
          detail: `連續 ${consecutive1Line} 個 1-line paragraph 沒合併`,
        });
      }
      consecutive1Line = 0;
    }
  }
  if (consecutive1Line >= 5) {
    probs.push({
      type: 'short-paragraph-1-line-many',
      detail: `連續 ${consecutive1Line} 個 1-line paragraph 沒合併(尾段)`,
    });
  }

  // 6) column=N 但實際 block 都集中在某一欄(其他欄空 / 只 1-2 個 block)
  if (columnCount >= 2) {
    const counts = new Array(columnCount).fill(0);
    for (const b of blocks) counts[b.column]++;
    const total = blocks.length;
    for (let c = 0; c < columnCount; c++) {
      if (counts[c] / total < 0.1) {
        probs.push({
          type: 'column-vs-block-conflict',
          detail: `column=${columnCount} 但 col${c} 只 ${counts[c]}/${total} 個 block`,
        });
        break;
      }
    }
  }

  // 7) 孤立小 block:bbox 極小、字數 < 5,可能是 OCR 殘渣或裝飾
  for (const b of blocks) {
    const w = b.bbox[2] - b.bbox[0];
    const h = b.bbox[3] - b.bbox[1];
    const txtLen = (b.text || '').length;
    if (txtLen > 0 && txtLen < 5 && w < 30 && h < 20 && b.type !== 'page-number') {
      probs.push({
        type: 'isolated-tiny-block',
        detail: `#${b.order} bbox=${w.toFixed(0)}×${h.toFixed(0)}pt | "${b.text}"`,
      });
    }
  }

  // 8) table 但只 2 行(table 啟發式應該要 ≥4 行,< 4 不該被歸 table——但實作允許)
  for (const b of blocks) {
    if (b.type === 'table' && b.lineCount < 4) {
      probs.push({
        type: 'table-but-only-2-rows',
        detail: `#${b.order} 標 table 但只 ${b.lineCount} 行 | ${truncate(b.text, 50)}`,
      });
    }
  }

  return probs;
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
