# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm start` — Run dev server (requires HTTPS certs configured in `.env`)
- `pnpm typecheck` — TypeScript type-check only (no emit in dev; production emits to `build/`)
- `pnpm docker:start` — Build and run dev Docker image
- `pnpm docker:deploy` — Build, tag, push to registry, and restart via SSH on remote host (manual/dev; releases go through CI)
- `pnpm release:patch` / `release:minor` — release-it bumps the version and pushes a `vX.Y.Z` tag;
  Forgejo CI (`.forgejo/workflows/ci.yml`) then tests, builds + pushes `docker.zacaj.com/web-syncr:<version>`
  (the `dev` stage), and deploys it to the VPS (health-checked, rolls back on failure). The `npmrc`
  build secret (token for `@zacaj/*`) comes from `~/.npmrc` via `.zdockerrc` locally, `NPM_TOKEN` in CI.

- `pnpm test` — Run the Playwright E2E test suite (`tests/`)
- `LIVE_TESTS=1 pnpm test tests/live-sites.spec.ts` — Opt-in live-site regression tests (require internet + HTTPS certs)

## Architecture

**web-syncr** is a single-process HTTPS proxy server that wraps arbitrary websites in a session-aware subdomain, saves page HTML to disk, and injects a session header bar into proxied responses.

### Request flow

1. All traffic hits `src/server.ts` (Hono on `@hono/node-server` with a native HTTPS server).
2. The hostname encodes routing: `{sessionId}__{baseUrl-dots-as-underscores}__.{publicHost}`.
   - Example: `snABC123__example_com__.localhost:29443` proxies to `https://example.com`.
   - `realUrlToWrapped` / `wrappedUrlToReal` handle this encoding on both server and client.
3. For proxied HTML responses, the server:
   - Replaces every occurrence of `baseUrl` in the body with the wrapped subdomain form (so all internal links stay within the proxy).
   - Injects a single `<script>` after `<body>` carrying `src/anchor.js`, `src/injected.js`, and the
     SSR'd `<Header>` markup *as a string*, to intercept client-side navigation
     (pushState/replaceState/popstate) and report it to `POST /__client-nav`.
   - The header is **not** served as markup. It is mounted from JS on `load`, into a
     `#web-syncr-root` wrapper appended to `<html>`, and re-checked on an interval so a
     client-side route change that drops it heals itself. This is deliberate: sites that hydrate
     React over the served HTML (Next.js App Router hydrates the whole document) reconcile
     `<body>`'s children positionally, so an injected *element* is a hydration mismatch and React
     deletes it — an injected `<script>` is tolerated. For the same reason, content offset uses
     `body` padding-top rather than a spacer element. See `injectHeaderAndScript` in `rewrite.ts`.
4. Non-HTML resources (JS, favicon, robots.txt, .well-known) bypass injection via `ignoreProxy`.

### Load modes

Each session has a `mode` (set via the Header dropdown or `POST /__session-mode`):

- **`proxy`** (default): Live streaming proxy — passes requests through to upstream.
- **`magicurl`**: Headless-browser rendering backend — uses the magicurl service to render pages
  through a real Camoufox/Playwright browser, solving JS-heavy SPA challenges and anti-bot walls.
- **`magicurl-noscript`**: Same render, but every `<script>` is stripped from the snapshot before
  rewriting and injection. For sites whose own JS fights the proxy: re-running a framework against
  HTML we have rewritten can corrupt its payload (a Next.js RSC flight payload embeds
  byte-length-prefixed rows, so lengthening a URL inside one desyncs it and trips the site's error
  boundary). Non-default — reach for it only when a page actually misbehaves, since it also disables
  any site feature that genuinely needs scripts. Safe only for magicurl: a *proxy*-mode page's DOM
  is not yet assembled, so stripping scripts there leaves any streaming/SPA site blank.

Use `usesMagicurl(mode)` / `stripsScripts(mode)` from `config.ts` rather than comparing mode
literals, so the two magicurl variants stay in step.

When either `magicurl` mode is active:
- Page navigations go through `src/magicurl.ts` → `POST /sessions/:id/fetch` → disk mount.
- Asset requests try the magicurl disk mount first (`lookupAsset` + `streamAsset`), then fall
  back to the live proxy with a `MAGICURL MISS` warning.
- If the magicurl API is unreachable, the entire request falls back to the live proxy.

Bot-challenge pages (`ChallengePage.tsx`) embed magicurl's noVNC via `src/vnc-proxy.ts`: web-syncr
serves it on its own https origin at `/__vnc/<token>/…` (HTTP + websocket `upgrade`), so it isn't
blocked as mixed content and works off Tailscale. The token is per challenge attempt, expires after
`vncTokenTtlMs` of disuse, and is revoked (open sockets closed) once the session gets past the
challenge — it is the only protection, so never log or persist it. Checking a challenge is manual
(Check Now → forced re-render); challenge pages only *poll* the cached result and never re-render on
their own, because re-rendering an unsolved page makes magicurl close the page being solved in VNC.

Config options (`.env`):
- `magicurlApi` — REST API base URL for the magicurl service (default: `http://host.docker.internal:3005`)
- `magicurlMount` — Read-only bind mount path for magicurl's `/data/fetches` (default: `/magicurl-data`)

### Session persistence

- Each session is a JSONL file: `db/session_{sessionId}.jsonl` — each line is a `Session` (`url` + `timestamp`).
- `db/sessions.jsonl` is an index of `SessionHead` records (sessionId, userId, display name).
- Fetched HTML pages are also saved to `db/session_{sessionId}/{path}` for archival.
- User identity uses a signed cookie (`z.web-syncr.userId`); login is simple username/password with no real auth.

### UI components

- `src/Header.tsx` — injected into every proxied page; shows session ID, history navigation, and a new-URL form.
- `src/Home.tsx` — shown at the root when no session/baseUrl is in the hostname; login + session list.
- Both use **Preact** (not React). JSX compiles with `jsxFactory: "h"` (see `tsconfig.json`).
- Event handlers in Header/Home use raw JS strings cast as `Hack` type — this is intentional: the components render server-side and execute in the proxied page's browser, not in a Preact VDOM.

### Shared utilities and ESLint config

Framework-agnostic helpers (`appendJsonL`/`readJsonL`/`lastLines`, `jsonDate`, `Opaque`, string/array/object utils, etc.) come from the published `@zacaj/util` package — `import from "@zacaj/util"` for the barrel, or a subpath like `"@zacaj/util/files"` for a single file. ESLint config comes from `@zacaj/eslint-config-base` the same way. Both ship real commented `.ts` source under `node_modules/@zacaj/*/src` alongside the build, so declaration-map "go to definition" lands on readable source, not just `.d.ts`.

### Tests

The suite lives in `tests/` and runs with Playwright (Chromium only). `global-setup.ts` starts:
- The web-syncr server on port **29443** (using `.env` certs, isolated db at `/tmp/web-syncr-test-db`)
- A mock HTTP server on port **38080** that serves controlled HTML pages and files from `tests/fixtures/`

Test files:
- `proxy.spec.ts` — core proxy behaviour: session creation, header injection, link rewriting, redirects, JSONL recording, SPA pushState
- `home.spec.ts` — login flow and home page rendering
- `fixtures.spec.ts` — proxying against captured real-site HTML (skips with a help message if the fixture isn't present)
- `magicurl.spec.ts` — magicurl mode: manifest lookup, DOM serving, URL rewriting, miss→proxy fallback, mode switching
- `live-sites.spec.ts` — opt-in tests that fetch real external sites; enable with `LIVE_TESTS=1`

### `scripts/mirror-page.ts`

Captures a real web page as a local fixture for offline proxy tests.

```
npx tsx scripts/mirror-page.ts <url>
```

Writes two files under `tests/fixtures/{host_with_underscores}/{path}/`:
- `.html` — raw HTML from the site
- `.local.html` — same HTML with the site's hostname replaced by `localhost`

The mock server serves `.local.html` at `/fixtures/{host}/{path}`. This lets `fixtures.spec.ts` test proxy rewriting against realistic markup without network access. When adding a new fixture-based test, run this script first and commit the `.local.html` file (the raw `.html` is for reference only).

## Key gotchas

- **HTTPS required** — Dev server fails to start without cert paths in `.env`. See `.env.template` for expected keys (`httpsKey`, `httpsCert`).
- **Node >=24 required** — Uses native APIs not available in earlier versions.
- **`pnpm typecheck` does not emit** — `noEmit: true` is set in `tsconfig.json`. The Dockerfile runs `tsc` directly during production builds; `tsx` runs source directly in dev.
- **No linting command in scripts** — Run ESLint manually: `pnpm eslint src/` or `pnpm eslint --fix src/`.
