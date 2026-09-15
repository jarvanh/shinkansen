// probe-implicit-cache.mjs — 直接打 Gemini API 驗 implicit cache 是否命中（2026-09-14）
// 背景：harness 實測 HN / 維基百科 129 批、Lite 與 3.8 Flash、並行 30 與 4，
// usageMetadata.cachedContentTokenCount 全為 0。本 probe 排除 extension 端因素：
// 同一份 systemInstruction 連打 N 次（contents 每次不同），印原始 usageMetadata。
// 變因：模型 × prompt 放置位置（systemInstruction vs contents 首段）× prompt 長度。
// 用法：node tools/probes/probe-implicit-cache.mjs   （key 讀 ~/.shinkansen-test-key）
import fs from 'fs'; import os from 'os'; import path from 'path';
const KEY = fs.readFileSync(path.join(os.homedir(), '.shinkansen-test-key'), 'utf8').trim();
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const base = '你是專業翻譯。以下規則必須遵守。'.repeat(1);
const filler = (n) => Array.from({ length: n }, (_, i) => `規則 ${i + 1}：翻譯時保留原文的語氣、術語與段落結構，遇到專有名詞先查對照表，沒有對照時依台灣慣用譯法處理，不可自行省略或增補內容，也不可把兩段合併成一段。`).join('\n');
const PROMPTS = { short: base + '\n' + filler(30), long: base + '\n' + filler(75) };   // 約 2.5K / 6K tokens
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(model, body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
  const j = await res.json(); if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  return j.usageMetadata;
}
for (const model of MODELS) for (const [plen, prompt] of Object.entries(PROMPTS)) for (const place of ['systemInstruction', 'contents']) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const text = `第 ${i} 句：The quick brown fox number ${Date.now()} jumps over the lazy dog. 請翻成繁體中文。`;
    const body = place === 'systemInstruction'
      ? { systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { maxOutputTokens: 64 } }
      : { contents: [{ role: 'user', parts: [{ text: prompt + '\n\n' + text }] }], generationConfig: { maxOutputTokens: 64 } };
    try { const u = await call(model, body); out.push(`prompt=${u.promptTokenCount} cached=${u.cachedContentTokenCount || 0}`); }
    catch (e) { out.push('ERR ' + e.message.slice(0, 120)); }
    await sleep(1500);
  }
  console.log(`${model} | ${plen} | ${place}\n   ` + out.join('\n   '));
}
