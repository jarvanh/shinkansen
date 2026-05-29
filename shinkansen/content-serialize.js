// content-serialize.js — Shinkansen 佔位符序列化/反序列化
// 負責把段落內的 inline 元素轉成 ⟦N⟧…⟦/N⟧ 佔位符（序列化），
// 以及把含佔位符的譯文還原成 DocumentFragment（反序列化）。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const PH_OPEN = SK.PH_OPEN;
  const PH_CLOSE = SK.PH_CLOSE;

  // 父 element 的 effective white-space 是 pre/pre-wrap/pre-line/break-spaces 時,
  // textContent 內的 \n 是視覺換行(不是會被瀏覽器 collapse 成 space 的純 source whitespace)。
  // 序列化時這些 \n 必須跟 <br> 共用  sentinel 路徑,否則接著 /\s+/g normalize 會
  // 把 \n 壓成 space,送 LLM/Google MT 的 text 失去原始換行,譯文回來不知如何還原。
  // 真實場景:Twitter / Reddit / Threads / Mastodon / Discord web 等用 SPAN + textContent
  // \n + white-space: pre-wrap 顯示換行(完全不用 <br>)。React 社群常見 pattern。
  function shouldPreserveTextNewlines(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (!cs) return false;
    const ws = cs.whiteSpace;
    return ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
  }
  // 暴露給 spec 用
  SK._shouldPreserveTextNewlines = shouldPreserveTextNewlines;

  // ─── 序列化 ───────────────────────────────────────────

  SK.serializeWithPlaceholders = function serializeWithPlaceholders(el) {
    return serializeNodeIterable(el.childNodes, {
      preserveNewlines: shouldPreserveTextNewlines(el),
    });
  };

  // ─── Google Translate 專用序列化 ──────────────────────
  // 只標記 <a> 連結（用【N】/【/N】）與 atomic 元素（用【*N】），
  // 其他 span/b/i/abbr 直接遞迴取文字（不加標記）。
  // 這樣送給 Google MT 的標記數量極少（通常 2-4 個），
  // 避免過多標記導致 Google MT 位置錯亂。
  //
  // 為什麼用【】而不用⟦⟧：⟦⟧ 是數學符號，Google MT 視為可翻譯符號會亂移；
  // 【】是 CJK 標點，Google MT 原樣保留且維持正確前後順序。
  //
  // 回傳的 text 可直接送 Google MT；結果還原時用
  // SK.restoreGoogleTranslateMarkers(tr) 把【N】換回⟦N⟧再走現有 deserialization。

  // v1.8.13: paired marker 數量上限。Google Translate 非官方端點對同段內
  // 「【N】xxx【/N】」配對標記超過 5 個時會 hallucinate(把標記當 list 結構
  // 亂吐 garbage tokens,典型症狀:譯文殘留「[/5】[/5]【6】【6】」「/Proad】」
  // 這類 garbage)。實 fetch 驗:3-5 對都 OK、6 對開始壞、8 對完全爛。
  // 觸發場景:Medium 作者 byline「socials: <a>YouTube</a> | <a>TikTok</a> |
  // ...」這類大量短 <a> 列表。超過閾值時改走「不加 paired marker、純取文字」
  // 退化路徑,該段失去 <a> 連結保留(anchor text 變純文字)但譯文不會壞掉。
  // Atomic 標記(【*N】)不受影響——probe 顯示連 8 個 atomic 都不會亂。
  const GT_MAX_PAIRED_SLOTS = 5;

  function countPairedInlineForGT(topLevelNodes) {
    let count = 0;
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
        if (SK.isAtomicPreserve(child)) continue;
        // v1.9.31: 含 element child 的 A 在 serialize 走 atomic,不算 paired。
        if (child.tagName === 'A' && hasElementChild(child)) continue;
        if (SK.GT_INLINE_TAGS.has(child.tagName)) {
          count++;
          if (count > GT_MAX_PAIRED_SLOTS) return;
        }
        walk(child.childNodes);
        if (count > GT_MAX_PAIRED_SLOTS) return;
      }
    }
    walk(topLevelNodes);
    return count;
  }

  // v1.9.31: 判斷 element 是否含 element child(用於 Google MT 對 anchor atomic 判斷)。
  function hasElementChild(el) {
    if (!el || !el.childNodes) return false;
    for (const c of el.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE) return true;
    }
    return false;
  }

  function serializeNodeIterableForGoogle(topLevelNodes, opts) {
    const slots = [];
    let out = '';
    const preserveNewlines = !!(opts && opts.preserveNewlines);
    // v1.8.13: paired marker 過閾值 → 降級為純文字模式(slots 仍可含
    // atomic,但不再產生 paired【N】/【/N】標記)。
    const degrade = countPairedInlineForGT(topLevelNodes) > GT_MAX_PAIRED_SLOTS;
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          // pre/pre-wrap/pre-line:textNode 內 \n 是視覺換行,轉  跟 BR 共用 sentinel,
          // 避開後續 /\s+/g collapse 把 \n 壓成 space。
          out += preserveNewlines
            ? child.nodeValue.replace(/\n/g, '')
            : child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // Inline <code> 在 HARD_EXCLUDE_TAGS 是給 walker 擋整個 code 區塊用的,
          // 但段落內 inline <code> 走到 serialize 已是另一條路徑,必須當 atomic
          // slot 保留(否則 GitHub PR description / 技術文章內的 <code>identifier</code>
          // 會被丟掉,grey background 樣式跟著消失)。必須先於 HARD_EXCLUDE 檢查。
          // PRE+code 仍然 continue(那是 code 區塊,跟 inline 不同)。
          if (child.tagName === 'CODE'
              && !(child.parentElement && child.parentElement.tagName === 'PRE')) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += '【*' + idx + '】';
            continue;
          }
          // 與 LLM serializer 同 pattern:inline <button> 走 paired marker 保留 wrapper。
          // BUTTON 在 HARD_EXCLUDE_TAGS 是給 walker 擋以 button 為主的 widget 用,
          // 段落內 inline 用法必須先於 HARD_EXCLUDE 開洞(同 inline CODE 例外位置)。
          // degrade 模式下走純文字路徑(跟下方 GT_INLINE_TAGS 在 degrade 下的行為一致)。
          // reuseNode 機制同 LLM path 註解:保留 React fiber → click 能展開。
          if (child.tagName === 'BUTTON' && SK.hasSubstantiveContent(child)) {
            if (!degrade) {
              const idx = slots.length;
              slots.push({ reuseNode: true, node: child });
              out += '【' + idx + '】';
              walk(child.childNodes);
              out += '【/' + idx + '】';
            } else {
              walk(child.childNodes);
            }
            continue;
          }
          if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          if (child.tagName === 'BR') { out += '\u0001'; continue; }
          // Atomic 元素（footnote sup 等）→ 單一標記，不翻內容
          if (SK.isAtomicPreserve(child)) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += '【*' + idx + '】';
            continue;
          }
          // v1.9.31: 含 element child 的 anchor 走 atomic deep clone path。
          // Why:Google MT 對含 nested SPAN 結構的 anchor(典型 X 推文 URL anchor:
          // <a><span>https://</span>text<span>main</span><span>…</span></a>、X @mention
          // anchor、framework site 的 link card)若走 paired marker shallow clone,
          // deserialize 時 anchor 內部結構全丟(只剩 Google MT 翻譯後純 text),
          // source/target 結構不對等 → Layer A3 collectA3Mutations 對齊失敗 →
          // framework-managed 段落 fallback dual sibling wrapper(違反 §15 single
          // 原地替換)。改 atomic 後 anchor 整段 deep clone 不送 Google API,
          // deserialize 直接塞回 source 原樣 → A3 對齊成功 → nodeValue mutate single。
          //
          // Trade-off:含 element child 的 markdown link `<a>some <b>bold</b> text</a>`
          // anchor inner text 也不翻。但這在 prose 文章較少見,且即使不翻 link text 也
          // 不會 break 文章主體翻譯。純 text 內 anchor `<a>科學家</a>` 維持 paired
          // marker 可翻(維基百科 / 一般 inline link 不受影響)。
          //
          // 不動 LLM serializeNodeIterable:Gemini path 對 anchor 內 SPAN 翻譯品質較好,
          // 且 LLM Layer A3 fallback 路徑跟 Google MT 不同(LLM 有更寬鬆的 free text
          // 吸收邏輯),不需此改動。
          if (!degrade && child.tagName === 'A' && hasElementChild(child)) {
            // block 元素（H1-H6 等）的唯一 child 是 <a> 時，A 是 block 的主要內容載體，
            // 走 paired marker 讓 Google MT 翻譯內文。典型 case：Amazon 評論標題
            // H5 > A > {I(星星 icon), SPAN(標題)} — 整段 atomic 會讓標題完全不翻。
            // A 內部有 element child 的 inline tag（I/B/EM 等）走 atomic 保留 icon 結構,
            // 其餘 text/SPAN 走 walk 讓 Google MT 翻。
            const _p = child.parentElement;
            if (_p && SK.BLOCK_TAGS_SET.has(_p.tagName) && _p.children.length === 1) {
              const idx = slots.length;
              slots.push(child.cloneNode(false));
              out += '【' + idx + '】';
              for (const ac of child.childNodes) {
                if (ac.nodeType === Node.TEXT_NODE) {
                  out += ac.nodeValue;
                } else if (ac.nodeType === Node.ELEMENT_NODE) {
                  if (SK.HARD_EXCLUDE_TAGS.has(ac.tagName)) continue;
                  if (ac.tagName === 'BR') { out += ''; continue; }
                  if (hasElementChild(ac) || !(ac.textContent || '').trim()) {
                    const aidx = slots.length;
                    slots.push({ atomic: true, node: ac.cloneNode(true) });
                    out += '【*' + aidx + '】';
                  } else {
                    walk([ac]);
                  }
                }
              }
              out += '【/' + idx + '】';
              continue;
            }
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += '【*' + idx + '】';
            continue;
          }
          // v1.9.31: IMG 走 atomic deep clone(Twitter / X 用 IMG render emoji)。
          // 原本 IMG 走 walk(childNodes) 透明展開,IMG 沒 children 等於從 source text
          // 流消失,Google MT API 收不到 emoji 位置,deserialize 後 tgt 也沒 IMG → src
          // 端 IMG 位置(sibling text 之間)失去對應 tgt token 跟結構,segment 對齊
          // 把 tgt 全集塞給第一個 ss,emoji 視覺跑到段尾。改 atomic 後 IMG 在 source
          // text 出現為【*N】marker,Google MT 看到不翻直接保留,deserialize 後 tgt
          // 還原 IMG 位置 → src/tgt 兩端 IMG 邊界對齊。
          if (!degrade && child.tagName === 'IMG') {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += '【*' + idx + '】';
            continue;
          }
          // 語意行內標籤 → 配對標記（保留格式）
          // 包含 <a>（連結）與 <b>/<i>/<small> 等語意格式標籤。
          // 刻意排除 <span>：SPAN 是最常見的爆炸來源（Wikipedia lede 有 10+ 個
          // span.class，會讓 Google MT 位置錯亂）。<abbr> 也排除（樣式用途為主）。
          // v1.8.13: degrade 模式下 GT_INLINE_TAGS 也走純文字路徑(不加標記)。
          if (!degrade && SK.GT_INLINE_TAGS.has(child.tagName)) {
            const idx = slots.length;
            slots.push(child.cloneNode(false));
            out += '【' + idx + '】';
            walk(child.childNodes);
            out += '【/' + idx + '】';
            continue;
          }
          // SPAN、ABBR 及其他非語意元素 → 只取文字，不加標記
          walk(child.childNodes);
        }
      }
    }
    walk(topLevelNodes);
    const normalized = out
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/\u0001{3,}/g, '\u0001\u0001')
      .replace(/\u0001/g, '\n')
      .trim();
    return { text: normalized, slots };
  }

  SK.serializeForGoogleTranslate = function serializeForGoogleTranslate(el) {
    return serializeNodeIterableForGoogle(el.childNodes, {
      preserveNewlines: shouldPreserveTextNewlines(el),
    });
  };

  SK.serializeFragmentForGoogleTranslate = function serializeFragmentForGoogleTranslate(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    // fragment 容器是 startNode 的 parent
    const parent = unit.startNode && unit.startNode.parentElement;
    return serializeNodeIterableForGoogle(nodes, {
      preserveNewlines: shouldPreserveTextNewlines(parent),
    });
  };

  // 將 Google MT 回傳的【N】/【/N】/【*N】換回⟦N⟧/⟦/N⟧/⟦*N⟧，
  // 交給現有 deserializeWithPlaceholders 處理。
  // Google MT 有時會把 CJK 括號【】正規化成 ASCII 括號 []。
  // 只在偵測到 [/N] 或 [*N]（自然文字不會出現的 pattern）時才啟動
  // ASCII fallback，避免把 footnote [0] / [1] 之類誤判為 marker。
  SK.restoreGoogleTranslateMarkers = function restoreGoogleTranslateMarkers(s) {
    var result = s
      .replace(/【\*(\d+)】/g, PH_OPEN + '*$1' + PH_CLOSE)
      .replace(/【(\d+)】/g,   PH_OPEN + '$1'  + PH_CLOSE)
      .replace(/【\/(\d+)】/g, PH_OPEN + '/$1' + PH_CLOSE);
    if (/\[\/\d+\]|\[\*\d+\]/.test(result)) {
      result = result
        .replace(/\[\*(\d+)\]/g, PH_OPEN + '*$1' + PH_CLOSE)
        .replace(/\[(\d+)\]/g,   PH_OPEN + '$1'  + PH_CLOSE)
        .replace(/\[\/(\d+)\]/g, PH_OPEN + '/$1' + PH_CLOSE);
    }
    return result;
  };

  // CJK↔placeholder 空格補齊:Google MT 翻成 CJK 時常吃掉 marker 前後空格。
  // 只對 opening ⟦N⟧ / atomic ⟦*N⟧ 前和 closing ⟦/N⟧ / atomic ⟦*N⟧ 後補空格;
  // 不動 ⟦N⟧ 後(slot 內容起始)與 ⟦/N⟧ 前(slot 內容結尾)。
  SK.ensureCJKSlotSpacing = function ensureCJKSlotSpacing(s) {
    return s
      .replace(/([一-鿿㐀-䶿])(⟦\*?\d+⟧)/g, '$1 $2')
      .replace(/(⟦[/*]\d+⟧)([一-鿿㐀-䶿])/g, '$1 $2');
  };

  SK.serializeFragmentWithPlaceholders = function serializeFragmentWithPlaceholders(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    const parent = unit.startNode && unit.startNode.parentElement;
    return serializeNodeIterable(nodes, {
      preserveNewlines: shouldPreserveTextNewlines(parent),
      // fragment 一律 clean-rebuild 注入,inline IMG(emoji)必須當 atomic slot 保留,
      // 否則透明展開後 emoji 從 source 流消失、注入譯文不含 emoji(見上方 IMG 區塊註解)。
      imgAsSlot: true,
    });
  };

  function serializeNodeIterable(topLevelNodes, opts) {
    const slots = [];
    let out = '';
    const preserveNewlines = !!(opts && opts.preserveNewlines);
    const imgAsSlot = !!(opts && opts.imgAsSlot);
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          // pre/pre-wrap/pre-line:textNode 內 \n 是視覺換行,轉  跟 BR 共用 sentinel,
          // 避開後續 /\s+/g collapse 把 \n 壓成 space。
          out += preserveNewlines
            ? child.nodeValue.replace(/\n/g, "")
            : child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // Inline <code> 在 HARD_EXCLUDE_TAGS 是給 walker 擋整個 code 區塊用的,
          // 但段落內 inline <code> 走到 serialize 已是另一條路徑,必須當 atomic
          // slot 保留(否則 GitHub PR description / 技術文章內的 <code>identifier</code>
          // 會被丟掉,grey background 樣式跟著消失)。必須先於 HARD_EXCLUDE 檢查。
          // PRE+code 仍然 continue(那是 code 區塊,跟 inline 不同)。
          if (child.tagName === 'CODE'
              && !(child.parentElement && child.parentElement.tagName === 'PRE')) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += PH_OPEN + '*' + idx + PH_CLOSE;
            continue;
          }
          // Inline <button>(段落內含 text 的 SPA「read more」/「show more」展開觸發
          // 按鈕,Medium 留言、X / 論壇截斷 preview 等)走 paired placeholder 保留
          // wrapper class 與 children 結構,內文走子節點遞迴翻譯。HARD_EXCLUDE_TAGS
          // 含 BUTTON 是給 walker 擋以 button 為主的 widget 用,段落內 inline 用法
          // 必須先於 HARD_EXCLUDE 開洞(同 inline CODE 例外模式)。
          //
          // reuseNode 標記:存原 button DOM node reference(不 cloneNode),deserialize
          // 時 reuse 原 node + 清 children 重填譯文,讓 React 18 root-level event
          // delegation 透過 button.__reactFiber$ 仍能找到 onClick handler — 點擊才能
          // 觸發框架展開動作。cloneNode(false) 會創新 node,失去 fiber/props 私有 key,
          // React 找不到 handler → click dead(實際使用者回報:Medium 留言「more」
          // 按鈕視覺保留但點下沒展開)。
          if (child.tagName === 'BUTTON' && SK.hasSubstantiveContent(child)) {
            const idx = slots.length;
            slots.push({ reuseNode: true, node: child });
            out += PH_OPEN + idx + PH_CLOSE;
            walk(child.childNodes);
            out += PH_OPEN + '/' + idx + PH_CLOSE;
            continue;
          }
          if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          if (child.tagName === 'PRE' && child.querySelector('code')) continue;
          if (child.tagName === 'BR') {
            out += '\u0001';
            continue;
          }
          // v1.10.15:fragment 路徑 IMG 走 atomic deep clone(保留 inline emoji,如
          // YouTube 留言的圖片 emoji)。IMG 沒 children,若不在此攔,走到下方
          // isPreservableInline = false → else walk(child.childNodes) 等於從 source text 流
          // 消失(emoji 整顆掉),fragment clean-rebuild 注入後譯文不含 emoji。atomic slot
          // 讓 LLM 看到 ⟦*N⟧ 不翻、deserialize 還原 IMG 在原位置。
          //
          // 只在 fragment 路徑(imgAsSlot=true)開:element 路徑維持 IMG 透明,因為
          // element 可能走 Layer A3 nodeValue-mutate 注入(content-inject.js gated by
          // kind !== 'fragment'),該路徑保留原 DOM、只改 text node 值,原 IMG 自然存活,
          // 且 v1.9.31 對齊邏輯靠「LLM 端 src/tgt 兩端 IMG 都不算 token」——element 路徑
          // 若多出 IMG slot 會破壞對齊 fallback dual(見 inject-a3-llm-img-emoji spec)。
          // fragment 一律 clean rebuild(injectFragmentTranslation),無此對齊顧慮。
          if (imgAsSlot && child.tagName === 'IMG') {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += PH_OPEN + '*' + idx + PH_CLOSE;
            continue;
          }
          if (SK.isAtomicPreserve(child)) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += PH_OPEN + '*' + idx + PH_CLOSE;
            continue;
          }
          if (SK.isPreservableInline(child)) {
            const idx = slots.length;
            const shell = child.cloneNode(false);
            slots.push(shell);
            out += PH_OPEN + idx + PH_CLOSE;
            walk(child.childNodes);
            out += PH_OPEN + '/' + idx + PH_CLOSE;
          } else {
            walk(child.childNodes);
          }
        }
      }
    }
    walk(topLevelNodes);
    const normalized = out
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/\u0001{3,}/g, '\u0001\u0001')
      .replace(/\u0001/g, '\n')
      .trim();
    return { text: normalized, slots };
  }

  // ─── 反序列化輔助函式 ─────────────────────────────────

  SK.collapseCjkSpacesAroundPlaceholders = function collapseCjkSpacesAroundPlaceholders(s) {
    if (!s) return s;
    const C = SK.CJK_CHAR;
    // 注意：用 [ \t]+ 而非 \s+，刻意保留 \n 不移除。
    // \n 代表原文有 <br> 換行（序列化時 <br> → \u0001 → \n），
    // 若用 \s+ 會把 ⟦/N⟧\n漢字 的 \n 吃掉，導致 <br> 無法還原（v1.4.4 修正）。
    s = s.replace(
      new RegExp('(' + C + ')[ \\t]+(' + PH_OPEN + '\\d+' + PH_CLOSE + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + PH_OPEN + '\\/\\d+' + PH_CLOSE + ')[ \\t]+(' + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + ')[ \\t]+(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')[ \\t]+(' + C + ')', 'g'),
      '$1$2'
    );
    return s;
  };

  SK.stripStrayPlaceholderMarkers = function stripStrayPlaceholderMarkers(s) {
    s = s.replace(new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'), '');
    s = s.replace(new RegExp('[\\*\\/]\\d+' + PH_CLOSE, 'g'), '');
    s = s.replace(new RegExp('[' + PH_OPEN + PH_CLOSE +
      SK.BRACKET_ALIASES_OPEN.join('') + SK.BRACKET_ALIASES_CLOSE.join('') + ']', 'g'), '');
    return s;
  };

  SK.normalizeLlmPlaceholders = function normalizeLlmPlaceholders(s) {
    if (!s) return s;
    for (const alias of SK.BRACKET_ALIASES_OPEN) {
      if (s.includes(alias)) s = s.split(alias).join(PH_OPEN);
    }
    for (const alias of SK.BRACKET_ALIASES_CLOSE) {
      if (s.includes(alias)) s = s.split(alias).join(PH_CLOSE);
    }
    // 若模型在佔位符標記內插入了多餘描述（如 ⟦0 drug⟧ → ⟦0⟧、⟦/0 drug⟧ → ⟦/0⟧），
    // 只保留前綴符號（*/?) 與數字，丟棄多餘文字。
    // 觸發情境：slot 內容涉及醫藥 / 術語時，模型會「加注」slot 代表的類別
    // （例如 ⟦0⟧ 對應 <strong>ファーストエイド用品（鎮痛剤...）</strong>，輸出 ⟦0 drug⟧）。
    // 修法：匹配「數字後有空白 + 非空白文字」的 pattern，統一清除（v1.4.5 修正）。
    s = s.replace(
      new RegExp(PH_OPEN + '\\s*(\\*?\\/?\\d+)[ \\t]+\\S[^' + PH_CLOSE + ']{0,28}' + PH_CLOSE, 'g'),
      PH_OPEN + '$1' + PH_CLOSE
    );
    return s.replace(
      new RegExp(PH_OPEN + '\\s*(\\*?\\/?\\d+)\\s*' + PH_CLOSE, 'g'),
      PH_OPEN + '$1' + PH_CLOSE
    );
  };

  SK.selectBestSlotOccurrences = function selectBestSlotOccurrences(text) {
    if (!text) return text;
    const re = new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE + '([\\s\\S]*?)' + PH_OPEN + '\\/\\1' + PH_CLOSE, 'g');
    const occurrences = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[2];
      const innerStripped = inner.replace(new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'), '').trim();
      occurrences.push({
        idx: Number(m[1]),
        start: m.index,
        end: m.index + m[0].length,
        inner: inner,
        nonEmpty: innerStripped.length > 0,
      });
    }
    if (occurrences.length === 0) return text;
    const byIdx = new Map();
    for (const o of occurrences) {
      if (!byIdx.has(o.idx)) byIdx.set(o.idx, []);
      byIdx.get(o.idx).push(o);
    }
    const losers = [];
    let dupSlotCount = 0;
    for (const [, list] of byIdx) {
      if (list.length === 1) continue;
      dupSlotCount++;
      let winner = list.find(o => o.nonEmpty);
      if (!winner) winner = list[0];
      for (const o of list) if (o !== winner) losers.push(o);
    }
    if (losers.length === 0) return text;
    losers.sort((a, b) => b.start - a.start);
    let out = text;
    for (const l of losers) {
      out = out.slice(0, l.start) + l.inner + out.slice(l.end);
    }
    SK.sendLog('info', 'translate', 'graceful dedup: dup_slots=' + dupSlotCount +
      ' losers_demoted=' + losers.length +
      ' preview=' + JSON.stringify(out.slice(0, 200)));
    return out;
  };

  // ─── 反序列化 ─────────────────────────────────────────

  SK.deserializeWithPlaceholders = function deserializeWithPlaceholders(translation, slots) {
    if (!translation) {
      return { frag: document.createDocumentFragment(), ok: false, matched: 0 };
    }

    translation = SK.normalizeLlmPlaceholders(translation);

    // v1.4.6 修正：Gemini 有時把換行指令解讀為「輸出字面 \n（反斜線 + n）」
    // 而非真正的換行符（U+000A）。pushText 用 clean.includes('\n') 偵測換行，
    // 字面 \n（兩字元：0x5C 0x6E）無法觸發，導致「\n」以兩個可見字元殘留 DOM。
    // 修法：在此統一把字面 \n（兩字元）轉換為真正換行符，再繼續後續流程。
    if (translation.includes('\\n')) {
      translation = translation.replace(/\\n/g, '\n');
    }

    translation = SK.collapseCjkSpacesAroundPlaceholders(translation);
    translation = SK.selectBestSlotOccurrences(translation);

    const matchedRef = { count: 0 };
    const frag = parseSegment(translation, slots, matchedRef);
    const ok = matchedRef.count > 0;
    return { frag, ok, matched: matchedRef.count };
  };

  // CJK 結尾 + Latin 開頭的邊界自動補空格(台灣排版慣例 + 下游 reader 擷取也需要)。
  // LLM 重組句子時常把 inline placeholder 周邊的空白吃掉,典型現象:
  //   原文「...rights ⟦1⟧https://...⟦/1⟧」(有 trailing space)
  //   LLM 譯成「...轉播權⟦1⟧https://...⟦/1⟧」(無 trailing space)
  //   deserialize 後 visual = 「轉播權https://...」(無 space)
  // 修法:append slot element 進 frag 之前,查 frag tail 結尾若 CJK + 此 slot 整段
  // textContent 開頭是 Latin,給 tail 補一個 space。
  function _cjkLatinTailEndsCjk(textValue) {
    return /[㐀-鿿豈-﫿ｦ-ﾟ]$/.test(textValue || '');
  }
  function _cjkLatinHeadStartsLatin(textValue) {
    const t = (textValue || '').replace(/^\s+/, '');
    return /^[A-Za-z0-9@#\-+/%&]/.test(t);
  }
  function _findTrailingTextNode(node) {
    let cur = node;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      if (cur.tagName === 'BR') return null;
      cur = cur.lastChild;
    }
    return cur && cur.nodeType === Node.TEXT_NODE ? cur : null;
  }
  function _maybePadCjkLatinSpace(frag, nextElement) {
    const last = frag.lastChild;
    if (!last) return;
    let tailText = '';
    if (last.nodeType === Node.TEXT_NODE) tailText = last.nodeValue || '';
    else if (last.nodeType === Node.ELEMENT_NODE) tailText = last.textContent || '';
    if (!tailText || /\s$/.test(tailText)) return;
    if (!_cjkLatinTailEndsCjk(tailText)) return;
    const headText = nextElement.textContent || '';
    if (!_cjkLatinHeadStartsLatin(headText)) return;
    if (last.nodeType === Node.TEXT_NODE) {
      last.nodeValue = tailText + ' ';
    } else {
      const trailing = _findTrailingTextNode(last);
      if (trailing) trailing.nodeValue = (trailing.nodeValue || '') + ' ';
    }
  }

  // v1.10.15:inline emoji IMG 前後補空格。collapseCjkSpacesAroundPlaceholders 會把
  // atomic marker(⟦*N⟧)兩側的 CJK 空格清掉——對腳註上標 / hr / inline code 這類
  // atomic 是對的(緊貼 CJK 才自然),但 emoji 圖跟前後文字貼死會擠成一團。只對 IMG
  // atomic 節點補:前面若非空白結尾補一格 + 後面固定補一格,讓 emoji 有呼吸空間。
  // 不影響其他 atomic 類型(它們不是 IMG)、也不影響 element 路徑(emoji 走 A3
  // nodeValue-mutate 保留原 DOM、不經此放置)。
  function _appendInlineImg(frag, imgNode) {
    const last = frag.lastChild;
    if (last) {
      let tail = last.nodeType === Node.TEXT_NODE ? (last.nodeValue || '') : (last.textContent || '');
      if (tail && !/\s$/.test(tail)) {
        if (last.nodeType === Node.TEXT_NODE) last.nodeValue = tail + ' ';
        else { const t = _findTrailingTextNode(last); if (t) t.nodeValue = (t.nodeValue || '') + ' '; }
      }
    }
    frag.appendChild(imgNode);
    frag.appendChild(document.createTextNode(' '));
  }

  function parseSegment(text, slots, matchedRef) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    const re = new RegExp(
      PH_OPEN + '(\\d+)' + PH_CLOSE + '([\\s\\S]*?)' + PH_OPEN + '\\/\\1' + PH_CLOSE
        + '|' + PH_OPEN + '\\*(\\d+)' + PH_CLOSE,
      'g'
    );

    function pushText(s) {
      if (!s) return;
      const clean = SK.stripStrayPlaceholderMarkers(s);
      if (!clean) return;
      if (clean.includes('\n')) {
        const parts = clean.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
          if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
        }
      } else {
        frag.appendChild(document.createTextNode(clean));
      }
    }

    let cursor = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > cursor) {
        pushText(text.slice(cursor, m.index));
      }
      if (m[3] !== undefined) {
        const idx = Number(m[3]);
        const slot = slots[idx];
        if (slot && slot.atomic && slot.node) {
          const cloned = slot.node.cloneNode(true);
          if (cloned.nodeType === Node.ELEMENT_NODE && cloned.tagName === 'IMG') {
            _appendInlineImg(frag, cloned);
          } else {
            _maybePadCjkLatinSpace(frag, cloned);
            frag.appendChild(cloned);
          }
          matchedRef.count++;
        }
      } else {
        const idx = Number(m[1]);
        const inner = m[2];
        const slot = slots[idx];
        if (slot && slot.reuseNode && slot.node) {
          // reuseNode 機制(目前用於 inline BUTTON):直接 reuse 原 DOM node,
          // 不 cloneNode → 原 node 上的 React private key(__reactFiber$ / __reactProps$)
          // 與 native listener 保留,React 18 root-level event delegation 仍能透過
          // fiber lookup 找到 onClick → 點擊才能觸發框架展開動作。
          //
          // 副作用考量:slot.node 此時仍是原 DOM tree 的成員,frag.appendChild 會把它
          // detach;後續 inject 階段 el.replaceChildren(frag) 會把它放回原 el(同 parent),
          // 等同 detach + re-attach。React fiber 對「同 node detach/re-attach」是寬容的,
          // event delegation 仍 work。LLM 重複輸出同 idx 的情況由 selectBestSlotOccurrences
          // 提前 dedup,parseSegment 看到時每個 idx 至多一次,不會出現「同 node 同時放
          // 兩處」的 DOM 例外。
          const reuse = slot.node;
          while (reuse.firstChild) reuse.removeChild(reuse.firstChild);
          const innerFrag = parseSegment(inner, slots, matchedRef);
          reuse.appendChild(innerFrag);
          _maybePadCjkLatinSpace(frag, reuse);
          frag.appendChild(reuse);
          matchedRef.count++;
        } else if (slot && slot.nodeType === Node.ELEMENT_NODE) {
          const shell = slot.cloneNode(false);
          const innerFrag = parseSegment(inner, slots, matchedRef);
          shell.appendChild(innerFrag);
          _maybePadCjkLatinSpace(frag, shell);
          frag.appendChild(shell);
          matchedRef.count++;
        } else if (slot && slot.atomic && slot.node) {
          const cloned = slot.node.cloneNode(true);
          if (cloned.nodeType === Node.ELEMENT_NODE && cloned.tagName === 'IMG') {
            _appendInlineImg(frag, cloned);
          } else {
            _maybePadCjkLatinSpace(frag, cloned);
            frag.appendChild(cloned);
          }
          matchedRef.count++;
        } else {
          const innerFrag = parseSegment(inner, slots, matchedRef);
          frag.appendChild(innerFrag);
        }
      }
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) {
      pushText(text.slice(cursor));
    }
    return frag;
  }

})(window.__SK);
