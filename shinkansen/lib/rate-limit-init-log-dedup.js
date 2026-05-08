// rate-limit-init-log-dedup.js — 判斷是否該寫一條 'rate limiter initialized' log
//
// 為什麼要這個:MV3 service worker 是 idle-die 設計(30 秒 idle 就被 chrome 殺掉),
// 任何訊息 / alarm / event 又重新 cold start → background.js 模組重新 load →
// `initLimiter()` 又跑 → 又寫一條 INFO log。Debug 分頁看到一堆同一行重複出現
// (5-25 分鐘間隔)很雜,但其實 limits 完全沒變。
//
// 設計:
//   - 同 payload(tier / model / rpm / tpm / rpd / safetyMargin 全相等)+ 24h 內 → 跳過 log
//   - payload 變化(tier 切換 / override 改 / model 換)→ 立刻 log(視為「值得記」事件)
//   - 24h 過期 → log 一次刷新時間戳,給使用者一個「我還活著」的訊號
//   - prev 為 null / undefined(第一次 init / 砍快取後)→ log

/**
 * @param {{ payload: object, timestamp: number } | null | undefined} prev
 * @param {number} now Date.now()
 * @param {object} payload 本次 init 的 limits + tier 資訊
 * @returns {boolean} 是否該寫 log(true = 寫)
 */
export function shouldLogInit(prev, now, payload) {
  if (!prev) return true;
  const elapsed = now - (Number(prev.timestamp) || 0);
  if (elapsed >= 24 * 60 * 60 * 1000) return true;
  return JSON.stringify(prev.payload) !== JSON.stringify(payload);
}
