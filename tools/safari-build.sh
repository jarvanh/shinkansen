#!/usr/bin/env bash
# safari-build.sh — Build & archive macOS Safari Web Extension
#
# 用途:
#   把 shinkansen/ 內容同步進 safari-app/Shinkansen/Shinkansen Extension/Resources/,
#   同步版本號到 project.pbxproj 的 MARKETING_VERSION / CURRENT_PROJECT_VERSION,
#   跑 xcodebuild archive + exportArchive 產出 Mac App Store 上傳用的 .pkg。
#
# 用法:
#   ./tools/safari-build.sh
#
# 需求:
#   - macOS + Xcode 15+
#   - jq 1.6+
#   - Apple Developer Program 啟用 + Mac Apps signing certificate 已裝在 Keychain
#   - safari-app/Shinkansen/Shinkansen.xcodeproj 已存在(若無,先跑 safari-bootstrap.sh)
#   - tools/safari-export-options.plist 內 teamID 已填入
#
# 輸出:
#   shinkansen-macos-v<version>.pkg(放 repo root)
#
# Source drift forcing function:
#   結束前跑 `diff -r --brief shinkansen/ safari-app/Shinkansen/Shinkansen\ Extension/Resources/`,
#   non-empty 視為 source drift,中止 release。

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="safari-app/Shinkansen"
PROJECT_FILE="$PROJECT_DIR/Shinkansen.xcodeproj"
PBXPROJ="$PROJECT_FILE/project.pbxproj"
EXTENSION_RESOURCES="$PROJECT_DIR/Shinkansen Extension/Resources"
EXPORT_OPTS="tools/safari-export-options.plist"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi

if [ ! -d "$PROJECT_FILE" ]; then
  echo "ERROR: $PROJECT_FILE 不存在。" >&2
  echo "       請先跑 ./tools/safari-bootstrap.sh 產出 Xcode project。" >&2
  exit 1
fi

if [ ! -f "$EXPORT_OPTS" ]; then
  echo "ERROR: $EXPORT_OPTS 不存在。" >&2
  exit 1
fi

if grep -q "TEAMID_TBD" "$EXPORT_OPTS"; then
  echo "ERROR: $EXPORT_OPTS 內 teamID 仍是 TEAMID_TBD,請填入真實 Team ID(PR6NG3PH45)。" >&2
  exit 1
fi

VERSION=$(jq -r '.version' shinkansen/manifest.json)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "ERROR: 無法從 manifest 讀 version。" >&2
  exit 1
fi
echo "Building macOS Safari Extension for version: $VERSION"

# 1. 同步 shinkansen/ → Resources/(--delete 移除已不存在舊檔)
echo "==> Sync extension Resources..."
mkdir -p "$EXTENSION_RESOURCES"
rsync -a --delete shinkansen/ "$EXTENSION_RESOURCES/"

# 2. 版本號同步進 pbxproj(GENERATE_INFOPLIST_FILE=YES,Info.plist 由 Xcode 自動產,
#    版本來源是 build settings 而非 Info.plist 本身)
echo "==> Sync version to project.pbxproj (MARKETING_VERSION / CURRENT_PROJECT_VERSION)..."
# macOS BSD sed 需要 -i ''
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${VERSION};/g" "$PBXPROJ"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${VERSION};/g" "$PBXPROJ"

# 3. clean 舊 build artifacts
echo "==> xcodebuild clean..."
rm -rf build
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  clean

# 4. archive
echo "==> xcodebuild archive..."
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  -archivePath build/Shinkansen.xcarchive \
  archive

# 5. exportArchive 產 .pkg
echo "==> xcodebuild exportArchive..."
xcodebuild -exportArchive \
  -archivePath build/Shinkansen.xcarchive \
  -exportPath build/safari-export \
  -exportOptionsPlist "$EXPORT_OPTS"

# 6. .pkg 搬到 root + 帶版本號
mv build/safari-export/Shinkansen.pkg "shinkansen-macos-v${VERSION}.pkg"

# 7. Source drift forcing function
echo "==> Source drift check..."
DRIFT=$(diff -r --brief shinkansen/ "$EXTENSION_RESOURCES/" 2>&1 || true)
if [ -n "$DRIFT" ]; then
  echo "ERROR: source drift between shinkansen/ and Resources/:" >&2
  echo "$DRIFT" >&2
  exit 1
fi

echo ""
echo "Done: shinkansen-macos-v${VERSION}.pkg"
echo ""
echo "Next: 用 Transporter 上傳到 App Store Connect:"
echo "  open -a Transporter shinkansen-macos-v${VERSION}.pkg"
