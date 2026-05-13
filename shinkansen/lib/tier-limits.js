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

// v0.96：依 2026-04 AI Studio 實際數值全面更新。
// Unlimited RPD 以 Infinity 表示，rate limiter 的比較邏輯可正確處理。
export const TIER_LIMITS = {
  free: {
    'gemini-3-flash-preview':        { rpm: 10,   tpm: 250_000,   rpd: 250 },
    'gemini-3.1-flash-lite': { rpm: 15,   tpm: 250_000,   rpd: 1_000 },
    'gemini-3.1-pro-preview':        { rpm: 5,    tpm: 250_000,   rpd: 100 },
  },
  tier1: {
    'gemini-3-flash-preview':        { rpm: 1000, tpm: 2_000_000, rpd: 10_000 },
    'gemini-3.1-flash-lite': { rpm: 4000, tpm: 4_000_000, rpd: 150_000 },
    'gemini-3.1-pro-preview':        { rpm: 225,  tpm: 2_000_000, rpd: 250 },
  },
  tier2: {
    'gemini-3-flash-preview':        { rpm: 2000,  tpm: 3_000_000,  rpd: 100_000 },
    'gemini-3.1-flash-lite': { rpm: 10000, tpm: 10_000_000, rpd: 350_000 },
    'gemini-3.1-pro-preview':        { rpm: 1000,  tpm: 5_000_000,  rpd: 50_000 },
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
  const model = settings?.geminiConfig?.model || 'gemini-3-flash-preview';
  const tierTable = TIER_LIMITS[tier];
  const base = (tierTable && tierTable[model]) || FALLBACK_LIMITS;

  return {
    rpm: Number(settings?.rpmOverride) || base.rpm,
    tpm: Number(settings?.tpmOverride) || base.tpm,
    rpd: Number(settings?.rpdOverride) || base.rpd,
    safetyMargin: typeof settings?.safetyMargin === 'number' ? settings.safetyMargin : 0.1,
  };
}
