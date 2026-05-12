#!/usr/bin/env bash
# safari-bootstrap.sh — Bootstrap or recreate the Xcode project
#
# 用途:
#   一次性 — 用 xcrun safari-web-extension-converter 從 shinkansen/ 產出
#   Xcode project 進 safari-app/。Xcode 大版本升級或 default project 結構
#   改變時可重跑(會覆蓋 safari-app/),平常開發 / release 不要跑。
#
# 警告:
#   會覆蓋 safari-app/(包含 ShinkansenApp.swift / ContentView.swift /
#   Localizable.xcstrings 等本機 host App 檔案)。重跑前手動備份這三檔,
#   完成後再 patch 回去。
#
# 注意:
#   converter 預設 host App Bundle ID 推導用 app-name reverse-DNS(會給
#   `app.shinkansen.Shinkansen`),違反「Extension Bundle ID 必須以 host
#   為 prefix」。重跑後要 manual 改 project.pbxproj line 606+648 為
#   `app.shinkansen.macos`(Debug + Release)。
#
# 用法:
#   ./tools/safari-bootstrap.sh
#
# 需求:
#   - macOS + Xcode 15+
#   - shinkansen/manifest.json 存在
#
# 輸出:
#   safari-app/Shinkansen/Shinkansen.xcodeproj 與相關目錄結構
#   (注意 converter 產出多一層 Shinkansen/ 目錄)

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi

if [ -d "safari-app" ]; then
  echo "WARN: safari-app/ 已存在,會被覆蓋。"
  echo "      請確認 host App 檔案(ShinkansenApp.swift / ContentView.swift /"
  echo "      Localizable.xcstrings 等)已備份。"
  echo ""
  read -p "      按 Enter 繼續,Ctrl+C 中止... " _ignore
  rm -rf safari-app
fi

echo "==> Running xcrun safari-web-extension-converter..."
xcrun safari-web-extension-converter shinkansen/ \
  --project-location safari-app/ \
  --bundle-identifier app.shinkansen.macos \
  --app-name "Shinkansen" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-prompt \
  --no-open

echo ""
echo "Done。接下來:"
echo "  1. 修 project.pbxproj 內兩處 PRODUCT_BUNDLE_IDENTIFIER:"
echo "     converter 預設給 host App `app.shinkansen.Shinkansen`(用 app-name 推),"
echo "     要改成 `app.shinkansen.macos`(Debug + Release 共兩處)。"
echo "  2. 把備份的 host App 三檔(ShinkansenApp.swift / ContentView.swift /"
echo "     Localizable.xcstrings)複製回 safari-app/Shinkansen/Shinkansen/"
echo "  3. 在 Xcode 開啟 safari-app/Shinkansen/Shinkansen.xcodeproj:"
echo "     - 右鍵 Shinkansen group → Add Files to project → 加入三檔"
echo "     - Project navigator 刪 AppDelegate.swift / ViewController.swift /"
echo "       Base.lproj/Main.storyboard / Resources/{Main.html,Script.js,Style.css,Icon.png}"
echo "     - Target Shinkansen → Build Settings → 移除 INFOPLIST_KEY_NSMainStoryboardFile"
echo "     - Target Shinkansen → Signing & Capabilities → Team = PR6NG3PH45"
echo "  4. 跑 ./tools/safari-build.sh 驗 archive + export 流程"
