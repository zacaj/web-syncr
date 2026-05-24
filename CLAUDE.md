# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm start` — Run dev server (requires HTTPS certs configured in `.env`)
- `pnpm typecheck` — TypeScript type-check only (no emit in dev; production emits to `build/`)
- `pnpm docker:start` — Build and run dev Docker image
- `pnpm docker:deploy` — Build, tag, push to registry, and restart via SSH on remote host

No test runner is configured.

## Architecture

**web-syncr** is a single-process HTTPS proxy server that wraps arbitrary websites in a session-aware subdomain, saves page HTML to disk, and injects a session header bar into proxied responses.

### Request flow

1. All traffic hits `src/server.ts` (Hono on `@hono/node-server` with a native HTTPS server).
2. The hostname encodes routing: `{sessionId}__{baseUrl-dots-as-underscores}__.{publicHost}`.
   - Example: `snABC123__example_com__.localhost:29443` proxies to `https://example.com`.
   - `realUrlToWrapped` / `wrappedUrlToReal` handle this encoding on both server and client.
3. For proxied HTML responses, the server:
   - Replaces every occurrence of `baseUrl` in the body with the wrapped subdomain form (so all internal links stay within the proxy).
   - Injects the `<Header>` Preact component (SSR) after `<body>`.
   - Injects `src/injected.js` before `</head>` to intercept client-side navigation (pushState/replaceState/popstate) and report it to `POST /__client-nav`.
4. Non-HTML resources (JS, favicon, robots.txt, .well-known) bypass injection via `ignoreProxy`.

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

### `common/` package

Shared TypeScript utilities (`util/files.ts`, `util/index.ts`, etc.) and ESLint configs. Imported via `@common/*` and `common/*` path aliases. In production Docker, `build/common` is symlinked into `node_modules` as both `common` and `@common`.

## Key gotchas

- **`package.json5`** — The package file uses JSON5 (comments allowed). Do not rename or convert to `.json`.
- **HTTPS required** — Dev server fails to start without cert paths in `.env`. See `.env.template` for expected keys (`httpsKey`, `httpsCert`).
- **Node >=24 required** — Uses native APIs not available in earlier versions.
- **`pnpm typecheck` does not emit** — `noEmit: true` is set in `tsconfig.json`. The Dockerfile runs `tsc` directly during production builds; `tsx` runs source directly in dev.
- **No linting command in scripts** — Run ESLint manually: `pnpm eslint src/` or `pnpm eslint --fix src/`.
