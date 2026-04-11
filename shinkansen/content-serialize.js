// content-serialize.js — Shinkansen 佔位符序列化/反序列化
// 負責把段落內的 inline 元素轉成 ⟦N⟧…⟦/N⟧ 佔位符（序列化），
// 以及把含佔位符的譯文還原成 DocumentFragment（反序列化）。

(function(SK) {

  const PH_OPEN = SK.PH_OPEN;
  const PH_CLOSE = SK.PH_CLOSE;

  // ─── 序列化 ───────────────────────────────────────────

  SK.serializeWithPlaceholders = function serializeWithPlaceholders(el) {
    return serializeNodeIterable(el.childNodes);
  };

  SK.serializeFragmentWithPlaceholders = function serializeFragmentWithPlaceholders(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    return serializeNodeIterable(nodes);
  };

  function serializeNodeIterable(topLevelNodes) {
    const slots = [];
    let out = '';
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          if (child.tagName === 'PRE' && child.querySelector('code')) continue;
          if (child.tagName === 'BR') {
            out += '\u0001';
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
    s = s.replace(
      new RegExp('(' + C + ')\\s+(' + PH_OPEN + '\\d+' + PH_CLOSE + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + PH_OPEN + '\\/\\d+' + PH_CLOSE + ')\\s+(' + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + ')\\s+(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')\\s+(' + C + ')', 'g'),
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
    translation = SK.collapseCjkSpacesAroundPlaceholders(translation);
    translation = SK.selectBestSlotOccurrences(translation);

    const matchedRef = { count: 0 };
    const frag = parseSegment(translation, slots, matchedRef);
    const ok = matchedRef.count > 0;
    return { frag, ok, matched: matchedRef.count };
  };

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
          frag.appendChild(slot.node.cloneNode(true));
          matchedRef.count++;
        }
      } else {
        const idx = Number(m[1]);
        const inner = m[2];
        const slot = slots[idx];
        if (slot && slot.nodeType === Node.ELEMENT_NODE) {
          const shell = slot.cloneNode(false);
          const innerFrag = parseSegment(inner, slots, matchedRef);
          shell.appendChild(innerFrag);
          frag.appendChild(shell);
          matchedRef.count++;
        } else if (slot && slot.atomic && slot.node) {
          frag.appendChild(slot.node.cloneNode(true));
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
