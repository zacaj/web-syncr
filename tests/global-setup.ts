import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

export const PID_FILE = `/tmp/web-syncr-test-server.pid`;
export const DB_TEST_PATH = `/tmp/web-syncr-test-db`;
export const TEST_PORT = 29443;
export const MOCK_PORT = 38080;

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
};

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

  // Start the web-syncr server with test config
  const baseEnv = readDotEnv(`./.env`);
  const env = {
    ...process.env,
    ...baseEnv,
    localPort: String(TEST_PORT),
    publicPort: String(TEST_PORT),
    publicHost: `localhost:${TEST_PORT}`,
    proxyPort: String(MOCK_PORT),
    proxyProtocol: `http`,
    dbPath: DB_TEST_PATH,
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
