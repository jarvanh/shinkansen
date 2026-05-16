#!/usr/bin/env bash
# safari-build.sh — Build & archive macOS Safari Web Extension(MAS 軌)
#
# 用途:
#   把 shinkansen/ 同步進 Resources/、bump pbxproj 版本、跑 xcodebuild archive,
#   export 出 Mac App Store 上傳用的 .pkg。
#
#   產出: safari-app/shinkansen-macos-v<version>-mas.pkg
#   用法: open -a Transporter safari-app/shinkansen-macos-v<version>-mas.pkg
#
# 雙軌:本 script 只跑 MAS 軌(快,每次 release.sh 跑這條)。
#      Developer ID 公開下載 .pkg 走獨立的 safari-app/safari-build-devid.sh
#      (含 notarize,Apple cloud 動輒 ~30-60 分鐘,不適合綁進 release flow)。
#
# 需求:
#   - macOS + Xcode 15+
#   - jq 1.6+
#   - 3rd Party Mac Developer Application/Installer cert 已裝 Keychain
#   - safari-app/safari-export-options.plist 內 teamID 已填
#   - safari-app/Shinkansen/Shinkansen.xcodeproj 已存在(無則先跑 safari-bootstrap.sh)
#
# Source drift forcing function:
#   結束前跑 diff -r --brief shinkansen/ Resources/,non-empty 視為 drift,中止。

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_DIR="safari-app/Shinkansen"
PROJECT_FILE="$PROJECT_DIR/Shinkansen.xcodeproj"
PBXPROJ="$PROJECT_FILE/project.pbxproj"
EXTENSION_RESOURCES="$PROJECT_DIR/Shinkansen Extension/Resources"
EXPORT_OPTS="safari-app/safari-export-options.plist"
BUILD_DIR="safari-app/build"

if [ ! -f "shinkansen/manifest.json" ]; then
  echo "ERROR: shinkansen/manifest.json not found." >&2
  exit 1
fi

if [ ! -d "$PROJECT_FILE" ]; then
  echo "ERROR: $PROJECT_FILE 不存在。" >&2
  echo "       請先跑 ./safari-app/safari-bootstrap.sh 產出 Xcode project。" >&2
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
echo "Building macOS Safari Extension for version: $VERSION (MAS 軌)"

# 1. 同步 shinkansen/ → Resources/(--delete 移除已不存在舊檔)
echo "==> Sync extension Resources..."
mkdir -p "$EXTENSION_RESOURCES"
rsync -a --delete shinkansen/ "$EXTENSION_RESOURCES/"

# 2. 版本號同步進 pbxproj
echo "==> Sync version to project.pbxproj..."
sed -i '' -E "s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = ${VERSION};/g" "$PBXPROJ"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = ${VERSION};/g" "$PBXPROJ"

# 3. clean 舊 build artifacts
echo "==> xcodebuild clean..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  clean

# 4. archive
echo "==> xcodebuild archive..."
xcodebuild -project "$PROJECT_FILE" \
  -scheme Shinkansen \
  -configuration Release \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  archive

# 5. exportArchive MAS → -mas.pkg
echo "==> Export MAS .pkg..."
xcodebuild -exportArchive \
  -archivePath "$BUILD_DIR/Shinkansen.xcarchive" \
  -exportPath "$BUILD_DIR/safari-export-mas" \
  -exportOptionsPlist "$EXPORT_OPTS"

MAS_PKG="safari-app/shinkansen-macos-v${VERSION}-mas.pkg"
mv "$BUILD_DIR/safari-export-mas/Shinkansen.pkg" "$MAS_PKG"

# 6. Source drift forcing function
echo "==> Source drift check..."
DRIFT=$(diff -r --brief shinkansen/ "$EXTENSION_RESOURCES/" 2>&1 || true)
if [ -n "$DRIFT" ]; then
  echo "ERROR: source drift between shinkansen/ and Resources/:" >&2
  echo "$DRIFT" >&2
  exit 1
fi

echo ""
echo "Done: $MAS_PKG"
echo ""
echo "MAS 上架:"
echo "  open -a Transporter $MAS_PKG"
echo ""
echo "要發 Developer ID 公開下載版(notarize 等 Apple cloud ~30-60 分鐘):"
echo "  ./safari-app/safari-build-devid.sh"
