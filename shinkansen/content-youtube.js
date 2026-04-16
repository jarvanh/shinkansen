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
    windowSizeS: 30,
    lookaheadS:  10,
    debugToast:  false,
    // preserveLineBreaks 已移除 toggle（v1.2.38），永遠 true（見 translateWindowFrom）
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
    const speed  = video ? `${video.playbackRate}x` : '—';
    const config = YT.config || DEFAULT_YT_CONFIG;
    _debugEl.textContent = [
      '🔍 Shinkansen 字幕 Debug',
      `active      : ${YT.active}`,
      `translating : ${YT.translating}`,
      `speed       : ${speed}`,
      `rawSegments : ${YT.rawSegments.length} 條（涵蓋 ${Math.round(maxMs/1000)}s）`,
      `captionMap  : ${YT.captionMap.size} 條`,
      `translated↑ : ${Math.round(YT.translatedUpToMs/1000)}s`,
      `video now   : ${curS}s`,
      `window/look : ${config.windowSizeS}s / ${config.lookaheadS}s`,
      `事件        : ${_lastEvent}`,
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
    let groupCounter = 0;
    for (const ev of (json.events || [])) {
      if (!ev.segs) continue;
      const full = ev.segs.map(s => s.utf8 || '').join('');
      // YouTube 以 \n 分隔同一 event 內的多行歌詞；DOM 每行獨立渲染為一個 .ytp-caption-segment
      // 拆行後分別建立條目，確保 normText 與 DOM 字幕對齊，避免落入 on-the-fly
      // preserveLineBreaks 開啟時，同一 event 的多行共用 groupId，供整組送翻
      const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
      const groupId = lines.length > 1 ? groupCounter++ : null;
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        segments.push({ text: line, normText: normText(line), startMs: ev.tStartMs || 0, groupId });
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

  // ─── 翻譯單位建構（preserveLineBreaks 模式用）────────────
  // preserve=false：每條 segment 各自一個單位（現有行為）
  // preserve=true ：同一 groupId 的 segment 合成一個單位，以空格串接後整組送翻
  //   （不用 \n 串接，避免 LLM 誤輸出 literal \n 字串進譯文）
  //   翻完後第一個 key 存完整合併譯文，其餘 key 存空字串讓 DOM segment 視覺消失

  function buildTranslationUnits(segs, preserve) {
    if (!preserve) {
      return segs.map(s => ({ text: s.text, keys: [s.normText] }));
    }
    const units = [];
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i];
      if (seg.groupId != null) {
        // 收集所有相鄰且 groupId 相同的 segment
        const group = [seg];
        let j = i + 1;
        while (j < segs.length && segs[j].groupId === seg.groupId) {
          group.push(segs[j]);
          j++;
        }
        units.push({ text: group.map(s => s.text).join(' '), keys: group.map(s => s.normText) });
        i = j;
      } else {
        units.push({ text: seg.text, keys: [seg.normText] });
        i++;
      }
    }
    return units;
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
      // 分批送翻譯（每批 20 個翻譯單位）
      const BATCH = 20;
      const preserve = true; // v1.2.38 起固定開啟，已移除設定頁 toggle
      const units = buildTranslationUnits(windowSegs, preserve);
      try {
        for (let i = 0; i < units.length; i += BATCH) {
          if (!YT.active) break; // 翻到一半使用者還原，立刻停止
          const batchUnits = units.slice(i, i + BATCH);
          const res = await chrome.runtime.sendMessage({
            type: 'TRANSLATE_SUBTITLE_BATCH',
            payload: { texts: batchUnits.map(u => u.text), glossary: null },
          });
          if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
          for (let j = 0; j < batchUnits.length; j++) {
            const unit  = batchUnits[j];
            const rawTrans = res.result[j] || unit.text;
            if (unit.keys.length === 1) {
              // 單行：直接存入（preserve=false 或單行 event 都走這裡）
              YT.captionMap.set(unit.keys[0], rawTrans);
            } else {
              // 多行群組：合併為單行顯示
              // 第一個 segment 顯示完整合併譯文，其餘設為空字串（DOM element 變空白後視覺消失）
              // 雙重替換：真實換行符 + LLM 可能誤輸出的 literal \n 字串
              const merged = rawTrans.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim();
              YT.captionMap.set(unit.keys[0], merged);
              for (let k = 1; k < unit.keys.length; k++) YT.captionMap.set(unit.keys[k], '');
            }
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
    // lookaheadMs 以 play-time 為單位；API 翻譯延遲是 real-time 固定值。
    // 速度愈快，real-time 愈少：需把 lookahead 乘以 playbackRate，
    // 確保在任何速度下都保留 lookaheadS 的 real-time 給翻譯完成。
    // 例：lookaheadS=10、speed=2x → lookaheadMs=20000ms play-time = 10s real-time
    const lookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);

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

  // ─── video.ratechange 驅動（切換播放速度時重新檢查是否需要立刻翻譯）──
  // 切速後 lookaheadMs 改變（乘以新 playbackRate），當前位置可能已進入新的
  // 預警範圍但 timeupdate 還沒觸發；直接在 ratechange 時做一次檢查。

  function onVideoRateChange() {
    const YT = SK.YT;
    if (!YT.active || YT.translating || YT.rawSegments.length === 0) return;
    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    const lookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);
    const currentMs   = video.currentTime * 1000;
    const maxMs       = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`ratechange(${video.playbackRate}x) 觸發下一批`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  // ─── video.seeked 驅動（向前跳轉時直接翻當前視窗）──────────
  // timeupdate 只能順序推進翻譯視窗；使用者向前拖進度條後，
  // 若新位置已超出 translatedUpToMs，captionMap 缺對應條目，全走 on-the-fly。
  // 修法：偵測 seeked，若新位置超出 translatedUpToMs，
  // 直接跳到新位置所在的視窗邊界翻譯，不從舊位置逐批追趕。

  function onVideoSeeked() {
    const YT = SK.YT;
    if (!YT.active || YT.rawSegments.length === 0) return;
    const video = YT.videoEl;
    if (!video) return;

    const currentMs = video.currentTime * 1000;
    if (currentMs < YT.translatedUpToMs) return; // 向後跳或仍在已翻範圍內，不需處理

    const config = YT.config || DEFAULT_YT_CONFIG;
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const newWindowStart = Math.floor(currentMs / windowSizeMs) * windowSizeMs;

    // 重設翻譯起點到當前視窗，若非翻譯中則立刻觸發
    YT.translatedUpToMs = newWindowStart;
    _debugUpdate(`seeked → 重設翻譯起點 ${Math.round(newWindowStart/1000)}s`);
    if (!YT.translating) translateWindowFrom(newWindowStart);
    // 若 translating 中：當前批次結束後 timeupdate 會以新的 translatedUpToMs 繼續
  }

  function attachVideoListener() {
    const YT = SK.YT;
    const video = document.querySelector('video');
    if (!video || YT.videoEl === video) return;
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',     onVideoSeeked);
      YT.videoEl.removeEventListener('ratechange', onVideoRateChange);
    }
    YT.videoEl = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
    video.addEventListener('seeked',     onVideoSeeked);
    video.addEventListener('ratechange', onVideoRateChange);
  }

  // ─── 強制重載字幕（CC toggle）────────────────────────────────
  // rawSegments=0 時，CC 字幕資料可能已存在 YouTube 播放器記憶體中，
  // 不會重新發出 /api/timedtext XHR。
  // 解法：把 CC 按鈕關掉再打開，強迫播放器重新抓一次字幕，讓 monkey-patch 有機會攔截。

  async function forceSubtitleReload() {
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) {
      SK.sendLog('warn', 'youtube', 'forceSubtitleReload: CC button not found');
      return;
    }
    const isOn = btn.getAttribute('aria-pressed') === 'true';
    if (!isOn) {
      SK.sendLog('info', 'youtube', 'forceSubtitleReload: CC is off, skip toggle');
      return; // CC 未開，不強制操作
    }
    SK.sendLog('info', 'youtube', 'forceSubtitleReload: toggling CC to force new XHR');
    btn.click(); // 關閉 CC → 播放器清空字幕狀態
    await new Promise(r => setTimeout(r, 200));
    if (SK.YT.active) btn.click(); // 重新開啟 CC → 播放器重新抓字幕，觸發 /api/timedtext XHR
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

    // 若字幕翻譯已啟動但尚未取得字幕（autoTranslate 或 forceSubtitleReload 在 XHR 之前跑完）
    // 不論 captionMap 有沒有 on-the-fly 資料，一律翻譯當前視窗
    // （on-the-fly 條目會被覆蓋，無害；不翻的話當前視窗仍會靠 on-the-fly，預翻目的落空）
    if (YT.active && !YT.translating) {
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const config = await getYtConfig();
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      // attachVideoListener 已在 translateYouTubeSubtitles 啟動時提前呼叫；
      // 若從 autoTranslate 路徑啟動（translateYouTubeSubtitles 不一定有呼叫），
      // 在此補掛確保 seeked/ratechange 一定有監聽器
      attachVideoListener();
      SK.showToast('loading', '翻譯字幕⋯', { startTimer: true });
      await translateWindowFrom(windowStartMs);
      SK.showToast('success', `字幕翻譯進行中（${YT.captionMap.size} 條已備妥）`);
      setTimeout(() => SK.hideToast(), 3000);
    }
  });

  // ─── MutationObserver：即時替換字幕 ──────────────────────

  // 判斷字串是否已含中日韓字元（表示已翻譯完成）
  // 用途：el.textContent 賦值會觸發 characterData mutation，若不跳過中文譯文會形成迴圈
  const RE_CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;


  // ─── 字幕行展開（防止長譯文折行 + 維持置中）──────────────────────
  // 注入中文譯文後無條件展開字幕框：
  //   方法 A：segment 設 nowrap，確保文字不在 segment 內折行
  //   方法 B：向上走遍所有 block 容器，全部設 width: max-content
  //   方法 C：到達 caption-window 時修正置中定位——
  //     YouTube 原本用「left: 50% + margin-left: -固定寬/2」置中，
  //     寬度改為 max-content 後 margin-left 算法失效導致偏右；
  //     改為清除 margin-left，改用 transform: translateX(-50%) 置中，
  //     讓容器永遠以自身寬度的一半為中心點對齊 left: 50%。

  function expandCaptionLine(el) {
    // 方法 A：segment 自身設 nowrap，覆蓋 YouTube 預設的 pre-wrap
    el.style.whiteSpace = 'nowrap';
    // 方法 B + C：向上走所有 block 容器
    let node = el.parentElement;
    while (node && !node.classList.contains('ytp-caption-window-container')) {
      const display = getComputedStyle(node).display;
      if (display !== 'inline' && display !== 'inline-block') {
        node.style.maxWidth = 'none';
        node.style.width = 'max-content';
        if (node.classList.contains('caption-window')) {
          // YouTube 的 margin-left 是 -固定寬/2，寬度改後不再準確；
          // 改用 transform 置中，自動適應任意寬度
          node.style.marginLeft = '0';
          node.style.transform = 'translateX(-50%)';
          break; // caption-window 是最外需修改的層，到此為止
        }
      }
      node = node.parentElement;
    }
  }

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
      if (el.textContent !== cached) {
        el.textContent = cached;
        // 同步展開字幕框（不用 rAF——新版 expandCaptionLine 純設 style，不需量測 layout；
        // 若用 rAF，瀏覽器會先 paint 出「中文 + 舊 315px 容器」再展開，造成一幀閃爍）
        if (cached) expandCaptionLine(el);
      }
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

    // 立刻掛上 seeked / ratechange / timeupdate listener，不等第一批翻完：
    // 若等翻完後才掛，使用者在第一批回來前拖進度條，seeked 沒有監聽器，fix 無效。
    attachVideoListener();

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
      // attachVideoListener() 已在上方提前呼叫，此處不重複

      SK.showToast('success', `字幕翻譯進行中（${YT.captionMap.size} 條已備妥）`);
      setTimeout(() => SK.hideToast(), 3000);

    } else {
      // 尚未攔截到字幕：可能是 autoTranslate 在 XHR 之前跑完，也可能是 CC 未開
      // → 先顯示「等待中」，5 秒後若 rawSegments 還是 0 才提示使用者開 CC
      startCaptionObserver();
      SK.showToast('loading', '字幕翻譯已啟動，等待字幕資料⋯');

      // 1 秒後若仍無 XHR → 主動 toggle CC 讓播放器重新抓字幕
      setTimeout(() => {
        if (SK.YT.active && SK.YT.rawSegments.length === 0) {
          forceSubtitleReload();
        }
      }, 1000);

      // 5 秒後若仍無資料 → 判斷是否 CC 根本沒開
      setTimeout(() => {
        if (SK.YT.active && SK.YT.rawSegments.length === 0) {
          if (SK.YT.captionMap.size > 0) {
            // on-the-fly 在運作（XHR toggle 可能還在途中）→ 顯示進度，不誤報 CC 未開
            SK.showToast('success', `字幕翻譯進行中（${SK.YT.captionMap.size} 條已備妥）`);
            setTimeout(() => SK.hideToast(), 3000);
          } else {
            // captionMap 也是空的 → CC 可能真的沒開
            SK.showToast('success', '字幕翻譯已開啟。請開啟 YouTube 字幕（CC），翻譯將自動開始。');
          }
        }
        // 若 rawSegments 已有資料，XHR handler 已接手（不覆蓋）
      }, 5000);
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
