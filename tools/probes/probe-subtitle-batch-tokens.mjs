// probe-subtitle-batch-tokens.mjs — 字幕翻譯每批固定 prompt 開銷量測（2026-09-15）
// 用 Gemini countTokens（免費）量 background 實際送出的字幕請求在不同批次大小下的 input token，
// 拆出「固定開銷」與「每則內容」兩部分。不需要 YouTube 播放，不打 generateContent。
//   A) 人工字幕 / ASR heuristic 合句路徑：DEFAULT_SUBTITLE_SYSTEM_PROMPT + «N» 序號 + <<<SHINKANSEN_SEP>>>
//      （預設不套固定術語表 / 禁用詞，見 background TRANSLATE_SUBTITLE_BATCH*）
//   B) ASR AI 分句路徑：DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT + JSON [{s,e,t}]（timestamp 模式）
// 用法：node tools/probes/probe-subtitle-batch-tokens.mjs   （key 讀 ~/.shinkansen-test-key）
import fs from 'fs'; import os from 'os'; import path from 'path';
import * as storage from '../../shinkansen/lib/storage.js';
import { buildEffectiveSystemInstruction, MARKER_COMPACT, DELIMITER } from '../../shinkansen/lib/system-instruction.js';
const KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
const MODEL = 'gemini-3.1-flash-lite';
const subSys = storage.getEffectiveSubtitleSystemPrompt ? storage.getEffectiveSubtitleSystemPrompt('zh-TW', '') : storage.DEFAULT_SUBTITLE_SYSTEM_PROMPT;
const asrSys = storage.getEffectiveAsrSubtitleSystemPrompt ? storage.getEffectiveAsrSubtitleSystemPrompt('zh-TW', 'en') : storage.DEFAULT_ASR_SUBTITLE_SYSTEM_PROMPT;
async function count(body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ generateContentRequest: { model: `models/${MODEL}`, ...body } }) });
  const j = await res.json(); if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 200)); return j.totalTokens;
}
// 典型人工字幕 / 合句單位：8–12 個英文字、40–60 字元
const CUES = [
  'So the first car on my list is actually one you might not expect.', 'It has a naturally aspirated V8 and a proper manual gearbox.',
  'I drove one of these for about a week last summer.', 'The steering is heavier than most modern cars, in a good way.',
  'You can find clean examples for well under thirty thousand dollars.', 'That said, the interior has not aged particularly well.',
  'Let me know in the comments if you agree with this pick.', 'My second choice is a little more controversial, I think.',
  'People forget how quick these were when they came out.', 'The suspension setup makes it surprisingly comfortable on long trips.',
  'Parts availability is still pretty good, which matters for a daily driver.', 'Okay, moving on to something a bit more modern now.',
];
const cue = (i) => CUES[i % CUES.length];
const rows = [];
for (const n of [1, 2, 4, 8, 12, 16, 20, 30]) {
  const texts = Array.from({ length: n }, (_, i) => cue(i));
  const marked = n > 1 ? texts.map((t, i) => MARKER_COMPACT.fmt(i + 1) + t) : texts;
  const joined = marked.join(DELIMITER);
  const sys = buildEffectiveSystemInstruction(subSys, texts, joined, null, [], []);
  const total = await count({ contents: [{ role: 'user', parts: [{ text: joined }] }], systemInstruction: { parts: [{ text: sys }] } });
  const contentOnly = await count({ contents: [{ role: 'user', parts: [{ text: texts.join('\n') }] }] });
  rows.push({ path: 'subtitle', n, total, contentOnly, perCue: Math.round(total / n), overhead: total - contentOnly });
}
// ASR 片段：1–3 字、平均 2.5 條/秒；子批 0 跨 4–8s，後續子批約 8–12s
const WORDS = 'so the first car on my list is actually one you might not expect it has a naturally aspirated v8 and a proper manual gearbox i drove one of these for about a week last summer the steering is heavier than most modern cars in a good way'.split(' ');
function asrSegs(n) { const out = []; let t = 12000; for (let i = 0; i < n; i++) { const w = 1 + (i % 3); const text = WORDS.slice((i * 2) % WORDS.length, (i * 2) % WORDS.length + w).join(' ') || 'and'; out.push({ s: t, e: t + 400 * w, t: text }); t += 400 * w + 100; } return out; }
for (const n of [10, 20, 40, 80]) {
  const segs = asrSegs(n);
  const inputJson = JSON.stringify(segs);
  const total = await count({ contents: [{ role: 'user', parts: [{ text: inputJson }] }], systemInstruction: { parts: [{ text: asrSys }] } });
  const contentOnly = await count({ contents: [{ role: 'user', parts: [{ text: inputJson }] }] });
  const plainOnly = await count({ contents: [{ role: 'user', parts: [{ text: segs.map(s => s.t).join(' ') }] }] });
  // 典型輸出：每 ~8 條 ASR 片段合成一句，輸出 [{"s","e","t"}]
  const sentences = Math.max(1, Math.round(n / 8));
  const outJson = JSON.stringify(Array.from({ length: sentences }, (_, i) => ({ s: 12000 + i * 3000, e: 15000 + i * 3000, t: '所以我清單上的第一台車其實是一台你可能想不到的車' })));
  const outTokens = await count({ contents: [{ role: 'user', parts: [{ text: outJson }] }] });
  const outPlain = await count({ contents: [{ role: 'user', parts: [{ text: Array.from({ length: sentences }, () => '所以我清單上的第一台車其實是一台你可能想不到的車').join('\n') }] }] });
  rows.push({ path: 'asr-json', n, total, contentOnly, plainOnly, jsonWrapOverhead: contentOnly - plainOnly, sysOverhead: total - contentOnly, outTokens, outPlain, sentences });
}
console.log(JSON.stringify({ model: MODEL, subtitleSysChars: subSys.length, asrSysChars: asrSys.length, rows }, null, 1));
