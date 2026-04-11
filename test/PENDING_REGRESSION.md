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

### v1.1.2+v1.1.4 — 2026-04-11 — 白名單自動翻譯（首次載入不生效 + autoTranslate 邏輯錯誤）
- **症狀**：
    1. v1.1.2 前：白名單網域首次載入不自動翻譯（只有 SPA 導航時才觸發）
    2. v1.1.2 修完後：打勾「白名單自動翻譯」導致所有網站都自動翻譯（`autoTranslate` 被當全域開關）
    3. v1.1.4 修正：`autoTranslate` 改為白名單功能的總開關——開啟 + 網域命中才翻譯
- **修在**：shinkansen/content.js — `isDomainWhitelisted()` helper + 首次載入 + `handleSpaNavigation()` 白名單檢查
- **為什麼還不能寫測試**：
    `isDomainWhitelisted()` 是 IIFE 內部函式，無法從外部 import。
    Jest 單元測試需要模擬 content script 初始化流程 + mock `chrome.storage.sync.get`，
    目前沒有現成 test harness 支援。可抽為獨立 pure function 後再補測試。
- **建議 spec 位置**：test/jest-unit/whitelist-auto-translate.test.cjs
- **建議測試策略**：
    1. 把 `isDomainWhitelisted(hostname, whitelist)` 抽成可 import 的 pure function
    2. 測試精確比對：`medium.com` 命中 `medium.com`
    3. 測試萬用字元：`blog.example.com` 命中 `*.example.com`
    4. 測試不命中：`evil.com` 不命中 `medium.com`
    5. 測試 `autoTranslate: false` 時即使白名單命中也不翻譯

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
