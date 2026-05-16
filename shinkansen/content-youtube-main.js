// content-youtube-main.js — Shinkansen YouTube XHR 字幕攔截（MAIN world）
// v1.3.12（從 v1.3.8 恢復）
//
// 執行環境：MAIN world，run_at: document_start（manifest 獨立宣告）
// 職責：monkey-patch XMLHttpRequest 與 fetch，攔截 YouTube 播放器
//       自己發出的 /api/timedtext 請求，把字幕原文透過 CustomEvent
//       傳給 isolated world（content-youtube.js）。
//
// 為什麼這樣做：YouTube 的 /api/timedtext 對所有主動的 fetch() 呼叫
// 一律回傳空 body（包含 main world / isolated world / service worker），
// 即使是 same-origin 的請求也一樣（只要 URL 含 exp=xpv/xpe 就需要 POT）。
// 唯一能拿到資料的方式，是等 YouTube 播放器自己發出請求，再擷取 response。

(function () {
  const TIMEDTEXT_RE = /\/api\/timedtext/;
  const CAPTION_EVENT = 'shinkansen-yt-captions';

  // ─── XMLHttpRequest monkey-patch ──────────────────────────
  // YouTube 播放器用 XHR 抓字幕，攔截 open() 記錄 URL，
  // 在 readystatechange 等到完成時把 responseText 丟出去。

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args) {
    this.__shinkansenUrl =
      typeof args[1] === 'string' ? args[1] : (args[1]?.href || '');
    return _open.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__shinkansenUrl || '';
    if (TIMEDTEXT_RE.test(url)) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState === 4 && this.status === 200 && this.responseText) {
          window.dispatchEvent(new CustomEvent(CAPTION_EVENT, {
            detail: { url, responseText: this.responseText },
          }));
        }
      });
    }
    return _send.apply(this, args);
  };

  // ─── fetch monkey-patch ───────────────────────────────────
  // 部分情境 YouTube 可能改用 fetch；攔截並克隆 response 讀取內容。

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string'
      ? args[0]
      : (args[0]?.url || args[0]?.href || '');
    const response = await _fetch.apply(this, args);
    if (TIMEDTEXT_RE.test(url)) {
      try {
        response.clone().text().then(text => {
          if (text) {
            window.dispatchEvent(new CustomEvent(CAPTION_EVENT, {
              detail: { url, responseText: text },
            }));
          }
        }).catch(() => {});
      } catch (_) {}
    }
    return response;
  };

  // ─── ytInitialPlayerResponse bridge(v1.9.9)───────────────
  // isolated world(content-youtube.js)5s「沒字幕」啟發式之前先 query 本 bridge,
  // 拿 captionTracks 權威訊號決定是否真的沒字幕(不靠 timeout 猜)。
  // 只回傳 captionTracks 子集合避免 serialize 整個 playerResponse;additionally
  // 多回 activeTrack（從 #movie_player.getOption 抓），給 caption track 自動選擇邏輯
  // 判斷當前是不是 YT 自翻譯軌（activeTrack.translationLanguage 有值）。

  window.addEventListener('shinkansen-yt-query-player-response', () => {
    let captionTracks = null;
    let playerResponseAvailable = false;
    let videoId = null;
    let activeTrack = null;
    try {
      const resp = window.ytInitialPlayerResponse;
      playerResponseAvailable = !!resp;
      videoId = resp?.videoDetails?.videoId || null;
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks)) {
        captionTracks = tracks.map((t) => ({
          languageCode:   t?.languageCode || null,
          kind:           t?.kind || '',
          isTranslatable: !!t?.isTranslatable,
          vssId:          t?.vssId || null,
          name:           t?.name?.simpleText || t?.name?.runs?.[0]?.text || null,
        }));
      }
      // videoId 給 isolated world 跟 URL videoId 比對:SPA 導航後 ytInitialPlayerResponse
      // 不一定立即更新到新影片,videoId 對不上 = stale,isolated 端會 retry。
    } catch (_) {
      captionTracks = null;
    }
    try {
      const player = document.querySelector('#movie_player');
      if (player?.getOption) {
        const at = player.getOption('captions', 'track');
        if (at && typeof at === 'object') {
          activeTrack = {
            languageCode:            at.languageCode || null,
            kind:                    at.kind || '',
            translationLanguageCode: at.translationLanguage?.languageCode || null,
          };
        }
      }
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('shinkansen-yt-player-response', {
      detail: { captionTracks, playerResponseAvailable, videoId, activeTrack },
    }));
  });

  // ─── caption track switch bridge ─────────────────────────
  // isolated world 跑完 track chooser 後，若決定 'switch' 就丟此事件來
  // 呼叫 #movie_player.setOption('captions', 'track', {languageCode, kind})，
  // 切換掉 YT 自翻譯軌 / 切到指定 manual or ASR 軌。
  // 結果以 shinkansen-yt-set-caption-track-result 回送（ok / error）。

  window.addEventListener('shinkansen-yt-set-caption-track', (e) => {
    const { languageCode, kind } = e?.detail || {};
    let ok = false;
    let error = null;
    try {
      const player = document.querySelector('#movie_player');
      if (player?.setOption && languageCode) {
        player.setOption('captions', 'track', {
          languageCode,
          kind: kind || '',
        });
        ok = true;
      } else {
        error = 'no-player-or-langcode';
      }
    } catch (err) {
      error = err?.message || String(err);
    }
    window.dispatchEvent(new CustomEvent('shinkansen-yt-set-caption-track-result', {
      detail: { ok, error },
    }));
  });

})();
