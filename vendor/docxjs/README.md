Browser bundles used by CiteRev's local DOCX importer:

- `docx-preview.min.js`: `docx-preview` 0.4.1, Apache License 2.0.
- `jszip.min.js`: JSZip 3.10.1, MIT or GPLv3.

CiteRev uses JSZip under the MIT option. The full upstream license texts and copyright notices are retained alongside the bundles.
The `.txt` copies of the license files provide browser-readable links from CiteRev's About page.

The bundles are served from the same origin as CiteRev Web. No DOCX content is sent to a server. The importer uses docx-preview's `parseAsync` and adapts its parsed paragraphs to CiteRev's own data format. Because the upstream parsed document structure is experimental, update the pinned bundle and adapter together.

Upstream: https://github.com/VolodymyrBaydalka/docxjs and https://github.com/Stuk/jszip.
