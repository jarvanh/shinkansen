// rate-limiter.js — 三維度 sliding window rate limiter + priority queue
//
// 對應 Gemini API 的三維度限制：
//   RPM: 每分鐘請求數       (sliding 60 秒視窗)
//   TPM: 每分鐘 input tokens(sliding 60 秒視窗)
//   RPD: 每日請求數         (太平洋時間午夜重置,persist 到 chrome.storage.local)
//
// 使用方式：
//   const limiter = new RateLimiter({ rpm, tpm, rpd, safetyMargin });
//   await limiter.acquire(estInputTokens);
//   // ... 做實際的 API 請求
//
// 特性:
// - acquire() 是 async,若任何維度超限會自動 setTimeout 等待到最近的釋放點後遞迴重試
// - 內部維護兩個 sliding window 環形緩衝區（requests 與 tokens)
// - priority queue: p0 優先於 p1（為未來術語表請求保留的插隊機制,v0.35 MVP 未使用）
// - RPD 計數透過 chrome.storage.local 持久化,service worker 被回收也不丟
// - 安全邊際（safetyMargin)：每個上限實際只用 (1 - margin) 比例,避免踩邊觸發 429
//
// 注意：service worker 重啟後,RPM/TPM 的 sliding window 視同清空
//（這是可接受的漂移,因為 Gemini 自己也是 rolling window、容錯度高）,
// 但 RPD 會從 storage 讀回,避免使用者配額累計錯亂。

import { debugLog } from './logger.js';

const WINDOW_MS = 60_000;
const RPD_KEY_PREFIX = 'rateLimit_rpd_';

/** 取得太平洋時間的 YYYYMMDD 字串,用於 RPD key。 */
function getPacificDateKey(now = new Date()) {
  // Intl 方式比手動計算時差更可靠（自動處理 DST)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now).replace(/-/g, ''); // YYYYMMDD
}

export class RateLimiter {
  constructor({ rpm, tpm, rpd, safetyMargin = 0.1 }) {
    this.updateLimits({ rpm, tpm, rpd, safetyMargin });

    // Sliding window 緩衝區
    this.requests = [];              // 時間戳陣列（ms）
    this.tokens = [];                // { t: 時間戳, n: token 數 }

    // RPD 狀態（從 storage 讀入）
    this.rpdDateKey = null;          // 對應哪一天
    this.rpdCount = 0;
    this.rpdLoaded = false;
    this.rpdLoadingPromise = null;

    // Priority queue(p0 優先 / p1 一般)
    // 每個 entry: { estTokens, resolve, reject }
    this.p0 = [];
    this.p1 = [];

    // 是否有 dispatcher 正在跑
    this.dispatching = false;
  }

  updateLimits({ rpm, tpm, rpd, safetyMargin = 0.1 }) {
    this.safetyMargin = Math.max(0, Math.min(0.5, safetyMargin));
    const factor = 1 - this.safetyMargin;
    this.rpmCap = Math.max(1, Math.floor(rpm * factor));
    this.tpmCap = Math.max(1, Math.floor(tpm * factor));
    this.rpdCap = Math.max(1, Math.floor(rpd * factor));
  }

  async loadRpdIfNeeded() {
    if (this.rpdLoaded) {
      // 跨日檢查
      const nowKey = getPacificDateKey();
      if (nowKey !== this.rpdDateKey) {
        this.rpdDateKey = nowKey;
        this.rpdCount = 0;
        await this.persistRpd();
      }
      return;
    }
    if (this.rpdLoadingPromise) {
      await this.rpdLoadingPromise;
      return;
    }
    this.rpdLoadingPromise = (async () => {
      const nowKey = getPacificDateKey();
      const storageKey = RPD_KEY_PREFIX + nowKey;
      const result = await chrome.storage.local.get(storageKey);
      this.rpdDateKey = nowKey;
      this.rpdCount = Number(result[storageKey]) || 0;
      this.rpdLoaded = true;

      // 順手清掉前幾天的 RPD key（garbage collection)
      const all = await chrome.storage.local.get(null);
      const staleKeys = Object.keys(all).filter(
        k => k.startsWith(RPD_KEY_PREFIX) && k !== storageKey
      );
      if (staleKeys.length) {
        await chrome.storage.local.remove(staleKeys);
      }
    })();
    await this.rpdLoadingPromise;
    this.rpdLoadingPromise = null;
  }

  async persistRpd() {
    if (!this.rpdDateKey) return;
    const storageKey = RPD_KEY_PREFIX + this.rpdDateKey;
    await chrome.storage.local.set({ [storageKey]: this.rpdCount });
  }

  /** 清除 60 秒之前的舊時間戳。 */
  pruneWindow(now) {
    const cutoff = now - WINDOW_MS;
    while (this.requests.length && this.requests[0] < cutoff) {
      this.requests.shift();
    }
    while (this.tokens.length && this.tokens[0].t < cutoff) {
      this.tokens.shift();
    }
  }

  /** 取得目前 60 秒視窗內累積的 token 數。 */
  currentTokenSum() {
    return this.tokens.reduce((s, e) => s + e.n, 0);
  }

  /**
   * 等待並取得一個 slot。若任何維度超限則等待到最近的釋放時間點再試。
   * @param {number} estTokens 本次請求估計 input token 數
   * @param {number} priority 0 = 高(術語表)/ 1 = 一般翻譯
   * @returns {Promise<void>}
   */
  async acquire(estTokens, priority = 1) {
    await this.loadRpdIfNeeded();
    return new Promise((resolve, reject) => {
      const entry = { estTokens, resolve, reject };
      if (priority === 0) this.p0.push(entry);
      else this.p1.push(entry);
      this.scheduleDispatch();
    });
  }

  scheduleDispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    // 用 microtask 啟動,避免 recursive stack
    Promise.resolve().then(() => this.dispatchLoop());
  }

  async dispatchLoop() {
    try {
      while (this.p0.length || this.p1.length) {
        const entry = this.p0.length ? this.p0[0] : this.p1[0];
        const fromP0 = this.p0.length > 0;
        const waitMs = this.computeWaitMs(entry.estTokens);

        if (waitMs > 0) {
          await this.sleep(waitMs);
          continue; // 重跑 loop 重新檢查（因為期間可能跨日或狀態改變）
        }

        // 可以放行了
        if (fromP0) this.p0.shift();
        else this.p1.shift();

        const now = Date.now();
        this.requests.push(now);
        this.tokens.push({ t: now, n: entry.estTokens });
        this.rpdCount += 1;
        // Persist RPD 寫入不等待完成（小量資料,容忍短暫不一致）
        this.persistRpd().catch(err =>
          debugLog('warn', 'rpd persist failed', { error: err.message })
        );
        entry.resolve();
      }
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * 判斷目前若要放 estTokens 這一次,需要等幾毫秒。
   * 回傳 0 代表可以立即放行。
   */
  computeWaitMs(estTokens) {
    const now = Date.now();
    this.pruneWindow(now);

    // RPD 檢查（此維度不是時間視窗,爆了就是明天才能繼續,不 wait)
    if (this.rpdCount + 1 > this.rpdCap) {
      // 特殊回傳：代表 RPD 爆了,上層呼叫應把隊伍都 reject。
      // 但為了實作簡單,這裡讓它等到太平洋午夜再 retry。
      // v0.35 MVP：直接丟到一個很大的 wait（24 小時）避免 busy-loop,
      // 實務上使用者會看到 toast 卡住,自己取消。未來可改成更友善處理。
      return 24 * 60 * 60 * 1000;
    }

    let wait = 0;

    // RPM 檢查：若當前請求數 + 1 > cap,需等到最早的時間戳滑出視窗
    if (this.requests.length + 1 > this.rpmCap) {
      const earliest = this.requests[this.requests.length - this.rpmCap];
      const releaseAt = earliest + WINDOW_MS;
      wait = Math.max(wait, releaseAt - now + 5);
    }

    // TPM 檢查：若 (當前 token + 新 estTokens) > cap,需等到足夠的 token 滑出
    const currentTok = this.currentTokenSum();
    if (currentTok + estTokens > this.tpmCap) {
      // 從最舊的 token 開始累計,找出需要滑掉多少才夠容納 estTokens
      const needToRelease = currentTok + estTokens - this.tpmCap;
      let released = 0;
      for (const e of this.tokens) {
        released += e.n;
        if (released >= needToRelease) {
          const releaseAt = e.t + WINDOW_MS;
          wait = Math.max(wait, releaseAt - now + 5);
          break;
        }
      }
      // 理論上不會跑完迴圈,但保險：若單一請求的 estTokens 就大於 tpmCap,等一個完整視窗
      if (released < needToRelease) {
        wait = Math.max(wait, WINDOW_MS + 5);
      }
    }

    return wait;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 取得目前狀態快照,供 popup / debug 顯示。 */
  snapshot() {
    const now = Date.now();
    this.pruneWindow(now);
    return {
      rpmUsed: this.requests.length,
      rpmCap: this.rpmCap,
      tpmUsed: this.currentTokenSum(),
      tpmCap: this.tpmCap,
      rpdUsed: this.rpdCount,
      rpdCap: this.rpdCap,
      rpdDateKey: this.rpdDateKey,
      safetyMargin: this.safetyMargin,
      queued: this.p0.length + this.p1.length,
    };
  }
}
