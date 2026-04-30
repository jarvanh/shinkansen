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

### v1.8.31 — 2026-04-30 — Dual mode 「跨組距離」(marginBottom 撐空間)的譯文塊空白未解
- **症狀**:Daring Fireball `<p>By John Gruber</p>` 跟下一個 `<ul>` 之間是用 `<p>` 的 `margin-bottom: 60px` 拉開(paddingBottom=0)。dual mode 下譯文塊插在 `<p>` afterend → 原文跟譯文塊之間多出 60px 空白,看起來不協調
- **來源 URL**:https://daringfireball.net/2020/03/super_wednesday(sidebar 的 byline)
- **為什麼還沒修**:v1.8.31 試過抵消 `(pb+mb)` 整體,sidebar `<ul><li><a>Archive</a></li></ul>` 結構踩雷——`<a>` 走 afterend-block-ancestor 插到 `<li>` 後面,`<li>` 自己也是 marginBottom: 12px(兄弟距離),抵消會讓譯文塊跟下一個 li 重疊。CSS 屬性層級無法區分「兄弟距離」vs「跨組距離」,需要動原段落 inline style 把 marginBottom 搬到 wrapper(風險:SPA 框架重 render 抹掉 inline style),先暫不做
- **建議解法**:`injectDual` 內 `original.style.marginBottom = '0'`(把原段落 marginBottom 暫時設 0)+ `wrapper.style.marginBottom = '${pb+mb}px'` mirror 過來;`removeDualWrappers` 內還原原段落 marginBottom。需驗證:
    1. SPA 站點(BBC / Substack)框架重 render 是否會洗掉 inline style;若會,評估 MutationObserver 重補 / 用 `!important` 等強化方案
    2. 原段落本身就有 inline `marginBottom` 的情況(用 `data-shinkansen-orig-margin-bottom` attribute 記原值)
- **建議 spec 位置**:`test/regression/inject-dual-byline-grouping.spec.js`
- **建議 fixture 結構**:
    ```html
    <p id="byline" style="margin-bottom: 60px;">By <strong>John Gruber</strong></p>
    <ul><li>Archive</li></ul>
    ```
    驗:wrapper 注入後 `<p>` 跟 wrapper 之間 gap = 0(緊貼),wrapper 跟 `<ul>` 之間 gap = 60px,`<li>` 跟下一個 `<li>` 不重疊

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
