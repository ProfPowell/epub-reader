// Minimal ZIP reader using DecompressionStream for DEFLATE.
// Supports: stored (0) and deflate (8). ZIP64 archives (>4 GB or
// >65 535 entries) are handled. No encryption.

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method            ZIP compression method (0=stored, 8=deflate).
 * @property {number} crc32
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} localHeader       Byte offset of the local file header.
 */

const SIG_EOCD       = 0x06054b50;
const SIG_CDH        = 0x02014b50;
const SIG_LFH        = 0x04034b50;
const SIG_ZIP64_LOC  = 0x07064b50; // ZIP64 EOCD locator
const SIG_ZIP64_EOCD = 0x06064b50; // ZIP64 EOCD record

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

    let totalEntries = view.getUint16(eocd + 10, true);
    let cdSize       = view.getUint32(eocd + 12, true);
    let cdOffset     = view.getUint32(eocd + 16, true);

    // ZIP64 promotion: any field at its 32-bit/16-bit sentinel means
    // the real value lives in the ZIP64 EOCD record.
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      const z64 = this.#findZip64EOCD(eocd);
      if (z64 < 0) throw new Error('ZIP64 fields signalled but no ZIP64 EOCD record found');
      // ZIP64 EOCD layout at z64:
      //  +0  signature (4)        +4  size of record (8)
      //  +12 version made (2)     +14 version needed (2)
      //  +16 disk# (4)            +20 disk# w/CD (4)
      //  +24 entries on disk (8)  +32 total entries (8)
      //  +40 CD size (8)          +48 CD offset (8)
      const total64 = readBigU64(view, z64 + 32);
      const size64  = readBigU64(view, z64 + 40);
      const off64   = readBigU64(view, z64 + 48);
      if (total64 > Number.MAX_SAFE_INTEGER || size64 > Number.MAX_SAFE_INTEGER || off64 > Number.MAX_SAFE_INTEGER) {
        throw new Error('ZIP64 archive exceeds Number.MAX_SAFE_INTEGER');
      }
      totalEntries = Number(total64);
      cdSize       = Number(size64);
      cdOffset     = Number(off64);
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
      let   compressedSize   = view.getUint32(p + 20, true);
      let   uncompressedSize = view.getUint32(p + 24, true);
      const nameLen          = view.getUint16(p + 28, true);
      const extraLen         = view.getUint16(p + 30, true);
      const commentLen       = view.getUint16(p + 32, true);
      let   localHeader      = view.getUint32(p + 42, true);

      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = decodeName(nameBytes, flags);

      // Promote sentinels from the ZIP64 extra field (id 0x0001).
      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeader === 0xffffffff) {
        const z64 = readZip64Extra(view, p + 46 + nameLen, extraLen,
          uncompressedSize === 0xffffffff,
          compressedSize === 0xffffffff,
          localHeader === 0xffffffff);
        if (z64.uncompressedSize !== undefined) uncompressedSize = z64.uncompressedSize;
        if (z64.compressedSize   !== undefined) compressedSize   = z64.compressedSize;
        if (z64.localHeader      !== undefined) localHeader      = z64.localHeader;
      }

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

  /**
   * Locate the ZIP64 EOCD record. The ZIP64 locator sits 20 bytes
   * before the regular EOCD; it points to the ZIP64 EOCD record
   * itself.
   * @param {number} eocd  Byte offset of the regular EOCD.
   * @returns {number}     Offset of the ZIP64 EOCD record, or -1.
   */
  #findZip64EOCD(eocd) {
    const view = this.#view;
    const locator = eocd - 20;
    if (locator < 0) return -1;
    if (view.getUint32(locator, true) !== SIG_ZIP64_LOC) return -1;
    const off = readBigU64(view, locator + 8);
    if (off > Number.MAX_SAFE_INTEGER) return -1;
    const recAt = Number(off);
    if (recAt < 0 || recAt + 4 > view.byteLength) return -1;
    if (view.getUint32(recAt, true) !== SIG_ZIP64_EOCD) return -1;
    return recAt;
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
/**
 * Read an 8-byte little-endian unsigned integer as a BigInt.
 * @param {DataView} view
 * @param {number} at
 * @returns {bigint}
 */
function readBigU64(view, at) {
  const lo = BigInt(view.getUint32(at,     true));
  const hi = BigInt(view.getUint32(at + 4, true));
  return lo | (hi << 32n);
}

/**
 * Walk the extra-field area of a CD entry looking for a 0x0001
 * (ZIP64) record and return the 64-bit values for whichever fields
 * the caller asked for. Fields appear in the order
 * uncompressedSize, compressedSize, localHeader, diskNumber — but
 * only those whose 32-bit equivalents are sentinels are present, so
 * the caller tells us which ones to read.
 *
 * @param {DataView} view
 * @param {number} start    Byte offset of the extra-field block.
 * @param {number} length   Length of the extra-field block.
 * @param {boolean} wantUncompressed
 * @param {boolean} wantCompressed
 * @param {boolean} wantLocalHeader
 * @returns {{uncompressedSize?: number, compressedSize?: number, localHeader?: number}}
 */
function readZip64Extra(view, start, length, wantUncompressed, wantCompressed, wantLocalHeader) {
  const end = start + length;
  /** @type {{uncompressedSize?: number, compressedSize?: number, localHeader?: number}} */
  const out = {};
  let p = start;
  while (p + 4 <= end) {
    const id   = view.getUint16(p, true);
    const len  = view.getUint16(p + 2, true);
    const next = p + 4 + len;
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => { const v = readBigU64(view, q); q += 8; return v; };
      if (wantUncompressed && q + 8 <= next) {
        const v = take();
        if (v <= BigInt(Number.MAX_SAFE_INTEGER)) out.uncompressedSize = Number(v);
      }
      if (wantCompressed && q + 8 <= next) {
        const v = take();
        if (v <= BigInt(Number.MAX_SAFE_INTEGER)) out.compressedSize = Number(v);
      }
      if (wantLocalHeader && q + 8 <= next) {
        const v = take();
        if (v <= BigInt(Number.MAX_SAFE_INTEGER)) out.localHeader = Number(v);
      }
      break;
    }
    p = next;
  }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not available in this environment');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}
