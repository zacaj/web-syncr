/**
 * Thin client + manifest layer for the magicurl headless-browser fetch service.
 *
 * Magicurl saves every fetch to disk under `/data/fetches/<fetchId>/`:
 *   result.json   — manifest mapping URLs → file paths
 *   dom.html      — rendered DOM
 *   assets/<sha>  — captured sub-resources
 *
 * The REST API exposes:
 *   POST /sessions          — create session
 *   GET  /sessions          — list sessions
 *   GET  /sessions/:id      — session detail
 *   POST /sessions/:id/fetch — render a URL
 *   GET  /fetches/:id       — read fetch result manifest
 *   GET  /fetches/:id/dom   — read rendered DOM
 *   GET  /fetches/:id/assets/:name — read an asset
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as Path from 'node:path';
import { env, type LoadMode, sessionConfigPath } from './config';

// ── Type definitions (from magicurl.md) ──────────────────────────────────────

export type Asset = {
  url: string;
  status: number;
  mimeType: string;
  fromCache: boolean;
  headers: Record<string, string>;
  path: string;    // filename within the bundle's assets/ directory
  bytes: number;
};

export type FetchResult = {
  fetchId: string;
  sessionId: string;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  egressIp?: string;

  request: {
    extraHeaders: Record<string, string>;
    cookiesSent: Array<{ name: string; value: string; domain: string }>;
  };
  response: {
    headers: Record<string, string>;
    cookiesAfter: Array<{ name: string; value: string; domain: string }>;
  };

  dom: { path: string; bytes: number };
  assets: Asset[];
  console?: Array<{ type: string; text: string }>;
  bundlePath: string;
};

export type SessionMeta = {
  sessionId: string;
  label?: string;
  createdAt: string;
  lastUsedAt: string;
  currentUrl?: string;
};

/** Extended session config that stores both load mode and magicurl session ID */
export type SessionConfig = {
  mode?: LoadMode;
  magicSessionId?: string;
  lastFetchId?: string;
  _lastUrl?: string;
};

// ── Session config helpers ──────────────────────────────────────────────────

function readSessionConfig(sessionId: string): SessionConfig {
  const path = sessionConfigPath(sessionId);
  if (!existsSync(path)) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return JSON.parse(readFileSync(path, `utf8`)) as SessionConfig;
  } catch {
    return {};
  }
}

function writeSessionConfig(sessionId: string, cfg: SessionConfig): void {
  const path = sessionConfigPath(sessionId);
  mkdirSync(Path.dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg));
}

// ── Magicurl REST client ────────────────────────────────────────────────────

const API = env.magicurlApi || `http://localhost:3005`;

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`magicurl GET ${path}: ${res.status} ${res.statusText}`);
  return res.json() as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`magicurl POST ${path}: ${res.status} ${res.statusText}`);
  return res.json() as T;
}

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Ensure a magicurl session exists for this web-syncr session.
 * Reads the magicSessionId from the session config; if absent, creates one via POST /sessions.
 * Returns the magicurl session ID.
 */
export async function ensureSession(webSessionId: string): Promise<string> {
  const cfg = readSessionConfig(webSessionId);
  if (cfg.magicSessionId) return cfg.magicSessionId;

  // Create a new magicurl session
  const meta = await apiPost<SessionMeta>(`/sessions`, { label: webSessionId });
  const updated = { ...cfg, magicSessionId: meta.sessionId };
  writeSessionConfig(webSessionId, updated);
  return meta.sessionId;
}

/**
 * Render a page through magicurl. Reuses cached fetchId when !force.
 * Returns a FetchResult (which also serves as the manifest handle).
 */
export async function renderPage(
  webSessionId: string,
  realUrl: string,
  { force = false }: { force?: boolean } = {},
): Promise<FetchResult> {
  const magicSessionId = await ensureSession(webSessionId);
  const cfg = readSessionConfig(webSessionId);

  // Reuse cached fetchId if not forcing a re-render
  if (!force && cfg.lastFetchId && cfg._lastUrl === realUrl) {
    const cached = await apiGet<FetchResult>(`/fetches/${cfg.lastFetchId}`);
    return cached;
  }

  // Issue a new fetch
  const result = await apiPost<FetchResult>(`/sessions/${magicSessionId}/fetch`, {
    url: realUrl,
    wait: { until: `domcontentloaded` as const, timeoutMs: 3000, settleMs: 500 },
    captureAssets: true,
    rotateOnBlock: true,
  });

  // Cache the fetchId for potential reuse
  const updated = { ...cfg, lastFetchId: result.fetchId, _lastUrl: realUrl };
  writeSessionConfig(webSessionId, updated);
  return result;
}

/**
 * Read the fetch manifest (result.json) from the mounted disk.
 * Falls back to the REST API if the mount path is not visible.
 */
export async function loadManifest(fetchId: string): Promise<FetchResult> {
  const mountPath = Path.join(env.magicurlMount || `/magicurl-data`, fetchId, `result.json`);
  try {
    if (existsSync(mountPath) && statSync(mountPath).size > 0) {
      return JSON.parse(readFileSync(mountPath, `utf8`)) as FetchResult;
    }
  } catch {
    // fall through to API fallback
  }
  // REST API fallback
  return await apiGet<FetchResult>(`/fetches/${fetchId}`);
}

/**
 * Read the rendered DOM HTML for a fetch from the mounted disk.
 */
export async function getDomHtml(fetchId: string): Promise<string> {
  const domPath = Path.join(env.magicurlMount || `/magicurl-data`, fetchId, `dom.html`);
  try {
    if (existsSync(domPath)) {
      return readFileSync(domPath, `utf8`);
    }
  } catch {
    // fall through to API fallback
  }
  // REST API fallback (DOM endpoint returns raw HTML, not JSON)
  const res = await fetch(`${API}/fetches/${fetchId}/dom`);
  if (!res.ok) throw new Error(`magicurl GET /fetches/${fetchId}/dom: ${res.status} ${res.statusText}`);
  return await res.text();
}

/**
 * Build (and cache) a map of realUrl → { absPath, mimeType } from the manifests
 * of all known fetchIds for a session.
 */
interface AssetHit {
  absPath: string;
  mimeType: string;
}

const manifestCache = new Map<string, Map<string, AssetHit>>();

function buildUrlMap(fetchResult: FetchResult): Map<string, AssetHit> {
  const urlMap = new Map<string, AssetHit>();
  const bundleBase = Path.join(env.magicurlMount || `/magicurl-data`, fetchResult.fetchId);

  for (const asset of fetchResult.assets) {
    const absPath = Path.join(bundleBase, `assets`, asset.path);
    urlMap.set(asset.url, { absPath, mimeType: asset.mimeType });
  }

  return urlMap;
}

/**
 * Look up a realUrl in the session's known fetch manifests.
 * Returns { absPath, mimeType } on hit, null on miss.
 */
export async function lookupAsset(
  webSessionId: string,
  realUrl: string,
): Promise<AssetHit | null> {
  const cfg = readSessionConfig(webSessionId);
  const fetchId = cfg.lastFetchId;
  if (!fetchId) return null;

  // Check cache first
  const sessionKey = webSessionId;
  let urlMap = manifestCache.get(sessionKey);
  if (!urlMap) {
    const result = await loadManifest(fetchId);
    urlMap = buildUrlMap(result);
    manifestCache.set(sessionKey, urlMap);
  }

  // Try exact match
  const hit = urlMap.get(realUrl);
  if (hit) return hit;

  // Try stripping trailing slash for directory-index URLs
  const normalized = realUrl.replace(/\/$/, ``);
  const hit2 = urlMap.get(normalized);
  if (hit2) return hit2;

  return null;
}

/**
 * Stream a file from the magicurl mount with proper content-type.
 * Returns { stream, mimeType, contentLength } or null if file not found.
 */
export function streamAsset(absPath: string): {
  stream: ReadableStream<Uint8Array>;
  mimeType: string;
  contentLength: number;
} | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;

    const nodeStream = createReadStream(absPath);
    const mimeType = guessMimeType(absPath);
    // Convert Node.js ReadStream to web ReadableStream
    const stream = nodeStream[Symbol.asyncIterator]
      ? fromNodeReadableStream(nodeStream)
      : new ReadableStream({
        start(controller) {
          nodeStream.on(`data`, (chunk: string | Buffer) => controller.enqueue(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : Buffer.from(chunk)));
          nodeStream.on(`end`, () => controller.close());
          nodeStream.on(`error`, (err: Error) => controller.error(err));
        },
      });
    return { stream, mimeType, contentLength: st.size };
  } catch {
    return null;
  }
}

/** Convert a Node.js ReadStream to a web ReadableStream */
function fromNodeReadableStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on(`data`, (chunk: string | Buffer) => controller.enqueue(Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : Buffer.from(chunk)));
      nodeStream.on(`end`, () => controller.close());
      nodeStream.on(`error`, (err: Error) => controller.error(err));
    },
  });
}

/** Simple MIME type guesser based on file extension */
function guessMimeType(filePath: string): string {
  const ext = Path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': `text/html`,
    '.htm': `text/html`,
    '.css': `text/css`,
    '.js': `application/javascript`,
    '.json': `application/json`,
    '.png': `image/png`,
    '.jpg': `image/jpeg`,
    '.jpeg': `image/jpeg`,
    '.gif': `image/gif`,
    '.svg': `image/svg+xml`,
    '.woff': `font/woff`,
    '.woff2': `font/woff2`,
    '.ttf': `font/ttf`,
    '.otf': `font/otf`,
    '.eot': `application/vnd.ms-fontobject`,
    '.webp': `image/webp`,
    '.ico': `image/x-icon`,
    '.pdf': `application/pdf`,
    '.txt': `text/plain`,
    '.xml': `application/xml`,
    '.webmanifest': `application/manifest+json`,
    '.mp4': `video/mp4`,
    '.webm': `video/webm`,
    '.mp3': `audio/mpeg`,
    '.wav': `audio/wav`,
  };
  return map[ext] ?? `application/octet-stream`;
}
