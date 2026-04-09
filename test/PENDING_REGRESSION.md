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

### v0.70 — 2026-04-09 — 術語表翻譯快取 key 未含 glossary hash

- **症狀**：啟用術語表後重新翻譯文章，所有段落仍從舊快取返回（console 顯示 inputTokens: 0），術語表完全無效——人名在不同段落有不同譯名（例如 Shenfu 被分別翻成「申甫」「慎甫」「申府」）
- **來源 URL**：https://www.newyorker.com/magazine/2023/07/03/the-double-education-of-my-twins-chinese-school
- **修在**：`lib/cache.js` 的 `getBatch`/`setBatch` 新增 `keySuffix` 參數、`background.js` 的 `handleTranslate` 計算 glossary hash 後綴
- **為什麼還不能寫測試**：快取 key 邏輯依賴 `chrome.storage.local` 與 `crypto.subtle`（需要 Extension 環境或 mock）。現有 regression fixture 只測 content script 注入行為，不測快取層。需要決定是否為快取層建立獨立的 unit test 框架
- **建議 spec 位置**：test/regression/cache-glossary-keysuffix.spec.js 或 test/unit/cache.spec.js

### v0.70 — 2026-04-09 — 術語表擷取逾時（EXTRACT_GLOSSARY timeout）

- **症狀**：長文翻譯時 console 顯示「glossary failed/timeout, proceeding without — 術語表逾時」，術語表在 15 秒內未回應。可能原因包括：API 重試次數過多耗盡 timeout、rate limiter 阻塞、Structured Output schema 格式問題
- **來源 URL**：同上
- **修在**：`background.js` 的 `handleExtractGlossary` 降低 maxRetries 為 1、`lib/gemini.js` 的 `extractGlossary` 加 `resp.json()` 防呆；全程加 console.log 追蹤
- **為什麼還不能寫測試**：逾時問題涉及 Gemini API 實際回應時間與 rate limiter 狀態，無法用靜態 fixture + canned response 重現。需要用 mock fetch 或 integration test 才能驗證。目前 v0.70 修正已降低重試次數以減少逾時機率，但尚未確認根因是否為 Structured Output schema 格式問題——需要 Jimmy 用 v0.70 實測後從 service worker console 看日誌確認
- **建議 spec 位置**：test/unit/glossary-extraction.spec.js

### v0.71 — 2026-04-09 — 術語表注入位置導致佔位符 ⟦*N⟧ 洩漏到譯文

- **症狀**：啟用術語表後翻譯 Wikipedia 長文，佔位符標記 `⟦*0⟧`、`⟦*1⟧` 等出現在頁面可見文字中（例如「⟦*0⟧柔柔⟦*1⟧」「⟦*0⟧法蘭克·迪茨⟦*1⟧」），原本無術語表時佔位符都能正常被 injector 還原
- **來源 URL**：https://en.wikipedia.org/wiki/Shen_Fu（或任何含腳註的 Wikipedia 長文）
- **修在**：`lib/gemini.js` 的 `translateChunk`——將術語對照表注入從 systemInstruction 建構的第一段移到最後一段（換行規則、佔位符規則之後）
- **為什麼還不能寫測試**：根因是 LLM 注意力分配問題（大量術語稀釋佔位符規則的 attention），非確定性邏輯。可以寫 unit test 驗證 `effectiveSystem` 字串中術語表出現在佔位符規則之後（純字串順序斷言），但無法用 canned response 驗證 LLM 是否真的不再洩漏佔位符
- **建議 spec 位置**：test/unit/system-instruction-ordering.spec.js（驗證字串拼接順序）

### v0.72 — 2026-04-09 — Gemini JSON mode 導致術語表截斷（316/8192 tokens）

- **症狀**：glossary 回傳 `finishReason=MAX_TOKENS`，JSON 被截在半途（`Unterminated string in JSON at position 754`），console 顯示 `glossary returned ok but empty (no terms extracted)`，usage `out=316` 遠低於 maxOutputTokens=8192
- **來源 URL**：https://www.newyorker.com/magazine/2023/07/03/the-double-education-of-my-twins-chinese-school
- **修在**：`lib/gemini.js` 的 `extractGlossary`——移除 `responseMimeType: 'application/json'`（JSON mode 在某些模型版本下會內部截止），改為純文字輸出 + prompt 指定格式 + 解析端容錯（code fence 移除、JSON 起止定位）
- **為什麼還不能寫測試**：根因是 Gemini API 的 JSON mode 行為（外部服務），無法用靜態 fixture 重現。可寫 unit test 驗證 JSON 解析容錯邏輯（code fence 移除、bracket 定位）
- **建議 spec 位置**：test/unit/glossary-json-parsing.spec.js

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
