// EPUB parser. Reads container.xml, the OPF (metadata/manifest/spine),
// and the navigation document (EPUB 3 nav, or EPUB 2 NCX fallback).
// Creates blob URLs for resources on demand, rewriting HTML/CSS references
// so that chapter iframes can load local assets relative to their blob URL.

import { ZipArchive } from './zip.js';

/**
 * @typedef {object} EpubMetadata
 * @property {string} title
 * @property {string} creator
 * @property {string} language
 * @property {string} identifier
 * @property {string} publisher
 * @property {string} description
 * @property {string} date
 * @property {string} rights
 */

/**
 * @typedef {object} ManifestItem
 * @property {string} id
 * @property {string} href            Original href as it appears in the OPF.
 * @property {string} path            Path resolved relative to the ZIP root.
 * @property {string} mediaType
 * @property {string} properties      Space-separated property tokens.
 */

/**
 * @typedef {ManifestItem & {linear: boolean, index: number, layout: 'reflowable' | 'pre-paginated'}} SpineItem
 */

/**
 * @typedef {object} TocEntry
 * @property {string} label
 * @property {string} href            Original href.
 * @property {string} path            Path resolved relative to the ZIP root.
 * @property {string} fragment        Fragment identifier (no leading `#`).
 * @property {TocEntry[]} children
 */

/**
 * @typedef {object} Chapter
 * @property {string} url             Blob URL for the chapter document.
 * @property {string} path
 * @property {number} index
 * @property {boolean} linear
 */

const CONTAINER_PATH = 'META-INF/container.xml';
const NS = {
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  opf:       'http://www.idpf.org/2007/opf',
  dc:        'http://purl.org/dc/elements/1.1/',
  xhtml:     'http://www.w3.org/1999/xhtml',
  ncx:       'http://www.daisy.org/z3986/2005/ncx/',
  epub:      'http://www.idpf.org/2007/ops',
  xlink:     'http://www.w3.org/1999/xlink',
};

const REWRITE_ATTRS = new Set([
  'src', 'href', 'poster', 'data',
]);

/**
 * Open an EPUB from a URL, Blob, or in-memory buffer.
 * @param {string | Blob | ArrayBuffer | ArrayBufferView} source
 * @returns {Promise<EpubBook>}
 */
export async function openEpub(source) {
  /** @type {Blob} */
  let blob;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch EPUB (${res.status}): ${source}`);
    blob = await res.blob();
  } else if (source instanceof Blob) {
    blob = source;
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    blob = new Blob([/** @type {BlobPart} */ (source)]);
  } else {
    throw new TypeError('openEpub expects a URL string, Blob/File, or ArrayBuffer');
  }
  const zip = await ZipArchive.from(blob);
  const book = new EpubBook(zip, blob);
  await book.load();
  return book;
}

export class EpubBook {
  /** @type {ZipArchive} */                          #zip;
  /** @type {string} */                              #opfPath = '';
  /** @type {string} */                              #opfDir = '';
  /** @type {Map<string, ManifestItem>} */           #manifest = new Map();
  /** @type {SpineItem[]} */                         #spine    = [];
  /** @type {TocEntry[]} */                          #toc      = [];
  /** @type {EpubMetadata} */                        #metadata = blankMetadata();
  /** @type {string | null} */                       #coverId  = null;
  /** @type {string | null} */                       #navId    = null;
  /** @type {Map<string, string>} */                 #blobUrls = new Map();
  /** @type {Map<string, Promise<string>>} */        #pending  = new Map();
  /** @type {Blob | null} */                         #source = null;
  /** @type {string | null} */                       #cachedBookId = null;
  /**
   * Map of obfuscated resource path → algorithm. Populated from
   * META-INF/encryption.xml during load(). EPUB allows two
   * font-obfuscation algorithms in the wild — IDPF and Adobe — and
   * we de-obfuscate at resourceUrl() time.
   *
   * @type {Map<string, 'idpf' | 'adobe'>}
   */
  #obfuscation = new Map();

  /**
   * @param {ZipArchive} zip
   * @param {Blob | null} [source]  Original EPUB blob — kept for SHA-256
   *                                fallback when dc:identifier is empty.
   */
  constructor(zip, source = null) {
    this.#zip = zip;
    this.#source = source;
  }

  /**
   * Stable per-book identifier for persistence keys. Prefers
   * `dc:identifier` from the OPF; falls back to the SHA-256 of the
   * source blob (cached after the first call). Throws only if neither
   * is available.
   *
   * @returns {Promise<string>}
   */
  async bookId() {
    if (this.#cachedBookId) return this.#cachedBookId;
    const id = (this.#metadata.identifier || '').trim();
    if (id) return (this.#cachedBookId = `id:${id}`);
    if (!this.#source) throw new Error('bookId: no dc:identifier and no source blob to hash');
    const buf = await this.#source.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return (this.#cachedBookId = `sha:${hex}`);
  }

  /**
   * Reverse one of the two EPUB font-obfuscation schemes. Both schemes
   * are simple XOR over a prefix of the file with a derived key:
   *
   * - IDPF (http://www.idpf.org/2008/embedding):
   *     key = SHA-1 of the whitespace-normalised dc:identifier; first
   *     1040 bytes are XORed with the 20-byte key, repeating.
   *
   * - Adobe (http://ns.adobe.com/pdf/enc#RC):
   *     key = the 16 raw bytes from the dc:identifier formatted as a
   *     UUID (hex digits parsed pair-wise); first 1024 bytes XORed.
   *
   * Beyond the prefix, the file is the original font bytes. We return
   * a fresh buffer rather than mutating the input.
   *
   * @param {Uint8Array} bytes
   * @param {'idpf' | 'adobe'} scheme
   * @returns {Promise<Uint8Array>}
   */
  async #deobfuscate(bytes, scheme) {
    const id = (this.#metadata.identifier || '').trim();
    if (!id) return bytes;
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    if (scheme === 'idpf') {
      const norm = id.replace(/\s+/g, '');
      const digest = await crypto.subtle.digest('SHA-1',
        new TextEncoder().encode(norm));
      const key = new Uint8Array(digest);
      const n = Math.min(1040, out.length);
      for (let i = 0; i < n; i++) out[i] ^= key[i % key.length];
    } else if (scheme === 'adobe') {
      const hex = id.replace(/[^0-9a-f]/gi, '').slice(0, 32);
      if (hex.length < 32) return bytes;
      const key = new Uint8Array(16);
      for (let i = 0; i < 16; i++) key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const n = Math.min(1024, out.length);
      for (let i = 0; i < n; i++) out[i] ^= key[i % key.length];
    }
    return out;
  }

  async load() {
    // Validate the EPUB envelope. The spec requires `mimetype` to be
    // the first archive entry, stored uncompressed, with the literal
    // string `application/epub+zip`. We accept either order so we don't
    // reject mostly-valid books, but we do require the right contents.
    if (this.#zip.has('mimetype')) {
      const mt = (await this.#zip.readText('mimetype')).trim();
      if (mt && mt !== 'application/epub+zip') {
        throw new Error(`Not an EPUB: mimetype is "${mt}", expected "application/epub+zip"`);
      }
    } else {
      // Some bad EPUBs omit the mimetype entry entirely. That's a
      // soft warning rather than a hard fail — the rest of the
      // structure can still be valid.
      console.warn('EPUB: missing top-level mimetype entry');
    }

    if (!this.#zip.has(CONTAINER_PATH)) {
      throw new Error('Not a valid EPUB: missing META-INF/container.xml');
    }
    let containerDoc;
    try {
      containerDoc = parseXml(await this.#zip.readText(CONTAINER_PATH), 'application/xml');
    } catch (err) {
      throw new Error(`Malformed META-INF/container.xml: ${err?.message || err}`);
    }
    const rootfile = containerDoc.getElementsByTagName('rootfile')[0];
    if (!rootfile) throw new Error('container.xml: no <rootfile> element');
    const fullPath = rootfile.getAttribute('full-path');
    if (!fullPath) throw new Error('container.xml: rootfile missing full-path');
    if (!this.#zip.has(fullPath)) {
      throw new Error(`OPF package file not found in archive: ${fullPath}`);
    }
    this.#opfPath = fullPath;
    this.#opfDir = dirname(this.#opfPath);

    let opfDoc;
    try {
      opfDoc = parseXml(await this.#zip.readText(this.#opfPath), 'application/xml');
    } catch (err) {
      throw new Error(`Malformed OPF (${this.#opfPath}): ${err?.message || err}`);
    }
    this.#parseMetadata(opfDoc);
    this.#parseManifest(opfDoc);
    this.#parseSpine(opfDoc);
    await this.#parseNav();
    await this.#parseEncryption();
  }

  /**
   * Parse META-INF/encryption.xml (when present) and record which
   * resources are obfuscated and by which algorithm. EPUB recognises
   * two font-obfuscation schemes:
   *
   *   IDPF:  http://www.idpf.org/2008/embedding
   *   Adobe: http://ns.adobe.com/pdf/enc#RC
   *
   * Anything else (real DRM, etc.) is left alone — the resource will
   * load as-is; if it's a font the user will see the wrong glyphs but
   * the rest of the book still works.
   */
  async #parseEncryption() {
    const path = 'META-INF/encryption.xml';
    if (!this.#zip.has(path)) return;
    let doc;
    try { doc = parseXml(await this.#zip.readText(path), 'application/xml'); }
    catch { return; }
    const datas = doc.getElementsByTagNameNS('*', 'EncryptedData');
    for (const data of datas) {
      const method = data.getElementsByTagNameNS('*', 'EncryptionMethod')[0];
      const cipher = data.getElementsByTagNameNS('*', 'CipherReference')[0];
      const algo = method?.getAttribute('Algorithm') || '';
      const uri = cipher?.getAttribute('URI') || '';
      if (!algo || !uri) continue;
      let scheme;
      if (algo === 'http://www.idpf.org/2008/embedding') scheme = 'idpf';
      else if (algo === 'http://ns.adobe.com/pdf/enc#RC') scheme = 'adobe';
      else continue;
      let target;
      try { target = decodeURIComponent(uri); } catch { target = uri; }
      // encryption.xml URIs are relative to the archive root.
      this.#obfuscation.set(target, /** @type {'idpf' | 'adobe'} */ (scheme));
    }
  }

  /** @returns {EpubMetadata} */
  get metadata() { return { ...this.#metadata }; }

  /** @returns {SpineItem[]} */
  get spine() { return this.#spine.map(x => ({ ...x })); }

  /** @returns {TocEntry[]} */
  get toc() { return this.#toc; }

  /** @returns {ManifestItem[]} */
  get manifest() { return [...this.#manifest.values()].map(x => ({ ...x })); }

  #parseMetadata(doc) {
    const metadata = doc.getElementsByTagNameNS(NS.opf, 'metadata')[0]
      || doc.getElementsByTagName('metadata')[0];
    if (!metadata) return;
    const pick = (name) => {
      const el = metadata.getElementsByTagNameNS(NS.dc, name)[0]
        || metadata.getElementsByTagName('dc:' + name)[0];
      return el ? el.textContent.trim() : '';
    };
    this.#metadata = {
      title:       pick('title'),
      creator:     pick('creator'),
      language:    pick('language'),
      identifier:  pick('identifier'),
      publisher:   pick('publisher'),
      description: pick('description'),
      date:        pick('date'),
      rights:      pick('rights'),
    };
    // EPUB 2 cover: <meta name="cover" content="<manifest-id>"/>
    for (const m of childrenByLocalName(metadata, 'meta')) {
      if (m.getAttribute('name') === 'cover') {
        this.#coverId = m.getAttribute('content');
      }
    }
  }

  #parseManifest(doc) {
    const manifest = doc.getElementsByTagNameNS(NS.opf, 'manifest')[0]
      || doc.getElementsByTagName('manifest')[0];
    if (!manifest) throw new Error('OPF: missing <manifest>');
    for (const item of childrenByLocalName(manifest, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type') || '';
      const properties = item.getAttribute('properties') || '';
      if (!id || !href) continue;
      const resolved = resolveRelative(this.#opfPath, href);
      if (!resolved) continue;
      // Warn (don't fail) if the manifest references a missing file.
      // The book stays usable for the chapters that DO exist.
      if (!this.#zip.has(resolved.path)) {
        console.warn(`OPF: manifest item "${id}" → "${resolved.path}" not found in archive`);
      }
      const entry = { id, href, path: resolved.path, mediaType, properties };
      this.#manifest.set(id, entry);
      if (properties.split(/\s+/).includes('nav')) this.#navId = id;
      if (properties.split(/\s+/).includes('cover-image')) this.#coverId = id;
    }
  }

  #parseSpine(doc) {
    const spine = doc.getElementsByTagNameNS(NS.opf, 'spine')[0]
      || doc.getElementsByTagName('spine')[0];
    if (!spine) throw new Error('OPF: missing <spine>');

    // Book-level default rendition:layout. EPUB 3 publishes it via
    // <meta property="rendition:layout">VALUE</meta> inside <metadata>;
    // older OPFs use a `rendition:layout` attribute on <package>.
    const pkg = doc.documentElement;
    /** @type {'reflowable' | 'pre-paginated'} */
    let bookLayout = 'reflowable';
    const layoutAttr = pkg.getAttribute('rendition:layout');
    if (layoutAttr === 'pre-paginated') bookLayout = 'pre-paginated';
    for (const m of pkg.getElementsByTagNameNS('*', 'meta')) {
      if (m.getAttribute('property') === 'rendition:layout') {
        const v = m.textContent?.trim();
        if (v === 'pre-paginated') bookLayout = 'pre-paginated';
      }
    }

    let i = 0;
    for (const ref of childrenByLocalName(spine, 'itemref')) {
      const idref = ref.getAttribute('idref');
      if (!idref) continue;
      const item = this.#manifest.get(idref);
      if (!item) {
        console.warn(`OPF: spine itemref "${idref}" doesn't match any manifest item`);
        continue;
      }
      const linear = (ref.getAttribute('linear') || 'yes') !== 'no';
      // Per-itemref override via properties tokens.
      const refProps = (ref.getAttribute('properties') || '').split(/\s+/);
      let layout = bookLayout;
      if (refProps.includes('rendition:layout-pre-paginated')) layout = 'pre-paginated';
      else if (refProps.includes('rendition:layout-reflowable')) layout = 'reflowable';
      this.#spine.push({
        id: item.id,
        href: item.href,
        path: item.path,
        mediaType: item.mediaType,
        properties: item.properties,
        linear,
        layout,
        index: i++,
      });
    }
    if (!this.#spine.length) throw new Error('OPF: empty spine');
  }

  async #parseNav() {
    if (this.#navId) {
      const item = this.#manifest.get(this.#navId);
      if (item) {
        try {
          const text = await this.#zip.readText(item.path);
          const doc = parseXml(text, 'application/xhtml+xml');
          const toc = findNavToc(doc);
          if (toc) {
            this.#toc = collectNavList(toc, item.path);
            if (this.#toc.length) return;
          }
        } catch (err) {
          console.warn('Failed to parse EPUB3 nav:', err);
        }
      }
    }
    // EPUB 2 NCX fallback.
    const ncxItem = [...this.#manifest.values()].find(x =>
      x.mediaType === 'application/x-dtbncx+xml'
    );
    if (ncxItem) {
      try {
        const text = await this.#zip.readText(ncxItem.path);
        const doc = parseXml(text, 'application/xml');
        const navMap = doc.getElementsByTagNameNS(NS.ncx, 'navMap')[0]
          || doc.getElementsByTagName('navMap')[0];
        if (navMap) {
          this.#toc = collectNcxPoints(navMap, ncxItem.path);
          if (this.#toc.length) return;
        }
      } catch (err) {
        console.warn('Failed to parse NCX:', err);
      }
    }
    // Last resort: synthesize a TOC from the spine.
    this.#toc = this.#spine
      .filter(s => s.linear)
      .map((s, i) => ({
        label: `Chapter ${i + 1}`,
        href: s.href,
        path: s.path,
        fragment: '',
        children: [],
      }));
  }

  // ------- resource URLs -------

  /**
   * Blob URL for the cover image, or null if the OPF declares none.
   * @returns {Promise<string | null>}
   */
  async coverUrl() {
    if (!this.#coverId) return null;
    const item = this.#manifest.get(this.#coverId);
    if (!item) return null;
    return await this.resourceUrl(item.path);
  }

  /**
   * Raw Blob for the cover image, suitable for IndexedDB storage. Null
   * if the OPF doesn't declare a cover or the entry is missing.
   * @returns {Promise<Blob | null>}
   */
  async coverBlob() {
    if (!this.#coverId) return null;
    const item = this.#manifest.get(this.#coverId);
    if (!item) return null;
    try {
      const bytes = await this.#zip.read(item.path);
      return new Blob([/** @type {BlobPart} */ (bytes)],
        { type: item.mediaType || 'application/octet-stream' });
    } catch { return null; }
  }

  /**
   * Source EPUB Blob (the bytes the reader was opened with). Used for
   * library persistence so we can re-open a stored book without going
   * back to disk. Null if the EpubBook was constructed without one.
   * @returns {Blob | null}
   */
  sourceBlob() { return this.#source; }

  /**
   * Lazily build a blob: URL for an archive resource. HTML/CSS resources
   * are processed to rewrite internal references.
   * @param {string} path
   * @returns {Promise<string>}
   */
  async resourceUrl(path) {
    const cached = this.#blobUrls.get(path);
    if (cached) return cached;
    const inflight = this.#pending.get(path);
    if (inflight) return inflight;

    const p = (async () => {
      const item = this.#manifestByPath(path);
      const mediaType = item?.mediaType || guessMime(path);
      let blob;
      if (isHtmlType(mediaType)) {
        blob = await this.#processHtml(path, mediaType);
      } else if (isCssType(mediaType)) {
        blob = await this.#processCss(path);
      } else {
        let bytes = await this.#zip.read(path);
        const scheme = this.#obfuscation.get(path);
        if (scheme) bytes = await this.#deobfuscate(bytes, scheme);
        blob = new Blob([/** @type {BlobPart} */ (bytes)], { type: mediaType });
      }
      const url = URL.createObjectURL(blob);
      this.#blobUrls.set(path, url);
      return url;
    })();
    this.#pending.set(path, p);
    try { return await p; }
    finally { this.#pending.delete(path); }
  }

  /**
   * Spine-item URL and metadata.
   * @param {number} index
   * @returns {Promise<Chapter>}
   */
  async chapter(index) {
    const item = this.#spine[index];
    if (!item) throw new RangeError(`Spine index out of range: ${index}`);
    const url = await this.resourceUrl(item.path);
    return { url, path: item.path, index, linear: item.linear };
  }

  /**
   * Map a manifest path back to a spine index. Returns -1 if not in spine.
   * @param {string} path
   * @returns {number}
   */
  spineIndexOf(path) {
    for (let i = 0; i < this.#spine.length; i++) {
      if (this.#spine[i].path === path) return i;
    }
    return -1;
  }

  /** Revoke all generated blob URLs. Call when the reader unloads a book. */
  destroy() {
    for (const url of this.#blobUrls.values()) URL.revokeObjectURL(url);
    this.#blobUrls.clear();
  }

  // ------- internals -------

  #manifestByPath(path) {
    for (const item of this.#manifest.values()) {
      if (item.path === path) return item;
    }
    return null;
  }

  async #processHtml(path, mediaType) {
    const raw = await this.#zip.readText(path);
    const parser = new DOMParser();
    // text/html is forgiving and handles most real-world EPUB content;
    // application/xhtml+xml rejects on a single malformed node.
    const doc = parser.parseFromString(raw, 'text/html');
    if (!doc || doc.getElementsByTagName('parsererror').length) {
      // Fall back to unmodified content if the parse completely fails.
      return new Blob([raw], { type: mediaType || 'text/html' });
    }

    // Rewrite attributes that reference other resources in the archive.
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    /** @type {Promise<void>[]} */
    const tasks = [];
    /** @type {Node | null} */
    let node;
    while ((node = walker.nextNode())) {
      tasks.push(this.#rewriteElement(/** @type {Element} */ (node), path));
    }
    await Promise.all(tasks);

    // Rewrite <style> blocks as well.
    for (const style of doc.getElementsByTagName('style')) {
      style.textContent = await this.#rewriteCss(style.textContent || '', path);
    }

    const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    return new Blob([html], { type: 'text/html; charset=utf-8' });
  }

  async #rewriteElement(el, basePath) {
    // Attribute-based references.
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const localName = name.includes(':') ? name.split(':').pop() : name;

      if (name === 'style') {
        const rewritten = await this.#rewriteCss(attr.value, basePath);
        if (rewritten !== attr.value) el.setAttribute('style', rewritten);
        continue;
      }

      if (name === 'srcset') {
        el.setAttribute('srcset', await this.#rewriteSrcset(attr.value, basePath));
        continue;
      }

      if (!REWRITE_ATTRS.has(name) && localName !== 'href') continue;

      const value = attr.value;
      if (!value) continue;

      // External links and data URIs stay untouched.
      if (isExternal(value) || value.startsWith('data:') || value.startsWith('blob:')) continue;

      // Pure in-document anchors.
      if (value.startsWith('#')) continue;

      const resolved = resolveRelative(basePath, value);
      if (!resolved) continue;
      if (!this.#zip.has(resolved.path)) continue;

      const tag = el.tagName.toLowerCase();
      const isAnchor = tag === 'a' || tag === 'area';
      const targetsHtml = isHtmlType(guessMime(resolved.path));

      if (isAnchor && targetsHtml) {
        // Keep anchor-style navigation; the reader intercepts clicks
        // via the data-epub-href attribute.
        const full = resolved.hash ? `${resolved.path}#${resolved.hash}` : resolved.path;
        el.setAttribute('data-epub-href', full);
        el.setAttribute('href', '#');
      } else {
        const url = await this.resourceUrl(resolved.path);
        el.setAttribute(attr.name, resolved.hash ? `${url}#${resolved.hash}` : url);
      }
    }
  }

  async #rewriteSrcset(value, basePath) {
    const parts = value.split(',').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const part of parts) {
      const tokens = part.split(/\s+/);
      const ref = tokens.shift() || '';
      const resolved = ref && !isExternal(ref) && !ref.startsWith('data:')
        ? resolveRelative(basePath, ref)
        : null;
      if (resolved && this.#zip.has(resolved.path)) {
        const url = await this.resourceUrl(resolved.path);
        out.push([url, ...tokens].join(' '));
      } else {
        out.push(part);
      }
    }
    return out.join(', ');
  }

  async #processCss(path) {
    const text = await this.#zip.readText(path);
    const rewritten = await this.#rewriteCss(text, path);
    return new Blob([rewritten], { type: 'text/css; charset=utf-8' });
  }

  async #rewriteCss(cssText, basePath) {
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g;
    const importRe = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/g;

    const replacements = new Map();
    const collect = async (ref) => {
      if (!ref || isExternal(ref) || ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('#')) return;
      if (replacements.has(ref)) return;
      const resolved = resolveRelative(basePath, ref);
      if (!resolved || !this.#zip.has(resolved.path)) return;
      const url = await this.resourceUrl(resolved.path);
      replacements.set(ref, resolved.hash ? `${url}#${resolved.hash}` : url);
    };

    const refs = [];
    cssText.replace(urlRe, (_, a, b, c) => { refs.push(a || b || c); return ''; });
    cssText.replace(importRe, (_, a, b, c, d, e) => { refs.push(a || b || c || d || e); return ''; });
    await Promise.all([...new Set(refs)].map(collect));

    const rewriteRef = (ref) => replacements.get(ref) || ref;
    return cssText
      .replace(urlRe, (_match, a, b, c) => {
        const ref = a || b || c;
        const out = rewriteRef(ref);
        return `url("${out}")`;
      })
      .replace(importRe, (match, a, b, c, d, e, media) => {
        const ref = a || b || c || d || e;
        const out = rewriteRef(ref);
        const tail = media ? ' ' + media.trim() : '';
        return `@import url("${out}")${tail};`;
      });
  }
}

// ---------- helpers ----------

/** @returns {EpubMetadata} */
function blankMetadata() {
  return { title: '', creator: '', language: '', identifier: '', publisher: '', description: '', date: '', rights: '' };
}

// Find descendant elements by local name regardless of XML namespace prefix.
// EPUB OPFs in the wild are inconsistent: some use the default namespace
// (`<item>`), others a prefix (`<opf:item>`). `getElementsByTagName` matches
// the qualified name, so it misses prefixed elements. `getElementsByTagNameNS`
// with `*` matches across all namespaces and is the right primitive here.
function childrenByLocalName(parent, localName) {
  return parent.getElementsByTagNameNS('*', localName);
}

/**
 * @param {string} text
 * @param {DOMParserSupportedType} [mime='application/xml']
 * @returns {Document}
 */
function parseXml(text, mime = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, mime);
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`XML parse error: ${err.textContent.trim().split('\n')[0]}`);
  return doc;
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function resolveRelative(basePath, ref) {
  if (!ref) return null;
  if (isExternal(ref)) return null;
  const [rawPath, hashRaw] = splitHash(ref);
  const hash = hashRaw ? decodeURIComponent(hashRaw) : '';
  if (!rawPath) {
    // Pure fragment -> same document.
    return { path: basePath, hash };
  }
  const baseDir = dirname(basePath);
  const baseParts = baseDir ? baseDir.split('/') : [];
  const parts = [...baseParts];
  for (const seg of rawPath.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const path = parts.join('/');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { decoded = path; }
  return { path: decoded, hash };
}

function splitHash(ref) {
  const i = ref.indexOf('#');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

function isExternal(ref) {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('file:');
}

function isHtmlType(mediaType) {
  if (!mediaType) return false;
  const t = mediaType.toLowerCase();
  return t.startsWith('application/xhtml+xml') || t.startsWith('text/html');
}

function isCssType(mediaType) {
  return !!mediaType && mediaType.toLowerCase().startsWith('text/css');
}

const MIME_BY_EXT = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'application/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', mp4: 'video/mp4', ogg: 'audio/ogg', m4a: 'audio/mp4',
  json: 'application/json', xml: 'application/xml',
  ncx: 'application/x-dtbncx+xml', opf: 'application/oebps-package+xml',
};

function guessMime(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME_BY_EXT[path.slice(i + 1).toLowerCase()] || 'application/octet-stream';
}

function findNavToc(doc) {
  // The nav document has <nav epub:type="toc"> or <nav role="doc-toc">.
  const navs = doc.getElementsByTagName('nav');
  for (const nav of navs) {
    const epubType = nav.getAttributeNS(NS.epub, 'type') || nav.getAttribute('epub:type') || '';
    const role = nav.getAttribute('role') || '';
    if (epubType.split(/\s+/).includes('toc') || role === 'doc-toc') return nav;
  }
  return navs[0] || null;
}

function collectNavList(container, navPath) {
  const list = firstChildTag(container, 'ol') || firstChildTag(container, 'ul');
  if (!list) return [];
  const out = [];
  for (const li of list.children) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const a = li.querySelector(':scope > a, :scope > span');
    const label = (a?.textContent || '').trim() || '(untitled)';
    const href = a?.getAttribute?.('href') || '';
    let path = '', fragment = '';
    if (href) {
      const r = resolveRelative(navPath, href);
      if (r) { path = r.path; fragment = r.hash; }
    }
    const nested = firstChildTag(li, 'ol') || firstChildTag(li, 'ul');
    out.push({
      label,
      href,
      path,
      fragment,
      children: nested ? collectNavList({ children: [nested] }, navPath) : [],
    });
  }
  return out;
}

function firstChildTag(el, tag) {
  for (const c of el.children || []) if (c.tagName?.toLowerCase() === tag) return c;
  return null;
}

function collectNcxPoints(container, ncxPath) {
  const out = [];
  for (const np of container.children) {
    if (np.tagName.toLowerCase() !== 'navpoint') continue;
    const labelEl = np.getElementsByTagName('text')[0] || np.getElementsByTagNameNS(NS.ncx, 'text')[0];
    const label = (labelEl?.textContent || '').trim() || '(untitled)';
    const content = np.getElementsByTagName('content')[0] || np.getElementsByTagNameNS(NS.ncx, 'content')[0];
    const src = content?.getAttribute('src') || '';
    let path = '', fragment = '';
    if (src) {
      const r = resolveRelative(ncxPath, src);
      if (r) { path = r.path; fragment = r.hash; }
    }
    out.push({
      label,
      href: src,
      path,
      fragment,
      children: collectNcxPoints(np, ncxPath),
    });
  }
  return out;
}
