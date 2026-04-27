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
/** @typedef {import('./epub.js').EpubBook} EpubBook */
/** @typedef {import('./epub.js').TocEntry} TocEntry */

/**
 * @typedef {object} ReaderElements
 * @property {HTMLDivElement}      shell
 * @property {HTMLSpanElement}     title
 * @property {HTMLSpanElement}     progress
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
 * @property {HTMLSpanElement}     sFontSizeV
 * @property {HTMLSpanElement}     sLineHeightV
 * @property {HTMLSpanElement}     sParagraphSpacingV
 * @property {HTMLButtonElement}   sReset
 * @property {HTMLButtonElement}   sClose
 */

/**
 * Typography overrides applied to chapter content. Sentinel values
 * mean "publisher default" (no rule emitted): empty string for
 * `fontFamily`, 0 for `lineHeight`, -1 for `paragraphSpacing`,
 * `null` for `justify`.
 *
 * @typedef {object} TypographySettings
 * @property {string}                fontFamily
 * @property {number}                fontSize           Percent, default 100.
 * @property {number}                lineHeight         0 = default.
 * @property {number}                paragraphSpacing   -1 = default; else em.
 * @property {boolean | null}        justify
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
  };
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
  return rules.join('\n');
}



// Component CSS, scoped via @scope so it never leaks beyond <epub-reader>.
// All colours / sizes / radii read Vanilla Breeze tokens with sensible
// fallbacks, so the component is themable when VB is loaded and usable
// (if plainer) when it isn't.
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
      <button class="reader-icon-btn next" type="button" aria-label="Next chapter">&rarr;</button>
    </div>
    <div class="reader-control-group">
      <button class="reader-icon-btn font-decrease" type="button" aria-label="Decrease font size">A&minus;</button>
      <button class="reader-icon-btn font-increase" type="button" aria-label="Increase font size">A+</button>
      <button class="reader-icon-btn settings-toggle" type="button" aria-label="Reading settings" aria-expanded="false" title="Reading settings">Aa</button>
    </div>
  </div>
</header>
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
      <div class="row checkbox">
        <label><input class="s-justify" type="checkbox" /><span>Justify text</span></label>
      </div>
      <div class="row">
        <button type="button" class="s-reset">Reset</button>
        <button type="button" class="s-close primary">Done</button>
      </div>
    </aside>
    <iframe sandbox="allow-same-origin" title="EPUB content"></iframe>
    <div class="overlay">
      <div class="message">Drop an EPUB file here or choose one to begin.</div>
    </div>
  </div>
</div>
`;



export class EpubReaderElement extends HTMLElement {
  static get observedAttributes() { return ['src', 'start', 'hide-toc']; }

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
      sFontSizeV:         $('.s-font-size-v'),
      sLineHeightV:       $('.s-line-height-v'),
      sParagraphSpacingV: $('.s-paragraph-spacing-v'),
      sReset:             $('.s-reset'),
      sClose:             $('.s-close'),
    };
    this.#els.prev.addEventListener('click', () => this.prev());
    this.#els.next.addEventListener('click', () => this.next());
    this.#els.toggle.addEventListener('click', () => this.#toggleToc());
    this.#els.settingsToggle.addEventListener('click', () => this.#toggleSettings());
    this.#els.fontDecrease.addEventListener('click', () => this.#stepFontSize(-10));
    this.#els.fontIncrease.addEventListener('click', () => this.#stepFontSize(+10));
    this.#els.iframe.addEventListener('load', () => this.#onIframeLoad());
    this.addEventListener('keydown', (e) => this.#onKeyDown(e));
    this.#wireSettingsControls();
    this.#syncSettingsControls();
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
      this.#renderToc();
      const start = Math.max(0, Math.min(
        book.spine.length - 1,
        Number(this.getAttribute('start') || 0) || 0
      ));
      this.dispatchEvent(new CustomEvent('epub-loaded', {
        detail: {
          metadata: book.metadata,
          spineLength: book.spine.length,
          toc: book.toc,
        },
        bubbles: true,
        composed: true,
      }));
      await this.goToIndex(start);
      this.#hideOverlay();
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

  /** Unload the current book and revoke any blob URLs it created. */
  close() {
    this.#currentIndex = -1;
    if (this.#book) { this.#book.destroy(); this.#book = null; }
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
  }

  #renderToc() {
    const ol = this.#els.toc;
    ol.innerHTML = '';
    if (!this.#book) return;
    const buildList = (items) => {
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.textContent = item.label;
        a.href = '#';
        a.dataset.path = item.path || '';
        a.dataset.fragment = item.fragment || '';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (!item.path || !this.#book) return;
          const idx = this.#book.spineIndexOf(item.path);
          if (idx >= 0) this.goToIndex(idx, item.fragment);
          else this.goToPath(item.path + (item.fragment ? '#' + item.fragment : ''));
        });
        li.append(a);
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

    // Apply chapter theming (VB tokens) + typography overrides before
    // paint to avoid a visible reflow.
    this.#applyChapterThemingTo(doc);
    this.#applyTypographyTo(doc);

    // Intercept in-book navigation via [data-epub-href] (set by epub.js).
    doc.addEventListener('click', (e) => {
      const target = /** @type {Element | null} */ (e.target);
      const a = target?.closest?.('[data-epub-href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('data-epub-href');
      if (href) this.goToPath(href);
    });

    // Scroll to the requested fragment, if any.
    const frag = iframe.dataset.fragment;
    if (frag) {
      const target = doc.getElementById(frag);
      if (target) target.scrollIntoView();
    } else {
      doc.documentElement.scrollTop = 0;
      if (doc.body) doc.body.scrollTop = 0;
    }
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
  }

  #onKeyDown(e) {
    if (!this.#book) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      this.next(); e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      this.prev(); e.preventDefault();
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
    if (doc) this.#applyTypographyTo(doc);
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
    e.sReset.addEventListener('click', () => this.resetTypography());
    e.sClose.addEventListener('click', () => this.#toggleSettings(false));

    // Close panel on outside click.
    this.addEventListener('pointerdown', (ev) => {
      if (e.settingsPanel.hidden) return;
      const path = ev.composedPath();
      if (path.includes(e.settingsPanel) || path.includes(e.settingsToggle)) return;
      this.#toggleSettings(false);
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
