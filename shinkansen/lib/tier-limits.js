// tier-limits.js — Gemini API 各層級 rate limit 對照表
//
// 資料來源：ai.google.dev/gemini-api/docs/rate-limits 與 2026 年 Q1 業界整理
// 快照時間：2026-04（v0.35 當下）
//
// Rate limit 三維度：
//   rpm  = Requests Per Minute
//   tpm  = Tokens Per Minute(input tokens)
//   rpd  = Requests Per Day(Pacific Time 午夜重置)
//
// 任何一個維度超過都會觸發 HTTP 429。Google Cloud Project 為配額單位,
// 多把 key 共用同一個 project 會共用額度。
//
// 免費層所有模型共用 250K TPM 池（此處以 per-model 填入相同值,
// 呼叫端如需嚴格計算共用池需自行處理,v0.35 MVP 暫不特別處理）。
//
// 付費層 per-model 各自獨立 TPM 池。
//
// 此對照表為靜態快照,Gemini 規格變動時需 bump extension 版本並更新此表。

export const TIER_LIMITS = {
  free: {
    'gemini-2.5-pro':        { rpm: 5,   tpm: 250_000,   rpd: 100 },
    'gemini-2.5-flash':      { rpm: 10,  tpm: 250_000,   rpd: 250 },
    'gemini-2.5-flash-lite': { rpm: 15,  tpm: 250_000,   rpd: 1000 },
    'gemini-2.0-flash':      { rpm: 15,  tpm: 1_000_000, rpd: 200 },
  },
  tier1: {
    'gemini-2.5-pro':        { rpm: 150, tpm: 1_000_000, rpd: 1000 },
    'gemini-2.5-flash':      { rpm: 300, tpm: 2_000_000, rpd: 1500 },
    'gemini-2.5-flash-lite': { rpm: 300, tpm: 2_000_000, rpd: 1500 },
    'gemini-2.0-flash':      { rpm: 300, tpm: 4_000_000, rpd: 1500 },
  },
  tier2: {
    'gemini-2.5-pro':        { rpm: 1000, tpm: 2_000_000, rpd: 10_000 },
    'gemini-2.5-flash':      { rpm: 2000, tpm: 4_000_000, rpd: 10_000 },
    'gemini-2.5-flash-lite': { rpm: 2000, tpm: 4_000_000, rpd: 10_000 },
    'gemini-2.0-flash':      { rpm: 2000, tpm: 4_000_000, rpd: 10_000 },
  },
};

// 當對照表查不到（例如新模型尚未收錄）時的 fallback,採保守數值。
const FALLBACK_LIMITS = { rpm: 60, tpm: 1_000_000, rpd: 1000 };

/**
 * 依據設定取得有效的 rate limit 數值。
 * 使用者 override 優先於 tier 對照表。
 * @param {object} settings 完整 settings 物件
 * @returns {{ rpm: number, tpm: number, rpd: number, safetyMargin: number }}
 */
export function getLimitsForSettings(settings) {
  const tier = settings?.tier || 'tier1';
  const model = settings?.geminiConfig?.model || 'gemini-2.5-flash';
  const tierTable = TIER_LIMITS[tier];
  const base = (tierTable && tierTable[model]) || FALLBACK_LIMITS;

  return {
    rpm: Number(settings?.rpmOverride) || base.rpm,
    tpm: Number(settings?.tpmOverride) || base.tpm,
    rpd: Number(settings?.rpdOverride) || base.rpd,
    safetyMargin: typeof settings?.safetyMargin === 'number' ? settings.safetyMargin : 0.1,
  };
}
