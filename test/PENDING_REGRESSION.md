# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Cowork 端** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步)
>   - **Claude Code 端** 跑完 `npm test` 全綠後若本檔非空,必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

### ~~v1.0.7~~ — 已補 URL 解析測試 → `test/regression/pure-gdoc-url.spec.js`
（注：跨分頁導向流程 `chrome.tabs.create()` + `tabs.onUpdated` 未涵蓋，需未來 E2E 測試）

### ~~v1.0.11~~ — 已補 Jest 單元測試 → `test/jest-unit/spa-url-polling.test.cjs`
（注：3 條測試涵蓋基本偵測、捲動跳過、sticky 覆蓋。Playwright E2E 的 pushState 競態重現未涵蓋）

### ~~v1.0.13+v1.0.14~~ — 已補 Content Guard 核心邏輯測試 → `test/regression/guard-content-overwrite.spec.js`
（注：「捲動觸發覆寫」的完整 Engadget IntersectionObserver 流程未涵蓋，但 guard 的核心邏輯——快取比對 + innerHTML 修復——已鎖死）

### ~~v1.0.18→v1.0.19~~ — 已關閉，不需要測試
v1.0.20 將 Content Guard 從「MutationObserver 觸發」重構為「setInterval 每秒週期性掃描」，
迴圈在架構層面不可能發生（guard 不再由 mutation 觸發，兩者徹底脫鉤）。
要讓此 bug 回歸，必須把 guard 改回 mutation-triggered 架構——這是重大設計變更，不是手滑就會發生。
且「驗證某件事沒有無限發生」天生是弱斷言，寫出來的測試保護力有限。

### ~~v1.0.16~~ — 已補測試 → `test/regression/detect-nav-anchor-threshold.spec.js`

### ~~v1.0.20~~ — guard 核心邏輯已由 `guard-content-overwrite.spec.js` 涵蓋
（注：Facebook 虛擬捲動的「元素暫時斷開 DOM 再接回」場景未涵蓋——需要模擬 `el.remove()` + `parent.appendChild(el)` + 覆寫 innerHTML，驗證快取未被刪除。可在未來擴充 guard-content-overwrite.spec.js 加第二個 test case）

### ~~v1.0.23~~ — 已補 Jest 單元測試 → `test/jest-unit/spa-sticky-translate.test.cjs`
（注：3 條測試涵蓋 hashchange+sticky 觸發 translatePage、非 sticky 不觸發、restorePage 關閉 sticky。使用 jsdom + chrome API mock，不動 production code）

### ~~v1.0.21+v1.0.22~~ — 已補偵測測試 → `test/regression/detect-grid-cell-leaf.spec.js`
（注：排版修正部分——CSS `br { display: none }` + flex 單行——需要真實 CSS 環境，未涵蓋在此測試中）

### ~~v1.1.2+v1.1.4~~ — 已補 Jest 單元測試 → `test/jest-unit/whitelist-auto-translate.test.cjs`
（注：6 條測試涵蓋精確比對、萬用字元、根域名命中、不命中、autoTranslate OFF、白名單為空。
未抽 pure function，改用 create-env 模式直接 eval content.js + mock chrome.storage 來測試
isDomainWhitelisted + 首次載入自動翻譯的整合行為）

### ~~v1.1.6~~ — 已補 Jest 單元測試 → `test/jest-unit/trad-chinese-article-sampling.test.cjs`
（注：3 條測試涵蓋：有 `<article>` 時 sidebar 簡體字不影響偵測、無 `<article>` fallback
到 body 時簡體字污染導致偵測失敗、`<main>` fallback 路徑。使用 create-env 模式
eval content.js + mock storage + Debug Bridge TRANSLATE 觸發 translatePage）

### v1.2.7 — 2026-04-16 — YouTube 字幕即時翻譯（on-the-fly）尚無自動化測試
- **症狀**：新功能，v1.2.5/v1.2.6 的預下載方案因 YouTube `/api/timedtext` 封鎖 JS fetch 而改為 MutationObserver 即時翻譯；尚無 regression spec 涵蓋
- **來源 URL**：任意有字幕的 YouTube 影片（例如 https://www.youtube.com/watch?v=dQw4w9WgXcQ）
- **修在**：`shinkansen/content-youtube.js`（大幅改寫），`shinkansen/background.js`（移除 GET_YT_PLAYER_DATA）
- **為什麼還不能寫 Playwright 測試**：
    新架構的核心是 MutationObserver 監聽 `.ytp-caption-segment` → 觸發 `TRANSLATE_BATCH` → 回填 DOM，涉及 service worker mock + 時序等待。最小 fixture 可以手動插入 `.ytp-caption-segment` 並觀察替換，但需要先補 `TRANSLATE_BATCH` mock 機制（目前 regression suite 僅 mock fetch，不支援 chrome.runtime.sendMessage mock）。
- **建議 spec 位置**：`test/regression/youtube-subtitle-onthefly.spec.js`
- **建議 fixture 結構**（已知觸發條件）：
    ```html
    <div class="ytp-caption-window-container">
      <!-- 空，由測試動態插入 -->
    </div>
    ```
    測試斷言：mock `TRANSLATE_BATCH`，動態插入 `.ytp-caption-segment[textContent="Hello world"]`，等待 800ms，textContent 應變為中文譯文；第二次插入相同文字應瞬間替換（快取命中）

### ~~v1.2.5~~ — 2026-04-15 — YouTube 字幕翻譯 MVP 尚無自動化測試
- **症狀**：新功能，尚無 regression spec 涵蓋
- **來源 URL**：任意有英文字幕的 YouTube 影片（例如 https://www.youtube.com/watch?v=dQw4w9WgXcQ）
- **修在**：`shinkansen/content-youtube.js`（新增）、`shinkansen/content.js`（translatePage 加 YouTube 分流）
- **為什麼還不能寫 Playwright 測試**：
    YouTube 的 `ytInitialPlayerResponse` 是由 YouTube JS 寫入的 main world 全域變數，在 Playwright fixture 中需要模擬此物件並搭配字幕 API 的 mock fetch 才能重現完整流程。此外，字幕翻譯透過 `TRANSLATE_BATCH` 訊息走背景 service worker，需要在測試環境中 mock Gemini API 回應。時序控制（等待翻譯完成 → 觸發字幕播放 → 確認 MutationObserver 置換）複雜，目前 regression 框架未支援跨 main world + isolated world 的 CustomEvent 橋接測試。
- **建議 spec 位置**：`test/regression/youtube-subtitle-translate.spec.js`
- **建議 fixture 結構**（已知觸發條件）：
    ```html
    <script>
      window.ytInitialPlayerResponse = {
        videoDetails: { videoId: 'test123' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{
              languageCode: 'en',
              baseUrl: '/mock-captions.json',
              name: { simpleText: 'English' }
            }]
          }
        }
      };
    </script>
    <div class="ytp-caption-window-container">
      <span class="ytp-caption-segment">Hello, world!</span>
    </div>
    ```
    測試斷言：mock `TRANSLATE_BATCH` 回傳 `['你好，世界！']`，啟動翻譯後 `.ytp-caption-segment` 的 textContent 應變為「你好，世界！」

### v1.2.1 — 2026-04-15 — 動態 widget 網站 SPA observer 無限 rescan
- **症狀**：Stratechery 頁面翻譯完成後，toast「已翻譯 4 段新內容」每秒持續彈出，log 顯示 `SPA observer rescan #N` 無限遞增（N 超過 100+）
- **來源 URL**：https://stratechery.com/2026/amazon-buys-globalstar-delta-to-add-leo-the-apple-angle/
- **修在**：`shinkansen/content-spa.js` 的 `spaObserverRescan()`，新增 `spaObserverSeenTexts` Set 過濾已翻文字
- **為什麼還不能寫 Playwright 測試**：
    觸發條件是「頁面 JS 每秒重設特定 DOM 元素（推薦 widget / Podcast 卡片）」，需要在 fixture 中模擬一個 `setInterval` 每秒 reset 某元素的 innerHTML，而這個 reset 要發生在 content script 注入完成後、MutationObserver 還活著的時間點。時序控制複雜，且需要 Playwright CDP 橋接 isolated world 的 content script 狀態，目前 regression 測試框架尚未支援此類時序感知測試。
- **建議 spec 位置**：`test/regression/spa-observer-widget-loop.spec.js`
- **建議 fixture 結構**（已知觸發條件）：
    ```html
    <article>
      <p>This is the main content to translate.</p>
    </article>
    <div id="widget">
      <p>Widget title A</p>
    </div>
    <script>
      // 每秒重設 widget 內容（模擬 Stratechery 推薦 widget）
      setInterval(() => {
        document.getElementById('widget').innerHTML = '<p>Widget title A</p>';
      }, 1000);
    </script>
    ```
    測試斷言：翻譯後等待 5 秒，`spaObserverRescanCount` 應 ≤ 2（首次 rescan 翻譯 widget，後續全部 skip），toast 不應多次出現同樣文字

<!--
條目格式範例(實際加入時把上面那行 placeholder 刪掉):

### v0.60 — 2026-04-12 — 簡短描述 bug
- **症狀**:Jimmy 觀察到的現象 (例如「Substack 卡片標題被吃掉變空字串」)
- **來源 URL**:https://example.com/some-page (若為公開頁面)
- **修在**:shinkansen/content.js 的 XX 函式 / commit hash
- **為什麼還不能寫測試**:
    例:還沒抽出最小重現結構;原頁面太複雜、含三層 wrapper + 動態載入,
    需要再觀察是哪個 attribute 是真正觸發條件
- **建議 spec 位置**:test/regression/inject-substack-title.spec.js
- **建議 fixture 結構**(若已知):
    ```html
    <article>
      <h2 class="...">
        <span>...</span>
      </h2>
    </article>
    ```
-->
