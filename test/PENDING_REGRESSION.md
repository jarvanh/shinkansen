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
