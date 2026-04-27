// DOM range helpers shared by find (#17), search (#16), and highlights
// (#15). All functions operate on a "root" element (typically the
// chapter iframe's <body>) and treat its concatenated text content as
// the canonical address space — text offsets are character indexes
// into that flat text.
//
// Wrapping marks are inserted under elements with the
// `data-reader-mark` attribute, and ignored when computing offsets so
// re-running find/highlight on a doc that already has marks doesn't
// drift.

/** @param {Node} node @returns {boolean} */
function isMarkWrapper(node) {
  return node.nodeType === 1
    && /** @type {Element} */ (node).hasAttribute('data-reader-mark');
}

/**
 * Walk every text node under `root` in document order, skipping our
 * own injected mark wrappers (we don't want their text counted twice
 * once we unwrap them).
 *
 * @param {Element} root
 * @returns {Generator<Text>}
 */
function* textNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // Skip text inside <script>/<style>; rare in EPUB chapters but cheap.
      const parent = n.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  /** @type {Text | null} */
  let node = /** @type {Text | null} */ (walker.nextNode());
  while (node) {
    yield node;
    node = /** @type {Text | null} */ (walker.nextNode());
  }
}

/**
 * Concatenated text content of `root`, using the same text-node walk
 * the offset helpers use so offsets stay in sync.
 *
 * @param {Element} root
 * @returns {string}
 */
export function plainText(root) {
  let s = '';
  for (const t of textNodes(root)) s += t.data;
  return s;
}

/**
 * Map a (text node, in-node offset) pair to its global character
 * offset within `root`'s plain text.
 *
 * @param {Element} root
 * @param {Node} node
 * @param {number} offset
 * @returns {number}
 */
export function textOffsetOf(root, node, offset) {
  let acc = 0;
  if (node.nodeType !== 3) {
    // Walk up to the nearest preceding text by stepping through
    // descendants of `node` up to `offset` siblings.
    const limit = node.childNodes[offset] || null;
    for (const t of textNodes(root)) {
      // Stop once t is at-or-after `limit` in document order.
      if (limit && (t === limit || (limit.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))) break;
      acc += t.data.length;
    }
    return acc;
  }
  for (const t of textNodes(root)) {
    if (t === node) return acc + Math.min(offset, t.data.length);
    acc += t.data.length;
  }
  return acc;
}

/**
 * Inverse of textOffsetOf: locate the text node + in-node offset
 * corresponding to a global character offset. Clamps to the end if
 * `offset` exceeds the document length.
 *
 * @param {Element} root
 * @param {number} offset
 * @returns {{ node: Text, offset: number } | null}
 */
export function nodeAtTextOffset(root, offset) {
  let acc = 0;
  /** @type {Text | null} */
  let last = null;
  for (const t of textNodes(root)) {
    last = t;
    if (acc + t.data.length >= offset) {
      return { node: t, offset: Math.max(0, offset - acc) };
    }
    acc += t.data.length;
  }
  if (last) return { node: last, offset: last.data.length };
  return null;
}

/**
 * Build a Range spanning `[startOffset, endOffset)` of `root`'s
 * concatenated plain text. Returns null if the range can't be
 * resolved (e.g. document changed since the offsets were captured).
 *
 * @param {Element} root
 * @param {number} startOffset
 * @param {number} endOffset
 * @returns {Range | null}
 */
export function rangeFromOffsets(root, startOffset, endOffset) {
  if (endOffset <= startOffset) return null;
  const start = nodeAtTextOffset(root, startOffset);
  const end = nodeAtTextOffset(root, endOffset);
  if (!start || !end) return null;
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch { return null; }
  return range;
}

/**
 * Map a Range to global text offsets within `root`. Useful when the
 * user makes a selection (Range) and we want to persist it as
 * (start, end) integers.
 *
 * @param {Element} root
 * @param {Range} range
 * @returns {{ start: number, end: number } | null}
 */
export function offsetsFromRange(root, range) {
  if (!range || range.collapsed) return null;
  const start = textOffsetOf(root, range.startContainer, range.startOffset);
  const end   = textOffsetOf(root, range.endContainer,   range.endOffset);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Find every occurrence of `query` (case-insensitive, plain substring)
 * in `root`'s plain text and return their offsets.
 *
 * @param {Element} root
 * @param {string} query
 * @returns {{ start: number, end: number }[]}
 */
export function findOffsets(root, query) {
  if (!query) return [];
  const text = plainText(root);
  const lowerHay = text.toLowerCase();
  const lowerNeedle = query.toLowerCase();
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  let i = 0;
  while (i <= lowerHay.length) {
    const at = lowerHay.indexOf(lowerNeedle, i);
    if (at < 0) break;
    out.push({ start: at, end: at + lowerNeedle.length });
    i = at + Math.max(1, lowerNeedle.length);
  }
  return out;
}

/**
 * Wrap a Range in a fresh element built by `factory`. The Range may
 * span multiple text nodes; we split it into per-text-node sub-ranges
 * and wrap each. Returns the wrapper elements created.
 *
 * @param {Range} range
 * @param {() => HTMLElement} factory
 * @returns {HTMLElement[]}
 */
export function wrapRange(range, factory) {
  const doc = range.startContainer.ownerDocument;
  if (!doc) return [];
  /** @type {HTMLElement[]} */
  const wrappers = [];
  // Collect the text nodes inside the range first — we mutate the DOM
  // as we wrap, so iterating the live walker would skip nodes.
  /** @type {{ node: Text, start: number, end: number }[]} */
  const pieces = [];
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  /** @type {Node | null} */
  let n = walker.currentNode;
  // commonAncestorContainer may itself be a text node when the range
  // is wholly within one text — handle that fast path.
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
    pieces.push({
      node: /** @type {Text} */ (range.startContainer),
      start: range.startOffset,
      end: range.endOffset,
    });
  } else {
    while ((n = walker.nextNode())) {
      const t = /** @type {Text} */ (n);
      const inRange = range.intersectsNode(t);
      if (!inRange) continue;
      const start = t === range.startContainer ? range.startOffset : 0;
      const end = t === range.endContainer ? range.endOffset : t.data.length;
      if (end > start) pieces.push({ node: t, start, end });
    }
  }
  for (const p of pieces) {
    const before = p.node.splitText(p.start);
    before.splitText(p.end - p.start);
    const wrapper = factory();
    before.parentNode?.insertBefore(wrapper, before);
    wrapper.append(before);
    wrappers.push(wrapper);
  }
  return wrappers;
}

/**
 * Remove every wrapper element matching `selector` under `root`,
 * preserving its children in place.
 *
 * @param {Element} root
 * @param {string} selector
 */
export function unwrapAll(root, selector) {
  const els = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);
  for (const el of els) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize?.();
  }
}
