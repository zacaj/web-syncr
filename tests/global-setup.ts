import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { expect, type Page } from '@playwright/test';
import { join } from 'node:path';

import type { Anchor } from '../src/config';

/** The subset of `src/anchor.js`'s window API the tests drive. */
export type AnchorHit = { el: Element; fraction: number; via: string; candidate: number };
export type AnchorApi = {
  scan: () => { x: number; container: Element | null };
  capture: () => Anchor;
  resolve: (a: Anchor) => AnchorHit | null;
  settleTo: (a: Anchor, opts?: { budgetMs?: number }) => Promise<AnchorHit | null>;
  readingLineY: () => number;
  headerHeight: () => number;
};
declare global {
  interface Window {
    __webSyncrAnchor: AnchorApi;
    /** Defined by `src/injected.js`'s sync client. */
    webSyncrJump: () => void;
    /** Defined by the `/late-shift` mock fixture. */
    __insertShift: () => void;
  }
}

export const PID_FILE = `/tmp/web-syncr-test-server.pid`;
export const DB_TEST_PATH = `/tmp/web-syncr-test-db`;
export const TEST_PORT = 29443;
export const MOCK_PORT = 38080;
export const MOCK_MAGICURL_PORT = 38081;

export const MOCK_PAGES: Record<string, { title: string; html: string }> = {
  '/': {
    title: `Mock Home`,
    html: `<html><head><title>Mock Home</title></head><body>
      <h1>Hello from mock</h1>
      <a href="/page2">Go to page 2</a>
    </body></html>`,
  },
  '/page2': {
    title: `Mock Page 2`,
    html: `<html><head><title>Mock Page 2</title></head><body>
      <h1>Mock Page 2</h1>
      <a href="/">Back home</a>
    </body></html>`,
  },
  '/with-link': {
    title: `With Absolute Link`,
    html: `<html><head><title>With Absolute Link</title></head><body>
      <h1>With Absolute Link</h1>
      <a id="abs" href="http://localhost/page2">absolute link</a>
    </body></html>`,
  },
  // Exercises the anchor column scan. Deliberately contains both kinds of
  // decoy the scan must reject:
  //   - `.rail`: a NON-semantic sidebar. No nav/aside tag to key off, so only
  //     the text-volume score can reject it (a hit-count score would pick it,
  //     since it lands 9 short items to the article's ~4 paragraphs).
  //   - `.banner`: position:sticky, which sits at the same viewport coordinate
  //     at every scroll offset and would otherwise anchor you to nowhere.
  '/long-article': {
    title: `Long Article`,
    html: `<html><head><title>Long Article</title><style>
      body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
      .banner { position: sticky; top: 0; background: #cdf; padding: 0.5rem; }
      .wrap { display: flex; gap: 2rem; }
      .rail { width: 180px; flex: none; padding: 1rem; background: #eee; }
      .rail div { padding: 0.4rem 0; }
      article { flex: 1; max-width: 42rem; padding: 1rem; }
      p { margin: 0 0 1.4rem; }
    </style></head><body>
      <div class="banner">Sticky banner</div>
      <div class="wrap">
        <div class="rail">RAIL_ITEMS</div>
        <article id="article">
          <h1>Long Article</h1>
          ARTICLE_PARAS
        </article>
      </div>
      <footer>Footer text</footer>
    </body></html>`
      .replace(`RAIL_ITEMS`, Array.from({ length: 30 }, (_, i) => `<div>Rail item ${i}</div>`).join(``))
      .replace(`ARTICLE_PARAS`, Array.from({ length: 60 }, (_, i) =>
        `<p id="para-${i}">Paragraph ${i}. ${`Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. `.repeat(3)}</p>`).join(``)),
  },
  // Content that grows *above* the reading position mid-restore — the exact
  // failure mode settleTo's convergence loop exists for. The insertion is
  // exposed as a function rather than a timer so the test can trigger it at a
  // controlled moment; a timer races Playwright's evaluate round-trip and the
  // shift lands before the restore even starts, making the test vacuous.
  '/late-shift': {
    title: `Late Shift`,
    html: `<html><head><title>Late Shift</title><style>
      /* Chrome's native scroll anchoring would otherwise absorb the insertion
         and the test would be measuring the browser, not our convergence loop.
         Plenty of real sites disable it for exactly this kind of jumpiness. */
      body { margin: 0; font: 16px/1.5 system-ui, sans-serif; overflow-anchor: none; }
      article { max-width: 42rem; padding: 1rem; }
      p { margin: 0 0 1.4rem; }
      .shift { height: 400px; background: #fdd; }
    </style></head><body>
      <article id="article">
        <div id="shift-host"></div>
        ARTICLE_PARAS
      </article>
      <script>
        window.__insertShift = function() {
          var d = document.createElement('div');
          d.className = 'shift';
          d.textContent = 'Late-loading block';
          document.getElementById('shift-host').appendChild(d);
        };
      </script>
    </body></html>`
      .replace(`ARTICLE_PARAS`, Array.from({ length: 60 }, (_, i) =>
        `<p id="lp-${i}">Late paragraph ${i}. ${`Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium totam rem aperiam. `.repeat(3)}</p>`).join(``)),
  },
  '/with-csp': {
    title: `With CSP`,
    html: `<html><head><meta http-equiv="Content-Security-Policy" content="script-src-attr 'none'"><title>With CSP</title></head><body>
      <h1>CSP Page</h1>
    </body></html>`,
  },
  '/with-special-attrs': {
    title: `Special Attrs`,
    html: `<html><head><title>With Special Attrs</title></head><body data-action="click->test" class="test" data-value="a>b">
      <h1>Page with Special Attrs</h1>
      <p>Body tag has attributes with special chars like > in values</p>
    </body></html>`,
  },
};

// ── Shared test helpers ──────────────────────────────────────────────────────

/**
 * Navigate to the web-syncr home page and create a new session by filling
 * the URL form. Resolves when the page has navigated to the wrapped subdomain.
 *
 * @param originUrl — the URL to proxy (e.g. `http://localhost/page2` or `https://example.com`)
 * @param wrappedRe — expected wrapped URL pattern (defaults to the `localhost` fixture pattern)
 */
export async function createSession(
  page: Page,
  originUrl = `http://localhost/`,
  wrappedRe: RegExp = new RegExp(
    `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
  ),
): Promise<void> {
  await page.goto(`/`);
  await page.fill(`input[type="url"][name="url"]`, originUrl);
  // The home form now defaults sync to `live`; most callers here spin up
  // independent browser contexts against the same session and don't expect
  // one to auto-follow the other's navigation, so pin it back to `off`
  // unless a test opts in explicitly via the session-mode endpoint.
  await page.selectOption(`form[action="/"] select[name="syncMode"]`, `off`);
  await Promise.all([
    page.waitForURL(wrappedRe),
    page.locator(`form[action="/"] button[type="submit"]`).first().click(),
  ]);
}

/**
 * Extract the session ID from the current page URL.
 */
export function extractSessionId(url: string): string | undefined {
  return url.match(/^https:\/\/([a-z0-9]+)__/)?.[1];
}

/**
 * Assert that the session header bar is present and visible.
 */
export async function assertHeaderPresent(page: Page): Promise<void> {
  await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();
}

/**
 * Assert that the body contains the given text, waiting up to the default timeout.
 * Useful for JS-heavy SPA sites where the content may not be immediately visible.
 */
export async function assertPageContent(page: Page, text: string, timeout?: number): Promise<void> {
  await expect(page.locator(`body`)).toContainText(text, timeout ? { timeout } : undefined);
}

/**
 * Detect whether the page is a Cloudflare (or other) bot-challenge interstitial.
 *
 * Checks:
 *   1. `x-magicurl-challenge` header on the magicurl response (server-side signal)
 *   2. Page HTML for Cloudflare challenge indicators (page-level signal)
 *
 * @returns true if a challenge was detected.
 */
export async function checkForChallenge(
  page: Page,
  response: any,
  siteUrl: string,
): Promise<boolean> {
  const html = await page.content();

  // 1. Check the magicurl challenge header
  const headers = response?.headers ?? response;
  const challenge = headers?.['x-magicurl-challenge'] ?? headers?.get?.('x-magicurl-challenge');
  if (challenge) {
    const status = typeof response?.status === 'function' ? response.status() : response?.status;
    console.warn(
      `magicurl hit a ${challenge} challenge for ${siteUrl} — `
      + `the page was an unresolvable bot-challenge interstitial (HTTP ${status}). `
      + `This usually means an interactive captcha or an egress IP the site hard-challenges.`,
    );
    return true;
  }

  // 2. Check the page HTML for Cloudflare challenge indicators.
  // Use specific patterns only — avoid broad terms like /Cloudflare/i that match
  // legitimate pages that mention Cloudflare in footer/content.
  const cloudflarePatterns = [
    /<title>[^<]*just a moment/i,          // classic CF challenge title
    /challenges\.cloudflare\.com/i,         // CF challenge CDN script
    /cf_chl_opt/i,                          // CF challenge JS config object
    /cf_chl_f_tk/i,                         // CF challenge token field
    /cf-mitigated/i,                        // CF mitigation meta/header
    /var cf\.challenge/i,                   // older CF challenge JS
  ];

  for (const pattern of cloudflarePatterns) {
    if (html.match(pattern)) {
      console.warn(
        `Detected Cloudflare challenge on ${siteUrl} — the page appears to be a bot-challenge interstitial. `
        + `Check that the site is reachable and that egress IPs are not flagged.`,
      );
      return true;
    }
  }

  return false;
}

export function readDotEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, `utf8`)
        .split(`\n`)
        .filter(l => !!l.trim() && !l.startsWith(`#`))
        .map(l => l.split(`=`, 2) as [string, string]),
    );
  } catch {
    return {};
  }
}

export function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = https.get(url, { rejectUnauthorized: false }, () => resolve());
      req.on(`error`, () => {
        if (Date.now() > deadline) return reject(new Error(`Server ${url} did not start`));
        setTimeout(attempt, 300);
      });
      req.setTimeout(1000, () => req.destroy());
    }
    attempt();
  });
}

export default async function globalSetup() {
  // Fresh isolated db directory for this test run
  rmSync(DB_TEST_PATH, { recursive: true, force: true });
  mkdirSync(DB_TEST_PATH, { recursive: true });

  // Start mock HTTP server that serves controlled test fixtures
  const FIXTURE_PREFIX = `/fixtures/`;
  const mockServer = http.createServer((req, res) => {
    const pathname = new URL(req.url!, `http://localhost`).pathname;

    if (pathname === `/redirect-to-page2`) {
      res.writeHead(301, { 'Location': `http://localhost/page2` });
      res.end();
      return;
    }

    // A rewritable (CSS) asset whose body contains NO occurrence of the proxied
    // base URL ("localhost"), so the link-rewrite pass makes no change. This is
    // the exact shape that used to fall through the handler without returning a
    // Response → Hono "Context is not finalized" 500. See asset-fallback.spec.ts.
    if (pathname === `/no-host.css`) {
      res.writeHead(200, { 'Content-Type': `text/css` });
      res.end(`.hero{color:red;background:url(/img/bg.png)}`);
      return;
    }
    // Same shape for JavaScript.
    if (pathname === `/no-host.js`) {
      res.writeHead(200, { 'Content-Type': `application/javascript` });
      res.end(`console.log("no base url here at all");`);
      return;
    }

    if (pathname.startsWith(FIXTURE_PREFIX)) {
      const rel = pathname.slice(FIXTURE_PREFIX.length);
      const fsPath = join(process.cwd(), `tests/fixtures`, `${rel}.local.html`);
      try {
        const html = readFileSync(fsPath, `utf8`);
        res.writeHead(200, { 'Content-Type': `text/html` });
        res.end(html);
        return;
      } catch {
        // fall through to 404
      }
    }

    const page = MOCK_PAGES[pathname];
    if (page) {
      res.writeHead(200, { 'Content-Type': `text/html` });
      res.end(page.html);
    } else {
      res.writeHead(404, { 'Content-Type': `text/html` });
      res.end(`<html><body>Not found: ${pathname}</body></html>`);
    }
  });
  await new Promise<void>(r => mockServer.listen(MOCK_PORT, r));
  (globalThis as Record<string, unknown>).__mockServer = mockServer;

  // Mock magicurl API — returns challenge responses for testing challenge page rendering
  const MOCK_MAGICURL_FETCH_ID = `challenge_fetch`;
  const MOCK_MAGIC_SESSION_ID = `magic-challenge`;
  const MOCK_SOLVED_FETCH_ID = `solved_fetch`;
  const mockMagicurl = { solved: false, renders: 0, lastUpgrade: `` };
  const mockFetches = new Map<string, unknown>();
  const mockMagicUrlServer = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    // POST /sessions — create a magicurl session
    if (url.pathname === `/sessions` && req.method === `POST`) {
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify({ sessionId: MOCK_MAGIC_SESSION_ID }));
      return;
    }

    // Test controls: `solve` flips the challenge to solved (as a human in VNC
    // would), `reset` restores it; `state` reports how many renders ran.
    if (url.pathname === `/__mock/solve` || url.pathname === `/__mock/reset`) {
      mockMagicurl.solved = url.pathname === `/__mock/solve`;
      if (!mockMagicurl.solved) { mockMagicurl.renders = 0; mockMagicurl.lastUpgrade = `` }
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify(mockMagicurl));
      return;
    }
    if (url.pathname === `/__mock/state`) {
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify(mockMagicurl));
      return;
    }

    // POST /sessions/:id/fetch — trigger a fetch: a pending challenge until
    // solved, then the real page. Like real magicurl, each result is stored
    // once and never updated.
    if (url.pathname === `/sessions/${MOCK_MAGIC_SESSION_ID}/fetch` && req.method === `POST`) {
      mockMagicurl.renders++;
      const fetchId = mockMagicurl.solved ? MOCK_SOLVED_FETCH_ID : MOCK_MAGICURL_FETCH_ID;
      const result = {
        fetchId,
        sessionId: MOCK_MAGIC_SESSION_ID,
        requestedUrl: `http://localhost/page2`,
        finalUrl: `http://localhost/page2`,
        status: 200,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 5000,
        ...mockMagicurl.solved ? {} : {
          challengePending: true,
          challengeName: `cloudflare`,
          vnc: `http://localhost:${MOCK_MAGICURL_PORT}/vnc.html?token=abc123`,
        },
        dom: { path: `dom.html`, bytes: 0 },
        assets: [],
        bundlePath: `/data/fetches/${fetchId}`,
      };
      mockFetches.set(fetchId, result);
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify(result));
      return;
    }

    // Stand-in for noVNC's static client (proxied by web-syncr under /__vnc/<token>/).
    if (url.pathname === `/vnc.html`) {
      res.writeHead(200, { 'Content-Type': `text/html` });
      res.end(`<html><head><title>noVNC</title></head><body><p id="novnc">mock novnc</p></body></html>`);
      return;
    }

    const fetchMatch = /^\/fetches\/([^/]+)(\/dom)?$/.exec(url.pathname);
    const stored = fetchMatch && mockFetches.get(fetchMatch[1]!);
    if (stored) {
      if (fetchMatch[2]) {
        res.writeHead(200, { 'Content-Type': `text/html` });
        res.end(`<html><head><title>Solved page</title></head><body><p id="solved">real content</p></body></html>`);
      }
      else {
        res.writeHead(200, { 'Content-Type': `application/json` });
        res.end(JSON.stringify(stored));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': `application/json` });
    res.end(JSON.stringify({ error: `not found` }));
  });
  // Stand-in for websockify: accept the handshake, send one text frame. Records
  // the path and Host it saw so tests can check the proxy re-pathed the request.
  mockMagicUrlServer.on(`upgrade`, (req, socket) => {
    mockMagicurl.lastUpgrade = `${req.headers.host} ${req.url}`;
    if (req.url !== `/websockify`) {
      socket.end(`HTTP/1.1 404 Not Found\r\n\r\n`);
      return;
    }
    const accept = createHash(`sha1`).update(`${req.headers[`sec-websocket-key`]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest(`base64`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 5, ...Buffer.from(`hello`)]));
    socket.on(`error`, () => {});
  });
  await new Promise<void>(r => mockMagicUrlServer.listen(MOCK_MAGICURL_PORT, r));
  (globalThis as Record<string, unknown>).__mockMagicUrlServer = mockMagicUrlServer;

  // Start the web-syncr server with test config
  const baseEnv = readDotEnv(`./.env`);
  const magicurlUrl = process.env.LIVE_MAGICURL;
  const isLive = process.env.LIVE_TESTS || magicurlUrl;
  const env = {
    ...process.env,
    ...baseEnv,
    localPort: String(TEST_PORT),
    publicPort: String(TEST_PORT),
    publicHost: `localhost:${TEST_PORT}`,
    ...(!isLive ? { proxyPort: String(MOCK_PORT), proxyProtocol: `http` } : {}),
    dbPath: DB_TEST_PATH,
    // Disable the event-loop watchdog under test: nothing here wedges the loop,
    // and a stray SIGKILL would surface as a baffling "server disconnected".
    watchdogMs: `0`,
    ...(magicurlUrl && magicurlUrl !== `1` ? { magicurlApi: magicurlUrl } : {}),
    ...(!isLive ? { magicurlApi: `http://localhost:${MOCK_MAGICURL_PORT}` } : {}),
  };

  const proc = spawn(`node_modules/.bin/tsx`, [`src/server`], {
    env,
    stdio: `pipe`,
    cwd: process.cwd(),
  });

  proc.stderr.on(`data`, (d: Buffer) => process.stderr.write(d));
  proc.on(`error`, err => { throw err });
  writeFileSync(PID_FILE, String(proc.pid));

  await waitForServer(`https://localhost:${TEST_PORT}`);
  console.log(`\nTest server started on port ${TEST_PORT} (pid ${proc.pid}), mock on ${MOCK_PORT}`);
}
