import { expect, test } from '@playwright/test';
import { jsonDate } from '@zacaj/util';
import { injectHeaderAndScript, replaceAllPatterns } from '../src/rewrite';

// These are pure-function unit tests (no browser / no server). They guard the
// URL-rewrite pass — the single biggest CPU-bound loop in the request path — for
// both correctness and, crucially, for *termination and speed* on large inputs.
// A pathological blow-up here blocks the single event-loop thread and takes the
// whole server down (see the 2026-07-23 timeout incident).

test(`replaceAllPatterns replaces every occurrence of every key`, () => {
  const out = replaceAllPatterns(`a.com x a.com y a.com`, { 'a.com': `WRAP` });
  expect(out).toBe(`WRAP x WRAP y WRAP`);
});

test(`replaceAllPatterns returns null when nothing matches`, () => {
  expect(replaceAllPatterns(`nothing here`, { 'a.com': `WRAP` })).toBeNull();
});

test(`replaceAllPatterns picks the nearest match across multiple keys`, () => {
  // Two keys, interleaved; the nearest one at each cursor must win.
  const out = replaceAllPatterns(`__enc__ raw raw __enc__`, {
    'raw': `R`,
    '__enc__': `E`,
  });
  expect(out).toBe(`E R R E`);
});

test(`replaceAllPatterns does not re-match text it just inserted`, () => {
  // The replacement value CONTAINS the search key (as happens when the public
  // host is "localhost" and the base URL is "localhost"). This must terminate and
  // must not recursively rewrite the inserted text.
  const out = replaceAllPatterns(`go to localhost now`, {
    'localhost': `sn1__localhost__.localhost:29443`,
  });
  expect(out).toBe(`go to sn1__localhost__.localhost:29443 now`);
});

test(`replaceAllPatterns ignores empty keys instead of looping forever`, () => {
  // An empty key matches at every index and would never advance the cursor. It
  // must be ignored, not spin.
  const out = replaceAllPatterns(`a.com here`, { '': `X`, 'a.com': `WRAP` });
  expect(out).toBe(`WRAP here`);
});

test(`replaceAllPatterns stays fast on a large body with many matches`, () => {
  // ~2 MB body with tens of thousands of matches of one key, PLUS a second key
  // that only ever matches once near the start. The old O(n·M) implementation
  // rebuilt the whole string on every match AND re-scanned the non-matching key
  // to end-of-string every iteration — quadratic, and the classic wedge. The
  // hardened version must finish this near-instantly.
  const unit = `<a href="https://base.example/page">link</a> filler text; `;
  const body = `RAREKEY ` + unit.repeat(40_000); // ~2.3 MB, ~40k matches of base.example
  const start = Date.now();
  const out = replaceAllPatterns(body, {
    'base.example': `sn9__base_example__.host`,
    'RAREKEY': `Q`, // matches exactly once, up front
  });
  const elapsedMs = Date.now() - start;

  expect(out).not.toBeNull();
  expect(out!.startsWith(`Q `)).toBe(true);
  expect(out).not.toContain(`base.example`);
  expect(out).toContain(`sn9__base_example__.host`);
  // Generous ceiling: this is ~O(n) work and completes in well under a second in
  // practice. If this ever blows past a couple of seconds, a quadratic regression
  // has crept back in.
  expect(elapsedMs).toBeLessThan(3_000);
});

test(`injectHeaderAndScript does not corrupt injected.js when the page's own <body> tag is captured by "$1"`, async () => {
  // Regression for a real-world break: the injected script's own source contains
  // the literal text "$1_$2" (injected.js's dot-escaping regex replacement). The
  // old implementation passed a STRING starting with "$1" to body.replace(), which
  // makes $1/$2/$&/$`/$' backreference tokens rather than literal text — so "$1"
  // inside injectedJs's own source silently got swapped for the page's real <body
  // ...> tag (this exact shape, lots of quoted attributes, is what a live WordPress/
  // Fictioneer site served), splicing page HTML into the middle of the script and
  // breaking history-dropdown navigation (wrapAndNavigate's realUrlToWrapped).
  const injectedJs = `function f(baseUrl) { return baseUrl.replaceAll(/([^.])\\.([^.])/g, \`$1_$2\`); }`;
  const body = `<html><head></head><body class="wp-singular" data-story-id="34544" `
    + `data-action="click->fictioneer#bodyClick">CONTENT</body></html>`;

  const out = await injectHeaderAndScript(
    body,
    { sessionId: `sn1`, url: `https://example.com/`, timestamp: jsonDate() },
    [],
    injectedJs,
  );

  // The script's own source must survive byte-for-byte — no page HTML spliced in.
  expect(out).toContain(injectedJs);
  // The page's original body tag must appear exactly once, untouched, immediately
  // followed by the injected script (not split apart by a bogus $-substitution).
  const originalBodyTag = `<body class="wp-singular" data-story-id="34544" data-action="click->fictioneer#bodyClick">`;
  expect(out.split(originalBodyTag)).toHaveLength(2);
  expect(out).toContain(`${originalBodyTag}<script>`);
  expect(out).toContain(`CONTENT`);
});
