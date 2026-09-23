/* DOCX import shared by the reviewer, verifier, reports, and workspace.
 * docx-preview 0.4.1 parses the package; this adapter keeps CiteRev's stable
 * paragraph/formatting contract separate from the library's internal model.
 */
(function (global) {
  'use strict';

  const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function styleResolver(document) {
    const styles = new Map((document.stylesPart?.styles || []).map(style => [style.id, style]));
    const defaults = [...styles.values()].filter(style => style.isDefault);
    function resolve(name, target, seen = new Set()) {
      if (!name || seen.has(name)) return {};
      seen.add(name);
      const style = styles.get(name);
      if (!style) return {};
      const base = resolve(style.basedOn, target, seen);
      for (const part of style.styles || []) {
        if (part.target === target) Object.assign(base, part.values || {});
      }
      return base;
    }
    const defaultRun = Object.assign({}, ...defaults.map(style => resolve(style.id, 'span')));
    return (paragraph, run) => ({
      ...defaultRun,
      ...resolve(paragraph.styleName, 'span'),
      ...resolve(run.styleName, 'span'),
      ...(run.cssStyle || {})
    });
  }

  function compactParagraph(parts, page, displayText) {
    const chars = [];
    for (const part of parts) {
      for (let i = 0; i < part.text.length; i++) {
        const char = part.text[i];
        if (/\s/.test(char)) {
          if (chars.length && chars[chars.length - 1].char !== ' ') chars.push({ char: ' ', italic: part.italic, bold: part.bold });
        } else chars.push({ char, italic: part.italic, bold: part.bold });
      }
    }
    if (chars[chars.length - 1]?.char === ' ') chars.pop();
    const text = chars.map(item => item.char).join('');
    const segments = [], italics = [], bolds = [];
    let html = '';
    for (let i = 0; i < chars.length;) {
      let end = i + 1;
      while (end < chars.length && chars[end].italic === chars[i].italic && chars[end].bold === chars[i].bold) end++;
      const segment = { text: text.slice(i, end), italic: chars[i].italic, bold: chars[i].bold };
      segments.push(segment);
      let markup = escapeHtml(segment.text);
      if (segment.bold) { bolds.push([i, end]); markup = `<strong>${markup}</strong>`; }
      if (segment.italic) { italics.push([i, end]); markup = `<em>${markup}</em>`; }
      html += markup;
      i = end;
    }
    return { text, rawText: text, displayText, segments, html, italics, bolds, page };
  }

  function noteText(note) {
    const parts = [];
    function visit(node) {
      if (!node) return;
      if (node.type === 'text') parts.push(node.text || '');
      else if (node.type === 'tab' || (node.type === 'break' && node.break === 'textWrapping')) parts.push(' ');
      else if (node.type !== 'deleted') (node.children || []).forEach(visit);
    }
    (note.children || []).forEach(visit);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function paragraphsFromDocument(document) {
    const root = document.documentPart?.body;
    if (!root?.children) throw new Error('未在 Word 文件中找到正文。');
    const notes = new Map((document.footnotesPart?.notes || []).map(note => [String(note.id), noteText(note)]));
    const runCss = styleResolver(document);
    const usedNotes = new Set();
    const paragraphs = [];
    let page = 1, hasPageInfo = false;

    function readParagraph(paragraph) {
      if (paragraph.pageBreakBefore) { page++; hasPageInfo = true; }
      let firstTextPage = null;
      const parts = [], displayParts = [];
      function add(text, style, inDocument = true) {
        if (!text) return;
        if (firstTextPage == null && /\S/.test(text)) firstTextPage = page;
        parts.push({ text, italic: style.italic, bold: style.bold });
        if (inDocument) displayParts.push(text);
      }
      function visit(node, style) {
        if (!node || node.type === 'deleted') return;
        if (node.type === 'run' || node.type === 'mmlRun') {
          const css = runCss(paragraph, node);
          style = {
            italic: css['font-style'] === 'italic',
            bold: css['font-weight'] === 'bold'
          };
        }
        switch (node.type) {
          case 'text': add(node.text || '', style); return;
          case 'tab': add(' ', style); return;
          case 'noBreakHyphen': add('-', style); return;
          case 'symbol': if (Number.isInteger(node.char)) add(String.fromCodePoint(node.char), style); return;
          case 'break':
            if (node.break === 'page' || node.break === 'lastRenderedPageBreak') {
              page++; hasPageInfo = true;
            } else add(' ', style);
            return;
          case 'footnoteReference': {
            const id = String(node.id);
            const note = notes.get(id);
            if (note) { usedNotes.add(id); add(` （脚注 ${id}：${note}） `, { italic: false, bold: false }, false); }
            return;
          }
          default: (node.children || []).forEach(child => visit(child, style));
        }
      }
      (paragraph.children || []).forEach(child => visit(child, { italic: false, bold: false }));
      const displayText = displayParts.join('').replace(/\s+/g, ' ').trim();
      const result = compactParagraph(parts, firstTextPage ?? page, displayText);
      if (result.text) paragraphs.push(result);
    }

    function visitBody(node) {
      if (node.type === 'paragraph') readParagraph(node);
      else if (node.type !== 'deleted') (node.children || []).forEach(visitBody);
    }
    root.children.forEach(visitBody);
    if (!hasPageInfo) paragraphs.forEach(paragraph => { paragraph.page = null; });
    return { paragraphs, hasPageInfo, footnoteCount: usedNotes.size };
  }

  async function parse(file) {
    if (!/\.docx$/i.test(file?.name || '')) throw new Error('目前仅支持 .docx；请先把旧版 .doc 转换为 .docx。');
    if (!global.docx?.parseAsync) throw new Error('Word 解析模块未加载。');
    try {
      return paragraphsFromDocument(await global.docx.parseAsync(file));
    } catch (error) {
      if (error?.message?.includes('未在 Word 文件中找到正文')) throw error;
      throw new Error('无法解析 DOCX 文件：' + (error?.message || error));
    }
  }

  global.CitationDocxImporter = Object.freeze({ parse });
})(window);
