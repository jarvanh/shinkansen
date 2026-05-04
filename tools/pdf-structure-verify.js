#!/usr/bin/env node
// Shinkansen PDF 頁面結構核對 harness
//
// 用途:把 docs/excluded/test pdf/ 下每份 PDF 跑一輪「英文當譯文填回」流程,
// 對每份輸出結構診斷 + 重生成 PDF 重 parse 驗證頁數 + 文字 run 數量。
// 不需要真的呼叫 Gemini API,純結構驗證。
//
// 用法:
//   node tools/pdf-structure-verify.js                 # 跑全部 PDF
//   node tools/pdf-structure-verify.js --only Plano    # 只跑檔名含 Plano 的 PDF
//
// 輸出:
//   .playwright-mcp/pdf-structure-verify-report.md  人類可讀報告
//   .playwright-mcp/pdf-structure-verify-raw.json   raw 結果 JSON
//
// 機制:
//   - 上傳 PDF 到 chrome-extension://.../translate-doc/index.html UI
//   - 等 stage-result 出現,doc 已寫進 module-scope currentDoc
//   - 透過 window.__skVerify dev hook(只在 translate-doc 頁存在)觸發:
//     a) computeStructureDiagnostics — 直接驗 doc IR 內每 block 的 bbox /
//        reader overlay % / fontSize / plainText 是否合法
//     b) injectPlainTextAsTranslation — 把每個 translatable block.plainText
//        當成 translation 灌進去
//     c) generateAndVerifyPdf — 攔截 downloadBilingualPdf 的 PDF bytes,
//        用 PDF.js 重新 parse 驗 numPages + 每頁 textRun 數量

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO_ROOT, 'shinkansen');
const PDF_DIR = path.join(REPO_ROOT, 'docs/excluded/test pdf');
const OUT_DIR = path.join(REPO_ROOT, '.playwright-mcp');
const REPORT_PATH = path.join(OUT_DIR, 'pdf-structure-verify-report.md');
const RAW_PATH = path.join(OUT_DIR, 'pdf-structure-verify-raw.json');

const onlyArgIdx = process.argv.indexOf('--only');
const ONLY_FILTER = onlyArgIdx >= 0 ? process.argv[onlyArgIdx + 1] : null;
const PARSE_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 240_000; // 重大 PDF 生成 + 字型 subset 可能要一陣子
const HEADED = process.env.SHINKANSEN_HEADED === '1';

async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`找不到 PDF 目錄:${PDF_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let pdfs = fs.readdirSync(PDF_DIR)
    .filter((f) => /\.pdf$/i.test(f))
    .map((f) => path.join(PDF_DIR, f));
  if (ONLY_FILTER) {
    pdfs = pdfs.filter((p) => path.basename(p).toLowerCase().includes(ONLY_FILTER.toLowerCase()));
    if (pdfs.length === 0) {
      console.error(`--only "${ONLY_FILTER}" 沒匹配任何 PDF`);
      process.exit(1);
    }
  }
  pdfs.sort();

  console.log(`[harness] ${pdfs.length} PDF(s) to verify`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-verify-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      ...(HEADED ? [] : ['--headless=new']),
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = worker.url().split('/')[2];

  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`PAGE[error]> ${err.message}`));
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  await page.goto(`chrome-extension://${extensionId}/translate-doc/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dropzone', { state: 'visible' });

  const results = [];

  for (const pdfPath of pdfs) {
    const baseName = path.basename(pdfPath);
    consoleErrors.length = 0;
    console.log(`\n[verify] ${baseName}`);
    const result = { filename: baseName, status: 'pending' };

    try {
      // 切回 stage-upload(若上一輪卡在 result/reader/debug)
      await resetToUploadStage(page);

      await page.setInputFiles('#file-input', pdfPath);
      const reachedStage = await page.waitForFunction(
        () => {
          const r = document.getElementById('stage-result');
          const errEl = document.getElementById('upload-error');
          if (r && !r.hidden) return 'result';
          if (errEl && !errEl.hidden && errEl.textContent.trim()) return 'error';
          return false;
        },
        null,
        { timeout: PARSE_TIMEOUT_MS, polling: 250 },
      ).catch(() => null);

      if (!reachedStage) {
        result.status = 'parse-timeout';
        results.push(result);
        continue;
      }
      const stage = await reachedStage.jsonValue();
      if (stage === 'error') {
        const errMsg = await page.$eval('#upload-error', (e) => e.textContent.trim());
        result.status = 'parse-error';
        result.error = errMsg;
        results.push(result);
        console.log(`  [skip] ${errMsg}`);
        continue;
      }

      // 1) doc 概況
      const docMeta = await page.evaluate(() => {
        const d = window.__skLayoutDoc;
        if (!d) return null;
        return {
          pageCount: d.pages.length,
          totalBlocks: d.pages.reduce((s, p) => s + p.blocks.length, 0),
          totalRuns: d.stats?.totalRuns || 0,
          totalChars: d.stats?.totalChars || 0,
          warnings: d.warnings || [],
        };
      });
      result.doc = docMeta;
      console.log(`  pages=${docMeta.pageCount} blocks=${docMeta.totalBlocks} runs=${docMeta.totalRuns} chars=${docMeta.totalChars}`);

      // 2) 結構診斷
      const struct = await page.evaluate(() => window.__skVerify.computeStructureDiagnostics());
      result.structure = struct;
      console.log(`  structure issues: ${struct.issueCount}`);
      if (struct.issueCount > 0) {
        const codeCounts = {};
        for (const it of struct.issues) codeCounts[it.code] = (codeCounts[it.code] || 0) + 1;
        console.log(`    by code: ${Object.entries(codeCounts).map(([c, n]) => `${c}:${n}`).join(' ')}`);
      }

      // 3) 灌 fake translation
      const inject = await page.evaluate(() => window.__skVerify.injectPlainTextAsTranslation());
      result.injected = inject;
      console.log(`  injected ${inject.translatableCount} translatable blocks`);

      // 4) 生成 PDF + 重 parse 驗證
      const verifyResult = await page.evaluate(
        () => Promise.race([
          window.__skVerify.generateAndVerifyPdf(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('verify-timeout-page')), 230_000)),
        ]),
      ).catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));

      result.pdf = verifyResult;
      if (!verifyResult.ok) {
        console.log(`  [pdf-fail] ${verifyResult.error}`);
      } else {
        const r = verifyResult.reparsed;
        if (r) {
          const totalReparsedRuns = r.pages.reduce((s, p) => s + p.runCount, 0);
          console.log(`  pdf=${(verifyResult.byteLength / 1024).toFixed(0)}KB elapsed=${verifyResult.elapsedMs}ms reparse: pages=${r.numPages} runs=${totalReparsedRuns}`);
          // 頁數核對
          if (r.numPages !== docMeta.pageCount) {
            result.pdfPageMismatch = `expected ${docMeta.pageCount}, got ${r.numPages}`;
            console.log(`    [WARN] page count mismatch: expected ${docMeta.pageCount}, got ${r.numPages}`);
          }
          // 每頁不該完全沒文字(原 PDF 該頁如果有文字,生成 PDF 也該有)
          const emptyPages = [];
          for (const reparsedPage of r.pages) {
            if (reparsedPage.runCount === 0) emptyPages.push(reparsedPage.pageIndex);
          }
          if (emptyPages.length > 0) {
            result.pdfEmptyPages = emptyPages;
            console.log(`    [INFO] reparsed pages with 0 runs: ${emptyPages.join(',')}`);
          }
        } else {
          console.log(`  [pdf-reparse-fail] ${verifyResult.reparseError}`);
        }
      }

      // 5) 蒐集 console errors(過濾掉 favicon 噪音)
      const filteredErrors = consoleErrors.filter((e) =>
        !e.includes('favicon') &&
        !e.includes('chrome-extension://') === false || true);
      if (filteredErrors.length > 0) {
        result.consoleErrors = filteredErrors.slice(0, 10);
      }

      result.status = 'ok';
    } catch (err) {
      console.error(`  [error] ${err.message}`);
      result.status = 'exception';
      result.error = err.message;
    }
    results.push(result);
  }

  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // 寫報告
  fs.writeFileSync(RAW_PATH, JSON.stringify(results, null, 2), 'utf-8');
  fs.writeFileSync(REPORT_PATH, buildReport(results), 'utf-8');
  console.log(`\n[report] ${path.relative(REPO_ROOT, REPORT_PATH)}`);
  console.log(`[raw]    ${path.relative(REPO_ROOT, RAW_PATH)}`);

  // exit code:有任何 structure issue 或 pdf-fail / pdf-page-mismatch 就 1
  let bad = 0;
  for (const r of results) {
    if (r.status !== 'ok') bad++;
    else if (r.structure?.issueCount > 0) bad++;
    else if (r.pdf && !r.pdf.ok) bad++;
    else if (r.pdfPageMismatch) bad++;
  }
  if (bad > 0) {
    console.log(`\n${bad} / ${results.length} PDF(s) have issues. See report.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${results.length} PDF(s) verified clean.`);
  }
}

async function resetToUploadStage(page) {
  const inUpload = await page.$eval('#stage-upload', (el) => !el.hidden).catch(() => false);
  if (inUpload) return;
  for (const sel of ['#reupload-btn', '#reader-reupload-btn', '#cancel-btn', '#debug-back-btn']) {
    const btn = await page.$(sel);
    if (btn) {
      const visible = await btn.evaluate((el) => {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute('hidden')) return false;
        }
        return true;
      }).catch(() => false);
      if (visible) {
        await btn.click().catch(() => {});
        await page.waitForSelector('#stage-upload:not([hidden])', { timeout: 5000 }).catch(() => {});
        return;
      }
    }
  }
}

function buildReport(results) {
  const lines = [];
  lines.push('# Shinkansen PDF Structure Verify Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total PDFs: ${results.length}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| File | Status | Pages | Blocks | Inject | Issues | PDF | Reparse |');
  lines.push('|------|--------|-------|--------|--------|--------|-----|---------|');
  for (const r of results) {
    const status = r.status;
    const pages = r.doc?.pageCount ?? '-';
    const blocks = r.doc?.totalBlocks ?? '-';
    const inject = r.injected?.translatableCount ?? '-';
    const issues = r.structure?.issueCount ?? '-';
    const pdf = r.pdf?.ok ? `${(r.pdf.byteLength / 1024).toFixed(0)}KB` : (r.pdf?.error ? `FAIL: ${r.pdf.error.slice(0, 30)}` : '-');
    let reparse = '-';
    if (r.pdf?.reparsed) {
      const runs = r.pdf.reparsed.pages.reduce((s, p) => s + p.runCount, 0);
      reparse = `${r.pdf.reparsed.numPages}p / ${runs}r`;
      if (r.pdfPageMismatch) reparse += ` MISMATCH`;
    } else if (r.pdf?.reparseError) {
      reparse = `FAIL: ${r.pdf.reparseError.slice(0, 20)}`;
    }
    const fname = r.filename.length > 50 ? r.filename.slice(0, 47) + '...' : r.filename;
    lines.push(`| ${fname.replace(/\|/g, '\\|')} | ${status} | ${pages} | ${blocks} | ${inject} | ${issues} | ${pdf} | ${reparse} |`);
  }
  lines.push('');

  // Detailed sections
  lines.push('## Details');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.filename}`);
    lines.push('');
    if (r.status !== 'ok') {
      lines.push(`**Status: ${r.status}**`);
      if (r.error) lines.push(`Error: ${r.error}`);
      lines.push('');
      continue;
    }
    if (r.doc) {
      lines.push(`- doc: ${r.doc.pageCount} pages, ${r.doc.totalBlocks} blocks, ${r.doc.totalRuns} runs, ${r.doc.totalChars} chars`);
      if (r.doc.warnings.length > 0) {
        lines.push(`- warnings: ${r.doc.warnings.map((w) => w.code).join(', ')}`);
      }
    }
    if (r.injected) {
      lines.push(`- injected ${r.injected.translatableCount} translatable blocks`);
    }
    if (r.structure && r.structure.issueCount > 0) {
      const codeCounts = {};
      for (const it of r.structure.issues) codeCounts[it.code] = (codeCounts[it.code] || 0) + 1;
      lines.push(`- structure issues: ${r.structure.issueCount} total`);
      for (const [code, n] of Object.entries(codeCounts)) {
        lines.push(`  - ${code}: ${n}`);
      }
      lines.push('');
      lines.push('  Sample issues:');
      for (const issue of r.structure.issues.slice(0, 8)) {
        lines.push(`  - p${issue.pageIndex} ${issue.blockId} \`${issue.code}\` ${issue.detail}`);
      }
    } else if (r.structure) {
      lines.push(`- structure: clean`);
    }
    if (r.pdf) {
      if (r.pdf.ok) {
        lines.push(`- pdf: ${(r.pdf.byteLength / 1024).toFixed(0)}KB, elapsed ${r.pdf.elapsedMs}ms`);
        if (r.pdf.reparsed) {
          const totalRuns = r.pdf.reparsed.pages.reduce((s, p) => s + p.runCount, 0);
          lines.push(`- reparsed: ${r.pdf.reparsed.numPages} pages, ${totalRuns} text runs total`);
          if (r.pdfPageMismatch) lines.push(`  - **PAGE COUNT MISMATCH**: ${r.pdfPageMismatch}`);
          if (r.pdfEmptyPages) lines.push(`  - empty pages (0 runs): ${r.pdfEmptyPages.join(', ')}`);
        } else if (r.pdf.reparseError) {
          lines.push(`- reparse FAILED: ${r.pdf.reparseError}`);
        }
      } else {
        lines.push(`- pdf FAILED: ${r.pdf.error}`);
      }
    }
    if (r.consoleErrors && r.consoleErrors.length > 0) {
      lines.push(`- console errors:`);
      for (const e of r.consoleErrors) lines.push(`  - ${e.slice(0, 200)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
