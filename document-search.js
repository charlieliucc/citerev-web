(function (global) {
  'use strict';
  function normalized(value) {
    let text = '', offset = 0;
    const starts = [], ends = [];
    for (const character of String(value || '')) {
      const end = offset + character.length;
      const lower = /\s/.test(character) ? ' ' : character.toLowerCase();
      if (lower === ' ' && text.endsWith(' ')) ends[ends.length - 1] = end;
      else {
        text += lower;
        for (let i = 0; i < lower.length; i++) { starts.push(offset); ends.push(end); }
      }
      offset = end;
    }
    return { text, starts, ends };
  }
  function findMatches(value, query) {
    const source = normalized(value);
    const needle = normalized(query).text.trim();
    const matches = [];
    if (!needle) return matches;
    let from = 0, index;
    while ((index = source.text.indexOf(needle, from)) >= 0) {
      matches.push({ start: source.starts[index], end: source.ends[index + needle.length - 1] });
      from = index + needle.length;
    }
    return matches;
  }
  function clear(root) {
    root?.querySelectorAll('.source-search-match').forEach(mark => {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    });
  }
  function highlight(root, query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node, text = '';
    while ((node = walker.nextNode())) {
      const start = text.length;
      text += node.nodeValue;
      nodes.push({ node, start, end: text.length });
    }
    const matches = findMatches(text, query).map(match => ({ ...match, elements: [] }));
    // 从后向前拆分文字，保留原文的斜体、链接和问题批注。
    for (const item of nodes.reverse()) {
      for (const match of [...matches].reverse()) {
        if (item.end <= match.start || item.start >= match.end) continue;
        const start = Math.max(match.start, item.start) - item.start;
        const end = Math.min(match.end, item.end) - item.start;
        const selected = item.node.splitText(start);
        selected.splitText(end - start);
        const mark = document.createElement('span');
        mark.className = 'source-search-match';
        selected.replaceWith(mark);
        mark.appendChild(selected);
        match.elements.unshift(mark);
      }
    }
    return matches;
  }
  global.CitationDocumentSearch = Object.freeze({ findMatches, highlight, clear });
})(window);
