# Sample EPUBs

Test fixtures pulled from the [IDPF epub3-samples release 20230704](https://github.com/IDPF/epub3-samples/releases/tag/20230704). Each one exercises a different corner of the spec.

| File | What it stresses |
| --- | --- |
| `accessible_epub_3.epub` | Full accessibility metadata, ARIA, language attributes |
| `childrens-literature.epub` | Single huge XHTML chapter (343 KB), deeply nested TOC with `<span>` group labels |
| `childrens-media-query.epub` | CSS media queries for layout adaptation |
| `cole-voyage-of-life.epub` | Scripted/interactive content (carousel) |
| `epub30-spec.epub` | The EPUB 3 spec itself — large multi-chapter doc |
| `figure-gallery-bindings.epub` | EPUB bindings, embedded figures |
| `georgia-cfi.epub` | Canonical Fragment Identifier examples |
| `haruko-html-jpeg.epub` | Image-heavy manga (full-page JPEGs) |
| `hefty-water.epub` | Tiny minimal EPUB — quick parser smoke test |
| `internallinks.epub` | Heavy internal cross-linking between chapters |
| `linear-algebra.epub` | MathML content |
| `moby-dick.epub` | 144-chapter spine, classic novel |
| `mymedia_lite.epub` | Embedded audio/video |
| `quiz-bindings.epub` | Interactive quiz via bindings |
| `regime-anticancer-arabic.epub` | Right-to-left Arabic text |
| `svg-in-spine.epub` | SVG documents directly in spine |
| `trees.epub` | Small clean EPUB 3 — easy debugging |
| `wasteland.epub` | Small classic poem — baseline for typography tests |
| `wasteland-otf-obf.epub` | EPUB-obfuscated OTF fonts (covers our font de-obfuscation gap) |
