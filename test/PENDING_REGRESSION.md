# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Claude Code** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步);跑完 `npm test` 全綠後若本檔非空,也必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

(目前沒有 pending 條目)

<!-- v1.9.11 清空紀錄(2026-05-12,Phase 1 macOS Safari 真機驗證 + Phase 1.5 release 完整收尾):

  ★ 兩條皆 **永久 path B**(自動化測試永遠寫不出來),SANITY 視覺驗收完成 + 已 release,
    queue 不再追蹤。原因:options.js 2000+ 行 module top-level side effect 多 + Playwright
    extension runtime URL 鎖 `chrome-extension://` 無法 mock `safari-web-extension://` /
    Playwright Chromium webkit ≠ 真實 Safari webkit baseline 渲染。

  ── B1: v1.9.10 options.js Safari detection 改用 body class + event delegation ──
  - 症狀:macOS Safari 真機 options 頁「翻譯快速鍵」section intro 顯示廢 `chrome://extensions/shortcuts`
    link(Safari 不允許 extension UI 改快速鍵,留 link 對 Safari user 是廢資訊)
  - 修在:`options/options.js` line 1733-1760 + `options/options.css` 加 `body.runtime-safari` rule
  - root cause:原 pattern「per-element addEventListener + inline style」被 `data-i18n-html` 的
    applyI18n 用 innerHTML 重設 `<p>` 時整個吹掉。改用 `document.body.classList.add('runtime-' + platform)`
    + event delegation 綁 document
  - 連帶 fix:Chrome / Firefox 一直被 i18n 吹掉的隱性 anchor click listener bug(沒人發現,
    因為 anchor href="#" 點下去靜悄悄沒事),event delegation 一起解
  - 為什麼永遠寫不出 spec:options.js 2000+ 行 module 含一堆 top-level side effects,
    要 unit test detection 邏輯必須先把 detection 抽 pure function(超出當前 bug fix 範圍,
    沒計畫 refactor);Playwright fixture extension 載入的 runtime URL 鎖 `chrome-extension://`,
    無法 mock 成 `safari-web-extension://` 驗 Safari 分支
  - SANITY:✅ 2026-05-12 macOS Safari 真機已視覺驗收 — Xcode rebuild + Safari reload extension +
    options「翻譯快速鍵」section anchor 隱藏(顯示「鍵位可至 變更」中間空格)

  ── B2: v1.9.11 options.css Safari `<input type="date">` line-height 25px 對齊 ──
  - 症狀:用量紀錄頁面 date input(2026/05/05)在 macOS Safari 上 Y 軸沒跟同 row 的 `00:00`
    select stepper 對齊(視覺偏上 ~7px)
  - 修在:`options/options.css` `body.runtime-safari .usage-date-label input[type="date"]`
    + `::-webkit-datetime-edit` pseudo
  - root cause:Safari 26 macOS 對 `<input type="date">` 即使套 `-webkit-appearance: textfield`,
    內部 `::-webkit-datetime-edit` pseudo-element line-box 仍預設靠 content area 頂端對齊
    (非 center);加上拉丁數字 0-9 visual weight 偏底部,geometric center 對齊 ≠ visual center
  - 修法:`-webkit-appearance: textfield` + `line-height: 25px`(on input + `::-webkit-datetime-edit`)。
    25px 是當前字型(-apple-system + PingFang TC + 13px)的 visual sweet spot
  - 修法歷程(燒 3 輪才鎖到):
    * v1.9.10:`::-webkit-datetime-edit-fields-wrapper` selector(Chrome 內部結構,Safari 不認)
      + `display: flex; align-items: center` → 真機完全沒生效
    * v1.9.11 中間嘗試:`-webkit-appearance: textfield` + `::-webkit-datetime-edit {
      padding: 0; margin: 0; line-height: 1 }` + `padding-top: 4px` → 沒生效
    * v1.9.11 final:加 setTimeout 1.5s 在 options.js 末尾彈紅框 dump 真機 computed style
      (CLAUDE.md §11 真實資料優先,避免再憑視覺猜),從 line-height: 13px(預設) = font-size
      看出 line-box 預設靠頂端對齊 → root cause 鎖死。歷時 30 → 28 → 26 → 25 四輪微調,
      Jimmy 視覺確認 25 pixel-perfect。debug code release 前已拿掉
  - 為什麼永遠寫不出 spec:webkit baseline 渲染差異,Playwright Chromium 跟真實 Safari webkit
    行為不同(Chromium 上已對齊,不會 reproduce);Playwright `playwright.webkit` 跟 Safari
    Web Extension 環境也有差距。完全靠真機視覺驗收
  - SANITY:✅ 2026-05-12 macOS Safari 真機已視覺驗收 line-height 25px pixel-perfect 對齊
-->


<!-- v1.9.5 清空紀錄(2026-05-11):
  - Google Translate 批次 echo 原文 → 逐筆 retry 補救 → 已補
    test/unit/google-translate-batch.spec.js 加 3 條 case(批次內某 unit echo / 整批全 echo /
    retry 仍 echo 維持原值)+ SANITY 驗(註解掉 needsRetry 區塊 → 3 條 fail,還原後全綠)。
    走 unit test 路徑(import lib/google-translate.js + mock globalThis.fetch),
    比 Playwright fixture 模 sendMessage 路徑直接,跟 v1.4.0 既有 7 條測試共用同檔同 mock 模式。
-->


<!-- v1.9.1+ 清空紀錄(2026-05-10):
  - v1.8.68 同 videoId yt-navigate-finish guard → 已補 test/unit/youtube-spa-nav-guard.spec.js
    (7 case + SANITY 過。鎖 guard 邏輯架構:listener 找得到 / 取 newVideoId /
    三段式條件 active+truthy+===videoId / early return / guard 在 reset path 之前 /
    reset path 仍在 / 命中記 'SPA nav skipped' log。SANITY:暫時拔掉 guard 整段 →
    4 條 fail 還原 → 全綠)
  - **訊號層次說明**(§1.1 規則 3):本 spec 鎖「我們的 guard 邏輯寫對」、**不鎖**
    「YouTube 真的會 fire 假性同 videoId 的 yt-navigate-finish」。後者是 YouTube
    內部行為,fixture dispatchEvent 自己 fire 永遠驗不到 — 這層靠 user 觀察 +
    production 體感持續驗證。

  popup 累計費用 path 合一 + 術語表抽取寫入 IndexedDB 兩條退役紀錄見下方
-->

<!-- v1.9.1 清空紀錄(2026-05-10):
  - popup 累計費用 path 合一 → 已補 test/unit/usage-path-architecture.spec.js
    (12 條 case:USAGE_STATS / RESET_USAGE handler 不存在 + addUsage / getUsageStats
    / resetUsageStats / USAGE_KEY 不再定義 + storage.local.set('usageStats') 不存在
    + QUERY_USAGE_STATS handler 仍在且走 usageDB.getStats + popup.js 送
    QUERY_USAGE_STATS / 讀 totalBilledCostUSD / 不送 USAGE_STATS / 不讀 totalCostUSD;
    SANITY:暫時把 USAGE_STATS handler 加回 background.js → 對應 spec fail,
    還原後全綠)
  - 術語表抽取用量寫進 IndexedDB(source='glossary')→ 已補
    test/unit/usage-glossary-record.spec.js(16 條 case:Gemini + OpenAI-compat
    兩條 handler 各驗 logTranslation 呼叫 / source='glossary' / engine 標籤 /
    model 欄位 fallback / billedCostUSD / 包在 if (usage > 0) block 內 / 用
    getCustomCacheHitRate 推 cache 折扣率;SANITY:暫時把 Gemini handler 內的
    usageDB.logTranslation 改名 → 對應 2 條 spec fail,還原後全綠)
-->


<!-- v1.8.46 清空紀錄(2026-05-05):
  - W6 譯文 PDF 下載對 owner-password + AESv2 弱加密 PDF 失敗(Trimble TDC6 SpecSheet)
    → 換 @cantoo/pdf-lib 2.6.5 fork(補 mozilla/pdf.js port 的 AES decrypt)
    + PDFDocument.load 加 { ignoreEncryption: true, password: '' }
    → 已補 test/regression/pdf-download-encrypted.spec.js(SANITY:暫時 revert
      password='' 驗證 spec 正確 fail EncryptedPDFError,還原 fix → pass)
    → fixture 走 docs/excluded(整個 .gitignore),CI 沒檔自動 skip,本機才跑
-->


<!-- v1.8.42 清空紀錄(2026-05-04):
  - non-ASR 雙語改走獨立 overlay + multi-segment dedup → 已補 test/regression/youtube-bilingual-overlay.spec.js
    (4 條 case:雙語不動 segment、雙語 dedup seg2 cached='' 也 push srcBits、純中文 dedup seg2 cached='' 清空 segment、_applyBilingualMode 加 hide class;case 3 已 SANITY 驗過)
  - 同時新加 SK._applyBilingualMode export 給 spec 用
-->


<!-- v1.8.41 清空紀錄(2026-05-04):
  - v1.8.40 YouTube zh-Hant skip → 已補 test/regression/youtube-skip-already-zh-hant.spec.js
    (6 條 case:4 個 zh-Hant/TW/HK/MO 應 skip + en/zh-Hans 對照組應送 API,SANITY 驗過)
  - v1.8.39 translateUnits 段落 hash dedup → 已補 test/regression/translate-dedup-broadcast.spec.js
    + fixtures/translate-dedup-broadcast.html(5 unique + 60 重複段,SANITY 驗過 broadcast 邏輯)
  - 原 v1.8.39 殘留條目「Google Translate 路徑未做 dedup」屬於「功能未做」(非 spec 未寫),
    不符 PENDING_REGRESSION 定位(本檔只追「bug 已修但 spec 未寫」),直接刪掉
-->


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
