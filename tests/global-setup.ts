import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { expect, type Page } from '@playwright/test';
import { join } from 'node:path';

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

function readDotEnv(path: string): Record<string, string> {
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

function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
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
  const mockMagicUrlServer = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    // POST /sessions — create a magicurl session
    if (url.pathname === `/sessions` && req.method === `POST`) {
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify({ sessionId: MOCK_MAGIC_SESSION_ID }));
      return;
    }

    // POST /sessions/:id/fetch — trigger a fetch, return challenge result
    if (url.pathname === `/sessions/${MOCK_MAGIC_SESSION_ID}/fetch` && req.method === `POST`) {
      res.writeHead(200, { 'Content-Type': `application/json` });
      res.end(JSON.stringify({
        fetchId: MOCK_MAGICURL_FETCH_ID,
        sessionId: MOCK_MAGIC_SESSION_ID,
        requestedUrl: `http://localhost/page2`,
        finalUrl: `http://localhost/page2`,
        status: 200,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 5000,
        challengePending: true,
        challengeName: `cloudflare`,
        vnc: `vnc.html?token=abc123`,
        dom: { path: `dom.html`, bytes: 0 },
        assets: [],
        bundlePath: `/data/fetches/${MOCK_MAGICURL_FETCH_ID}`,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': `application/json` });
    res.end(JSON.stringify({ error: `not found` }));
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
