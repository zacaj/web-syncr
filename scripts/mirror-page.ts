#!/usr/bin/env node
/**
 * Mirrors a web page's HTML to tests/fixtures/ for use in local proxy tests.
 *
 * Usage: npx tsx scripts/mirror-page.ts <url>
 *
 * Produces two files:
 *   tests/fixtures/{host}/{path}.html        — raw HTML from the site
 *   tests/fixtures/{host}/{path}.local.html  — HTML with hostname replaced by
 *                                              "localhost", so the proxy's URL
 *                                              rewriter has something to act on
 *
 * The mock test server serves the .local.html variant at:
 *   /fixtures/{host}/{path}
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl) {
    console.error(`Usage: npx tsx scripts/mirror-page.ts <url>`);
    process.exit(1);
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.error(`Invalid URL: ${rawUrl}`);
    process.exit(1);
  }

  if (url.protocol !== `https:` && url.protocol !== `http:`) {
    console.error(`URL must be http or https`);
    process.exit(1);
  }

  console.log(`Fetching ${url.href} ...`);

  let response: Response;
  try {
    response = await fetch(url.href, {
      redirect: `follow`,
      headers: {
        'User-Agent': `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
        'Accept': `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
        'Accept-Language': `en-US,en;q=0.5`,
      },
    });
  } catch (e) {
    console.error(`Fetch failed: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`HTTP ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const contentType = response.headers.get(`content-type`) ?? ``;
  if (!contentType.includes(`text/html`)) {
    console.error(`Expected text/html, got: ${contentType}`);
    process.exit(1);
  }

  const html = await response.text();

  // Compute fixture path from hostname + pathname
  const sanitizedHost = url.hostname.replaceAll(`.`, `_`);
  let pathPart = url.pathname;
  // If no file extension or trailing slash → treat as directory → index.html
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathPart);
  if (!hasExtension) {
    pathPart = pathPart.replace(/\/?$/, `/index`);
  }
  const relPath = `${sanitizedHost}${pathPart}`;
  const rawFile = join(process.cwd(), `tests/fixtures`, `${relPath}.html`);
  const localFile = join(process.cwd(), `tests/fixtures`, `${relPath}.local.html`);

  // Replace hostname occurrences so the proxy's rewriter has localhost refs to act on
  const localHtml = html.replaceAll(url.hostname, `localhost`);

  mkdirSync(dirname(rawFile), { recursive: true });
  writeFileSync(rawFile, html, `utf8`);
  writeFileSync(localFile, localHtml, `utf8`);

  const fixturePath = `/fixtures/${relPath}`;
  console.log(`\nSaved:`);
  console.log(`  Raw:   tests/fixtures/${relPath}.html`);
  console.log(`  Local: tests/fixtures/${relPath}.local.html`);
  console.log(`\nMock server path:  ${fixturePath}`);
  console.log(`Suggested test URL: http://localhost${fixturePath}`);
}

main();
