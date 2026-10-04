(function (global) {
  'use strict';

  let pdfjsPromise;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdfjs/pdf.mjs?v=20260912-pdf-reader1').then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs?v=20260912-pdf-reader1', document.baseURI).href;
        return pdfjs;
      });
    }
    return pdfjsPromise;
  }

  function supportsReadableStreamAsyncIteration() {
    const asyncIterator = typeof Symbol !== 'undefined' && Symbol.asyncIterator;
    return typeof global.ReadableStream !== 'undefined' && !!asyncIterator && typeof global.ReadableStream.prototype?.[asyncIterator] === 'function';
  }

  async function readTextContentFromReader(page, params = {}) {
    const readableStream = page.streamTextContent(params);
    if (!readableStream || typeof readableStream.getReader !== 'function') {
      throw new Error('当前浏览器不支持 PDF 文本流读取');
    }
    const reader = readableStream.getReader();
    const textContent = {
      items: [],
      styles: Object.create(null),
      lang: null
    };
    let completed = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        textContent.lang ??= value.lang;
        Object.assign(textContent.styles, value.styles);
        textContent.items.push(...(value.items || []));
      }
      completed = true;
      return textContent;
    } finally {
      if (!completed && typeof reader.cancel === 'function') {
        try { await reader.cancel(); } catch (_) {}
      }
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
  }

  async function getTextContentCompat(page, params = {}) {
    if (supportsReadableStreamAsyncIteration()) return page.getTextContent(params);
    return readTextContentFromReader(page, params);
  }

  const esc = value => String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function cleanText(value) {
    return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  }

  function resolvePageNumber(value, labels, pageCount) {
    const query = String(value || '').trim();
    if (!query) return null;
    const labelsIndex = (labels || []).findIndex(label => String(label || '').trim().toLowerCase() === query.toLowerCase());
    if (labelsIndex >= 0 && labelsIndex < pageCount) return labelsIndex + 1;
    if (/^\d+$/.test(query)) {
      const number = Number(query);
      if (number >= 1 && number <= pageCount) return number;
    }
    return null;
  }

  function fontInfo(page, item, styles) {
    let font = null;
    try {
      if (page.commonObjs && page.commonObjs.has(item.fontName)) font = page.commonObjs.get(item.fontName);
    } catch (_) {}
    const names = [font?.name, font?.loadedName, font?.fallbackName, styles?.[item.fontName]?.fontFamily].filter(Boolean).join(' ');
    return {
      italic: !!font?.italic || /(?:italic|oblique)/i.test(names),
      bold: font ? !!font.bold : /(?:bold|semibold|demibold)/i.test(names),
      styleInfoAvailable: !!font || /(?:italic|oblique|bold|times|arial|helvetica|courier)/i.test(names),
      fontName: font?.name || styles?.[item.fontName]?.fontFamily || item.fontName || ''
    };
  }

  function makeLine(pageNumber, pageLabel, pageWidth, pageHeight, seed) {
    return {
      page: pageNumber,
      pageLabel,
      pageWidth,
      pageHeight,
      y: seed.y,
      height: seed.height,
      lastX: seed.x,
      lastEndX: seed.x,
      text: '',
      html: '',
      italics: [],
      bolds: [],
      styleInfoAvailable: true,
      sourceSpans: []
    };
  }

  function appendItem(line, token) {
    const previous = line.text.slice(-1);
    const incoming = token.text.charAt(0);
    const gap = token.x - line.lastEndX;
    const em = Math.max(1, token.height || line.height || 10);
    const needsSpace = line.text && !/\s/.test(previous) && !/\s/.test(incoming) && gap > em * 0.16;
    if (needsSpace) {
      line.text += ' ';
      line.html += ' ';
    }
    const start = line.text.length;
    line.text += token.text;
    let html = esc(token.text);
    if (token.bold) html = '<strong>' + html + '</strong>';
    if (token.italic) html = '<em>' + html + '</em>';
    line.html += html;
    const end = line.text.length;
    if (token.italic) line.italics.push([start, end]);
    if (token.bold) line.bolds.push([start, end]);
    line.styleInfoAvailable = line.styleInfoAvailable && token.styleInfoAvailable;
    line.sourceSpans.push({
      start,
      end,
      page: token.page,
      pageLabel: token.pageLabel,
      x: token.x,
      y: token.y - token.height * 0.24,
      width: Math.max(token.width, token.height * 0.12),
      height: Math.max(token.height, 1)
    });
    line.lastX = token.x;
    line.lastEndX = token.x + token.width;
    line.height = Math.max(line.height, token.height);
  }

  function pageLines(page, pageNumber, pageLabel, textContent) {
    const viewport = page.getViewport({ scale: 1 });
    const lines = [];
    let current = null;
    const flush = () => {
      if (!current) return;
      current.text = current.text.trim();
      current.html = current.html.trim();
      if (current.text) lines.push(current);
      current = null;
    };
    for (const item of textContent.items || []) {
      if (!item || typeof item.str !== 'string') continue;
      const text = item.str.replace(/\s+/g, ' ');
      if (!text.trim()) {
        if (item.hasEOL) flush();
        continue;
      }
      const transform = item.transform || [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4]) || 0;
      const y = Number(transform[5]) || 0;
      const height = Math.max(1, Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0) || 10);
      const width = Math.max(0, Number(item.width) || 0);
      const style = fontInfo(page, item, textContent.styles || {});
      const token = { text, x, y, height, width, page: pageNumber, pageLabel, ...style };
      const sameLine = current && Math.abs(current.y - y) <= Math.max(2, Math.min(current.height, height) * 0.38) && x >= current.lastX - Math.max(current.height, height);
      if (!sameLine) {
        flush();
        current = makeLine(pageNumber, pageLabel, viewport.width, viewport.height, token);
      }
      appendItem(current, token);
      if (item.hasEOL) flush();
    }
    flush();
    return lines;
  }

  function stripRepeatedMargins(pages) {
    const occurrences = new Map();
    const normalized = line => cleanText(line.text).toLowerCase().replace(/\d+/g, '#');
    for (const lines of pages) {
      const seen = new Set();
      for (const line of lines) {
        const inMargin = line.y > line.pageHeight * 0.91 || line.y < line.pageHeight * 0.09;
        if (!inMargin) continue;
        const key = normalized(line);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        occurrences.set(key, (occurrences.get(key) || 0) + 1);
      }
    }
    const threshold = Math.max(2, Math.ceil(pages.length * 0.4));
    return pages.map(lines => lines.filter(line => {
      const inMargin = line.y > line.pageHeight * 0.91 || line.y < line.pageHeight * 0.09;
      if (!inMargin) return true;
      if (/^\s*(?:[ivxlcdm]+|\d+)\s*$/i.test(line.text)) return false;
      return (occurrences.get(normalized(line)) || 0) < threshold;
    }));
  }

  function combineLines(lines) {
    let text = '', html = '';
    const italics = [], bolds = [], sourceSpans = [];
    for (const line of lines) {
      if (!line?.text) continue;
      const separator = text && !/[-‐‑‒–—/]$/.test(text) ? ' ' : '';
      if (separator) { text += separator; html += separator; }
      const base = text.length;
      text += line.text;
      html += line.html;
      for (const [start, end] of line.italics || []) italics.push([start + base, end + base]);
      for (const [start, end] of line.bolds || []) bolds.push([start + base, end + base]);
      for (const span of line.sourceSpans || []) sourceSpans.push({ ...span, start: span.start + base, end: span.end + base });
    }
    const pages = [...new Set(sourceSpans.map(span => span.page))];
    return {
      text,
      rawText: text,
      html,
      italics,
      bolds,
      styleInfoAvailable: lines.filter(line => line?.text).every(line => line.styleInfoAvailable === true),
      page: pages[0] || null,
      pageEnd: pages[pages.length - 1] || pages[0] || null,
      pages,
      sourceSpans
    };
  }

  function documentFromLines(lines, pageCount, pageLabels) {
    const bounds = global.CitationReferenceSplitter?.findDocumentSectionBounds(lines, line => cleanText(line?.text)) || { found: false, headingIndex: -1, referenceStart: -1, referenceEnd: lines.length, appendixIndex: -1 };
    const bodyLines = bounds.found ? [...lines.slice(0, bounds.headingIndex), ...lines.slice(bounds.appendixIndex)] : [];
    const referenceLines = splitReferenceLines(bounds.found ? lines.slice(bounds.referenceStart, bounds.referenceEnd) : lines);
    const grouped = global.CitationReferenceSplitter?.groupReferenceLines(referenceLines, line => line?.text) || referenceLines.map(line => [line]);
    const bodyBlocks = bodyLines.map(line => combineLines([line]));
    const referenceBlocks = grouped.map(combineLines).filter(block => block.text);
    const body = bodyBlocks.map(block => block.text).join('\n');
    const references = referenceBlocks.map(block => block.text).join('\n\n');
    return {
      body,
      references,
      text: lines.map(line => line?.text || '').filter(Boolean).join('\n'),
      bodyBlocks,
      referenceBlocks,
      hasPageInfo: true,
      pageCount,
      pageLabels,
      styleInfoAvailable: [...bodyBlocks, ...referenceBlocks].some(block => block.styleInfoAvailable)
    };
  }

  function splitReferenceLines(lines) {
    return lines.flatMap(line => {
      const offsets = global.CitationReferenceSplitter?.referenceStartOffsets(line.text) || [];
      const cuts = [0, ...offsets.filter(offset => offset > 0), line.text.length];
      if (cuts.length === 2) return [line];
      return cuts.slice(0, -1).map((start, index) => {
        const end = cuts[index + 1];
        const raw = line.text.slice(start, end);
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const from = start + raw.indexOf(trimmed), to = from + trimmed.length;
        const clipRanges = ranges => (ranges || []).map(([s, e]) => [Math.max(s, from) - from, Math.min(e, to) - from]).filter(([s, e]) => e > s);
        const italics = clipRanges(line.italics), bolds = clipRanges(line.bolds);
        const boundaries = [...new Set([0, trimmed.length, ...italics.flat(), ...bolds.flat()])].sort((a, b) => a - b);
        const html = boundaries.slice(0, -1).map((s, i) => {
          const e = boundaries[i + 1];
          let segment = esc(trimmed.slice(s, e));
          if (italics.some(([a, b]) => a <= s && b >= e)) segment = '<em>' + segment + '</em>';
          if (bolds.some(([a, b]) => a <= s && b >= e)) segment = '<strong>' + segment + '</strong>';
          return segment;
        }).join('');
        const sourceSpans = (line.sourceSpans || []).flatMap(span => {
          const s = Math.max(span.start, from), e = Math.min(span.end, to);
          if (e <= s) return [];
          const length = span.end - span.start;
          return [{ ...span, start: s - from, end: e - from,
            x: span.x + span.width * (s - span.start) / length,
            width: span.width * (e - s) / length }];
        });
        return { ...line, text: trimmed, html, italics, bolds, sourceSpans };
      }).filter(Boolean);
    });
  }

  async function parse(file, onProgress) {
    if (!file) throw new Error('没有选择 PDF 文件');
    if (!/\.pdf$/i.test(file.name || '') && file.type !== 'application/pdf') throw new Error('请选择 .pdf 文件');
    const pdfjs = await loadPdfJs();
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjs.getDocument({ data: originalBytes.slice() });
    const pdf = await loadingTask.promise;
    const pageLabels = await pdf.getPageLabels().catch(() => null);
    const pages = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress?.(pageNumber, pdf.numPages);
      const page = await pdf.getPage(pageNumber);
      await page.getOperatorList({ intent: 'display' });
      const textContent = await getTextContentCompat(page);
      const lines = pageLines(page, pageNumber, pageLabels?.[pageNumber - 1] || String(pageNumber), textContent);
      characterCount += lines.reduce((sum, line) => sum + line.text.length, 0);
      pages.push(lines);
      page.cleanup();
    }
    if (characterCount < 20) {
      await loadingTask.destroy();
      throw new Error('未读取到可用文字。请确认 PDF 是由 Word 导出且未设置禁止读取或加密限制。');
    }
    const usefulLines = stripRepeatedMargins(pages).flat();
    const result = documentFromLines(usefulLines, pdf.numPages, pageLabels);
    result.pdfBytes = originalBytes;
    result.sourceType = 'pdf';
    await loadingTask.destroy();
    return result;
  }

  function createViewer(container) {
    let pdf = null, loadingTask = null, pdfjs = null, pageNumber = 1, zoom = 1, labels = null, selectedAnchor = null, renderSerial = 0;
    container.innerHTML = '<div class="pdf-source-toolbar"><button type="button" data-pdf-action="prev" aria-label="上一页">‹</button><label>第 <input type="text" inputmode="text" data-pdf-page-input value="1" aria-label="跳转到 PDF 页码"> / <b data-pdf-total>1</b> 页</label><button type="button" data-pdf-action="go" aria-label="跳转到页码">跳转</button><button type="button" data-pdf-action="next" aria-label="下一页">›</button><span data-pdf-page-label class="pdf-page-label"></span><span data-pdf-page-error class="pdf-page-error" role="status" aria-live="polite"></span><span class="pdf-toolbar-gap"></span><button type="button" data-pdf-action="out" aria-label="缩小">−</button><span data-pdf-zoom>100%</span><button type="button" data-pdf-action="in" aria-label="放大">＋</button></div><div class="pdf-page-stage"><div class="pdf-page-surface"><canvas></canvas><div class="pdf-text-layer textLayer"></div><div class="pdf-highlight-layer"></div></div></div>';
    let activeRenderTask = null;
    const pageInput = container.querySelector('[data-pdf-page-input]');
    const totalEl = container.querySelector('[data-pdf-total]');
    const pageLabelEl = container.querySelector('[data-pdf-page-label]');
    const pageErrorEl = container.querySelector('[data-pdf-page-error]');
    const zoomEl = container.querySelector('[data-pdf-zoom]');
    const stage = container.querySelector('.pdf-page-stage');
    const surface = container.querySelector('.pdf-page-surface');
    const canvas = container.querySelector('canvas');
    const textLayer = container.querySelector('.pdf-text-layer');
    const highlightLayer = container.querySelector('.pdf-highlight-layer');

    function clearPageError() {
      pageErrorEl.textContent = '';
      pageInput.removeAttribute('aria-invalid');
    }

    function updatePageControls() {
      pageInput.value = String(pageNumber);
      const label = labels?.[pageNumber - 1];
      pageLabelEl.textContent = label && label !== String(pageNumber) ? `文档页码：${label}` : '';
      clearPageError();
    }

    function showPageError(value) {
      pageErrorEl.textContent = `找不到页码“${String(value || '').trim()}”`;
      pageInput.setAttribute('aria-invalid', 'true');
    }

    async function goToPage(value) {
      if (!pdf) return false;
      const target = resolvePageNumber(value, labels, pdf.numPages);
      if (!target) { showPageError(value); return false; }
      pageNumber = target;
      await render();
      return true;
    }

    async function render() {
      if (!pdf) return;
      const serial = ++renderSerial;
      activeRenderTask?.cancel();
      const page = await pdf.getPage(pageNumber);
      if (serial !== renderSerial || !pdf) return;
      const available = Math.max(320, stage.clientWidth - 28);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1.6, available / base.width) * zoom;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      surface.style.width = viewport.width + 'px';
      surface.style.height = viewport.height + 'px';
      surface.style.setProperty('--total-scale-factor', String(scale));
      const context = canvas.getContext('2d', { alpha: false });
      const task = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      activeRenderTask = task;
      try { await task.promise; }
      catch (error) { if (error?.name === 'RenderingCancelledException') return; throw error; }
      finally { if (activeRenderTask === task) activeRenderTask = null; }
      if (serial !== renderSerial) return;
      textLayer.replaceChildren();
      const content = await getTextContentCompat(page);
      const layer = new pdfjs.TextLayer({ textContentSource: content, container: textLayer, viewport });
      await layer.render();
      if (serial !== renderSerial) return;
      highlightLayer.replaceChildren();
      highlightLayer.style.width = viewport.width + 'px';
      highlightLayer.style.height = viewport.height + 'px';
      const spans = (selectedAnchor?.sourceSpans || []).filter(span => span.page === pageNumber);
      for (const span of spans) {
        const p1 = viewport.convertToViewportPoint(span.x, span.y);
        const p2 = viewport.convertToViewportPoint(span.x + span.width, span.y + span.height);
        const rect = [p1[0], p1[1], p2[0], p2[1]];
        const marker = document.createElement('span');
        marker.className = 'pdf-source-highlight';
        marker.style.left = Math.min(rect[0], rect[2]) + 'px';
        marker.style.top = Math.min(rect[1], rect[3]) + 'px';
        marker.style.width = Math.max(3, Math.abs(rect[2] - rect[0])) + 'px';
        marker.style.height = Math.max(3, Math.abs(rect[3] - rect[1])) + 'px';
        highlightLayer.appendChild(marker);
      }
      totalEl.textContent = pdf.numPages;
      zoomEl.textContent = Math.round(zoom * 100) + '%';
      updatePageControls();
    }

    async function load(bytes, pageLabels) {
      searchPages = null;
      if (!bytes?.byteLength) return;
      if (loadingTask) await loadingTask.destroy();
      pdfjs = await loadPdfJs();
      labels = pageLabels || null;
      pageNumber = selectedAnchor?.page || selectedAnchor?.sourceSpans?.[0]?.page || 1;
      zoom = 1;
      loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes).slice() });
      pdf = await loadingTask.promise;
      pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber));
      totalEl.textContent = pdf.numPages;
      updatePageControls();
      await render();
    }

    let searchPages = null;
    async function search(query) {
      if (!pdf || !global.CitationDocumentSearch) return [];
      const document = pdf;
      if (!searchPages) {
        searchPages = (async () => {
          const blocks = [];
          for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            const content = await getTextContentCompat(page);
            blocks.push(combineLines(pageLines(page, number, labels?.[number - 1] || String(number), content)));
          }
          return blocks;
        })();
      }
      const blocks = await searchPages;
      if (pdf !== document) return [];
      return blocks.flatMap(block => global.CitationDocumentSearch.findMatches(block.text, query).map(match => ({
        page: block.page,
        sourceSpans: block.sourceSpans.filter(span => span.end > match.start && span.start < match.end),
        searchMatch: true
      })));
    }
    function clearSearch() {
      if (!selectedAnchor?.searchMatch) return;
      selectedAnchor = null;
      highlightLayer.replaceChildren();
    }

    async function locate(anchor) {
      if (!anchor) return;
      selectedAnchor = anchor;
      if (!pdf) return;
      const target = anchor.page || anchor.sourceSpans?.[0]?.page || 1;
      pageNumber = Math.max(1, Math.min(pdf.numPages, target));
      await render();
      stage.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    container.addEventListener('click', event => {
      const action = event.target.closest('[data-pdf-action]')?.dataset.pdfAction;
      if (!action || !pdf) return;
      if (action === 'prev') pageNumber = Math.max(1, pageNumber - 1);
      if (action === 'next') pageNumber = Math.min(pdf.numPages, pageNumber + 1);
      if (action === 'out') zoom = Math.max(0.6, zoom - 0.15);
      if (action === 'in') zoom = Math.min(2.5, zoom + 0.15);
      if (action === 'go') { goToPage(pageInput.value); return; }
      render();
    });

    pageInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      goToPage(pageInput.value);
    });

    async function destroy() {
      activeRenderTask?.cancel();
      searchPages = null;
      renderSerial++;
      if (loadingTask) await loadingTask.destroy();
      pdf = null;
      loadingTask = null;
      selectedAnchor = null;
      canvas.width = canvas.height = 0;
      textLayer.replaceChildren();
      highlightLayer.replaceChildren();
    }

    return { load, locate, search, clearSearch, goToPage, render, destroy, get pageNumber() { return pageNumber; } };
  }

  global.CitationPdfImporter = Object.freeze({ parse, createViewer, loadPdfJs, resolvePageNumber });
})(window);
