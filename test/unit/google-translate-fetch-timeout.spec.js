// Unit test: google-translate _fetchTranslate 必含 15s fetch-level timeout(v1.9.21)
//
// 背景:Google Translate 非官方端點 typical < 1s 回,但偶爾會 hang(連 retry 都沒)。
// 跟 Gemini / OpenAI 對齊 15s。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_PATH = path.resolve(__dirname, '../../shinkansen/lib/google-translate.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf-8');

test('FETCH_TIMEOUT_MS 常數為 15_000', () => {
  expect(
    SRC,
    'google-translate.js 缺 `const FETCH_TIMEOUT_MS = 15_000`',
  ).toMatch(/const\s+FETCH_TIMEOUT_MS\s*=\s*15_000\s*;/);
});

test('_fetchTranslate 內含 AbortController + setTimeout(abort, FETCH_TIMEOUT_MS)', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  expect(fnStart, 'google-translate.js 找不到 _fetchTranslate').toBeGreaterThan(-1);
  const fnBody = SRC.slice(fnStart, fnStart + 1500);

  expect(fnBody, '缺 AbortController').toMatch(/new\s+AbortController\s*\(\s*\)/);
  expect(
    fnBody,
    '缺 `setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)`',
  ).toMatch(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*controller\.abort\s*\(\s*\)\s*,\s*FETCH_TIMEOUT_MS\s*\)/);
});

test('fetch 帶 `signal: controller.signal`', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_fetchTranslate fetch options 缺 `signal: controller.signal`',
  ).toMatch(/signal\s*:\s*controller\.signal/);
});

test('AbortError 轉換成有意義訊息(不裸 throw AbortError)', () => {
  const fnStart = SRC.indexOf('async function _fetchTranslate');
  const fnBody = SRC.slice(fnStart, fnStart + 1500);
  expect(
    fnBody,
    '_fetchTranslate 缺 AbortError → `Google Translate 逾時(...)` 訊息轉換',
  ).toMatch(/err\.name\s*===\s*['"]AbortError['"][\s\S]{0,200}逾時/);
});
