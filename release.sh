#!/bin/bash
# 用法: ./release.sh "改了什麼"
# 自動 commit、tag、push，GitHub Actions 會自動建 Release 並附 zip

set -e
cd "$(dirname "$0")"

VERSION=$(grep '"version"' shinkansen/manifest.json | head -1 | sed 's/[^0-9.]//g')
MSG="${1:-v${VERSION}}"

git add -A
git commit -m "v${VERSION} — ${MSG}"
git tag "v${VERSION}"
git push && git push --tags

echo ""
echo "v${VERSION} 已推送，Release 會在 1 分鐘內自動建立。"
echo "https://github.com/jimmysu0309/shinkansen/releases"
