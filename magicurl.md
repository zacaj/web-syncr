# magicurl

**Stateful, stealthy headless-browser fetch service.** Give it a URL, it drives a real browser to load the page, then returns the rendered DOM, all loaded assets, and full request/response metadata. Sessions persist like open browser tabs.

## What It Does

`magicurl` is a "curl for Single-Page Apps" — it solves the problem that `curl` can't handle JavaScript-heavy sites. You send it a URL, and it:

- **Renders the page** using a real Camoufox (Firefox) browser instance
- **Captures everything**: the final DOM, every loaded asset (JS, CSS, images, fonts, XHR), and metadata
- **Maintains state** across requests within a session (cookies, localStorage, auth state), just like keeping browser tabs open
- **Survives restarts** by checkpointing session state to disk — including the browser fingerprint, so rehydrated sessions retain their identity across server restarts
- **Passes fingerprinting checks** using Camoufox, an anti-detect Firefox variant; fingerprints are persisted to disk keyed by egress IP so VPN rotations don't trigger new challenges
- **Shares Cloudflare clearance tokens** across sessions — once one session solves a CF challenge for a domain, all sessions on the same IP automatically reuse the token
- **Pins VPN server** on restart — remembers the last connected server and reconnects to it, avoiding unnecessary IP changes
- **Rotates VPN exits** on demand when blocked, with an optional auto-rotate hook that can reuse existing CF tokens by rotating back to the bound IP
- **Enables human-in-the-loop debugging** via VNC for captchas and manual inspection — on challenge, returns `challengePending` + VNC link and keeps the page alive

Perfect for web scraping, automated testing, content capture, and any scenario where you need a real browser's rendering engine instead of parsing static HTML.

## Quick Start

### One-Off Fetch
```bash
docker run --rm \
  --env-file .env \
  -v $PWD/out:/data/fetches \
  magicurl fetch \
    --url https://example.com \
    --wait-selector .results
```

### Persistent Server
```bash
docker run -d \
  --env-file .env \
  -p 3000:3000 \
  -p 6080:6080 \
  magicurl
```

Then call the REST API:
```bash
# Create a session
curl -X POST http://localhost:3000/sessions

# Fetch a URL in that session
curl -X POST http://localhost:3000/sessions/uuid/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "wait": { "selector": ".results", "timeoutMs": 30000 }
  }'
```

---

## Usage Examples

### Scrape a JavaScript-Rendered Page

Fetch the fully rendered DOM of a React/Vue/Angular SPA, waiting for the main content to appear:

```bash
SESSION=$(curl -s -X POST http://localhost:3000/sessions | jq -r .sessionId)

curl -X POST http://localhost:3000/sessions/$SESSION/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://news.ycombinator.com",
    "wait": { "selector": ".itemlist", "timeoutMs": 15000 }
  }'
```

### Multi-Step Login Flow

Use a persistent session so cookies from the login page carry forward to subsequent requests:

```bash
# 1. Create a named session
SESSION=$(curl -s -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"label": "my-account"}' | jq -r .sessionId)

# 2. Load the login page (establishes CSRF tokens, sets initial cookies)
curl -X POST http://localhost:3000/sessions/$SESSION/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/login", "wait": {"until": "networkidle"}}'

# 3. After human interaction via VNC (http://localhost:6080), or if the form
#    submission is handled by a subsequent fetch, proceed to the protected page.
#    Session cookies are automatically preserved.
curl -X POST http://localhost:3000/sessions/$SESSION/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/dashboard", "wait": {"selector": ".user-name"}}'
```

### Ephemeral One-Shot Fetch

For stateless scrapes, use `/fetch` — a session is created and destroyed automatically:

```bash
curl -X POST http://localhost:3000/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://quotes.toscrape.com",
    "wait": { "until": "networkidle" },
    "captureAssets": false
  }'
```

### Pass Custom Headers and Cookies

Inject auth tokens or override the `User-Agent` per-request:

```bash
curl -X POST http://localhost:3000/sessions/$SESSION/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/data",
    "extraHeaders": {
      "Authorization": "Bearer eyJ...",
      "X-Custom-Header": "value"
    },
    "cookies": [
      { "name": "session_id", "value": "abc123", "domain": "example.com" }
    ]
  }'
```

### Wait Strategies

Control when a fetch is considered "done":

```bash
# Wait for DOM content parsed (default)
{ "url": "...", "wait": { "until": "domcontentloaded" } }

# Wait for network to go idle (use for SPAs that load data after DOMContentLoaded)
{ "url": "...", "wait": { "until": "networkidle" } }

# Wait for a specific DOM element
{ "url": "...", "wait": { "selector": "#main-content" } }

# Wait for DOM ready + extra settle time (for animated renders)
# settleMs does NOT count against timeoutMs — it runs after the wait phase
{ "url": "...", "wait": { "until": "domcontentloaded", "settleMs": 2000 } }

# All options together with a 45s timeout
{
  "url": "...",
  "wait": {
    "until": "networkidle",
    "selector": ".results-loaded",
    "settleMs": 500,
    "timeoutMs": 45000
  }
}
```

**Timeout behavior:** If the `until` load state times out, the fetch still succeeds — the page is captured as-is and a `warnings` entry is added to the result. This is a *soft* timeout: the server responded and some content loaded, it just didn't reach the desired load state in time. A hard `FetchTimeoutError` (504) only occurs if the server never responds at all, or if a `selector` wait times out.

### Read Back Past Results

Every fetch is stored permanently on disk. Re-read results, stream the DOM, or download specific assets:

```bash
FETCH_ID="<fetchId from result>"

# Re-read the full result manifest
curl http://localhost:3000/fetches/$FETCH_ID

# Stream the rendered DOM as HTML
curl http://localhost:3000/fetches/$FETCH_ID/dom

# Download a specific captured asset (sha1 filename from manifest)
curl http://localhost:3000/fetches/$FETCH_ID/assets/abc123def456.js
```

### VPN Rotation

Rotate the exit IP between requests, or target a specific country:

```bash
# Rotate to any available server (lowest load)
curl -X POST http://localhost:3000/vpn/rotate

# Rotate to a Netherlands exit
curl -X POST http://localhost:3000/vpn/rotate \
  -H "Content-Type: application/json" \
  -d '{ "country": "nl" }'
```

---

## REST API Reference

### `GET /health`

Returns service liveness, current egress IP, and VPN status.

**Response:**
```json
{
  "status": "ok",
  "egressIp": "1.2.3.4",
  "vpn": { "connected": true, "ip": "1.2.3.4", "server": "nl123.nordvpn.com", "country": "nl" },
  "vnc": "http://localhost:6080/vnc.html"
}
```

---

### `POST /sessions`

Create a new persistent session (browser context).

**Request body** _(optional)_:
```json
{ "label": "my-session" }
```

**Response:** [`SessionMeta`](#sessionmeta)

---

### `GET /sessions`

List all active sessions.

**Response:** `SessionMeta[]`

---

### `GET /sessions/:id`

Get session detail and fetch history.

**Response:** [`SessionMeta`](#sessionmeta) (with history)

---

### `DELETE /sessions/:id`

Close and optionally delete a session.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `deleteData` | `boolean` | If `true`, removes on-disk session state |

**Response:** `204 No Content`

---

### `POST /sessions/:id/fetch`

**The main call.** Load a URL in a named session, capture the result.

**Request body:** [`FetchRequest`](#fetchrequest)

**Response:** [`FetchResult`](#fetchresult)

---

### `POST /fetch`

One-off fetch. Creates an ephemeral session, runs the fetch, destroys the session.

**Request body:** [`FetchRequest`](#fetchrequest)

**Response:** [`FetchResult`](#fetchresult)

---

### `GET /fetches/:fetchId`

Re-read a previously captured fetch result.

**Response:** [`FetchResult`](#fetchresult)

---

### `GET /fetches/:fetchId/dom`

Stream the captured rendered DOM as `text/html`.

---

### `GET /fetches/:fetchId/assets/:name`

Stream a captured asset file. The `:name` is the content-addressed filename (e.g. `abc123.js`) from the `assets` array in the fetch result.

---

### `POST /vpn/rotate`

Swap the NordVPN exit to the lowest-load server, optionally filtered by country.

**Request body:**
```json
{ "country": "nl" }
```
| Field | Type | Description |
|-------|------|-------------|
| `country` | `string` _(optional)_ | ISO 3166-1 alpha-2 country code |

**Response:**
```json
{
  "connected": true,
  "ip": "1.2.3.4",
  "server": "nl123.nordvpn.com",
  "country": "nl"
}
```

---

## Type Reference

### `FetchRequest`

The body sent to `/sessions/:id/fetch` and `/fetch`.

```typescript
{
  url: string                             // required — the URL to load
  extraHeaders?: Record<string, string>   // HTTP headers to inject into every request on this page
  cookies?: Array<{                       // cookies to add before navigation
    name: string
    value: string
    domain: string
  }>
  wait?: WaitOptions                      // when to consider the fetch complete (see WaitOptions)
  captureAssets?: boolean                 // save all sub-resources to disk (default: true)
  rotateOnBlock?: boolean                 // auto rotate VPN + retry on 403/block (default: false)
  reuseToken?: boolean                    // auto rotate VPN to reuse an existing CF token bound to a different IP (default: true)
  viewport?: { width: number; height: number }  // override browser viewport size
}
```

### `WaitOptions`

```typescript
{
  until?: 'load' | 'domcontentloaded' | 'networkidle'  // page load state (default: 'domcontentloaded')
  selector?: string       // wait for a CSS selector to appear in the DOM
  settleMs?: number       // extra delay (ms) AFTER the wait phase — not counted against timeoutMs
  timeoutMs?: number      // timeout for navigation + load state + selector (default: 30000)
}
```

**Load states** (see [Playwright docs](https://playwright.dev/docs/api/class-page#page-goto)):

| State | Fires when | Best for |
|-------|-----------|----------|
| `domcontentloaded` | HTML parsed, deferred scripts executed; images/subframes may still be loading | Most pages — fast and reliable *(default)* |
| `load` | Page and all dependent resources (images, stylesheets) have finished loading | Pages where you need all images/styles before capture |
| `networkidle` | No network requests for 500 ms | SPAs that fetch data after initial load; avoid on sites with persistent connections (analytics, websockets) as it may never fire |

**Soft vs. hard timeouts:** If the `until` load state doesn't complete within `timeoutMs`, the fetch still succeeds — the page is captured as-is and a warning is added to the result. Navigation failures (server unreachable) and `selector` timeouts are hard failures that return a 504.

### `FetchResult`

Returned by all fetch endpoints.

```typescript
{
  fetchId: string           // UUID for this fetch bundle
  sessionId: string
  requestedUrl: string
  finalUrl: string          // URL after redirects
  status: number            // HTTP status of the final navigation (challenge-aware)
  startedAt: string         // ISO 8601
  finishedAt: string
  durationMs: number
  warnings?: string[]       // e.g. ["waitUntil 'networkidle' timed out; page captured as-is"]
  egressIp?: string         // Current egress IP used for this fetch (for CF token binding validation)
  cfTokenStatus?: string    // Cloudflare token analysis: 'no_token' | 'token_expired' | 'token_wrong_ip' | 'token_valid' | 'token_worked' | 'token_failed'
  cfTokenReuse?: CfTokenReuse  // Details about CF token reuse flow (present when auto-rotation was attempted or skipped)

  request: {
    extraHeaders: Record<string, string>
    cookiesSent: Array<{ name: string; value: string; domain: string }>
  }
  response: {
    headers: Record<string, string>
    cookiesAfter: Array<{ name: string; value: string; domain: string }>
  }

  dom: { path: string; bytes: number }   // 'dom.html' relative to bundlePath
  assets: Asset[]
  console?: Array<{ type: string; text: string }>  // browser console messages
  bundlePath: string        // absolute path to the on-disk bundle directory
  vnc?: string              // noVNC link when challenge is pending
  challengePending?: boolean // true if the challenge needs manual resolution
  challengeName?: string    // e.g. "cloudflare"
}
```

### `CfTokenReuse`

Present when the fetch pipeline evaluated or executed CF token reuse:

```typescript
{
  initialStatus: 'token_wrong_ip' | 'token_expired' | 'no_token' | 'token_valid'
                     // State before any rotation attempt
  targetServer?: string  // VPN server hostname we rotated to (if applicable)
  boundIp?: string       // The old IP the token was bound to
  rotated: boolean       // Whether we successfully rotated to reuse the token
  skipReason?: 'opt_out' | 'no_mapping' | 'server_unavailable' | 'rotation_failed' | 'not_cf_protected'
                     // Why rotation was skipped or failed
  finalStatus: 'token_worked' | 'token_failed' | 'token_expired' | 'no_token'
                     // State after rotation (or skip)
  rotationDurationMs?: number  // Time spent on VPN rotation + browser swap
}
```

**`cfTokenStatus` values:**
| Value | Meaning |
|-------|---------|
| `no_token` | No Cloudflare token in session; challenge expected if page is protected |
| `token_expired` | Token exists but is past expiration; challenge expected |
| `token_wrong_ip` | Token bound to a different egress IP (likely due to VPN rotation); token won't work |
| `token_valid` | Token is present, not expired, and IP matches; challenge should not occur |
| `token_worked` | Token was valid and no challenge occurred (token successfully reused) |
| `token_failed` | Token was valid but challenge occurred anyway (token may have been invalidated) |

### `Asset`

One entry per sub-resource captured during the page load.

```typescript
{
  url: string
  status: number
  mimeType: string
  fromCache: boolean
  headers: Record<string, string>
  path: string    // filename within the bundle's assets/ directory
  bytes: number
}
```

### `SessionMeta`

```typescript
{
  sessionId: string
  label?: string
  createdAt: string       // ISO 8601
  lastUsedAt: string      // ISO 8601
  currentUrl?: string     // last navigated URL
  headless?: boolean      // whether the browser runs headless (no VNC display)
  cfTokenIp?: string      // Egress IP when Cloudflare token was obtained (if present)
  cfTokenExpires?: number // Unix timestamp (seconds) when CF token expires (if known)
}
```

**CF token fields:** When a Cloudflare clearance token is detected and stored in the session, `cfTokenIp` captures the egress IP at that moment. Subsequent fetches can check if the IP has changed (indicating VPN rotation); if it has, the token won't work and a new challenge is expected. `cfTokenExpires` (if present) indicates when the token expires and becomes invalid.

---

## How It Works

### Architecture
One **Camoufox browser process** managed by Node.js + Playwright. Each **session** maps to a browser context (isolated cookies/storage) with one page ("tab"). This mirrors how you think about browser tabs.

```
Your script/tool
       ↓
   HTTP API (Fastify)
       ↓
  SessionManager ← → Browser contexts (on-disk state)
       ↓          ← → Fingerprint store ({dataDir}/fingerprints/)
       ↓          ← → CF token store ({dataDir}/cf-tokens/)
  Camoufox (Firefox)
       ↓
   Rendered DOM + Assets + Metadata
```

### Session Model
A **session** persists state across multiple fetches:

- Created explicitly (or auto-created on first fetch)
- Backed by a Playwright `BrowserContext` with isolated cookies, localStorage, cache
- On-disk checkpoint includes cookies, localStorage, and fetch history
- Can survive container restarts by rehydrating from disk
- **Fingerprint persistence**: The browser fingerprint is saved to disk keyed by egress IP. On restart, the same fingerprint is restored, so the browser identity is preserved even across VPN rotations.
- **CF token sharing**: When a session obtains a Cloudflare clearance token, it's saved to a shared store. New sessions automatically inject matching tokens, avoiding redundant challenges.

### Fetch Pipeline
When you request a URL:

1. **Resolve or create** the session (restoring state from disk if needed)
2. **Apply overrides** (extra headers, cookies, proxy, viewport)
3. **Intercept responses** and save each asset to disk
4. **Navigate** to the URL (hard failure if the server never responds)
5. **Wait for load state** (`domcontentloaded` by default) — soft failure: if it times out, the page is still captured with a warning
6. **Detect challenge pages** (Cloudflare, etc.) and wait for resolution automatically
7. **Wait for selector** if specified (hard failure on timeout)
8. **Settle** for `settleMs` if specified (runs outside the timeout budget)
9. **Snapshot the DOM** (the rendered HTML post-JavaScript)
10. **Collect metadata** (final URL, status, headers, cookies, timings, console errors)
11. **Checkpoint the session** back to disk
12. **Write a manifest** (`result.json`) mapping every URL → local file path

### Challenge Detection
The fetch pipeline automatically detects bot-challenge pages from Cloudflare and similar vendors. When a challenge is detected, the fetch waits briefly (~5s) for automatic resolution, then returns immediately with `challengePending: true` and a `vnc` link. The browser page is kept alive and visible in the noVNC viewer (`http://localhost:6080`).

To complete the fetch, re-issue the same request against the returned `sessionId`. The `cf_clearance` cookie is stored in the session's cookie jar, so the retry sails through without another challenge.

**CF token sharing**: Clearance cookies are detected during session checkpointing and saved to a shared domain-level store (`/data/cf-tokens/`). When a new session is created, tokens for all known domains are automatically injected — so even a fresh session on the same IP won't trigger a redundant Cloudflare challenge. Tokens are bound to the egress IP and fingerprint, so they only work when both match.

**Auto token reuse (Phase 5)**: If a fetch detects a Cloudflare-protected domain and the session has a valid token bound to a *different* VPN IP, the pipeline can automatically rotate the VPN back to the bound IP, swap the browser fingerprint, and re-inject the token — all before navigation. This avoids a new challenge entirely. Controlled by the `reuseToken` flag on fetch requests (defaults `true`).

### Output Format
Each fetch produces a directory bundle:
```
/data/fetches/<fetchId>/
  result.json     # manifest: URLs, status codes, bytes, paths
  dom.html        # the rendered DOM
  assets/
    <sha1>.js     # each asset, content-addressed by hash
    <sha1>.css
    ...
```

The manifest maps every loaded URL to its on-disk file, so downstream tools can rewrite links or archive the page.

### On-Disk Layout

```
/data/
  sessions/
    <sessionId>/
      meta.json              # created, lastUsed, label, current URL, CF token info
      storage_state.json     # Playwright storage_state(): cookies + localStorage
      history.jsonl          # append-only log of fetches in this session
  fetches/
    <fetchId>/
      result.json            # manifest: URLs, status codes, bytes, paths
      dom.html               # rendered DOM snapshot
      assets/
        <sha1>.<ext>         # each captured asset, content-addressed
  fingerprints/
    <egressIp>.json          # persisted Camoufox fingerprint (keyed by egress IP)
    direct.json              # fingerprint for direct (non-VPN) connections
  vpn/
    last-server.json         # last connected VPN server (for pinning on restart)
    servers.json             # cached WireGuard server catalogue
    wg/
      <hostname>.conf        # WireGuard config per server
  cf-tokens/
    <domain>.json            # shared Cloudflare clearance token (keyed by domain)
```

**Fingerprint files** store the full Camoufox `Fingerprint` object plus the VPN server hostname (for Phase 5 auto-rotate). On restart, the fingerprint is loaded by egress IP key — so if the VPN reconnects to the same server, the same identity is restored.

**CF token files** store a single `cf_clearance` cookie per domain, bound to the egress IP that obtained it. Tokens are automatically injected into new sessions when the IP matches.

### VPN Integration
The container runs with a NordVPN tunnel for egress anonymity. The tunnel is **global** — all sessions share one exit at a time, but you can swap exits on demand:

```bash
curl -X POST http://localhost:3000/vpn/rotate \
  -d '{ "country": "nl" }'
```

Optional `rotateOnBlock: true` in fetch requests triggers an automatic rotate + retry if the site returns a 403 or blocks.

**VPN server pinning**: On startup, the server first attempts to reconnect to the last connected VPN server (saved to `/data/vpn/last-server.json`). If that server is unavailable, it falls back to the lowest-load selection. This keeps the egress IP stable across restarts, which is critical for CF token validity.

**Browser swap on rotation**: When the VPN exit changes, `swapBrowser()` is automatically called — the old browser is closed, a new fingerprint is loaded (or generated) for the new IP, and all sessions are rehydrated into the new browser. This ensures the fingerprint stays consistent with the egress IP, so previously saved CF tokens remain valid.

### Human-in-the-Loop
For pages that need captcha solving or manual interaction:

- VNC access to the live browser at `http://localhost:6080`
- On a challenge, the response includes `challengePending: true` and a `vnc` link — solve in noVNC, then re-issue the fetch against the same `sessionId`

---

## Development

```bash
# Install dependencies
pnpm install

# Type-check
pnpm build

# Run tests
pnpm test

# Start dev server (requires Camoufox + Node.js)
pnpm start
```

## Design Philosophy

- **Explicit over magic**: wait strategies, proxy configuration, and VPN behavior are all exposed as knobs — the caller knows the site best.
- **Real browser, real rendering**: Not a DOM parser — uses a real Playwright instance so JS, CSS, and CSS-in-JS all work.
- **Session = tab**: Familiar mental model. Cookies and state work like a browser you keep open, not a fresh incognito window every time.
- **Disk-persistent**: Session state survives restarts; useful for long-running crawls and recovery.
- **Asset capture**: Every URL that loaded gets saved to disk with a manifest, enabling downstream archival, link rewriting, or replay.

## Notes

- **Not a crawler**: doesn't follow links automatically. The caller controls the URL queue.
- **No HTML rewriting**: assets are captured and manifested; you can rewrite links downstream if needed.
- **One browser process**: sessions run concurrently as browser contexts, sharing one Camoufox instance.
- **Linux-only**: requires Docker + `NET_ADMIN` for VPN, Xvfb for headful display.

## Architecture Details

For deeper design docs, API request/response schemas, VPN mechanism details, and build order, see [SPEC.md](./SPEC.md).

## License

TODO
