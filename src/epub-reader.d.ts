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

/** Map of events emitted by <epub-reader> to their CustomEvent detail types. */
export interface EpubReaderEventMap {
  'epub-loaded':              CustomEvent<EpubLoadedDetail>;
  'epub-navigate':            CustomEvent<EpubNavigateDetail>;
  'epub-error':               CustomEvent<EpubErrorDetail>;
  'epub-typography-change':   CustomEvent<EpubTypographyChangeDetail>;
}

/** Programmatic source accepted by `open()`. */
export type EpubSource = string | Blob | ArrayBuffer | ArrayBufferView;

/**
 * The `<epub-reader>` custom element. A drop-in EPUB 3 viewer with a
 * shadow-DOM UI (toolbar, TOC sidebar, content iframe).
 *
 * Attributes:
 * - `src`       URL of an EPUB to auto-load.
 * - `start`     Spine index to open first (default 0).
 * - `hide-toc`  Hide the TOC sidebar by default.
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

  /** Revoke all generated blob URLs. */
  destroy(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'epub-reader': EpubReaderElement;
  }
}
