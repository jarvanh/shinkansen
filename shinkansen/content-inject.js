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
   * (B) Media-preserving 例外：target 含媒體元素時，就地替換最長文字節點。
   */
  function injectIntoTarget(target, content) {
    const isString = typeof content === 'string';

    if (SK.containsMedia(target)) {
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
      for (const t of textNodes) if (t !== main) t.nodeValue = '';
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

  SK.injectTranslation = function injectTranslation(unit, translation, slots) {
    if (!translation) return;
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
      newContent = document.createTextNode(translation);
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

})(window.__SK);
