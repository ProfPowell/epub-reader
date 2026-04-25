// Minimal ZIP reader using DecompressionStream for DEFLATE.
// Supports: stored (0) and deflate (8). No ZIP64, no encryption.
// Enough for nearly every EPUB in the wild.

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method            ZIP compression method (0=stored, 8=deflate).
 * @property {number} crc32
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} localHeader       Byte offset of the local file header.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CDH  = 0x02014b50;
const SIG_LFH  = 0x04034b50;

const MAX_COMMENT = 0xffff;
const EOCD_MIN = 22;

export class ZipArchive {
  /** @type {Uint8Array} */         #bytes;
  /** @type {DataView} */            #view;
  /** @type {Map<string, ZipEntry>} */ #entries;

  /** @param {ArrayBuffer} arrayBuffer */
  constructor(arrayBuffer) {
    this.#bytes = new Uint8Array(arrayBuffer);
    this.#view = new DataView(arrayBuffer);
    this.#entries = new Map();
  }

  /**
   * Parse a ZIP archive from any binary source.
   * @param {ArrayBuffer | ArrayBufferView | Blob} source
   * @returns {Promise<ZipArchive>}
   */
  static async from(source) {
    /** @type {ArrayBuffer} */
    let buf;
    if (source instanceof ArrayBuffer) {
      buf = source;
    } else if (ArrayBuffer.isView(source)) {
      buf = /** @type {ArrayBuffer} */ (
        source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
      );
    } else if (source instanceof Blob) {
      buf = await source.arrayBuffer();
    } else {
      throw new TypeError('ZipArchive.from expects ArrayBuffer, TypedArray, or Blob');
    }
    const zip = new ZipArchive(buf);
    zip.#parseCentralDirectory();
    return zip;
  }

  /** @returns {string[]} All entry names in the archive. */
  get names() {
    return [...this.#entries.keys()];
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#entries.has(name);
  }

  #findEOCD() {
    const bytes = this.#bytes;
    const end = bytes.length;
    const minStart = Math.max(0, end - EOCD_MIN - MAX_COMMENT);
    for (let i = end - EOCD_MIN; i >= minStart; i--) {
      if (
        bytes[i]     === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x05 &&
        bytes[i + 3] === 0x06
      ) {
        return i;
      }
    }
    throw new Error('Not a ZIP archive: End of Central Directory record not found');
  }

  #parseCentralDirectory() {
    const view = this.#view;
    const bytes = this.#bytes;
    const eocd = this.#findEOCD();

    const totalEntries = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      throw new Error('ZIP64 archives are not supported');
    }

    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    for (let i = 0; i < totalEntries && p < cdEnd; i++) {
      const sig = view.getUint32(p, true);
      if (sig !== SIG_CDH) {
        throw new Error(`Invalid central directory header at ${p}`);
      }
      const flags            = view.getUint16(p + 8, true);
      const method           = view.getUint16(p + 10, true);
      const crc32            = view.getUint32(p + 16, true);
      const compressedSize   = view.getUint32(p + 20, true);
      const uncompressedSize = view.getUint32(p + 24, true);
      const nameLen          = view.getUint16(p + 28, true);
      const extraLen         = view.getUint16(p + 30, true);
      const commentLen       = view.getUint16(p + 32, true);
      const localHeader      = view.getUint32(p + 42, true);

      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = decodeName(nameBytes, flags);

      this.#entries.set(name, {
        name,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeader,
      });

      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** @param {ZipEntry} entry */
  #entryData(entry) {
    const view = this.#view;
    const bytes = this.#bytes;
    const p = entry.localHeader;
    if (view.getUint32(p, true) !== SIG_LFH) {
      throw new Error(`Invalid local file header for ${entry.name}`);
    }
    const nameLen  = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLen + extraLen;
    return bytes.subarray(dataStart, dataStart + entry.compressedSize);
  }

  /**
   * Read and decompress an entry as raw bytes.
   * @param {string} name
   * @returns {Promise<Uint8Array>}
   */
  async read(name) {
    const entry = this.#entries.get(name);
    if (!entry) throw new Error(`ZIP entry not found: ${name}`);
    const raw = this.#entryData(entry);

    if (entry.method === 0) {
      return new Uint8Array(raw);
    }
    if (entry.method === 8) {
      return await inflateRaw(raw);
    }
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
  }

  /**
   * Read an entry and decode it as text.
   * @param {string} name
   * @param {string} [encoding='utf-8']
   * @returns {Promise<string>}
   */
  async readText(name, encoding = 'utf-8') {
    const bytes = await this.read(name);
    return new TextDecoder(encoding).decode(bytes);
  }

  /**
   * Read an entry and wrap it in a Blob with the given MIME type.
   * @param {string} name
   * @param {string} [type='application/octet-stream']
   * @returns {Promise<Blob>}
   */
  async blob(name, type = 'application/octet-stream') {
    const bytes = await this.read(name);
    return new Blob([/** @type {BlobPart} */ (bytes)], { type });
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} flags ZIP general-purpose bit flag.
 * @returns {string}
 */
function decodeName(bytes, flags) {
  // Bit 11 (0x0800) = UTF-8 filenames. Most modern ZIPs set it; EPUBs should.
  const utf8 = (flags & 0x0800) !== 0;
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'utf-8', { fatal: !utf8 }).decode(bytes);
  } catch {
    // Fall back to latin1 for legacy archives.
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not available in this environment');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}
