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

### code review 2026-06-09 M2 — content-drive.js rAF loop orphan 收斂 + 防重複綁定
- **症狀**(潛在):content-drive.js:411 _startRenderLoop 的 rAF loop 原本無條件遞迴永不停,orphan content script 後仍每幀 getBoundingClientRect 空轉;_listenPlayerMessages 無防重複綁定
- **修在**:`shinkansen/content-drive.js` _startRenderLoop 加 orphan 自我停止(`!chrome.runtime?.id`)+ DRIVE.renderLoopRunning 防重複啟動 guard;_listenPlayerMessages 加 DRIVE._msgListenerInstalled guard
- **為什麼還不能寫測試**:orphan context 同 M1(harness 無法重現);防重複啟動 / 綁定 guard 要測需 expose 內部 + 計 rAF 次數,收益低。既有 drive-bilingual-overlay / drive-engine-normalize spec 已驗 overlay 結構 / render 邏輯沒被破壞(本輪跑過全綠)
- **取捨(非 bug)**:不在 _autoTranslateEnabled=false 時暫停 loop——暫停後需可靠 resume 觸發,風險高於收益(Drive niche 路徑),只收斂「回不來」的 orphan
- **建議 spec 位置**:無(orphan 部分永久 path B)

### code review 2026-06-09 M4 — usage-db getDB 連線失效自我重建
- **症狀**(潛在):lib/usage-db.js getDB singleton 沒掛 onclose / onversionchange,連線被瀏覽器關閉後 _dbPromise cache 死連線 → 後續 db.transaction() 丟 InvalidStateError,usage 寫入靜默失敗到 SW 重啟
- **修在**:`shinkansen/lib/usage-db.js` req.onsuccess 掛 `db.onclose` / `db.onversionchange`,比對 `_db === db` 後 null 掉 _dbPromise 讓下次 getDB 重建
- **為什麼還不能寫測試**:專案無 IndexedDB 測試基建(無 fake-indexeddb dep,既有 usage spec 都是讀 source / 測 handler 架構,不跑真 IndexedDB)。onclose 要瀏覽器儲存壓力才觸發;onversionchange 要跨 context DB 升級,但 DB_VERSION 恆=1 production 不會升級。兩者在 harness representatively 重現需另建基建,收益低
- **建議 spec 位置**:無;若未來引入 fake-indexeddb 或 sw context IndexedDB 測試再補
- **驗證方式**:code inspection + node --check;_db===db 比對防舊連線晚到 onclose 誤殺新連線

### code review 2026-06-09 M8 — YT heuristic / on-the-fly 批次結果 res.result 防禦
- **症狀**(潛在,path drift):content-youtube.js heuristic(_runBatch)與 on-the-fly(flushOnTheFly)路徑用 `res.result[j]`,若 res.ok=true 但 res.result 缺失會 throw;非 ASR 主路徑(_injectBatchResult)早已 `res.result || []`,這兩條沒跟上(CLAUDE.md §5 單一資料源 drift)
- **修在**:`shinkansen/content-youtube.js` 兩處改 `const results = res.result || []` 再 index
- **為什麼還不能寫測試**:觸發條件是「background 回 ok=true 卻不帶 result」的契約違反,正常不會發生;要在 YT fixture 路徑產生需深層 mock safeSendMessage + 跑完整 window 翻譯流程,收益低。修法與主路徑已測的 `|| []` 同 pattern,風險近零(只在 result undefined 時改變行為——舊 code 是 throw)
- **建議 spec 位置**:無;若未來建 YT 批次路徑 mock harness 可一併補

---

## Deferred 改善項(code review 2026-06-09,待評估排程)

> 這些是 2026-06-09 全 codebase review 找出、但當輪決定**不動**的項目(架構級重構 / 低 ROI)。
> 不是 bug,功能現況正確。放這裡是為了不遺失,未來有空再評估。**不計入 release gate**。
>
> **2026-06-09 後續處理**：M9(c)、L2(a)（部分：只合 Drive Gemini+Custom）、L2(b) 已於本輪
> 完成，走路徑 A 寫了 regression spec（`test/jest-unit/alarm-dispatcher.test.cjs` /
> `drive-batch-merge.test.cjs` / `exchange-rate-and-format.test.cjs` 新增 describe）並 SANITY 驗過，
> 從本清單移除。L2(a) 的 Google / YouTube `_runAsrSubBatch` 折疊評估後風險 > 收益，**不做**
>（輸入格式 / 輸出目標 / 時間戳生成全不同）。剩 L5 待評估。

### L5 — gemini.js segment mismatch 逐段 fallback 不過 rate limiter
- lib/gemini.js translateChunk mismatch 時逐段重打 API,不經 limiter.acquire(不計入 RPM/TPM 視窗)。
- **為何 deferred**:修法需把 limiter 從 background 接進純 API 模組(架構改動);mismatch 罕見,逐段 fallback 內層已有 429 退避兜底,後果良性。
- **建議**:fallback 逐段也走 limiter,或在 background 層處理 mismatch retry。

## 已評估為「非 bug / 維持原樣」(不要再被當問題重提)

- **M7 PDF 多行末行被吞**:**誤報**。數學證明 fit 保證 `requiredH ≤ blockH+1`,drawText 的 `cy < pdfBottom - lineHeight` break 對成功 fit 的最後一行永不觸發(餘裕 = `fontSize×(visualRatio-1)+lineHeight-1 ≥ 5.5 > 0`)。break 只在 fallback overflow 情境清掉真的溢出的行——正確行為。移除 break 反而讓 fallback 譯文溢出蓋下個 block。2026-06-09 Plano/Quotation/Trimble 真翻譯 Read 譯文 PDF 均無末行遺失。
- **L1 caption scale observer**:**維持觀察 #movie_player**,不縮到 .ytp-caption-window-container。YT 在字幕 toggle / 全螢幕 / 畫質切換時銷毀重建該容器,observer 掛舊容器會漏掉重建。現有 rAF 合併 + idempotent apply 已壓住成本(且只在 scale≠100 啟動)。

<!-- iOS host app ↔ extension App Group 設定橋接（Phase 2,SPEC-PRIVATE §26.12）清空紀錄
  （2026-06-09,模擬器端到端驗收完成）:
  - 功能:host app onboarding / 設定畫面選的 API Key + 預設模型，經 App Group 共享
    UserDefaults + native messaging 拉進 extension storage，四指 tap / Alt+S / popup 翻譯用到。
  - 改在:ViewController.swift（saveSettings/getSettings）/ SafariWebExtensionHandler.swift
    （pullHostSettings）/ shinkansen/background.js（pullHostSettings + model→slot2 + seq 消費）/
    shinkansen/content-touch.js（頁面載入送 PULL_HOST_SETTINGS）。
  - 為什麼 path B（harness 抓不到）:pull 以 IS_IOS_BUILD gate（Chromium false 早退）+
    sendNativeMessage 需 Safari appex native handler + App Group 共享容器（Chromium 無對應）+
    Safari WebExtension chrome.storage 在 WebKit 不透明位置（自動讀不到 consumedSeq）。
  - ★ 清空依據:2026-06-09 Jimmy 模擬器驗收——App Group plist 確認 host 寫入（hostApiKey/
    hostModel/hostSettingsSeq=6）、擴充功能已啟用（Extensions.plist GrantedPermissions）、
    設 Gemini 模型 + sim Safari 翻譯英文頁回報「測試翻譯正常」→ 整條 host 寫 → pull → 套用 →
    翻譯生效跑通。比照 §26.6/26.7 靠「實際翻譯成功」ground truth 結案，queue 不再追蹤。
  - 已知未涵蓋（非 pending,屬上架流程）:真機 TestFlight smoke-check + profile 重簽（§26.12 ⑥）。 -->


<!-- v1.10.27 清空紀錄(2026-06-08,iPhone 實機驗收完成):
  - iOS 原生全螢幕字幕軌:gate + fullscreen 事件切換層(永久 path B)
  - 症狀:iPhone / iPad Safari 看 YouTube 一按全螢幕,翻譯字幕消失(iOS 平台限制——
    webkitEnterFullscreen 進原生播放器只搬 <video>,DOM overlay 全被蓋住)
  - 修在:shinkansen/content-youtube.js iOS FS track 模組(_refreshIosFsTrack /
    _isIOSSafari / _iosFsBeginHandler / _iosFsEndHandler)
  - 已寫的 spec(路徑 A,自動測得到那層):test/regression/youtube-ios-fullscreen-track.spec.js
    4 case + SANITY——驗 _buildIosFsTrackCues cue 組裝 + _ensureIosFsTrack 真實建軌灌 VTTCue
  - 為什麼 gate / fullscreen 事件層永遠寫不出 spec(訊號層次,CLAUDE.md 工作流原則 §3):
    1. _isIOSSafari() 在 Playwright Chromium 永遠回 false → _refreshIosFsTrack 整段
       early return,自動環境碰不到
    2. webkitbeginfullscreen / webkitendfullscreen 是 iOS 原生播放器專屬事件,Chromium
       不 fire;原生播放器把 TextTrack 渲染出來更是 iPhone 系統層,harness 完全看不到
  - ★ 清空依據:2026-06-08 Jimmy iPhone 實機(TestFlight)驗收回報「測試都正常」——
    進全螢幕字幕正常顯示中文、退出切回 DOM overlay 正常。永久 path B 那層改靠這次
    實機驗收結案,queue 不再追蹤。
  - 取捨(非 bug):全螢幕字幕外觀由 iOS「設定→輔助使用→字幕」控制,無法照搬 overlay
    的中英共用黑底樣式(iPhone 硬限制)。
  - 已知未涵蓋範圍(非本條 pending,屬功能未做):目前只鏡像 ASR(自動生成)路徑的
    displayCues;非 ASR(手動上傳字幕)路徑走 replaceSegmentEl,沒有 displayCues 來源,
    全螢幕仍會消失——待後續評估是否補(mobile YouTube 外語影片以 ASR 為大宗,MVP 先涵蓋 ASR)。
-->

<!-- v1.10.0 清空紀錄(2026-05-20):
  - B3 整條移除(使用者要求移除 MAS 上架待辦,2026-05-20)。Part 1(popup banner
    Safari 分支改直連 .pkg 下載 URL)SANITY 驗收已 2026-05-18 完成。Part 2(MAS
    build 編譯期 strip update-check 全套路徑)隨 MAS 上架追蹤一起移除——
    `lib/distribution.js` + `lib/distribution-cs.js` 兩檔仍保留在 codebase
    (`IS_MAS_BUILD = false`),safari-build.sh MAS 軌 override 機制保留;未來若
    重啟 MAS 上架追蹤,SANITY 驗收計畫紀錄見 git history `test/PENDING_REGRESSION.md`
    v1.10.0 之前版本。
-->

<!-- v1.9.28 清空紀錄(2026-05-20):
  - B4: Finding 3 X 串尾「I love your works ❤」stall **完全解了**(v1.9.27.x diagnostic
    sentinel 過程後 ship v1.9.28)。Prescan IntersectionObserver `rootMargin:1000px`
    觀察 `[data-testid="tweetText"]:not([data-shinkansen-translated])` + IO callback
    內 explicit `spaObserverSeenTexts.delete(text)` 豁免 30s TTL 黑名單。POC 純觀測
    顯示 IO fire 比 user dwell 早 3.3s。5-run cross-run consistency sy=10000 桶
    stall_pct 全 0%/0%/0%/0%/0%(baseline 累積 9 runs 全 100%)。
  - 對應 regression spec:`test/regression/spa-prescan-intersection-observer.spec.js`
    8 條 + SANITY(常數定義 / subdomain 命中 / no-op 條件 / 初始 register / MO 攔
    mount / IO callback 觸發 rescan / 100ms batch coalesce / stopSpaObserver lifecycle),
    SANITY 暫破壞 batch 合成驗 spec fail 還原 pass。
  - 並發發現修法(在 Finding 3 修復過程中浮現,非原 §25.20 規劃):
    onProgress race guard(3 處 _progressClosed)/ SPA rescan 8s Promise.race timeout /
    loading toast lazy fire(只 onProgress 真有進度才彈)。全部在 v1.9.28 同輪解。
  - 完整紀錄 SPEC-PRIVATE §25.20.10。
-->

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
