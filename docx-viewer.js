/* Render the imported Word file with docx-preview and attach CiteRev comments
 * to its text nodes without replacing the document's layout or styles.
 */
(function (global) {
  'use strict';

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function findParagraph(paragraphs, text, start) {
    const needle = normalize(text);
    if (!needle) return -1;
    const prefix = needle.slice(0, Math.min(needle.length, 32));
    for (let i = start; i < paragraphs.length; i++) {
      const visible = normalize(paragraphs[i].textContent);
      if (visible === needle || visible.startsWith(needle) || (prefix.length >= 8 && visible.startsWith(prefix))) return i;
    }
    return -1;
  }

  function textPosition(haystack, needle, occurrence) {
    let from = 0, found = -1;
    for (let i = 0; i <= occurrence; i++) {
      found = haystack.indexOf(needle, from);
      if (found < 0) break;
      from = found + needle.length;
    }
    if (found >= 0) return [found, found + needle.length];
    const pattern = new RegExp(needle.trim().split(/\s+/).map(escapeRegExp).join('\\s+'), 'g');
    let match;
    for (let i = 0; (match = pattern.exec(haystack)); i++) {
      if (i === occurrence) return [match.index, match.index + match[0].length];
    }
    return null;
  }

  function markText(paragraph, quote, occurrence, id, className, title) {
    if (!quote) return false;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node, length = 0;
    while ((node = walker.nextNode())) {
      const start = length;
      length += node.nodeValue.length;
      nodes.push({ node, start, end: length });
    }
    const text = nodes.map(item => item.node.nodeValue).join('');
    const position = textPosition(text, quote, occurrence);
    if (!position) return false;
    const [start, end] = position;
    for (const item of nodes.reverse()) {
      if (item.end <= start || item.start >= end) continue;
      const localStart = Math.max(start, item.start) - item.start;
      const localEnd = Math.min(end, item.end) - item.start;
      const selected = item.node.splitText(localStart);
      selected.splitText(localEnd - localStart);
      const mark = document.createElement('span');
      mark.className = `hl docx-text-mark ${className}`;
      mark.dataset.cmid = id;
      mark.title = title || '';
      selected.replaceWith(mark);
      mark.appendChild(selected);
    }
    return true;
  }

  function footerPageFields(paragraph) {
    let visible = '';
    const fields = [];
    const stack = [];
    function visit(node) {
      if (!node || node.type === 'deleted') return;
      if (node.type === 'text') { visible += node.text || ''; return; }
      if (node.type === 'instruction') {
        if (stack.length) stack[stack.length - 1].instruction += node.text || '';
        return;
      }
      if (node.type === 'complexField') {
        if (node.charType === 'begin') stack.push({ instruction: '', start: null });
        else if (node.charType === 'separate' && stack.length) stack[stack.length - 1].start = visible.length;
        else if (node.charType === 'end' && stack.length) {
          const field = stack.pop();
          if (/^\s*PAGE(?:\s|\\|$)/i.test(field.instruction) && field.start != null && visible.length > field.start) {
            fields.push({ start: field.start, end: visible.length });
          }
        }
        return;
      }
      if (node.type === 'simpleField') {
        const start = visible.length;
        (node.children || []).forEach(visit);
        if (/^\s*PAGE(?:\s|\\|$)/i.test(node.instruction || '') && visible.length > start) {
          fields.push({ start, end: visible.length });
        }
        return;
      }
      (node.children || []).forEach(visit);
    }
    visit(paragraph);
    return { visible, fields };
  }

  function replaceTextRange(paragraph, start, end, replacement) {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node, cursor = 0, first = null, last = null;
    while ((node = walker.nextNode())) {
      const next = cursor + node.nodeValue.length;
      if (!first && start >= cursor && start < next) first = { node, offset: start - cursor };
      if (end > cursor && end <= next) { last = { node, offset: end - cursor }; break; }
      cursor = next;
    }
    if (!first || !last) return;
    if (first.node === last.node) {
      const value = first.node.nodeValue;
      first.node.nodeValue = value.slice(0, first.offset) + replacement + value.slice(last.offset);
      return;
    }
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
  }

  function updateFooterPageFields(container, documentModel) {
    const descriptors = [];
    for (const part of documentModel?.parts || []) {
      if (!/^word\/footer[^/]*\.xml$/i.test(part.path || '')) continue;
      function visit(node) {
        if (node?.type === 'paragraph') {
          const descriptor = footerPageFields(node);
          if (descriptor.fields.length) descriptors.push(descriptor);
        } else (node?.children || []).forEach(visit);
      }
      visit(part.rootElement);
    }
    if (!descriptors.length) return;
    [...container.querySelectorAll('section.docx')].forEach((sheet, index) => {
      sheet.querySelectorAll('footer p').forEach(paragraph => {
        const descriptor = descriptors.find(item => item.visible === paragraph.textContent);
        if (!descriptor) return;
        for (const field of [...descriptor.fields].sort((a, b) => b.start - a.start)) {
          replaceTextRange(paragraph, field.start, field.end, String(index + 1));
        }
      });
    });
  }

  function create(container) {
    let generation = 0;
    let rendered = false;
    let pendingAnnotations = null;

    function clearMarks() {
      container.querySelectorAll('.docx-text-mark').forEach(mark => {
        const parent = mark.parentNode;
        mark.replaceWith(...mark.childNodes);
        parent?.normalize();
      });
      container.querySelectorAll('.docx-reference-mark').forEach(paragraph => {
        paragraph.classList.remove('docx-reference-mark', 'hl', 'hl-unused', 'hl-format', 'hl-resolved', 'active', 'flash-hl');
        delete paragraph.dataset.cmid;
        delete paragraph.dataset.cmids;
      });
      container.querySelectorAll('[data-source-page]').forEach(paragraph => { delete paragraph.dataset.sourcePage; });
      container.querySelectorAll('[data-reference-index]').forEach(paragraph => { delete paragraph.dataset.referenceIndex; });
    }

    function applyAnnotations() {
      if (!rendered || !pendingAnnotations) return;
      clearMarks();
      const { bodyText, bodyParagraphs, bodyRanges, referenceBlocks, referenceMarks } = pendingAnnotations;
      const paragraphs = [...container.querySelectorAll('section.docx > article p')];
      const mappedBody = [];
      let bodyCursor = 0, textCursor = 0;
      for (const source of bodyParagraphs || []) {
        const index = findParagraph(paragraphs, source.displayText || source.text, bodyCursor);
        const start = bodyText.indexOf(source.text, textCursor);
        const end = start < 0 ? textCursor + source.text.length : start + source.text.length;
        mappedBody.push({ source, element: index < 0 ? null : paragraphs[index], start: start < 0 ? textCursor : start, end });
        if (index >= 0 && Number(source.page) > 0) paragraphs[index].dataset.sourcePage = String(source.page);
        textCursor = end;
        if (index >= 0) bodyCursor = index + 1;
      }
      let lastEnd = -1;
      for (const range of [...(bodyRanges || [])].sort((a, b) => a.s - b.s)) {
        if (range.s < lastEnd) continue;
        lastEnd = range.e;
        let found = false;
        for (const item of mappedBody) {
          if (!item.element || range.e <= item.start || range.s >= item.end) continue;
          const localStart = Math.max(0, range.s - item.start);
          const localEnd = Math.min(item.source.text.length, range.e - item.start);
          const quote = item.source.text.slice(localStart, localEnd);
          const preceding = item.source.text.slice(0, localStart);
          const occurrence = quote ? preceding.split(quote).length - 1 : 0;
          found = markText(item.element, quote, occurrence, range.id, range.cls, range.tip) || found;
        }
        if (!found) {
          const quote = bodyText.slice(range.s, range.e).trim();
          const note = [...container.querySelectorAll('section.docx > ol p, section.docx > footer p')].find(p => p.textContent.includes(quote));
          if (note) markText(note, quote, 0, range.id, range.cls, range.tip);
        }
      }

      let refCursor = 0;
      (referenceBlocks || []).forEach((block, index) => {
        const mark = referenceMarks?.[index];
        const candidate = String(block.text || '').slice(0, 32);
        const found = findParagraph(paragraphs, candidate, refCursor);
        if (found < 0) return;
        refCursor = found + 1;
        paragraphs[found].dataset.referenceIndex = String(index);
        if (Number(block.page) > 0) paragraphs[found].dataset.sourcePage = String(block.page);
        if (!mark?.id) return;
        const paragraph = paragraphs[found];
        paragraph.classList.add('hl', 'docx-reference-mark', ...mark.classes);
        paragraph.dataset.cmid = mark.id;
        paragraph.dataset.cmids = mark.ids;
      });
    }

    async function load(data) {
      const token = ++generation;
      rendered = false;
      const stage = document.createElement('div');
      stage.className = 'docx-render-stage';
      stage.textContent = '正在渲染 Word 原文档…';
      container.replaceChildren(stage);
      if (!global.docx?.renderAsync) throw new Error('Word 渲染模块未加载。');
      const documentModel = await global.docx.renderAsync(data, stage, null, {
        ignoreLastRenderedPageBreak: false,
        useBase64URL: true,
        renderAltChunks: false,
        renderComments: false
      });
      if (token !== generation) return;
      updateFooterPageFields(stage, documentModel);
      rendered = true;
      container.dataset.rendered = 'true';
      applyAnnotations();
    }

    return Object.freeze({
      load,
      annotate(annotations) { pendingAnnotations = annotations; applyAnnotations(); },
      clear() { generation++; rendered = false; pendingAnnotations = null; delete container.dataset.rendered; container.replaceChildren(); },
      get rendered() { return rendered; }
    });
  }

  global.CitationDocxViewer = Object.freeze({ create });
})(window);
