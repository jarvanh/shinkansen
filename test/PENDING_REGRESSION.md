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

### v1.8.40 — 2026-05-04 — YouTube 字幕原文已是繁中時跳過 Gemini 翻譯
- **症狀(避免):** 使用者勾選「自動翻譯字幕」後,即使 YouTube 影片的字幕本身已是繁中(zh-Hant / zh-TW / zh-HK / zh-MO),Shinkansen 仍照送 Gemini 翻譯一次,浪費 token + 延遲顯示 + 可能譯出怪內容。
- **修在:** shinkansen/content-youtube.js
  1. `shinkansen-yt-captions` listener(line ~542)從 caption URL 抓 `lang` 參數存進 `YT.captionLang`,順便把 captionLang 加進 `XHR captions captured` log 欄位;reset `YT._skipLoggedForLang = false` 讓跨影片仍會 log skip 原因
  2. SK.YT 預設值加 `captionLang: null` 欄位(line ~243-247)+ inline 註解
  3. `translateWindowFrom`(line ~1572)入口加 `_shouldSkipBecauseAlreadyTraditionalChinese()` 判斷,命中就 return + 第一次 log `skip translate: caption already traditional chinese`(後續同影片不重複 log)
  4. SKIP_TRANSLATE_LANGS_TW set 含 4 個 BCP-47 繁中代碼:`zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO`
- **明確不在範圍**(維持送 Gemini): `zh-Hans` / `zh-CN`(簡中,讓 LLM 簡轉繁更精準)、`zh`(泛中,無從區分繁簡)、其他語言
- **為什麼還不能寫測試:** content-youtube.js 7000+ 行,字幕路徑要 mock `<video>` element + `shinkansen-yt-captions` CustomEvent + caption URL parsing + window-based translation pipeline,既有 fixture 沒這個 pattern。需要先設計「YouTube 字幕測試 fixture / mock framework」共用基礎,單條 spec 沒這層工程量會太重。
- **建議 spec 位置:** test/regression/youtube-skip-already-zh-hant.spec.js
- **建議 fixture 結構:** mock 一個含 `<video>` element 的 page + helper 用 `dispatchEvent(new CustomEvent('shinkansen-yt-captions', { detail: { url, segments } }))` 觸發 listener,url 含 `lang=zh-Hant`,驗 `translateWindowFrom` 進入後立刻 return + log 含 `skip translate: caption already traditional chinese`。
- **內容 heuristic 增強(未來)**: URL lang 偶爾不準(YouTube auto-translated tlang= 標 zh-Hant 但實際內容是 hybrid)。可選增強:抓首批 cue 的 text 算「中文字符占比 > 70%」當 fallback 判斷依據。本輪先走 URL lang only。

### v1.8.39 — 2026-05-04 — translateUnits 段落 hash dedup
- **症狀(避免):** Medium 文章 60 張圖每張 alt 都是同字串 `"Press enter or click to view image in full size"`,packBatches 把 60 段切成 3 個 batch 各 20 段重複內容。實測 batch 11 浪費整個 API call(1754 input tokens / 2.7 秒),batch 12/13 雖然本地 cache 救起來但 batch 11 仍多打。
- **修在:** shinkansen/content.js translateUnits 入口處(serialize 後、packBatches 前)做 text hash dedup,build `origIndicesByText: Map<text, origIdx[]>` + `dedupedTexts/Units/Slots`;packBatches 收 deduped 子集;runBatch + STREAMING_SEGMENT 路徑 inject 時 broadcast 到所有 dup 原始位置(用各 dup 自己的 slots,因為 slots 綁的 DOM 不同)。
- **為什麼還不能寫測試:** dedup 邏輯緊耦合在 translateUnits 內 60 行(serialize → dedup → packBatches → runBatch broadcast inject),要寫 regression spec 需要 fixture HTML(60+ 段重複文字)+ mock TRANSLATE_BATCH 回應 + 驗 broadcast 後 60 個 element 都有譯文 + 驗 log 含 `milestone:dedup_done` saved=59。中等複雜任務,需要建新 fixture + mock pattern,本輪先實機驗證(Medium 真實頁面)為主。
- **建議 spec 位置:** test/regression/translate-dedup-broadcast.spec.js
- **建議 fixture 結構:** 5 段 unique 文字 + 60 段全相同 "Press enter or click to view image in full size" 散布其中(模擬 Medium image alt 重複),驗 milestone:dedup_done saved=59,packBatches 後 batch 數比未 dedup 少,所有 65 段對應 element 都有 [data-shinkansen-translated] 屬性。
- **同類 google translate 路徑(translateUnitsGoogle)未動:** 同樣有重複內容浪費 fetch 的問題,但本輪 scope 鎖在 Gemini 路徑,Google 路徑下次回頭處理(預估改動同模式,~30 行)。

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
