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

### v1.0.18→v1.0.19 — 2026-04-10 — Content Guard 與 rescan 互相觸發迴圈 + 冷卻過度封鎖新內容
- **症狀**：在 Twitter 翻譯後捲動頁面，Toast 在「已恢復N段被覆寫的翻譯」和「已翻譯N段新內容」之間無限跳動，即使停止捲動也不停止
- **來源 URL**：`https://x.com/`（Twitter/X 首頁或任何推文時間線）
- **修在**：`shinkansen/content.js` — v1.0.18 新增全域冷卻 `mutationSuppressedUntil`，v1.0.19 重構為精準的 `guardSuppressedUntil`（只抑制覆寫偵測）+ translated-ancestor 過濾（排除新內容偵測中的自身寫入副作用）
- **根因**：Content Guard 用 `el.innerHTML = savedHTML` 還原譯文時產生 `childList` mutations，觸發 observer 排程新的 Content Guard 和 rescan；rescan 翻譯注入後又觸發 Content Guard，形成迴圈。Twitter 的 React virtual DOM reconciliation 會持續覆寫 Content Guard 的還原，使迴圈不會自然終止。v1.0.18 的全域冷卻修好了 Twitter 但導致 Facebook 等持續載入新內容的 SPA 在冷卻期間無法偵測新貼文
- **為什麼還不能寫測試**：
    觸發條件需要 React 的 virtual DOM reconciliation 機制——框架偵測到 DOM 被外部修改後
    立刻重新渲染覆蓋回去。Playwright fixture 中的靜態 HTML 沒有 React 運行，
    無法模擬「Content Guard 還原 → React 立刻覆寫 → observer 再觸發」的完整迴圈。
    冷卻機制本身的邏輯（時間戳比較）太簡單，獨立測試意義不大。
- **建議 spec 位置**：`test/regression/guard-loop-suppression.spec.js`
- **建議測試方向**：
    1. 在 fixture 頁面翻譯一段文字後，用 setInterval 模擬框架每 300ms 覆寫 innerHTML
    2. 觀察 Content Guard 是否在 2 秒冷卻期後才再次觸發，而非每 500ms 都觸發
    3. 驗證不會產生無限 toast 跳動

### ~~v1.0.16~~ — 已補測試 → `test/regression/detect-nav-anchor-threshold.spec.js`

### ~~v1.0.20~~ — guard 核心邏輯已由 `guard-content-overwrite.spec.js` 涵蓋
（注：Facebook 虛擬捲動的「元素暫時斷開 DOM 再接回」場景未涵蓋——需要模擬 `el.remove()` + `parent.appendChild(el)` + 覆寫 innerHTML，驗證快取未被刪除。可在未來擴充 guard-content-overwrite.spec.js 加第二個 test case）

### ~~v1.0.23~~ — 已補 Jest 單元測試 → `test/jest-unit/spa-sticky-translate.test.cjs`
（注：3 條測試涵蓋 hashchange+sticky 觸發 translatePage、非 sticky 不觸發、restorePage 關閉 sticky。使用 jsdom + chrome API mock，不動 production code）

### ~~v1.0.21+v1.0.22~~ — 已補偵測測試 → `test/regression/detect-grid-cell-leaf.spec.js`
（注：排版修正部分——CSS `br { display: none }` + flex 單行——需要真實 CSS 環境，未涵蓋在此測試中）

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
