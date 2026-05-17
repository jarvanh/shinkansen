#!/bin/bash
# 用法: ./tools/release.sh "改了什麼"
#       SKIP_SAFARI=1 ./tools/release.sh "改了什麼"   # 緊急只發 Chrome / Firefox
#
# 一次 build 產出三條 release artifact:
#   - Chrome / Firefox       : commit + tag + push,GitHub Actions 自動建 Release zip
#   - macOS Safari Developer ID : shinkansen-macos-v<ver>.pkg(notarize + stapled,
#                              自動上傳到 GitHub Release 給使用者公開下載手動安裝)
#   - macOS Safari MAS       : shinkansen-macos-v<ver>-mas.pkg(Transporter 上傳 App Store Connect,
#                              需手動 deliver)
#
# Safari build 失敗(沒 Xcode / 沒簽章 / pbxproj 不存在 / notarize cloud reject)會在
# git commit 前 abort,不留半 release 狀態。
#
# Developer ID notarize 等 Apple cloud 時間不固定(實測過 27 秒;Apple 文件聲稱可達
# 30-60 分鐘)。怕等就 SKIP_SAFARI=1 走純 Chrome / Firefox 路。

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
  echo "    下次 Safari release 要手動跑 ./safari-app/safari-build.sh + safari-build-devid.sh 補上同步。"
else
  echo "==> Safari MAS build(同步 Resources / bump pbxproj / xcodebuild archive)..."
  ./safari-app/safari-build.sh
  echo ""
  echo "==> Safari Developer ID build(獨立 archive + notarize,等 Apple cloud)..."
  ./safari-app/safari-build-devid.sh
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

# Developer ID .pkg 上傳到 GitHub Release(GitHub Actions ~1 分鐘內建出 release,
# 這邊 poll 等到 release 存在再 upload)。SKIP_SAFARI 時沒 .pkg,跳過。
if [ "${SKIP_SAFARI:-0}" != "1" ]; then
  DEVID_PKG="safari-app/shinkansen-macos-v${VERSION}.pkg"
  if [ ! -f "$DEVID_PKG" ]; then
    echo "⚠️  $DEVID_PKG 不存在,跳過 GitHub Release upload(safari-build-devid.sh 應產此檔)。"
  else
    echo ""
    echo "==> 等 GitHub Release v${VERSION} 由 Actions 建出(最多輪詢 3 分鐘)..."
    UPLOADED=0
    for i in $(seq 1 18); do
      if gh release view "v${VERSION}" >/dev/null 2>&1; then
        echo "    Release 已建立,開始上傳 $DEVID_PKG ..."
        gh release upload "v${VERSION}" "$DEVID_PKG" --clobber
        UPLOADED=1
        break
      fi
      sleep 10
    done
    if [ "$UPLOADED" != "1" ]; then
      echo "⚠️  GitHub Release v${VERSION} 3 分鐘內沒出現,手動補上:"
      echo "    gh release upload v${VERSION} $DEVID_PKG"
    fi
  fi
fi

echo ""
echo "v${VERSION} 已推送,GitHub Release 已建立。"
echo "  Chrome / Firefox     : https://github.com/jimmysu0309/shinkansen/releases"
if [ "${SKIP_SAFARI:-0}" != "1" ]; then
  echo "  macOS Safari (DevID) : 已自動上傳到 v${VERSION} release(notarize + stapled)"
  echo "  macOS Safari (MAS)   : safari-app/shinkansen-macos-v${VERSION}-mas.pkg"
  echo "                         open -a Transporter safari-app/shinkansen-macos-v${VERSION}-mas.pkg"
fi
