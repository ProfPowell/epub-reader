// Public type declarations for <epub-reader>. Consumers can:
//
//   /// <reference path="./node_modules/epub-reader/src/epub-reader.d.ts" />
//   const reader = document.querySelector('epub-reader');
//   reader.open(file);
//
// Or, in TypeScript projects, import the typedefs directly:
//
//   import type { EpubMetadata, TocEntry } from './epub-reader.d.ts';

export interface EpubMetadata {
  title:       string;
  creator:     string;
  language:    string;
  identifier:  string;
  publisher:   string;
  description: string;
  date:        string;
  rights:      string;
}

export interface ManifestItem {
  id:        string;
  href:      string;
  path:      string;
  mediaType: string;
  properties: string;
}

export interface SpineItem extends ManifestItem {
  linear: boolean;
  index:  number;
  /**
   * EPUB rendition layout for this spine item. `pre-paginated` chapters
   * (image-page / fixed-layout EPUBs like manga, illustrated books) get
   * fit-to-viewport rendering instead of native-size scrolling.
   */
  layout: 'reflowable' | 'pre-paginated';
}

export interface TocEntry {
  label:    string;
  href:     string;
  path:     string;
  fragment: string;
  children: TocEntry[];
}

export interface Chapter {
  url:    string;
  path:   string;
  index:  number;
  linear: boolean;
}

/** Detail payload for the `epub-loaded` event. */
export interface EpubLoadedDetail {
  metadata:    EpubMetadata;
  spineLength: number;
  toc:         TocEntry[];
}

/** Detail payload for the `epub-navigate` event. */
export interface EpubNavigateDetail {
  index: number;
  path:  string;
  title: string;
}

/** Detail payload for the `epub-error` event. */
export interface EpubErrorDetail {
  error: unknown;
}

/**
 * Typography overrides applied to chapter content. Sentinel values
 * mean "publisher default": empty string for `fontFamily`, 0 for
 * `lineHeight`, -1 for `paragraphSpacing`, null for `justify`.
 */
export interface TypographySettings {
  fontFamily:       string;
  fontSize:         number;       // percent (e.g. 100 = default)
  lineHeight:       number;       // 0 = default; 100..220 (×0.01)
  paragraphSpacing: number;       // -1 = default; 0..20 (×0.1 em)
  justify:          boolean | null;
}

/** Detail payload for the `epub-typography-change` event. */
export interface EpubTypographyChangeDetail {
  typography: TypographySettings;
}

/**
 * Detail payload for the `epub-position-restored` event. Fired after
 * `open()` if the reader successfully restored a previously-saved
 * spine index + scroll fraction for this book.
 */
export interface EpubPositionRestoredDetail {
  spineIndex: number;
  scrollFraction: number;
  bookId: string | null;
}

/** One user bookmark within a book. */
export interface Bookmark {
  id: string;
  spineIndex: number;
  scrollFraction: number;
  chapterTitle: string;
  label: string;
  snippet: string;
  createdAt: number;
}

/** Detail payload for the `epub-bookmarks-change` event. */
export interface EpubBookmarksChangeDetail {
  bookmarks: Bookmark[];
}

/** Map of events emitted by <epub-reader> to their CustomEvent detail types. */
export interface EpubReaderEventMap {
  'epub-loaded':              CustomEvent<EpubLoadedDetail>;
  'epub-navigate':            CustomEvent<EpubNavigateDetail>;
  'epub-error':               CustomEvent<EpubErrorDetail>;
  'epub-typography-change':   CustomEvent<EpubTypographyChangeDetail>;
  'epub-position-restored':   CustomEvent<EpubPositionRestoredDetail>;
  'epub-bookmarks-change':    CustomEvent<EpubBookmarksChangeDetail>;
}

/** Programmatic source accepted by `open()`. */
export type EpubSource = string | Blob | ArrayBuffer | ArrayBufferView;

/**
 * The `<epub-reader>` custom element. A drop-in EPUB 3 viewer rendered
 * in light DOM, using Vanilla Breeze chrome conventions
 * (`.reader-chrome`, `.reader-controls`, `.reader-icon-btn`) and
 * tokens (`--color-background`, `--color-text`, `--color-interactive`,
 * `--color-border`). Chapter content lives in a sandboxed iframe.
 *
 * Attributes:
 * - `src`            URL of an EPUB to auto-load.
 * - `start`          Spine index to open first (default 0).
 * - `hide-toc`       Hide the TOC sidebar by default.
 * - `allow-scripts`  Add `allow-scripts` to the chapter iframe sandbox.
 *                    Off by default — only set for content you trust.
 *
 * Events: see {@link EpubReaderEventMap}.
 */
export class EpubReaderElement extends HTMLElement {
  /** Load an EPUB. Replaces any currently-open book. */
  open(source: EpubSource): Promise<void>;

  /** Unload the current book and revoke any blob URLs it created. */
  close(): void;

  /** Advance to the next spine item. No-op if already at the last. */
  next(): Promise<void>;

  /** Move to the previous spine item. No-op if already at the first. */
  prev(): Promise<void>;

  /** Jump to a spine index, optionally scrolling to a fragment. */
  goToIndex(index: number, fragment?: string): Promise<void>;

  /** Jump to a manifest path (with optional `#fragment`). */
  goToPath(pathOrHref: string): Promise<void>;

  /**
   * Reader-applied typography overrides. Reading returns a clone;
   * assigning a partial value merges with the current settings,
   * persists to localStorage, fires `epub-typography-change`, and
   * re-applies to the visible chapter immediately.
   */
  typography: TypographySettings;

  /** Reset typography overrides to publisher defaults. */
  resetTypography(): void;

  /** Read-only snapshot of the current book's bookmarks. */
  readonly bookmarks: Bookmark[];

  /**
   * Add a bookmark at the current position, or remove the existing
   * bookmark there if one exists. Resolves with the new bookmark or
   * `null` (when a bookmark was removed instead).
   */
  toggleBookmark(label?: string): Promise<Bookmark | null>;

  /** Remove a bookmark by id. Resolves true if a bookmark was removed. */
  removeBookmark(id: string): Promise<boolean>;

  /** Jump to a bookmark (chapter + scroll position). */
  goToBookmark(id: string): Promise<void>;

  // Theming is delegated to the host page's Vanilla Breeze theme
  // engine. The reader reads `--color-background`, `--color-text`,
  // `--color-interactive`, and `--color-border` off the host element
  // and applies them to chapter content automatically.

  // Typed event helpers — work just like HTMLElement's, but resolve event
  // names against EpubReaderEventMap so CustomEvent.detail is typed.
  addEventListener<K extends keyof EpubReaderEventMap>(
    type: K,
    listener: (this: EpubReaderElement, ev: EpubReaderEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;

  removeEventListener<K extends keyof EpubReaderEventMap>(
    type: K,
    listener: (this: EpubReaderElement, ev: EpubReaderEventMap[K]) => void,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void;
}

/** Factory used internally by the component. Exposed for ad-hoc parsing. */
export function openEpub(source: EpubSource): Promise<EpubBook>;

/** EPUB book, parsed and ready for resource lookup. */
export class EpubBook {
  readonly metadata: EpubMetadata;
  readonly spine:    SpineItem[];
  readonly toc:      TocEntry[];
  readonly manifest: ManifestItem[];

  /** Blob URL for the cover image, or null if none declared. */
  coverUrl(): Promise<string | null>;

  /** Lazily build a blob URL for an archive resource. */
  resourceUrl(path: string): Promise<string>;

  /** Spine-item URL and metadata. */
  chapter(index: number): Promise<Chapter>;

  /** Map a manifest path back to a spine index. -1 if not in spine. */
  spineIndexOf(path: string): number;

  /**
   * Stable per-book identifier suitable as a persistence key. Prefers
   * `dc:identifier` (prefixed `id:`) and falls back to SHA-256 of the
   * source blob (prefixed `sha:`).
   */
  bookId(): Promise<string>;

  /** Revoke all generated blob URLs. */
  destroy(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'epub-reader': EpubReaderElement;
  }
}
