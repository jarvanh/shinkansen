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

### v1.0.7 — 2026-04-10 — Google Docs 偵測導向 mobilebasic
- **症狀**：在 Google Docs 編輯頁面按翻譯，應開新分頁到 `/mobilebasic` 並自動翻譯
- **來源 URL**：`https://docs.google.com/document/d/*/edit`（任何 Google Docs 文件）
- **修在**：`shinkansen/content.js` 的 `isGoogleDocsEditorPage()` + `translatePage()` 開頭的偵測區塊；`shinkansen/background.js` 的 `OPEN_GDOC_MOBILE` handler
- **為什麼還不能寫測試**：
    此功能依賴 `chrome.tabs.create()` 開新分頁 + 監聽 `tabs.onUpdated`，
    是跨分頁的整合流程，不是單一頁面內的段落偵測/注入問題。
    需要 Playwright 層級的 E2E 測試（用 `browser.newPage()` 模擬新分頁），
    目前 regression suite 的 fixture 機制只測單頁注入，不覆蓋跨分頁場景。
    此外 mobilebasic 頁面需要 Google 帳號登入才能存取私人文件，
    CI 環境下無法重現。
- **建議 spec 位置**：`test/e2e/gdoc-redirect.spec.js`（未來建立 e2e 資料夾時）
- **建議測試方向**：
    1. 單元測試：mock `location` 測 `isGoogleDocsEditorPage()` 和 `getGoogleDocsMobileBasicUrl()` 的 URL 解析邏輯
    2. E2E 測試：用公開的 Google Docs 文件 URL 驗證導向行為

### v1.0.11 — 2026-04-10 — SPA 導航後 Option+S 誤判為「已還原原文」
- **症狀**：在 Medium 翻譯完成後，點擊文章內的站內連結跳到新頁面，按 Option+S 會顯示「已還原原文」而不是翻譯新頁面。`STATE.translated` 沒有被重置。
- **來源 URL**：`https://emmanuel6.medium.com/famous-photo-gallery-yellowkorner-now-sells-horrendous-ai-images-instead-of-real-art-photos-075f4321b502`（任何 Medium 文章，點擊文中連結跳到另一篇）
- **修在**：`shinkansen/content.js` 的 SPA 導航偵測區段——新增 500ms URL 輪詢 safety net
- **根因**：React Router 在 module 初始化時快取 `history.pushState` 原始參照，content script 的 monkey-patch（`document_idle` 才跑）攔不到框架呼叫的 pushState
- **為什麼還不能寫測試**：
    觸發條件是「SPA 框架在 content script patch 之前快取 pushState」，
    需要在 fixture 頁面的 main world 預先執行 JS 模擬此行為，
    但 Playwright 的 content script 注入時機與真實 Chrome 不同，
    不容易重現 patch 競態。URL 輪詢本身的邏輯（字串比對 + handleSpaNavigation 呼叫）
    太簡單，單獨測意義不大。
- **建議 spec 位置**：`test/regression/spa-url-poll.spec.js`
- **建議測試方向**：
    1. 在 fixture 頁面用 `<script>` 在 main world 快取 pushState，然後呼叫快取的版本導航
    2. 驗證 500ms 後 collectParagraphs 拿到的是新頁面的內容而非舊頁面殘留

### v1.0.13+v1.0.14 — 2026-04-10 — 無限捲動網站翻譯消失（雙層修復）
- **症狀**：在 Engadget 翻譯完成後，使用者往下捲動，已翻譯的中文內容會消失變回英文。捲回頂部後原本翻好的段落也恢復成英文。
- **來源 URL**：`https://www.engadget.com/computing/laptops/asus-zenbook-a16-review-a-surprisingly-light-and-powerful-16-inch-ultraportable-140000914.html`（任何 Engadget 文章，往下捲到出現其他文章的區域）
- **修在**：`shinkansen/content.js`
- **根因（雙層）**：
    1. v1.0.13 修的層：Engadget 在捲動時用 `history.replaceState` 更新網址列，SPA URL 輪詢誤判為頁面導航呼叫 `resetForSpaNavigation()` 清空狀態
    2. v1.0.14 修的層：即使 SPA 狀態不被重設，Engadget 的框架仍會在捲動時用 innerHTML 把已翻譯節點的內容覆蓋回英文（元素本身不移除，`data-shinkansen-translated` 屬性留存），MutationObserver 的 addedNodes/removedNodes 偵測看不出問題
- **v1.0.14 修法**：新增 `STATE.translatedHTML` Map 快取譯文，spaObserver mutation 回調偵測到已翻譯節點內的 childList 變動時排程 `runContentGuard()` 重新套用
- **為什麼還不能寫測試**：
    觸發條件需要：(1) 框架在捲動時覆寫 innerHTML，程式性 `scrollTo` 無法觸發
    Engadget 的 IntersectionObserver 回調、(2) replaceState URL 變化也只在真實捲動時發生。
    Playwright fixture 可以模擬「覆寫 innerHTML」行為，但無法模擬「捲動觸發覆寫」的完整流程。
    內容守衛的核心邏輯（偵測 innerHTML 被改 → 重新套用）可以在 fixture 中測試。
- **建議 spec 位置**：`test/regression/guard-content-overwrite.spec.js`
- **建議測試方向**：
    1. 在 fixture 頁面翻譯一段文字（mock 翻譯結果注入）
    2. 用 JS 模擬框架覆寫：`el.innerHTML = originalEnglishHTML`
    3. 等待 500ms（content guard 排程延遲）
    4. 驗證元素內容已恢復成中文譯文

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

### v1.0.20 — 2026-04-10 — Content Guard 架構簡化 + Facebook 虛擬捲動修復
- **症狀**：Facebook 社團翻譯後上下捲動，已翻譯的貼文回復成英文不被修復（v1.0.14–v1.0.19 逐層疊加的 mutation 觸發 guard + cooldown 機制過於複雜且有時間缺口）
- **來源 URL**：`https://www.facebook.com/groups/360308324312508`（任何 Facebook 社團或動態消息）
- **修在**：`shinkansen/content.js` — 刪除 mutation 觸發路徑 A + cooldown 機制，改為每秒週期性掃描 + 斷開元素不刪除快取
- **根因（雙層）**：
    1. mutation 觸發的 guard 自身就是迴圈根源（guard 寫 DOM → mutation → 觸發 guard + rescan → 迴圈），cooldown 是壓制迴圈的 workaround，但造成覆寫時間缺口
    2. `runContentGuard()` 在元素暫時斷開 DOM 時立刻刪除快取，Facebook 重新接回元素時無法還原
- **為什麼還不能寫測試**：
    可以模擬「翻譯後延遲覆寫 innerHTML」測試週期性掃描是否自動修復，
    但需等待 1–2 秒讓 interval 生效，測試執行時間較長。
- **建議 spec 位置**：`test/regression/guard-periodic-sweep.spec.js`
- **建議測試方向**：
    1. 在 fixture 頁面翻譯一段文字（mock 翻譯結果注入）
    2. 等翻譯完成後用 JS 覆寫 innerHTML 回原文
    3. 等待 1.5 秒，驗證週期性掃描已自動修復內容回中文
    4. 模擬元素暫時 `el.remove()` 再 `parent.appendChild(el)` 並覆寫 innerHTML，驗證快取未被刪除、重新接回後仍可還原

### v1.0.23 — 2026-04-10 — SPA 續翻模式（Gmail 點進/退出 email 自動翻譯）
- **症狀**：在 Gmail inbox 翻譯完成後，點進一封 email 不會自動翻譯信件內容；退出 email 回到 inbox 時，原本翻好的主旨/預覽恢復成英文
- **來源 URL**：`https://mail.google.com/mail/u/0/#inbox`（Gmail 收件匣，點進任一封 email）
- **修在**：`shinkansen/content.js`（新增 `STATE.stickyTranslate`、`handleSpaNavigation()` 優先檢查 stickyTranslate、URL 輪詢 scroll check 在 stickyTranslate 時不跳過、新增 `hashchange` 事件監聽）
- **根因**：Gmail 使用 hash-based 路由（`#inbox` → `#inbox/FMfcg...`），不走 `pushState`，monkey-patch 和 `popstate` 攔不到。URL 輪詢能偵測到 hash 變化，但 v1.0.13 的捲動跳過邏輯在已翻譯狀態下會跳過所有 URL 變化，導致 Gmail 導航不觸發 `handleSpaNavigation()`。即使觸發，也只在白名單內才自動翻譯
- **為什麼還不能寫測試**：
    續翻模式涉及 SPA 導航→重設狀態→自動翻譯的完整流程，
    需要模擬 hash change 事件（`window.dispatchEvent(new HashChangeEvent(...))`）
    + 翻譯完成（mock API）+ 再次 hash change + 驗證第二次翻譯觸發。
    Playwright fixture 可以模擬 hashchange，但 `translatePage()` 依賴
    `chrome.storage.sync` 和 `chrome.runtime.sendMessage`，需要完整 mock 環境。
- **建議 spec 位置**：`test/regression/spa-sticky-translate.spec.js`
- **建議測試方向**：
    1. 在 fixture 頁面 mock translatePage 為 no-op counter
    2. 手動設 `STATE.stickyTranslate = true` + `STATE.translated = true`
    3. `window.dispatchEvent(new HashChangeEvent('hashchange', { newURL: '...#page2' }))`
    4. 驗證 translatePage counter 增加（自動續翻觸發）
    5. 呼叫 restorePage，再做 hashchange，驗證 counter 不增加（續翻已關閉）

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
