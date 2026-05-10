// Unit test: YouTube SPA nav same-videoId guard architecture invariants(v1.8.68)
//
// 對應 PENDING_REGRESSION.md 條目「v1.8.68 同 videoId yt-navigate-finish 假性
// 重 fire 不誤清譯文」。YouTube SPA 在 quality 切換 / ad break 結束 /
// player re-mount / theatre-fullscreen 切換等情境會 fire 假性 yt-navigate-finish
// (同一影片頁、videoId 沒變)。原 listener 一律走 reset path → captionMap /
// displayCues / overlay 全清 + force reload XHR(~10 秒)→ 使用者看到「中文字幕
// 閃一下變回英文一陣子才回到中文」。v1.8.68 加 same-videoId guard 跳過 reset。
//
// 本檔做 static check,鎖死 listener 開頭的 guard architecture invariant —
// 確保未來不會有人不小心拔掉 guard / 把 reset 移到 guard 之前 / 改錯 guard 條件,
// 讓字幕閃爍 bug 重現。
//
// **驗到 / 沒驗到**(訊號層次,§1.1 規則 3):
//   ✅ 「我們的 guard 邏輯寫對」:listener 開頭有 same-videoId early-return guard,
//      reset path 在 guard 之後 — 這層 fixture 跟 static check 都能驗。
//   ❌ 「YouTube 真的會 fire 假性同 videoId 的 yt-navigate-finish」:這是 YouTube
//      內部行為,fixture dispatchEvent 自己 fire 永遠驗不到 — 這層靠 user 觀察 +
//      production 體感持續驗證,spec 鎖死範圍不含。
//
// SANITY 紀錄(已驗證):暫時把 guard 整段拔掉,對應 spec fail;還原後全綠。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * 從 content-youtube.js 抽出 `yt-navigate-finish` listener 的 body。
 * 從 `addEventListener('yt-navigate-finish'` 開始找第一個 `{`(listener arrow
 * function body 起頭)— brace balance 計數抓到對應 `}` 為止。處理 string /
 * line comment / block comment 內的 `{}` 不算 brace。
 */
function extractListenerBody(src) {
  const anchor = src.indexOf("addEventListener('yt-navigate-finish'");
  if (anchor === -1) return null;
  const bodyOpen = src.indexOf('{', anchor);
  if (bodyOpen === -1) return null;

  let depth = 1;
  let i = bodyOpen + 1;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (src[i - 1] === '*' && ch === '/') inBlockComment = false;
    } else if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
    } else {
      if (ch === '/' && src[i + 1] === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && src[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; }
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  return src.slice(bodyOpen, i);
}

test.describe('content-youtube.js: yt-navigate-finish listener 同 videoId guard', () => {
  const src = readFile('shinkansen/content-youtube.js');
  const body = extractListenerBody(src);

  test('yt-navigate-finish listener 可被找到', () => {
    expect(body).not.toBeNull();
    expect(body.length).toBeGreaterThan(200);
  });

  test('listener 開頭取當前 URL videoId(用於跟 YT.videoId 比對)', () => {
    expect(body).toMatch(/getVideoIdFromUrl\s*\(\)/);
  });

  test('有 same-videoId early-return guard(三段式條件:active + 新 videoId truthy + 等於 YT.videoId)', () => {
    // 三個條件都要,缺一不可:
    //   - YT.active:必須是翻譯仍在進行中,單純停在影片頁不該被 guard
    //   - 新 videoId truthy:離開 watch 頁(newVideoId === null)該走原 reset path
    //   - 新 videoId === YT.videoId:不同影片切換該走原 reset path
    expect(body).toMatch(/YT\.active\s*&&\s*\w+\s*&&\s*\w+\s*===\s*YT\.videoId/);
  });

  test('guard 命中時 early return(避免繼續跑 reset path)', () => {
    // 抓 guard if (...) 後面接 { ... return; ... } 或 if (...) return;
    // 用更寬的 pattern:guard 條件之後 200 字內出現 return
    expect(body).toMatch(/YT\.active\s*&&[\s\S]{0,80}===\s*YT\.videoId\s*\)\s*\{?[\s\S]{0,200}return\s*[;\n]/);
  });

  test('guard 在 reset path(stopYouTubeTranslation / 清 captionMap)之前', () => {
    // 用字串位置比較:guard 條件位置 < reset 操作位置
    const guardIdx = body.search(/===\s*YT\.videoId/);
    const stopIdx = body.indexOf('stopYouTubeTranslation()');
    const captionMapResetIdx = body.search(/YT\.captionMap\s*=\s*new\s+Map/);

    expect(guardIdx).toBeGreaterThan(0);
    expect(stopIdx).toBeGreaterThan(0);
    expect(captionMapResetIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(stopIdx);
    expect(guardIdx).toBeLessThan(captionMapResetIdx);
  });

  test('reset path 仍在(不同影片 / 離開 watch 頁仍走原 reset)', () => {
    // 確保 guard 加了之後 reset 邏輯沒被一起拿掉 — 真正的影片切換仍要清狀態
    expect(body).toMatch(/stopYouTubeTranslation\s*\(\)/);
    expect(body).toMatch(/YT\.captionMap\s*=\s*new\s+Map/);
    expect(body).toMatch(/YT\.rawSegments\s*=\s*\[\]/);
  });

  test('guard 命中時記 log(方便 user 報告閃爍時 dump log 驗證真實場景)', () => {
    // user 報告字幕閃時,log 內可以看到 'SPA nav skipped' 條目 → 確認真的有命中
    // same-videoId 場景。沒這條 log,我們仍鎖不到 YouTube 真實 fire 行為,但至少
    // 知道 guard 沒命中(應該命中卻沒命中 = 別處出問題)
    expect(body).toMatch(/['"]SPA nav skipped[^'"]*['"]/);
  });
});
