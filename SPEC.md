# Shinkansen — 規格文件（SPEC）

> 一款專注於網頁翻譯的 Chrome Extension，作為 Immersive Translation 的輕量相容品。

- 文件版本：v1.0
- 建立日期：2026-04-08
- 最後更新：2026-04-11
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：1.1.0

---

## 0. 文件維護政策

**每次修改 Extension 的行為、UI、設定結構、或檔案組織，都必須同步更新本文件。**

- Extension 版本號規則：三段式格式（`1.0.0` → `1.0.1`）。v1.0.0 以前的歷史版本使用兩段式。
- Extension 版本號統一由 `manifest.json` 的 `version` 欄位控管；Popup 顯示版本透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。
- 本 SPEC 文件的版本號與 Extension 版本號獨立管理；SPEC 有結構性變動時 +0.1。

---

## 1. 專案目標

Shinkansen 是一款 Chrome 擴充功能，將英文（或其他外語）網頁翻譯成台灣繁體中文，協助使用者流暢閱讀外語內容。名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

授權：Elastic License 2.0 (ELv2)。允許查看、學習、修改與個人使用；禁止將本軟體（含改寫版本）作為託管或受管理的服務提供給第三方。完整條款見專案根目錄 `LICENSE`。

---

## 2. 功能範圍

### 2.1 已實作（v1.1.0 為止）

以下按版本階段摘要已實作功能。每條對應的詳細變更記錄在 git history 中。

**基礎翻譯（v0.13–v0.28）**：單語覆蓋顯示、手動翻譯（Popup 按鈕 + Option+S 快捷鍵）、自動翻譯白名單、Gemini REST API 串接、翻譯快取（SHA-1 key）、還原原文、佔位符保留行內元素（`⟦N⟧…⟦/N⟧` 配對型 + `⟦*N⟧` 原子型）、巢狀佔位符遞迴序列化/反序列化、腳註參照原子保留、CJK 空白清理、技術元素過濾、佔位符密度控制。

**段落偵測與注入重構（v0.29–v0.58）**：mixed-content fragment 單位、字元預算 + 段數上限雙門檻分批、`<br>` ↔ `\n` round-trip（sentinel 區分語意換行與排版空白）、三條注入路徑統一為 `resolveWriteTarget` + `injectIntoTarget`、slot 重複 graceful degradation（`selectBestSlotOccurrences`）、MJML/Mailjet email 模板 `font-size:0` 相容、媒體保留策略。

**並行翻譯與 Rate Limiter（v0.35 起）**：三維滑動視窗 Rate Limiter（RPM/TPM/RPD）、Priority Queue Dispatcher、並行 concurrency pool（`runWithConcurrency`）、429 指數退避 + `Retry-After` 尊重、tier 對照表（Free/Tier1/Tier2）、設定頁效能與配額區塊。

**全文術語表一致化（v0.69 起）**：翻譯長文前先呼叫 Gemini 擷取專有名詞對照表，注入所有翻譯批次的 systemInstruction。依文章長度三級策略（短文跳過、中檔 fire-and-forget、長文阻塞等待）。術語表快取（`gloss_` prefix）。設定頁術語表區塊。

**UI 與設定（v0.60–v0.99）**：設定頁全面重構（模型管理、計價連動、Service Tier、Thinking 開關、匯入匯出驗證）、Popup 面板（快取/費用統計、術語表開關）、Toast 成本顯示（implicit cache 折扣後實付值）、用量追蹤（IndexedDB + 圖表 + CSV 匯出）、Debug Bridge（main world ↔ isolated world CustomEvent 橋接）、Log 系統（記憶體 buffer 1000 筆 + 設定頁 Log 分頁）。

**穩定性與防護（v0.76–v0.88）**：自動語言偵測（跳過已是目標語言的頁面）、離線偵測、翻譯中止（AbortController）、超大頁面段落上限（MAX_TOTAL_UNITS）、SPA 支援（pushState/replaceState 偵測 + MutationObserver）、延遲 rescan。

**v1.0.x 系列**：每批段數/字元預算改為設定頁選項（v1.0.2）、編輯譯文模式（v1.0.3）、程式碼重構與效能最佳化（v1.0.4，ES module 化、handler map、debounce storage 寫入）、修正用量頁面無資料（v1.0.5）、修正 manifest description 與文件重構（v1.0.6，SPEC.md v1.0 重寫、README.md 重寫、測試流程說明更新）、Google Docs 翻譯支援（v1.0.7，偵測 Google Docs 編輯頁面自動導向 `/mobilebasic` 閱讀版，在標準 HTML 上執行翻譯並自動觸發）、`<pre>` 條件排除（v1.0.8，將 `<pre>` 從硬排除改為條件排除——僅含 `<code>` 子元素時視為程式碼區塊跳過，不含 `<code>` 的 `<pre>` 視為普通容器，修復 Medium 留言區等使用 `<pre>` 包裝非程式碼文字的網站無法翻譯的問題；同時豁免 `<pre>` 的 `isInteractiveWidgetContainer` 檢查——PRE 的 HTML 語意是文字容器，內部的 button 如 Medium「more」展開按鈕是次要控制項，不應讓整段被視為互動 widget 跳過；新增「leaf content DIV」補抓 pass——CSS-in-JS 框架以 `<div>` 取代 `<p>` 的純文字容器，若無 block 祖先、無 block 後代、無子元素（純文字 leaf）、文字 ≥ 20 字則納入翻譯，修復 New Yorker 文章副標等使用 styled DIV 的內容未被偵測的問題；限制純文字 leaf 是為了避免破壞有結構化 inline 子元素的 DIV 如圖說容器）、主要內容區域內 footer 放行（v1.0.9，`isContentFooter` 新增「footer 有 `<article>` 或 `<main>` 祖先」判斷——CSS-in-JS 網站如 New Yorker 把文章附屬資訊如刊登期數放在 `<main>` 內的 `<footer>` 元素中，這是「內容 footer」而非「站底 footer」，應納入翻譯；站底 footer 通常不在 main/article 內，維持排除不受影響）、排除 contenteditable/textbox 表單控制項（v1.0.10，`isInsideExcludedContainer` 新增 `contenteditable="true"` 與 `role="textbox"` 祖先排除——Medium 等網站的留言輸入框用 `<div contenteditable>` 而非 `<textarea>`，翻譯 placeholder 文字會破壞表單互動與排版）、SPA 導航 URL 輪詢 safety net（v1.0.11，部分 SPA 框架如 React Router 在 module 初始化時快取 `history.pushState` 原始參照，content script 的 monkey-patch 攔不到導航事件，導致翻譯完成後點擊站內連結 URL 已變但 `STATE.translated` 未重置，Option+S 變成「還原原文」而非翻譯新頁；新增每 500ms URL 輪詢偵測 `location.href` 變化，作為 history API 攔截的 safety net）、heading 豁免 widget 檢查（v1.0.12，`isInteractiveWidgetContainer` 新增 `WIDGET_CHECK_EXEMPT_TAGS` 常數，H1-H6 與 PRE 統一豁免——Substack 等平台在 heading 內嵌入 anchor link 圖示按鈕 `<button aria-label="Link">`，觸發 widget 偵測導致整個標題被跳過不翻譯；heading 的語意就是標題，內部 button 是輔助控制項不是 CTA）、修正無限捲動網站翻譯消失問題（v1.0.13，Engadget 等無限捲動網站在捲動時用 `history.replaceState` 更新網址列以反映目前可見的文章，SPA URL 輪詢將此誤判為頁面導航並呼叫 `resetForSpaNavigation()` 清空所有翻譯狀態，導致使用者捲動時已翻譯的中文內容消失；修法：`replaceState` handler 只靜默同步 `spaLastUrl` 而不觸發導航重設，URL 輪詢亦新增「已翻譯且 DOM 中仍有 `data-shinkansen-translated` 節點」判斷——命中時視為捲動型 URL 更新而非頁面切換；真正的 SPA 導航 `pushState` 在 500ms 輪詢偵測到時框架已完成 re-render，舊翻譯節點已被替換，不會命中此分支）、內容守衛機制防止框架覆寫譯文（v1.0.14，Engadget 等網站的框架在捲動時用 innerHTML 把已翻譯的中文覆蓋回原始英文，但不移除 DOM 元素本身——`data-shinkansen-translated` 屬性留存、MutationObserver 的 childList 偵測看不出異常。新增 `STATE.translatedHTML` Map 在翻譯注入時快取每個元素的譯文 HTML；spaObserver 的 mutation 回調新增「是否有 mutation 落在已翻譯節點內」偵測，命中時排程 `runContentGuard()`——掃描所有快取元素，若 innerHTML 與快取不符則立刻重新套用，不需 API 呼叫。覆寫偵測到套用的延遲為 500ms，遠快於原本 spaObserver rescan 的 3 秒去抖動）、移除 `<nav>` / `role="navigation"` 硬排除（v1.0.15，`<nav>` 從 `SEMANTIC_CONTAINER_EXCLUDE_TAGS` 移除、`navigation` 從 `EXCLUDE_ROLES` 移除——Engadget 等網站的 `<nav>` 裡含有使用者想看的內容如趨勢文章標題和麵包屑，「該不該翻」交給 system prompt 判斷；同時移除已不再需要的 `isContentNav()` 白名單機制，因為 NAV 不再被排除就不需要白名單放行）、提高 anchor 偵測最短文字門檻（v1.0.16，獨立 `<a>` 元素的偵測門檻從 12 字元提高至 20 字元——v1.0.15 移除 NAV 硬排除後，Engadget 主選單中 "Buyer's Guide"（13 字元）和 "Entertainment"（13 字元）剛好超過舊門檻被翻譯，但 "News"、"Gaming" 等較短項目未被翻譯，造成不一致；此路徑只處理無 block 祖先的獨立 `<a>`，正常文章連結在 `<li>` / `<p>` 等 block 元素內走 walker 偵測不受影響，Trending bar 和麵包屑同理）、Toast 透明度設定（v1.0.17，設定頁新增「Toast 提示」區段，提供 10%–100% 的透明度滑桿，預設 90%；無限捲動等頻繁更新的網站上 toast 訊息不斷跳出會造成視覺干擾，使用者可調低透明度降低干擾；設定存在 `chrome.storage.sync`，content script 監聯 `storage.onChanged` 即時套用，不需 reload extension）、修正 Content Guard 與 rescan 互相觸發迴圈（v1.0.18，Twitter 等 React SPA 框架在捲動時由 virtual DOM reconciliation 重新渲染元素，Content Guard 還原譯文後產生的 DOM mutations 又觸發 observer，observer 同時排程新的 Content Guard 和 rescan，rescan 的翻譯注入又觸發 Content Guard，形成「已恢復N段被覆寫的翻譯」↔「已翻譯N段新內容」的無限跳動；修法：新增 `mutationSuppressedUntil` 冷卻時間戳，Content Guard 還原或 rescan 注入完成後設定 2 秒冷卻期，冷卻期間 observer 忽略所有 mutations——因為這些 mutations 是我們自己的 DOM 寫入產生的，不是框架覆寫或新內容）、精準化冷卻機制分離覆寫偵測與新內容偵測（v1.0.19，v1.0.18 的全域冷卻過於粗暴——2 秒內忽略所有 mutations，導致 Facebook 等持續載入新貼文的 SPA 在冷卻期間無法偵測新內容；重構為雙路徑架構：路徑 A「覆寫偵測」受 `guardSuppressedUntil` 冷卻控制，路徑 B「新內容偵測」永遠活躍但排除已翻譯元素內部的 mutations——`m.target.closest('[data-shinkansen-translated]')` 過濾掉 guard/injection 的 DOM 寫入副作用，只偵測框架載入的真正新段落；Twitter 的 Guard ↔ rescan 迴圈不再發生，因為 guard 寫入後的 mutations 在覆寫偵測被冷卻擋下、在新內容偵測被 translated-ancestor 過濾擋下；Facebook 的新貼文在覆寫偵測冷卻期間仍能被路徑 B 偵測到並觸發 rescan）、Content Guard 架構簡化（v1.0.20，重構 v1.0.14–v1.0.19 逐步疊加的覆寫防護機制。原架構有 5 個變數：mutation 觸發的 guard timer、cooldown 時間戳、cooldown 常數、週期性 interval、interval 常數，加上 `onSpaObserverMutations` 裡的雙路徑架構（路徑 A 覆寫偵測 + 路徑 B 新內容偵測），路徑 A 受 cooldown 控制以防 Twitter 上的 Guard ↔ React 迴圈——但 cooldown 又造成 Facebook 虛擬捲動覆寫的時間缺口。簡化為：刪除 mutation 觸發的路徑 A、刪除 cooldown 機制（`guardSuppressedUntil` / `GUARD_SUPPRESS_MS` / `contentGuardTimer`），只留每秒一次的週期性掃描（`contentGuardInterval`，1 秒間隔）。週期性掃描不依賴 MutationObserver 觸發，不可能產生迴圈，也不需要 cooldown。`onSpaObserverMutations` 只剩新內容偵測（rescan），保留 v1.0.19 的 translated-ancestor 過濾器防止 guard DOM 寫入觸發 rescan。同時修正 `runContentGuard()` 的快取清理——元素暫時斷開 DOM 時跳過不刪除 `STATE.translatedHTML` 條目，Facebook 虛擬捲動暫時移除元素再重新接回帶原文時仍可還原；記憶體影響可忽略——元素數有限且還原/導航時 `.clear()` 會整體清空。guard 改為靜默運作不跳 toast，使用者直接看到文字從原文變回中文即可。Guard 掃描只修復可見/即將可見的元素（視窗上下各 500px 緩衝），離螢幕的元素不動——Facebook 的 React 會在 100–500ms 內覆寫回去，若 guard 對 135+ 個離螢幕元素每秒強寫，會造成每秒 270+ 次無意義 DOM 操作並干擾新內容偵測的 MutationObserver）、頁面層級繁中偵測設定化（v1.0.21，設定頁新增「語言偵測」區段，提供「跳過繁體中文網頁」checkbox，預設開啟；關閉後 `translatePage()` 不再做頁面層級的繁中檢查，但元素層級的 `isCandidateText()` 仍會逐段跳過繁中段落——Gmail 等介面語言為繁中但信件多為英文的網站，關閉此選項即可正常翻譯英文信件；設定存在 `chrome.storage.sync` 的 `skipTraditionalChinesePage` 欄位）、排除 ARIA grid 資料格翻譯（v1.0.22，`EXCLUDE_ROLES` 新增 `grid`——ARIA `role="grid"` 標記的是互動式資料格如 email 列表、檔案管理器等，cell 內容是獨立資料欄位如寄件者/主旨/日期，不是文章段落，翻譯整個 gridcell 會摧毀欄位結構。Gmail inbox 的 `<table role="grid">` 是典型案例，翻譯前會偵測到 52 段 `<td>` 並把寄件者+主旨+預覽混成一段送翻，結果亂碼。加入 grid 排除後 inbox list view 的整個 `<td>` 不再被當成翻譯單位。同時新增「grid cell leaf text」補抓 pass——排除整個 td 後回頭掃描 grid cell 內部的純文字 leaf 元素（`children.length === 0`、自身文字 >= 15 字、通過 `isCandidateText`），個別翻譯主旨 span，保留欄位結構。限制純文字 leaf 是因為有子元素的 span（如 Gmail 預覽 `<span>text<span>-</span></span>`）在序列化→注入過程中佔位符重建可能插入 `<br>` 撐破行高。中文信件的主旨/預覽會被 `isTraditionalChinese` 過濾跳過，只翻譯英文信件。個別 email 內容不在 grid 內不受影響。Wikipedia 等純內容表格不使用 `role="grid"` 不會被誤傷。後續補充：放寬 grid cell leaf 限制，允許含短文字子元素的 span 也被偵測——Gmail 預覽欄位 `<span>text<span>-</span></span>` 的 `-` 子元素文字 < 15 字即通過；CSS 新增 `table[role="grid"] [data-shinkansen-translated] br { display: none }` 隱藏序列化重建產生的 `<br>` 標籤，防止撐破 flex 單行佈局）、SPA 續翻模式（v1.0.23，使用者在某頁面手動按 Option+S 翻譯後，後續同一頁面內的 SPA 導航自動翻譯新內容——Gmail 點進一封 email 時自動翻譯信件內容，退回 inbox 時自動重新翻譯主旨/預覽。新增 `STATE.stickyTranslate` 旗標：`translatePage()` 完成時設為 true，`restorePage()` 時設為 false，`resetForSpaNavigation()` 保留不清。`handleSpaNavigation()` 優先檢查 stickyTranslate，命中時直接呼叫 `translatePage()` 不需查白名單。URL 輪詢的捲動跳過邏輯在 stickyTranslate 開啟時不跳過——確保 Gmail hash 導航等 replaceState 未攔截到的 URL 變化能正確觸發。新增 `hashchange` 事件監聽——Gmail 使用 hash-based 路由 `#inbox` → `#inbox/FMfcg...`，不走 pushState/popstate，monkey-patch 和 popstate 監聽都攔不到，hashchange 是 hash 路由唯一可靠的同步事件）、設定頁 API Key 欄位加入申請教學連結（v1.0.24，API Key 輸入框下方新增「還沒有 API Key？請參考申請教學」提示連結，指向 GitHub repo 的 `API-KEY-SETUP.md`，包含帳單設定等容易遺漏的步驟）、設定頁標題下方加入 README 連結 + README 加入 PERFORMANCE.md 超連結（v1.0.25）、擴充 `window.__shinkansen` 測試 API（v1.0.26——新增 `setTestState()`、`testRunContentGuard()`、`testGoogleDocsUrl()`，`getState()` 增加 `translating`/`stickyTranslate`/`guardCacheSize` 欄位，讓 regression spec 能測試 Content Guard 覆寫修復與 Google Docs URL 解析邏輯）、設定頁術語表區塊加入預設不開啟說明與 README 連結 + README 大幅擴充文件（v1.0.27——options.html 術語表一致化區段新增副作用說明與 GitHub README 連結；README 新增 API Key 申請教學連結、SPEC.md 改為超連結、Gemini API Rate Limit 參考表格、術語表一致化詳細說明段落、翻譯快取與費用計算段落含雙層快取機制說明與通知數據解讀、編輯譯文用途說明）、設定頁拆分（v1.0.28——原「設定」Tab 拆為「一般設定」與「Gemini」兩個 Tab。Gemini Tab 包含 Gemini API（Key/模型/Service Tier）、模型計價、配額（API 用量限制）、LLM 參數微調、術語表一致化五個區段；一般設定 Tab 保留效能、網域規則、語言偵測、Toast 透明度、匯入匯出、快捷鍵、回復預設、授權資訊。兩個 Tab 共用同一個 save() 函式與 dirty 偵測機制。Tab bar 變為四個：一般設定 | Gemini | 用量紀錄 | Log）、固定術語表與術語表 Tab（v1.0.29——新增「術語表」Tab，包含兩大區塊：「固定術語表」為使用者手動指定的「原文 → 譯文」對照，支援全域通用 + 網域專用兩層，網域術語覆蓋全域同名術語；「自動術語擷取」為既有的 Gemini 自動擷取功能（從 Gemini Tab 搬來）。固定術語優先級最高——注入 system prompt 時放在自動擷取術語之後，以「使用者指定，優先級高於上方所有術語」措辭確保 LLM 遵守。儲存在 `chrome.storage.sync` 的 `fixedGlossary` 欄位，結構為 `{ global: [{source, target}], byDomain: { "domain.com": [{source, target}] } }`。`background.js` 翻譯時從 settings 讀取固定術語，以 `sender.tab.url` 的 hostname 匹配網域，合併後透過 `translateBatch()` 第四參數傳給 `gemini.js`。快取 key 同時包含自動與固定術語的 hash，確保術語變更後舊快取自動失效。Tab bar 變為五個：一般設定 | Gemini | 術語表 | 用量紀錄 | Log）、用量紀錄表格顯示 cache hit rate（v1.0.30——用量紀錄表格的 Tokens 欄位下方新增小字 `(XX% hit)` 顯示 Gemini implicit cache 命中率，計算方式為 `cachedTokens / inputTokens`；命中率為 0 時不顯示，保持欄位乾淨）、Toast 位置選項與預設透明度調整（v1.0.31——設定頁「翻譯進度通知」新增「顯示位置」下拉選單，可選右下角/左下角/右上角/左上角，預設右下角；Toast 預設透明度從 90% 改為 70%；位置透過 CSS class `pos-{position}` 控制，支援 `chrome.storage.onChanged` 即時套用不需 reload extension）。

### 2.2 規劃中（尚未實作）

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、多 Provider（Google 翻譯、DeepL、Yandex 等）、PDF/EPUB/影片字幕、延遲載入、多國語言介面、淺色/深色主題切換、雙語對照顯示模式。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-3-flash-preview`，可改為其他 Gemini 模型或自行輸入模型 ID）
- `serviceTier`：推論層級（DEFAULT / FLEX / STANDARD / PRIORITY），設定頁存大寫短形式，API 送出時轉小寫（`flex`/`standard`/`priority`），DEFAULT 時不送此欄位
- `temperature`：創造性，範圍 0–2，預設 1.0（Gemini 3 Flash 原廠預設值）
- `topP`：核採樣，預設 0.95
- `topK`：預設 40（Gemini 3 Flash 原廠預設值，Pro 系列為 64）
- `maxOutputTokens`：最大輸出長度，預設 8192
- `systemInstruction`：系統提示詞（見 3.3）
- `safetySettings`：安全過濾等級（預設 BLOCK_NONE 四大類別全開）

> **Thinking 功能**：`gemini.js` 固定送 `thinkingConfig: { thinkingBudget: 0 }`（永遠關閉），不開放使用者設定。原因是思考 token 會吃掉 `maxOutputTokens` 額度，導致譯文被截斷。

### 3.3 預設 System Prompt

完整預設 prompt 定義在 `lib/storage.js` 的 `DEFAULT_SYSTEM_PROMPT`（v0.83 升級）。採 XML tag 結構，分四大區塊：

- **`<role_definition>`**：定位為「精通英美流行文化與台灣在地文學的首席翻譯專家」，追求出版級台灣當代語感
- **`<critical_rules>`**：禁止輸出思考過程、忠實保留不雅詞彙（不做道德審查）、專有名詞保留英文原文（地理位置例外，須翻為台灣標準譯名）
- **`<linguistic_guidelines>`**：台灣道地語感（拒絕翻譯腔）、禁用中國大陸用語（附具體對照表）、台灣通行譯名、特殊詞彙首次出現加註原文
- **`<formatting_and_typography>`**：全形標點、破折號改寫、中英夾雜半形空格、數字格式（1–99 中文數字、100 以上阿拉伯數字）、年份格式

`lib/gemini.js` 的 `buildEffectiveSystemInstruction()` 會依批次內容動態追加規則。追加順序為：基礎指令 → 多段分隔符（含 `«N»` 序號標記規則） → 段內換行 → 佔位符 → 術語對照表。

### 3.4 分段請求協定

多段文字以 `\n<<<SHINKANSEN_SEP>>>\n` 串接後一次送出，回應以相同分隔符拆分對齊。

**分批策略**：字元預算 + 段數上限雙門檻 greedy 打包。`maxCharsPerBatch`（預設 3500，設定頁可調）與 `maxUnitsPerBatch`（預設 12，設定頁可調）任一觸發即封口。超大段落獨佔一批，不切段落本身。

**對齊失敗 fallback**：回傳段數不符時退回逐段單獨呼叫模式。

**實作位置**：`content.js` 的 `packBatches()` 為主要打包層，`lib/gemini.js` 的 `packChunks()` 為雙重保險層。

### 3.5 Rate Limiter

三維滑動視窗（RPM / TPM / RPD），實作於 `lib/rate-limiter.js`。

- **RPM**：60 秒滑動視窗，時間戳環形緩衝區
- **TPM**：60 秒滑動視窗，token 估算 `Math.ceil(text.length / 3.5)`
- **RPD**：太平洋時間午夜重置，持久化至 `chrome.storage.local`（key `rateLimit_rpd_<YYYYMMDD>`）
- **安全邊際**：每個上限乘以 `(1 - safetyMargin)`，預設 10%
- **429 處理**：尊重 `Retry-After` header，否則指數退避 `2^n * 500ms`（上限 8 秒）。RPD 爆則不重試

Tier 對照表在 `lib/tier-limits.js`，涵蓋 Free / Tier 1 / Tier 2 各模型的 RPM / TPM / RPD。設定頁可選 Tier 或自訂覆寫。

### 3.6 術語表一致化

翻譯長文前先呼叫 Gemini 擷取全文專有名詞對照表，注入所有翻譯批次的 systemInstruction。

**策略依文章長度分三級**（由 `glossary.skipThreshold` 和 `glossary.blockingThreshold` 控制）：

- ≤ `skipThreshold`（預設 1）批 → 完全跳過，不建術語表
- `skipThreshold` < 批數 ≤ `blockingThreshold`（預設 5）→ fire-and-forget（首批不等術語表）
- \> `blockingThreshold` → 阻塞等待術語表回來再開始翻譯

**擷取 prompt**：定義在 `lib/storage.js` 的 `DEFAULT_GLOSSARY_PROMPT`，XML 結構，限定四類實體（人名/地名/專業術語/作品名），附排除規則與 JSON 格式範例。上限 `glossary.maxTerms`（預設 200）條。

**其他細節**：

- 輸入壓縮：只送 heading、每段第一句、caption、頁面標題（約原文 20–30%）
- 術語表快取於 `chrome.storage.local`（key `gloss_<sha1>`），版本變更時清空
- 術語表請求走 rate limiter priority 0 插隊
- 逾時 `glossary.timeoutMs`（預設 60000ms），`gemini.js` 內部 fetch 層另有 `fetchTimeoutMs`（預設 55000ms）
- 失敗或逾時 → fallback 成不帶術語表的一般翻譯
- 術語表 temperature 獨立設定（預設 0.1，要穩定不要有創意）
- 預設停用（`glossary.enabled` 預設 `false`），使用者可在設定頁或 Popup 開啟

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

**單語覆蓋（僅此一種）**：將原文段落的文字節點替換成譯文，元素本身保留不動。**不提供雙語對照模式**。

### 4.2 替換策略

依元素內含的內容走兩條路徑，共用 `resolveWriteTarget()` + `injectIntoTarget()` 兩個 helper：

**`resolveWriteTarget(el)`**：回答「要把譯文寫到哪個元素」。預設回傳 `el` 自己；若 `el` 的 computed `font-size < 1px`（MJML email 模板常見），改回傳第一個 font-size 正常且非 slot 系元素的後代。descent 時整個 slot subtree 以 `FILTER_REJECT` 跳過（含子孫）。

**`injectIntoTarget(target, content)`**：回答「怎麼寫進 target」。預設走 clean slate（清空 children 後 append）；若 target 含媒體元素（img/svg/video/picture/audio/canvas），改走「就地替換最長文字節點」保留媒體。

**路徑 A — 含可保留行內元素**：

1. `serializeWithPlaceholders(el)`：遞迴把行內元素換成 `⟦N⟧…⟦/N⟧` 佔位符（支援巢狀），slot 存 shallow clone
2. LLM 翻譯純文字，佔位符原樣保留
3. `selectBestSlotOccurrences(text)`：處理 LLM 重複引用同一 slot 的情況（挑首次非空出現為 winner，其餘降級為純文字）
4. `deserializeWithPlaceholders(translation, slots)`：遞迴 `parseSegment()` 重建 DocumentFragment
5. `replaceNodeInPlace(el, frag)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入

驗證採寬鬆模式：至少一對佔位符配對即視為成功，殘留標記由 `stripStrayPlaceholderMarkers` 清除。

**路徑 B — 無可保留行內元素**：

`replaceTextInPlace(el, translation)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入。含 `\n` 時用 `buildFragmentFromTextWithBr` 產生帶 `<br>` 的 fragment。

**`<br>` ↔ `\n` round-trip**：序列化時用 sentinel `\u0001` 標記來自 `<br>` 的換行，與 source HTML 排版空白區分。normalize 先收所有原生 whitespace 為 space，再把 sentinel 還原為 `\n`。反序列化時 `\n` 還原為 `<br>`。

### 4.2.1 可保留行內元素清單

`PRESERVE_INLINE_TAGS`：A, STRONG, B, EM, I, CODE, MARK, U, S, SUB, SUP, KBD, ABBR, CITE, Q, SMALL, DEL, INS, VAR, SAMP, TIME

`SPAN`：僅當帶有 `class` 或非空 `style` 屬性時才保留。

**原子保留（`isAtomicPreserve`）**：`<sup class="reference">` 整個 deep clone 進 slot，用自閉合 `⟦*N⟧` 取代，內部文字不送 LLM。

佔位符字元：`⟦` (U+27E6) 與 `⟧` (U+27E7)。配對型 `⟦N⟧…⟦/N⟧`，自閉合 `⟦*N⟧`。

### 4.3 還原機制

`STATE.originalHTML`（Map，el → innerHTML）備份每個被替換元素的原始 HTML。再次按 Option+S 呼叫 `restorePage()` 逐一還原。

### 4.4 視覺樣式

原文元素的 font-family、font-size、color、layout 完全不動。不加邊框、背景、左邊線等任何裝飾。

---

## 5. 段落偵測規則

### 5.1 納入的 block tags

```
P, H1, H2, H3, H4, H5, H6, LI, BLOCKQUOTE, DD, DT,
FIGCAPTION, CAPTION, TH, TD, SUMMARY
```

### 5.2 硬排除

- **Tags**（整個子樹不走）：SCRIPT, STYLE, CODE, PRE, NOSCRIPT, TEXTAREA, INPUT, BUTTON, SELECT
- **語意容器**：NAV、FOOTER 永遠跳過
- **ARIA role**：祖先鏈含 `banner` / `navigation` / `contentinfo` / `search` 則跳過。HEADER 僅在 `role="banner"` 時排除

**不做內容性 selector 排除**：content.js 不以 class/selector 判斷「該不該翻」。此類判斷交給 Gemini systemInstruction。

### 5.3 選擇器補抓（`INCLUDE_BY_SELECTOR`）

```
#siteSub, #contentSub, #contentSub2, #coordinates,
.hatnote, .mw-redirectedfrom, .dablink, [role="note"], .thumbcaption
```

### 5.4 Mixed-content fragment 單位

若 block 元素既有直接文字又含 block 後代（如 `<li>` 含巢狀 `<ul>`），walker 先讓 block 子孫獨立處理，再用 `extractDirectTextFragment()` 從父元素收集「不屬於任何 block 後代」的直接文字（含夾在中間的行內元素），建立虛擬 fragment 單位。fragment 單位注入時走原節點就地替換，不新增 DOM 容器。

### 5.5 可見性過濾

`isVisible(el)` 排除 `display:none`、`visibility:hidden`、`getBoundingClientRect()` 面積為零的元素。候選文字須含拉丁字母、CJK 或數字才算有效。

---

## 6. 專案檔案結構

```
shinkansen/
├── manifest.json
├── content.js            # Content script（不能用 ES module）
├── content.css
├── background.js         # Service Worker（ES module）
├── lib/
│   ├── gemini.js         # Gemini API 呼叫、分批、重試
│   ├── cache.js          # 翻譯快取（LRU + debounced flush）
│   ├── storage.js        # 設定讀寫、預設值
│   ├── rate-limiter.js   # 三維 Rate Limiter
│   ├── tier-limits.js    # Tier 對照表
│   ├── logger.js         # 結構化 Log 系統
│   ├── usage-db.js       # 用量追蹤（IndexedDB）
│   ├── format.js         # 共用格式化函式（formatBytes/formatTokens/formatUSD）
│   ├── detector.js       # 預留空殼（邏輯目前在 content.js）
│   ├── injector.js       # 預留空殼（邏輯目前在 content.js）
│   └── vendor/           # 第三方程式庫
├── popup/
│   ├── popup.html
│   ├── popup.js          # ES module
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js        # ES module
│   └── options.css
├── _locales/
│   └── zh_TW/
│       └── messages.json # Chrome i18n 繁體中文語系檔
└── icons/
```

---

## 7. 資料流程

1. 使用者按 Option+S 或 Popup「翻譯本頁」
2. `content.js` 的 `collectParagraphs()` 遍歷 DOM 收集翻譯單位
3. `packBatches()` 依字元預算 + 段數上限打包成批次
4. 術語表前置流程（依文章長度決定策略）
5. `runWithConcurrency()` 平行送出批次，每批經 `TRANSLATE_BATCH` 訊息到 background
6. background 的 handler 查快取 → 未命中則走 Rate Limiter → 呼叫 Gemini API
7. 每批回來立即注入 DOM（`injectTranslation`），Toast 更新進度
8. 全部完成後顯示成功 Toast（含 token 數、費用、快取命中率）

---

## 8. 設定資料結構

### 8.1 `chrome.storage.sync`（跨裝置同步，100KB 上限）

以下為 `lib/storage.js` 的 `DEFAULT_SETTINGS` 完整結構（含預設值）：

```json
{
  "geminiConfig": {
    "model": "gemini-3-flash-preview",
    "serviceTier": "DEFAULT",
    "temperature": 1.0,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 8192,
    "systemInstruction": "（見 §3.3 DEFAULT_SYSTEM_PROMPT）"
  },
  "pricing": { "inputPerMTok": 0.50, "outputPerMTok": 3.00 },
  "glossary": {
    "enabled": false,
    "prompt": "（見 DEFAULT_GLOSSARY_PROMPT）",
    "temperature": 0.1,
    "skipThreshold": 1,
    "blockingThreshold": 5,
    "timeoutMs": 60000,
    "maxTerms": 200
  },
  "domainRules": { "whitelist": [], "blacklist": [] },
  "autoTranslate": false,
  "debugLog": false,
  "tier": "tier1",
  "safetyMargin": 0.1,
  "maxRetries": 3,
  "rpmOverride": null,
  "tpmOverride": null,
  "rpdOverride": null,
  "maxConcurrentBatches": 10,
  "maxUnitsPerBatch": 12,
  "maxCharsPerBatch": 3500,
  "maxTranslateUnits": 1000
}
```

- **API Key** 存 `chrome.storage.local`（key `apiKey`），不跨裝置同步。舊版（≤v0.61）存在 sync 的 Key 會自動遷移至 local
- 快捷鍵由 Chrome 原生 `commands` API 管理，不存設定
- `rpmOverride` / `tpmOverride` / `rpdOverride`：非 null 時覆寫 tier 對照表的對應值
- `maxTranslateUnits`：單頁翻譯段落數上限，超過截斷（0 = 不限制）

### 8.2 `chrome.storage.local`（本地，5MB 上限）

- **翻譯快取**：key `tc_<sha1>` → 譯文字串
- **術語表快取**：key `gloss_<sha1>` → 術語對照 JSON
- **版本標記**：key `__cacheVersion` → manifest version（不一致時清空所有快取）
- **RPD 計數**：key `rateLimit_rpd_<YYYYMMDD>` → 當日請求數

### 8.3 同步策略

- `chrome.storage.sync` 自動跨裝置同步設定（不含 API Key）
- 翻譯快取與術語表快取只存 local，不同步
- 設定頁提供匯出/匯入 JSON（API Key 不含在匯出範圍），匯入時 `sanitizeImport()` 驗證所有欄位

---

## 9. 翻譯快取

### 9.1 Key 設計

`tc_` + SHA-1（原文十六進位）= 43 字元。同一段原文跨頁面共用同一 key。key 只 hash 原文，不含模型/prompt；換模型改 prompt 時以版本自動清空處理。

有術語表時，快取 key 追加 `_g<glossary hash 前 12 字元>` 後綴，確保有/無術語表的翻譯分開快取。

### 9.2 批次讀寫

- `cache.getBatch(texts)`：一次 `storage.local.get(allKeys)`。讀取時累積 LRU 時間戳到 `pendingTouches`，由 5 秒 debounce 統一 flush
- `cache.setBatch(texts, translations)`：一次 `storage.local.set(updates)`。eviction check 最多每 30 秒一次

### 9.3 清空邏輯

- `cache.clearAll()`：filter 出 `tc_` 和 `gloss_` 開頭的 key 全部 remove
- `cache.checkVersionAndClear(currentVersion)`：比對版本，不一致則 clearAll 並更新 `__cacheVersion`
- Service Worker 啟動時與 `onInstalled` 事件各執行一次

### 9.4 統計

`cache.stats()` 回傳 `{ count, bytes }`。bytes 為 key + value 字元長度粗估。

---

## 10. 快捷鍵

**Option + S**（macOS）/ **Alt + S**（其他 OS）—— 切換翻譯狀態。

```json
"commands": {
  "toggle-translate": {
    "suggested_key": { "default": "Alt+S", "mac": "Alt+S" },
    "description": "切換目前分頁的翻譯"
  }
}
```

使用者可至 `chrome://extensions/shortcuts` 調整。

---

## 11. 翻譯狀態提示（Toast）

### 11.1 容器

`position: fixed; z-index: 2147483647`，Shadow DOM 隔離（closed mode），280px 寬、白底圓角陰影。位置由 CSS class `pos-{position}` 控制，支援 `bottom-right`（預設）、`bottom-left`、`top-right`、`top-left` 四個選項，使用者可在設定頁調整。預設透明度 70%。

### 11.2 狀態

| 狀態 | 主訊息 | 進度條 | 自動消失 |
|------|--------|--------|----------|
| loading | `翻譯中… N / Total` + 計時器 | 藍色（mismatch 時黃色閃爍） | 否 |
| success | `翻譯完成（N 段）` + token/費用/命中率 | 綠色 100% | 否（點擊外部關閉） |
| error | `翻譯失敗：<msg>` | 紅色 100% | 否 |
| restore | `已還原原文` | 綠色 100% | 2 秒 |

成功 Toast 的 detail 兩行：token 數 + implicit cache hit%、實付費用 + 節省%。費用套用 Gemini implicit context cache 折扣（cached tokens ×0.25 計費）。

### 11.3 設計原則

- 不用轉圈 spinner，用橫向進度條 + 計時器
- 不用左邊色條 border-left
- 成功提示不自動消失（避免錯過）
- 延遲 rescan 補抓在 UI 層完全隱形

---

## 12. LLM 除錯 Log

`lib/logger.js` 提供結構化 Log，記錄 API 呼叫的時間、模型、參數、耗時、token、錯誤等。

- **記憶體 buffer**：最近 1000 筆，設定頁「Log」分頁可瀏覽（分類/等級篩選、搜尋、匯出 JSON）
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content.js 透過 CustomEvent 橋接，main world 可用 `shinkansen-debug-request` / `shinkansen-debug-response` 事件讀取 log（支援 `GET_LOGS`、`CLEAR_LOGS`、`CLEAR_CACHE`、`TRANSLATE`、`RESTORE`、`GET_STATE`）

---

## 13. Popup 面板規格

### 13.1 版面

- Header：emoji 🚄 + 名稱「Shinkansen」+ 版本號（動態讀取）
- 主按鈕：「翻譯本頁」/「顯示原文」（依 `GET_STATE` 切換）
- 編輯譯文按鈕（預設 `hidden`，翻譯完成後才顯示；切換 `TOGGLE_EDIT_MODE`）
- 白名單自動翻譯 toggle
- 術語表一致化 toggle
- 快取統計（段數 / 大小）+ 清除快取按鈕
- 累計費用 / token 顯示（透過 `USAGE_STATS` 訊息讀取；重置功能在 options 頁面）
- 狀態列（「狀態：就緒」/ 「狀態：正在翻譯…」/ 錯誤訊息等）
- Footer：設定按鈕（開啟 options 頁面）+ 快捷鍵提示（動態讀取 `chrome.commands`）

### 13.2 版本顯示

**必須**透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。

---

## 14. 訊息協定（content ↔ background ↔ popup）

### 14.1 content → background

| type | payload | 回應 |
|------|---------|------|
| `TRANSLATE_BATCH` | `{ texts, slots, … }` | `{ ok, result, usage }` |
| `EXTRACT_GLOSSARY` | `{ input }` | `{ ok, terms, _diag }` |
| `LOG` | `{ level, category, message, data }` | — |
| `LOG_USAGE` | `{ inputTokens, outputTokens, … }` | `{ ok }` |
| `SET_BADGE_TRANSLATED` | — | `{ ok }` |
| `CLEAR_BADGE` | — | `{ ok }` |

### 14.2 popup / options → background

| type | 回應 | 用途 |
|------|------|------|
| `CACHE_STATS` | `{ ok, count, bytes }` | 快取統計 |
| `CLEAR_CACHE` | `{ ok, removed }` | 清空翻譯快取 |
| `USAGE_STATS` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 累計費用/token 顯示 |
| `RESET_USAGE` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 重置累計統計 |
| `QUERY_USAGE_STATS` | `{ ok, stats }` | Options 用量彙總卡片 |
| `QUERY_USAGE_CHART` | `{ ok, data }` | Options 用量折線圖 |
| `QUERY_USAGE` | `{ ok, records }` | Options 用量明細表格 |
| `EXPORT_USAGE_CSV` | `{ ok, csv }` | Options 匯出 CSV |
| `CLEAR_USAGE` | `{ ok }` | Options 清除用量紀錄 |
| `GET_LOGS` | `{ logs }` | 讀取 Log buffer（同步） |
| `CLEAR_LOGS` | — | 清空 Log buffer（同步） |
| `CLEAR_RPD` | `{ ok, removedKeys }` | 清除 RPD 計數（除錯用） |

> **設定讀寫**：popup 和 options 直接透過 `chrome.storage.sync` / `chrome.storage.local` 存取設定，不經 message handler。

### 14.3 background / popup → content

| type | 用途 |
|------|------|
| `TOGGLE_TRANSLATE` | 觸發翻譯或還原 |
| `GET_STATE` | 查詢翻譯狀態 |
| `TOGGLE_EDIT_MODE` | 切換編輯譯文模式 |

### 14.4 Badge

翻譯完成後 `SET_BADGE_TRANSLATED` 點亮紅點 badge（`●`，`#cf3a2c`）。分頁跨站導航時 `chrome.tabs.onUpdated` 自動清除。

background.js 使用 `messageHandlers` 物件 map 做 O(1) dispatch，統一的 listener 負責 sendResponse 包裝與錯誤處理。

---

## 15. Debug API

供自動化測試（Playwright）在 isolated world 查詢 content script 內部狀態。`content.js` 載入後在 isolated world 掛上 `window.__shinkansen`：

```js
window.__shinkansen = {
  version: string,                          // manifest version（getter）
  collectParagraphs(): Array,               // 回傳序列化安全的段落陣列
  collectParagraphsWithStats(): Object,     // 同上 + walker 跳過統計
  serialize(el): { text, slots },           // 佔位符序列化
  deserialize(text, slots): { frag, ok, matched }, // 佔位符反序列化
  testInject(el, translation): { sourceText, slotCount }, // 測試用：跑完整 serialize → inject 路徑，跳過 API 層
  selectBestSlotOccurrences(text): Object,  // 測試用：暴露 slot 重複排除邏輯
  getState(): Object,                       // 翻譯狀態快照
}
```

**設計原則**：查詢類方法只讀不寫、回 plain object 不回 DOM 參考、永遠啟用（無開關）、掛在 isolated world。`testInject` 和 `selectBestSlotOccurrences` 是測試專用 helper（v0.59 起），供 regression spec 驗證注入路徑而不需要呼叫 Gemini API。

---

## 16. 用量追蹤

`lib/usage-db.js` 使用 IndexedDB 儲存每次翻譯的詳細紀錄（時間、URL、模型、token 數、費用、段落數等）。

- 設定頁「用量」分頁：彙總卡片（總費用/token/筆數/最常用模型）、折線圖（日/週/月粒度）、明細表格
- 支援日期範圍篩選、CSV 匯出、清除
- 費用計算套用 Gemini implicit cache 折扣後的實付值
