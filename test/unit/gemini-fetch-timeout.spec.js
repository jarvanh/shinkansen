// Unit test: 主翻譯 fetchWithRetry 必含 15s fetch-level timeout(v1.9.21)
//
// 背景:v0.70 加 timeout 給 extractGlossary(55s,當時用 Structured Output JSON
// mode 可能卡 30-60s),主翻譯路徑 fetchWithRetry 一直沒設 timeout。使用者卡死
// 情境(實測 2 分 27 秒)只能手動按 × 取消。v1.9.21 補 15s timeout —— Flash 系列
// 慢 case ~8s 留 2x margin,真正 hang 在 15s 後 AbortError,走原有的 network error
// retry path(最壞 ~76s 完全放棄)。
//
// 為什麼用 source 結構驗證而非 mock fetch:fetchWithRetry 不 export,且真實 timeout
// behaviour 要等 15s + retry backoff,實測太慢不適合 unit test。改 lock 關鍵 source
// 結構,擋住「未來不小心拔掉 timeout 又沒人注意」的 regression。
//
// SANITY 紀錄(已驗證):暫時把 `signal: controller.signal` 那行刪掉,case「fetch
// call 含 signal 欄位」fail;暫時把 FETCH_TIMEOUT_MS 從 15_000 改成 55_000,
// case「常數值為 15_000」fail;還原 pass。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GEMINI_JS_PATH = path.resolve(__dirname, '../../shinkansen/lib/gemini.js');
const SRC = fs.readFileSync(GEMINI_JS_PATH, 'utf-8');

test('FETCH_TIMEOUT_MS 常數設定為 15_000(主翻譯 fetch timeout)', () => {
  expect(
    SRC,
    'gemini.js 缺 `const FETCH_TIMEOUT_MS = 15_000` 常數(主翻譯 fetch 層級 timeout)',
  ).toMatch(/const\s+FETCH_TIMEOUT_MS\s*=\s*15_000\s*;/);
});

test('fetchWithRetry 內含 AbortController + setTimeout(abort, FETCH_TIMEOUT_MS)', () => {
  // 找到 fetchWithRetry 函式 body 範圍
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  expect(fnStart, 'gemini.js 找不到 fetchWithRetry 函式').toBeGreaterThan(-1);
  // 取後續 2000 字元當函式 body 範圍粗略掃描(夠包到 while loop 內所有邏輯)
  const fnBody = SRC.slice(fnStart, fnStart + 2000);

  expect(
    fnBody,
    'fetchWithRetry 內缺 `new AbortController()`',
  ).toMatch(/new\s+AbortController\s*\(\s*\)/);

  expect(
    fnBody,
    'fetchWithRetry 內缺 `setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)`',
  ).toMatch(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*controller\.abort\s*\(\s*\)\s*,\s*FETCH_TIMEOUT_MS\s*\)/);
});

test('fetch 呼叫帶 `signal: controller.signal`(否則 abort 不會生效)', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  // fetch(url, { ..., signal: controller.signal }) 必須存在
  expect(
    fnBody,
    'fetchWithRetry 的 fetch() options 缺 `signal: controller.signal` —— 沒這欄 AbortController 不會生效',
  ).toMatch(/signal\s*:\s*controller\.signal/);
});

test('catch 區塊辨識 AbortError 並走網路錯誤 retry path', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  // catch 區塊需檢查 err.name === 'AbortError',逾時 debugLog 改用 'gemini fetch timeout' 訊息
  expect(
    fnBody,
    'fetchWithRetry catch 區塊缺 `err.name === \'AbortError\'` 偵測',
  ).toMatch(/err\.name\s*===\s*['"]AbortError['"]/);
});

test('clearTimeout(abortTimer) 在 fetch 成功與失敗兩路徑都被呼叫(避免 leak)', () => {
  const fnStart = SRC.indexOf('async function fetchWithRetry');
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  // 至少 2 次 clearTimeout:catch 內(fetch throw)+ try 結束後(fetch 成功)
  const matches = fnBody.match(/clearTimeout\s*\(\s*abortTimer\s*\)/g) || [];
  expect(
    matches.length,
    `fetchWithRetry 內 \`clearTimeout(abortTimer)\` 應出現 ≥ 2 次(成功 + 失敗兩路徑各一);實際 ${matches.length}`,
  ).toBeGreaterThanOrEqual(2);
});

// ── translateBatchStream(streaming 路徑)同樣套 15s headers timeout ──
//
// 跟 non-stream 不同,streaming 用 internal AbortController + forward 外部 signal,
// fetch resolve(headers 到)後 clearTimeout,stream phase 由外部 signal 控制。

test('translateBatchStream 內含 internal AbortController + headersTimer(FETCH_TIMEOUT_MS)', () => {
  const fnStart = SRC.indexOf('export async function translateBatchStream');
  expect(fnStart, 'gemini.js 找不到 translateBatchStream 函式').toBeGreaterThan(-1);
  // 函式體較長,讀 4000 字夠涵蓋 headers fetch + cleanup
  const fnBody = SRC.slice(fnStart, fnStart + 4000);

  expect(
    fnBody,
    'translateBatchStream 內缺 `new AbortController()`(internal headers timeout)',
  ).toMatch(/new\s+AbortController\s*\(\s*\)/);

  expect(
    fnBody,
    'translateBatchStream 缺 `setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)` headers timer',
  ).toMatch(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*ac\.abort\s*\(\s*\)\s*,\s*FETCH_TIMEOUT_MS\s*\)/);
});

test('translateBatchStream fetch 改用 internal ac.signal(不直接吃外部 signal)', () => {
  const fnStart = SRC.indexOf('export async function translateBatchStream');
  const fnBody = SRC.slice(fnStart, fnStart + 4000);
  // 之前是 signal: signal,改 signal: ac.signal 後 internal headers timer 能 abort fetch
  expect(
    fnBody,
    'translateBatchStream fetch options 應用 `signal: ac.signal`(原本 signal: signal 不能套 internal headers timeout)',
  ).toMatch(/signal\s*:\s*ac\.signal/);
});

test('translateBatchStream 把外部 signal 的 abort 事件 forward 到 internal AC', () => {
  const fnStart = SRC.indexOf('export async function translateBatchStream');
  const fnBody = SRC.slice(fnStart, fnStart + 4000);
  // 若沒 forward,外部 user cancel 不會 abort fetch / stream
  expect(
    fnBody,
    'translateBatchStream 缺外部 signal forward(`signal?.addEventListener(\'abort\', ...)`)',
  ).toMatch(/signal\?\.addEventListener\s*\(\s*['"]abort['"]/);
});

test('translateBatchStream 用 try/finally 清掉外部 signal listener(避免 leak)', () => {
  const fnStart = SRC.indexOf('export async function translateBatchStream');
  // 函式較長(>4000 字),讀 9000 字確保涵蓋尾端 finally
  const fnBody = SRC.slice(fnStart, fnStart + 9000);
  expect(
    fnBody,
    'translateBatchStream 缺 `signal?.removeEventListener(\'abort\', ...)`(listener leak risk)',
  ).toMatch(/signal\?\.removeEventListener\s*\(\s*['"]abort['"]/);
});

// ── 術語表 extractGlossary 預設 timeout 降到 15s(對齊主翻譯)──
//
// v0.70 原為 55s(當時用 Structured Output 大輸入需 30-60s),v0.72 拿掉 JSON mode
// 後該理由消失;v1.9.21 統一降到 15s。glossaryConfig.fetchTimeoutMs 仍可 override。

test('extractGlossary 預設 fetchTimeoutMs 為 15_000(對齊主翻譯)', () => {
  const fnStart = SRC.indexOf('export async function extractGlossary');
  expect(fnStart, 'gemini.js 找不到 extractGlossary').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 2000);
  expect(
    fnBody,
    'extractGlossary 預設 fetchTimeoutMs 應為 15_000,不應是 55_000 / 60_000',
  ).toMatch(/fetchTimeoutMs\s*=\s*glossaryConfig\?\.fetchTimeoutMs\s*\?\?\s*15_000/);
});
