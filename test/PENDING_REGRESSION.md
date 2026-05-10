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

- **popup 累計費用 = IndexedDB usage stats(單一資料源 path 合一)**
  - 改動:拔掉 `background.js` 的 `usageStats` storage.local 累計 path(`addUsage` /
    `getUsageStats` / `resetUsageStats` / `USAGE_STATS` / `RESET_USAGE`),popup 改送
    `QUERY_USAGE_STATS` 讀 IndexedDB stats,與 options 用量明細分頁同源。
  - Bug 症狀:options 點「清除紀錄」只清 IndexedDB,popup 累計金額 path 沒被清,
    繼續顯示舊累計值。Root cause 是同一份「累計費用」事實由兩條獨立 path 維護
    必 drift(CLAUDE.md §1.1 規則 5)。
  - 為什麼進 PENDING:架構收斂消除 root cause,沒辦法用 fixture HTML 抽最小重現
    結構(要載入 popup HTML 攔 `browser.runtime.sendMessage` 驗送出 message type
    與 response 處理,工程量比一般 fixture spec 大)。短期靠 grep / static check
    禁止 `USAGE_STATS` / `RESET_USAGE` 訊息名再被加進 background.js 即可,
    但 spec 還沒寫。
  - 之後要做:寫 unit spec 對 `shinkansen/background.js` 內容做 static check,
    asserting `MESSAGE_HANDLERS` 不含 `USAGE_STATS` / `RESET_USAGE`,
    且 popup.js 送的 usage message type 是 `QUERY_USAGE_STATS`。

- **術語表抽取用量寫進 IndexedDB(`source='glossary'`)**
  - 改動:`background.js` 的 `handleExtractGlossary`(Gemini)/
    `handleExtractGlossaryCustomProvider`(OpenAI-compat)兩個 handler 結尾,
    在 `usage.inputTokens > 0 || usage.outputTokens > 0` 時組 record + 呼叫
    `usageDB.logTranslation({ ..., source: 'glossary' })`。
  - Bug 症狀:過去這兩條 path 只寫 `storage.local['usageStats']` 累計值
    (popup grand total),不進 IndexedDB,所以 options 用量明細永遠不含術語表
    費用 — 兩邊本來就 drift。前一輪「path 合一」拔掉 `usageStats` 後變成
    兩邊都漏。本輪補上 IndexedDB 寫入,讓所有 token 用量都進單一資料源。
  - 為什麼進 PENDING:跟前一條同性質(架構級寫入規範,單條 fixture 抽不出最小
    重現)。需要 unit spec mock `usageDB.logTranslation` + 模擬呼叫 handler,
    驗 `source='glossary'` record 確實被寫入。
  - 之後要做:寫 unit spec 載入 `background.js` 的 glossary handler,模擬
    `extractGlossary` / `extractGlossaryCustom` 回 `usage.inputTokens > 0`,
    asserting `usageDB.logTranslation` 被呼叫一次且 `record.source === 'glossary'`。

- **v1.8.68 同 videoId yt-navigate-finish 假性重 fire 不誤清譯文**
  - 改動:`shinkansen/content-youtube.js` 的 `yt-navigate-finish` listener 開頭加 guard
    `if (YT.active && newVideoId && newVideoId === YT.videoId) return;`
  - 為什麼進 PENDING:YouTube SPA 在 quality 切換 / ad break 結束 / player re-mount /
    theatre-fullscreen 等情境會 fire 假性 `yt-navigate-finish`,但「YouTube 何時 fire」
    沒最小重現結構(每個情境是否真的會 fire 視 YouTube 內部實作),fixture dispatchEvent
    自己 fire 只能驗「我們 guard 寫對」、不能驗「YouTube 真的會這樣 fire」。
  - 真實場景驗證來源:user 報告「字幕中文閃一下變回英文一陣子才回到中文」對應 log
    `shinkansen-log-20260509-073527.json`(seq 10 / 17 兩次 SPA navigation reset,
    一次首頁 → 影片正常,另一次需確認是否同 videoId 重 fire)。
  - 之後要做:user 下次閃到時 dump 完整 log(含 `category: youtube` 的
    `SPA navigation reset` 條目),確認確實有「same videoId reset」場景觸發,
    再寫對應 spec / 退役本條。

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
