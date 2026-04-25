# Sample EPUBs

The complete sample set from the [IDPF epub3-samples release 20230704](https://github.com/IDPF/epub3-samples/releases/tag/20230704). Each fixture exercises a different corner of the EPUB 3 spec.

| File | Size | What it stresses |
| --- | ---: | --- |
| `accessible_epub_3.epub` | 3.9 MB | Full accessibility metadata, ARIA roles, language attributes |
| `cc-shared-culture.epub` | 30 MB | Embedded video, large fixed-layout pages |
| `childrens-literature.epub` | 158 KB | Single huge XHTML chapter (343 KB), deeply nested TOC with `<span>` group labels |
| `childrens-media-query.epub` | 136 KB | CSS media queries for adaptive layout |
| `cole-voyage-of-life.epub` | 948 KB | Scripted carousel, fixed-layout spreads |
| `cole-voyage-of-life-tol.epub` | 979 KB | Same content with a different fixed-layout strategy |
| `epub30-spec.epub` | 222 KB | The EPUB 3 specification itself — long multi-chapter doc |
| `figure-gallery-bindings.epub` | 425 KB | EPUB bindings, embedded SVG figures |
| `georgia-cfi.epub` | 533 KB | Canonical Fragment Identifier examples |
| `georgia-pls-ssml.epub` | 534 KB | Pronunciation Lexicon and SSML markup |
| `GhV-oeb-page.epub` | 2.6 MB | OEB-page-map metadata for legacy page numbering |
| `haruko-ahl.epub` | 2.2 MB | Manga rendition with adaptive HTML layout |
| `haruko-html-jpeg.epub` | 2.1 MB | Manga as HTML pages embedding JPEGs |
| `haruko-jpeg.epub` | 2.2 MB | Manga as raw JPEG fixed-layout pages |
| `hefty-water.epub` | 3.6 KB | Tiny minimal EPUB — quick parser smoke test |
| `horizontally-scrollable-emakimono.epub` | 5 MB | Horizontal-scrolling continuous picture scroll |
| `indexing-for-eds-and-auths-3f.epub` | 1.6 MB | EPUB Indexes spec — full-form |
| `indexing-for-eds-and-auths-3md.epub` | 1.6 MB | EPUB Indexes spec — minimum-data form |
| `internallinks.epub` | 648 KB | Heavy internal cross-linking between chapters |
| `israelsailing.epub` | 1.3 MB | Fixed-layout illustrated content |
| `jlreq-in-english.epub` | 8 MB | Japanese typography requirements (JLReq) — English |
| `jlreq-in-japanese.epub` | 8 MB | JLReq — Japanese (vertical writing) |
| `kusamakura-japanese-vertical-writing.epub` | 17 MB | Vertical writing mode, Japanese ruby |
| `kusamakura-preview-embedded.epub` | 17 MB | Same with preview metadata |
| `kusamakura-preview.epub` | 9.5 MB | Preview-only Kusamakura |
| `linear-algebra.epub` | 1 MB | MathML content |
| `mahabharata.epub` | 11 MB | Long-form text with extensive Sanskrit glyphs |
| `moby-dick.epub` | 1.6 MB | 144-chapter spine, classic novel |
| `moby-dick-mo.epub` | 10 MB | Moby-Dick with EPUB Media Overlays (TTS sync) |
| `mymedia_lite.epub` | 261 KB | Embedded `<audio>` / `<video>` |
| `page-blanche.epub` | 3 MB | Fixed-layout French illustrated book |
| `page-blanche-bitmaps-in-spine.epub` | 3 MB | Same with bitmaps directly in spine |
| `quiz-bindings.epub` | 147 KB | Interactive quiz via EPUB bindings |
| `regime-anticancer-arabic.epub` | 108 KB | Right-to-left Arabic text |
| `sous-le-vent.epub` | 1.1 MB | French illustrated content |
| `sous-le-vent_svg-in-spine.epub` | 1.4 MB | SVG documents in spine |
| `svg-in-spine.epub` | 671 KB | SVG-only spine items |
| `trees.epub` | 74 KB | Small clean EPUB 3 — easy debugging |
| `vertically-scrollable-manga.epub` | 5.6 MB | Vertical-scrolling continuous manga |
| `wasteland.epub` | 99 KB | Small classic poem — typography baseline |
| `wasteland-otf.epub` | 726 KB | OTF web fonts (clear) |
| `wasteland-otf-obf.epub` | 728 KB | OTF web fonts (IDPF-obfuscated) |
| `wasteland-woff.epub` | 424 KB | WOFF web fonts (clear) |
| `wasteland-woff-obf.epub` | 424 KB | WOFF web fonts (IDPF-obfuscated) |
| `WCAG.epub` | 4.1 MB | WCAG 2.1 spec — large accessibility-focused doc |

## Using these in tests

`npm test` walks every file here through the reader and asserts that
metadata, the spine, and the TOC parse and that the first chapter renders
without errors. See `tests/run-samples.mjs`.
