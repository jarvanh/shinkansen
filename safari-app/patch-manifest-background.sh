#!/usr/bin/env bash
# patch-manifest-background.sh — Safari build 的 manifest background 改宣告 event page
# （safari-build.sh 與 safari-build-ios.sh 共用，單一資料源、不雙實作）
#
# 為什麼存在（2026-06-07）：
#   iOS Safari 的 MV3 background **service worker 被系統回收後不再喚醒**
#   （Apple Developer Forums thread 758346；iOS 17.4 起、迄今未修）。SW 死後
#   content script / popup 的 runtime 訊息石沉大海且叫不醒它——「用一段時間後
#   四指 / popup 失效，強制關閉 Safari 才復原」的根因。Safari 對 background
#   event page（scripts + persistent: false）的生命週期管理正常：卸載後下一個
#   事件會重新喚起；WebKit 原始碼（WebExtension.cpp generatedBackgroundContent）
#   證實 scripts 形式照樣吃 type: "module"（產生 <script type="module">），
#   background.js 的 16 個 static import 不需 bundle。
#
#   Chrome 版 manifest（shinkansen/）維持 service_worker 不動——Safari build
#   的受控差異由本 script 產生並驗證。
#
# 用法：patch-manifest-background.sh <manifest.json 路徑>
#   就地改寫（冪等）：background = { scripts: [<原 service_worker>],
#   type: <原 type，預設 classic 不寫>, persistent: false }
set -euo pipefail

MANIFEST="${1:?用法: patch-manifest-background.sh <manifest.json 路徑>}"
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST 不存在" >&2
  exit 1
fi

ALREADY=$(jq -r '.background | has("scripts") and (has("service_worker") | not)' "$MANIFEST")
if [ "$ALREADY" != "true" ]; then
  SW_FILE=$(jq -r '.background.service_worker' "$MANIFEST")
  if [ -z "$SW_FILE" ] || [ "$SW_FILE" = "null" ]; then
    echo "ERROR: $MANIFEST 讀不到 background.service_worker" >&2
    exit 1
  fi
  TMP="$MANIFEST.tmp"
  jq '.background = ((.background | del(.service_worker)) + { scripts: [.background.service_worker], persistent: false })' \
    "$MANIFEST" > "$TMP"
  mv "$TMP" "$MANIFEST"
fi

# verify：必須是 event page 形式、scripts 指向原 SW 檔、type 欄位保留（module）
BG_OK=$(jq -r '(.background.scripts | type == "array" and length == 1) and (.background.persistent == false) and (.background | has("service_worker") | not)' "$MANIFEST")
if [ "$BG_OK" != "true" ]; then
  echo "ERROR: manifest background 不是預期 event page 形式：" >&2
  jq '.background' "$MANIFEST" >&2
  exit 1
fi

echo "manifest background patched: $(jq -c '.background' "$MANIFEST")"
