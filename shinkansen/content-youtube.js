// content-youtube.js — Shinkansen YouTube 字幕翻譯模組（isolated world）
// v1.2.11：時間視窗批次翻譯架構
//
// 核心設計：
//   1. XHR 攔截（MAIN world）→ 取得含時間戳的字幕 → rawSegments[{text,normText,startMs}]
//   2. 按時間視窗翻譯（預設 30 秒一批），video.timeupdate 驅動觸發下一批
//   3. 在剩餘時間 < lookaheadS（預設 10 秒）時提前翻譯下一批
//   4. observer 在第一批翻完後才啟動，避免英文閃爍
//   5. 字幕翻譯設定（prompt/temperature/windowSizeS/lookaheadS）從 ytSubtitle settings 讀取

(function(SK) {

  // ─── 預設設定（storage 讀不到時用這組） ────────────────────
  const DEFAULT_YT_CONFIG = {
    windowSizeS:  30,
    lookaheadS:   10,
    debugToast:   false,
  };

  // ─── Debug 狀態面板 ─────────────────────────────────────
  // 開啟 ytSubtitle.debugToast 後，頁面左上角顯示即時狀態面板。

  let _debugEl        = null;
  let _debugInterval  = null;
  let _lastEvent      = '—';
  // debugToast 開啟時，記錄已 log 過的 miss key，避免同一條字幕重複刷 log
  let _debugMissedKeys = new Set();

  function _debugRender() {
    if (!_debugEl) return;
    const YT = SK.YT;
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs : 0;
    const video  = YT.videoEl || document.querySelector('video');
    const curS   = video ? video.currentTime.toFixed(1) : '0.0';
    const config = YT.config || DEFAULT_YT_CONFIG;
    _debugEl.textContent = [
      '🔍 Shinkansen 字幕 Debug',
      `active      : ${YT.active}`,
      `translating : ${YT.translating}`,
      `rawSegments : ${YT.rawSegments.length} 條（涵蓋 ${Math.round(maxMs/1000)}s）`,
      `captionMap  : ${YT.captionMap.size} 條`,
      `translated↑ : ${Math.round(YT.translatedUpToMs/1000)}s`,
      `video now   : ${curS}s`,
      `window/look : ${config.windowSizeS}s / ${config.lookaheadS}s`,
      `事件        : ${_lastEvent.length > 36 ? _lastEvent.slice(0, 35) + '…' : _lastEvent}`,
    ].join('\n');
  }

  function _debugUpdate(eventLabel) {
    const YT = SK.YT;
    if (!YT.config?.debugToast) return;
    _lastEvent = eventLabel;

    if (!_debugEl) {
      _debugEl = document.createElement('div');
      _debugEl.id = '__sk-yt-debug';
      Object.assign(_debugEl.style, {
        position:   'fixed',
        top:        '8px',
        left:       '8px',
        background: 'rgba(0,0,0,0.88)',
        color:      '#39ff14',
        fontFamily: 'monospace',
        fontSize:   '11px',
        lineHeight: '1.65',
        padding:    '8px 12px',
        borderRadius: '6px',
        zIndex:     '2147483647',
        maxWidth:   '340px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      });
      document.body.appendChild(_debugEl);
      // 啟動 500ms 重繪 timer，讓 video now / captionMap 等欄位即時更新
      _debugInterval = setInterval(_debugRender, 500);
    }

    _debugRender();
  }

  function _debugRemove() {
    if (_debugInterval) { clearInterval(_debugInterval); _debugInterval = null; }
    if (_debugEl) { _debugEl.remove(); _debugEl = null; }
    _lastEvent = '—';
    _debugMissedKeys.clear();
  }

  // ─── 狀態 ──────────────────────────────────────────────────
  SK.YT = {
    captionMap:       new Map(),   // normText(原文) → 譯文
    rawSegments:      [],          // [{text, normText, startMs}] sorted by startMs
    pendingQueue:     new Map(),   // on-the-fly 備案：normText → [DOM element]
    observer:         null,
    batchTimer:       null,
    flushing:         false,
    active:           false,
    videoId:          null,
    translating:      false,       // 目前是否有視窗正在翻譯（防止重疊）
    translatedUpToMs: 0,           // 已翻譯涵蓋到的時間點（ms）
    config:           null,        // ytSubtitle settings 快取
    videoEl:          null,        // video element（timeupdate 監聽對象）
  };

  // ─── 工具 ──────────────────────────────────────────────────

  SK.isYouTubePage = function isYouTubePage() {
    return location.hostname === 'www.youtube.com'
      && location.pathname.startsWith('/watch');
  };

  function normText(t) {
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getVideoIdFromUrl() {
    return new URL(location.href).searchParams.get('v') || null;
  }

  async function getYtConfig() {
    if (SK.YT.config) return SK.YT.config;
    const saved = await chrome.storage.sync.get('ytSubtitle');
    SK.YT.config = { ...DEFAULT_YT_CONFIG, ...(saved.ytSubtitle || {}) };
    return SK.YT.config;
  }

  // ─── 時間字串轉 ms（TTML 格式 "HH:MM:SS.mmm"） ────────────

  function parseTimeToMs(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    const secs = parts.reduce((acc, p) => acc * 60 + parseFloat(p || 0), 0);
    return Math.round(secs * 1000);
  }

  // ─── 字幕解析：JSON3（含時間戳）────────────────────────────

  function parseJson3(text) {
    const json = JSON.parse(text);
    const segments = [];
    const seen = new Set();
    for (const ev of (json.events || [])) {
      if (!ev.segs) continue;
      const full = ev.segs.map(s => s.utf8 || '').join('');
      // YouTube 以 \n 分隔同一 event 內的多行歌詞；DOM 每行獨立渲染為一個 .ytp-caption-segment
      // 拆行後分別建立條目，確保 normText 與 DOM 字幕對齊，避免落入 on-the-fly
      const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        segments.push({ text: line, normText: normText(line), startMs: ev.tStartMs || 0 });
      }
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 字幕解析：XML/TTML（含時間戳）────────────────────────

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const els = doc.querySelectorAll('text, p');
    const segments = [];
    const seen = new Set();
    for (const el of els) {
      const t = el.textContent.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const begin = el.getAttribute('begin') || '0';
      const startMs = begin.includes(':') ? parseTimeToMs(begin) : parseInt(begin, 10) || 0;
      segments.push({ text: t, normText: normText(t), startMs });
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 自動偵測格式並解析 ────────────────────────────────────

  function parseCaptionResponse(responseText) {
    if (!responseText) return [];
    try { return parseJson3(responseText); } catch (_) {}
    try { return parseTtml(responseText); } catch (_) {}
    return [];
  }

  // ─── 時間視窗翻譯 ──────────────────────────────────────────

  async function translateWindowFrom(windowStartMs) {
    const YT = SK.YT;
    if (YT.translating) return;
    if (!YT.active) return;

    // 取得設定
    const config = await getYtConfig();
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const windowEndMs  = windowStartMs + windowSizeMs;

    // 標記「已排程翻譯到此位置」，防止 timeupdate 重複觸發
    YT.translatedUpToMs = windowEndMs;
    YT.translating = true;

    // 找出本視窗內的字幕（[windowStartMs, windowEndMs)）
    const windowSegs = YT.rawSegments.filter(
      s => s.startMs >= windowStartMs && s.startMs < windowEndMs
    );

    SK.sendLog('info', 'youtube', 'translateWindow start', {
      windowStartMs, windowEndMs, segCount: windowSegs.length,
    });
    if (config.debugToast && windowSegs.length > 0) {
      SK.sendLog('info', 'youtube-debug', 'translateWindow texts', {
        window: `${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s`,
        texts: windowSegs.map(s => ({ ms: s.startMs, norm: s.normText })),
      });
    }
    _debugUpdate(`翻譯視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s（${windowSegs.length} 條）`);

    if (windowSegs.length > 0) {
      // 分批送翻譯（每批 20 筆）
      const BATCH = 20;
      try {
        for (let i = 0; i < windowSegs.length; i += BATCH) {
          if (!YT.active) break; // 翻到一半使用者還原，立刻停止
          const batch = windowSegs.slice(i, i + BATCH);
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_SUBTITLE_BATCH',
            payload: { texts: batch.map(s => s.text), glossary: null },
          });
          if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
          for (let j = 0; j < batch.length; j++) {
            YT.captionMap.set(batch[j].normText, res.result[j] || batch[j].text);
          }
        }
        // 替換目前頁面上已顯示的字幕
        document.querySelectorAll('.ytp-caption-segment').forEach(replaceSegmentEl);
      } catch (err) {
        SK.sendLog('error', 'youtube', 'window translation failed', { error: err.message });
      }
    }

    YT.translating = false;
    _debugUpdate(`視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s 完成（captionMap: ${YT.captionMap.size}）`);

    // 檢查是否還有未翻譯的字幕
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs
      : 0;
    if (YT.translatedUpToMs <= maxMs && YT.active) {
      SK.sendLog('info', 'youtube', 'more captions remain', {
        translatedUpToMs: YT.translatedUpToMs, maxMs,
      });
    }
  }

  // ─── video.timeupdate 驅動（觸發下一視窗）────────────────

  function onVideoTimeUpdate() {
    const YT = SK.YT;
    if (!YT.active || YT.translating || YT.rawSegments.length === 0) return;

    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    const lookaheadMs  = (config.lookaheadS  || 10) * 1000;

    const currentMs = video.currentTime * 1000;

    // 所有字幕都翻完了
    const maxMs = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    // 若距離已翻譯邊界不足 lookaheadMs，或已超過，立刻翻下一批
    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`timeupdate 觸發下一批（now: ${Math.round(currentMs/1000)}s，up to: ${Math.round(YT.translatedUpToMs/1000)}s）`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  function attachVideoListener() {
    const YT = SK.YT;
    const video = document.querySelector('video');
    if (!video || YT.videoEl === video) return;
    if (YT.videoEl) YT.videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
    YT.videoEl = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
  }

  // ─── 接收 MAIN world XHR 攔截結果 ────────────────────────

  window.addEventListener('shinkansen-yt-captions', async (e) => {
    const { url, responseText } = e.detail || {};
    if (!responseText) return;

    const segments = parseCaptionResponse(responseText);
    if (segments.length === 0) return;

    const YT = SK.YT;
    YT.rawSegments = segments;
    const lastMs = segments[segments.length - 1]?.startMs ?? 0;
    SK.sendLog('info', 'youtube', 'XHR captions captured', {
      url: url?.replace(/[?&].*$/, ''),
      count: segments.length,
      firstMs: segments[0]?.startMs,
      lastMs,
    });
    // verbose log：列出全部 rawSegments 原文與 normText，供比對 DOM 字幕用
    const dbgConfig = YT.config || await getYtConfig();
    if (dbgConfig.debugToast) {
      SK.sendLog('info', 'youtube-debug', 'rawSegments full list', {
        count: segments.length,
        segments: segments.map(s => ({ ms: s.startMs, text: s.text, norm: s.normText })),
      });
    }
    _debugUpdate(`XHR 攔截 ${segments.length} 條字幕（至 ${Math.round(lastMs/1000)}s）`);

    // 若 observer 已啟動（使用者先按 Alt+S 再開 CC），立刻翻譯目前視窗
    if (YT.active && !YT.translating && YT.captionMap.size === 0) {
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const config = await getYtConfig();
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      await translateWindowFrom(windowStartMs);
      attachVideoListener();
    }
  });

  // ─── MutationObserver：即時替換字幕 ──────────────────────

  // 判斷字串是否已含中日韓字元（表示已翻譯完成）
  // 用途：el.textContent 賦值會觸發 characterData mutation，若不跳過中文譯文會形成迴圈
  const RE_CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

  function replaceSegmentEl(el) {
    if (!SK.YT.active) return;
    const original = el.textContent.trim();
    if (!original) return;
    // 已含中日韓字元 → 這是我們設置的譯文被 characterData mutation 觸發回呼，直接跳過
    if (RE_CJK.test(original)) return;
    const key = normText(original);

    // 快取命中 → 瞬間替換
    const cached = SK.YT.captionMap.get(key);
    if (cached !== undefined) {
      if (el.textContent !== cached) el.textContent = cached;
      return;
    }

    // 快取未命中（尚未翻譯到的視窗）→ on-the-fly 備案
    if (SK.YT.config?.debugToast && !_debugMissedKeys.has(key)) {
      _debugMissedKeys.add(key);
      SK.sendLog('warn', 'youtube-debug', 'captionMap miss → on-the-fly', {
        domText: original,
        normKey: key,
        captionMapSize: SK.YT.captionMap.size,
        rawSegCount: SK.YT.rawSegments.length,
      });
    }
    if (!SK.YT.pendingQueue.has(key)) SK.YT.pendingQueue.set(key, []);
    SK.YT.pendingQueue.get(key).push(el);
    clearTimeout(SK.YT.batchTimer);
    SK.YT.batchTimer = setTimeout(flushOnTheFly, 300);
  }

  async function flushOnTheFly() {
    const YT = SK.YT;
    if (YT.pendingQueue.size === 0 || YT.flushing) return;
    YT.flushing = true;

    const queue = new Map(YT.pendingQueue);
    YT.pendingQueue.clear();
    const texts = Array.from(queue.keys());

    if (YT.config?.debugToast) {
      SK.sendLog('info', 'youtube-debug', 'flushOnTheFly batch', {
        count: texts.length,
        texts,
      });
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SUBTITLE_BATCH',
        payload: { texts, glossary: null },
      });
      if (!res?.ok) throw new Error(res?.error || '翻譯失敗');

      for (let i = 0; i < texts.length; i++) {
        const key = texts[i];
        const trans = res.result[i] || texts[i];
        YT.captionMap.set(key, trans);
        for (const el of (queue.get(key) || [])) {
          if (document.contains(el) && normText(el.textContent) === key) {
            el.textContent = trans;
          }
        }
      }
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'on-the-fly flush error', { error: err.message });
    }

    YT.flushing = false;
    if (YT.pendingQueue.size > 0) setTimeout(flushOnTheFly, 100);
  }

  function startCaptionObserver() {
    const YT = SK.YT;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }

    // 先替換現有字幕
    document.querySelectorAll('.ytp-caption-segment').forEach(replaceSegmentEl);

    YT.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList.contains('ytp-caption-segment')) {
            replaceSegmentEl(node);
          } else {
            node.querySelectorAll?.('.ytp-caption-segment').forEach(replaceSegmentEl);
          }
        }
        if (m.type === 'characterData') {
          const parent = m.target.parentElement;
          if (parent?.classList?.contains('ytp-caption-segment')) {
            replaceSegmentEl(parent);
          }
        }
      }
    });

    const root =
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('#movie_player') ||
      document.body;

    YT.observer.observe(root, { childList: true, subtree: true, characterData: true });
    SK.sendLog('info', 'youtube', 'caption observer started', {
      root: root.className || root.tagName,
      translatedUpToMs: YT.translatedUpToMs,
    });
    _debugUpdate(`Observer 已啟動（root: ${root.className?.slice(0,30) || root.tagName}）`);
  }

  // ─── 停止 ─────────────────────────────────────────────────

  function stopYouTubeTranslation() {
    const YT = SK.YT;
    clearTimeout(YT.batchTimer);
    YT.batchTimer = null;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
      YT.videoEl = null;
    }
    YT.active           = false;
    YT.translating      = false;
    YT.translatedUpToMs = 0;
    YT.captionMap       = new Map();
    YT.pendingQueue     = new Map();
    _debugRemove();
    SK.sendLog('info', 'youtube', 'stopped');
  }

  SK.stopYouTubeTranslation = stopYouTubeTranslation;

  // ─── 主入口：Alt+S ─────────────────────────────────────────

  SK.translateYouTubeSubtitles = async function translateYouTubeSubtitles() {
    const YT = SK.YT;

    // 切換：再按一次還原
    if (YT.active) {
      stopYouTubeTranslation();
      SK.showToast('success', '已還原原文字幕');
      setTimeout(() => SK.hideToast(), 2000);
      return;
    }

    YT.active  = true;
    YT.videoId = getVideoIdFromUrl();
    YT.config  = null; // 強制重新讀取設定

    const config = await getYtConfig();
    _debugUpdate('字幕翻譯已啟動');

    if (YT.rawSegments.length > 0) {
      // XHR 已攔截到字幕 → 從目前播放位置的視窗開始翻譯
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;

      SK.showToast('loading', '翻譯字幕⋯', { startTimer: true });
      await translateWindowFrom(windowStartMs);
      startCaptionObserver();
      attachVideoListener();

      SK.showToast('success', `字幕翻譯進行中（${YT.captionMap.size} 條已備妥）`);
      setTimeout(() => SK.hideToast(), 3000);

    } else {
      // 尚未攔截到字幕（使用者還沒開 CC）→ 啟動 observer 備案，等 XHR 到來
      startCaptionObserver();
      SK.showToast('success', '字幕翻譯已開啟。請開啟 YouTube 字幕（CC），翻譯將自動開始。');
    }

    SK.sendLog('info', 'youtube', 'activated', {
      videoId: YT.videoId,
      rawSegments: YT.rawSegments.length,
      windowSizeS: config.windowSizeS,
      lookaheadS:  config.lookaheadS,
    });
  };

  // ─── SPA 導航重置 ──────────────────────────────────────────

  window.addEventListener('yt-navigate-finish', () => {
    const YT = SK.YT;
    if (YT.active) stopYouTubeTranslation(); // stopYouTubeTranslation 內已呼叫 _debugRemove
    _debugRemove(); // 確保即使非 active 狀態也清掉面板（內含 _debugMissedKeys.clear()）
    YT.rawSegments      = [];
    YT.captionMap       = new Map();
    YT.translatedUpToMs = 0;
    YT.config           = null;
    YT.videoId          = getVideoIdFromUrl();
    SK.sendLog('info', 'youtube', 'SPA navigation reset');
  });

})(window.__SK);
