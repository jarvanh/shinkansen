// content-inject.js — Shinkansen DOM 注入
// 負責把翻譯結果注入回 DOM：resolveWriteTarget、injectIntoTarget、
// replaceNodeInPlace、replaceTextInPlace、plainTextFallback、fragment 注入。

(function(SK) {

  const STATE = SK.STATE;

  /**
   * 保證同一個 element 只快照一次原始 innerHTML。
   */
  SK.snapshotOnce = function snapshotOnce(el) {
    if (!STATE.originalHTML.has(el)) {
      STATE.originalHTML.set(el, el.innerHTML);
    }
  };

  /**
   * 「注入目標解析」——回答「要把譯文寫到哪個元素?」
   * 預設值是 el 本身。唯一例外：el 自己 computed font-size 趨近 0（MJML 模板）。
   */
  function resolveWriteTarget(el) {
    const win = el.ownerDocument?.defaultView;
    const cs = win?.getComputedStyle?.(el);
    const px = cs ? parseFloat(cs.fontSize) : NaN;
    if (Number.isFinite(px) && px < 1) {
      const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node === el) return NodeFilter.FILTER_SKIP;
            if (SK.isPreservableInline(node) || SK.isAtomicPreserve(node)) {
              return NodeFilter.FILTER_REJECT;
            }
            const dcs = win?.getComputedStyle?.(node);
            const dpx = dcs ? parseFloat(dcs.fontSize) : NaN;
            if (Number.isFinite(dpx) && dpx >= 1) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          },
        }
      );
      const found = walker.nextNode();
      if (found) return found;
    }
    return el;
  }

  /**
   * 「注入」helper——回答「要怎麼把譯文寫進 target?」
   * (A) Clean slate 預設：清空 target 後 append content。
   * (B) Media-preserving 例外：target 含媒體元素，且無 CONTAINER_TAGS 直屬子元素時，
   *     就地替換最長文字節點（保留媒體位置）。
   *     若 target 有 DIV/SECTION 等容器直屬子元素（如 vBulletin TD > DIV+HR+DIV），
   *     文字節點分散於不同結構子容器，media-preserving 路徑會把譯文塞進最長文字
   *     所在的子容器，導致其他結構元素（HR、標題 DIV）殘留在錯誤位置（HR 跑到標題上面）。
   *     這種情況改走 clean-slate，讓 deserialize 後的 fragment 依正確順序填入 target。
   *     （v1.4.14 修正 vBulletin 論壇貼文標題翻譯後分隔線位置顛倒）
   */
  function injectIntoTarget(target, content) {
    const isString = typeof content === 'string';

    // (B) 條件：含媒體 && target 無 CONTAINER_TAGS 直屬子元素
    const hasContainerChild = Array.from(target.children).some(c =>
      SK.CONTAINER_TAGS.has(c.tagName));
    if (SK.containsMedia(target) && !hasContainerChild) {
      // (B) media-preserving path
      if (!isString) {
        let fragHasBr = false;
        const fw = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
        let fn;
        while ((fn = fw.nextNode())) {
          if (fn.tagName === 'BR') { fragHasBr = true; break; }
        }
        if (fragHasBr) {
          const oldBrs = target.querySelectorAll('br');
          for (const br of oldBrs) if (br.parentNode) br.parentNode.removeChild(br);
        }
      }
      const node = isString ? target.ownerDocument.createTextNode(content) : content;
      const textNodes = SK.collectVisibleTextNodes(target);
      if (textNodes.length === 0) {
        target.appendChild(node);
        return;
      }
      const main = SK.findLongestTextNode(textNodes);
      for (const t of textNodes) {
        if (t === main) continue;
        t.nodeValue = '';
        // v1.2.2: 清空文字後，若父 inline 元素（如 <a>）因此變成空殼，向上逐層移除，
        // 避免留下看不見的空連結殼（Gmail Team Picks 連結消失 bug 的根因）
        let p = t.parentNode;
        while (p && p !== target) {
          if (p.textContent.trim() === '' && !SK.containsMedia(p)) {
            const gp = p.parentNode;
            if (!gp) break;
            gp.removeChild(p);
            p = gp;
          } else {
            break;
          }
        }
      }
      const parent = main.parentNode;
      if (parent) {
        parent.insertBefore(node, main);
        parent.removeChild(main);
      } else {
        target.appendChild(node);
      }
      return;
    }

    // (A) clean slate path
    while (target.firstChild) target.removeChild(target.firstChild);
    if (isString) {
      target.textContent = content;
    } else {
      target.appendChild(content);
    }
  }

  /**
   * 把含 \n 的純文字譯文做成 DocumentFragment。
   */
  function buildFragmentFromTextWithBr(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
    }
    return frag;
  }

  /**
   * slot 配對失敗 fallback 用的純文字注入。
   */
  function plainTextFallback(el, cleaned) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, cleaned);
  }

  /**
   * 無 slots 路徑的純文字注入。
   */
  function replaceTextInPlace(el, translation) {
    if (translation && translation.includes('\n')) {
      const frag = buildFragmentFromTextWithBr(translation);
      replaceNodeInPlace(el, frag);
      return;
    }
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, translation);
  }

  /**
   * slots 路徑的 fragment 注入。
   */
  function replaceNodeInPlace(el, frag) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, frag);
  }

  // ─── 主注入函式 ───────────────────────────────────────

  /**
   * ok=false fallback: LLM 丟掉佔位符時，嘗試從原始 DOM 找回 <a> slot 的文字，
   * 在譯文中重新定位並包回 <a> 標籤，還原連結結構。
   * 僅處理 <a> slot；slot 文字必須完整出現在譯文中才做，否則 return null。
   *
   * 範例（Dhruv Team Picks）：
   *   原文: "Dhruv's been having fun with this little ⟦0⟧Kodak Charmera⟦/0⟧ keychain."
   *   LLM 回: "Dhruv 最近都在玩這個超可愛的 Kodak Charmera 鑰匙圈。"  (slot 丟掉)
   *   → 找到 "Kodak Charmera" → frag: TEXT + A("Kodak Charmera") + TEXT
   */
  function tryRecoverLinkSlots(el, text, slots) {
    // 找出所有 <a> slot 的 index
    const linkSlotIdxs = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.nodeType === Node.ELEMENT_NODE && s.tagName === 'A') {
        linkSlotIdxs.push(i);
      }
    }
    if (linkSlotIdxs.length === 0) return null;

    // 從原始 DOM 取得每個 <a> 的原始文字（按 DOM 順序）
    const originalAnchors = Array.from(el.querySelectorAll('a'));

    let remaining = text;
    const parts = [];
    let anyFound = false;
    let slotPtr = 0;

    for (const anchor of originalAnchors) {
      const linkText = (anchor.textContent || '').trim();
      if (linkText.length < 2) continue; // 太短容易誤判
      const pos = remaining.indexOf(linkText);
      if (pos === -1) continue; // 找不到則跳過，不強行猜位置

      const matchIdx = linkSlotIdxs[slotPtr];
      if (matchIdx === undefined) continue;

      if (pos > 0) parts.push({ type: 'text', content: remaining.slice(0, pos) });
      parts.push({ type: 'link', content: linkText, slotIdx: matchIdx });
      remaining = remaining.slice(pos + linkText.length);
      anyFound = true;
      slotPtr++;
    }

    if (!anyFound) return null;
    if (remaining) parts.push({ type: 'text', content: remaining });

    // 建立 DocumentFragment
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.content) frag.appendChild(document.createTextNode(part.content));
      } else {
        const shell = slots[part.slotIdx].cloneNode(false);
        shell.appendChild(document.createTextNode(part.content));
        frag.appendChild(shell);
      }
    }
    return frag;
  }

  SK.injectTranslation = function injectTranslation(unit, translation, slots) {
    if (!translation) return;
    // v1.4.8: 統一在注入入口規範化字面 \n（反斜線+n，兩字元）→ 真正換行符（U+000A）。
    // v1.4.6 在 deserializeWithPlaceholders（有 slots 路徑）加了同樣的規範化，
    // 但 fragment no-slots / element no-slots 路徑完全繞過 deserializeWithPlaceholders，
    // 導致字面 \n 殘留可見 DOM 字元。在此入口統一處理，覆蓋所有後續路徑。
    if (translation.includes('\\n')) translation = translation.replace(/\\n/g, '\n');

    // v1.5.0: 雙語對照模式分派——dual 走 SK.injectDual 走另一條路徑。
    // 只 element 走得到 dual（fragment unit 結構特殊，dual 模式直接 fallback 走 single）。
    // 模式由 STATE.translatedMode 決定（translatePage 進入時依 settings.displayMode 設定）。
    if (STATE.translatedMode === 'dual' && unit.kind !== 'fragment' && SK.injectDual) {
      SK.injectDual(unit, translation, slots);
      return;
    }

    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const el = unit.el;
    SK.snapshotOnce(el);

    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        replaceNodeInPlace(el, frag);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, el.innerHTML);
        return;
      }
      const cleaned = SK.stripStrayPlaceholderMarkers(translation);
      // v1.2.3: ok=false 時，嘗試從原始 DOM 找回 <a> 連結文字並重建連結結構
      const recovered = tryRecoverLinkSlots(el, cleaned, slots);
      if (recovered) {
        replaceNodeInPlace(el, recovered);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, el.innerHTML);
        return;
      }
      plainTextFallback(el, cleaned);
      el.setAttribute('data-shinkansen-translated', '1');
      STATE.translatedHTML.set(el, el.innerHTML);
      return;
    }

    replaceTextInPlace(el, translation);
    el.setAttribute('data-shinkansen-translated', '1');
    STATE.translatedHTML.set(el, el.innerHTML);
  };

  function injectFragmentTranslation(unit, translation, slots) {
    if (!translation) return;
    const { el, startNode, endNode } = unit;

    if (!startNode || startNode.parentNode !== el) return;

    SK.snapshotOnce(el);

    let newContent;
    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        newContent = frag;
      } else {
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        newContent = document.createTextNode(cleaned);
      }
    } else {
      // v1.4.8: 無 slots 時也要把 \n 還原為 <br>（字面 \n 已在 injectTranslation 入口轉換完畢）
      if (translation.includes('\n')) {
        newContent = buildFragmentFromTextWithBr(translation);
      } else {
        newContent = document.createTextNode(translation);
      }
    }

    const anchor = endNode ? endNode.nextSibling : null;
    const toRemove = [];
    let cur = startNode;
    while (cur) {
      toRemove.push(cur);
      if (cur === endNode) break;
      cur = cur.nextSibling;
    }
    for (const n of toRemove) {
      if (n.parentNode === el) el.removeChild(n);
    }
    el.insertBefore(newContent, anchor);
  }

  // 暴露 resolveWriteTarget / injectIntoTarget 供 Debug API testInject 使用
  SK._resolveWriteTarget = resolveWriteTarget;
  SK._injectIntoTarget = injectIntoTarget;

  // ─── v1.5.0 雙語對照模式注入 ────────────────────────
  // 與 single 模式並列；single 走 SK.injectTranslation 的舊路徑，dual 走這裡。
  // 設計原則：
  //   1. 結構性判斷不綁站點/class（硬規則 §8）：依 tagName + computed display 決定 wrapper 形狀
  //   2. 不動原段落（原文保留），只在原段落旁/內附加 <shinkansen-translation> wrapper
  //   3. 透過既有 deserializeWithPlaceholders 重建譯文 inline 結構（連結、行內樣式都會保留）
  //   4. Content Guard 用 STATE.translationCache 追蹤 original → { wrapper, mode } 對應

  /** 找最近的 block 祖先（computed display ∈ BLOCK_DISPLAY_VALUES） */
  function findBlockAncestor(el) {
    const win = el.ownerDocument?.defaultView;
    let cur = el.parentElement;
    while (cur && cur !== el.ownerDocument.body) {
      const cs = win?.getComputedStyle?.(cur);
      if (cs && SK.BLOCK_DISPLAY_VALUES.has(cs.display)) return cur;
      cur = cur.parentElement;
    }
    return cur;  // body 或 null
  }
  // 暴露給 content-spa.js（Content Guard dual 分支）使用
  SK.findBlockAncestor = findBlockAncestor;

  /** 依原段落 tag 決定 wrapper 內部要用哪個 element + 是否需繼承 heading 字級 */
  function buildDualInner(originalTag, originalEl, translation, slots) {
    let innerTag;
    let copyHeadingStyle = false;
    if (/^H[1-6]$/.test(originalTag)) {
      innerTag = 'div';
      copyHeadingStyle = true;
    } else if (originalTag === 'LI' || originalTag === 'TD' || originalTag === 'TH') {
      innerTag = 'div';
    } else if (SK.BLOCK_TAGS_SET.has(originalTag) || originalTag === 'DIV' || originalTag === 'SECTION' || originalTag === 'ARTICLE' || originalTag === 'MAIN' || originalTag === 'ASIDE') {
      // 一般 block：保留原 tag（P, BLOCKQUOTE, DD, DT, FIGCAPTION, CAPTION, SUMMARY, PRE, FOOTER, DIV 等）
      innerTag = originalTag.toLowerCase();
    } else {
      // Inline 段落（SPAN/A/EM 等被偵測為段落時）
      innerTag = 'div';
    }
    const inner = document.createElement(innerTag);
    if (copyHeadingStyle) {
      const win = originalEl.ownerDocument?.defaultView;
      const cs = win?.getComputedStyle?.(originalEl);
      if (cs) {
        if (cs.fontSize)   inner.style.fontSize   = cs.fontSize;
        if (cs.fontWeight) inner.style.fontWeight = cs.fontWeight;
        if (cs.lineHeight) inner.style.lineHeight = cs.lineHeight;
      }
    }

    // 譯文內容：有 slots 走 deserializer 重建 inline 結構，否則純文字 / br fragment
    if (slots && slots.length > 0) {
      const result = SK.deserializeWithPlaceholders(translation, slots);
      if (result.ok) {
        inner.appendChild(result.frag);
      } else {
        // ok=false fallback：類似 single 路徑——盡力把連結 slot 還原回去
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        const recovered = tryRecoverLinkSlots(originalEl, cleaned, slots);
        if (recovered) {
          inner.appendChild(recovered);
        } else {
          inner.appendChild(document.createTextNode(cleaned));
        }
      }
    } else if (translation.includes('\n')) {
      inner.appendChild(buildFragmentFromTextWithBr(translation));
    } else {
      inner.appendChild(document.createTextNode(translation));
    }
    return inner;
  }

  /** 主入口：把譯文以雙語 wrapper 形式注入 DOM */
  SK.injectDual = function injectDual(unit, translation, slots) {
    if (!translation) return;
    // Fragment unit 結構特殊（虛擬段落 = 父容器內的「直接文字節點區段」），
    // 在 dual 模式下沒有清楚的「插在哪裡」答案——fallback 走 single 路徑。
    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const original = unit.el;
    if (!original || !original.parentNode) return;
    // 同一段已注入過就不要重複（SPA rescan 雙重觸發、Content Guard 觸發都會重打）
    if (original.hasAttribute('data-shinkansen-dual-source')) return;

    const tag = original.tagName;
    const inner = buildDualInner(tag, original, translation, slots);
    const wrapper = original.ownerDocument.createElement(SK.TRANSLATION_WRAPPER_TAG);
    const mark = SK.currentMarkStyle && SK.VALID_MARK_STYLES.has(SK.currentMarkStyle)
      ? SK.currentMarkStyle
      : SK.DEFAULT_MARK_STYLE;
    wrapper.setAttribute('data-sk-mark', mark);
    wrapper.appendChild(inner);

    let insertMode;
    if (tag === 'LI' || tag === 'TD' || tag === 'TH') {
      original.appendChild(wrapper);
      insertMode = 'append';
    } else if (
      SK.BLOCK_TAGS_SET.has(tag) ||
      tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN' || tag === 'ASIDE'
    ) {
      original.insertAdjacentElement('afterend', wrapper);
      insertMode = 'afterend';
    } else {
      // Inline 段落：往上找最近 block 祖先
      const blockAncestor = findBlockAncestor(original);
      if (blockAncestor && blockAncestor !== original.ownerDocument.body) {
        blockAncestor.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend-block-ancestor';
      } else {
        // 找不到合理祖先，掛在 inline 自身後（次佳）
        original.insertAdjacentElement('afterend', wrapper);
        insertMode = 'afterend';
      }
    }

    original.setAttribute('data-shinkansen-dual-source', '1');
    STATE.translationCache.set(original, { wrapper, insertMode });
  };

  /** 還原 dual 模式：移除所有 wrapper、清乾淨 attribute（restorePage 雙語分支用） */
  SK.removeDualWrappers = function removeDualWrappers() {
    const tag = SK.TRANSLATION_WRAPPER_TAG;
    document.querySelectorAll(tag).forEach(n => n.remove());
    document.querySelectorAll('[data-shinkansen-dual-source]').forEach(el => {
      el.removeAttribute('data-shinkansen-dual-source');
    });
  };

  /** 全域 wrapper 樣式注入（content.css 跨 host 行為不可靠，inline style 才能保證生效） */
  SK.ensureDualWrapperStyle = function ensureDualWrapperStyle() {
    if (document.getElementById('shinkansen-dual-style')) return;
    const tag = SK.TRANSLATION_WRAPPER_TAG;
    const style = document.createElement('style');
    style.id = 'shinkansen-dual-style';
    // 樣式設計原則：display:block 確保 wrapper 自成一行；mark 用 attribute selector 區分
    style.textContent =
      `${tag} { display: block; margin-top: 0.25em; }\n` +
      `${tag}[data-sk-mark="tint"]   { background-color: #FFF8E1; padding: 2px 4px; }\n` +
      `${tag}[data-sk-mark="bar"]    { border-left: 2px solid #9CA3AF; padding-left: 8px; }\n` +
      `${tag}[data-sk-mark="dashed"] { border-bottom: 1px dashed #9CA3AF; }\n` +
      `${tag}[data-sk-mark="none"]   {}\n`;
    (document.head || document.documentElement).appendChild(style);
  };

})(window.__SK);
