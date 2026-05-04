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

### v1.8.42 — 2026-05-04 — non-ASR 雙語改走獨立 overlay + 字型 / 行距 / 動態 anchor
- **症狀**:non-ASR 雙語舊路徑把譯文 innerHTML `<br>` 接在原生 `.ytp-caption-segment`
  內,2 行英文字幕時譯文擠掉第二行視覺(image 7-8 系列)。修為走獨立
  `<shinkansen-yt-overlay>`,native CC 整個藏掉,中英都搬到 overlay 同一塊黑底,
  ASR 雙語也跟進統一架構。
- **修在**:shinkansen/content-youtube.js
  - `_setOverlayContent` 加 sourceText 顯示分支
  - 新增 `_updateNonAsrBilingualOverlay` + `_updateOverlayAnchor` helper
  - `_applyBilingualMode` truth table 改成「雙語都藏 native」
  - `replaceSegmentEl` / `flushOnTheFly` cache hit 雙語分流
  - `translateYouTubeSubtitles` 啟動時補一次 `_applyBilingualMode`(reload 後 captionsXHR 可能被 cache)
  - shadow DOM 改成 `.cue-block > .src + .tgt` 共享黑底
  - `_setAsrHidingMode` CSS 上推到 `.ytp-caption-window-container`
- **為什麼還不能寫測試**:
    fixture 要 mock 的 surface 太大——native YouTube `.caption-window` 動態建立
    時序、`.ytp-caption-segment` 多行 layout、`captionsXHR` 攔截路徑、ResizeObserver
    觸發點,全部影響 overlay anchor 與 srcBits 收集。最小可重現結構抽不出來
    (踩過至少 5 輪修錯方向才靠 Chrome for Claude 真實站點 probe 找到根因)。
- **真實頁面驗收**:Jimmy 在 https://www.youtube.com/watch?v=hkJUk6Lak_I
  已驗證:non-ASR 雙語兩行英文 + 完整中文同框、純中文 multi-segment dedup 不殘留英文、
  ASR 雙語也走同套 overlay 架構。
- **何時清**:抽得出 minimal fixture 模擬「.caption-window 內含 2 個 segment + captionMap
  其一 cached='' 一其 cached=trans」+「`_applyBilingualMode(true)` 後 player 加 hide
  class」+「overlay shadow .src 寫入 srcBits.join('\n')」即可寫 spec。

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
