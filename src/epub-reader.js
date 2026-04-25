// <epub-reader> custom element. Wraps the EPUB parser in a UI with a
// sidebar TOC, a toolbar, and an iframe rendering the current spine item.
// Uses Shadow DOM for style encapsulation so it can be dropped into any page.
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
 * @property {HTMLDivElement}     shell
 * @property {HTMLSpanElement}    title
 * @property {HTMLSpanElement}    progress
 * @property {HTMLButtonElement}  prev
 * @property {HTMLButtonElement}  next
 * @property {HTMLButtonElement}  toggle
 * @property {HTMLElement}        sidebar
 * @property {HTMLOListElement}   toc
 * @property {HTMLIFrameElement}  iframe
 * @property {HTMLDivElement}     overlay
 */

const TEMPLATE = `
<style>
  :host {
    --reader-bg:        var(--vb-color-surface, #fbfaf7);
    --reader-fg:        var(--vb-color-text, #1f1f1f);
    --reader-muted:     var(--vb-color-muted, #667085);
    --reader-accent:    var(--vb-color-primary, #2d6cdf);
    --reader-border:    var(--vb-color-border, #e4e4e7);
    --reader-sidebar-w: 18rem;
    --reader-font:      var(--vb-font-body, system-ui, -apple-system, "Segoe UI", sans-serif);
    --reader-content-font: var(--reader-font);

    display: block;
    position: relative;
    block-size: 100%;
    min-block-size: 20rem;
    color: var(--reader-fg);
    background: var(--reader-bg);
    font-family: var(--reader-font);
    container-type: inline-size;
  }

  .shell {
    display: grid;
    grid-template-columns: var(--reader-sidebar-w) 1fr;
    grid-template-rows: auto 1fr;
    block-size: 100%;
    min-block-size: inherit;
  }
  :host([hide-toc]) .shell,
  .shell.toc-hidden { grid-template-columns: 0 1fr; }
  :host([hide-toc]) .sidebar,
  .shell.toc-hidden .sidebar { display: none; }

  .toolbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: .5rem;
    padding: .5rem .75rem;
    border-block-end: 1px solid var(--reader-border);
    background: var(--reader-bg);
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
  }
  .toolbar .title {
    flex: 1;
    min-inline-size: 0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toolbar .progress {
    color: var(--reader-muted);
    font-variant-numeric: tabular-nums;
    font-size: .9em;
  }
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--reader-border);
    border-radius: .375rem;
    padding: .35rem .6rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: color-mix(in srgb, var(--reader-accent) 8%, transparent); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primary { background: var(--reader-accent); color: white; border-color: transparent; }
  button.icon { padding: .35rem .5rem; }

  .sidebar {
    overflow: auto;
    border-inline-end: 1px solid var(--reader-border);
    padding: .5rem;
    background: var(--reader-bg);
  }
  .sidebar h2 {
    font-size: .75rem;
    text-transform: uppercase;
    letter-spacing: .08em;
    color: var(--reader-muted);
    margin: .25rem .25rem .5rem;
  }
  .toc, .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc ol { padding-inline-start: .75rem; border-inline-start: 1px solid var(--reader-border); margin-block: .25rem; }
  .toc li { margin: 0; }
  .toc a {
    display: block;
    padding: .3rem .5rem;
    border-radius: .25rem;
    color: inherit;
    text-decoration: none;
    line-height: 1.3;
    font-size: .9rem;
  }
  .toc a:hover { background: color-mix(in srgb, var(--reader-accent) 10%, transparent); }
  .toc a.current { background: color-mix(in srgb, var(--reader-accent) 16%, transparent); font-weight: 600; }

  .content { position: relative; overflow: hidden; background: var(--reader-bg); }
  iframe {
    inline-size: 100%;
    block-size: 100%;
    border: 0;
    display: block;
    background: white;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 2rem;
    text-align: center;
    color: var(--reader-muted);
    pointer-events: none;
  }
  .overlay[hidden] { display: none; }
  .overlay .message { max-inline-size: 32rem; }
  .overlay.error { color: #b42318; }

  @container (inline-size < 40rem) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { display: none; position: absolute; inset: 3rem 0 0 0; z-index: 1; inline-size: min(20rem, 90%); box-shadow: 0 4px 16px rgba(0,0,0,.1); }
    .shell.toc-open .sidebar { display: block; }
  }
</style>
<div class="shell" part="shell">
  <div class="toolbar" part="toolbar">
    <button class="icon toc-toggle" type="button" aria-label="Toggle table of contents" title="Table of contents">&#9776;</button>
    <span class="title" part="title"></span>
    <span class="progress" part="progress"></span>
    <button class="prev" type="button" aria-label="Previous chapter">&larr;</button>
    <button class="next" type="button" aria-label="Next chapter">&rarr;</button>
  </div>
  <aside class="sidebar" part="sidebar">
    <h2>Contents</h2>
    <ol class="toc" part="toc"></ol>
  </aside>
  <div class="content" part="content">
    <iframe part="iframe" sandbox="allow-same-origin" title="EPUB content"></iframe>
    <div class="overlay" part="overlay">
      <div class="message">Drop an EPUB file here or choose one to begin.</div>
    </div>
  </div>
</div>
`;

export class EpubReaderElement extends HTMLElement {
  static get observedAttributes() { return ['src', 'start', 'hide-toc']; }

  /** @type {ShadowRoot} */          #shadow;
  /** @type {ReaderElements} */      #els;
  /** @type {EpubBook | null} */     #book = null;
  #currentIndex = -1;
  #loadToken = 0;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
    this.#shadow.innerHTML = TEMPLATE;
    const $ = /** @type {<T extends Element>(sel: string) => T} */ (
      (sel) => /** @type {any} */ (this.#shadow.querySelector(sel))
    );
    this.#els = {
      shell:    $('.shell'),
      title:    $('.title'),
      progress: $('.progress'),
      prev:     $('.prev'),
      next:     $('.next'),
      toggle:   $('.toc-toggle'),
      sidebar:  $('.sidebar'),
      toc:      $('.toc'),
      iframe:   $('iframe'),
      overlay:  $('.overlay'),
    };
    this.#els.prev.addEventListener('click', () => this.prev());
    this.#els.next.addEventListener('click', () => this.next());
    this.#els.toggle.addEventListener('click', () => this.#toggleToc());
    this.#els.iframe.addEventListener('load', () => this.#onIframeLoad());
    this.addEventListener('keydown', (e) => this.#onKeyDown(e));
    this.tabIndex = 0;
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
