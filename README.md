# epub-reader

A rudimentary EPUB reader built from vanilla web platform primitives.
No build step, no npm dependencies, no frameworks.

**Live demo:** <https://profpowell.github.io/epub-reader/>

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

The app shell shows a "Try a sample" bar populated from
[`samples/demo.json`](samples/demo.json) — click any entry to load it
without opening a file picker. Deep links work too:
`?sample=moby-dick.epub` auto-loads on first paint.

## Live demo (GitHub Pages)

Pushes to `main` deploy the app to <https://profpowell.github.io/epub-reader/>
via [`.github/workflows/pages.yml`](.github/workflows/pages.yml). The
deploy artifact contains `index.html`, `src/`, and the demo sample subset
listed in `samples/demo.json` — the full 163 MB test-fixture set stays in
the repo for tests but isn't shipped to Pages.

To add or remove a demo sample, edit `samples/demo.json`. The next push
to `main` will rebuild the site with the updated set.

The Pages site must be enabled in the repository settings: **Settings →
Pages → Source: GitHub Actions**.

## Testing

The `samples/` directory contains the full IDPF EPUB 3 sample set
(release 20230704). `npm test` walks every sample through the reader in
headless Chromium and asserts that metadata, the spine, and the TOC
parse and that the first chapter renders without errors.

```sh
npm install
npx playwright install chromium  # once, to fetch the browser binary
npm test
```

Filter to a subset with `--grep`, e.g. `node tests/run-samples.mjs --grep moby`.

Known-failing samples (e.g. interactive bindings that need an unsandboxed
iframe) are listed in `tests/known-failures.json` so they don't make the
suite red. If a known-failure sample starts passing the runner reports it
as `XPASS` — remove the entry.

## Typechecking

The codebase ships as plain ES modules but is fully annotated with JSDoc
types and typechecked via the TypeScript compiler in `--checkJs` mode.
There's no build step — `tsc` only verifies, never emits.

```sh
npm run typecheck
```

`src/epub-reader.d.ts` is the consumer-facing declaration file. It
augments `HTMLElementTagNameMap` so TypeScript projects get strong types
out of `document.querySelector('epub-reader')`, plus typed `addEventListener`
overloads for `epub-loaded`, `epub-navigate`, and `epub-error`.

## Install

From npm (for use in another project):

```sh
npm install @profpowell/epub-reader
```

```js
import '@profpowell/epub-reader';
```

Or load directly from a CDN — no install, no bundler:

```html
<script type="module" src="https://unpkg.com/@profpowell/epub-reader/src/epub-reader.js"></script>
<epub-reader src="path/to/book.epub"></epub-reader>
```

## Component API

```html
<epub-reader src="path/to/book.epub"></epub-reader>
```

**Attributes**

- `src` — URL of an EPUB to auto-load.
- `start` — Spine index to open first (default `0`).
- `hide-toc` — Hide the table-of-contents sidebar by default.
- `allow-scripts` — Add `allow-scripts` to the chapter iframe's `sandbox`
  attribute so interactive EPUBs (quizzes, bindings, scripted carousels)
  run. **Off by default.** Combining `allow-scripts` with the reader's
  default `allow-same-origin` lets scripts in the chapter reach the
  parent document — only enable for content you trust.

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
