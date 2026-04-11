# Shinkansen — Google Gemini API Key 申請指南

> 本文件帶你從零開始取得 Gemini API Key，讓 Shinkansen 可以呼叫 Google Gemini 翻譯網頁。
> 全程大約需要 10–15 分鐘。

---

## 事前準備

你需要：

1. 一個 **Google 帳號**（Gmail 即可）
2. 一張**信用卡或金融卡**（Visa / Mastercard / JCB 皆可，用來設定帳單付款方式）
3. Chrome 瀏覽器

> **為什麼需要信用卡？** Google 的 Gemini API 有免費額度，但 Google 要求你必須先設定付款方式才能啟用 API。設定付款方式不代表會馬上扣款——只要用量在免費額度內，你不會被收費。這一步很容易被漏掉，漏掉的話 API Key 雖然拿到了，但呼叫 API 時會收到帳單相關的錯誤。

---

## 第一部分：建立 Google Cloud 專案

### 步驟 1：進入 Google Cloud Console

前往 [Google Cloud Console](https://console.cloud.google.com/)，用你的 Google 帳號登入。

如果你是第一次使用 Google Cloud，畫面會請你同意服務條款，勾選後按「同意並繼續」。

### 步驟 2：建立新專案

1. 點擊畫面最上方的專案選擇器（通常顯示「選取專案」或你上次用的專案名稱）
2. 在彈出的視窗中，點右上角的「新增專案」
3. 填寫專案名稱，例如 `Shinkansen`（名稱隨意，方便自己辨識就好）
4. 「機構」欄位留空或選預設值
5. 點「建立」

等幾秒鐘，右上角通知鈴鐺出現「建立專案 'Shinkansen'」的成功訊息後，點擊該通知切換到新專案。

---

## 第二部分：啟用 Gemini API

### 步驟 3：啟用 Generative Language API

1. 在 Google Cloud Console 最上方的搜尋列，輸入 `Generative Language API`
2. 在搜尋結果中找到「**Generative Language API**」，點進去
3. 點擊藍色的「啟用」按鈕

啟用成功後，畫面會跳轉到這個 API 的管理頁面。

> **小提醒**：API 的全名是「Generative Language API」，不是「Gemini API」——在 Cloud Console 搜尋時請用前者。

---

## 第三部分：設定帳單帳戶（加入付款方式）⚠️ 最容易漏掉的一步

> **這一步非常重要。** 很多人拿到 API Key 後直接跳過帳單設定，結果呼叫 API 時會得到 `BILLING_NOT_ENABLED` 或 `403` 錯誤。即使你只打算使用免費額度，Google 仍然要求你綁定付款方式。

### 步驟 4：建立帳單帳戶

1. 在 Cloud Console 左側選單，點「**帳單**」（Billing）
   - 如果左側選單收起來了，先點左上角的「≡」漢堡選單展開
2. 如果你從未建立過帳單帳戶，畫面會顯示「此專案沒有帳單帳戶」，點「**連結帳單帳戶**」或「**建立帳戶**」
3. 選擇國家/地區：**台灣**
4. 帳戶類型：選「**個人**」（除非你是公司用途）
5. 點「繼續」

### 步驟 5：填寫付款資訊

1. 填寫姓名與地址（中文或英文皆可）
2. **加入付款方式**：輸入你的信用卡或金融卡號碼、到期日、CVV 安全碼
3. 確認資訊後，點「**提交並啟用帳單**」

> **FAQ：會馬上被扣款嗎？**
> 不會。Google 可能會在你的卡片上產生一筆 $0.00 或極小金額（如 NT$1）的暫時性授權交易，用來驗證卡片是否有效。這不是實際扣款，通常幾天內就會消失。

### 步驟 6：將帳單帳戶連結到專案

通常在步驟 4–5 完成後，Google 會自動將帳單帳戶連結到你目前的專案。你可以驗證：

1. 回到 Cloud Console → 左側選單 →「帳單」
2. 確認畫面上顯示的是你剛才建立的帳單帳戶，且專案名稱正確
3. 如果顯示「此專案沒有帳單帳戶」，點「連結帳單帳戶」，選擇你剛建立的帳戶

---

## 第四部分：建立 API Key

### 方法 A：透過 Google AI Studio（推薦，最簡單）

1. 前往 [Google AI Studio](https://aistudio.google.com/)
2. 用同一個 Google 帳號登入
3. 點左下角的「**Get API key**」
4. 點「**Create API key**」
5. 選擇你剛才建立的專案（例如 `Shinkansen`）
6. API Key 會立刻顯示在畫面上，格式像 `AIzaSy...`（約 39 個字元）
7. **立刻複製並妥善保存**——離開這個頁面後就看不到完整的 Key 了

### 方法 B：透過 Google Cloud Console

1. 在 Cloud Console 左側選單，找到「**API 和服務**」→「**憑證**」（Credentials）
2. 點頁面上方的「**+ 建立憑證**」→「**API 金鑰**」
3. 系統會自動產生一組 API Key 並顯示在彈出視窗
4. 複製這組 Key
5. （選擇性但建議）點「**限制金鑰**」，在「API 限制」中選擇只允許「Generative Language API」，可以防止 Key 被誤用在其他服務上

> **方法 A 和方法 B 的差異**：透過 AI Studio 建立的 Key 預設就只能存取 Gemini API（比較安全）；透過 Cloud Console 建立的 Key 預設是不限制的（可存取專案中所有啟用的 API），建議手動加上限制。

---

## 第五部分：在 Shinkansen 中設定 API Key

1. 在 Chrome 網址列輸入 `chrome://extensions/`，找到 Shinkansen
2. 點「詳細資料」→ 找到「擴充功能選項」並點擊（或直接點 Shinkansen 圖示 → 齒輪圖示）
3. 在「**Gemini API Key**」欄位貼上你剛才複製的 Key
4. 點「儲存」
5. 開啟任意英文網頁，按 `Option + S`（Mac）測試翻譯是否正常運作

---

## 第六部分：費用與免費額度

### 免費額度（2026 年 4 月資訊）

Google 提供 Gemini API 的免費方案（Free Tier），以下是主要限制：

- **Gemini 2.5 Flash**：免費使用，有每分鐘請求數與每日請求數限制
- **Gemini 2.5 Flash-Lite**：免費使用，速率限制較寬鬆
- **Gemini 2.5 Pro 等進階模型**：2026 年 4 月起需要付費方案才能使用

Shinkansen 預設使用的模型可以在選項頁面中調整。一般網頁翻譯使用 Flash 系列模型就足夠了。

### 付費方案

如果超出免費額度，費用依 token 數量計算。以 Gemini 2.5 Flash 為例：每百萬輸入 token 約 $0.15–$0.30 美元，每百萬輸出 token 約 $0.60–$2.50 美元。翻譯一般長度的網頁（約 2,000–5,000 字）通常只需要幾分錢美金。

### 花費上限

2026 年 4 月起，Google 對所有付費帳單帳戶強制設定花費上限：第一級（Tier 1）帳戶每月上限 $250 美元。這是保護機制，避免意外產生天價帳單。

---

## 常見問題

### Q: 我拿到 API Key 了，但呼叫時出現 403 錯誤或 BILLING_NOT_ENABLED？
A: 你漏掉了「第三部分：設定帳單帳戶」。請回去完成步驟 4–6，確認專案已連結帳單帳戶且付款方式有效。

### Q: 我不想綁信用卡，可以只用免費額度嗎？
A: 很遺憾，即使只用免費額度，Google 仍然要求綁定付款方式。這是 Google Cloud 的通用政策。不綁卡就無法啟用帳單帳戶，API 會拒絕請求。

### Q: API Key 洩漏了怎麼辦？
A: 立刻到 [Google AI Studio](https://aistudio.google.com/) 或 Cloud Console 的「憑證」頁面，刪除被洩漏的 Key，然後重新建立一組新的。

### Q: 一個 Google 帳號可以建立多組 API Key 嗎？
A: 可以。你可以在同一個專案中建立多組 Key，也可以建立多個專案各自管理。

### Q: Google Cloud 的「免費試用 $300 美元額度」可以用在 Gemini API 嗎？
A: 不行。Google Cloud 的歡迎贈金（Welcome Credits）不適用於 AI Studio / Gemini API 的用量。你需要有一個真正的付款方式。

---

## 流程總覽（速查清單）

- [ ] 1. 登入 Google Cloud Console
- [ ] 2. 建立新專案
- [ ] 3. 啟用 Generative Language API
- [ ] 4. 建立帳單帳戶 + 加入付款方式 ⚠️
- [ ] 5. 確認帳單帳戶已連結到專案
- [ ] 6. 在 AI Studio 或 Cloud Console 建立 API Key
- [ ] 7. 在 Shinkansen 選項頁面貼上 API Key
- [ ] 8. 測試翻譯功能

---

*本文件最後更新：2026 年 4 月*
