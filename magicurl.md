# magicurl

**Stateful, stealthy headless-browser fetch service.** Give it a URL, it drives a real browser to load the page, then returns the rendered DOM, all loaded assets, and full request/response metadata. Sessions persist like open browser tabs.

## What It Does

`magicurl` is a "curl for Single-Page Apps" — it solves the problem that `curl` can't handle JavaScript-heavy sites. You send it a URL, and it:

- **Renders the page** using a real Camoufox (Firefox) browser instance
- **Captures everything**: the final DOM, every loaded asset (JS, CSS, images, fonts, XHR), and metadata
- **Maintains state** across requests within a session (cookies, localStorage, auth state), just like keeping browser tabs open
- **Survives restarts** by checkpointing session state to disk
- **Passes fingerprinting checks** using Camoufox, an anti-detect Firefox variant
- **Automatically resolves challenge pages** (Cloudflare, etc.) and waits for the real page
- **Rotates VPN exits** on demand when blocked, with an optional auto-rotate hook
- **Enables human-in-the-loop debugging** via VNC for captchas and manual inspection

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
# Wait for network to go idle (default)
{ "url": "...", "wait": { "until": "networkidle" } }

# Wait for a specific DOM element
{ "url": "...", "wait": { "selector": "#main-content" } }

# Wait for DOM ready + extra settle time (for animated renders)
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
  "vpn": { "connected": true, "ip": "1.2.3.4", "country": "nl" },
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
  wait?: WaitOptions                      // when to consider the fetch complete (default: networkidle)
  captureAssets?: boolean                 // save all sub-resources to disk (default: true)
  rotateOnBlock?: boolean                 // auto rotate VPN + retry on 403/block (default: false)
  viewport?: { width: number; height: number }  // override browser viewport size
}
```

### `WaitOptions`

```typescript
{
  until?: 'load' | 'domcontentloaded' | 'networkidle'  // Playwright load event (default: 'networkidle')
  selector?: string       // wait for a CSS selector to appear in the DOM
  settleMs?: number       // additional fixed delay after load (ms)
  timeoutMs?: number      // hard timeout for the entire wait phase (default: 30000)
}
```

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
  egressIp?: string

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
}
```

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
  createdAt: string     // ISO 8601
  lastUsedAt: string
  currentUrl?: string   // last navigated URL
}
```

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
       ↓
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

### Fetch Pipeline
When you request a URL:

1. **Resolve or create** the session (restoring state from disk if needed)
2. **Apply overrides** (extra headers, cookies, proxy, viewport)
3. **Intercept responses** and save each asset to disk
4. **Navigate** to the URL with configurable wait strategies
5. **Detect challenge pages** (Cloudflare, etc.) and wait for resolution automatically
6. **Wait for "done"** using a layered heuristic: networkidle + optional selector + settle delay + timeout
7. **Snapshot the DOM** (the rendered HTML post-JavaScript)
8. **Collect metadata** (final URL, status, headers, cookies, timings, console errors)
9. **Checkpoint the session** back to disk
10. **Write a manifest** (`result.json`) mapping every URL → local file path

### Challenge Detection
The fetch pipeline automatically detects bot-challenge pages from Cloudflare and similar vendors. When a challenge is detected, the fetch waits (polling every 500ms) until the challenge resolves and the real page reaches `networkidle` — then captures the final page content. The `status` field in the result reflects the real page's HTTP status, not the 403/503 returned by the challenge.

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

### VPN Integration
The container runs with a NordVPN tunnel for egress anonymity. The tunnel is **global** — all sessions share one exit at a time, but you can swap exits on demand:

```bash
curl -X POST http://localhost:3000/vpn/rotate \
  -d '{ "country": "nl" }'
```

Optional `rotateOnBlock: true` in fetch requests triggers an automatic rotate + retry if the site returns a 403 or blocks.

### Human-in-the-Loop
For pages that need captcha solving or manual interaction:

- VNC access to the live browser at `http://localhost:6080`
- A fetch request can block waiting for human input, or
- Solve manually in VNC and re-issue the fetch (session state persists)

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
