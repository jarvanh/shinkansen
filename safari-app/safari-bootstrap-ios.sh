#!/usr/bin/env bash
# safari-bootstrap-ios.sh — Bootstrap or recreate the iOS Xcode project
#
# 用途:
#   一次性 — 用 xcrun safari-web-extension-converter 從 shinkansen/(排除
#   translate-doc/,manifest 同步 patch)產出 iOS Xcode project 進
#   safari-app/Shinkansen-iOS/,並自動吸收 Phase 0 spike 踩坑修正
#   (SPEC-PRIVATE §26.5):
#     1. converter host App Bundle ID bug 修正(app.shinkansen.Shinkansen
#        → app.shinkansen.ios)
#     2. App Store 手動簽名(CODE_SIGN_STYLE=Manual + profile specifier;
#        cloud signing 在帳號零 iOS 裝置時連 archive 都過不了)
#     3. App icon flatten(iOS 不收帶 alpha 的 1024 icon,altool error 90717)
#     4. ITSAppUsesNonExemptEncryption=false(host + extension 兩份 Info.plist)
#     5. MARKETING_VERSION 同步 manifest version
#
#   Xcode 大版本升級或 default project 結構改變時可重跑(會覆蓋
#   safari-app/Shinkansen-iOS/),平常開發 / release 不要跑。
#
# 警告:
#   會覆蓋 safari-app/Shinkansen-iOS/。重跑前備份自訂 host App 檔案
#   (若 Phase 2 之後有客製 ViewController / 啟用教學頁),完成後 patch 回去。
#
# 需求:
#   - macOS + Xcode 15+ / jq / ffmpeg
#   - shinkansen/manifest.json 存在
#   - 簽名 profiles 已裝(SPEC-PRIVATE §26.5 第 4 條;過期重開:ASC API
#     POST /v1/profiles type=IOS_APP_STORE,cert AHZZMD5VZ3)
#
# 用法:
#   ./safari-app/safari-bootstrap-ios.sh
#
# 輸出:
#   safari-app/Shinkansen-iOS/Shinkansen.xcodeproj 與相關目錄結構
#   (converter 產出多一層 Shinkansen/ 目錄,與 macOS 版相同)

set -euo pipefail
cd "$(dirname "$0")/.."

PROJ_PARENT="safari-app/Shinkansen-iOS"
STAGING="${TMPDIR%/}/shinkansen-ios-bootstrap-src"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi

if [ -d "$PROJ_PARENT" ]; then
  echo "WARN: $PROJ_PARENT/ 已存在,會被覆蓋。"
  read -p "      按 Enter 繼續,Ctrl+C 中止... " _ignore
  rm -rf "$PROJ_PARENT"
fi

# 1. staging source:排除 translate-doc/ + manifest patch(iOS 不做 PDF 翻譯,
#    SPEC-PRIVATE §26.1)
echo "==> Staging iOS source(exclude translate-doc/)..."
rm -rf "$STAGING"; mkdir -p "$STAGING"
rsync -a --exclude 'translate-doc/' shinkansen/ "$STAGING/"
jq '(.web_accessible_resources[]?.resources) |= map(select(. != "translate-doc/*"))' \
  "$STAGING/manifest.json" > "$STAGING/manifest.json.tmp"
mv "$STAGING/manifest.json.tmp" "$STAGING/manifest.json"

# 2. converter
echo "==> Running xcrun safari-web-extension-converter(iOS)..."
mkdir -p "$PROJ_PARENT"
xcrun safari-web-extension-converter "$STAGING" \
  --project-location "$PROJ_PARENT/" \
  --bundle-identifier app.shinkansen.ios \
  --app-name "Shinkansen" \
  --swift \
  --ios-only \
  --copy-resources \
  --no-prompt \
  --no-open

PROJ="$PROJ_PARENT/Shinkansen"
PBX="$PROJ/Shinkansen.xcodeproj/project.pbxproj"

# 3. 修 converter host Bundle ID bug(spike 踩坑 1)
echo "==> Fix host bundle ID(converter bug)..."
sed -i '' 's/PRODUCT_BUNDLE_IDENTIFIER = app\.shinkansen\.Shinkansen;/PRODUCT_BUNDLE_IDENTIFIER = app.shinkansen.ios;/g' "$PBX"

# 4. 版本 + team + 手動簽名(spike 踩坑 4)
echo "==> Version / team / manual App Store signing..."
VERSION=$(jq -r '.version' shinkansen/manifest.json)
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${VERSION};/g" "$PBX"
python3 - "$PBX" <<'PYEOF'
import sys
p = open(sys.argv[1]).read()
p = p.replace("CODE_SIGN_STYLE = Automatic;",
              "CODE_SIGN_STYLE = Manual;\n\t\t\t\tDEVELOPMENT_TEAM = PR6NG3PH45;")
p = p.replace('PRODUCT_BUNDLE_IDENTIFIER = app.shinkansen.ios.Extension;',
 'PRODUCT_BUNDLE_IDENTIFIER = app.shinkansen.ios.Extension;\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "Shinkansen iOS Ext App Store";\n\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";')
p = p.replace('PRODUCT_BUNDLE_IDENTIFIER = app.shinkansen.ios;',
 'PRODUCT_BUNDLE_IDENTIFIER = app.shinkansen.ios;\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "Shinkansen iOS App Store";\n\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";')
open(sys.argv[1],"w").write(p)
PYEOF

# 5. App icon flatten(spike 踩坑 3;正式 full-bleed icon 由 Claude Design 出,
#    出之前先用 macOS icon 鋪自身底色 #EFE8DA)
echo "==> Flatten app icon(remove alpha)..."
ICONSET="$PROJ/Shinkansen/Assets.xcassets/AppIcon.appiconset"
ffmpeg -y -f lavfi -i "color=0xEFE8DA:s=1024x1024" -i safari-app/Shinkansen/icon-1024.png \
  -filter_complex "[0][1]overlay,format=rgb24" -frames:v 1 \
  "$ICONSET/universal-icon-1024@1x.png" 2>/dev/null
if [ "$(sips -g hasAlpha "$ICONSET/universal-icon-1024@1x.png" | awk '/hasAlpha/{print $2}')" != "no" ]; then
  echo "ERROR: icon flatten 失敗,仍有 alpha channel。" >&2
  exit 1
fi

# 6. 出口合規(spike 踩坑 5)
echo "==> ITSAppUsesNonExemptEncryption=false..."
for P in "$PROJ/Shinkansen/Info.plist" "$PROJ/Shinkansen Extension/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$P" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$P"
done

echo ""
echo "Done: $PROJ/Shinkansen.xcodeproj"
echo "接下來跑 ./safari-app/safari-build-ios.sh 驗 archive + export 流程"
