#!/usr/bin/env node
// generate-i18n-content.mjs — 從 lib/i18n.js 產出 content script 專用子集 lib/i18n-content.js
//（2026-09-12 code review 批次 6 §5.1「i18n 拆 content 子集」）
//
// 為什麼：lib/i18n.js 是 8 語完整 dict（約 790KB、8400 行，popup / options / translate-doc 全部字串），
// 但 manifest 把它當 content script 注入到 <all_urls> 的每個分頁與每個 iframe（all_frames），content
// 端實際只用約 70 個 key（toast / 編輯列 / 懸浮按鈕 / 背景錯誤訊息）。每個 frame 都要 parse 790KB
// 只為了 70 個 key，是 §6.1 量到的固定成本大頭。
//
// 做法：runtime（IIFE、getUiLanguage / t / bgErrorMessage / applyI18n …）原封不動從 i18n.js 抄，
// 8 個 dict block 只留 content 端用得到的 key——子集與完整 dict 的「值」保證相同（單一資料源仍是
// i18n.js，本檔是衍生物，不可手改）。
//
// 子集的 key 來源（機械規則，見 collectContentKeys）：
//   1. manifest.json 所有 content_scripts 列出的 js（lib/i18n.js 本身除外）內，任何單引號字串字面
//      恰好等於 zh-TW dict 的 key → 收（涵蓋 SK.t('x')、`key: 'instapaper.x'`、三元式選 key）
//   2. 動態前綴：`'error.bg.' + code`（bgErrorMessage）→ 整個 error.bg.* 前綴收
//
// 用法：
//   node tools/build/generate-i18n-content.mjs           # 重生 shinkansen/lib/i18n-content.js
//   node tools/build/generate-i18n-content.mjs --check   # 只比對，過期則 exit 1（i18n-sync-check / spec 用）
// 改 lib/i18n.js 或 content script 用到的 key 後必重生（i18n-sync-check skill 會跑 --check；
// test/unit/i18n-content-subset.spec.js 是 forcing function）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'shinkansen');
export const SOURCE_PATH = path.join(EXT, 'lib', 'i18n.js');
export const OUTPUT_PATH = path.join(EXT, 'lib', 'i18n-content.js');

const LANGS = ['ZH_TW', 'ZH_CN', 'EN', 'JA', 'KO', 'ES', 'FR', 'DE'];
// 動態組 key 的前綴（字面掃描抓不到）
export const DYNAMIC_PREFIXES = ['error.bg.'];

function dictBlock(src, lang) {
  const start = src.indexOf(`// === ${lang}_DICT_START ===`);
  const end = src.indexOf(`// === ${lang}_DICT_END ===`);
  if (start === -1 || end === -1) throw new Error(`i18n.js 缺 ${lang} dict marker`);
  return { start, end: end + `// === ${lang}_DICT_END ===`.length };
}

// dict block 內的單行 entry：'key': <單行 JS 字串字面>,
const ENTRY_RE = /^(\s*)'([^']+)':\s*(.+),\s*$/;

export function parseDictEntries(blockText) {
  const entries = new Map();
  for (const line of blockText.split('\n')) {
    const m = line.match(ENTRY_RE);
    if (m) entries.set(m[2], line);
  }
  return entries;
}

/** manifest content_scripts 內所有 js（lib/i18n.js 除外） */
export function contentScriptFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf-8'));
  const files = new Set();
  for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) {
      if (js === 'lib/i18n.js' || js === 'lib/i18n-content.js') continue;
      files.add(js);
    }
  }
  return [...files];
}

/** content 端用到的 key 集合（規則見檔頭） */
export function collectContentKeys(zhTWKeys) {
  const keys = new Set();
  for (const rel of contentScriptFiles()) {
    const src = fs.readFileSync(path.join(EXT, rel), 'utf-8');
    for (const m of src.matchAll(/'([A-Za-z][A-Za-z0-9_.-]*)'/g)) {
      if (zhTWKeys.has(m[1])) keys.add(m[1]);
    }
  }
  for (const k of zhTWKeys) {
    if (DYNAMIC_PREFIXES.some((p) => k.startsWith(p))) keys.add(k);
  }
  return keys;
}

export function buildContentI18n() {
  const src = fs.readFileSync(SOURCE_PATH, 'utf-8');
  const zh = dictBlock(src, 'ZH_TW');
  const zhTWKeys = new Set(parseDictEntries(src.slice(zh.start, zh.end)).keys());
  const keys = collectContentKeys(zhTWKeys);
  const sortedKeys = [...zhTWKeys].filter((k) => keys.has(k)); // 依 zh-TW dict 原順序

  let out = src;
  // 從後往前替換各 dict block，避免 index 位移
  for (const lang of [...LANGS].reverse()) {
    const { start, end } = dictBlock(out, lang);
    const block = out.slice(start, end);
    const entries = parseDictEntries(block);
    const varName = block.match(/const (messages_\w+) = \{/)?.[1];
    if (!varName) throw new Error(`${lang} dict 找不到 const messages_* 宣告`);
    const lines = [
      `// === ${lang}_DICT_START ===`,
      `  // ${lang} content 子集（由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出，不可手改）`,
      `  const ${varName} = {`,
    ];
    for (const k of sortedKeys) {
      const line = entries.get(k);
      if (!line) throw new Error(`${lang} dict 缺 key ${k}（先跑 i18n-sync-check 對齊 8 語）`);
      lines.push(line);
    }
    lines.push('  };', `  // === ${lang}_DICT_END ===`);
    out = out.slice(0, start) + lines.join('\n') + out.slice(end);
  }
  const banner = `// lib/i18n-content.js — content script 專用 i18n 子集（GENERATED，不可手改）
//
// 由 tools/build/generate-i18n-content.mjs 從 lib/i18n.js 產出：runtime 原封不動，8 語 dict 只留
// content script（manifest content_scripts）用得到的 ${sortedKeys.length} 個 key。完整 dict 仍是
// lib/i18n.js（popup / options / translate-doc 載入）；改字串一律改 i18n.js 再重生本檔。
// test/unit/i18n-content-subset.spec.js 鎖「本檔 = 重生結果」與「子集值 = 完整 dict 值」。
//
`;
  // 原檔頭註解（到 IIFE 開始）換成 banner
  const iife = out.indexOf('(function (global) {');
  out = banner + out.slice(iife);
  return { text: out, keys: sortedKeys };
}

function main() {
  const check = process.argv.includes('--check');
  const { text, keys } = buildContentI18n();
  if (check) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf-8') : '';
    if (current !== text) {
      console.error(`✗ lib/i18n-content.js 已過期（${keys.length} 個 key），請跑：node tools/build/generate-i18n-content.mjs`);
      process.exit(1);
    }
    console.log(`✓ lib/i18n-content.js 與 lib/i18n.js 一致（${keys.length} 個 key）`);
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, text);
  console.log(`✓ 已產出 ${path.relative(ROOT, OUTPUT_PATH)}：${keys.length} 個 key，${(text.length / 1024).toFixed(1)}KB（完整 dict ${(fs.statSync(SOURCE_PATH).size / 1024).toFixed(1)}KB）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
