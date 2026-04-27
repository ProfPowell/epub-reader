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
  await h.waitChapter((doc) =>
    doc.body && doc.body.children.length > 0 && doc.getElementById('__epub_reader_theme'));
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
