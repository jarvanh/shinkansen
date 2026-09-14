// probe-detect-perf.mjs — 偵測 / 序列化效能 probe（2026-09-14 code review 批次 7）
//
// 用途：載入 working tree extension（dev tail），對指定 URL 走 Debug Bridge
// PROFILE_DETECT / PROFILE_SERIALIZE，量 collectParagraphs / 序列化 / 反序列化耗時，
// 並存下單元簽章（kind|tag|len|前 40 字）與序列化簽章供改動前後等價比對。
//
// 用法：
//   node tools/probes/probe-detect-perf.mjs --label before [--url URL] [--runs 5] [--serialize]
//   node tools/probes/probe-detect-perf.mjs --compare before after
//   --ext <path>   指定 extension 目錄（預設 shinkansen/；量「改動前」時指向 git 取出的副本）
//   --live         直接打線上 URL（預設：第一次抓頁面存快照到 .playwright-mcp/detect-perf-snap/，
//                  之後由本機 http server 提供同一份 DOM，前後對照才不受廣告 / 動態內容干擾）
//   --cpuprofile   CDP CPU profile，印 self-time top 25
//   PROBE_HEADED=1 顯示視窗；每次都用全新 profile（避開 SW 模組快取）
//
// 輸出：.playwright-mcp/detect-perf-<label>-<host>-<path>.json
// 對照：--compare 印出兩份 summary 差異（新增 / 消失單元）與耗時中位數。

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const EXT_PATH = path.join(ROOT, 'shinkansen');
const OUT_DIR = path.join(ROOT, '.playwright-mcp');
const HEADED = process.env.PROBE_HEADED === '1';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const LABEL = opt('--label', 'run');
const URLS = (opt('--url', 'https://en.wikipedia.org/wiki/Taiwan')).split(',');
const RUNS = Number(opt('--runs', '5'));
const SERIALIZE = argv.includes('--serialize');
const COMPARE = argv.indexOf('--compare');
const CPUPROFILE = argv.includes('--cpuprofile');
const LIVE = argv.includes('--live');
const EXT_OVERRIDE = opt('--ext', null);
const SNAP_DIR = path.join(OUT_DIR, 'detect-perf-snap');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function slug(url) {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop() || 'index';
  return `${u.hostname}-${last}`.replace(/[^a-z0-9.]/gi, '_').slice(0, 80);
}
function outPath(label, url) {
  return path.join(OUT_DIR, `detect-perf-${label}-${slug(url)}.json`);
}
function snapPath(url) { return path.join(SNAP_DIR, `${slug(url)}.html`); }

import http from 'node:http';
// 本機快照 server：/<slug> 回存好的 HTML（已注入 <base href> 讓相對資源仍指原站）
function startSnapServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(SNAP_DIR, decodeURIComponent(req.url.slice(1)) + '.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('no snapshot'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
async function ensureSnapshot(context, url) {
  const file = snapPath(url);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(5000);
  let html = await page.content();
  const base = `<base href="${new URL(url).origin}/">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  fs.writeFileSync(file, html);
  await page.close();
  console.log(`[snapshot] ${url} → ${path.relative(ROOT, file)} (${(html.length / 1024).toFixed(0)}KB)`);
}

if (COMPARE >= 0) {
  const a = argv[COMPARE + 1], b = argv[COMPARE + 2];
  for (const url of URLS) {
    const A = JSON.parse(fs.readFileSync(outPath(a, url), 'utf8'));
    const B = JSON.parse(fs.readFileSync(outPath(b, url), 'utf8'));
    const setA = new Set(A.summary), setB = new Set(B.summary);
    const gone = A.summary.filter((s) => !setB.has(s));
    const added = B.summary.filter((s) => !setA.has(s));
    console.log(`\n=== ${url}`);
    console.log(`units: ${A.unitCount} → ${B.unitCount}  | detect median ms: ${median(A.timesMs)} → ${median(B.timesMs)}  (all: ${A.timesMs.join(',')} → ${B.timesMs.join(',')})`);
    if (A.serializeTimesMs) {
      console.log(`serialize median ms: ${median(A.serializeTimesMs)} → ${median(B.serializeTimesMs)} | deserialize median ms: ${median(A.deserializeTimesMs)} → ${median(B.deserializeTimesMs)} | slots ${A.totalSlots} → ${B.totalSlots}`);
      const sA = new Set(A.serSummary), sB = new Set(B.serSummary);
      const sGone = A.serSummary.filter((s) => !sB.has(s)), sAdded = B.serSummary.filter((s) => !sA.has(s));
      console.log(`serialize signature diff: gone ${sGone.length}, added ${sAdded.length}`);
      sGone.slice(0, 10).forEach((s) => console.log('  - ' + s));
      sAdded.slice(0, 10).forEach((s) => console.log('  + ' + s));
    }
    console.log(`summary diff: gone ${gone.length}, added ${added.length}${gone.length + added.length === 0 ? '  ✅ 等價' : ''}`);
    gone.slice(0, 20).forEach((s) => console.log('  - ' + s));
    added.slice(0, 20).forEach((s) => console.log('  + ' + s));
  }
  process.exit(0);
}

async function getIsolatedEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  cdp.on('Runtime.executionContextDestroyed', (e) => {
    const idx = contexts.findIndex((c) => c.id === e.executionContextId);
    if (idx >= 0) contexts.splice(idx, 1);
  });
  await cdp.send('Runtime.enable');
  await sleep(500);
  const target = contexts.filter((c) => c?.auxData?.type === 'isolated').find((c) => /Shinkansen/i.test(c.name || ''));
  if (!target) throw new Error('找不到 Shinkansen isolated world');
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { contextId: target.id, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`evaluate 失敗: ${r.exceptionDetails.text}`);
    return r.result.value;
  };
  evaluate.cdp = cdp;
  return evaluate;
}

// CPU profile：self time 依函式名彙總（top 25）
async function withCpuProfile(cdp, fn) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  const r = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; const samples = profile.samples;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anon)'} @${path.basename(cf.url || '')}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`  CPU profile self-time top 25 (total ${(total / 1000).toFixed(1)} ms):`);
  for (const [k, v] of top) console.log(`    ${(v / 1000).toFixed(1).padStart(7)} ms  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
  return r;
}

async function bridge(evaluate, action, extra = {}) {
  return evaluate(`new Promise((resolve) => {
    const onResp = (e) => { window.removeEventListener('shinkansen-debug-response', onResp); resolve(e.detail); };
    window.addEventListener('shinkansen-debug-response', onResp);
    window.dispatchEvent(new CustomEvent('shinkansen-debug-request', { detail: ${JSON.stringify({ action, ...extra })} }));
    setTimeout(() => { window.removeEventListener('shinkansen-debug-response', onResp); resolve({ ok: false, error: 'TIMEOUT' }); }, 120000);
  })`);
}

const extPath = EXT_OVERRIDE ? path.resolve(EXT_OVERRIDE) : EXT_PATH;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-detectperf-'));
const context = await chromium.launchPersistentContext(profileDir, {
  headless: !HEADED,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--mute-audio'],
  viewport: { width: 1280, height: 900 },
});
let snap = null;
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!LIVE) snap = await startSnapServer();
  for (const url of URLS) {
    const page = await context.newPage();
    let target = url;
    if (!LIVE) {
      await ensureSnapshot(context, url);
      target = `http://127.0.0.1:${snap.port}/${slug(url)}`;
    }
    await page.goto(target, { waitUntil: 'load', timeout: 90000 });
    await sleep(4000);
    const evaluate = await getIsolatedEvaluator(page);
    const version = await evaluate('window.__shinkansen.version');
    // 暖機一輪（layout / style 快取進穩態），不計入
    await bridge(evaluate, 'PROFILE_DETECT', { runs: 1 });
    const res = CPUPROFILE
      ? await withCpuProfile(evaluate.cdp, () => bridge(evaluate, SERIALIZE ? 'PROFILE_SERIALIZE' : 'PROFILE_DETECT', { runs: RUNS }))
      : await bridge(evaluate, SERIALIZE ? 'PROFILE_SERIALIZE' : 'PROFILE_DETECT', { runs: RUNS });
    if (!res.ok) throw new Error(`${url}: ${res.error}`);
    const times = res.timesMs || res.detectTimesMs;
    const rec = { url, version, label: LABEL, unitCount: res.unitCount, timesMs: times, summary: res.summary, skipStats: res.skipStats };
    if (SERIALIZE) {
      Object.assign(rec, { serializeTimesMs: res.serializeTimesMs, deserializeTimesMs: res.deserializeTimesMs, totalSlots: res.totalSlots, serSummary: res.serSummary });
      // summary 由 PROFILE_DETECT 補
      const d = await bridge(evaluate, 'PROFILE_DETECT', { runs: 1 });
      rec.summary = d.summary; rec.skipStats = d.skipStats;
    }
    fs.writeFileSync(outPath(LABEL, url), JSON.stringify(rec, null, 1));
    console.log(`[${LABEL}${EXT_OVERRIDE ? ' ext=' + EXT_OVERRIDE : ''}${LIVE ? ' live' : ' snap'}] ${url}  v${version}  units=${res.unitCount}  detect ms=${times.join(',')} (median ${median(times)})`
      + (SERIALIZE ? `  serialize ms=${res.serializeTimesMs.join(',')} (median ${median(res.serializeTimesMs)})  deserialize ms=${res.deserializeTimesMs.join(',')} (median ${median(res.deserializeTimesMs)})  slots=${res.totalSlots}` : ''));
    await page.close();
  }
} finally {
  await context.close();
  if (snap) snap.server.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
}
