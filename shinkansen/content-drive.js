// content-drive.js — Shinkansen Drive 影片 ASR 字幕翻譯(top frame 入口)
// commit 2/5 — 路徑 A(top frame 浮層)
//
// 執行環境:isolated world,run_at: document_idle,<all_urls> + all_frames: true。
// gate 只在 Drive viewer 的 top frame(drive.google.com/file/...)啟動實際邏輯;
// iframe 內的偵測由獨立的 content-drive-iframe.js 處理。
//
// 職責(commit 2):接收 background relay 的 DRIVE_ASR_CAPTIONS 訊息(原始 timedtext
// json3),解析成 raw segments,目前只 log dump 驗結構正確。
// 不做的事:合句、翻譯、overlay 容器、時間軸同步——留 commit 3+。

(function (SK) {
  if (!SK || SK.disabled) return;

  // 只在 Drive viewer top frame 啟動。
  // 其他頁面(YouTube / Wikipedia / Drive folder 列表 / Google Docs 等)load
  // 此 script 但 gate fail 直接 return,不掛 listener、無副作用。
  if (location.hostname !== 'drive.google.com') return;
  if (!location.pathname.startsWith('/file/')) return;
  if (window.top !== window) return;

  // ─── json3 解析 ──────────────────────────────────────
  // event 格式跟 YouTube ASR 完全一致:
  //   { tStartMs, dDurationMs, segs: [{ utf8, tOffsetMs, acAsrConf }] }
  // commit 2 fork 一份簡化版(只取 startMs / text);commit 3 抽 helper 跟
  // content-youtube.js 共用,並接合句邏輯。
  function parseJson3(json) {
    const segments = [];
    for (const ev of (json?.events || [])) {
      if (!ev.segs) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      if (!text) continue;
      segments.push({
        startMs: ev.tStartMs || 0,
        durationMs: ev.dDurationMs || 0,
        text,
      });
    }
    return segments;
  }

  // ─── DRIVE_ASR_CAPTIONS listener ─────────────────────
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'DRIVE_ASR_CAPTIONS') return;
    const { json3 } = message.payload || {};
    if (!json3) {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS payload missing json3');
      return;
    }
    const segments = parseJson3(json3);
    SK.sendLog('info', 'drive', 'asr segments parsed', {
      count: segments.length,
      firstStartMs: segments[0]?.startMs,
      lastStartMs: segments[segments.length - 1]?.startMs,
      sample: segments.slice(0, 5).map(s => ({
        startMs: s.startMs,
        durationMs: s.durationMs,
        text: s.text.length > 60 ? s.text.slice(0, 60) + '…' : s.text,
      })),
    });
  });

  SK.sendLog('info', 'drive', 'content-drive.js top frame ready', {
    href: location.href.slice(0, 200),
  });

})(window.__SK);
