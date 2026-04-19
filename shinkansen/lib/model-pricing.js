// model-pricing.js — Gemini 模型計價表（Standard tier，USD per 1M tokens）
// 來源：https://ai.google.dev/gemini-api/docs/pricing
// 結構對齊 settings.pricing，可直接當 effectivePricing 使用。
//
// v1.4.12：preset 快速鍵按 modelOverride 觸發翻譯時，由 background.js handleTranslate
// 依當下 model 查此表覆蓋 settings.pricing，讓 toast 顯示的費用與 usage log 跟 model 走。
// 使用者若在 options 頁有自訂 settings.pricing，該值在「沒有 modelOverride」時仍會被使用。
export const MODEL_PRICING = {
  'gemini-3.1-flash-lite-preview': { inputPerMTok: 0.10, outputPerMTok: 0.30 },
  'gemini-3-flash-preview':        { inputPerMTok: 0.50, outputPerMTok: 3.00 },
  'gemini-3.1-pro-preview':        { inputPerMTok: 2.00, outputPerMTok: 12.00 },
};

export function getPricingForModel(model) {
  if (!model) return null;
  return MODEL_PRICING[model] || null;
}
