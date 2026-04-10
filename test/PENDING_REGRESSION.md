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
