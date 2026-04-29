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

  // commit 4a:取前 SAMPLE_BATCH_SIZE 段送 LLM 驗整條 D' pipeline,後續 commit 4b
  // 接時間軸 + 視窗切批 + overlay 顯示。
  const SAMPLE_BATCH_SIZE = 30;

  async function _handleCaptionsMessage(message) {
    const { json3 } = message.payload || {};
    if (!json3) {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS payload missing json3');
      return;
    }
    if (!SK.ASR?.parseJson3 || !SK.ASR?.parseAsrResponse) {
      SK.sendLog('warn', 'drive', 'SK.ASR helpers not available (load order issue?)');
      return;
    }
    const rawSegments = SK.ASR.parseJson3(json3);
    SK.sendLog('info', 'drive', 'asr segments parsed', {
      count: rawSegments.length,
      firstStartMs: rawSegments[0]?.startMs,
      lastStartMs: rawSegments[rawSegments.length - 1]?.startMs,
    });

    const batch = rawSegments.slice(0, SAMPLE_BATCH_SIZE);
    if (batch.length === 0) return;

    // D' JSON 格式 [{s, e, t}]:s/e 毫秒時間戳、t 原文。LLM 自由合句後回相同格式
    // (entry 數可能少於 input,因為合多段成一句)。e 用下一段 startMs(子批內不重疊),
    // 最後一段 fallback +1500ms。
    const inputArr = batch.map((seg, i) => {
      const next = batch[i + 1];
      const endMs = next ? next.startMs : seg.startMs + 1500;
      return { s: seg.startMs, e: endMs, t: seg.text };
    });
    const inputJson = JSON.stringify(inputArr);

    SK.sendLog('info', 'drive', 'sending sample batch to LLM', {
      batchSize: batch.length,
      inputBytes: inputJson.length,
      firstS: inputArr[0]?.s,
      lastE: inputArr[inputArr.length - 1]?.e,
    });

    let res;
    try {
      res = await browser.runtime.sendMessage({
        type: 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH',
        payload: { texts: [inputJson], glossary: null },
      });
    } catch (e) {
      SK.sendLog('warn', 'drive', 'TRANSLATE_DRIVE_ASR_SUBTITLE_BATCH sendMessage failed', {
        error: e?.message || String(e),
      });
      return;
    }

    if (!res?.ok) {
      SK.sendLog('warn', 'drive', 'LLM batch failed', { error: res?.error || 'unknown' });
      return;
    }

    const rawText = res.result?.[0] || '';
    let entries;
    try {
      entries = SK.ASR.parseAsrResponse(rawText);
    } catch (e) {
      SK.sendLog('warn', 'drive', 'parseAsrResponse failed', {
        error: e?.message || String(e),
        rawHead: rawText.slice(0, 200),
      });
      return;
    }

    SK.sendLog('info', 'drive', 'asr translated', {
      entryCount: entries.length,
      inputCount: batch.length,
      compressionRatio: batch.length > 0
        ? (entries.length / batch.length).toFixed(2)
        : null,
      firstS: entries[0]?.s,
      lastE: entries[entries.length - 1]?.e,
      sample: entries.slice(0, 5).map(e => ({
        s: e.s,
        e: e.e,
        t: typeof e.t === 'string' && e.t.length > 100 ? e.t.slice(0, 100) + '…' : e.t,
      })),
      usage: res.usage,
    });
  }

  // ─── DRIVE_ASR_CAPTIONS listener ─────────────────────
  // listener 同步 return,async 邏輯走 fire-and-forget(避免被 Chrome 視為 sendResponse promise)
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'DRIVE_ASR_CAPTIONS') return;
    _handleCaptionsMessage(message).catch(err => {
      SK.sendLog('warn', 'drive', 'DRIVE_ASR_CAPTIONS handler exception', {
        error: err?.message || String(err),
      });
    });
  });

  SK.sendLog('info', 'drive', 'content-drive.js top frame ready', {
    href: location.href.slice(0, 200),
  });

})(window.__SK);
