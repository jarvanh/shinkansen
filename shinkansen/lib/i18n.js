// lib/i18n.js — Extension UI 字串 i18n(P2,v1.8.60)
//
// 設計理念:
// - 自製 dict + 綁 settings.targetLanguage 動態切換(Chrome chrome.i18n 綁 browser
//   locale 不能跟 target 連動,必須自製)
// - 三語 dict 內嵌(zh-TW source of truth、zh-CN / en 由 tools/translate-i18n-dict.js
//   產出後寫回)
// - 5 語 target(ja / ko / es / fr / de)fallback 走 en
// - IIFE 注入 window.__SK.i18n,popup / options 透過 <script src="lib/i18n.js"></script>
//   載入後從 window.__SK.i18n 取用;content scripts 直接用 SK.t 簡寫
// - 拒絕值用「{name}」placeholder,避開 ES template literal 衝突

(function (global) {
  'use strict';

  // === ZH_TW_DICT_START ===
  // zh-TW dict — source of truth,人工撰寫;改動由人(或 build script)直接編輯
  const messages_zhTW = {
    // ── popup ──────────────────────────────────────────────
    'popup.action.translate': '翻譯本頁',
    'popup.action.restore': '顯示原文',
    'popup.action.editDone': '結束編輯',
    'popup.action.editStart': '編輯譯文',
    'popup.title.updateAvailable': '有新版可下載',
    'popup.banner.welcome': '🎉 已升級至 v{version}',
    'popup.banner.welcomeBullets': '本版新增：',
    'popup.banner.welcomeDismiss': '知道了',
    'popup.banner.updateNoticeTitle': '📦 有新版可下載',
    'popup.banner.updateNoticeVersion': 'v{newVersion}（你目前是 v{currentVersion}）',
    'popup.banner.i18nFallback': 'UI shown in English · Translation works fully',
    'popup.label.displayMode': '顯示模式',
    'popup.label.modeSingle': '單語覆蓋',
    'popup.label.modeDual': '雙語對照',
    'popup.label.autoTranslate': '自動翻譯指定網站',
    'popup.label.ytSubtitle': 'YouTube 字幕翻譯',
    'popup.label.driveSubtitle': 'Drive 影片字幕翻譯',
    'popup.label.bilingual': '字幕雙語對照',
    'popup.label.glossary': '術語表一致化',
    'popup.cache.loading': '快取：讀取中⋯',
    'popup.cache.value': '快取：{count} 段 / {bytes}',
    'popup.cache.failed': '快取：讀取失敗',
    'popup.cache.unreadable': '快取：無法讀取',
    'popup.cache.clear': '清除快取',
    'popup.cache.confirm': '確定清除？',
    'popup.cache.confirmYes': '是',
    'popup.cache.confirmNo': '否',
    'popup.usage.loading': '累計費用：讀取中⋯',
    'popup.usage.value': '累計：{cost} / {tokens} tokens',
    'popup.usage.failed': '累計：讀取失敗',
    'popup.usage.unreadable': '累計：無法讀取',
    'popup.status.ready': '狀態：就緒',
    'popup.status.translating': '狀態：正在翻譯⋯',
    'popup.status.restoring': '狀態：正在還原原文⋯',
    'popup.status.cannotRun': '狀態：無法在此頁面執行，請重新整理後再試',
    'popup.status.noApiKey': '狀態：⚠ 尚未設定 API Key',
    'popup.status.editMode': '狀態：編輯模式（{count} 個區塊可編輯）',
    'popup.status.editEnded': '狀態：已結束編輯',
    'popup.status.editFailed': '狀態：無法切換編輯模式',
    'popup.status.cacheCleared': '狀態：已清除 {count} 筆快取',
    'popup.status.cacheClearFailed': '狀態：清除失敗 — {error}',
    'popup.status.subtitleToggleFailed': '狀態：無法切換字幕翻譯，請重新整理頁面',
    'popup.status.bilingualToggleFailed': '狀態：無法切換雙語對照',
    'popup.status.unknownError': '未知錯誤',
    'popup.shortcut.value': '{shortcut} 快速切換',
    'popup.shortcut.unset': '未設定快捷鍵',
    'popup.footer.options': '設定',
    'popup.footer.translateDoc': '翻譯文件（beta）',

    // ── 共用 ──────────────────────────────────────────────
    'common.errorUnknown': '未知錯誤',
    'common.untitled': '（無標題）',
    'common.unset': '未設定',
    'common.unlimited': '無限制',

    // ── toast（content scripts）─────────────────────────────
    'toast.detectGoogleDocs': '偵測到 Google Docs，正在開啟可翻譯的閱讀版⋯',
    'toast.cancelling': '正在取消翻譯⋯',
    'toast.offline': '目前處於離線狀態，無法翻譯。請確認網路連線後再試',
    'toast.alreadyInTarget': '此頁面已是{lang}，不需翻譯',
    'toast.noContent': '找不到可翻譯的內容',
    'toast.glossaryBuilding': '建立術語表⋯',
    'toast.translateProgress': '{prefix}翻譯中⋯ {done} / {total}',
    'toast.translateProgressGoogle': '{prefix}Google 翻譯中⋯ {done} / {total}',
    'toast.translateNew': '翻譯新內容⋯ {done} / {total}',
    'toast.translateNewFailed': '新內容翻譯失敗：{error}',
    'toast.cancelled': '已取消翻譯',
    'toast.partialFailed': '翻譯部分失敗：{failed} / {total} 段失敗',
    'toast.budgetWarning': '提醒：今日 API 請求次數已超過預算上限',
    'toast.translateFailed': '翻譯失敗：{error}',
    'toast.restored': '已還原原文',
    'toast.subtitleRestored': '已還原原文字幕',
    'toast.subtitleEnabled': '字幕翻譯已開啟。請開啟 YouTube 字幕（CC），翻譯將自動開始。',
    'toast.modeChanged': '顯示模式已切換為「{desc}」，請按快速鍵重新翻譯以套用',

    // ── lang 名稱（toast 動態插入「此頁面已是X」用）──────
    'lang.zh-TW': '繁體中文',
    'lang.zh-CN': '简体中文',
    'lang.en': '英文',
    'lang.ja': '日文',
    'lang.ko': '韓文',
    'lang.es': '西班牙文',
    'lang.fr': '法文',
    'lang.de': '德文',

    // ── options 共用 ─────────────────────────────────────
    'options.tab.settings': '一般設定',
    'options.tab.youtube': 'YouTube 字幕',
    'options.tab.gemini': 'Gemini',
    'options.tab.customProvider': '自訂模型',
    'options.tab.glossary': '術語表',
    'options.tab.forbidden': '禁用詞清單',
    'options.tab.usage': '用量紀錄',
    'options.tab.log': 'Debug',

    'options.title': 'Shinkansen 設定',
    'options.intro.html': '<a href="https://jimmysu0309.github.io/shinkansen/" target="_blank" rel="noopener">專案主頁</a>，功能介紹與使用說明請參考 <a href="https://github.com/jimmysu0309/shinkansen#readme" target="_blank" rel="noopener">README</a>',

    'options.action.save': '儲存設定',
    'options.action.show': '顯示',
    'options.action.hide': '隱藏',
    'options.action.test': '測試',
    'options.action.testing': '測試中⋯',
    'options.action.testingConnect': '正在連線測試⋯',
    'options.action.connectOk': '連線成功',
    'options.action.saved': '✓ 已儲存',
    'options.action.dirtyBar': '有未儲存的變更',
    'options.action.savedBar': '設定已儲存',

    // ── options banner ───────────────────────────────────
    'options.updateBanner.title': '📦 有新版可下載',
    'options.updateBanner.dismiss': '不再提示',
    'options.updateBanner.dismissTitle': '不再顯示更新提示',

    // ── options 翻譯目標語言 ─────────────────────────────
    'options.target.heading': '翻譯目標語言',
    'options.target.label': '翻譯成',
    'options.target.hint.html': '所有翻譯模式（網頁、PDF、YouTube 字幕）共用此目標語言。變更後新翻譯結果會用新語言；舊翻譯快取仍保留，可在 Popup 點「清除快取」重新翻譯。<strong>zh-CN 與 en 為新增功能，品質持續優化中</strong>',

    // ── options API Key ─────────────────────────────────
    'options.apiKey.heading': 'Gemini API Key',
    'options.apiKey.label': 'API Key',
    'options.apiKey.placeholder': '貼上您的 Gemini API Key',
    'options.apiKey.showAria': '顯示 API Key',
    'options.apiKey.hideAria': '隱藏 API Key',
    'options.apiKey.testAria': '測試 API Key',
    'options.apiKey.hint.html': '還沒有 API Key？請參考 <a href="https://github.com/jimmysu0309/shinkansen/blob/main/API-KEY-SETUP.md" target="_blank" rel="noopener">Gemini API Key 申請教學</a>（含帳單設定等容易遺漏的步驟）',

    // ── options 翻譯快速鍵 ───────────────────────────────
    'options.preset.heading': '翻譯快速鍵',
    'options.preset.intro.html': '三組可自訂的翻譯預設，對應三個快速鍵。依網頁內容選擇不同引擎或模型（例如文學性強用最強模型、一般網頁用最省錢）。已翻譯狀態下按任一快速鍵都會還原原文；翻譯中按任一快速鍵則取消翻譯。鍵位可至 <a href="#" id="open-shortcuts" class="open-shortcuts-link">chrome://extensions/shortcuts</a> 變更',
    'options.preset.firefoxWarn.html': '⚠ <strong>Firefox 使用者注意</strong>:Firefox 的 <code>Alt+S</code> 會展開「歷史」選單、<code>Alt+D</code> 會切到地址列，<code>Alt+A</code> 也常被其他擴充功能（例如 Save Page WE）攔截。Chrome 沒這個衝突，但 Firefox 環境下三組預設快捷鍵可能無法觸發翻譯。請到 <code>about:addons</code> → 設定圖示（齒輪）→「管理擴充功能快捷鍵」改成不衝突的組合（例如 <code>Ctrl+Shift+S</code>）',
    'options.preset.primary': '主要預設',
    'options.preset.slot2': '預設 2',
    'options.preset.slot3': '預設 3',
    'options.preset.label': '標籤',
    'options.preset.engine': '翻譯引擎',
    'options.preset.engineGemini': 'Gemini（AI 翻譯）',
    'options.preset.engineGoogle': 'Google Translate（免費機器翻譯）',
    'options.preset.engineCustom': '自訂模型',
    'options.preset.modelGemini': 'Gemini 模型',
    'options.preset.unset': '—',

    // ── options 工具列按鈕對應 ───────────────────────────
    'options.popupBtn.heading': '工具列「翻譯本頁」按鈕',
    'options.popupBtn.intro': '點擊瀏覽器工具列上的 Shinkansen 圖示後，跳出視窗中「翻譯本頁」按鈕要使用哪一組設定（與翻譯快速鍵共用三組預設）',
    'options.popupBtn.label': '對應的翻譯預設',

    // ── options 網域規則 ─────────────────────────────────
    'options.domain.heading': '網域規則',
    'options.domain.whitelistLabel': '自動翻譯網站（每行一個網域，進入時自動翻譯）',
    'options.domain.autoTranslateSlotLabel': '自動翻譯使用的預設',
    'options.domain.autoTranslateSlotHint': '進入白名單網域時走哪一組預設（等同自動按下對應的快速鍵）。預設「主要預設」與 v1.6.12 之前的行為一致',

    // ── options 語言偵測 ─────────────────────────────────
    'options.langDetect.heading': '語言偵測',
    'options.langDetect.skipTraditional': '跳過繁體中文網頁',
    'options.langDetect.skipTraditionalHint': '開啟時，若整頁文字以繁體中文為主，按翻譯會直接跳過。關閉後仍會逐段跳過中文段落，只翻譯外語內容。Gmail 等介面為中文但信件多為英文的網站，建議關閉此選項',

    // ── options 雙語對照視覺標記 ────────────────────────
    'options.dualMark.heading': '雙語對照視覺標記',
    'options.dualMark.intro': '當顯示模式設為「雙語對照」時，譯文會以新段落形式 append 在原文之後。以下選項決定譯文段落的視覺標記樣式（顯示模式本身可在 popup 切換）。v1.8.31 起，Shinkansen 會自動偵測網頁實際背景亮度套用對應配色，亮色與深色頁面各自呈現如下',
    'options.dualMark.demoLight': '亮色頁面',
    'options.dualMark.demoDark': '深色頁面',
    'options.dualMark.demoOriginal': 'The quick brown fox jumps over the lazy dog.',
    'options.dualMark.demoTranslation': '敏捷的棕狐跨越懶狗',
    'options.dualMark.tint': '淡底色',
    'options.dualMark.bar': '左邊細條',
    'options.dualMark.dashed': '波浪底線',
    'options.dualMark.none': '無標記',
    'options.dualMark.accent': '強調色',
    'options.dualMark.accentAuto': '預設（各 mark 原色）',
    'options.dualMark.accentBlue': '藍',
    'options.dualMark.accentGreen': '綠',
    'options.dualMark.accentYellow': '黃',
    'options.dualMark.accentOrange': '橘',
    'options.dualMark.accentRed': '紅',
    'options.dualMark.accentPurple': '紫',
    'options.dualMark.accentPink': '粉',
    'options.dualMark.accentCustom': '自訂',
    'options.dualMark.hint': '深色頁面預設灰色看不清時，可選一個強調色；三種視覺標記會共用同一色（tint 套淡底，bar / dashed 套實線色）',

    // ── options 翻譯進度通知 ─────────────────────────────
    'options.toast.heading': '翻譯進度通知',
    'options.toast.show': '顯示翻譯進度通知',
    'options.toast.showHint': '關閉後將完全不顯示翻譯期間的進度通知（包含成功 / 失敗訊息也不顯示）',
    'options.toast.position': '顯示位置',
    'options.toast.posBR': '右下角',
    'options.toast.posBL': '左下角',
    'options.toast.posTR': '右上角',
    'options.toast.posTL': '左上角',
    'options.toast.opacity': '通知透明度 {value}%',
    'options.toast.opacityHint': '如果覺得太搶眼，可以往左拉降低不透明度，讓通知變淡一點',
    'options.toast.autoHide': '翻譯完成後自動關閉通知',
    'options.toast.autoHideHint': '開啟時翻譯完成的通知會在 5 秒後自動消失；關閉時需手動點擊關閉',

    // ── options 金額顯示幣值 ─────────────────────────────
    'options.currency.heading': '金額顯示幣值',
    'options.currency.intro': '影響翻譯完成通知、popup 累計、用量明細分頁的金額顯示。內部計價仍以美金為基準，只在顯示時換算',
    'options.currency.usd': 'USD（美金）',
    'options.currency.twd': 'TWD（台幣）',
    'options.currency.rateLoading': '目前匯率讀取中⋯',
    'options.currency.rateOk': '目前匯率：1 USD = {rate} TWD ・ {ymd} {hm} 更新自 open.er-api.com',
    'options.currency.rateFallback': '目前匯率：1 USD = {rate} TWD（fallback，尚未抓到 open.er-api.com 資料）',
    'options.currency.rateFailed': '匯率讀取失敗，使用 fallback NT$ 31.6',
    'options.currency.refresh': '重新抓取匯率',
    'options.currency.refreshing': '抓取中⋯',
    'options.currency.refreshFailed': '匯率抓取失敗（{error}），沿用現有 {rate}',
    'options.currency.refreshFailedShort': '匯率抓取失敗：{error}',

    // ── options 匯入 / 匯出 ─────────────────────────────
    'options.io.heading': '匯入 / 匯出設定',
    'options.io.intro': '匯出為 JSON 檔案備份，或從檔案匯入還原（API Key 不包含在匯出入範圍）',
    'options.io.export': '匯出設定',
    'options.io.import': '匯入設定',
    'options.io.importNoFields': '匯入失敗：檔案中沒有任何有效的設定欄位',
    'options.io.importPartial': '匯入完成，但部分欄位被略過：\n\n{warnings}',
    'options.io.importOk': '匯入成功',
    'options.io.importFooter': '\n\n（API Key 不在匯入範圍，請自行輸入）',
    'options.io.importFailed': '匯入失敗：{error}',

    // ── options 回復預設 ─────────────────────────────────
    'options.reset.heading': '回復預設設定',
    'options.reset.intro.html': '將所有設定（模型、參數、計價、網域規則、系統提示等）還原為預設值。<strong>API Key 會被保留</strong>，不需要重填。翻譯快取與累計使用統計也不會受影響（請分別在 Popup 點「清除快取」與「重置統計」處理）',
    'options.reset.button': '回復預設設定',
    'options.reset.confirm': '確定要回復所有預設設定嗎？\n\nAPI Key 會被保留，翻譯快取與累計使用統計不受影響。\n此操作無法復原。',
    'options.reset.done': '✓ 已回復預設設定',

    // ── options 授權 ────────────────────────────────────
    'options.license.heading': '授權資訊',
    'options.license.line1.html': 'Shinkansen 採用 <strong>Elastic License 2.0 (ELv2)</strong> 授權',
    'options.license.line2.html': '你可以自由查看原始碼、學習、修改、自己使用，但<strong>不能把 Shinkansen（或改寫版本）包成服務拿去賣</strong>',
    'options.license.line3.html': '完整條款請見擴充功能目錄內的 LICENSE 檔案，或參閱 <a href="https://www.elastic.co/licensing/elastic-license" target="_blank" rel="noopener">Elastic License 2.0 官方全文</a>',
    'options.license.line4.html': '作者：Jimmy Su ・ Twitter (X):<a href="https://x.com/jimmy_su" target="_blank" rel="noopener">@jimmy_su</a>',

    // ── options Gemini 分頁 ─────────────────────────────
    'options.gemini.pricing.heading': '模型計價',
    'options.gemini.pricing.intro.html': 'Shinkansen 內建已知 Gemini 模型的標準層級單價（<strong id="pricing-calibrated-date">2026-04</strong> 校準），用於計算翻譯成本顯示在翻譯完成通知與「用量紀錄」分頁。Google 改價時可在下方覆蓋對應模型，空白表示用內建價。詳細費率見 <a href="https://ai.google.dev/pricing" target="_blank" rel="noopener">Gemini 官方定價頁</a>',
    'options.gemini.pricing.priority': 'Preset 翻譯的計價優先順序：覆蓋值 → 內建表 → 下方「後備路徑單價」。單位皆為「每 1M tokens 的美金價格」',
    'options.gemini.pricing.flashLite.builtin': '內建 $0.10 / $0.30',
    'options.gemini.pricing.flash.builtin': '內建 $0.50 / $3.00',
    'options.gemini.pricing.pro.builtin': '內建 $2.00 / $12.00',
    'options.gemini.pricing.flashLiteAria': 'Flash Lite {field} 覆蓋',
    'options.gemini.pricing.flashAria': 'Flash {field} 覆蓋',
    'options.gemini.pricing.proAria': 'Pro {field} 覆蓋',
    'options.gemini.pricing.fieldInput': 'input',
    'options.gemini.pricing.fieldOutput': 'output',

    'options.gemini.partial.heading': '節省模式',
    'options.gemini.partial.toggle': '只翻文章開頭',
    'options.gemini.partial.maxLabel': '翻譯段落數上限',
    'options.gemini.partial.hint': '啟用後只翻譯頁面前 N 段（按 DOM 順序，不排序）。適合先快速預覽再決定是否繼續讀完整文章，可大幅減少 token 用量。翻譯完成後右下角提示會出現「翻譯剩餘段落」按鈕，點按即可繼續翻完整篇——前面已翻好的段落會從本地快取載入，不重複收費。預設 25 段，範圍 5-50',

    'options.gemini.params.heading': '模型參數微調',
    'options.gemini.params.tempLabel': 'Temperature',
    'options.gemini.params.tempHint': '控制回覆的隨機程度。數字越低翻譯越穩定一致，越高則越有創意但可能偏離原意，範圍 0–2，預設 1.0（Gemini 3 Flash 原廠預設值）',
    'options.gemini.params.advSummary': '進階設定（Service Tier、Top P、Top K、Max Output Tokens）',
    'options.gemini.params.tierLabel': '服務層級（Service Tier）— 影響費用與延遲',
    'options.gemini.params.tierDefault': '預設（不指定，安全相容）',
    'options.gemini.params.tierFlex': 'Flex（省 50%，但翻譯速度會明顯變慢）',
    'options.gemini.params.tierStandard': 'Standard（原價）',
    'options.gemini.params.tierPriority': 'Priority（優先，更貴）',
    'options.gemini.params.tierHint': '注意：Service Tier 僅較新模型支援（如 gemini-3-flash-preview），舊模型請用「預設」避免錯誤',
    'options.gemini.params.topPHint': '限制模型從機率最高的幾個候選詞中挑選。數字越低結果越集中，越高則用詞越多樣，範圍 0–1，預設 0.95',
    'options.gemini.params.topKHint': '限制每次選詞時最多考慮幾個候選詞。數字越小越精準，越大越多樣，範圍 1–100，預設 40(Gemini 3 Flash 原廠預設值，Pro 系列為 64)',
    'options.gemini.params.maxOutHint': 'Gemini 每次回覆的最大 token 數量。數字越大，單批能翻譯的內容越多，但也會消耗更多費用，上限 65,535，預設 8,192，一般不需要調整',
    'options.gemini.params.systemPromptLabel': '翻譯 Prompt',
    'options.gemini.params.targetMismatch.html': '⚠ 你已客製化此 prompt；切換目標語言<strong>不會自動覆蓋</strong>你的版本。要套用新目標語言預設，請清空欄位儲存（系統會自動走對應預設），或點下方「重置」按鈕',

    'options.gemini.perf.summary': '效能調校（進階）— 批次大小、並行數量、單頁段落上限',
    'options.gemini.perf.intro': '調整每批翻譯的大小與並行數量，影響翻譯速度與品質的平衡。一般使用者不需要動，維持預設即可',
    'options.gemini.perf.maxConcurrentLabel': '同時並發批次上限',
    'options.gemini.perf.maxConcurrentHint': '同時送出幾批翻譯請求。數字越大翻越快，但也越容易撞到配額上限，長文建議 5–10，短文可設 1（逐批翻譯）',
    'options.gemini.perf.maxUnitsLabel': '每批段數上限',
    'options.gemini.perf.maxUnitsHint': '每一批最多包含幾段。這裡的「段」是指網頁上一個獨立的文字區塊（例如一個段落、一個標題、一個列表項目），由網頁結構自動偵測。數字越大每批翻越多，但太大容易導致翻譯對齊失準，預設 20',
    'options.gemini.perf.maxCharsLabel': '每批字元預算',
    'options.gemini.perf.maxCharsHint': '每一批累積的原文字元數上限（與段數上限先到先封口）。數字越大每批能裝越多內容，但太大可能超出模型輸出長度限制，預設 3500',
    'options.gemini.perf.maxTransLabel': '單頁翻譯段落上限',
    'options.gemini.perf.maxTransHint': '單次翻譯最多處理幾段。超大頁面（如維基百科長條目）超過此上限時，多餘段落會被略過。設為 0 表示不限制，預設 1000',

    'options.gemini.quota.summary': 'API 配額管理（進階）— Gemini API 層級、自訂上限、失敗重試',
    'options.gemini.quota.intro': 'Shinkansen 會在背景幫你管理 Gemini API 用量。大頁面翻譯時會把請求平均攤開避免 burst 觸發 Google 限速；快超過每日上限時提早警告，不會等到失敗才知道。多數情況維持預設即可',
    'options.gemini.quota.tierLabel': 'Gemini API 層級',
    'options.gemini.quota.tierFree': 'Free（免費）',
    'options.gemini.quota.tier1': 'Tier 1（付費，已啟用 billing）',
    'options.gemini.quota.tier2': 'Tier 2（累積消費 $250+，首次付款 30 天後）',
    'options.gemini.quota.tierCustom': '自訂（手動填入下方數值）',
    'options.gemini.quota.tierHint.html': '不確定自己是哪一層？到 <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noopener">Gemini API Rate Limit</a> 查詢。剛申請 API key 沒啟用付費 = Free。層級切換時下方三個數字自動更新，只有把 Tier 選為「自訂」才需要手動填',
    'options.gemini.quota.rpmLabel': 'RPM（每分鐘請求數）',
    'options.gemini.quota.tpmLabel': 'TPM（每分鐘 token 數）',
    'options.gemini.quota.rpdLabel': 'RPD（每日請求數）',
    'options.gemini.quota.retriesLabel': '失敗重試次數',
    'options.gemini.quota.retriesHint': '單批翻譯遇到 API 錯誤（如 429 配額限制）時的最大重試次數，設為 0 表示不重試、失敗即跳過，預設 3 次',

    'options.gemini.resetAll': '重設所有參數',
    'options.gemini.resetAllTitle': '把本分頁所有欄位重設為預設值（按下後仍需點「儲存設定」才會生效）',
    'options.gemini.resetAllConfirm': '確定要把 Gemini 分頁所有參數重設為預設值嗎？\n\n影響欄位：Service Tier、模型計價覆蓋（清空走內建表）、Tier/RPM/TPM/RPD、安全邊際、重試次數、Temperature、Top P、Top K、Max Output Tokens、翻譯 Prompt、並發批次、每批段數/字元/段落上限。\n\n按下後仍需點「儲存設定」才會生效。',
    'options.gemini.resetAllDone': '欄位已重設，請按「儲存設定」生效',

    // ── options 術語表分頁 ───────────────────────────────
    'options.glossary.fixed.heading': '固定術語表',
    'options.glossary.fixed.intro': '手動指定「原文 → 譯文」對照。每次翻譯時會注入 Gemini 的 system prompt，強制模型遵守你指定的譯法。固定術語的優先級高於自動擷取的術語',
    'options.glossary.fixed.globalTitle': '全域（所有網站共用）',
    'options.glossary.fixed.colSource': '原文',
    'options.glossary.fixed.colTarget': '譯文',
    'options.glossary.fixed.addRow': '＋ 新增一列',
    'options.glossary.fixed.domainTitle': '網域專用（覆蓋全域同名術語）',
    'options.glossary.fixed.domainSelectPlaceholder': '選擇網域⋯',
    'options.glossary.fixed.domainInputPlaceholder': '或輸入新網域，例如 medium.com',
    'options.glossary.fixed.domainAdd': '新增網域',
    'options.glossary.fixed.domainDelete': '刪除此網域',
    'options.glossary.fixed.domainDeleteConfirm': '確定要刪除「{domain}」的網域術語表嗎？',
    'options.glossary.fixed.placeholderSource': '英文原文',
    'options.glossary.fixed.placeholderTarget': '中文譯文',
    'options.glossary.fixed.deleteRow': '刪除',

    'options.glossary.auto.heading': '自動術語擷取',
    'options.glossary.auto.intro.html': '長文翻譯時，先呼叫 Gemini 擷取全文專有名詞建立對照表，確保分批翻譯的名詞譯名一致。短文（1 批以內）自動跳過。預設不開啟——開啟後術語翻譯會跳過 system prompt 的部分指示（例如「英文人名保留不翻」會失效）。詳細說明見 <a href="https://github.com/jimmysu0309/shinkansen#術語表一致化" target="_blank" rel="noopener">README</a>',
    'options.glossary.auto.toggle': '啟用自動術語擷取',
    'options.glossary.auto.modelLabel': '術語擷取模型',
    'options.glossary.auto.modelLite': 'Gemini 3.1 Flash Lite（預設，快又便宜）',
    'options.glossary.auto.modelFlash': 'Gemini 3 Flash（較慢但語意理解較強）',
    'options.glossary.auto.modelPro': 'Gemini 3.1 Pro（最強，較貴）',
    'options.glossary.auto.modelSame': '與主翻譯模型相同',
    'options.glossary.auto.modelHint': '術語擷取是任務簡單的單次請求，Flash Lite 通常已夠用，且比 Flash 快 1.5-3 倍、便宜 5 倍',
    'options.glossary.auto.advSummary': '進階設定（阻塞門檻、Temperature、逾時時間、術語擷取 Prompt）',
    'options.glossary.auto.blockingLabel': '阻塞門檻（批次數）',
    'options.glossary.auto.blockingHint': '頁面切批 > 此值才「先等術語表再翻譯」(blocking),≤ 此值則術語表跟翻譯並行（fire-and-forget，不阻塞首字）。預設 10——中等長度頁面省 1.5-7 秒首字延遲，但 batch 0 翻的部分可能跟後段術語不一致。設 0 = 全部走 fire-and-forget（永不阻塞）；設極大值（如 50）= 幾乎都阻塞（舊行為）',
    'options.glossary.auto.tempLabel': '術語表 Temperature',
    'options.glossary.auto.tempHint': '控制術語擷取的穩定度，越低越穩定。預設 0.1，一般不需調整',
    'options.glossary.auto.timeoutLabel': '逾時時間（毫秒）',
    'options.glossary.auto.timeoutHint': '長文等待術語表的最長時間。超過則放棄術語表直接翻譯，預設 60000（60 秒）',
    'options.glossary.auto.promptLabel': '術語擷取 Prompt',
    'options.glossary.auto.promptHint': '控制 Gemini 擷取哪些類型的專有名詞。進階使用者可自行調整',
    'options.glossary.auto.targetMismatch.html': '⚠ 你已客製化此 prompt；切換目標語言<strong>不會自動覆蓋</strong>你的版本。要套用新目標語言預設，請清空欄位儲存（系統會自動走對應預設）',

    // ── options 自訂模型分頁 ─────────────────────────────
    'options.cp.heading': '自訂 OpenAI 相容模型',
    'options.cp.intro1': '想用 Gemini 之外的模型？設定一組 OpenAI 相容端點即可接 OpenRouter（含 Anthropic / Gemini / DeepSeek / Llama / Qwen / Grok 等百種模型）、Ollama 本機、Together、Groq、Fireworks、OpenAI 自家等',
    'options.cp.intro2': '設定完成後，到「一般設定」分頁的「翻譯快速鍵」，把任一組預設引擎改為「自訂模型」，即可使用快速鍵啟動翻譯',
    'options.cp.baseUrlLabel': 'Base URL',
    'options.cp.baseUrlPlaceholder': '例如：https://openrouter.ai/api/v1',
    'options.cp.baseUrlHint.html': 'OpenAI 相容模型端點的根目錄。系統會自動接 <code>/chat/completions</code>。常見：<code>https://openrouter.ai/api/v1</code>、<code>https://api.together.xyz/v1</code>、<code>http://localhost:11434/v1</code>(Ollama)',
    'options.cp.firefoxHttpsWarn.html': '⚠ <strong>Firefox 使用者注意</strong>:Firefox 的 HTTPS-Only Mode 會把 <code>http://</code> 請求強制升級成 <code>https://</code>，導致連本機 server 失敗。請到 <code>about:preferences#privacy</code> 滑到「HTTPS-Only Mode」改為「Don\'t enable」，或對該網址加入例外',
    'options.cp.cors.summary': '連本機 Ollama / llama.cpp 收到 403?（展開查看解法）',
    'options.cp.cors.line1.html': 'Chrome 從擴充功能呼叫本機後端（<code>localhost</code> / <code>127.0.0.1</code>）時，會強制送 <code>Origin: chrome-extension://&lt;id&gt;</code> header。Ollama 與 llama.cpp 預設的 CORS 設定不認得這個 origin → 直接回 403',
    'options.cp.cors.line2.html': '<strong>兩種解法擇一</strong>:',
    'options.cp.cors.solution1.html': '<strong>Ollama</strong>：啟動前設環境變數 <code>OLLAMA_ORIGINS=*</code>（或更嚴格的 <code>chrome-extension://*</code>）。macOS 用 <code>launchctl setenv OLLAMA_ORIGINS "*"</code> 後重啟 Ollama;Windows 在「系統內容 → 環境變數」加 <code>OLLAMA_ORIGINS</code> = <code>*</code>',
    'options.cp.cors.solution2.html': '<strong>後端不能改 CORS 設定時</strong>：在系統 hosts 檔加一筆 <code>127.0.0.1 ollama.local</code>,Base URL 改成 <code>http://ollama.local:11434/v1</code>。Chrome 看到的不是 loopback 地址就不會強制送 Origin',
    'options.cp.modelLabel': '模型 ID',
    'options.cp.modelPlaceholder': '例如：anthropic/claude-sonnet-4-5（llama.cpp / Ollama 可留空）',
    'options.cp.modelHint.html': 'OpenRouter 的 model ID 格式為 <code>provider/model</code>（如 <code>anthropic/claude-sonnet-4-5</code>、<code>google/gemini-3-flash</code>、<code>deepseek/deepseek-chat</code>）；其他端點直接填 model 名稱。本機 server（llama.cpp / Ollama）啟動時若已鎖定 model 可留空，request 不送此欄位即用 server 預設',
    'options.cp.apiKeyLabel': 'API Key',
    'options.cp.apiKeyPlaceholder': '貼上對應 provider 的 API Key（本機 llama.cpp / Ollama 等可留空）',
    'options.cp.apiKeyHint': '僅存在你的瀏覽器本機（與 Gemini API Key 同樣不跨裝置同步、不上傳任何伺服器）；本機後端（llama.cpp / Ollama 等）可留空',
    'options.cp.systemPromptLabel': '翻譯 Prompt',
    'options.cp.systemPromptPlaceholder': '留空使用內建簡短預設 prompt',
    'options.cp.systemPromptHint': '自訂模型用獨立的翻譯 prompt（不繼承 Gemini 分頁的設定）；但「固定術語表」與「禁用詞清單」會自動共用注入到 prompt 末端',
    'options.cp.resetPrompt': '重置為預設 Prompt（與 Gemini 同）',
    'options.cp.tempLabel': 'Temperature',
    'options.cp.advSummary': '進階：思考強度 / 段序號 / 自訂 body',
    'options.cp.thinkingLabel': '思考強度',
    'options.cp.thinkingAuto': '自動（用 provider 預設）',
    'options.cp.thinkingOff': '關閉',
    'options.cp.thinkingLow': '低',
    'options.cp.thinkingMid': '中',
    'options.cp.thinkingHigh': '高',
    'options.cp.thinkingHint.html': '依 baseUrl 與模型自動翻譯成對應 provider 的 thinking API(OpenRouter <code>reasoning.effort</code>、DeepSeek <code>extra_body.thinking</code>、Claude <code>thinking.type</code>、OpenAI o-series <code>reasoning_effort</code>、Grok <code>reasoning_effort</code>、Qwen <code>extra_body.enable_thinking</code>)。翻譯任務 thinking 通常無感但會多花 token；建議「關閉」省成本，除非你的模型只能在 thinking 開啟時翻譯（如 DeepSeek-R1 / QwQ）。不認識的 provider 走「自動」',
    'options.cp.strongMarker': '強化段序號標記（適合本機量化模型）',
    'options.cp.strongMarkerHint.html': '本機量化模型（如 gemma-4 量化版）會把預設的「<code>«1»</code> <code>«2»</code>」段序號誤譯為「N1、N2」洩漏到譯文。開啟後改用 <code>&lt;&lt;&lt;SHINKANSEN_SEG-N&gt;&gt;&gt;</code> 格式，弱模型不會誤翻；代價是每段批次多約 7 tokens（input + output 雙倍開銷）。商用 API（OpenRouter / DeepSeek / Groq 等）不需此選項，但開啟也無害',
    'options.cp.extraBodyLabel': '自訂 request body 額外參數（JSON，覆蓋上方思考強度）',
    'options.cp.extraBodyHint.html': '內容會深層 merge 進 chat.completions request body，可用來：（1）強制覆蓋上方「思考強度」自動產生的設定；（2）加 provider 專屬參數（例如 OpenRouter 的 <code>top_k</code> / <code>min_p</code>、Anthropic 的 <code>metadata</code>）。格式錯誤會在 Debug 分頁 log 一條 warn 並忽略，翻譯不會中斷',

    'options.cp.pricing.heading': '模型計價（USD）',
    'options.cp.pricing.intro.html': '請填入 input / output 單價，系統會用來估算翻譯費用顯示在翻譯完成通知與「用量紀錄」分頁。填 <strong>0</strong> 代表不顯示費用（token 數仍會記錄）',
    'options.cp.pricing.inputLabel': 'Input tokens 單價（USD / 1M tokens）',
    'options.cp.pricing.outputLabel': 'Output tokens 單價（USD / 1M tokens）',

    'options.cp.modelDisplayUnset': '（未設定）',
    'options.cp.targetMismatch.html': '⚠ 你已客製化此 prompt；切換目標語言<strong>不會自動覆蓋</strong>你的版本。要套用新目標語言預設，請清空欄位儲存（系統會自動走對應預設），或點下方「重置」按鈕',

    // ── options 禁用詞清單分頁 ───────────────────────────
    'options.forbidden.heading': '禁用詞清單',
    'options.forbidden.intro': '針對 AI 模型容易漏網的禁用辭彙自訂禁用對照表。內容會以高顯著性區塊注入 Gemini 的 system prompt 末端，明確要求譯文不可使用左欄詞彙、必須改用右欄。修改清單後會自動讓既有翻譯快取分區，不再命中舊譯文',
    'options.forbidden.colWord': '禁用詞',
    'options.forbidden.colReplacement': '替換詞',
    'options.forbidden.colNote': '備註',
    'options.forbidden.add': '＋ 新增一條',
    'options.forbidden.reset': '還原預設清單',
    'options.forbidden.resetConfirm': '確定要還原預設禁用詞清單嗎？目前的自訂內容會被覆蓋。',
    'options.forbidden.placeholderForbidden': '禁用詞（簡中）',
    'options.forbidden.placeholderReplacement': '替換詞（台灣）',
    'options.forbidden.placeholderNote': '（可選）',

    // ── options 用量紀錄分頁 ─────────────────────────────
    'options.usage.intro.html': '以下為 Shinkansen 根據模型計價設定估算的用量，僅供參考。實際帳單金額請至 <a href="https://aistudio.google.com/spend" target="_blank" rel="noopener">Gemini API Spend</a> 查詢',
    'options.usage.from': '從',
    'options.usage.to': '到',
    'options.usage.toNow': '現在時間',
    'options.usage.toNowTitle': '把「到」設為現在時間',
    'options.usage.fromHourAria': '從 — 小時',
    'options.usage.fromMinAria': '從 — 分鐘',
    'options.usage.toHourAria': '到 — 小時',
    'options.usage.toMinAria': '到 — 分鐘',
    'options.usage.granDay': '日',
    'options.usage.granWeek': '週',
    'options.usage.granMonth': '月',
    'options.usage.searchPlaceholder': '搜尋標題、網址或網域⋯',
    'options.usage.modelAll': '全部模型',
    'options.usage.totalCostLabel': '累計費用',
    'options.usage.totalCostLabelCurrency': '累計費用（{currency}）',
    'options.usage.totalTokensLabel': '計費 Tokens',
    'options.usage.totalCountLabel': '翻譯次數',
    'options.usage.topModelLabel': '最常用模型',
    'options.usage.colTime': '時間',
    'options.usage.colSite': '網站',
    'options.usage.colModel': '模型',
    'options.usage.colTokens': 'Tokens',
    'options.usage.colCost': '費用',
    'options.usage.empty': '此期間沒有翻譯紀錄',
    'options.usage.paginationAria': '用量明細分頁',
    'options.usage.pagePrev': '上一頁',
    'options.usage.pageNext': '下一頁',
    'options.usage.pageInfo': '第 {page} / {total} 頁（{count} 筆）',
    'options.usage.reload': '重新載入',
    'options.usage.reloadTitle': '重新從背景讀取最新用量紀錄（不需關閉設定頁）',
    'options.usage.exportCsv': '匯出 CSV',
    'options.usage.clear': '清除紀錄',
    'options.usage.clearConfirm': '確定要清除所有翻譯用量紀錄嗎？\n此操作無法復原。',
    'options.usage.clearFailed': '清除失敗：{error}',
    'options.usage.exportFailed': '匯出失敗：{error}',
    'options.usage.costTwd': '費用（TWD）',
    'options.usage.costUsd': '費用（USD）',
    'options.usage.costTwdRow': '費用： NT$ {value}',
    'options.usage.costUsdRow': '費用： {value}',
    'options.usage.periodTotal': '期間合計：{tokens} tokens / {cost}',

    // ── options Debug 分頁 ───────────────────────────────
    'options.log.youtube.heading': 'YouTube 字幕',
    'options.log.youtube.debugToast': '顯示字幕翻譯即時狀態面板',
    'options.log.youtube.debugToastHint.html': '開啟後，字幕翻譯啟動時頁面左上角會出現一個即時狀態面板，顯示 buffer、batch API 耗時、captionMap 大小等診斷資訊。各欄位含意詳見 <a href="https://github.com/jimmysu0309/shinkansen/blob/main/DEBUG-BOARD.md" target="_blank" rel="noopener">DEBUG-BOARD.md</a>',
    'options.log.youtube.onTheFly': '啟用 On-the-fly 備援翻譯',
    'options.log.youtube.onTheFlyHint': '開啟後，當字幕出現時若尚未預翻（captionMap 未命中），會即時送 API 翻譯。使用較慢的模型（如 Flash Lite）時建議關閉，避免即時翻譯請求阻塞預翻進度。預設關閉',
    'options.log.heading': 'Log 記錄',
    'options.log.catAll': '全部分類',
    'options.log.catTranslate': '翻譯流程',
    'options.log.catApi': 'Gemini API',
    'options.log.catCache': '快取',
    'options.log.catRateLimit': 'Rate Limiter',
    'options.log.catGlossary': '術語表',
    'options.log.catSpa': 'SPA',
    'options.log.catSystem': '系統',
    'options.log.catYoutube': 'YouTube 字幕',
    'options.log.catDrive': 'Drive 字幕',
    'options.log.catGuard': 'Content Guard',
    'options.log.catYoutubeDebug': 'YouTube 除錯',
    'options.log.lvlAll': '全部等級',
    'options.log.searchPlaceholder': '搜尋 Log（含批次內容）⋯',
    'options.log.clear': '清除',
    'options.log.export': '匯出 JSON',
    'options.log.autoscroll': '自動捲動',
    'options.log.colTime': '時間',
    'options.log.colCat': '分類',
    'options.log.colLvl': '等級',
    'options.log.colMsg': '訊息',
    'options.log.empty': '尚無 Log。翻譯一個頁面後，Log 會自動出現在這裡',
    'options.log.emptyFiltered': '沒有符合篩選條件的 Log',
    'options.log.count': '{count} 筆',
    'options.log.filteredCount': '（篩選後 {count} 筆）',
    'options.log.devtools': '同時將 Log 輸出到 DevTools Console（進階開發者用）',
    'options.log.detailExpand': '收合',
    'options.log.detailCollapse': '{…}',

    // ── options YouTube 字幕分頁 ─────────────────────────
    'options.yt.auto.heading': '自動翻譯',
    'options.yt.auto.toggle': '偵測到 YouTube 影片時自動翻譯字幕',
    'options.yt.auto.hint': '開啟後進入 YouTube 影片頁面時，會自動開始翻譯字幕，不需手動在 Popup 開啟開關',
    'options.yt.asr.heading': '自動產生字幕分句模式',
    'options.yt.asr.intro.html': '僅影響 YouTube <strong>自動產生</strong>的字幕，人工字幕不受此設定影響',
    'options.yt.asr.toggle': 'AI 分句模式',
    'options.yt.asr.hint.html': '<strong>開啟</strong>：使用 AI 分句，提升字幕品質，些微提升 token 耗費<br><strong>關閉</strong>：使用 YouTube 自動產生字幕的原始分句邏輯',
    'options.yt.engine.heading': '翻譯引擎',
    'options.yt.engine.label': '引擎',
    'options.yt.engine.gemini': 'Gemini（預設，品質較高，需要 API Key）',
    'options.yt.engine.google': 'Google Translate（免費，速度較快，不需 API Key）',
    'options.yt.engine.custom': '自訂模型（與「自訂模型」分頁共用設定）',
    'options.yt.engine.hint.html': '選擇 Google Translate 時，下方模型、計價、Prompt 設定均不作用（Google MT 不支援自訂 Prompt）。<br>選擇「自訂模型」時，會使用「自訂模型」分頁設定的 Base URL / 模型 ID / API Key / Prompt（與文章翻譯共用同一組）；下方模型、計價也不作用',
    'options.yt.gemini.heading': 'Gemini 設定',
    'options.yt.gemini.intro': '括號為 Standard tier 參考價（input / output，每 1M tokens USD）',
    'options.yt.gemini.modelLabel': '模型',
    'options.yt.gemini.modelSame': '（與網頁翻譯主要預設相同）',
    'options.yt.gemini.modelLite': 'gemini-3.1-flash-lite-preview($0.10 / $0.30)— 便宜，字幕品質足夠',
    'options.yt.gemini.modelFlash': 'gemini-3-flash-preview($0.50 / $3.00)— 推薦',
    'options.yt.gemini.modelPro': 'gemini-3.1-pro-preview($2.00 / $12.00)— 大炮打小鳥，不推薦',
    'options.yt.gemini.modelHint': '選擇模型後，下方計價會自動帶入參考價；你也可以手動修改',
    'options.yt.gemini.inputLabel': '字幕 Input 單價（USD / 1M tokens）',
    'options.yt.gemini.inputPlaceholder': '（與文章翻譯相同）',
    'options.yt.gemini.inputHint': '空白表示使用與文章翻譯相同的計價，不需重複設定',
    'options.yt.gemini.outputLabel': '字幕 Output 單價（USD / 1M tokens）',
    'options.yt.gemini.outputPlaceholder': '（與文章翻譯相同）',
    'options.yt.gemini.tempLabel': 'Temperature',
    'options.yt.prompt.heading': '字幕翻譯 Prompt',
    'options.yt.prompt.intro': '字幕翻譯使用獨立的 prompt，與文章翻譯分開。字幕著重口語化、逐段保持、不合併',
    'options.yt.prompt.targetMismatch.html': '⚠ 你已客製化此 prompt；切換目標語言<strong>不會自動覆蓋</strong>你的版本。要套用新目標語言預設，請清空欄位儲存（系統會自動走對應預設），或點下方「重置」按鈕',
    'options.yt.prompt.reset': '重置為預設 Prompt',
    'options.yt.advanced.glossary.summary': '進階：固定術語表 & 禁用詞清單',
    'options.yt.advanced.glossary.intro.html': '是否把「術語表」分頁的固定術語表、與「禁用詞清單」分頁的禁用對照表也注入到字幕翻譯的 prompt?<br><strong>預設關閉以省 token</strong>——字幕本來就走獨立 prompt，且字幕短句 AI 模型不太會誤翻禁用詞，套用收益小、開銷會在高頻字幕場景累積',
    'options.yt.advanced.glossary.applyFixed': '字幕翻譯也套用「固定術語表」',
    'options.yt.advanced.glossary.applyForbidden': '字幕翻譯也套用「禁用詞清單」',
    'options.yt.advanced.batch.summary': '進階：字幕分批翻譯參數',
    'options.yt.advanced.batch.intro': '字幕依時間分批翻譯。每批翻譯涵蓋一段時間內的字幕，在快用完前提前翻好下一批。一般使用者不需要動，維持預設即可',
    'options.yt.advanced.batch.windowLabel': '每批涵蓋秒數',
    'options.yt.advanced.batch.windowHint': '每次送去翻譯的字幕涵蓋幾秒（預設 30 秒）。數字越大每次翻越多，但第一次等待時間也越長',
    'options.yt.advanced.batch.lookaheadLabel': '提前觸發秒數',
    'options.yt.advanced.batch.lookaheadHint': '在目前批次快用完前幾秒，提前翻好下一批（預設 10 秒）。建議不低於 5 秒',
    'options.yt.advanced.borderless.summary': '進階：YouTube 無邊模式',
    'options.yt.advanced.borderless.intro.html': '隱藏 YouTube 介面、讓影片填滿視窗、自動依影片長寬比調整視窗高度。預設未綁定快速鍵，可至 <a href="#" class="open-shortcuts-link" id="open-shortcuts-yt">chrome://extensions/shortcuts</a> 設定「切換 YouTube 無邊模式」',

    // ── options 動態錯誤訊息 ─────────────────────────────
    'options.import.warningSkipType': '{key}：型別錯誤，已略過',
    'options.import.warningSkipNum': '{key}：非有效數字，已略過',
    'options.import.warningSkipMin': '{key}:{value} 低於下限 {min}，已略過',
    'options.import.warningSkipMax': '{key}:{value} 超過上限 {max}，已略過',
    'options.import.warningSkipInt': '{key}：需為整數，已略過',
    'options.import.warningSkipOneOf': '{key}:「{value}」不在允許值內，已略過',
    'options.import.warningSkipNeg': 'pricing.{key}：需為非負數字，已略過',
    'options.import.warningForbiddenSkip': 'forbiddenTerms:{count} 筆格式錯誤，已略過',
    'options.import.warningCpApiKey': 'customProvider.apiKey：匯入不含 API Key，請至設定頁自行填入',
    'options.import.warningDomainRules': 'domainRules.{key}：需為字串陣列，已略過',
    'options.import.warningTransDocPrompt': 'translateDoc.systemPrompt：型別錯誤，已略過',
    'options.import.warningTransDocApply': 'translateDoc.applyGlossary：型別錯誤，已略過',
    'options.import.warningTransDocTemp': 'translateDoc.temperature：超出 0-2 範圍，已略過',

    'options.footerEgg': 'No coding skills were harmed in the making of this shit.',
  };
  // === ZH_TW_DICT_END ===

  // === ZH_CN_DICT_START ===
  // zh-CN dict — 由 tools/translate-i18n-dict.js 產出(從 zh-TW 翻譯)
  // 改 zh-TW 後重跑 build script;或人工 review 後直接編輯本段
  const messages_zhCN = {};
  // === ZH_CN_DICT_END ===

  // === EN_DICT_START ===
  // en dict — 由 tools/translate-i18n-dict.js 產出(從 zh-TW 翻譯)
  const messages_en = {};
  // === EN_DICT_END ===

  const TABLES = {
    'zh-TW': messages_zhTW,
    'zh-CN': messages_zhCN,
    en: messages_en,
  };

  const SUPPORTED_UI_LANGS = ['zh-TW', 'zh-CN', 'en'];
  const FALLBACK_LANG = 'en';

  function getUiLanguage(targetLanguage) {
    if (SUPPORTED_UI_LANGS.includes(targetLanguage)) return targetLanguage;
    return FALLBACK_LANG;
  }

  function _interp(str, params) {
    if (!params || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => {
      if (Object.prototype.hasOwnProperty.call(params, k)) return String(params[k]);
      return m;
    });
  }

  function t(key, params, target) {
    const lang = getUiLanguage(target || _readCurrentTarget());
    const tables = [TABLES[lang], TABLES[FALLBACK_LANG], TABLES['zh-TW']];
    for (const tbl of tables) {
      if (tbl && Object.prototype.hasOwnProperty.call(tbl, key)) {
        return _interp(tbl[key], params);
      }
    }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[shinkansen i18n] missing key:', key, '(lang:', lang + ')');
    }
    return key;
  }

  function _readCurrentTarget() {
    try {
      if (global.__SK && global.__SK.STATE && global.__SK.STATE.targetLanguage) {
        return global.__SK.STATE.targetLanguage;
      }
    } catch (_) { /* 略 */ }
    return 'zh-TW';
  }

  // applyI18n:掃 rootNode 內 [data-i18n] / [data-i18n-html] / [data-i18n-attr-*] 元素並注入翻譯
  // - data-i18n="key":textContent
  // - data-i18n-html="key":innerHTML(只用於信任的 dict 內含 HTML 字串)
  // - data-i18n-attr-<attrName>="key":元素的 <attrName> 屬性,例 data-i18n-attr-placeholder
  // - data-i18n-params="json":params 物件 JSON
  function applyI18n(rootNode, target) {
    const root = rootNode || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return;
    const lang = getUiLanguage(target || _readCurrentTarget());

    const pickParams = (el) => {
      const raw = el.getAttribute('data-i18n-params');
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch (_) { return undefined; }
    };

    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key, pickParams(el), lang);
    });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (!key) return;
      el.innerHTML = t(key, pickParams(el), lang);
    });
    // attribute 注入(placeholder / title / aria-label 等)
    if (root.querySelectorAll) {
      const all = root.querySelectorAll('*');
      all.forEach((el) => {
        const attrs = el.attributes;
        if (!attrs) return;
        for (let i = 0; i < attrs.length; i++) {
          const a = attrs[i];
          if (!a.name.startsWith('data-i18n-attr-')) continue;
          const targetAttr = a.name.slice('data-i18n-attr-'.length);
          const key = a.value;
          if (!key) continue;
          el.setAttribute(targetAttr, t(key, pickParams(el), lang));
        }
      });
    }
  }

  // subscribeUiLanguageChange — 監聽 settings.targetLanguage 變動
  // callback(newUiLanguage, newTarget) 觸發時保留供呼叫方 reapplyI18n
  function subscribeUiLanguageChange(callback) {
    if (typeof callback !== 'function') return () => {};
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) {
      return () => {};
    }
    const handler = (changes, area) => {
      if (area !== 'sync' || !changes.targetLanguage) return;
      const newTarget = changes.targetLanguage.newValue;
      callback(getUiLanguage(newTarget), newTarget);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      try { chrome.storage.onChanged.removeListener(handler); } catch (_) { /* 略 */ }
    };
  }

  const api = {
    t,
    applyI18n,
    getUiLanguage,
    subscribeUiLanguageChange,
    // 給 spec 用的內部 helpers
    _tables: TABLES,
    _supported: SUPPORTED_UI_LANGS,
  };

  // 雙通道 export:content scripts 走 window.__SK,popup / options 也走 window.__SK
  if (!global.__SK) global.__SK = {};
  global.__SK.i18n = api;
  // 短捷:content scripts 慣用 SK.t,直接掛到 SK 命名空間
  if (typeof global.__SK.t !== 'function') global.__SK.t = t;
})(typeof window !== 'undefined' ? window : globalThis);
