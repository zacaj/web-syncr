import { expect, test } from '@playwright/test';
import { stripsScripts, usesMagicurl, type LoadMode } from '../src/config';
import { stripScripts } from '../src/rewrite';

/**
 * `magicurl-noscript` serves a rendered snapshot with every `<script>` removed.
 * These cover the transform itself and the mode predicates that gate it; the
 * render path that calls them is exercised by magicurl.spec.ts.
 */

test(`stripScripts removes inline and src scripts`, () => {
  const html = `<html><head><script src="/app.js"></script></head>`
    + `<body><h1>Chapter</h1><script>var a = 1;</script><p>text</p></body></html>`;
  const out = stripScripts(html);
  expect(out).not.toContain(`<script`);
  expect(out).not.toContain(`app.js`);
  expect(out).not.toContain(`var a = 1`);
  // Content must survive untouched.
  expect(out).toContain(`<h1>Chapter</h1>`);
  expect(out).toContain(`<p>text</p>`);
});

test(`stripScripts handles attributes, casing and multi-line bodies`, () => {
  const html = `<SCRIPT TYPE="module" defer>\nlet x = 1;\nlet y = 2;\n</SCRIPT>`
    + `<script type="application/json" id="d">{"a":1}</script><p>keep</p>`;
  const out = stripScripts(html);
  expect(out).toBe(`<p>keep</p>`);
});

test(`stripScripts removes the framework payload that corrupts under URL rewriting`, () => {
  // The novelsworld.org failure: a Next.js RSC flight payload embeds
  // byte-length-prefixed rows (`<id>:T<hex-length>,`). Rewriting a hostname
  // inside one lengthens the row without updating its prefix, desyncing the
  // payload and tripping the site's error boundary. Stripping scripts removes
  // the payload entirely, so the rewrite has nothing left to corrupt.
  const html = `<body><article>chapter text</article>`
    + `<script>self.__next_f.push([1,"39:T43f,{\\"host\\":\\"example.org\\"}"])</script></body>`;
  const out = stripScripts(html);
  expect(out).not.toContain(`__next_f`);
  expect(out).not.toContain(`:T43f,`);
  expect(out).toContain(`<article>chapter text</article>`);
});

test(`stripScripts leaves a document with no scripts unchanged`, () => {
  const html = `<body><p>plain</p></body>`;
  expect(stripScripts(html)).toBe(html);
});

test(`stripping runs before injection, so our own script survives`, () => {
  // Ordering property the server relies on: strip the snapshot first, then
  // inject. Reversing it would delete the header mount along with the rest.
  const snapshot = `<body><script src="/site.js"></script><p>text</p></body>`;
  const injected = stripScripts(snapshot)
    .replace(/<body[^>]*>/i, m => m + `<script>/* web-syncr */</script>`);
  expect(injected).toContain(`web-syncr`);
  expect(injected).not.toContain(`site.js`);
});

test(`mode predicates gate magicurl and script stripping correctly`, () => {
  const cases: [LoadMode, boolean, boolean][] = [
    // mode, usesMagicurl, stripsScripts
    [`proxy`, false, false],
    [`magicurl`, true, false],
    [`magicurl-noscript`, true, true],
  ];
  for (const [mode, magic, strip] of cases) {
    expect(usesMagicurl(mode), `usesMagicurl(${mode})`).toBe(magic);
    expect(stripsScripts(mode), `stripsScripts(${mode})`).toBe(strip);
  }
});
