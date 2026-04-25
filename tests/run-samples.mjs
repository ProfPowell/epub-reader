// Walks every EPUB in samples/ through the reader and asserts that
// metadata, spine, and TOC parse and that the first chapter renders
// without errors. Exits non-zero on any failure.
//
// Usage: npm test
// Filter:  node tests/run-samples.mjs --grep moby
// Verbose: node tests/run-samples.mjs --verbose

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES_DIR = join(ROOT, 'samples');
const KNOWN_FAILURES = JSON.parse(readFileSync(join(__dirname, 'known-failures.json'), 'utf8'));

const args = process.argv.slice(2);
const grep = args.find(a => a.startsWith('--grep='))?.slice(7)
          || (args.includes('--grep') ? args[args.indexOf('--grep') + 1] : null);
const verbose = args.includes('--verbose') || args.includes('-v');

const playwright = await import('playwright').catch(() => null);
if (!playwright) {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(2);
}
const { chromium } = playwright;

const samples = readdirSync(SAMPLES_DIR)
  .filter(f => f.endsWith('.epub'))
  .filter(f => !grep || f.includes(grep))
  .sort();

if (!samples.length) {
  console.error(grep ? `No samples match --grep=${grep}` : 'No samples found in samples/');
  process.exit(2);
}

const server = await startServer(ROOT);
const browser = await chromium.launch();
const results = [];
const t0 = Date.now();

try {
  for (const file of samples) {
    const r = await runOne(file);
    const known = KNOWN_FAILURES[file];
    if (r.ok) {
      r.status = known ? 'XPASS' : 'PASS';
    } else {
      r.status = known ? 'XFAIL' : 'FAIL';
    }
    results.push(r);
    const summary = r.ok
      ? `spine=${r.spineLength} toc=${r.tocItems} title=${truncate(r.title, 40)}`
      : (known ? `(#${known.issue}) ${known.reason}` : r.error);
    console.log(`${r.status.padEnd(5)} ${file.padEnd(45)} ${summary}`);
    if (verbose && r.warnings.length) {
      for (const w of r.warnings) console.log(`         · ${w}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const passed = results.filter(r => r.status === 'PASS');
const xfailed = results.filter(r => r.status === 'XFAIL');
const failed = results.filter(r => r.status === 'FAIL');
const xpassed = results.filter(r => r.status === 'XPASS');
const dur = ((Date.now() - t0) / 1000).toFixed(1);

console.log(
  `\n${passed.length} passed, ${xfailed.length} expected failures, ` +
  `${failed.length} unexpected failures, ${xpassed.length} unexpected passes ` +
  `(${dur}s)`
);
if (xpassed.length) {
  console.log(`\nUnexpected passes — remove from known-failures.json:`);
  for (const r of xpassed) console.log(`  ${r.file}`);
}
if (failed.length) {
  console.log(`\nUnexpected failures:`);
  for (const r of failed) console.log(`  ${r.file}: ${r.error}`);
  process.exit(1);
}
if (xpassed.length) process.exit(1);

async function runOne(file) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const warnings = [];

  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    // Network failures are tracked separately via `response`.
    if (/Failed to load resource/.test(t)) return;
    // Chapter sandbox warnings are expected for scripted EPUBs.
    if (/sandboxed and the 'allow-scripts'/.test(t)) { warnings.push(t); return; }
    errors.push('console.error: ' + t);
  });
  page.on('response', res => {
    if (res.status() >= 400 && !ignorableUrl(res.url())) {
      errors.push(`http ${res.status()}: ${res.url()}`);
    }
  });

  try {
    await page.goto(`${server.url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await page.setInputFiles('#file', join(SAMPLES_DIR, file));

    // Wait for either a successful load or an error overlay.
    await page.waitForFunction(() => {
      const r = document.getElementById('reader');
      const t = r?.shadowRoot?.querySelector('.title')?.textContent;
      const ov = r?.shadowRoot?.querySelector('.overlay');
      const errMode = ov && !ov.hidden && ov.classList.contains('error');
      return errMode || (t && t.length > 0);
    }, null, { timeout: 15_000 });

    const state = await page.evaluate(() => {
      const r = document.getElementById('reader');
      const s = r.shadowRoot;
      const ov = s.querySelector('.overlay');
      const isError = ov && !ov.hidden && ov.classList.contains('error');
      return {
        isError,
        errorText: isError ? ov.querySelector('.message')?.textContent : '',
        title: s.querySelector('.title')?.textContent || '',
        progress: s.querySelector('.progress')?.textContent || '',
        spineLength: Number((s.querySelector('.progress')?.textContent || '0 / 0').split(' / ')[1]),
        tocItems: s.querySelectorAll('.toc a').length,
      };
    });

    if (state.isError) {
      return { file, ok: false, error: state.errorText, warnings, ...state };
    }

    // Wait for the first chapter to render in the iframe. Allow either an
    // HTML body with content or an SVG root (svg-in-spine EPUBs).
    await page.waitForFunction(() => {
      const doc = document.getElementById('reader').shadowRoot.querySelector('iframe').contentDocument;
      if (!doc) return false;
      if (doc.body && doc.body.children.length > 0) return true;
      const root = doc.documentElement;
      return root && root.localName === 'svg';
    }, null, { timeout: 10_000 });

    if (errors.length) {
      return { file, ok: false, error: errors[0], warnings, ...state };
    }
    if (!state.spineLength || state.spineLength < 1) {
      return { file, ok: false, error: 'spine is empty', warnings, ...state };
    }
    return { file, ok: true, warnings, ...state };
  } catch (err) {
    return { file, ok: false, error: err.message?.split('\n')[0] || String(err), warnings };
  } finally {
    await ctx.close();
  }
}

function ignorableUrl(url) {
  return /\/favicon\./.test(url) || /unpkg\.com/.test(url);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
