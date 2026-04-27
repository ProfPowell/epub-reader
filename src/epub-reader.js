// <epub-reader> custom element. Wraps the EPUB parser in a UI with a
// sidebar TOC, a toolbar, and an iframe rendering the current spine item.
// Renders in light DOM so Vanilla Breeze tokens (--color-surface, --color-text,
// --color-interactive, etc.) and themes cascade in. Chapter content stays in
// a sandboxed iframe for publisher-CSS isolation.
//
// The chrome borrows Vanilla Breeze's <reader-view> conventions (.reader-chrome,
// .reader-controls, .reader-control-group, .reader-icon-btn) so the reader
// blends in on a VB-themed host page even without VB CSS loaded — fallback
// values on every var() keep it usable bare.
//
// Attributes:
//   src          URL of an EPUB to auto-load.
//   start        Spine index to open first (default 0).
//   hide-toc     If present, hides the TOC sidebar by default.
//
// Methods:
//   open(src)        Load an EPUB from URL, File, Blob, or ArrayBuffer.
//   close()          Unload the current book and revoke blob URLs.
//   next() / prev()  Move to the next/previous spine item.
//   goToIndex(i)     Jump to a spine index (with optional fragment).
//   goToPath(path)   Jump to a manifest path (with optional #fragment).
//
// Events:
//   epub-loaded      detail: { metadata, spineLength, toc }
//   epub-navigate    detail: { index, path, title }
//   epub-error       detail: { error }

import { openEpub } from './epub.js';
import { dbGet, dbPut, dbDelete, dbGetAll, dbClear } from './storage.js';
import { findOffsets, plainText, rangeFromOffsets, wrapRange, unwrapAll, offsetsFromRange } from './range-utils.js';
/** @typedef {import('./epub.js').EpubBook} EpubBook */
/** @typedef {import('./epub.js').TocEntry} TocEntry */

/**
 * One user bookmark within a book.
 *
 * @typedef {object} Bookmark
 * @property {string} id              Stable random id for diffing/removal.
 * @property {number} spineIndex
 * @property {number} scrollFraction  0..1 within the chapter.
 * @property {string} chapterTitle    Captured at create time (TOC label).
 * @property {string} label           Optional user-supplied label.
 * @property {string} snippet         ~120 chars of surrounding text.
 * @property {number} createdAt       `Date.now()` at create time.
 */

/**
 * One user highlight. Position is captured as (start, end) char
 * offsets into the chapter body's plain text via range-utils, which
 * survives publisher CSS shuffling and is far simpler than CFI.
 *
 * @typedef {object} Highlight
 * @property {string} id           Stable random id.
 * @property {number} spineIndex
 * @property {number} startOffset  Char offset (inclusive).
 * @property {number} endOffset    Char offset (exclusive).
 * @property {string} text         Snapshot of the highlighted text (≤200 chars).
 * @property {string} color        CSS colour (one of the popover swatches by default).
 * @property {string} note         Optional user note.
 * @property {number} createdAt
 */

/**
 * One stored library entry. The whole record (including the source
 * blob) lives in IndexedDB so the user doesn't need to re-pick the
 * file to keep reading.
 *
 * @typedef {object} LibraryEntry
 * @property {string}     id            Same shape as EpubBook.bookId().
 * @property {string}     title
 * @property {string}     creator
 * @property {string}     identifier    dc:identifier from the OPF (may be empty).
 * @property {Blob}       blob          Original EPUB bytes.
 * @property {Blob | null} cover        Cover image blob (may be null).
 * @property {number}     size          blob.size, denormalised for cheap reads.
 * @property {number}     addedAt
 * @property {number}     lastOpenedAt
 */

/**
 * Persisted reading-position record stored under
 * IndexedDB(epub-reader).positions[bookId].
 *
 * @typedef {object} ReadingPosition
 * @property {string} id              Book identifier (`id:...` or `sha:...`).
 * @property {number} spineIndex      Spine index of the chapter when saved.
 * @property {number} scrollFraction  0..1 within the chapter (scroll mode).
 * @property {number} updatedAt       `Date.now()` at save time.
 */

/**
 * @typedef {object} ReaderElements
 * @property {HTMLDivElement}      shell
 * @property {HTMLSpanElement}     title
 * @property {HTMLSpanElement}     progress
 * @property {HTMLSpanElement}     chapterProgress
 * @property {HTMLButtonElement}   prev
 * @property {HTMLButtonElement}   next
 * @property {HTMLButtonElement}   toggle
 * @property {HTMLButtonElement}   settingsToggle
 * @property {HTMLElement}         sidebar
 * @property {HTMLOListElement}    toc
 * @property {HTMLIFrameElement}   iframe
 * @property {HTMLDivElement}      overlay
 * @property {HTMLElement}         settingsPanel
 * @property {HTMLButtonElement}   fontDecrease
 * @property {HTMLButtonElement}   fontIncrease
 * @property {HTMLSelectElement}   sFontFamily
 * @property {HTMLInputElement}    sFontSize
 * @property {HTMLInputElement}    sLineHeight
 * @property {HTMLInputElement}    sParagraphSpacing
 * @property {HTMLInputElement}    sJustify
 * @property {HTMLInputElement}    sReadingWidth
 * @property {HTMLSpanElement}     sFontSizeV
 * @property {HTMLSpanElement}     sLineHeightV
 * @property {HTMLSpanElement}     sParagraphSpacingV
 * @property {HTMLSpanElement}     sReadingWidthV
 * @property {HTMLButtonElement}   sLayoutScroll
 * @property {HTMLButtonElement}   sLayoutPaginated
 * @property {HTMLTextAreaElement} sUserCss
 * @property {HTMLButtonElement}   sReset
 * @property {HTMLButtonElement}   sClose
 * @property {HTMLButtonElement}   bookmarksToggle
 * @property {HTMLElement}         bookmarksPanel
 * @property {HTMLButtonElement}   bmAdd
 * @property {HTMLButtonElement}   bmClose
 * @property {HTMLOListElement}    bmList
 * @property {HTMLButtonElement}   libraryToggle
 * @property {HTMLElement}         libraryPanel
 * @property {HTMLOListElement}    libList
 * @property {HTMLElement}         libQuota
 * @property {HTMLButtonElement}   libClear
 * @property {HTMLButtonElement}   libClose
 * @property {HTMLElement}         findBar
 * @property {HTMLInputElement}    findInput
 * @property {HTMLSpanElement}     findCount
 * @property {HTMLButtonElement}   findPrev
 * @property {HTMLButtonElement}   findNext
 * @property {HTMLButtonElement}   findClose
 * @property {HTMLButtonElement}   searchToggle
 * @property {HTMLElement}         searchPanel
 * @property {HTMLInputElement}    searchInput
 * @property {HTMLElement}         searchStatus
 * @property {HTMLOListElement}    searchResults
 * @property {HTMLButtonElement}   searchClose
 * @property {HTMLButtonElement}   highlightsToggle
 * @property {HTMLElement}         highlightsPanel
 * @property {HTMLOListElement}    hlList
 * @property {HTMLButtonElement}   hlPanelClose
 * @property {HTMLElement}         hlPopover
 */

/**
 * Typography + layout overrides applied to chapter content. Sentinel
 * values mean "publisher default" (no rule emitted): empty string for
 * `fontFamily`, 0 for `lineHeight`, -1 for `paragraphSpacing`,
 * `null` for `justify`, 0 for `readingWidth`.
 *
 * @typedef {object} TypographySettings
 * @property {string}                  fontFamily
 * @property {number}                  fontSize           Percent, default 100.
 * @property {number}                  lineHeight         0 = default.
 * @property {number}                  paragraphSpacing   -1 = default; else em.
 * @property {boolean | null}          justify
 * @property {number}                  readingWidth       Max content width in
 *                                                        ch; 0 = unlimited.
 *                                                        Default 65.
 * @property {'scroll' | 'paginated'}  layoutMode         Reflowable layout
 *                                                        mode (default 'scroll').
 * @property {string}                  userCss            Power-user CSS
 *                                                        appended to the
 *                                                        chapter stylesheet
 *                                                        after sanitisation.
 */

const TYPOGRAPHY_KEY = 'epub-reader:typography';

/** @returns {TypographySettings} */
function defaultTypography() {
  return {
    fontFamily: '',
    fontSize: 100,
    lineHeight: 0,
    paragraphSpacing: -1,
    justify: null,
    readingWidth: 65,
    layoutMode: 'scroll',
    userCss: '',
  };
}

/**
 * Strip CSS authoring constructs that have no place in a user stylesheet
 * applied to chapter content. We can't fully sanitise CSS, but blocking
 * the obvious vectors is cheap:
 *   - HTML tag chars  -> illegal in CSS, almost always a paste mistake.
 *   - @import         -> would let the user load arbitrary remote URLs.
 *   - expression(...) -> legacy IE attack surface; ignored by modern
 *                        browsers but still worth flagging.
 *   - behavior:       -> legacy IE, same reasoning.
 *
 * @param {string} css
 * @returns {string}
 */
function sanitiseUserCss(css) {
  if (!css) return '';
  return String(css)
    .replace(/[<>]/g, '')
    .replace(/@import\b[^;]*;?/gi, '/* @import blocked */')
    .replace(/\bexpression\s*\(/gi, '/*expression(*/')
    .replace(/\bbehavior\s*:/gi, '/*behavior:*/');
}

/** @returns {TypographySettings} */
function loadTypography() {
  try {
    const raw = globalThis.localStorage?.getItem(TYPOGRAPHY_KEY);
    if (!raw) return defaultTypography();
    const parsed = JSON.parse(raw);
    return { ...defaultTypography(), ...parsed };
  } catch { return defaultTypography(); }
}

/** @param {TypographySettings} t */
function saveTypography(t) {
  try { globalThis.localStorage?.setItem(TYPOGRAPHY_KEY, JSON.stringify(t)); }
  catch { /* private mode, quota, etc. */ }
}

/** Build the CSS that overrides publisher typography for one chapter. */
function buildTypographyCss(/** @type {TypographySettings} */ t) {
  /** @type {string[]} */
  const rules = [];
  if (t.fontSize !== 100) {
    rules.push(`html, body { font-size: ${t.fontSize}% !important; }`);
  }
  if (t.fontFamily) {
    rules.push(`body, p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6 { font-family: ${t.fontFamily} !important; }`);
    // Don't override math glyphs — MathML relies on the math font.
    rules.push(`math, math * { font-family: revert !important; }`);
  }
  if (t.lineHeight > 0) {
    rules.push(`body, p, li, blockquote { line-height: ${t.lineHeight / 100} !important; }`);
  }
  if (t.paragraphSpacing >= 0) {
    rules.push(`p, li { margin-block-end: ${t.paragraphSpacing / 10}em !important; }`);
  }
  if (t.justify !== null) {
    rules.push(`body, p { text-align: ${t.justify ? 'justify' : 'start'} !important; }`);
  }
  if (t.readingWidth > 0) {
    // Pin a max measure on the chapter body and centre it. Padding-inline
    // ensures comfortable gutters even when the viewport equals the
    // measure exactly.
    rules.push(`body { max-inline-size: ${t.readingWidth}ch !important; margin-inline: auto !important; padding-inline: clamp(0.75rem, 3vw, 2rem) !important; }`);
  }
  // User CSS comes last so it overrides any of the curated rules above.
  const user = sanitiseUserCss(t.userCss);
  if (user) rules.push(`/* --- user css --- */\n${user}`);
  return rules.join('\n');
}



// Component CSS, scoped via @scope so it never leaks beyond <epub-reader>.
// All colours / sizes / radii read Vanilla Breeze tokens with sensible
// fallbacks, so the component is themable when VB is loaded and usable
// (if plainer) when it isn't.
// Stylesheet injected into every chapter iframe. Styles the wrappers
// emitted by range-utils for find (#17), search (#16), and highlights
// (#15). Kept minimal — one rule per kind, distinct visuals, no
// publisher-CSS conflicts.
const MARKS_CSS = `
[data-reader-mark="find"] {
  background: #fde68a !important;
  color: inherit !important;
  border-radius: 2px;
  padding: 0 1px;
}
[data-reader-mark="find"].current {
  background: #f59e0b !important;
  outline: 2px solid #f59e0b;
}
[data-reader-mark="search"] {
  background: color-mix(in srgb, #2d6cdf 25%, transparent) !important;
  color: inherit !important;
  border-radius: 2px;
}
[data-reader-mark="highlight"] {
  background: var(--reader-hl-color, #fde68a) !important;
  color: inherit !important;
  border-radius: 2px;
  cursor: pointer;
}
`;

const COMPONENT_CSS = `
@scope (epub-reader) {
  :scope {
    display: grid;
    grid-template-rows: auto 1fr;
    block-size: 100%;
    min-block-size: 20rem;
    background: var(--color-background, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    container-type: inline-size;
  }

  .reader-chrome {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--size-m, 1rem);
    padding-inline: max(var(--size-m, 1rem), env(safe-area-inset-left))
                    max(var(--size-m, 1rem), env(safe-area-inset-right));
    block-size: var(--_reader-chrome-h, 3.625rem);
    background: var(--color-surface, #f5f5f5);
    border-block-end: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    position: relative;
    z-index: 2;
  }
  .reader-chrome-copy { min-inline-size: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .reader-chrome-kicker {
    font-size: var(--font-size-2xs, 0.625rem);
    font-weight: var(--font-weight-semibold, 600);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-text-muted, #888);
  }
  .reader-chrome-title {
    font-size: var(--font-size-xs, 0.75rem);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted, #888);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .reader-controls {
    display: flex; align-items: center;
    gap: var(--size-s, 0.75rem);
    min-inline-size: 0; overflow-x: auto; scrollbar-width: none;
  }
  .reader-controls::-webkit-scrollbar { display: none; }
  .reader-control-group {
    display: inline-flex; align-items: center;
    gap: var(--size-3xs, 0.125rem);
    padding: var(--size-3xs, 0.125rem);
    background: var(--color-surface-raised, rgba(0, 0, 0, 0.04));
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-full, 999px);
    flex: 0 0 auto;
  }
  .reader-icon-btn, .reader-seg-btn {
    border: 0;
    background: transparent;
    color: var(--color-text-muted, #667085);
    cursor: pointer;
    border-radius: var(--radius-full, 999px);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-semibold, 600);
    transition: color 140ms ease, background 140ms ease;
  }
  .reader-icon-btn {
    inline-size: 2.1rem; block-size: 2.1rem;
    display: inline-grid; place-items: center;
    font-size: var(--font-size-xs, 0.75rem);
  }
  .reader-icon-btn:hover:not(:disabled),
  .reader-seg-btn:hover:not(:disabled) {
    color: var(--color-text, #222);
    background: var(--color-surface-raised, rgba(0, 0, 0, 0.06));
  }
  .reader-icon-btn:disabled, .reader-seg-btn:disabled { opacity: .28; cursor: default; }
  .reader-icon-btn[aria-pressed="true"], .reader-seg-btn[data-reader-state="active"] {
    color: var(--color-interactive-text, #fff);
    background: var(--color-interactive, #2d6cdf);
  }
  .progress {
    color: var(--color-text-muted, #667085);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-2xs, 0.7rem);
    padding-inline: var(--size-2xs, 0.35rem);
    min-inline-size: 3rem;
    text-align: center;
  }
  .chapter-progress {
    color: var(--color-text-muted, #888);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-2xs, 0.65rem);
    padding-inline: 0.25rem;
    min-inline-size: 2.5rem;
    text-align: center;
    opacity: .8;
  }
  .chapter-progress[hidden] { display: none; }
  .title { /* alias for the chrome title; kept for tests/CSS hooks */ }

  .body {
    display: grid;
    grid-template-columns: var(--_sidebar-w, 18rem) 1fr;
    min-block-size: 0;
    overflow: hidden;
  }
  :scope([hide-toc]) .body, .body.toc-hidden { grid-template-columns: 0 1fr; }
  :scope([hide-toc]) .sidebar, .body.toc-hidden .sidebar { display: none; }

  .sidebar {
    overflow: auto;
    border-inline-end: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    padding: var(--size-2xs, 0.5rem);
    background: var(--color-surface, #fbfaf7);
  }
  .sidebar h2 {
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
    margin: 0.25rem 0.25rem 0.5rem;
  }
  .toc, .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc ol { padding-inline-start: 0.75rem; border-inline-start: 1px solid var(--color-border, #e4e4e7); margin-block: 0.25rem; }
  .toc a {
    display: block; padding: 0.3rem 0.5rem; border-radius: 0.25rem;
    color: inherit; text-decoration: none; line-height: 1.3;
    font-size: var(--font-size-s, 0.9rem);
  }
  .toc a:hover { background: color-mix(in srgb, var(--color-interactive, #2d6cdf) 10%, transparent); }
  .toc a.current { background: color-mix(in srgb, var(--color-interactive, #2d6cdf) 16%, transparent); font-weight: 600; }
  .toc .toc-heading {
    display: block;
    padding: 0.4rem 0.5rem 0.2rem;
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted, #667085);
    font-weight: var(--font-weight-semibold, 600);
  }

  .content { position: relative; overflow: hidden; background: var(--color-background, #fff); }
  iframe {
    inline-size: 100%; block-size: 100%; border: 0; display: block;
    background: var(--color-background, #fff);
  }

  .overlay {
    position: absolute; inset: 0; display: grid; place-items: center;
    padding: 2rem; text-align: center; pointer-events: none;
    color: var(--color-text-muted, #667085);
  }
  .overlay[hidden] { display: none; }
  .overlay .message { max-inline-size: 32rem; }
  .overlay.error { color: var(--color-danger, #b42318); }

  .settings-panel {
    position: absolute;
    inset-block-start: calc(100% + 0.25rem);
    inset-inline-end: var(--size-s, 0.75rem);
    z-index: 4;
    inline-size: min(20rem, calc(100vw - 1rem));
    background: var(--color-surface, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-m, 0.5rem);
    box-shadow: var(--shadow-l, 0 8px 24px rgba(0,0,0,0.12));
    padding: 0.75rem;
    display: grid; gap: 0.6rem;
    font-size: var(--font-size-s, 0.9rem);
  }
  .settings-panel[hidden] { display: none; }

  /* Bookmarks panel: same layout idea as settings, but a list-of-items affordance. */
  .bookmarks-panel {
    position: absolute;
    inset-block-start: calc(100% + 0.25rem);
    inset-inline-end: var(--size-s, 0.75rem);
    z-index: 4;
    inline-size: min(22rem, calc(100vw - 1rem));
    max-block-size: min(70vh, 32rem);
    overflow: auto;
    background: var(--color-surface, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-m, 0.5rem);
    box-shadow: var(--shadow-l, 0 8px 24px rgba(0, 0, 0, 0.12));
    padding: 0.75rem;
    display: grid;
    gap: 0.5rem;
    font-size: var(--font-size-s, 0.9rem);
  }
  .bookmarks-panel[hidden] { display: none; }
  .bookmarks-panel h3 {
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
    margin: 0;
  }
  .bookmarks-panel .row {
    display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  }
  .bookmarks-panel button {
    font: inherit; color: inherit;
    background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.35rem);
    padding: 0.35rem 0.6rem;
    cursor: pointer;
  }
  .bookmarks-panel button.primary {
    background: var(--color-interactive, #2d6cdf);
    color: var(--color-interactive-text, white);
    border-color: transparent;
  }
  .bookmarks-panel .bm-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
  .bookmarks-panel .bm-list li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 0.5rem;
    align-items: start;
    padding: 0.35rem 0.5rem;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
  }
  .bookmarks-panel .bm-list li:hover { background: color-mix(in srgb, var(--color-interactive, #2d6cdf) 6%, transparent); }
  .bookmarks-panel .bm-list .bm-jump {
    text-align: start; padding: 0; border: 0; background: transparent;
    cursor: pointer; color: inherit; min-inline-size: 0;
  }
  .bookmarks-panel .bm-list .bm-label { font-weight: 600; }
  .bookmarks-panel .bm-list .bm-meta {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    line-height: 1.3;
  }
  .bookmarks-panel .bm-list .bm-snippet {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    line-height: 1.4;
  }
  .bookmarks-panel .bm-list .bm-remove {
    inline-size: 1.5rem; block-size: 1.5rem;
    display: inline-grid; place-items: center;
    border-radius: 999px; padding: 0; font-size: 0.9em;
  }
  .bookmarks-panel .bm-empty {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    text-align: center;
    padding-block: 0.5rem;
  }
  .bookmarks-panel:not([data-empty="true"]) .bm-empty { display: none; }
  .bookmarks-panel[data-empty="true"] .bm-list { display: none; }
  /* Solid star when bookmark exists at current position. */
  :scope([data-bookmark-active]) .bookmarks-toggle::before { content: ''; }

  /* Highlight selection popover — floats above the iframe selection. */
  .hl-popover {
    position: absolute;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem;
    background: var(--color-surface, #fff);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-full, 999px);
    box-shadow: var(--shadow-l, 0 8px 24px rgba(0,0,0,0.12));
    transform: translate(-50%, -100%);
  }
  .hl-popover[hidden] { display: none; }
  .hl-popover .hl-color {
    inline-size: 1.5rem;
    block-size: 1.5rem;
    border-radius: 999px;
    border: 2px solid transparent;
    background: var(--c);
    cursor: pointer;
    padding: 0;
  }
  .hl-popover .hl-color:hover { border-color: var(--color-text, #1f1f1f); }
  .hl-popover .hl-note {
    font: inherit;
    color: inherit;
    background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: 999px;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    font-size: 0.85em;
  }

  /* Highlights / notes panel — same shape as bookmarks. */
  .highlights-panel {
    position: absolute;
    inset-block-start: calc(100% + 0.25rem);
    inset-inline-end: var(--size-s, 0.75rem);
    z-index: 4;
    inline-size: min(22rem, calc(100vw - 1rem));
    max-block-size: min(70vh, 32rem);
    overflow: auto;
    background: var(--color-surface, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-m, 0.5rem);
    box-shadow: var(--shadow-l, 0 8px 24px rgba(0, 0, 0, 0.12));
    padding: 0.75rem;
    display: grid;
    gap: 0.5rem;
    font-size: var(--font-size-s, 0.9rem);
  }
  .highlights-panel[hidden] { display: none; }
  .highlights-panel h3 {
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
    margin: 0;
  }
  .highlights-panel .hl-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
  .highlights-panel .hl-list li {
    display: grid;
    grid-template-columns: 0.5rem 1fr auto;
    gap: 0.5rem;
    align-items: start;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    padding: 0.4rem 0.5rem;
  }
  .highlights-panel .hl-swatch {
    inline-size: 0.5rem;
    block-size: 100%;
    min-block-size: 1.5rem;
    border-radius: 2px;
    background: var(--c, #fde68a);
  }
  .highlights-panel .hl-jump {
    text-align: start; padding: 0; border: 0; background: transparent;
    cursor: pointer; color: inherit; min-inline-size: 0;
    display: grid; gap: 0.15rem;
  }
  .highlights-panel .hl-jump .hl-text {
    line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.95em;
  }
  .highlights-panel .hl-jump .hl-meta {
    color: var(--color-text-muted, #667085);
    font-size: 0.8em;
  }
  .highlights-panel .hl-jump .hl-note-text {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    font-style: italic;
  }
  .highlights-panel .hl-remove {
    inline-size: 1.5rem; block-size: 1.5rem;
    display: inline-grid; place-items: center;
    border-radius: 999px;
    background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    cursor: pointer;
    padding: 0; font-size: 0.9em;
    color: inherit;
  }
  .highlights-panel .hl-empty {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    text-align: center;
    padding-block: 0.5rem;
  }
  .highlights-panel:not([data-empty="true"]) .hl-empty { display: none; }
  .highlights-panel[data-empty="true"] .hl-list { display: none; }
  .highlights-panel button.primary {
    background: var(--color-interactive, #2d6cdf);
    color: var(--color-interactive-text, white);
    border-color: transparent;
    border: 0;
    border-radius: var(--radius-s, 0.35rem);
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    font: inherit;
  }
  .highlights-panel .row { display: flex; justify-content: flex-end; }

  /* Search panel: full content-area overlay like the library, but
     denser since each result is short. */
  .search-panel {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: var(--color-background, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    padding: var(--size-m, 1rem);
    overflow: auto;
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: var(--size-s, 0.75rem);
  }
  .search-panel[hidden] { display: none; }
  .search-panel .srch-header {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    align-items: center;
  }
  .search-panel h3 {
    margin: 0;
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
  }
  .search-panel .search-input {
    inline-size: 100%;
    font: inherit; color: inherit;
    background: var(--color-surface, #fff);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    padding: 0.4rem 0.6rem;
  }
  .search-panel .srch-status {
    color: var(--color-text-muted, #667085);
    font-size: var(--font-size-2xs, 0.75rem);
  }
  .search-panel .search-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    display: grid;
    gap: 0.4rem;
  }
  .search-panel .search-results li {
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    background: var(--color-surface, #fff);
  }
  .search-panel .search-results .srch-jump {
    display: grid;
    gap: 0.2rem;
    inline-size: 100%;
    text-align: start;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    padding: 0.5rem 0.6rem;
    font: inherit;
  }
  .search-panel .search-results .srch-jump:hover {
    background: color-mix(in srgb, var(--color-interactive, #2d6cdf) 8%, transparent);
  }
  .search-panel .search-results .srch-chap {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .search-panel .search-results .srch-snippet {
    line-height: 1.4;
    font-size: 0.95em;
  }
  .search-panel .search-results .srch-snippet mark {
    background: color-mix(in srgb, var(--color-interactive, #2d6cdf) 25%, transparent);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .search-panel .row {
    display: flex; justify-content: flex-end; gap: 0.5rem;
  }
  .search-panel button.primary {
    background: var(--color-interactive, #2d6cdf);
    color: var(--color-interactive-text, white);
    border: 0;
    border-radius: var(--radius-s, 0.35rem);
    padding: 0.4rem 0.75rem;
    cursor: pointer;
    font: inherit;
  }

  /* Find-in-chapter bar (Ctrl/Cmd+F replacement). */
  .find-bar {
    display: flex;
    align-items: center;
    gap: var(--size-3xs, 0.25rem);
    padding: 0.4rem 0.75rem;
    border-block-end: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    background: var(--color-surface, #f5f5f5);
    position: relative; z-index: 3;
  }
  .find-bar[hidden] { display: none; }
  .find-bar .find-input {
    flex: 1;
    font: inherit; color: inherit; background: var(--color-background, #fff);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    padding: 0.3rem 0.5rem;
    min-inline-size: 0;
  }
  .find-bar .find-count {
    color: var(--color-text-muted, #667085);
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-2xs, 0.75rem);
    min-inline-size: 4rem;
    text-align: end;
  }

  /* CSS for find/highlight marks lives in a stylesheet injected into
     the chapter iframe — kept inline below in #findStyles for easy
     re-application after publisher CSS rewrites. The :scope rules
     here only affect host chrome. */

  /* Library panel: full-width overlay so cards have room to breathe. */
  .library-panel {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: var(--color-background, #fbfaf7);
    color: var(--color-text, #1f1f1f);
    padding: var(--size-m, 1rem);
    overflow: auto;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: var(--size-s, 0.75rem);
  }
  .library-panel[hidden] { display: none; }
  .library-panel .lib-header {
    display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
  }
  .library-panel h3 {
    margin: 0;
    font-size: var(--font-size-m, 1rem);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
  }
  .library-panel .lib-quota {
    color: var(--color-text-muted, #667085);
    font-size: var(--font-size-2xs, 0.7rem);
    font-variant-numeric: tabular-nums;
  }
  .library-panel .lib-quota[data-warn="true"] { color: #b42318; font-weight: 600; }
  .library-panel .lib-list {
    list-style: none; margin: 0; padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: var(--size-s, 0.75rem);
    align-content: start;
  }
  .library-panel .lib-list li {
    position: relative;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-m, 0.5rem);
    padding: 0.5rem;
    background: var(--color-surface, #fff);
    display: grid; gap: 0.35rem;
  }
  .library-panel .lib-list .lib-cover {
    aspect-ratio: 2/3;
    inline-size: 100%;
    border-radius: var(--radius-s, 0.25rem);
    background: color-mix(in srgb, var(--color-text-muted, #999) 12%, transparent);
    display: grid; place-items: center;
    overflow: hidden;
    font-size: 0.75rem; color: var(--color-text-muted, #667085);
  }
  .library-panel .lib-list .lib-cover img {
    inline-size: 100%; block-size: 100%; object-fit: cover; display: block;
  }
  .library-panel .lib-list .lib-title {
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .library-panel .lib-list .lib-meta {
    color: var(--color-text-muted, #667085);
    font-size: 0.85em;
  }
  .library-panel .lib-list .lib-open {
    text-align: start; padding: 0; margin: 0; border: 0;
    background: transparent; color: inherit; cursor: pointer;
    display: contents;
  }
  .library-panel .lib-list .lib-remove {
    position: absolute;
    inset-block-start: 0.25rem;
    inset-inline-end: 0.25rem;
    inline-size: 1.6rem; block-size: 1.6rem;
    display: inline-grid; place-items: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-background, #fff) 80%, transparent);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    padding: 0;
  }
  .library-panel .lib-empty {
    color: var(--color-text-muted, #667085);
    text-align: center;
    padding: 2rem 1rem;
  }
  .library-panel:not([data-empty="true"]) .lib-empty { display: none; }
  .library-panel[data-empty="true"] .lib-list { display: none; }
  .library-panel .row {
    display: flex; justify-content: space-between; gap: 0.5rem;
  }
  .library-panel button {
    font: inherit; color: inherit;
    background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.35rem);
    padding: 0.4rem 0.75rem;
    cursor: pointer;
  }
  .library-panel button.primary {
    background: var(--color-interactive, #2d6cdf);
    color: var(--color-interactive-text, white);
    border-color: transparent;
  }
  .settings-panel h3 {
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--color-text-muted, #667085);
    margin: 0;
  }
  .settings-panel label {
    display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 0.75rem; align-items: center;
  }
  .settings-panel label .value {
    color: var(--color-text-muted, #667085);
    font-variant-numeric: tabular-nums;
    font-size: 0.85em;
  }
  .settings-panel select,
  .settings-panel input[type="range"] {
    grid-column: 1 / -1;
    inline-size: 100%;
    font: inherit; color: inherit; background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    padding: 0.25rem 0.35rem;
  }
  .settings-panel input[type="range"] { padding: 0; }
  .settings-panel .row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .settings-panel .row.checkbox label { grid-template-columns: auto 1fr; gap: 0.5rem; }
  .settings-panel details.user-css summary {
    font-size: var(--font-size-2xs, 0.7rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted, #667085);
    cursor: pointer;
    padding-block: 0.25rem;
  }
  .settings-panel textarea {
    inline-size: 100%;
    min-block-size: 5rem;
    font: inherit;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.85em;
    color: inherit;
    background: var(--color-background, transparent);
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.25rem);
    padding: 0.4rem;
    resize: vertical;
    box-sizing: border-box;
  }
  .settings-panel button {
    font: inherit; color: inherit;
    background: transparent;
    border: var(--border-width-thin, 1px) solid var(--color-border, #e4e4e7);
    border-radius: var(--radius-s, 0.35rem);
    padding: 0.35rem 0.6rem;
    cursor: pointer;
  }
  .settings-panel button.primary {
    background: var(--color-interactive, #2d6cdf);
    color: var(--color-interactive-text, white);
    border-color: transparent;
  }

  @container (inline-size < 40rem) {
    .body { grid-template-columns: 1fr; }
    .sidebar { display: none; position: absolute; inset: 3.625rem 0 0 0; z-index: 1;
               inline-size: min(20rem, 90%); box-shadow: 0 4px 16px rgba(0,0,0,.1); }
    .body.toc-open .sidebar { display: block; }
  }
}`;

// Light-DOM markup. Borrows class names from <reader-view> chrome
// (.reader-chrome, .reader-controls, .reader-control-group, .reader-icon-btn)
// so VB stylesheets — when loaded — paint the reader natively.
const TEMPLATE = `
<header class="reader-chrome">
  <div class="reader-chrome-copy">
    <span class="reader-chrome-kicker">EPUB</span>
    <span class="reader-chrome-title title"></span>
  </div>
  <div class="reader-controls" role="toolbar" aria-label="Reading controls">
    <div class="reader-control-group">
      <button class="reader-icon-btn toc-toggle" type="button" aria-label="Toggle table of contents" title="Table of contents">&#9776;</button>
    </div>
    <div class="reader-control-group">
      <button class="reader-icon-btn prev" type="button" aria-label="Previous chapter">&larr;</button>
      <span class="progress" role="status"></span>
      <span class="chapter-progress" aria-label="Position in chapter" title="Position in current chapter"></span>
      <button class="reader-icon-btn next" type="button" aria-label="Next chapter">&rarr;</button>
    </div>
    <div class="reader-control-group">
      <button class="reader-icon-btn font-decrease" type="button" aria-label="Decrease font size">A&minus;</button>
      <button class="reader-icon-btn font-increase" type="button" aria-label="Increase font size">A+</button>
      <button class="reader-icon-btn search-toggle" type="button" aria-label="Search book" aria-expanded="false" title="Search whole book">&#128269;</button>
      <button class="reader-icon-btn highlights-toggle" type="button" aria-label="Highlights" aria-expanded="false" title="Highlights &amp; notes">&#128396;</button>
      <button class="reader-icon-btn bookmarks-toggle" type="button" aria-label="Bookmarks" aria-expanded="false" aria-pressed="false" title="Bookmarks (b to toggle)">&#9734;</button>
      <button class="reader-icon-btn library-toggle" type="button" aria-label="Library" aria-expanded="false" title="Library">&#128218;</button>
      <button class="reader-icon-btn settings-toggle" type="button" aria-label="Reading settings" aria-expanded="false" title="Reading settings">Aa</button>
    </div>
  </div>
</header>
<div class="find-bar" role="search" aria-label="Find in chapter" hidden>
  <input class="find-input" type="search" placeholder="Find in chapter…"
    aria-label="Find in chapter" autocomplete="off" spellcheck="false" />
  <span class="find-count" aria-live="polite"></span>
  <button class="reader-icon-btn find-prev" type="button" aria-label="Previous match">&uarr;</button>
  <button class="reader-icon-btn find-next" type="button" aria-label="Next match">&darr;</button>
  <button class="reader-icon-btn find-close" type="button" aria-label="Close find">&times;</button>
</div>
<div class="body">
  <aside class="sidebar"><h2>Contents</h2><ol class="toc"></ol></aside>
  <div class="content">
    <aside class="settings-panel" role="dialog" aria-label="Reading settings" hidden>
      <h3>Reading settings</h3>
      <label>
        <span>Font</span>
        <select class="s-font-family">
          <option value="">Publisher default</option>
          <option value="system-ui, sans-serif">System sans</option>
          <option value="Georgia, 'Times New Roman', serif">Serif (Georgia)</option>
          <option value="'Iowan Old Style', 'Palatino Linotype', Palatino, serif">Serif (Iowan)</option>
          <option value="'Helvetica Neue', Arial, sans-serif">Helvetica</option>
          <option value="Verdana, sans-serif">Verdana</option>
          <option value="'Atkinson Hyperlegible', system-ui, sans-serif">Atkinson Hyperlegible</option>
          <option value="'OpenDyslexic', system-ui, sans-serif">OpenDyslexic</option>
          <option value="ui-monospace, 'Fira Code', monospace">Monospace</option>
        </select>
      </label>
      <label>
        <span>Font size</span><span class="value s-font-size-v"></span>
        <input class="s-font-size" type="range" min="80" max="200" step="5" />
      </label>
      <label>
        <span>Line height</span><span class="value s-line-height-v"></span>
        <input class="s-line-height" type="range" min="100" max="220" step="5" />
      </label>
      <label>
        <span>Paragraph spacing</span><span class="value s-paragraph-spacing-v"></span>
        <input class="s-paragraph-spacing" type="range" min="-1" max="20" step="1" />
      </label>
      <label>
        <span>Reading width</span><span class="value s-reading-width-v"></span>
        <input class="s-reading-width" type="range" min="0" max="120" step="5" />
      </label>
      <div class="row checkbox">
        <label><input class="s-justify" type="checkbox" /><span>Justify text</span></label>
      </div>
      <label>
        <span>Layout</span>
        <div class="seg" role="radiogroup" aria-label="Layout mode">
          <button type="button" class="reader-seg-btn s-layout-scroll" data-mode="scroll" role="radio">Scroll</button>
          <button type="button" class="reader-seg-btn s-layout-paginated" data-mode="paginated" role="radio">Paginated</button>
        </div>
      </label>
      <details class="user-css">
        <summary>Custom CSS</summary>
        <textarea class="s-user-css" rows="4" spellcheck="false"
          placeholder="body { font-feature-settings: 'onum'; }"></textarea>
      </details>
      <div class="row">
        <button type="button" class="s-reset">Reset</button>
        <button type="button" class="s-close primary">Done</button>
      </div>
    </aside>
    <aside class="bookmarks-panel" role="dialog" aria-label="Bookmarks" hidden>
      <h3>Bookmarks</h3>
      <div class="row">
        <button type="button" class="bm-add primary">Bookmark this page</button>
        <button type="button" class="bm-close">Done</button>
      </div>
      <ol class="bm-list" aria-live="polite"></ol>
      <div class="bm-empty">No bookmarks yet — press <kbd>b</kbd> or use the button above.</div>
    </aside>
    <aside class="search-panel" role="dialog" aria-label="Search book" hidden>
      <header class="srch-header">
        <h3>Search</h3>
        <input class="search-input" type="search" placeholder="Search the whole book…"
          aria-label="Search the whole book" autocomplete="off" spellcheck="false" />
      </header>
      <div class="srch-status" aria-live="polite"></div>
      <ol class="search-results" aria-live="polite"></ol>
      <div class="row">
        <button type="button" class="search-close primary">Done</button>
      </div>
    </aside>
    <aside class="library-panel" role="dialog" aria-label="Library" hidden>
      <header class="lib-header">
        <h3>Library</h3>
        <span class="lib-quota" aria-live="polite"></span>
      </header>
      <ol class="lib-list" aria-live="polite"></ol>
      <div class="lib-empty">No books stored yet — opening a book adds it here automatically.</div>
      <div class="row">
        <button type="button" class="lib-clear">Clear all</button>
        <button type="button" class="lib-close primary">Done</button>
      </div>
    </aside>
    <iframe sandbox="allow-same-origin" title="EPUB content"></iframe>
    <div class="hl-popover" role="toolbar" aria-label="Highlight" hidden>
      <button type="button" class="hl-color" data-color="#fde68a" aria-label="Yellow highlight" style="--c:#fde68a"></button>
      <button type="button" class="hl-color" data-color="#bbf7d0" aria-label="Green highlight" style="--c:#bbf7d0"></button>
      <button type="button" class="hl-color" data-color="#bfdbfe" aria-label="Blue highlight" style="--c:#bfdbfe"></button>
      <button type="button" class="hl-color" data-color="#fbcfe8" aria-label="Pink highlight" style="--c:#fbcfe8"></button>
      <button type="button" class="hl-color" data-color="#fed7aa" aria-label="Orange highlight" style="--c:#fed7aa"></button>
      <button type="button" class="hl-note" aria-label="Add note">Note&hellip;</button>
    </div>
    <aside class="highlights-panel" role="dialog" aria-label="Highlights" hidden>
      <h3>Highlights &amp; notes</h3>
      <ol class="hl-list" aria-live="polite"></ol>
      <div class="hl-empty">No highlights yet — select text in a chapter and pick a colour.</div>
      <div class="row">
        <button type="button" class="hl-close primary">Done</button>
      </div>
    </aside>
    <div class="overlay">
      <div class="message">Drop an EPUB file here or choose one to begin.</div>
    </div>
  </div>
</div>
`;



export class EpubReaderElement extends HTMLElement {
  static get observedAttributes() { return ['src', 'start', 'hide-toc', 'allow-scripts']; }

  /** @type {ReaderElements} */     #els;
  /** @type {EpubBook | null} */    #book = null;
  /** @type {TypographySettings} */ #typography = loadTypography();
  #currentIndex = -1;
  #loadToken = 0;

  constructor() {
    super();
    EpubReaderElement.#injectStylesOnce();
    this.innerHTML = TEMPLATE;
    const $ = /** @type {<T extends Element>(sel: string) => T} */ (
      (sel) => /** @type {any} */ (this.querySelector(sel))
    );
    this.#els = {
      shell:              this,
      title:              $('.title'),
      progress:           $('.progress'),
      chapterProgress:    $('.chapter-progress'),
      prev:               $('.prev'),
      next:               $('.next'),
      toggle:             $('.toc-toggle'),
      settingsToggle:     $('.settings-toggle'),
      fontDecrease:       $('.font-decrease'),
      fontIncrease:       $('.font-increase'),
      sidebar:            $('.sidebar'),
      toc:                $('.toc'),
      iframe:             $('iframe'),
      overlay:            $('.overlay'),
      settingsPanel:      $('.settings-panel'),
      sFontFamily:        $('.s-font-family'),
      sFontSize:          $('.s-font-size'),
      sLineHeight:        $('.s-line-height'),
      sParagraphSpacing:  $('.s-paragraph-spacing'),
      sJustify:           $('.s-justify'),
      sReadingWidth:      $('.s-reading-width'),
      sFontSizeV:         $('.s-font-size-v'),
      sLineHeightV:       $('.s-line-height-v'),
      sParagraphSpacingV: $('.s-paragraph-spacing-v'),
      sReadingWidthV:     $('.s-reading-width-v'),
      sLayoutScroll:      $('.s-layout-scroll'),
      sLayoutPaginated:   $('.s-layout-paginated'),
      sUserCss:           $('.s-user-css'),
      sReset:             $('.s-reset'),
      sClose:             $('.s-close'),
      bookmarksToggle:    $('.bookmarks-toggle'),
      bookmarksPanel:     $('.bookmarks-panel'),
      bmAdd:              $('.bm-add'),
      bmClose:            $('.bm-close'),
      bmList:             $('.bm-list'),
      libraryToggle:      $('.library-toggle'),
      libraryPanel:       $('.library-panel'),
      libList:            $('.lib-list'),
      libQuota:           $('.lib-quota'),
      libClear:           $('.lib-clear'),
      libClose:           $('.lib-close'),
      findBar:            $('.find-bar'),
      findInput:          $('.find-input'),
      findCount:          $('.find-count'),
      findPrev:           $('.find-prev'),
      findNext:           $('.find-next'),
      findClose:          $('.find-close'),
      searchToggle:       $('.search-toggle'),
      searchPanel:        $('.search-panel'),
      searchInput:        $('.search-input'),
      searchStatus:       $('.srch-status'),
      searchResults:      $('.search-results'),
      searchClose:        $('.search-close'),
      highlightsToggle:   $('.highlights-toggle'),
      highlightsPanel:    $('.highlights-panel'),
      hlList:             $('.hl-list'),
      hlPanelClose:       $('.hl-close'),
      hlPopover:          $('.hl-popover'),
    };
    this.#els.prev.addEventListener('click', () => this.prev());
    this.#els.next.addEventListener('click', () => this.next());
    this.#els.toggle.addEventListener('click', () => this.#toggleToc());
    this.#els.settingsToggle.addEventListener('click', () => this.#toggleSettings());
    this.#els.fontDecrease.addEventListener('click', () => this.#stepFontSize(-10));
    this.#els.fontIncrease.addEventListener('click', () => this.#stepFontSize(+10));
    this.#els.bookmarksToggle.addEventListener('click', () => this.#toggleBookmarksPanel());
    this.#els.bmAdd.addEventListener('click', () => this.toggleBookmark());
    this.#els.bmClose.addEventListener('click', () => this.#toggleBookmarksPanel(false));
    this.#els.libraryToggle.addEventListener('click', () => this.#toggleLibraryPanel());
    this.#els.libClose.addEventListener('click', () => this.#toggleLibraryPanel(false));
    this.#els.libClear.addEventListener('click', async () => {
      // Confirm via the host page's `confirm()` so screen readers see it.
      if (!confirm('Remove all books, bookmarks, and reading positions?')) return;
      await this.clearLibrary();
      await this.#renderLibrary();
    });
    // Find-in-chapter controls.
    this.#els.findInput.addEventListener('input', () => this.#refreshFind());
    this.#els.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) this.#findStep(-1); else this.#findStep(+1);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.find(false); e.preventDefault();
      }
    });
    this.#els.findPrev.addEventListener('click', () => this.#findStep(-1));
    this.#els.findNext.addEventListener('click', () => this.#findStep(+1));
    this.#els.findClose.addEventListener('click', () => this.find(false));
    // Search-whole-book controls.
    this.#els.searchToggle.addEventListener('click', () => this.#toggleSearchPanel());
    this.#els.searchClose.addEventListener('click', () => this.#toggleSearchPanel(false));
    let searchTimer = 0;
    this.#els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.#runSearch(this.#els.searchInput.value), 200);
    });
    this.#els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.#toggleSearchPanel(false); e.preventDefault(); }
    });
    // Highlights panel + popover.
    this.#els.highlightsToggle.addEventListener('click', () => this.#toggleHighlightsPanel());
    this.#els.hlPanelClose.addEventListener('click', () => this.#toggleHighlightsPanel(false));
    this.#els.hlPopover.addEventListener('click', (ev) => {
      const target = /** @type {HTMLElement} */ (ev.target);
      const colorBtn = target.closest('.hl-color');
      const noteBtn = target.closest('.hl-note');
      if (colorBtn) this.#addHighlightFromSelection(colorBtn.getAttribute('data-color') || '#fde68a');
      else if (noteBtn) this.#addHighlightFromSelection('#fde68a', /* withNote */ true);
    });
    this.#els.iframe.addEventListener('load', () => this.#onIframeLoad());
    this.addEventListener('keydown', (e) => this.#onKeyDown(e));
    this.#wireSettingsControls();
    this.#syncSettingsControls();
    this.#updateSandbox();
    this.tabIndex = 0;
  }

  // Component CSS injected once into <head>, scoped via @scope
  // (epub-reader) so it never leaks. Avoids duplicate <style> blocks
  // when a page hosts multiple readers.
  static #stylesInjected = false;
  static #injectStylesOnce() {
    if (EpubReaderElement.#stylesInjected) return;
    EpubReaderElement.#stylesInjected = true;
    const style = document.createElement('style');
    style.id = '__epub_reader_component_css';
    style.textContent = COMPONENT_CSS;
    document.head.append(style);
  }

  connectedCallback() {
    const src = this.getAttribute('src');
    if (src) this.open(src);
  }

  disconnectedCallback() {
    this.close();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'src' && this.isConnected && newValue) this.open(newValue);
    if (name === 'allow-scripts') this.#updateSandbox();
  }

  /**
   * Build the iframe `sandbox` attribute from the current host attributes.
   *
   * Default — `sandbox="allow-same-origin"` — blocks all scripts but lets
   * us reach into the chapter document from the parent (fragment scroll,
   * link interception, theme/typography injection). Setting `allow-scripts`
   * on the host adds `allow-scripts` so interactive EPUBs (quizzes,
   * bindings, scripted carousels) work.
   *
   * NB: `allow-same-origin` + `allow-scripts` together lets sandboxed
   * scripts escape via the parent — only enable for content you trust.
   */
  #updateSandbox() {
    const iframe = this.#els?.iframe;
    if (!iframe) return;
    const tokens = ['allow-same-origin'];
    if (this.hasAttribute('allow-scripts')) tokens.push('allow-scripts');
    iframe.setAttribute('sandbox', tokens.join(' '));
  }

  // ------- public API -------

  /**
   * Load an EPUB. Replaces any currently-open book. Fires `epub-loaded`
   * on success, `epub-error` on failure.
   * @param {string | Blob | ArrayBuffer | ArrayBufferView} source
   * @returns {Promise<void>}
   */
  async open(source) {
    const token = ++this.#loadToken;
    this.close();
    this.#setOverlay('Loading…');
    try {
      const book = await openEpub(source);
      if (token !== this.#loadToken) { book.destroy(); return; }
      this.#book = book;
      this.#bookId = null;
      this.#renderToc();

      // Resolve the persistence key + look up any stored position before
      // we land on the start chapter, so we can land directly on the
      // restored chapter and skip rendering the start-of-book first.
      this.#bookId = await book.bookId().catch(() => null);
      const stored = this.#bookId ? await dbGet('positions', this.#bookId) : null;
      // Load bookmarks + highlights for this book before rendering.
      await this.#loadBookmarks();
      await this.#loadHighlights();

      const startAttr = Number(this.getAttribute('start') || 0) || 0;
      const startIndex = Math.max(0, Math.min(book.spine.length - 1, startAttr));

      this.dispatchEvent(new CustomEvent('epub-loaded', {
        detail: {
          metadata: book.metadata,
          spineLength: book.spine.length,
          toc: book.toc,
        },
        bubbles: true,
        composed: true,
      }));

      // Validate the stored position against the current spine before
      // restoring — books update, indices shift.
      const restoreIdx = stored && stored.spineIndex >= 0 && stored.spineIndex < book.spine.length
        ? stored.spineIndex : -1;
      if (restoreIdx >= 0) {
        await this.goToIndex(restoreIdx);
        this.#applyRestoredScroll(stored.scrollFraction);
        this.dispatchEvent(new CustomEvent('epub-position-restored', {
          detail: {
            spineIndex: stored.spineIndex,
            scrollFraction: stored.scrollFraction,
            bookId: this.#bookId,
          },
          bubbles: true, composed: true,
        }));
      } else {
        await this.goToIndex(startIndex);
      }
      this.#hideOverlay();
      // Auto-add to the library (persist source blob + metadata + cover).
      // Don't block the reader on it — fire and forget.
      this.#persistLibraryEntry(book).catch(() => { /* swallow */ });
    } catch (err) {
      if (token !== this.#loadToken) return;
      this.#setOverlay(String(err?.message || err), true);
      this.dispatchEvent(new CustomEvent('epub-error', {
        detail: { error: err },
        bubbles: true,
        composed: true,
      }));
    }
  }

  /** Most recent book identifier (used as the IndexedDB key for persistence). */
  /** @type {string | null} */ #bookId = null;
  /** @type {ReturnType<typeof setTimeout> | null} */ #saveTimer = null;
  /** Suppress saves while we're applying a restored position. */
  #suppressSave = false;

  /**
   * Re-apply a stored scroll fraction once the chapter iframe finishes
   * loading. Skipped in paginated mode (scrollFraction has no meaning
   * across columns) and for fixed-layout chapters (no scroll).
   * @param {number} scrollFraction
   */
  #applyRestoredScroll(scrollFraction) {
    if (!Number.isFinite(scrollFraction) || scrollFraction <= 0) return;
    if (this.#typography.layoutMode === 'paginated') return;
    const item = this.#book?.spine[this.#currentIndex];
    if (item?.layout === 'pre-paginated') return;
    this.#suppressSave = true;
    const apply = () => {
      const doc = this.#els.iframe.contentDocument;
      const se = doc?.scrollingElement || doc?.documentElement;
      if (!se) return;
      const max = se.scrollHeight - se.clientHeight;
      if (max > 0) se.scrollTop = scrollFraction * max;
    };
    requestAnimationFrame(apply);
    this.#els.iframe.contentWindow?.addEventListener('load', () => {
      apply();
      this.#suppressSave = false;
    }, { once: true });
    // Belt + braces: re-enable saves after a short timeout in case the
    // load event never fires (e.g. cached SVG-in-spine docs).
    setTimeout(() => { this.#suppressSave = false; }, 1500);
  }

  /**
   * Persist current position. Throttled — caller-side scroll handlers
   * fire every frame; we batch up to one save per ~500 ms.
   */
  #schedulePositionSave() {
    if (this.#suppressSave || !this.#book || !this.#bookId) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#savePositionNow(), 500);
  }

  async #savePositionNow() {
    this.#saveTimer = null;
    if (!this.#book || !this.#bookId) return;
    const doc = this.#els.iframe.contentDocument;
    const se = doc?.scrollingElement || doc?.documentElement;
    let scrollFraction = 0;
    if (se && this.#typography.layoutMode === 'scroll') {
      const max = se.scrollHeight - se.clientHeight;
      if (max > 0) scrollFraction = Math.min(1, Math.max(0, se.scrollTop / max));
    }
    /** @type {ReadingPosition} */
    const record = {
      id: this.#bookId,
      spineIndex: this.#currentIndex,
      scrollFraction,
      updatedAt: Date.now(),
    };
    await dbPut('positions', record);
  }

  // ------- find in chapter (#17) -------

  /** Current query string in the find bar. */
  #findQuery = '';
  /** Index of the focused match within the current chapter. */
  #findIndex = 0;
  /** Cached count of matches in the current chapter. */
  #findTotal = 0;

  /**
   * Open or close the find-in-chapter bar. When opening, focuses the
   * input and seeds it with the current selection (if any).
   *
   * @param {boolean} open
   */
  find(open) {
    const bar = this.#els.findBar;
    if (open) {
      bar.hidden = false;
      const sel = this.#els.iframe.contentDocument?.getSelection?.()?.toString();
      if (sel) {
        this.#els.findInput.value = sel;
      }
      this.#els.findInput.focus();
      this.#els.findInput.select();
      this.#refreshFind();
    } else {
      bar.hidden = true;
      this.#findQuery = '';
      this.#findIndex = 0;
      this.#findTotal = 0;
      this.#els.findInput.value = '';
      this.#els.findCount.textContent = '';
      const doc = this.#els.iframe.contentDocument;
      if (doc) this.#findClearMarks(doc);
    }
  }

  #refreshFind() {
    const doc = this.#els.iframe.contentDocument;
    if (!doc?.body) return;
    this.#findClearMarks(doc);
    const q = this.#els.findInput.value;
    this.#findQuery = q;
    if (!q || q.length < 2) {
      this.#findTotal = 0;
      this.#findIndex = 0;
      this.#els.findCount.textContent = '';
      return;
    }
    const offsets = findOffsets(doc.body, q);
    this.#findTotal = offsets.length;
    this.#findIndex = offsets.length > 0 ? 0 : -1;
    if (offsets.length === 0) {
      this.#els.findCount.textContent = '0 / 0';
      return;
    }
    // Wrap each match in document order. We re-resolve the range
    // for each one because previous wraps split the text nodes.
    let i = 0;
    for (const { start, end } of offsets) {
      const range = rangeFromOffsets(doc.body, start, end);
      if (!range) continue;
      const idx = i++;
      wrapRange(range, () => {
        const m = doc.createElement('mark');
        m.setAttribute('data-reader-mark', 'find');
        m.dataset.findIndex = String(idx);
        return m;
      });
    }
    this.#findFocusCurrent();
  }

  /** @param {Document} doc */
  #findClearMarks(doc) {
    if (!doc.body) return;
    unwrapAll(doc.body, '[data-reader-mark="find"]');
  }

  /** @param {1 | -1} dir */
  #findStep(dir) {
    if (this.#findTotal === 0) return;
    this.#findIndex = (this.#findIndex + dir + this.#findTotal) % this.#findTotal;
    this.#findFocusCurrent();
  }

  #findFocusCurrent() {
    const doc = this.#els.iframe.contentDocument;
    if (!doc) return;
    // De-emphasise others, mark current.
    for (const el of /** @type {NodeListOf<HTMLElement>} */
        (doc.querySelectorAll('[data-reader-mark="find"].current'))) {
      el.classList.remove('current');
    }
    const wraps = /** @type {NodeListOf<HTMLElement>} */ (
      doc.querySelectorAll(`[data-reader-mark="find"][data-find-index="${this.#findIndex}"]`));
    let scrolled = false;
    for (const el of wraps) {
      el.classList.add('current');
      if (!scrolled) { el.scrollIntoView({ block: 'center' }); scrolled = true; }
    }
    this.#els.findCount.textContent = `${this.#findIndex + 1} / ${this.#findTotal}`;
  }

  // ------- full-text search (#16) -------

  /**
   * Lazy index of all reflowable spine items, built on first search.
   * Cleared on book close so reopening rebuilds. Pre-paginated chapters
   * are skipped — they're images, not text.
   *
   * @typedef {{spineIndex: number, path: string, title: string, text: string, lower: string}} SearchChapter
   * @type {SearchChapter[] | null}
   */
  #searchIndex = null;
  /** @type {Promise<SearchChapter[]> | null} */
  #searchIndexPromise = null;
  /** Current search query — propagated to chapter highlighting on nav. */
  #searchQuery = '';

  /**
   * Build (or return cached) full-text index for the open book. The
   * index pulls each chapter through a fresh fetch + DOMParser so the
   * text matches what the user actually sees, with whitespace
   * normalised to single spaces for predictable offsets.
   *
   * @returns {Promise<SearchChapter[]>}
   */
  #buildSearchIndex() {
    if (this.#searchIndex) return Promise.resolve(this.#searchIndex);
    if (this.#searchIndexPromise) return this.#searchIndexPromise;
    if (!this.#book) return Promise.resolve([]);
    const book = this.#book;
    const status = this.#els.searchStatus;
    /** @type {SearchChapter[]} */
    const out = [];
    const total = book.spine.length;
    this.#searchIndexPromise = (async () => {
      for (let i = 0; i < book.spine.length; i++) {
        // Bail if the user closed the book mid-build.
        if (this.#book !== book) return [];
        if (status) status.textContent = `Indexing… ${i + 1} / ${total}`;
        const item = book.spine[i];
        if (item.layout === 'pre-paginated') continue;
        try {
          const url = await book.resourceUrl(item.path);
          const res = await fetch(url);
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          out.push({
            spineIndex: i,
            path: item.path,
            title: this.#tocLabelForPath(item.path) || `Chapter ${i + 1}`,
            text,
            lower: text.toLowerCase(),
          });
        } catch { /* skip unreadable chapters */ }
      }
      this.#searchIndex = out;
      this.#searchIndexPromise = null;
      if (status) status.textContent = '';
      return out;
    })();
    return this.#searchIndexPromise;
  }

  /**
   * Public search API. Returns hits across the whole book without
   * touching the panel. Useful for embedders.
   *
   * @param {string} query
   * @param {{ maxHits?: number }} [opts]
   * @returns {Promise<{spineIndex: number, path: string, title: string,
   *                    offset: number, contextBefore: string, match: string,
   *                    contextAfter: string}[]>}
   */
  async search(query, opts = {}) {
    const q = (query || '').trim();
    if (q.length < 2) return [];
    const maxHits = opts.maxHits ?? 500;
    const idx = await this.#buildSearchIndex();
    const lower = q.toLowerCase();
    /** @type {{spineIndex:number, path:string, title:string, offset:number,
     *          contextBefore:string, match:string, contextAfter:string,
     *          matchOrdinal:number}[]} */
    const hits = [];
    for (const ch of idx) {
      let i = 0;
      let ordinal = 0;
      while (i <= ch.lower.length) {
        const at = ch.lower.indexOf(lower, i);
        if (at < 0) break;
        const start = Math.max(0, at - 40);
        const end = Math.min(ch.text.length, at + lower.length + 40);
        hits.push({
          spineIndex: ch.spineIndex,
          path: ch.path,
          title: ch.title,
          offset: at,
          contextBefore: ch.text.slice(start, at),
          match: ch.text.slice(at, at + lower.length),
          contextAfter: ch.text.slice(at + lower.length, end),
          matchOrdinal: ordinal++,
        });
        if (hits.length >= maxHits) return hits;
        i = at + Math.max(1, lower.length);
      }
    }
    return hits;
  }

  async #toggleSearchPanel(force) {
    const open = typeof force === 'boolean' ? force : this.#els.searchPanel.hidden;
    this.#els.searchPanel.hidden = !open;
    this.#els.searchToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // Mutually exclusive popovers.
      this.#els.bookmarksPanel.hidden = true;
      this.#els.bookmarksToggle.setAttribute('aria-expanded', 'false');
      this.#els.libraryPanel.hidden = true;
      this.#els.libraryToggle.setAttribute('aria-expanded', 'false');
      this.#els.settingsPanel.hidden = true;
      this.#els.settingsToggle.setAttribute('aria-expanded', 'false');
      this.#els.searchInput.focus();
      this.#els.searchInput.select();
    }
  }

  async #runSearch(query) {
    const q = (query || '').trim();
    this.#searchQuery = q;
    const ol = this.#els.searchResults;
    const status = this.#els.searchStatus;
    ol.innerHTML = '';
    if (q.length < 2) {
      status.textContent = q.length === 0 ? '' : 'Type at least 2 characters.';
      return;
    }
    status.textContent = 'Searching…';
    const hits = await this.search(q);
    if (this.#searchQuery !== q) return; // superseded
    if (hits.length === 0) {
      status.textContent = `No results for “${q}”.`;
      return;
    }
    // Group by chapter for the visual list.
    /** @type {Map<number, typeof hits>} */
    const byChap = new Map();
    for (const h of hits) {
      const arr = byChap.get(h.spineIndex) || [];
      arr.push(h);
      byChap.set(h.spineIndex, arr);
    }
    status.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} in ${byChap.size} chapter${byChap.size === 1 ? '' : 's'}.`;
    const frag = document.createDocumentFragment();
    for (const [, group] of byChap) {
      for (const h of group) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'srch-jump';
        const chap = document.createElement('span');
        chap.className = 'srch-chap';
        chap.textContent = h.title;
        const snip = document.createElement('span');
        snip.className = 'srch-snippet';
        snip.append(document.createTextNode(h.contextBefore));
        const m = document.createElement('mark');
        m.textContent = h.match;
        snip.append(m);
        snip.append(document.createTextNode(h.contextAfter));
        btn.append(chap, snip);
        btn.addEventListener('click', () => this.#goToSearchHit(h));
        li.append(btn);
        frag.append(li);
      }
    }
    ol.append(frag);
  }

  /**
   * Jump from a search hit to the corresponding place in the chapter.
   * After the iframe finishes loading, scroll to the matched offset
   * and wrap every match for the active query in a search-mark so the
   * reader sees them all in context.
   *
   * @param {{spineIndex: number, matchOrdinal: number}} hit
   */
  async #goToSearchHit(hit) {
    await this.#toggleSearchPanel(false);
    const settle = () => {
      const doc = this.#els.iframe.contentDocument;
      if (!doc?.body) return;
      this.#highlightSearchInChapter(doc, this.#searchQuery);
      const marks = /** @type {NodeListOf<HTMLElement>} */ (
        doc.querySelectorAll('[data-reader-mark="search"]'));
      if (marks.length === 0) return;
      // Marks are in document order — pick the user's clicked match
      // by its per-chapter ordinal.
      const target = marks[hit.matchOrdinal] || marks[0];
      target.scrollIntoView({ block: 'center' });
    };
    if (this.#currentIndex === hit.spineIndex) {
      settle();
      return;
    }
    this.goToIndex(hit.spineIndex);
    this.#els.iframe.addEventListener('load', settle, { once: true });
  }

  /**
   * Wrap every match for `query` in the chapter doc with a
   * `[data-reader-mark="search"]`. Idempotent — clears previous
   * search marks first.
   *
   * @param {Document} doc
   * @param {string} query
   */
  #highlightSearchInChapter(doc, query) {
    if (!doc.body) return;
    unwrapAll(doc.body, '[data-reader-mark="search"]');
    if (!query || query.length < 2) return;
    const offsets = findOffsets(doc.body, query);
    let i = 0;
    for (const { start, end } of offsets) {
      const range = rangeFromOffsets(doc.body, start, end);
      if (!range) continue;
      const idx = i++;
      wrapRange(range, () => {
        const m = doc.createElement('mark');
        m.setAttribute('data-reader-mark', 'search');
        m.dataset.searchIndex = String(idx);
        return m;
      });
    }
  }

  // ------- highlights (#15) -------

  /** @type {Highlight[]} */ #highlights = [];

  /** @returns {Promise<void>} */
  async #loadHighlights() {
    this.#highlights = [];
    if (!this.#bookId) { this.#renderHighlights(); return; }
    const rec = await dbGet('highlights', this.#bookId);
    if (rec && Array.isArray(rec.items)) this.#highlights = rec.items;
    this.#renderHighlights();
  }

  async #saveHighlights() {
    if (!this.#bookId) return;
    await dbPut('highlights', {
      id: this.#bookId,
      items: this.#highlights,
      updatedAt: Date.now(),
    });
  }

  /** Read-only snapshot of the current book's highlights. */
  get highlights() { return this.#highlights.map(h => ({ ...h })); }

  /**
   * Capture the selection in the chapter iframe as a new highlight.
   * @param {string} color
   * @param {boolean} [withNote]  If true, prompt the user for a note.
   * @returns {Promise<Highlight | null>}
   */
  async #addHighlightFromSelection(color, withNote = false) {
    const doc = this.#els.iframe.contentDocument;
    const sel = doc?.getSelection?.();
    if (!doc?.body || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.#hideHighlightPopover();
      return null;
    }
    const range = sel.getRangeAt(0);
    const offsets = offsetsFromRange(doc.body, range);
    if (!offsets) { this.#hideHighlightPopover(); return null; }
    const text = range.toString().trim().slice(0, 200);
    let note = '';
    if (withNote) {
      const win = this.ownerDocument?.defaultView;
      note = (win?.prompt('Note for this highlight (optional):', '') || '').trim();
    }
    const hl = /** @type {Highlight} */ ({
      id: 'hl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      spineIndex: this.#currentIndex,
      startOffset: offsets.start,
      endOffset: offsets.end,
      text, color, note,
      createdAt: Date.now(),
    });
    this.#highlights = [...this.#highlights, hl]
      .sort((a, b) => a.spineIndex - b.spineIndex || a.startOffset - b.startOffset);
    await this.#saveHighlights();
    this.#applyHighlightsTo(doc);
    this.#renderHighlights();
    sel.removeAllRanges();
    this.#hideHighlightPopover();
    this.dispatchEvent(new CustomEvent('epub-highlights-change', {
      detail: { highlights: this.highlights },
      bubbles: true, composed: true,
    }));
    return hl;
  }

  /**
   * Public removal API — used by the panel × button.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removeHighlight(id) {
    const before = this.#highlights.length;
    this.#highlights = this.#highlights.filter(h => h.id !== id);
    if (this.#highlights.length === before) return false;
    await this.#saveHighlights();
    const doc = this.#els.iframe.contentDocument;
    if (doc) this.#applyHighlightsTo(doc);
    this.#renderHighlights();
    this.dispatchEvent(new CustomEvent('epub-highlights-change', {
      detail: { highlights: this.highlights },
      bubbles: true, composed: true,
    }));
    return true;
  }

  /**
   * Jump to a stored highlight (chapter + scroll into the wrapper).
   * @param {string} id
   */
  async goToHighlight(id) {
    const hl = this.#highlights.find(h => h.id === id);
    if (!hl || !this.#book) return;
    if (hl.spineIndex < 0 || hl.spineIndex >= this.#book.spine.length) return;
    if (this.#currentIndex !== hl.spineIndex) {
      await this.goToIndex(hl.spineIndex);
      // Wait one iframe-load tick for the marks to be applied.
      await new Promise(r => this.#els.iframe.addEventListener('load', () => r(undefined), { once: true }));
    }
    const doc = this.#els.iframe.contentDocument;
    const target = /** @type {HTMLElement | null} */ (doc?.querySelector(`[data-reader-mark="highlight"][data-id="${CSS.escape(id)}"]`));
    target?.scrollIntoView({ block: 'center' });
  }

  /**
   * Apply (or refresh) the highlight wrappers in the chapter doc.
   * Always wraps from the offsets (not the prior wrappers) so DOM
   * mutations between chapter loads can't drift.
   * @param {Document} doc
   */
  #applyHighlightsTo(doc) {
    if (!doc.body) return;
    unwrapAll(doc.body, '[data-reader-mark="highlight"]');
    const here = this.#highlights.filter(h => h.spineIndex === this.#currentIndex);
    for (const h of here) {
      const range = rangeFromOffsets(doc.body, h.startOffset, h.endOffset);
      if (!range) continue;
      wrapRange(range, () => {
        const m = doc.createElement('mark');
        m.setAttribute('data-reader-mark', 'highlight');
        m.dataset.id = h.id;
        m.style.setProperty('--reader-hl-color', h.color);
        if (h.note) m.title = h.note;
        return m;
      });
    }
  }

  /**
   * Selection-popover lifecycle. Listens for selection changes inside
   * the iframe, positions the popover above the selection (translated
   * from iframe coordinates to host coordinates).
   * @param {HTMLIFrameElement} iframe
   */
  #wireHighlightSelection(iframe) {
    const doc = iframe.contentDocument;
    if (!doc) return;
    const update = () => this.#updateHighlightPopover();
    doc.addEventListener('mouseup', update);
    doc.addEventListener('keyup', update);
    doc.addEventListener('selectionchange', update);
  }

  #updateHighlightPopover() {
    const iframe = this.#els.iframe;
    const doc = iframe.contentDocument;
    const sel = doc?.getSelection?.();
    if (!doc || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.#hideHighlightPopover();
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.#hideHighlightPopover();
      return;
    }
    const ifr = iframe.getBoundingClientRect();
    const host = this.getBoundingClientRect();
    const popover = this.#els.hlPopover;
    popover.hidden = false;
    popover.style.left = (ifr.left - host.left + rect.left + rect.width / 2) + 'px';
    popover.style.top = (ifr.top - host.top + rect.top - 8) + 'px';
  }

  #hideHighlightPopover() { this.#els.hlPopover.hidden = true; }

  #toggleHighlightsPanel(force) {
    const open = typeof force === 'boolean' ? force : this.#els.highlightsPanel.hidden;
    this.#els.highlightsPanel.hidden = !open;
    this.#els.highlightsToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // Mutually exclusive popovers.
      this.#els.bookmarksPanel.hidden = true;
      this.#els.bookmarksToggle.setAttribute('aria-expanded', 'false');
      this.#els.libraryPanel.hidden = true;
      this.#els.libraryToggle.setAttribute('aria-expanded', 'false');
      this.#els.settingsPanel.hidden = true;
      this.#els.settingsToggle.setAttribute('aria-expanded', 'false');
      this.#els.searchPanel.hidden = true;
      this.#els.searchToggle.setAttribute('aria-expanded', 'false');
      this.#renderHighlights();
    }
  }

  #renderHighlights() {
    const ol = this.#els.hlList;
    const panel = this.#els.highlightsPanel;
    panel.dataset.empty = String(this.#highlights.length === 0);
    ol.innerHTML = '';
    for (const h of this.#highlights) {
      const li = document.createElement('li');
      li.dataset.id = h.id;

      const swatch = document.createElement('span');
      swatch.className = 'hl-swatch';
      swatch.style.setProperty('--c', h.color);

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'hl-jump';
      const text = document.createElement('span');
      text.className = 'hl-text';
      text.textContent = `“${h.text}”`;
      const meta = document.createElement('span');
      meta.className = 'hl-meta';
      const chapter = this.#book?.spine[h.spineIndex];
      const chapterTitle = chapter ? this.#tocLabelForPath(chapter.path) : '';
      meta.textContent = chapterTitle || `Chapter ${h.spineIndex + 1}`;
      jump.append(text, meta);
      if (h.note) {
        const noteEl = document.createElement('span');
        noteEl.className = 'hl-note-text';
        noteEl.textContent = h.note;
        jump.append(noteEl);
      }
      jump.addEventListener('click', () => this.goToHighlight(h.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'hl-remove';
      remove.setAttribute('aria-label', 'Remove highlight');
      remove.textContent = '×';
      remove.addEventListener('click', (ev) => { ev.stopPropagation(); this.removeHighlight(h.id); });

      li.append(swatch, jump, remove);
      ol.append(li);
    }
  }

  // ------- bookmarks -------

  /**
   * In-memory cache of the current book's bookmarks. The persisted shape
   * in IndexedDB is `{ id: bookId, items: Bookmark[] }` — one record per
   * book, list-of-items inside, so add/remove are simple put-the-record
   * round-trips and listing for a single book is a single get.
   *
   * @type {Bookmark[]}
   */
  #bookmarks = [];

  /** @returns {Promise<void>} */
  async #loadBookmarks() {
    this.#bookmarks = [];
    if (!this.#bookId) { this.#renderBookmarks(); return; }
    const rec = await dbGet('bookmarks', this.#bookId);
    if (rec && Array.isArray(rec.items)) this.#bookmarks = rec.items;
    this.#renderBookmarks();
    this.#updateBookmarkButton();
  }

  /** @returns {Promise<void>} */
  async #saveBookmarks() {
    if (!this.#bookId) return;
    await dbPut('bookmarks', {
      id: this.#bookId,
      items: this.#bookmarks,
      updatedAt: Date.now(),
    });
  }

  /** Read-only snapshot of the current book's bookmarks. */
  get bookmarks() { return this.#bookmarks.map(b => ({ ...b })); }

  /** True if a bookmark exists at (close to) the current position. */
  #bookmarkAtCurrent() {
    return this.#bookmarks.find(b =>
      b.spineIndex === this.#currentIndex &&
      Math.abs(b.scrollFraction - this.#currentScrollFraction()) < 0.05
    ) || null;
  }

  /** @returns {number} */
  #currentScrollFraction() {
    if (this.#typography.layoutMode === 'paginated') {
      const info = this.#pageInfo();
      return info ? (info.current - 1) / Math.max(1, info.total) : 0;
    }
    const doc = this.#els.iframe.contentDocument;
    const se = doc?.scrollingElement || doc?.documentElement;
    if (!se) return 0;
    const max = se.scrollHeight - se.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, se.scrollTop / max)) : 0;
  }

  /**
   * Add or remove a bookmark at the current position. Used by both the
   * panel "Bookmark this page" button and the `b` keyboard shortcut.
   * @param {string} [label]  Optional label; defaults to the chapter title.
   * @returns {Promise<Bookmark | null>}
   *   The newly created bookmark, or null if a bookmark was removed.
   */
  async toggleBookmark(label) {
    if (!this.#book || !this.#bookId) return null;
    const existing = this.#bookmarkAtCurrent();
    if (existing) {
      this.#bookmarks = this.#bookmarks.filter(b => b.id !== existing.id);
      await this.#saveBookmarks();
      this.#renderBookmarks();
      this.#updateBookmarkButton();
      this.#emitBookmarksChange();
      return null;
    }
    /** @type {Bookmark} */
    const bm = {
      id: 'bm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      spineIndex: this.#currentIndex,
      scrollFraction: this.#currentScrollFraction(),
      chapterTitle: this.#tocLabelForPath(this.#book.spine[this.#currentIndex]?.path || ''),
      label: label || '',
      snippet: this.#captureSnippet(),
      createdAt: Date.now(),
    };
    this.#bookmarks = [...this.#bookmarks, bm].sort((a, b) =>
      a.spineIndex - b.spineIndex || a.scrollFraction - b.scrollFraction);
    await this.#saveBookmarks();
    this.#renderBookmarks();
    this.#updateBookmarkButton();
    this.#emitBookmarksChange();
    return bm;
  }

  /**
   * Remove a bookmark by id.
   * @param {string} id
   * @returns {Promise<boolean>} true if a bookmark was removed.
   */
  async removeBookmark(id) {
    const before = this.#bookmarks.length;
    this.#bookmarks = this.#bookmarks.filter(b => b.id !== id);
    if (this.#bookmarks.length === before) return false;
    await this.#saveBookmarks();
    this.#renderBookmarks();
    this.#updateBookmarkButton();
    this.#emitBookmarksChange();
    return true;
  }

  /**
   * Jump to a bookmark. Mirrors the position-restore flow so layout
   * settles before the scrollFraction re-applies.
   * @param {string} id
   */
  async goToBookmark(id) {
    const bm = this.#bookmarks.find(b => b.id === id);
    if (!bm || !this.#book) return;
    if (bm.spineIndex < 0 || bm.spineIndex >= this.#book.spine.length) return;
    await this.goToIndex(bm.spineIndex);
    this.#applyRestoredScroll(bm.scrollFraction);
  }

  /**
   * Capture ~120 chars of visible chapter text near the current scroll
   * position, for the bookmark snippet.
   * @returns {string}
   */
  #captureSnippet() {
    const doc = this.#els.iframe.contentDocument;
    const text = (doc?.body?.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) return '';
    const frac = this.#currentScrollFraction();
    const start = Math.max(0, Math.floor(text.length * frac) - 20);
    return text.slice(start, start + 120).trim();
  }

  #renderBookmarks() {
    const ol = this.#els.bmList;
    ol.innerHTML = '';
    const panel = this.#els.bookmarksPanel;
    panel.dataset.empty = String(this.#bookmarks.length === 0);
    for (const bm of this.#bookmarks) {
      const li = document.createElement('li');
      li.dataset.bookmarkId = bm.id;
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'bm-jump';
      const labelEl = document.createElement('span');
      labelEl.className = 'bm-label';
      labelEl.textContent = bm.label || bm.chapterTitle || '(unnamed)';
      const meta = document.createElement('span');
      meta.className = 'bm-meta';
      const pct = Math.round((bm.scrollFraction || 0) * 100);
      meta.textContent = `${bm.chapterTitle || `Chapter ${bm.spineIndex + 1}`} · ${pct}%`;
      const snippet = document.createElement('span');
      snippet.className = 'bm-snippet';
      snippet.textContent = bm.snippet || '';
      jump.append(labelEl, document.createElement('br'), meta);
      if (bm.snippet) jump.append(document.createElement('br'), snippet);
      jump.addEventListener('click', () => this.goToBookmark(bm.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bm-remove';
      remove.setAttribute('aria-label', 'Remove bookmark');
      remove.textContent = '×';
      remove.addEventListener('click', (e) => { e.stopPropagation(); this.removeBookmark(bm.id); });
      li.append(jump, remove);
      ol.append(li);
    }
  }

  #updateBookmarkButton() {
    const active = !!this.#bookmarkAtCurrent();
    this.#els.bookmarksToggle.setAttribute('aria-pressed', String(active));
    // Swap glyph: ★ when active, ☆ when not.
    this.#els.bookmarksToggle.textContent = active ? '★' : '☆';
    this.toggleAttribute('data-bookmark-active', active);
  }

  #toggleBookmarksPanel(force) {
    const open = typeof force === 'boolean' ? force : this.#els.bookmarksPanel.hidden;
    this.#els.bookmarksPanel.hidden = !open;
    this.#els.bookmarksToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // Close the settings + library panels — only one popover at a time.
      this.#els.settingsPanel.hidden = true;
      this.#els.settingsToggle.setAttribute('aria-expanded', 'false');
      this.#els.libraryPanel.hidden = true;
      this.#els.libraryToggle.setAttribute('aria-expanded', 'false');
    }
  }

  #emitBookmarksChange() {
    this.dispatchEvent(new CustomEvent('epub-bookmarks-change', {
      detail: { bookmarks: this.bookmarks },
      bubbles: true, composed: true,
    }));
  }

  // ------- library -------

  /**
   * Persist the just-opened book into the library store: source blob
   * (so we can re-open it later without re-fetching), metadata
   * (title/creator/identifier), cover thumbnail blob, addedAt /
   * lastOpenedAt timestamps. Idempotent — re-opening the same book
   * just bumps lastOpenedAt.
   *
   * @param {EpubBook} book
   */
  async #persistLibraryEntry(book) {
    if (!this.#bookId) return;
    /** @type {Blob | null} */
    const source = book.sourceBlob();
    if (!source) return;
    const existing = await dbGet('library', this.#bookId);
    /** @type {Blob | null} */
    const cover = existing?.cover || await book.coverBlob();
    const meta = book.metadata;
    /** @type {LibraryEntry} */
    const record = {
      id: this.#bookId,
      title: meta.title || '(untitled)',
      creator: meta.creator || '',
      identifier: meta.identifier || '',
      blob: source,
      cover,
      size: source.size,
      addedAt: existing?.addedAt || Date.now(),
      lastOpenedAt: Date.now(),
    };
    await dbPut('library', record);
    this.dispatchEvent(new CustomEvent('epub-library-change', {
      detail: { reason: 'added', id: this.#bookId },
      bubbles: true, composed: true,
    }));
  }

  /**
   * Read-only snapshot of all books in the library, sorted by most
   * recently opened. Each entry is a clone — mutations don't leak.
   *
   * @returns {Promise<LibraryEntry[]>}
   */
  async getLibrary() {
    /** @type {LibraryEntry[]} */
    const rows = await dbGetAll('library');
    return rows.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
      .map(r => ({ ...r }));
  }

  /**
   * Open a previously stored library entry. Convenience wrapper around
   * `open(blob)` that pulls the saved source from IDB.
   *
   * @param {string} id  Library entry id (same shape as bookId()).
   */
  async openFromLibrary(id) {
    const rec = /** @type {LibraryEntry | null} */ (await dbGet('library', id));
    if (!rec?.blob) return;
    await this.open(rec.blob);
  }

  /**
   * Remove a book from the library (does not touch positions or
   * bookmarks for that book — they stay until manually cleared).
   * @param {string} id
   */
  async removeFromLibrary(id) {
    await dbDelete('library', id);
    this.dispatchEvent(new CustomEvent('epub-library-change', {
      detail: { reason: 'removed', id },
      bubbles: true, composed: true,
    }));
  }

  /** Drop every library entry (and reading positions / bookmarks / highlights). */
  async clearLibrary() {
    await dbClear('library');
    await dbClear('positions');
    await dbClear('bookmarks');
    await dbClear('highlights');
    // Reflect the wipe in the open book's in-memory state so the UI
    // updates without a reload.
    this.#bookmarks = [];
    this.#renderBookmarks();
    this.#updateBookmarkButton();
    this.#highlights = [];
    this.#renderHighlights();
    const doc = this.#els.iframe.contentDocument;
    if (doc?.body) unwrapAll(doc.body, '[data-reader-mark="highlight"]');
    this.dispatchEvent(new CustomEvent('epub-library-change', {
      detail: { reason: 'cleared', id: null },
      bubbles: true, composed: true,
    }));
  }

  /**
   * Best-effort storage estimate (bytes used, bytes available, percent).
   * Returns null on browsers without navigator.storage.estimate().
   * @returns {Promise<{usage: number, quota: number, percent: number} | null>}
   */
  async getStorageEstimate() {
    if (!navigator.storage?.estimate) return null;
    try {
      const est = await navigator.storage.estimate();
      const usage = est.usage || 0;
      const quota = est.quota || 0;
      const percent = quota > 0 ? Math.round((usage / quota) * 100) : 0;
      return { usage, quota, percent };
    } catch { return null; }
  }

  async #toggleLibraryPanel(force) {
    const wasOpen = !this.#els.libraryPanel.hidden;
    const open = typeof force === 'boolean' ? force : !wasOpen;
    this.#els.libraryPanel.hidden = !open;
    this.#els.libraryToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      // Mutually-exclusive popovers.
      this.#els.bookmarksPanel.hidden = true;
      this.#els.bookmarksToggle.setAttribute('aria-expanded', 'false');
      this.#els.settingsPanel.hidden = true;
      this.#els.settingsToggle.setAttribute('aria-expanded', 'false');
      await this.#renderLibrary();
    }
  }

  async #renderLibrary() {
    /** @type {LibraryEntry[]} */
    const entries = await this.getLibrary();
    const ol = this.#els.libList;
    const panel = this.#els.libraryPanel;
    panel.dataset.empty = String(entries.length === 0);
    ol.innerHTML = '';
    /** @type {string[]} */
    const transientUrls = [];
    for (const entry of entries) {
      const li = document.createElement('li');
      li.dataset.bookId = entry.id;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lib-open';
      open.setAttribute('aria-label', `Open ${entry.title}`);

      const cover = document.createElement('div');
      cover.className = 'lib-cover';
      if (entry.cover) {
        const url = URL.createObjectURL(entry.cover);
        transientUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        cover.append(img);
      } else {
        cover.textContent = 'no cover';
      }

      const title = document.createElement('span');
      title.className = 'lib-title';
      title.textContent = entry.title;

      const meta = document.createElement('span');
      meta.className = 'lib-meta';
      const parts = [];
      if (entry.creator) parts.push(entry.creator);
      parts.push(formatBytes(entry.size));
      meta.textContent = parts.join(' · ');

      open.append(cover, title, meta);
      open.addEventListener('click', async () => {
        await this.#toggleLibraryPanel(false);
        await this.openFromLibrary(entry.id);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lib-remove';
      remove.setAttribute('aria-label', `Remove ${entry.title} from library`);
      remove.textContent = '×';
      remove.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${entry.title}" from the library?`)) return;
        await this.removeFromLibrary(entry.id);
        await this.#renderLibrary();
      });

      li.append(open, remove);
      ol.append(li);
    }
    // Free transient cover URLs after a tick so <img> has time to start
    // loading. The browser keeps the bytes alive while the load is in
    // flight, so revoking is safe.
    if (transientUrls.length) {
      setTimeout(() => transientUrls.forEach(URL.revokeObjectURL), 5_000);
    }

    // Quota text — warn at >= 80%.
    const est = await this.getStorageEstimate();
    if (est && est.quota > 0) {
      this.#els.libQuota.textContent =
        `${formatBytes(est.usage)} of ${formatBytes(est.quota)} used (${est.percent}%)`;
      this.#els.libQuota.dataset.warn = String(est.percent >= 80);
    } else {
      this.#els.libQuota.textContent = '';
      delete this.#els.libQuota.dataset.warn;
    }
  }

  /** Unload the current book and revoke any blob URLs it created. */
  close() {
    this.#currentIndex = -1;
    if (this.#book) { this.#book.destroy(); this.#book = null; }
    this.#bookId = null;
    this.#bookmarks = [];
    this.#renderBookmarks();
    this.#updateBookmarkButton();
    this.#highlights = [];
    this.#renderHighlights();
    this.#hideHighlightPopover();
    this.#els.highlightsPanel.hidden = true;
    this.#els.highlightsToggle.setAttribute('aria-expanded', 'false');
    this.find(false);
    // Reset full-text search state — index belongs to the closed book.
    this.#searchIndex = null;
    this.#searchIndexPromise = null;
    this.#searchQuery = '';
    this.#els.searchInput.value = '';
    this.#els.searchStatus.textContent = '';
    this.#els.searchResults.innerHTML = '';
    this.#els.searchPanel.hidden = true;
    this.#els.searchToggle.setAttribute('aria-expanded', 'false');
    this.#els.iframe.removeAttribute('src');
    this.#els.toc.innerHTML = '';
    this.#els.title.textContent = '';
    this.#els.progress.textContent = '';
    this.#els.prev.disabled = this.#els.next.disabled = true;
    this.#setOverlay('Drop an EPUB file here or choose one to begin.');
  }

  /** Advance to the next spine item. No-op if already at the last. */
  async next() { if (this.#book && this.#currentIndex + 1 < this.#book.spine.length) await this.goToIndex(this.#currentIndex + 1); }

  /** Move to the previous spine item. No-op if already at the first. */
  async prev() { if (this.#book && this.#currentIndex > 0) await this.goToIndex(this.#currentIndex - 1); }

  /**
   * @param {number} index
   * @param {string} [fragment='']
   * @returns {Promise<void>}
   */
  async goToIndex(index, fragment = '') {
    if (!this.#book) return;
    const spine = this.#book.spine;
    if (index < 0 || index >= spine.length) return;
    this.#currentIndex = index;
    const chapter = await this.#book.chapter(index);
    this.#els.iframe.dataset.fragment = fragment;
    this.#els.iframe.src = chapter.url;
    this.#updateChrome();
    this.dispatchEvent(new CustomEvent('epub-navigate', {
      detail: {
        index,
        path: chapter.path,
        title: this.#tocLabelForPath(chapter.path),
      },
      bubbles: true,
      composed: true,
    }));
    // Persist immediately on chapter change (don't wait for the
    // throttled scroll-pause save) so closing the tab mid-chapter
    // resumes from the right place next time.
    this.#schedulePositionSave();
  }

  /** @param {string} pathOrHref */
  async goToPath(pathOrHref) {
    if (!this.#book) return;
    const [rawPath, fragmentRaw] = pathOrHref.split('#');
    const fragment = fragmentRaw ?? '';
    let path = rawPath;
    try { path = decodeURIComponent(rawPath); } catch {}
    let idx = this.#book.spineIndexOf(path);
    if (idx < 0) {
      // Non-spine target (e.g. landmarks) — still try to open it directly.
      try {
        const url = await this.#book.resourceUrl(path);
        this.#els.iframe.dataset.fragment = fragment;
        this.#els.iframe.src = url;
      } catch (err) {
        console.warn('goToPath failed', err);
      }
      return;
    }
    await this.goToIndex(idx, fragment);
  }

  // ------- internals -------

  #updateChrome() {
    if (!this.#book) return;
    const meta = this.#book.metadata;
    this.#els.title.textContent = meta.title || '(untitled)';
    this.#els.progress.textContent = `${this.#currentIndex + 1} / ${this.#book.spine.length}`;
    this.#els.prev.disabled = this.#currentIndex <= 0;
    this.#els.next.disabled = this.#currentIndex >= this.#book.spine.length - 1;
    this.#highlightToc();
    this.#updateBookmarkButton();
  }

  #renderToc() {
    const ol = this.#els.toc;
    ol.innerHTML = '';
    if (!this.#book) return;
    const buildList = (items) => {
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const li = document.createElement('li');
        // EPUB nav docs use <span> (no href) for section group headings
        // like author names. Render those as a non-link element so they
        // aren't focusable as links and don't look clickable.
        if (item.path) {
          const a = document.createElement('a');
          a.textContent = item.label;
          a.href = '#';
          a.dataset.path = item.path;
          a.dataset.fragment = item.fragment || '';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            if (!this.#book) return;
            const idx = this.#book.spineIndexOf(item.path);
            if (idx >= 0) this.goToIndex(idx, item.fragment);
            else this.goToPath(item.path + (item.fragment ? '#' + item.fragment : ''));
          });
          li.append(a);
        } else {
          const heading = document.createElement('strong');
          heading.className = 'toc-heading';
          heading.textContent = item.label;
          li.append(heading);
        }
        if (item.children && item.children.length) {
          const sub = document.createElement('ol');
          sub.append(buildList(item.children));
          li.append(sub);
        }
        frag.append(li);
      }
      return frag;
    };
    ol.append(buildList(this.#book.toc));
  }

  #highlightToc() {
    const path = this.#book?.spine[this.#currentIndex]?.path;
    for (const a of this.#els.toc.querySelectorAll('a')) {
      a.classList.toggle('current', !!path && a.dataset.path === path);
    }
  }

  #tocLabelForPath(path) {
    const found = findInToc(this.#book?.toc || [], path);
    return found ? found.label : (this.#book?.metadata?.title || '');
  }

  #onIframeLoad() {
    const iframe = this.#els.iframe;
    const doc = iframe.contentDocument;
    if (!doc) return;

    // Apply chapter theming (VB tokens) + typography + layout before
    // paint to avoid a visible reflow.
    this.#applyChapterThemingTo(doc);
    this.#applyTypographyTo(doc);
    this.#applyLayoutTo(doc);
    this.#applyPaginatedTo(doc);
    this.#wireChapterScroll(iframe);
    this.#wirePagination(iframe);

    // Intercept in-book navigation via [data-epub-href] (set by epub.js).
    doc.addEventListener('click', (e) => {
      const target = /** @type {Element | null} */ (e.target);
      const a = target?.closest?.('[data-epub-href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('data-epub-href');
      if (href) this.goToPath(href);
    });

    // Forward Ctrl/Cmd+F and Escape from the iframe to our find bar.
    doc.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        this.find(true);
      } else if (e.key === 'Escape' && !this.#els.findBar.hidden) {
        e.preventDefault();
        this.find(false);
      }
    });

    // Re-apply find marks for the current query (chapter changed under us).
    if (!this.#els.findBar.hidden && this.#findQuery) {
      this.#refreshFind();
    } else {
      this.#findClearMarks(doc);
    }
    // Re-apply book-wide search highlights for the active query, if any.
    if (this.#searchQuery && doc.body) {
      this.#highlightSearchInChapter(doc, this.#searchQuery);
    }
    // Re-apply persisted highlights for the new chapter + listen for
    // selections so the popover can offer to add new highlights.
    this.#applyHighlightsTo(doc);
    this.#wireHighlightSelection(iframe);

    // Scroll to the requested fragment, if any.
    const frag = iframe.dataset.fragment;
    if (frag) {
      this.#scrollToFragment(iframe, frag);
    } else {
      doc.documentElement.scrollTop = 0;
      if (doc.body) doc.body.scrollTop = 0;
    }
  }

  /**
   * Reliably scroll to a fragment in the chapter iframe, handling the
   * common race conditions:
   *   1. The element isn't in the DOM yet when `iframe.load` fires
   *      (deferred parsing). MutationObserver retries until it appears
   *      or a budget elapses.
   *   2. The element is in the DOM but layout hasn't settled because
   *      images are still loading. After the initial scroll, we wait
   *      for the iframe window's `load` event and scroll again so the
   *      final layout lands on the right anchor.
   *
   * @param {HTMLIFrameElement} iframe
   * @param {string} frag    Fragment identifier without leading `#`.
   */
  #scrollToFragment(iframe, frag) {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return;

    const tryScroll = () => {
      const el = doc.getElementById(frag) || doc.querySelector(`[name="${CSS.escape(frag)}"]`);
      if (el) el.scrollIntoView({ block: 'start' });
      return !!el;
    };

    if (tryScroll()) {
      // First scroll succeeded. After all subresources (images, fonts)
      // load, the layout may shift — re-scroll once to land cleanly.
      const onLoaded = () => { tryScroll(); win.removeEventListener('load', onLoaded); };
      if (doc.readyState === 'complete') queueMicrotask(onLoaded);
      else win.addEventListener('load', onLoaded, { once: true });
      return;
    }

    // Element not in DOM yet — observe for it, with a budget.
    const observer = new MutationObserver(() => { if (tryScroll()) { observer.disconnect(); cleanup(); } });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); }, 1500);
    const cleanup = () => clearTimeout(timer);
  }

  /**
   * Inject (or update) the typography override <style> in a chapter doc.
   * @param {Document} doc
   */
  #applyTypographyTo(doc) {
    // SVG-in-spine documents have no <head>; nothing to do.
    if (doc.documentElement?.localName === 'svg') return;
    const head = doc.head || doc.documentElement;
    if (!head) return;
    const id = '__epub_reader_typography';
    let style = /** @type {HTMLStyleElement | null} */ (doc.getElementById(id));
    if (!style) {
      style = doc.createElement('style');
      style.id = id;
      head.append(style);
    }
    style.textContent = buildTypographyCss(this.#typography);

    // Marks stylesheet — find / search / highlight wrappers all use
    // [data-reader-mark="..."]. Idempotent: only inject once per doc.
    if (!doc.getElementById('__epub_reader_marks')) {
      const m = doc.createElement('style');
      m.id = '__epub_reader_marks';
      m.textContent = MARKS_CSS;
      head.append(m);
    }
  }

  #onKeyDown(e) {
    if (!this.#book) return;
    // Ctrl/Cmd+F intercepts the browser's native find — handled even
    // when modifiers are present.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      this.find(true);
      e.preventDefault();
      return;
    }
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && !this.#els.findBar.hidden) {
      this.find(false); e.preventDefault(); return;
    }
    const paginated = this.#typography.layoutMode === 'paginated';
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      if (paginated) this.#pageNext(); else this.next();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (paginated) this.#pagePrev(); else this.prev();
      e.preventDefault();
    } else if (e.key === 'b' || e.key === 'B') {
      this.toggleBookmark();
      e.preventDefault();
    }
  }

  #toggleToc() {
    // In narrow layouts, show/hide the sidebar overlay.
    this.#els.shell.classList.toggle('toc-open');
    // In wide layouts, collapse the sidebar column.
    this.#els.shell.classList.toggle('toc-hidden');
  }

  // ------- typography -------

  /** Current typography overrides. Returns a clone so external mutation can't leak. */
  get typography() { return { ...this.#typography }; }

  /**
   * Replace the current typography overrides. Persists to localStorage,
   * fires `epub-typography-change`, and re-applies to the current chapter.
   * @param {Partial<TypographySettings>} value
   */
  set typography(value) {
    this.#typography = { ...defaultTypography(), ...this.#typography, ...value };
    saveTypography(this.#typography);
    this.#syncSettingsControls();
    const doc = this.#els.iframe.contentDocument;
    if (doc) {
      this.#applyTypographyTo(doc);
      this.#applyPaginatedTo(doc);
      this.#updateChapterProgress();
    }
    this.dispatchEvent(new CustomEvent('epub-typography-change', {
      detail: { typography: { ...this.#typography } },
      bubbles: true, composed: true,
    }));
  }

  /** Reset typography overrides to publisher defaults. */
  resetTypography() { this.typography = defaultTypography(); }

  /** Adjust font size by `delta` percent, clamped to the slider range. */
  #stepFontSize(delta) {
    const next = Math.min(200, Math.max(80, this.#typography.fontSize + delta));
    if (next !== this.#typography.fontSize) this.typography = { fontSize: next };
  }

  // ------- chapter theming -------

  /**
   * Inject (or update) a tiny stylesheet in the chapter doc that pulls
   * Vanilla Breeze tokens off the host's computed style and applies them
   * to the chapter body. This keeps EPUB content visually coherent with
   * whatever VB theme the host page has active — no reader-side theme
   * preset list, no theme picker, no localStorage. The host page owns
   * theming via VB's own theme switcher.
   *
   * @param {Document} doc
   */
  #applyChapterThemingTo(doc) {
    if (doc.documentElement?.localName === 'svg') return;
    const head = doc.head || doc.documentElement;
    if (!head) return;
    const id = '__epub_reader_theme';
    let style = /** @type {HTMLStyleElement | null} */ (doc.getElementById(id));
    if (!style) {
      style = doc.createElement('style');
      style.id = id;
      head.insertBefore(style, head.firstChild);
    }
    const cs = this.ownerDocument?.defaultView?.getComputedStyle(this);
    const pick = (/** @type {string} */ name, /** @type {string} */ fallback) =>
      cs?.getPropertyValue(name).trim() || fallback;
    const bg     = pick('--color-background',  '#ffffff');
    const fg     = pick('--color-text',        '#1f1f1f');
    const link   = pick('--color-interactive', '#2d6cdf');
    const border = pick('--color-border',      '#e4e4e7');
    style.textContent = [
      `html, body { background-color: ${bg} !important; color: ${fg} !important; }`,
      `a, a:link { color: ${link} !important; }`,
      `a:visited { color: color-mix(in srgb, ${link} 70%, ${fg}) !important; }`,
      `hr { border-color: ${border} !important; }`,
    ].join('\n');
  }

  /**
   * Inject layout overrides for pre-paginated (image-page) chapters so
   * the primary image fits the viewport instead of overflowing at native
   * size. Reflowable chapters get no layout rules (publisher CSS wins).
   * @param {Document} doc
   */
  #applyLayoutTo(doc) {
    if (doc.documentElement?.localName === 'svg') return;
    const head = doc.head || doc.documentElement;
    if (!head) return;
    const id = '__epub_reader_layout';
    let style = /** @type {HTMLStyleElement | null} */ (doc.getElementById(id));
    const item = this.#book?.spine[this.#currentIndex];
    const isFixed = item?.layout === 'pre-paginated';
    if (!isFixed) {
      // Reflowable: remove any leftover fixed-layout style from a prior chapter.
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElement('style');
      style.id = id;
      head.append(style);
    }
    style.textContent = [
      `html, body { margin: 0 !important; padding: 0 !important; height: 100vh !important; width: 100vw !important; overflow: hidden !important; }`,
      `body { display: flex !important; align-items: center !important; justify-content: center !important; }`,
      `body img, body svg { max-inline-size: 100vw !important; max-block-size: 100vh !important; inline-size: auto !important; block-size: auto !important; object-fit: contain !important; }`,
    ].join('\n');
  }

  /**
   * Inject (or remove) the paginated-columns stylesheet. Active only
   * when `typography.layoutMode === 'paginated'` AND the chapter is
   * reflowable (pre-paginated chapters are already image-page-fitted).
   * @param {Document} doc
   */
  #applyPaginatedTo(doc) {
    if (doc.documentElement?.localName === 'svg') return;
    const head = doc.head || doc.documentElement;
    if (!head) return;
    const id = '__epub_reader_paginated';
    let style = /** @type {HTMLStyleElement | null} */ (doc.getElementById(id));
    const item = this.#book?.spine[this.#currentIndex];
    const reflowable = !item || item.layout !== 'pre-paginated';
    const wantPaginated = this.#typography.layoutMode === 'paginated' && reflowable;
    if (!wantPaginated) { style?.remove(); return; }
    if (!style) { style = doc.createElement('style'); style.id = id; head.append(style); }
    style.textContent = [
      // Lock the document to the viewport, lay children out as columns
      // exactly the viewport's width, and let body horizontally scroll
      // through them. scroll-snap keeps page-turns crisp.
      `html { height: 100vh !important; overflow: hidden !important; margin: 0 !important; }`,
      `body { margin: 0 !important; height: 100vh !important;`
        + ` column-width: 100vw !important; column-gap: 0 !important; column-fill: auto !important;`
        + ` overflow-x: auto !important; overflow-y: hidden !important;`
        + ` scroll-snap-type: x mandatory !important; scrollbar-width: none !important;`
        + ` overscroll-behavior-x: contain !important; }`,
      `body::-webkit-scrollbar { display: none !important; }`,
      // Most chapter children are paragraphs and headings; snapping at
      // the body level is enough, but anchors at column starts help RTL.
      `body > * { scroll-snap-align: start; }`,
      // Tame oversized media so it never overflows a column.
      `body img, body svg, body video, body iframe { max-inline-size: 100% !important; max-block-size: 100% !important; block-size: auto !important; }`,
      // Avoid splitting figures/blockquotes across page boundaries
      // when possible — readability win.
      `figure, blockquote, pre, table { break-inside: avoid; }`,
    ].join('\n');
  }

  /**
   * Compute current/total pages of the visible chapter (paginated mode).
   * Returns null if not in paginated mode or the iframe doc isn't ready.
   * @returns {{current: number, total: number, atStart: boolean, atEnd: boolean} | null}
   */
  #pageInfo() {
    if (this.#typography.layoutMode !== 'paginated') return null;
    const doc = this.#els.iframe.contentDocument;
    if (!doc?.body) return null;
    const item = this.#book?.spine[this.#currentIndex];
    if (item?.layout === 'pre-paginated') return null;
    const body = doc.body;
    const pageW = body.clientWidth;
    if (pageW <= 0) return null;
    const total = Math.max(1, Math.round(body.scrollWidth / pageW));
    const cur = Math.round(Math.abs(body.scrollLeft) / pageW);
    return {
      current: cur + 1,
      total,
      atStart: cur <= 0,
      atEnd:   cur >= total - 1,
    };
  }

  /** Advance one page within the current chapter; spill over to next chapter at end. */
  async #pageNext() {
    const info = this.#pageInfo();
    if (!info) { return this.next(); }
    if (info.atEnd) {
      this.#enterFromBack = false;
      return this.next();
    }
    const body = this.#els.iframe.contentDocument?.body;
    if (!body) return;
    body.scrollBy({ left: body.clientWidth, behavior: 'instant' });
    this.#updateChapterProgress();
  }

  /** Step back one page within the current chapter; spill over to prev chapter at start. */
  async #pagePrev() {
    const info = this.#pageInfo();
    if (!info) { return this.prev(); }
    if (info.atStart) {
      this.#enterFromBack = true;
      return this.prev();
    }
    const body = this.#els.iframe.contentDocument?.body;
    if (!body) return;
    body.scrollBy({ left: -body.clientWidth, behavior: 'instant' });
    this.#updateChapterProgress();
  }

  /**
   * Wire pagination affordances: scroll-to-end on backward chapter
   * spillover, edge clicks (prev/next page), touch-swipe page-turn.
   * @param {HTMLIFrameElement} iframe
   */
  #wirePagination(iframe) {
    const doc = iframe.contentDocument;
    const body = doc?.body;
    if (!doc || !body) return;
    const paginated = this.#typography.layoutMode === 'paginated' &&
                      this.#book?.spine[this.#currentIndex]?.layout !== 'pre-paginated';
    if (!paginated) return;

    // If we entered the chapter via backward chapter navigation, jump
    // to the last page so the reader stays "going backwards".
    if (this.#enterFromBack) {
      const after = () => {
        const pageW = body.clientWidth;
        const last = Math.max(0, Math.floor(body.scrollWidth / pageW) - 0) - 1;
        body.scrollLeft = Math.max(0, last) * pageW;
        this.#updateChapterProgress();
      };
      // Wait one frame for layout, then a second time after window load
      // (subresources affecting column flow).
      requestAnimationFrame(after);
      iframe.contentWindow?.addEventListener('load', after, { once: true });
      this.#enterFromBack = false;
    }

    // Edge-click + touch-swipe support.
    let downX = 0, downY = 0, downT = 0;
    doc.addEventListener('pointerdown', (ev) => {
      downX = ev.clientX; downY = ev.clientY; downT = Date.now();
    });
    doc.addEventListener('pointerup', (ev) => {
      const dx = ev.clientX - downX, dy = ev.clientY - downY;
      const dt = Date.now() - downT;
      const insideAnchor = /** @type {Element | null} */ (ev.target)?.closest?.('a, button, [data-epub-href]');
      if (insideAnchor) return;
      // Swipe: fast horizontal drag.
      if (dt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) this.#pageNext(); else this.#pagePrev();
        return;
      }
      // Edge click (no real movement): hit a page-turn zone.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
        const w = body.clientWidth;
        if (ev.clientX < Math.min(120, w * 0.15)) this.#pagePrev();
        else if (ev.clientX > w - Math.min(120, w * 0.15)) this.#pageNext();
      }
    });
  }

  /** Recompute and write the chapter-progress display. */
  #updateChapterProgress() {
    const display = this.#els.chapterProgress;
    const info = this.#pageInfo();
    if (info) {
      display.hidden = false;
      display.textContent = `Page ${info.current} of ${info.total}`;
      return;
    }
    // Scroll mode: percentage already wired by #wireChapterScroll on
    // each scroll event; nothing to do here.
  }

  /** True when the next chapter load should land at the end (back-paging spillover). */
  #enterFromBack = false;

  /**
   * Track scroll position inside the chapter iframe and update the
   * `.chapter-progress` span. Reflowable chapters get a percentage,
   * fixed-layout (image-page) chapters get nothing — there's no scroll.
   * @param {HTMLIFrameElement} iframe
   */
  #wireChapterScroll(iframe) {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) return;
    const item = this.#book?.spine[this.#currentIndex];
    const isFixed = item?.layout === 'pre-paginated';
    const display = this.#els.chapterProgress;
    if (isFixed) {
      display.hidden = true;
      display.textContent = '';
      return;
    }
    const paginated = this.#typography.layoutMode === 'paginated';
    display.hidden = false;
    const update = () => {
      if (this.#typography.layoutMode === 'paginated') {
        this.#updateChapterProgress();
        return;
      }
      const se = doc.scrollingElement || doc.documentElement;
      const max = se.scrollHeight - se.clientHeight;
      const pct = max > 0 ? Math.round((se.scrollTop / max) * 100) : 100;
      display.textContent = `${pct}%`;
    };
    update();
    // Vertical scroll (scroll mode) and horizontal scroll (paginated)
    // both fire the same event on the window.
    const onScroll = () => {
      update();
      this.#schedulePositionSave();
      this.#updateBookmarkButton();
    };
    win.addEventListener('scroll', onScroll, { passive: true });
    doc.body?.addEventListener('scroll', onScroll, { passive: true });
    // After subresources load, layout shifts; recompute once.
    win.addEventListener('load', update, { once: true });
  }

  #toggleSettings(force) {
    const open = typeof force === 'boolean' ? force : this.#els.settingsPanel.hidden;
    this.#els.settingsPanel.hidden = !open;
    this.#els.settingsToggle.setAttribute('aria-expanded', String(open));
    if (open) this.#els.sFontFamily.focus();
  }

  #wireSettingsControls() {
    const e = this.#els;
    /** @param {Partial<TypographySettings>} patch */
    const update = (patch) => { this.typography = patch; };
    e.sFontFamily.addEventListener('change', () => update({ fontFamily: e.sFontFamily.value }));
    e.sFontSize.addEventListener('input', () => update({ fontSize: Number(e.sFontSize.value) }));
    e.sLineHeight.addEventListener('input', () => {
      const v = Number(e.sLineHeight.value);
      update({ lineHeight: v <= 100 ? 0 : v });
    });
    e.sParagraphSpacing.addEventListener('input', () => {
      const v = Number(e.sParagraphSpacing.value);
      update({ paragraphSpacing: v < 0 ? -1 : v });
    });
    e.sJustify.addEventListener('change', () => update({ justify: e.sJustify.checked }));
    e.sReadingWidth.addEventListener('input', () => update({ readingWidth: Number(e.sReadingWidth.value) }));
    e.sLayoutScroll.addEventListener('click', () => update({ layoutMode: 'scroll' }));
    e.sLayoutPaginated.addEventListener('click', () => update({ layoutMode: 'paginated' }));
    // User CSS: re-apply on every keystroke (cheap — sanitiser runs in O(n)).
    e.sUserCss.addEventListener('input', () => update({ userCss: e.sUserCss.value }));
    e.sReset.addEventListener('click', () => this.resetTypography());
    e.sClose.addEventListener('click', () => this.#toggleSettings(false));

    // Close popovers on outside click. Both panels are mutually exclusive
    // (only one open at a time) so we check each independently.
    this.addEventListener('pointerdown', (ev) => {
      const path = ev.composedPath();
      if (!e.settingsPanel.hidden &&
          !path.includes(e.settingsPanel) &&
          !path.includes(e.settingsToggle)) {
        this.#toggleSettings(false);
      }
      if (!e.bookmarksPanel.hidden &&
          !path.includes(e.bookmarksPanel) &&
          !path.includes(e.bookmarksToggle)) {
        this.#toggleBookmarksPanel(false);
      }
      if (!e.libraryPanel.hidden &&
          !path.includes(e.libraryPanel) &&
          !path.includes(e.libraryToggle)) {
        this.#toggleLibraryPanel(false);
      }
      if (!e.searchPanel.hidden &&
          !path.includes(e.searchPanel) &&
          !path.includes(e.searchToggle)) {
        this.#toggleSearchPanel(false);
      }
      if (!e.highlightsPanel.hidden &&
          !path.includes(e.highlightsPanel) &&
          !path.includes(e.highlightsToggle)) {
        this.#toggleHighlightsPanel(false);
      }
    });
  }

  /** Sync the panel inputs to reflect the current typography + theme state. */
  #syncSettingsControls() {
    const e = this.#els;
    if (!e?.sFontFamily) return;
    const t = this.#typography;
    e.sFontFamily.value = t.fontFamily;
    e.sFontSize.value = String(t.fontSize);
    e.sFontSizeV.textContent = `${t.fontSize}%`;
    e.sLineHeight.value = String(t.lineHeight || 100);
    e.sLineHeightV.textContent = t.lineHeight ? (t.lineHeight / 100).toFixed(2) : 'default';
    e.sParagraphSpacing.value = String(t.paragraphSpacing);
    e.sParagraphSpacingV.textContent = t.paragraphSpacing < 0
      ? 'default'
      : `${(t.paragraphSpacing / 10).toFixed(1)}em`;
    e.sJustify.checked = !!t.justify;
    e.sJustify.indeterminate = t.justify === null;
    e.sReadingWidth.value = String(t.readingWidth);
    e.sReadingWidthV.textContent = t.readingWidth === 0 ? 'unlimited' : `${t.readingWidth} ch`;
    const paginated = t.layoutMode === 'paginated';
    e.sLayoutScroll.dataset.readerState = paginated ? '' : 'active';
    e.sLayoutPaginated.dataset.readerState = paginated ? 'active' : '';
    e.sLayoutScroll.setAttribute('aria-checked', String(!paginated));
    e.sLayoutPaginated.setAttribute('aria-checked', String(paginated));
    if (e.sUserCss.value !== t.userCss) e.sUserCss.value = t.userCss;
  }

  #setOverlay(message, isError = false) {
    const ov = this.#els.overlay;
    ov.classList.toggle('error', isError);
    const messageEl = ov.querySelector('.message');
    if (messageEl) messageEl.textContent = message;
    ov.hidden = false;
  }
  #hideOverlay() { this.#els.overlay.hidden = true; }
}

/**
 * Human-readable byte count: 1.6 MB, 184 KB, 12 B, etc.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function findInToc(items, path) {
  for (const item of items) {
    if (item.path === path) return item;
    if (item.children?.length) {
      const inner = findInToc(item.children, path);
      if (inner) return inner;
    }
  }
  return null;
}

if (!customElements.get('epub-reader')) {
  customElements.define('epub-reader', EpubReaderElement);
}
