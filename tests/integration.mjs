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
      const t = r?.shadowRoot?.querySelector('.title')?.textContent;
      const ov = r?.shadowRoot?.querySelector('.overlay');
      const errMode = ov && !ov.hidden && ov.classList.contains('error');
      return errMode || (t && t.length > 0);
    }, null, { timeout: 15_000 });
    await page.waitForFunction(() => {
      const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
      if (!doc) return false;
      if (doc.body && doc.body.children.length > 0) return true;
      return doc.documentElement?.localName === 'svg';
    }, null, { timeout: 10_000 });
  },

  state: () => page.evaluate(() => {
    const r = document.getElementById('reader');
    const s = r.shadowRoot;
    return {
      title:    s.querySelector('.title')?.textContent || '',
      progress: s.querySelector('.progress')?.textContent || '',
      tocCount: s.querySelectorAll('.toc a').length,
    };
  }),

  iframeContent: () => page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
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
    const iframe = document.getElementById('reader').shadowRoot.querySelector('iframe');
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
    const toc = document.getElementById('reader').shadowRoot.querySelectorAll('.toc a');
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
      const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
      return [...doc.querySelectorAll('[data-epub-href]')].length;
    });
    if (anchors > 0) break;
    await h.reader.next();
    await h.waitChapter((doc) => doc.body?.children?.length > 0);
  }
  const before = await h.state();
  const anchorInfo = await page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
    const a = doc.querySelector('[data-epub-href]');
    const href = a.getAttribute('data-epub-href');
    a.click();
    return { href };
  });
  truthy(anchorInfo.href, 'should have found at least one in-book link');
  await page.waitForFunction((startProgress) => {
    const r = document.getElementById('reader');
    const p = r.shadowRoot.querySelector('.progress')?.textContent;
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
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
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
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.typography = { fontSize: 150 };
    r.resetTypography();
  });
  const cssText = await page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
    const style = doc.getElementById('__epub_reader_typography');
    return style?.textContent || '';
  });
  eq(cssText.trim(), '', 'reset should leave an empty stylesheet');
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
    return r?.shadowRoot?.querySelector('.title')?.textContent;
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
    const p = document.getElementById('reader').shadowRoot.querySelector('.settings-panel');
    return !p.hidden;
  });
  eq(initiallyOpen, false, 'panel should start hidden');
  await page.evaluate(() => {
    document.getElementById('reader').shadowRoot.querySelector('.settings-toggle').click();
  });
  const opened = await page.evaluate(() => {
    const p = document.getElementById('reader').shadowRoot.querySelector('.settings-panel');
    return !p.hidden;
  });
  eq(opened, true, 'clicking settings-toggle should open the panel');
});

test('theme: setting a theme applies to host attribute and chapter body', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => { document.getElementById('reader').theme = 'dark'; });
  const state = await page.evaluate(() => {
    const r = document.getElementById('reader');
    const doc = r.shadowRoot.querySelector('iframe').contentDocument;
    const cs = doc.defaultView.getComputedStyle(doc.body);
    return {
      hostAttr:   r.getAttribute('data-theme'),
      themeProp:  r.theme,
      hasStyle:   !!doc.getElementById('__epub_reader_theme'),
      bgColor:    cs.backgroundColor,
      fgColor:    cs.color,
    };
  });
  eq(state.hostAttr, 'dark', 'host data-theme should be set');
  eq(state.themeProp, 'dark');
  truthy(state.hasStyle, 'theme style element should be present');
  // The dark preset bg is #17181b → rgb(23, 24, 27); fg #e9e9ec → rgb(233, 233, 236).
  matches(state.bgColor, /rgb\(23, ?24, ?27\)/, `bg should be dark, got ${state.bgColor}`);
  matches(state.fgColor, /rgb\(233, ?233, ?236\)/, `fg should be light, got ${state.fgColor}`);
});

test('theme: chapter link colour matches the preset', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => { document.getElementById('reader').theme = 'sepia'; });
  const colour = await page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
    let a = doc.querySelector('a');
    if (!a) {
      a = doc.createElement('a'); a.href = '#'; a.textContent = 'x';
      doc.body.append(a);
    }
    return doc.defaultView.getComputedStyle(a).color;
  });
  // Sepia link #7c421d → rgb(124, 66, 29).
  matches(colour, /rgb\(124, ?66, ?29\)/, `sepia link should match preset, got ${colour}`);
});

test('theme: auto emits prefers-color-scheme media query', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  await page.evaluate(() => { document.getElementById('reader').theme = 'auto'; });
  const css = await page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
    return doc.getElementById('__epub_reader_theme')?.textContent || '';
  });
  matches(css, /@media \(prefers-color-scheme: dark\)/, 'auto theme should emit @media block');
  // Both tokens should appear (light branch + dark branch).
  truthy(css.includes('#fbfaf7'), 'should contain light bg');
  truthy(css.includes('#17181b'), 'should contain dark bg');
});

test('theme: setting persists across reload', async (h, { page }) => {
  await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('reader').theme = 'sepia'; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restored = await page.evaluate(() => {
    const r = document.getElementById('reader');
    return { theme: r.theme, hostAttr: r.getAttribute('data-theme') };
  });
  eq(restored.theme, 'sepia');
  eq(restored.hostAttr, 'sepia');
  // Reset for subsequent runs.
  await page.evaluate(() => { document.getElementById('reader').theme = 'auto'; });
});

test('theme: custom CSS variable on host overrides preset bg', async (h, { page }) => {
  await h.openSample('wasteland.epub');
  // Override --reader-theme-bg on the host, then activate a theme. The
  // chapter CSS reads the resolved value from the host.
  await page.evaluate(() => {
    const r = document.getElementById('reader');
    r.style.setProperty('--reader-theme-bg', '#102030');
    r.theme = 'light';
  });
  const bg = await page.evaluate(() => {
    const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
    return doc.defaultView.getComputedStyle(doc.body).backgroundColor;
  });
  // #102030 → rgb(16, 32, 48)
  matches(bg, /rgb\(16, ?32, ?48\)/, `custom bg override should win, got ${bg}`);
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
