#!/bin/bash
# 用法: ./tools/release.sh "改了什麼"
#       SKIP_SAFARI=1 ./tools/release.sh "改了什麼"   # 緊急只發 Chrome / Firefox
#
# 一次 build 產出兩條快速 release artifact:
#   - Chrome / Firefox    : commit + tag + push,GitHub Actions 自動建 Release zip
#   - macOS Safari MAS    : shinkansen-macos-v<ver>-mas.pkg(Transporter 上傳 App Store Connect)
#
# Developer ID 公開下載 .pkg 拆成獨立流程:
#   ./safari-app/safari-build-devid.sh    # notarize 等 Apple cloud ~30-60 分鐘
#   gh release upload v<ver> safari-app/shinkansen-macos-v<ver>.pkg
# 不綁進 release.sh — notarize 太慢不能每版跑,需要時手工觸發,當作獨立 deliverable。
#
# Safari MAS build 失敗(沒 Xcode / 沒簽章 / pbxproj 不存在)會在 git commit 前 abort,
# 不留半 release 狀態。

set -e
cd "$(dirname "$0")/.."

VERSION=$(grep '"version"' shinkansen/manifest.json | head -1 | sed 's/[^0-9.]//g')
MSG="${1:-v${VERSION}}"

# Safari build 必先過(syncs Resources + bumps pbxproj MARKETING_VERSION /
# CURRENT_PROJECT_VERSION + 產 .pkg)。pbxproj 變更會由下面 git add -A 一起 commit,
# 讓 manifest 版本跟 Xcode 版本永遠同 commit,杜絕兩邊 drift。
# 真要只發 Chrome(例如 Xcode 暫時不能跑)走 SKIP_SAFARI=1。
if [ "${SKIP_SAFARI:-0}" = "1" ]; then
  echo "⚠️  SKIP_SAFARI=1 — 跳過 Safari build,只發 Chrome / Firefox。"
  echo "    下次 Safari release 要手動跑 ./safari-app/safari-build.sh 補上同步。"
else
  echo "==> Safari build(同步 Resources / bump pbxproj / xcodebuild archive)..."
  ./safari-app/safari-build.sh
fi

# v1.6.5: minor/major bump 時提醒檢查 RELEASE_HIGHLIGHTS 是否要更新
# patch bump 不會觸發 welcome notice，跳過提醒
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
PREV_VER=${PREV_TAG#v}
if [ -n "$PREV_VER" ]; then
  NEW_MAJOR=$(echo "$VERSION" | cut -d. -f1)
  NEW_MINOR=$(echo "$VERSION" | cut -d. -f2)
  PREV_MAJOR=$(echo "$PREV_VER" | cut -d. -f1)
  PREV_MINOR=$(echo "$PREV_VER" | cut -d. -f2)
  if [ "$NEW_MAJOR" != "$PREV_MAJOR" ] || [ "$NEW_MINOR" != "$PREV_MINOR" ]; then
    echo ""
    echo "⚠️  Major / Minor bump 偵測到（v${PREV_VER} → v${VERSION}）"
    echo "   此版會觸發 CWS 使用者的「歡迎升級」提示——請確認"
    echo "   shinkansen/lib/release-highlights.js 的 RELEASE_HIGHLIGHTS 是否要更新。"
    echo ""
    echo "   - 有新功能 → 把最舊那條換成新功能描述"
    echo "   - 純內部升級（重構 / 效能 / 修 bug） → 可用通用條目，例如："
    echo "       '改善效能與穩定性，提升整體使用體驗'"
    echo ""
    read -p "   按 Enter 繼續發版、按 Ctrl+C 中止去更新 highlights ... " _ignore
  fi
fi

git add -A
git commit -m "v${VERSION} — ${MSG}"

# 若 tag 已存在，先刪除本地和遠端的舊 tag 再重建
if git tag -l "v${VERSION}" | grep -q .; then
  git tag -d "v${VERSION}"
  git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
fi
git tag "v${VERSION}"
git push && git push --tags

echo ""
echo "v${VERSION} 已推送，GitHub Release 會在 1 分鐘內自動建立。"
echo "  Chrome / Firefox     : https://github.com/jimmysu0309/shinkansen/releases"
if [ "${SKIP_SAFARI:-0}" != "1" ]; then
  echo "  macOS Safari (MAS)   : safari-app/shinkansen-macos-v${VERSION}-mas.pkg"
  echo "                         open -a Transporter safari-app/shinkansen-macos-v${VERSION}-mas.pkg"
fi
echo ""
echo "(要發 Developer ID 公開下載 .pkg → 手工跑 ./safari-app/safari-build-devid.sh,"
echo " notarize 等 Apple cloud ~30-60 分鐘,完成後 gh release upload v${VERSION} ...)"
