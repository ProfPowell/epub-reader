# epub-reader

A rudimentary EPUB reader built from vanilla web platform primitives.
No build step, no npm dependencies, no frameworks.

It ships in two forms:

1. **App** — `index.html` is a drop-in viewer with file picker, drag-and-drop,
   and keyboard navigation. It uses [Vanilla Breeze](https://github.com/ProfPowell/vanilla-breeze)
   (loaded from CDN) for the outer shell styling.
2. **Web component** — `<epub-reader src="book.epub">` can be embedded in any
   page. See `examples/embed.html`.

## How it works

Three small ES modules under `src/`:

| File | Responsibility |
| --- | --- |
| `zip.js` | Minimal ZIP reader. Parses the central directory; inflates `deflate` entries via the built-in [`DecompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream). |
| `epub.js` | Parses `META-INF/container.xml`, the OPF (metadata/manifest/spine), and the EPUB 3 nav document (with NCX fallback). Lazily builds `blob:` URLs for each resource, rewriting HTML/CSS references so chapter iframes can resolve their assets. |
| `epub-reader.js` | Defines the `<epub-reader>` custom element — Shadow DOM UI with a TOC sidebar, toolbar, and iframe-rendered content. Intercepts in-book link clicks and keyboard navigation. |

It follows the [EPUB 3.3 specification](https://www.w3.org/TR/epub-33/) for the
package, container, and navigation documents.

## Running

Browsers won't load ES modules from `file://`. Serve the folder over HTTP:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Component API

```html
<epub-reader src="path/to/book.epub"></epub-reader>
```

**Attributes**

- `src` — URL of an EPUB to auto-load.
- `start` — Spine index to open first (default `0`).
- `hide-toc` — Hide the table-of-contents sidebar by default.

**Methods**

- `open(source)` — Load from a URL, `File`, `Blob`, or `ArrayBuffer`.
- `close()` — Unload and revoke blob URLs.
- `next()` / `prev()` — Move through the spine.
- `goToIndex(i, fragment?)` — Jump to a spine index.
- `goToPath(pathOrHref)` — Jump to a manifest path (`chapter2.xhtml#sec1`).

**Events** (bubble, composed)

- `epub-loaded` — `{ metadata, spineLength, toc }`
- `epub-navigate` — `{ index, path, title }`
- `epub-error` — `{ error }`

**Styling**

The component uses `::part(toolbar | sidebar | content | iframe | title | progress | toc | overlay)`
for external theming, and respects Vanilla Breeze tokens
(`--vb-color-surface`, `--vb-color-text`, `--vb-color-primary`, etc.) when
present.

## Known limitations

- **No ZIP64 or encryption.** Also no EPUB font obfuscation — obfuscated fonts
  will fail to render, but the text remains legible.
- **Chapter-based paging only.** No pagination within a long chapter; scroll
  within the iframe to read long sections.
- **No persistence.** Reading position, bookmarks, and highlights are not saved.
- **Scripts in EPUB content are disabled** (iframe `sandbox="allow-same-origin"`).

## Browser support

Requires `DecompressionStream` (Chrome 80+/Firefox 113+/Safari 16.4+) and
native custom elements + Shadow DOM.
