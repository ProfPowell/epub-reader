// Integration tests: end-to-end behaviour of <epub-reader> against
// hand-picked samples. Each test gets a fresh browser context.
//
// Usage:
//   node tests/integration.mjs
//   node tests/integration.mjs --grep navigation
//   node tests/integration.mjs --verbose

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES = join(ROOT, 'samples');

const args = process.argv.slice(2);
const grep = args.find(a => a.startsWith('--grep='))?.slice(7)
          || (args.includes('--grep') ? args[args.indexOf('--grep') + 1] : null);
const verbose = args.includes('--verbose') || args.includes('-v');

const playwright = await import('playwright').catch(() => null);
if (!playwright) { console.error('Playwright is not installed. Run: npm install'); process.exit(2); }
const { chromium } = playwright;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const eq = (actual, expected, msg = '') => {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};
const truthy = (v, msg) => { if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`); };
const matches = (s, re, msg) => { if (!re.test(s)) throw new Error(`${msg || 'regex'}: ${JSON.stringify(s)} did not match ${re}`); };

// ---------- harness helpers used by tests ----------

const helpers = (page, server) => ({
  async openSample(file) {
    await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#file', join(SAMPLES, file));
    await page.waitForFunction(() => {
      const r = document.getElementById('reader');
      const t = r?.querySelector('.title')?.textContent;
      const ov = r?.querySelector('.overlay');
      const errMode = ov && !ov.hidden && ov.classList.contains('error');
      return errMode || (t && t.length > 0);
    }, null, { timeout: 15_000 });
    await page.waitForFunction(() => {
      const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
      if (!doc) return false;
      if (doc.body && doc.body.children.length > 0) return true;
      return doc.documentElement?.localName === 'svg';
    }, null, { timeout: 10_000 });
  },

  state: () => page.evaluate(() => {
    const r = document.getElementById('reader');
    const s = r;
    return {
      title:    s.querySelector('.title')?.textContent || '',
      progress: s.querySelector('.progress')?.textContent || '',
      tocCount: s.querySelectorAll('.toc a').length,
    };
  }),

  iframeContent: () => page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    if (!doc) return null;
    return {
      bodyText:    (doc.body?.textContent || '').trim().slice(0, 200),
      links:       [...doc.querySelectorAll('link[rel=stylesheet]')].map(l => l.href),
      images:      [...doc.querySelectorAll('img')].map(i => ({ src: i.src, complete: i.complete, w: i.naturalWidth })),
      epubAnchors: [...doc.querySelectorAll('[data-epub-href]')].map(a => a.getAttribute('data-epub-href')),
      svgRoot:     doc.documentElement?.localName === 'svg',
    };
  }),

  reader: {
    next:    () => page.evaluate(() => document.getElementById('reader').next()),
    prev:    () => page.evaluate(() => document.getElementById('reader').prev()),
    goPath:  (p) => page.evaluate((p) => document.getElementById('reader').goToPath(p), p),
    goIdx:   (i) => page.evaluate((i) => document.getElementById('reader').goToIndex(i), i),
    close:   () => page.evaluate(() => document.getElementById('reader').close()),
  },

  waitChapter: (predicate) => page.waitForFunction((src) => {
    const fn = new Function('doc', 'iframe', 'return (' + src + ')(doc, iframe);');
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    return doc && fn(doc, iframe);
  }, predicate.toString(), { timeout: 10_000 }),
});

// ---------- tests ----------

test('metadata + TOC labels are exposed via the public API', async (h) => {
  await h.openSample('trees.epub');
  const s = await h.state();
  eq(s.title, 'Trees', 'reader title should match dc:title');
  matches(s.progress, /^1 \/ 3$/, 'spine should be 3 items');
  truthy(s.tocCount >= 1, 'TOC should have at least one entry');
});

test('spine navigation: next() advances through the spine', async (h) => {
  await h.openSample('trees.epub');
  const before = await h.state();
  eq(before.progress, '1 / 3');
  await h.reader.next();
  await h.waitChapter((doc) => doc.body?.textContent?.length > 0);
  const mid = await h.state();
  eq(mid.progress, '2 / 3');
  await h.reader.next();
  await h.waitChapter((doc) => doc.body?.textContent?.length > 0);
  const last = await h.state();
  eq(last.progress, '3 / 3');
  await h.reader.prev();
  await h.waitChapter((doc) => doc.body?.textContent?.length > 0);
  eq((await h.state()).progress, '2 / 3');
});

test('keyboard navigation: ArrowRight advances chapter', async (h, { page }) => {
  await h.openSample('trees.epub');
  // Dispatch the keydown event directly on the host element. Focus
  // routing through `page.keyboard.press` is flaky when an iframe is in
  // the layout, since focus may be captured by the iframe contents.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await h.waitChapter((doc) => doc.body?.textContent?.length > 0);
  eq((await h.state()).progress, '2 / 3', 'progress after ArrowRight');
});

test('TOC click jumps to the right spine item', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  // Pick a TOC entry mid-book and click it via the shadow DOM.
  const target = await page.evaluate(() => {
    const toc = document.getElementById('reader').querySelectorAll('.toc a');
    // Find an entry that points to a chapter (not just a heading).
    const hit = [...toc].find(a => a.dataset.path && /chapter_005/i.test(a.dataset.path)) || toc[20];
    hit.click();
    return { label: hit.textContent.trim(), path: hit.dataset.path };
  });
  await h.waitChapter((doc) => doc.body?.children?.length > 0);
  const after = await h.state();
  truthy(after.progress !== '1 / 144', `progress should change from initial 1/144 — got ${after.progress}`);
  truthy(target.path, 'TOC entry should expose its path');
});

test('internal anchor click navigates between spine items', async (h, { page }) => {
  await h.openSample('internallinks.epub');
  // The first spine item is the cover image with no links. Walk forward
  // until we find a chapter with `[data-epub-href]` anchors.
  let attempts = 0;
  while (attempts++ < 6) {
    const anchors = await page.evaluate(() => {
      const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
      return [...doc.querySelectorAll('[data-epub-href]')].length;
    });
    if (anchors > 0) break;
    await h.reader.next();
    await h.waitChapter((doc) => doc.body?.children?.length > 0);
  }
  const before = await h.state();
  const anchorInfo = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const a = doc.querySelector('[data-epub-href]');
    const href = a.getAttribute('data-epub-href');
    a.click();
    return { href };
  });
  truthy(anchorInfo.href, 'should have found at least one in-book link');
  await page.waitForFunction((startProgress) => {
    const r = document.getElementById('reader');
    const p = r.querySelector('.progress')?.textContent;
    return p && p !== startProgress;
  }, before.progress, { timeout: 5_000 });
  // Progress updated synchronously, but the iframe load + render may not
  // have completed yet — wait for the destination chapter's content too.
  await h.waitChapter((doc) =>
    (doc.body && doc.body.children.length > 0) || doc.documentElement?.localName === 'svg'
  );
  const after = await h.iframeContent();
  truthy(after.bodyText.length > 0 || after.svgRoot, 'destination chapter should have content');
});

test('CSS references are rewritten to blob URLs', async (h) => {
  await h.openSample('wasteland.epub');
  const c = await h.iframeContent();
  truthy(c.links.length > 0, 'wasteland should have at least one stylesheet link');
  for (const href of c.links) matches(href, /^blob:/, 'stylesheet href');
});

test('image references are rewritten and load successfully', async (h) => {
  await h.openSample('cole-voyage-of-life.epub');
  // The first chapter is the cover — ensure the image loaded from a blob URL.
  const c = await h.iframeContent();
  truthy(c.images.length > 0, 'cover chapter should have at least one image');
  for (const img of c.images) {
    matches(img.src, /^blob:/, 'img src');
    truthy(img.complete && img.w > 0, `image should be loaded: ${img.src}`);
  }
});

test('SVG-in-spine renders as svg root document', async (h) => {
  await h.openSample('svg-in-spine.epub');
  const c = await h.iframeContent();
  truthy(c.svgRoot, 'first chapter should be an SVG document');
});

test('close() unloads the book and clears the UI', async (h) => {
  await h.openSample('trees.epub');
  eq((await h.state()).title, 'Trees');
  await h.reader.close();
  const after = await h.state();
  eq(after.title, '');
  eq(after.progress, '');
  eq(after.tocCount, 0);
});

test('epub-loaded event fires with metadata + spine length', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  // Hook the event before triggering load.
  await page.evaluate(() => {
    window.__loadedEvents = [];
    document.getElementById('reader').addEventListener('epub-loaded', (e) => {
      window.__loadedEvents.push(e.detail);
    });
  });
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => window.__loadedEvents?.length > 0, null, { timeout: 10_000 });
  const detail = await page.evaluate(() => window.__loadedEvents[0]);
  eq(detail.metadata.title, 'Trees');
  eq(detail.spineLength, 3);
  truthy(Array.isArray(detail.toc), 'detail.toc is an array');
});

test('epub-navigate event fires with index + path on chapter change', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => {
    window.__navEvents = [];
    document.getElementById('reader').addEventListener('epub-navigate', (e) => {
      window.__navEvents.push(e.detail);
    });
  });
  await h.reader.next();
  await h.waitChapter((doc) => doc.body?.textContent?.length > 0);
  const events = await page.evaluate(() => window.__navEvents);
  truthy(events.length >= 1, 'expected at least one epub-navigate event');
  eq(events[events.length - 1].index, 1);
  truthy(events[events.length - 1].path, 'navigate detail should include path');
});

test('typography: assigning settings injects a style block in the chapter', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => {
    document.getElementById('reader').typography = {
      fontFamily: 'Georgia, serif',
      fontSize: 130,
      lineHeight: 160,
    };
  });
  const computed = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const style = doc.getElementById('__epub_reader_typography');
    const cs = doc.defaultView.getComputedStyle(doc.body);
    const p = doc.querySelector('p');
    const csp = p ? doc.defaultView.getComputedStyle(p) : null;
    return {
      hasStyle: !!style,
      cssText:  style?.textContent || '',
      bodyFont: cs.fontFamily,
      pLineH:   csp?.lineHeight,
      htmlSize: doc.defaultView.getComputedStyle(doc.documentElement).fontSize,
    };
  });
  truthy(computed.hasStyle, 'typography style element should be present');
  truthy(/Georgia/.test(computed.bodyFont), `body font-family should include Georgia, got ${computed.bodyFont}`);
  // 130% of 16px = 20.8px (browsers may round).
  truthy(/^2[01](\.\d+)?px$/.test(computed.htmlSize), `html font-size ~20.8px, got ${computed.htmlSize}`);
});

test('typography: reset clears the override style', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  // resetTypography goes back to defaults (incl. fontSize 100, lineHeight 0,
  // readingWidth 65 — a sensible default per #9). Verify the explicit
  // overrides we set above don't survive: no font-size override, no
  // font-family override.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.typography = { fontSize: 150, fontFamily: 'Georgia, serif' };
    r.resetTypography();
  });
  const cssText = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const style = doc.getElementById('__epub_reader_typography');
    return style?.textContent || '';
  });
  truthy(!/font-size:\s*150/.test(cssText), `reset should drop fontSize override, css=${cssText}`);
  truthy(!/Georgia/.test(cssText), `reset should drop fontFamily override, css=${cssText}`);
});

test('typography: settings persist across reloads and apply to next book', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('reader').typography = { fontSize: 125, fontFamily: 'Verdana, sans-serif' };
  });
  // Reload the page; settings should restore from localStorage.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r?.querySelector('.title')?.textContent;
  });
  await h.waitChapter((doc) => doc.body?.children?.length > 0);
  const settings = await page.evaluate(() => document.getElementById('reader').typography);
  eq(settings.fontSize, 125, 'fontSize should restore from localStorage');
  matches(settings.fontFamily, /Verdana/, 'fontFamily should restore');
  // Reset for the next test (localStorage persists across pages within the context).
  await page.evaluate(() => document.getElementById('reader').resetTypography());
});

test('typography: panel toggle button shows/hides the settings panel', async (h, { page }) => {
  await h.openSample('trees.epub');
  const initiallyOpen = await page.evaluate(() => {
    const p = document.getElementById('reader').querySelector('.settings-panel');
    return !p.hidden;
  });
  eq(initiallyOpen, false, 'panel should start hidden');
  await page.evaluate(() => {
    document.getElementById('reader').querySelector('.settings-toggle').click();
  });
  const opened = await page.evaluate(() => {
    const p = document.getElementById('reader').querySelector('.settings-panel');
    return !p.hidden;
  });
  eq(opened, true, 'clicking settings-toggle should open the panel');
});


test('light DOM: chrome is a child of the host element, no shadow root', async (h, { page }) => {
  await h.openSample('trees.epub');
  const layout = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return {
      hasShadow: !!r.shadowRoot,
      chrome: !!r.querySelector('.reader-chrome'),
      controlGroups: r.querySelectorAll('.reader-control-group').length,
      iconBtns: r.querySelectorAll('.reader-icon-btn').length,
    };
  });
  eq(layout.hasShadow, false, 'no shadow root after refactor');
  truthy(layout.chrome, '.reader-chrome should be in the host element');
  truthy(layout.controlGroups >= 3, 'at least 3 reader-control-group');
  truthy(layout.iconBtns >= 5, 'at least 5 reader-icon-btn (toc, prev, next, A-, A+, settings)');
});

test('VB tokens: chapter iframe picks up colours set on the host', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  // Override --color-background and --color-text on the host as VB themes do.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.style.setProperty('--color-background', '#102030');
    r.style.setProperty('--color-text', '#cce0ff');
    // Force chapter theming refresh by re-navigating to the same chapter.
    r.goToIndex(0);
  });
  // Wait until the iframe doc has actually picked up the new --color-background
  // (between goToIndex setting src and the new chapter loading, contentDocument
  // can briefly be the previous chapter with stale styles).
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    if (!doc?.body) return false;
    const css = doc.getElementById('__epub_reader_theme')?.textContent || '';
    return css.includes('#102030');
  }, null, { timeout: 5_000 });
  const computed = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const cs = doc.defaultView.getComputedStyle(doc.body);
    return { bg: cs.backgroundColor, fg: cs.color };
  });
  matches(computed.bg, /rgb\(16, ?32, ?48\)/, `chapter bg should follow --color-background, got ${computed.bg}`);
  matches(computed.fg, /rgb\(204, ?224, ?255\)/, `chapter fg should follow --color-text, got ${computed.fg}`);
});

test('font A-/A+ buttons step the typography fontSize', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').resetTypography());
  const before = await page.evaluate(() => document.getElementById('reader').typography.fontSize);
  await page.click('.font-increase');
  await page.click('.font-increase');
  const after = await page.evaluate(() => document.getElementById('reader').typography.fontSize);
  eq(after, before + 20, `A+ twice should add 20% — before ${before}, after ${after}`);
  await page.click('.font-decrease');
  const after2 = await page.evaluate(() => document.getElementById('reader').typography.fontSize);
  eq(after2, before + 10, 'A- once should subtract 10%');
  await page.evaluate(() => document.getElementById('reader').resetTypography());
});

test('TOC: <span> group labels render as headings, not anchors (issue #2)', async (h, { page }) => {
  await h.openSample('childrens-literature.epub');
  // The deeply-nested nav uses <span class="author"> for group headings
  // like "Abram S. Isaacs" / "Hans Christian Andersen". Those should
  // render as .toc-heading (a <strong>), not as a clickable <a>.
  const tocStats = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const headings = [...r.querySelectorAll('.toc .toc-heading')].map(h => h.textContent.trim());
    const anchors = [...r.querySelectorAll('.toc a')].map(a => a.textContent.trim());
    return { headings, anchors, headingCount: headings.length, anchorCount: anchors.length };
  });
  truthy(tocStats.headingCount > 0, `expected at least one .toc-heading, got ${tocStats.headingCount}`);
  truthy(
    tocStats.headings.some(h => /Isaacs|Andersen|Browne|Wilde/i.test(h)),
    `expected an author-name heading, got: ${JSON.stringify(tocStats.headings.slice(0, 5))}`
  );
  // The chapter links (those with href) should still be present.
  truthy(tocStats.anchorCount > 0, 'expected anchors for chapter links');
  // No TOC anchor should have an empty data-path (which would mean an
  // anchor was rendered for a label that has no target).
  const emptyPathAnchors = await page.evaluate(() =>
    [...document.getElementById('reader').querySelectorAll('.toc a')].filter(a => !a.dataset.path).length);
  eq(emptyPathAnchors, 0, 'no TOC anchor should have empty data-path');
});

test('TOC: clicking a deep-fragment entry scrolls past the chapter top (issue #3)', async (h, { page }) => {
  // childrens-literature.epub has a single-chapter structure where the
  // nav doc points at fragments inside s04.xhtml. Click an entry deep
  // in the file and verify the iframe is scrolled meaningfully past 0.
  await h.openSample('childrens-literature.epub');
  const target = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const anchors = [...r.querySelectorAll('.toc a')].filter(a => a.dataset.fragment);
    // Pick an entry roughly mid-list to ensure a non-trivial scroll.
    const hit = anchors[Math.floor(anchors.length / 2)] || anchors[0];
    if (!hit) return null;
    const info = { path: hit.dataset.path, fragment: hit.dataset.fragment };
    hit.click();
    return info;
  });
  truthy(target, 'expected at least one fragment-targeted TOC entry');
  // Wait for the iframe to settle on the right chapter and a non-zero scroll.
  await page.waitForFunction((t) => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    if (!doc?.body) return false;
    const el = doc.getElementById(t.fragment);
    if (!el) return false;
    // Either the element is near the viewport top (scrolled into view),
    // or the document has scrolled at all.
    const rect = el.getBoundingClientRect();
    const scrolled = (doc.scrollingElement?.scrollTop || 0) > 100;
    return scrolled && Math.abs(rect.top) < 200;
  }, target, { timeout: 8_000 });
  const stats = await page.evaluate((t) => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const el = doc.getElementById(t.fragment);
    return {
      scrollTop: doc.scrollingElement?.scrollTop || 0,
      targetTop: el ? Math.round(el.getBoundingClientRect().top) : null,
    };
  }, target);
  truthy(stats.scrollTop > 100, `expected scrollTop > 100 after deep-fragment click, got ${stats.scrollTop}`);
  truthy(Math.abs(stats.targetTop) < 200, `target should be near viewport top, got top=${stats.targetTop}`);
});

test('chapter progress: scrolling the iframe updates the % display (issue #4)', async (h, { page }) => {
  // childrens-literature.epub is one 343 KB chapter — its scroll height
  // far exceeds the viewport, so a scroll has somewhere to go.
  await h.openSample('childrens-literature.epub');
  // Walk to the body chapter (first item is the cover image).
  await page.evaluate(() => document.getElementById('reader').goToIndex(2));
  await h.waitChapter((doc) => doc.body && doc.body.textContent && doc.body.textContent.length > 1000);

  const initial = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return r.querySelector('.chapter-progress').textContent;
  });
  matches(initial, /^\d+%$/, `chapter-progress should show a percentage at start, got ${JSON.stringify(initial)}`);

  // Programmatic scroll inside the iframe.
  await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const se = doc.scrollingElement || doc.documentElement;
    se.scrollTop = Math.floor((se.scrollHeight - se.clientHeight) * 0.6);
    iframe.contentWindow.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => {
    const txt = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^\d+%$/.test(txt) && parseInt(txt, 10) >= 50;
  }, null, { timeout: 5_000 });
  const scrolled = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.chapter-progress').textContent);
  const pct = parseInt(scrolled, 10);
  truthy(pct >= 50 && pct <= 100, `expected 50-100% after scrolling 60% in, got ${scrolled}`);
});

test('chapter progress: spine progress (X / Y) is unchanged by scrolling', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  const before = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const se = doc.scrollingElement || doc.documentElement;
    if (se) se.scrollTop = 200;
  });
  // Allow the scroll listener to update the chapter-progress.
  await page.waitForFunction(() => true, null, { timeout: 50 });
  const after = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(after, before, 'spine progress should not change on scroll');
});

test('rendition:layout: pre-paginated declared at book level (issue #5)', async (h, { page }) => {
  await h.openSample('haruko-html-jpeg.epub');
  const layouts = await page.evaluate(() => {
    const r = document.getElementById('reader');
    // SpineItem.layout is exposed via the `spine` getter on the underlying book.
    // We can't reach the EpubBook directly, but the runtime applies a layout
    // style to the iframe — use that as the observable.
    const doc = r.querySelector('iframe').contentDocument;
    return {
      layoutStyle: !!doc.getElementById('__epub_reader_layout'),
      bodyDisplay: doc.body ? doc.defaultView.getComputedStyle(doc.body).display : '',
      bodyOverflow: doc.documentElement
        ? doc.defaultView.getComputedStyle(doc.documentElement).overflow
        : '',
    };
  });
  truthy(layouts.layoutStyle, 'pre-paginated chapter should get a __epub_reader_layout style');
  eq(layouts.bodyDisplay, 'flex', 'body should be display:flex (centred image)');
  matches(layouts.bodyOverflow, /hidden/, 'html overflow should be hidden in fixed layout');
});

test('rendition:layout: chapter image fits the viewport (issue #5)', async (h, { page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await h.openSample('haruko-html-jpeg.epub');
  const fit = await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const img = doc.querySelector('img');
    if (!img) return null;
    const cs = doc.defaultView.getComputedStyle(img);
    const rect = img.getBoundingClientRect();
    return {
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      width:  Math.round(rect.width),
      height: Math.round(rect.height),
      objectFit: cs.objectFit,
      iframeW: iframe.clientWidth,
      iframeH: iframe.clientHeight,
    };
  });
  truthy(fit, 'chapter should contain at least one image');
  truthy(fit.naturalW > 0, 'image should be loaded');
  truthy(fit.width <= fit.iframeW + 1, `image width ${fit.width} should fit in iframe width ${fit.iframeW}`);
  truthy(fit.height <= fit.iframeH + 1, `image height ${fit.height} should fit in iframe height ${fit.iframeH}`);
});

test('rendition:layout: chapter-progress hidden in fixed-layout chapters', async (h, { page }) => {
  await h.openSample('haruko-html-jpeg.epub');
  const hidden = await page.evaluate(() => {
    const cp = document.getElementById('reader').querySelector('.chapter-progress');
    return cp.hidden;
  });
  eq(hidden, true, 'chapter-progress should be hidden for pre-paginated chapters');
});

test('rendition:layout: reflowable chapters do NOT get the layout style', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  const present = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return !!doc.getElementById('__epub_reader_layout');
  });
  eq(present, false, 'reflowable chapter should not have a layout style injected');
});

test('sandbox: default is allow-same-origin only (issue #6)', async (h, { page }) => {
  await h.openSample('trees.epub');
  const sb = await page.evaluate(() => document.getElementById('reader').querySelector('iframe').getAttribute('sandbox'));
  eq(sb, 'allow-same-origin');
});

test('sandbox: allow-scripts attribute adds it to the iframe sandbox (issue #6)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').setAttribute('allow-scripts', ''));
  const sb = await page.evaluate(() => document.getElementById('reader').querySelector('iframe').getAttribute('sandbox'));
  matches(sb, /allow-same-origin/);
  matches(sb, /allow-scripts/);
  // Removing the attribute reverts.
  await page.evaluate(() => document.getElementById('reader').removeAttribute('allow-scripts'));
  const after = await page.evaluate(() => document.getElementById('reader').querySelector('iframe').getAttribute('sandbox'));
  eq(after, 'allow-same-origin');
});

test('reading width: default 65 ch is applied to chapter body (issue #9)', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => document.getElementById('reader').resetTypography());
  const css = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.getElementById('__epub_reader_typography')?.textContent || '';
  });
  matches(css, /max-inline-size:\s*65ch/, `default reading width should be 65ch, css=${css}`);
  matches(css, /margin-inline:\s*auto/, 'should center the body');
});

test('reading width: 0 means unlimited — no max-inline-size rule (issue #9)', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => { document.getElementById('reader').typography = { readingWidth: 0 }; });
  const css = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.getElementById('__epub_reader_typography')?.textContent || '';
  });
  truthy(!/max-inline-size/.test(css), `unlimited width should drop the rule, css=${css}`);
});

test('reading width: slider value persists across reloads (issue #9)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('reader').typography = { readingWidth: 80 }; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const w = await page.evaluate(() => document.getElementById('reader').typography.readingWidth);
  eq(w, 80);
  await page.evaluate(() => { document.getElementById('reader').resetTypography(); });
});

test('paginated mode: CSS columns are injected (issue #10)', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'paginated' }; });
  const state = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const style = doc.getElementById('__epub_reader_paginated');
    const bodyCs = doc.body ? doc.defaultView.getComputedStyle(doc.body) : null;
    return {
      hasStyle:    !!style,
      columnWidth: bodyCs?.columnWidth || '',
      overflowX:   bodyCs?.overflowX || '',
      overflowY:   bodyCs?.overflowY || '',
    };
  });
  truthy(state.hasStyle, 'paginated style should be injected');
  truthy(state.columnWidth !== '' && state.columnWidth !== 'auto',
    `body should have column-width set, got ${state.columnWidth}`);
  matches(state.overflowX, /auto|scroll/, 'body should be horizontally scrollable');
  matches(state.overflowY, /hidden/, 'body should not scroll vertically');
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'scroll' }; });
});

test('paginated mode: page indicator shows "Page X of Y" (issue #10)', async (h, { page }) => {
  // childrens-literature.epub has one long chapter that produces many
  // columns when paginated.
  await h.openSample('childrens-literature.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(2));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'paginated' }; });
  // Wait for the body to settle into columns and the indicator to update.
  await page.waitForFunction(() => {
    const txt = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^Page \d+ of \d+$/.test(txt);
  }, null, { timeout: 5_000 });
  const text = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.chapter-progress').textContent);
  matches(text, /^Page 1 of \d+$/, `expected "Page 1 of N", got ${JSON.stringify(text)}`);
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'scroll' }; });
});

test('paginated mode: ArrowRight pages within the chapter (issue #10)', async (h, { page }) => {
  await h.openSample('childrens-literature.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(2));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'paginated' }; });
  await page.waitForFunction(() => {
    const t = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^Page 1 of/.test(t);
  }, null, { timeout: 5_000 });

  // Dispatch ArrowRight on the host. Should advance one PAGE (not chapter).
  const beforeSpine = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowRight', bubbles: true }));
  });
  await page.waitForFunction(() => {
    const t = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^Page 2 of/.test(t);
  }, null, { timeout: 3_000 });
  const afterSpine = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(afterSpine, beforeSpine, 'spine progress should not change on page-turn within a chapter');
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'scroll' }; });
});

test('paginated mode: forward at chapter end advances to next spine item (issue #10)', async (h, { page }) => {
  await h.openSample('trees.epub');
  // Switch to paginated mode and jump body scroll to the end so atEnd is true.
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'paginated' }; });
  await page.waitForFunction(() => {
    const t = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^Page \d+ of \d+$/.test(t);
  }, null, { timeout: 5_000 });
  // Force last page of the chapter.
  await page.evaluate(() => {
    const body = document.getElementById('reader').querySelector('iframe').contentDocument.body;
    const w = body.clientWidth;
    body.scrollLeft = body.scrollWidth - w;
  });
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowRight', bubbles: true }));
  });
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  const spine = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(spine, '2 / 3', 'arrow at end of chapter should advance to next spine item');
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'scroll' }; });
});

test('paginated mode: works with RTL chapters (issue #10)', async (h, { page }) => {
  await h.openSample('regime-anticancer-arabic.epub');
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'paginated' }; });
  await page.waitForFunction(() => {
    const t = document.getElementById('reader').querySelector('.chapter-progress').textContent;
    return /^Page \d+ of \d+$/.test(t);
  }, null, { timeout: 5_000 });
  const info = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return {
      dir: doc.documentElement.getAttribute('dir') || doc.body?.getAttribute('dir') || '',
      indicator: document.getElementById('reader').querySelector('.chapter-progress').textContent,
    };
  });
  matches(info.indicator, /^Page 1 of \d+$/, `RTL paginated should show "Page 1 of N", got ${info.indicator}`);
  await page.evaluate(() => { document.getElementById('reader').typography = { layoutMode: 'scroll' }; });
});

test('user CSS: arbitrary rules are appended to the chapter stylesheet (issue #11)', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => {
    document.getElementById('reader').typography = {
      userCss: 'body { letter-spacing: 0.07em !important; }',
    };
  });
  const result = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    const css = doc.getElementById('__epub_reader_typography')?.textContent || '';
    const ls = doc.defaultView.getComputedStyle(doc.body).letterSpacing;
    return { css, ls };
  });
  truthy(/letter-spacing:\s*0\.07em/.test(result.css), `userCss should be appended, css=${result.css}`);
  // 0.07em at 16 px base = ~1.12 px.
  truthy(parseFloat(result.ls) >= 1, `body letter-spacing should reflect userCss, got ${result.ls}`);
});

test('user CSS: @import is stripped, <script> tags are stripped (issue #11)', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => {
    document.getElementById('reader').typography = {
      userCss: '@import url(https://evil.example/x.css);\n<script>1</script>\np { color: red; }',
    };
  });
  const css = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.getElementById('__epub_reader_typography')?.textContent || '';
  });
  truthy(!/evil\.example/.test(css), `@import should be blocked, css=${css}`);
  truthy(!/<script/i.test(css), `<script> should be stripped, css=${css}`);
  truthy(/p\s*\{\s*color:\s*red/.test(css), `harmless rules should survive, css=${css}`);
});

test('user CSS: persists across reload and survives reset clearing it (issue #11)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('reader').typography = { userCss: 'p { color: rebeccapurple; }' };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restored = await page.evaluate(() => document.getElementById('reader').typography.userCss);
  matches(restored, /rebeccapurple/, 'userCss should round-trip via localStorage');
  // Reset clears it.
  await page.evaluate(() => document.getElementById('reader').resetTypography());
  const cleared = await page.evaluate(() => document.getElementById('reader').typography.userCss);
  eq(cleared, '');
});

test('position: chapter index is saved and restored after reload (issue #12)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file', join(SAMPLES, 'moby-dick.epub'));
  await page.waitForFunction(() =>
    document.getElementById('reader')?.querySelector('.title')?.textContent === 'Moby-Dick');
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);

  // Jump to chapter 5 and let the throttled save fire.
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await new Promise(r => setTimeout(r, 700)); // exceed 500 ms save throttle

  // Reload, open the same file. epub-position-restored should fire and
  // we should land on chapter 5 again, not chapter 0.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__restored = null;
    document.getElementById('reader').addEventListener('epub-position-restored',
      (e) => { window.__restored = e.detail; });
  });
  await page.setInputFiles('#file', join(SAMPLES, 'moby-dick.epub'));
  await page.waitForFunction(() => window.__restored !== null, null, { timeout: 8_000 });
  const detail = await page.evaluate(() => window.__restored);
  eq(detail.spineIndex, 5, 'restored spineIndex should match the saved value');
  const progress = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(progress, '6 / 144', 'reader should land on the restored chapter');

  // Cleanup so the next test doesn't auto-restore.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('epub-reader');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
});

test('position: book identifier prefers dc:identifier over SHA-256 (issue #12)', async (h, { page }) => {
  // moby-dick.epub has a dc:identifier; haruko a slightly different one;
  // the prefix should be `id:`. We can observe via the restore event on
  // a fresh load (no stored position → no event), so instead we verify
  // by triggering save and inspecting IndexedDB directly.
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await new Promise(r => setTimeout(r, 700));
  const ids = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('epub-reader');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('positions', 'readonly');
      const req = tx.objectStore('positions').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  truthy(ids.length > 0, 'expected at least one stored position');
  const first = String(ids[0]);
  truthy(first.startsWith('id:') || first.startsWith('sha:'),
    `book id should be prefixed (id: or sha:), got ${first}`);
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('epub-reader');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
});

test('position: stale spineIndex (out of range) is ignored (issue #12)', async (h, { page }) => {
  // Plant a fake stored position with a too-large spineIndex, then load
  // a small book and verify we land on chapter 0 instead of trying to
  // restore the bogus value.
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  // Ensure the DB exists by loading anything once.
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => document.getElementById('reader')?.querySelector('.title')?.textContent);
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  // Wait past the throttled save so the trees.epub identifier is in the DB.
  await new Promise(r => setTimeout(r, 700));
  // Now plant a bogus record under the trees.epub identifier.
  const treesId = await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('epub-reader');
      req.onsuccess = () => resolve(req.result);
    });
    return await new Promise((resolve) => {
      const tx = db.transaction('positions', 'readonly');
      const req = tx.objectStore('positions').getAllKeys();
      req.onsuccess = () => resolve(String(req.result[0] || ''));
    });
  });
  truthy(treesId, 'trees.epub should have stored a real id by now');
  await page.evaluate(async (id) => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('epub-reader');
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('positions', 'readwrite');
      tx.objectStore('positions').put({ id, spineIndex: 999, scrollFraction: 0, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
    });
  }, treesId);

  // Reload + reopen. We should NOT receive an epub-position-restored event,
  // and progress should be 1 / 3.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__restored = null;
    document.getElementById('reader').addEventListener('epub-position-restored',
      (e) => { window.__restored = e.detail; });
  });
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => document.getElementById('reader')?.querySelector('.title')?.textContent);
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  // Allow some time in case the (incorrect) event would fire.
  await new Promise(r => setTimeout(r, 200));
  const restored = await page.evaluate(() => window.__restored);
  eq(restored, null, 'out-of-range stored spineIndex must not trigger a restore');
  const progress = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(progress, '1 / 3', 'reader should fall back to start when stored position is invalid');
  // Cleanup.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('epub-reader');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
});

test('bookmarks: toggleBookmark adds/removes at current position (issue #13)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(3));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);

  // Add via the public API.
  const bm = await page.evaluate(() => document.getElementById('reader').toggleBookmark('first one'));
  truthy(bm, 'toggleBookmark should return the new bookmark');
  eq(bm.spineIndex, 3);
  eq(bm.label, 'first one');
  // Same call removes it (toggle).
  const removed = await page.evaluate(() => document.getElementById('reader').toggleBookmark());
  eq(removed, null, 'second toggle should remove and return null');
  const list = await page.evaluate(() => document.getElementById('reader').bookmarks);
  eq(list.length, 0, 'list should be empty after toggle off');
});

test('bookmarks: list renders + click jumps to chapter (issue #13)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  // Start fresh — wipe any bookmarks left by prior tests for this book.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    return Promise.all(r.bookmarks.map(b => r.removeBookmark(b.id)));
  });
  // Bookmark chapter 5 then chapter 10, jump back to 0, click the chapter 5
  // bookmark in the panel, verify we land there.
  await page.evaluate(async () => {
    const r = document.getElementById('reader');
    await r.goToIndex(5); await r.toggleBookmark('Five');
    await r.goToIndex(10); await r.toggleBookmark('Ten');
    await r.goToIndex(0);
  });
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);

  const renderedLabels = await page.evaluate(() =>
    [...document.getElementById('reader').querySelectorAll('.bm-list .bm-label')]
      .map(l => l.textContent.trim()));
  eq(renderedLabels.length, 2, `expected 2 bookmarks rendered, got ${renderedLabels.length}`);
  truthy(renderedLabels.includes('Five') && renderedLabels.includes('Ten'),
    `expected 'Five' and 'Ten' labels, got ${JSON.stringify(renderedLabels)}`);

  // Click the bookmark whose label is "Five".
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    const li = [...r.querySelectorAll('.bm-list li')]
      .find(li => li.querySelector('.bm-label').textContent.trim() === 'Five');
    li.querySelector('.bm-jump').click();
  });
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  const progress = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.progress').textContent);
  eq(progress, '6 / 144', 'click on "Five" bookmark should land on chapter 5');
});

test('bookmarks: keyboard "b" toggles a bookmark (issue #13)', async (h, { page }) => {
  await h.openSample('trees.epub');
  // Wipe any leftovers from a prior test on this book.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    return Promise.all(r.bookmarks.map(b => r.removeBookmark(b.id)));
  });
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'b', bubbles: true }));
  });
  let len = await page.evaluate(() => document.getElementById('reader').bookmarks.length);
  eq(len, 1, '`b` should add a bookmark');
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'b', bubbles: true }));
  });
  len = await page.evaluate(() => document.getElementById('reader').bookmarks.length);
  eq(len, 0, 'second `b` should remove the bookmark at this position');
});

test('bookmarks: persist across reload (issue #13)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => document.getElementById('reader')?.querySelector('.title')?.textContent);
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(async () => {
    const r = document.getElementById('reader');
    // Wipe any prior bookmarks for this book.
    await Promise.all(r.bookmarks.map(b => r.removeBookmark(b.id)));
    await r.goToIndex(1);
    await r.toggleBookmark('persist test');
  });
  await new Promise(r => setTimeout(r, 200));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file', join(SAMPLES, 'trees.epub'));
  await page.waitForFunction(() => document.getElementById('reader')?.bookmarks?.length > 0,
    null, { timeout: 6_000 });
  const bookmarks = await page.evaluate(() => document.getElementById('reader').bookmarks);
  eq(bookmarks.length, 1);
  eq(bookmarks[0].label, 'persist test');
  eq(bookmarks[0].spineIndex, 1);
  // Cleanup.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('epub-reader');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
});

test('library: opening a book auto-adds it (issue #14)', async (h, { page }) => {
  // Wipe via the public API so we don't fight the page-context restriction.
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());

  await h.openSample('moby-dick.epub');
  // The persist runs fire-and-forget — wait for the entry to land.
  await page.waitForFunction(async () => {
    const lib = await document.getElementById('reader').getLibrary();
    return lib.length > 0 && lib[0].title === 'Moby-Dick';
  }, null, { timeout: 5_000 });
  const lib = await page.evaluate(() => document.getElementById('reader').getLibrary());
  eq(lib.length, 1, 'expected one library entry after opening one book');
  eq(lib[0].title, 'Moby-Dick');
  truthy(lib[0].size > 0, 'library entry should record blob.size');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('library: panel renders cards for stored books (issue #14)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());

  // Open three different books so the library has something to show.
  await h.openSample('trees.epub');
  await page.waitForFunction(async () =>
    (await document.getElementById('reader').getLibrary()).length === 1, null, { timeout: 5_000 });
  await h.openSample('wasteland.epub');
  await page.waitForFunction(async () =>
    (await document.getElementById('reader').getLibrary()).length === 2, null, { timeout: 5_000 });
  await h.openSample('moby-dick.epub');
  await page.waitForFunction(async () =>
    (await document.getElementById('reader').getLibrary()).length === 3, null, { timeout: 5_000 });

  // Open the panel and verify cards are rendered.
  await page.click('.library-toggle');
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return !r.querySelector('.library-panel').hidden &&
           r.querySelectorAll('.lib-list li').length === 3;
  }, null, { timeout: 5_000 });
  const titles = await page.evaluate(() =>
    [...document.getElementById('reader').querySelectorAll('.lib-list .lib-title')]
      .map(t => t.textContent.trim()));
  truthy(titles.includes('Moby-Dick'), `expected Moby-Dick card, got ${JSON.stringify(titles)}`);
  truthy(titles.includes('Trees'), `expected Trees card, got ${JSON.stringify(titles)}`);
  truthy(titles.includes('The Waste Land'), `expected The Waste Land card, got ${JSON.stringify(titles)}`);

  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('library: openFromLibrary opens the stored blob (issue #14)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
  await h.openSample('trees.epub');
  await page.waitForFunction(async () =>
    (await document.getElementById('reader').getLibrary()).length === 1, null, { timeout: 5_000 });

  // Now navigate via the library entry (no file picker). The reader
  // should report the same title.
  const id = await page.evaluate(async () =>
    (await document.getElementById('reader').getLibrary())[0].id);
  await page.evaluate(() => document.getElementById('reader').close());
  // Confirm closed.
  const t1 = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.title').textContent);
  eq(t1, '', 'title should be cleared after close()');

  await page.evaluate((id) => document.getElementById('reader').openFromLibrary(id), id);
  await page.waitForFunction(() =>
    document.getElementById('reader').querySelector('.title').textContent === 'Trees',
    null, { timeout: 5_000 });

  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('library: removeFromLibrary drops the entry (issue #14)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
  await h.openSample('trees.epub');
  await h.openSample('wasteland.epub');
  await page.waitForFunction(async () =>
    (await document.getElementById('reader').getLibrary()).length === 2, null, { timeout: 5_000 });
  const id = await page.evaluate(async () => {
    const lib = await document.getElementById('reader').getLibrary();
    return lib.find(e => e.title === 'Trees').id;
  });
  await page.evaluate((id) => document.getElementById('reader').removeFromLibrary(id), id);
  const remaining = await page.evaluate(async () =>
    (await document.getElementById('reader').getLibrary()).map(e => e.title));
  eq(remaining.length, 1);
  eq(remaining[0], 'The Waste Land');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('library: clearLibrary wipes everything including bookmarks + positions (issue #14)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());

  await h.openSample('trees.epub');
  await page.evaluate(async () => {
    const r = document.getElementById('reader');
    await r.toggleBookmark('keep me');
    await r.goToIndex(2);
  });
  await new Promise(r => setTimeout(r, 700));

  await page.evaluate(() => document.getElementById('reader').clearLibrary());
  const state = await page.evaluate(async () => {
    const r = document.getElementById('reader');
    return { lib: (await r.getLibrary()).length, bm: r.bookmarks.length };
  });
  eq(state.lib, 0, 'library cleared');
  eq(state.bm, 0, 'bookmarks cleared');
});

test('library: getStorageEstimate reports usage/quota (issue #14)', async (h, { page }) => {
  await h.openSample('trees.epub');
  const est = await page.evaluate(() => document.getElementById('reader').getStorageEstimate());
  // Browsers without the API may return null — Chromium has it.
  if (est === null) return;
  truthy(typeof est.usage === 'number' && est.usage >= 0, 'usage should be a number');
  truthy(typeof est.quota === 'number' && est.quota > 0, 'quota should be > 0');
  truthy(est.percent >= 0 && est.percent <= 100, `percent should be 0..100, got ${est.percent}`);
});

test('find: Ctrl+F opens the find bar (issue #17)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  // Dispatch Ctrl+F on the host.
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', ctrlKey: true, bubbles: true }));
  });
  const open = await page.evaluate(() =>
    !document.getElementById('reader').querySelector('.find-bar').hidden);
  eq(open, true, 'Ctrl+F should open the find bar');
});

test('find: typing highlights matches and shows count (issue #17)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(() => document.getElementById('reader').find(true));

  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.find-input');
    el.value = 'the';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const c = document.getElementById('reader').querySelector('.find-count').textContent;
    return /^\d+ \/ \d+$/.test(c) && Number(c.split('/')[1].trim()) > 0;
  }, null, { timeout: 5_000 });
  const stats = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const doc = r.querySelector('iframe').contentDocument;
    return {
      count: r.querySelector('.find-count').textContent,
      marks: doc.querySelectorAll('[data-reader-mark="find"]').length,
      currentMarks: doc.querySelectorAll('[data-reader-mark="find"].current').length,
    };
  });
  matches(stats.count, /^1 \/ [1-9]\d*$/, `expected "1 / N", got ${stats.count}`);
  truthy(stats.marks > 0, 'expected at least one find mark in the chapter');
  truthy(stats.currentMarks >= 1, 'expected exactly the first match to be .current');
  await page.evaluate(() => document.getElementById('reader').find(false));
});

test('find: Enter cycles forward, Shift+Enter cycles backward (issue #17)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(() => document.getElementById('reader').find(true));
  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.find-input');
    el.value = 'the';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const c = document.getElementById('reader').querySelector('.find-count').textContent;
    return /^1 \/ \d+$/.test(c);
  });
  // Step forward twice, back once → at "2 / N".
  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.find-input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  });
  const count = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.find-count').textContent);
  matches(count, /^2 \/ /, `expected "2 / N" after +/+/-, got ${count}`);
  await page.evaluate(() => document.getElementById('reader').find(false));
});

test('find: Escape closes and clears marks (issue #17)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.evaluate(() => document.getElementById('reader').find(true));
  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.find-input');
    el.value = 'the';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-reader-mark="find"]').length > 0;
  });
  await page.evaluate(() => {
    document.getElementById('reader').dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true }));
  });
  const after = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const doc = r.querySelector('iframe').contentDocument;
    return {
      barHidden: r.querySelector('.find-bar').hidden,
      marks: doc.querySelectorAll('[data-reader-mark="find"]').length,
    };
  });
  eq(after.barHidden, true, 'Esc should close the find bar');
  eq(after.marks, 0, 'Esc should clear find marks');
});

test('search: returns hits across multiple chapters with context (issue #16)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  const hits = await page.evaluate(() => document.getElementById('reader').search('whale', { maxHits: 50 }));
  truthy(hits.length > 5, `expected several hits, got ${hits.length}`);
  const chapters = new Set(hits.map(hit => hit.spineIndex));
  truthy(chapters.size > 1, `hits should span chapters, only saw ${[...chapters].join(',')}`);
  // Each hit carries enough to render a card.
  const sample = hits[0];
  truthy(typeof sample.title === 'string' && sample.title.length > 0, 'hit.title');
  matches(sample.match, /whale/i);
  truthy(sample.contextBefore !== undefined && sample.contextAfter !== undefined,
    'hit should carry surrounding context strings');
});

test('search: too-short query returns no hits (issue #16)', async (h, { page }) => {
  await h.openSample('trees.epub');
  const empty = await page.evaluate(() => document.getElementById('reader').search('a'));
  eq(empty.length, 0, 'queries shorter than 2 chars must return []');
});

test('search: panel renders results grouped by chapter (issue #16)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.click('.search-toggle');
  await page.waitForFunction(() => !document.getElementById('reader').querySelector('.search-panel').hidden);
  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.search-input');
    el.value = 'whale';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r.querySelectorAll('.search-results li').length > 0;
  }, null, { timeout: 30_000 });
  const summary = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return {
      results: r.querySelectorAll('.search-results li').length,
      status:  r.querySelector('.srch-status').textContent,
      firstChapter: r.querySelector('.search-results .srch-chap')?.textContent || '',
      firstSnippetMark: r.querySelector('.search-results .srch-snippet mark')?.textContent || '',
    };
  });
  truthy(summary.results > 5, `expected multiple results, got ${summary.results}`);
  matches(summary.status, /\d+ result/, `status should report counts, got ${summary.status}`);
  matches(summary.firstSnippetMark, /whale/i, 'snippet should highlight the matched term');
});

test('search: clicking a hit jumps to the chapter and highlights matches (issue #16)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.click('.search-toggle');
  await page.evaluate(() => {
    const el = document.getElementById('reader').querySelector('.search-input');
    el.value = 'whale';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return r.querySelectorAll('.search-results li').length > 0;
  }, null, { timeout: 30_000 });

  // Capture the destination chapter title before clicking.
  const targetTitle = await page.evaluate(() =>
    document.getElementById('reader').querySelector('.search-results .srch-chap').textContent.trim());
  // Click the first hit. Wait for the panel to close + the chapter to render.
  await page.click('.search-results li:first-child .srch-jump');
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    if (!r.querySelector('.search-panel').hidden) return false;
    const doc = r.querySelector('iframe').contentDocument;
    return doc?.querySelectorAll('[data-reader-mark="search"]').length > 0;
  }, null, { timeout: 8_000 });
  const state = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const doc = r.querySelector('iframe').contentDocument;
    return {
      title: r.querySelector('.title').textContent,
      marks: doc.querySelectorAll('[data-reader-mark="search"]').length,
    };
  });
  truthy(state.marks > 0, 'destination chapter should have search marks');
  truthy(targetTitle.length > 0, 'a chapter title was rendered');
});

test('search: closing the book clears the index + highlights (issue #16)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').search('whale'));
  await page.evaluate(() => document.getElementById('reader').close());
  const state = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return {
      panelHidden: r.querySelector('.search-panel').hidden,
      input: r.querySelector('.search-input').value,
      results: r.querySelectorAll('.search-results li').length,
    };
  });
  eq(state.panelHidden, true);
  eq(state.input, '');
  eq(state.results, 0);
});

test('highlights: programmatic add via selection works (issue #15)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);

  // Make a selection inside the iframe of the first ~50 chars.
  await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let t;
    while ((t = walker.nextNode())) {
      if (t.data && t.data.trim().length > 20) break;
    }
    const range = doc.createRange();
    range.setStart(t, 0);
    range.setEnd(t, Math.min(t.data.length, 30));
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger the popover's selection refresh.
    doc.dispatchEvent(new Event('selectionchange'));
  });
  // The popover should be visible.
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.hl-popover').hidden,
    null, { timeout: 3_000 });
  // Click the yellow swatch.
  await page.click('.hl-popover .hl-color[data-color="#fde68a"]');
  // Verify a highlight mark exists in the chapter, and the public list
  // reports one item.
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-reader-mark="highlight"]').length > 0;
  }, null, { timeout: 3_000 });
  const list = await page.evaluate(() => document.getElementById('reader').highlights);
  eq(list.length, 1, 'expected one persisted highlight');
  eq(list[0].color, '#fde68a');
  truthy(list[0].text.length > 0);
  // Cleanup
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('highlights: re-applied when chapter reloads (issue #15)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  // The iframe may transition between waitChapter resolving and the
  // following evaluate firing. Wait for both `body.children > 0` AND
  // a long-enough text node to be present, in the same tick that we
  // capture the selection — eliminates the race.
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    if (!doc?.body) return false;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let t;
    while ((t = walker.nextNode())) {
      if (t.data && t.data.trim().length > 20) return true;
    }
    return false;
  }, null, { timeout: 8_000 });
  // Simulate a saved highlight by dispatching a selection + colour click.
  await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let t;
    while ((t = walker.nextNode())) { if (t.data && t.data.trim().length > 20) break; }
    const range = doc.createRange();
    range.setStart(t, 0); range.setEnd(t, 25);
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.hl-popover').hidden);
  await page.click('.hl-popover .hl-color[data-color="#bbf7d0"]');
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-reader-mark="highlight"]').length > 0;
  });

  // Navigate away and back — highlight wrapper should reappear.
  await page.evaluate(() => document.getElementById('reader').goToIndex(6));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  const onAwayMarks = await page.evaluate(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-reader-mark="highlight"]').length;
  });
  eq(onAwayMarks, 0, 'no highlights expected on a different chapter');

  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await page.waitForFunction(() => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    return doc.querySelectorAll('[data-reader-mark="highlight"]').length > 0;
  }, null, { timeout: 5_000 });
  // Cleanup
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('highlights: removeHighlight clears the in-memory list + chapter mark (issue #15)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);

  await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let t;
    while ((t = walker.nextNode())) { if (t.data && t.data.trim().length > 30) break; }
    const r = doc.createRange();
    r.setStart(t, 0); r.setEnd(t, 25);
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(r);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.hl-popover').hidden);
  await page.click('.hl-popover .hl-color[data-color="#fde68a"]');
  await page.waitForFunction(() =>
    document.getElementById('reader').highlights.length === 1, null, { timeout: 5_000 });

  // Now remove it. Both the array and the chapter mark must go.
  const id = await page.evaluate(() => document.getElementById('reader').highlights[0].id);
  await page.evaluate((id) => document.getElementById('reader').removeHighlight(id), id);
  const state = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const doc = r.querySelector('iframe').contentDocument;
    return {
      list: r.highlights.length,
      marks: doc.querySelectorAll('[data-reader-mark="highlight"]').length,
    };
  });
  eq(state.list, 0, 'removed highlight should leave list empty');
  eq(state.marks, 0, 'removed highlight should drop its <mark> wrapper');
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('highlights: panel renders entries and click jumps to the chapter (issue #15)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  // Add a highlight.
  await page.evaluate(() => {
    const iframe = document.getElementById('reader').querySelector('iframe');
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let t;
    while ((t = walker.nextNode())) { if (t.data && t.data.trim().length > 30) break; }
    const r = doc.createRange();
    r.setStart(t, 0); r.setEnd(t, 25);
    win.getSelection().removeAllRanges();
    win.getSelection().addRange(r);
    doc.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.hl-popover').hidden);
  await page.click('.hl-popover .hl-color[data-color="#fbcfe8"]');
  await page.waitForFunction(() => document.getElementById('reader').highlights.length === 1);

  // Navigate elsewhere, then open panel and click the entry → land back here.
  await page.evaluate(() => document.getElementById('reader').goToIndex(0));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  await page.click('.highlights-toggle');
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.highlights-panel').hidden &&
    document.getElementById('reader').querySelectorAll('.hl-list li').length === 1);
  await page.click('.hl-list .hl-jump');
  await page.waitForFunction(() => {
    return document.getElementById('reader').querySelector('.progress').textContent === '6 / 144';
  }, null, { timeout: 8_000 });
  // Cleanup
  await page.evaluate(() => document.getElementById('reader').clearLibrary());
});

test('robustness: obfuscated OTF font is decoded back to its OTTO/0x0001 magic (issue #21)', async (h, { page }) => {
  // wasteland-otf-obf.epub uses IDPF font obfuscation. The resourceUrl()
  // path applies de-obfuscation before exposing the blob — fetch the
  // manifest's font resource and verify the magic bytes match a real
  // OpenType signature.
  await h.openSample('wasteland-otf-obf.epub');
  const magic = await page.evaluate(async () => {
    const doc = document.getElementById('reader').querySelector('iframe').contentDocument;
    // Walk every stylesheet in the chapter — including the ones reached
    // via @import — and collect the first blob: URL referenced via
    // url(...) (font references end up here after our rewriting).
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const blobUrls = [];
    /** @param {CSSStyleSheet} sheet */
    const walk = (sheet) => {
      if (!sheet || seen.has(sheet.href || '')) return;
      seen.add(sheet.href || '');
      let rules;
      try { rules = sheet.cssRules; } catch { return; }
      for (const rule of rules || []) {
        if (rule.constructor.name === 'CSSImportRule') walk(/** @type {any} */ (rule).styleSheet);
        const src = (rule.cssText || '');
        const m = src.match(/url\(["']?(blob:[^"')]+)/);
        if (m && !blobUrls.includes(m[1])) blobUrls.push(m[1]);
      }
    };
    for (const ss of doc.styleSheets) walk(ss);
    if (blobUrls.length === 0) return null;
    // The OTF/WOFF magic only appears at offset 0 of the actual font
    // file. CSS may reference both stylesheets (via @import) and the
    // font itself; check each blob until we find a recognisable one.
    for (const url of blobUrls) {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 4) continue;
      const b = new Uint8Array(buf, 0, 4);
      const hex = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
      if (hex === '4f 54 54 4f' || hex === '00 01 00 00' || hex === '77 4f 46 46') {
        return hex;
      }
    }
    return null;
  });
  truthy(magic, 'expected to find an OTF/WOFF magic byte sequence in the chapter blob URLs');
  // OpenType: 'OTTO' = '4f 54 54 4f', or version 1.0 = '00 01 00 00';
  // WOFF: '77 4f 46 46'. Any of those indicates we de-obfuscated.
  matches(magic, /^(4f 54 54 4f|00 01 00 00|77 4f 46 46)$/,
    `expected OTF/WOFF magic, got ${magic}`);
});

test('robustness: malformed mimetype rejects with a clear error (issue #21)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  // Build a tiny ZIP at the page level using browser-side helpers.
  // Bad mimetype → openEpub throws → reader fires epub-error.
  const errorMessage = await page.evaluate(async () => {
    // Minimal valid ZIP with a single "mimetype" entry containing the
    // wrong string, and nothing else. Hand-crafted bytes follow the
    // ZIP spec.
    const content = new TextEncoder().encode('text/plain');
    const name = new TextEncoder().encode('mimetype');
    const lfh = new Uint8Array(30 + name.length + content.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0,  0x04034b50, true);   // local file header signature
    dv.setUint16(4,  20,         true);   // version
    dv.setUint16(6,  0,          true);   // flags
    dv.setUint16(8,  0,          true);   // method = stored
    dv.setUint32(14, 0,          true);   // crc32 (skipped — readers don't enforce here)
    dv.setUint32(18, content.length, true);
    dv.setUint32(22, content.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lfh.set(name, 30);
    lfh.set(content, 30 + name.length);

    const cd = new Uint8Array(46 + name.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);   // CD header signature
    cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);  cdv.setUint16(10, 0, true);
    cdv.setUint32(20, content.length, true);
    cdv.setUint32(24, content.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint16(30, 0, true); cdv.setUint16(32, 0, true);
    cdv.setUint32(42, 0, true);           // local header offset = 0
    cd.set(name, 46);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0,  0x06054b50, true);
    ev.setUint16(8,  1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, cd.length, true);
    ev.setUint32(16, lfh.length, true);

    const total = new Uint8Array(lfh.length + cd.length + eocd.length);
    total.set(lfh, 0);
    total.set(cd, lfh.length);
    total.set(eocd, lfh.length + cd.length);
    const blob = new Blob([total], { type: 'application/epub+zip' });

    return await new Promise((resolve) => {
      const reader = document.getElementById('reader');
      reader.addEventListener('epub-error', (e) =>
        resolve(e.detail.error?.message || String(e.detail.error)),
        { once: true });
      reader.open(blob);
    });
  });
  matches(errorMessage, /mimetype.*application\/epub\+zip/i,
    `expected a mimetype error, got ${errorMessage}`);
});

test('robustness: missing container.xml rejects with a clear error (issue #21)', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  // Empty ZIP (just an EOCD record) — no container.xml inside.
  const errorMessage = await page.evaluate(async () => {
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    const blob = new Blob([eocd], { type: 'application/epub+zip' });
    return await new Promise((resolve) => {
      const reader = document.getElementById('reader');
      reader.addEventListener('epub-error', (e) =>
        resolve(e.detail.error?.message || String(e.detail.error)),
        { once: true });
      reader.open(blob);
    });
  });
  matches(errorMessage, /container\.xml/i,
    `expected a container.xml error, got ${errorMessage}`);
});

test('a11y: chrome controls all have accessible names (issue #20)', async (h, { page }) => {
  await h.openSample('trees.epub');
  const missing = await page.evaluate(() => {
    const r = document.getElementById('reader');
    /** @type {string[]} */
    const out = [];
    for (const el of r.querySelectorAll('button')) {
      const name = el.getAttribute('aria-label') || el.textContent?.trim();
      if (!name) out.push(el.outerHTML.slice(0, 60));
    }
    return out;
  });
  eq(missing.length, 0, `expected every button to have an accessible name; missing: ${JSON.stringify(missing)}`);
});

test('a11y: TOC uses tree/treeitem roles + aria-current on the active entry (issue #20)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  const treeShape = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return {
      treeRole: r.querySelector('.toc')?.getAttribute('role'),
      treeitemCount: r.querySelectorAll('.toc [role="treeitem"]').length,
      anchorCount: r.querySelectorAll('.toc a').length,
    };
  });
  eq(treeShape.treeRole, 'tree');
  truthy(treeShape.treeitemCount > 0, 'expected role=treeitem on TOC entries');
  // Every TOC anchor should also be a treeitem.
  truthy(treeShape.treeitemCount >= treeShape.anchorCount,
    `treeitems (${treeShape.treeitemCount}) should cover anchors (${treeShape.anchorCount})`);

  // Navigate to a known chapter; aria-current should land on its TOC entry.
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await h.waitChapter((doc) => doc.body && doc.body.children.length > 0);
  const current = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const els = [...r.querySelectorAll('.toc a[aria-current="true"]')];
    return els.length;
  });
  truthy(current === 1, `expected exactly one aria-current=true TOC entry, got ${current}`);
});

test('a11y: chapter changes announce via the polite live region (issue #20)', async (h, { page }) => {
  await h.openSample('moby-dick.epub');
  await page.evaluate(() => document.getElementById('reader').goToIndex(5));
  await page.waitForFunction(() => {
    const r = document.getElementById('reader');
    return /^Chapter 6 of \d+/.test(r.querySelector('[role="status"]')?.textContent || '');
  }, null, { timeout: 5_000 });
  const live = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const el = r.querySelector('[role="status"]');
    return { text: el?.textContent || '', polite: el?.getAttribute('aria-live') };
  });
  eq(live.polite, 'polite', 'live region should be polite');
  matches(live.text, /^Chapter 6 of \d+/, `expected "Chapter 6 of N…", got ${JSON.stringify(live.text)}`);
});

test('a11y: skip link is present and targets the chapter iframe (issue #20)', async (h, { page }) => {
  await h.openSample('trees.epub');
  const link = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const a = r.querySelector('a.skip-link');
    return a ? { href: a.getAttribute('href'), text: a.textContent } : null;
  });
  truthy(link, 'expected a .skip-link element');
  eq(link.href, '#__epub_chapter');
  matches(link.text, /skip/i, 'skip link should mention skipping');
});

test('a11y: closing the settings panel returns focus to its toggle (issue #20)', async (h, { page }) => {
  await h.openSample('trees.epub');
  await page.click('.settings-toggle');
  await page.waitForFunction(() =>
    !document.getElementById('reader').querySelector('.settings-panel').hidden);
  // Click the panel's Done button.
  await page.click('.s-close');
  // After close, document.activeElement should be the settings-toggle.
  const focusedClass = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const a = r.contains(document.activeElement) ? document.activeElement.className : '';
    return a;
  });
  matches(focusedClass, /settings-toggle/, `focus should return to the toggle, got "${focusedClass}"`);
});

// ---------- runner ----------

const filtered = grep ? tests.filter(t => t.name.includes(grep)) : tests;
if (!filtered.length) { console.error(grep ? `No tests match --grep=${grep}` : 'No tests'); process.exit(2); }

const server = await startServer(ROOT);
const browser = await chromium.launch();
let pass = 0, fail = 0;
const t0 = Date.now();

try {
  for (const t of filtered) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const txt = msg.text();
      if (/Failed to load resource/.test(txt)) return;
      if (/sandboxed and the 'allow-scripts'/.test(txt)) return;
      consoleErrors.push(txt);
    });
    const h = helpers(page, server);
    try {
      await t.fn(h, { page, server });
      if (consoleErrors.length) throw new Error('console errors: ' + consoleErrors.slice(0, 3).join(' | '));
      console.log(`PASS  ${t.name}`);
      pass++;
    } catch (err) {
      console.log(`FAIL  ${t.name}\n      ${err.message}`);
      if (verbose && consoleErrors.length) {
        for (const e of consoleErrors) console.log(`      · ${e}`);
      }
      fail++;
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const dur = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${pass}/${pass + fail} integration tests passed in ${dur}s`);
if (fail > 0) process.exit(1);
