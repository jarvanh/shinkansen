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

  // ─── DRIVE_ASR_CAPTIONS listener ─────────────────────
  // commit 3 起改用 SK.ASR.{parseJson3, mergeAsr}(在 content-youtube.js 內 export),
  // 跟 YouTube ASR 路徑共用同一份字幕格式與啟發式合句邏輯。
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'DRIVE_ASR_CAPTIONS') return;
    const { json3 } = message.payload || {};
    if (!json3) {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS payload missing json3');
      return;
    }
    if (!SK.ASR?.parseJson3 || !SK.ASR?.mergeAsr) {
      SK.sendLog('warn', 'drive', 'SK.ASR helpers not available (load order issue?)');
      return;
    }
    const rawSegments = SK.ASR.parseJson3(json3);
    SK.sendLog('info', 'drive', 'asr segments parsed', {
      count: rawSegments.length,
      firstStartMs: rawSegments[0]?.startMs,
      lastStartMs: rawSegments[rawSegments.length - 1]?.startMs,
    });
    const sentences = SK.ASR.mergeAsr(rawSegments);
    SK.sendLog('info', 'drive', 'asr sentences merged', {
      count: sentences.length,
      compressionRatio: rawSegments.length > 0
        ? (sentences.length / rawSegments.length).toFixed(2)
        : null,
      firstStartMs: sentences[0]?.startMs,
      lastEndMs: sentences[sentences.length - 1]?.endMs,
      sample: sentences.slice(0, 5).map(s => ({
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text.length > 100 ? s.text.slice(0, 100) + '…' : s.text,
      })),
    });
  });

  SK.sendLog('info', 'drive', 'content-drive.js top frame ready', {
    href: location.href.slice(0, 200),
  });

})(window.__SK);
