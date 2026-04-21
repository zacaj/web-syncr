# web-syncr

Single-page web proxy server using Hono + Preact.

## Commands

- `pnpm start` - Run dev server (requires HTTPS certs via env)
- `pnpm build` - TypeScript check
- `pnpm docker:start` - Run in Docker dev mode
- `pnpm docker:start:prod` - Run production Docker image

**Note**: Uses `package.json5` (not `.json`) - pnpm reads this directly.

## Architecture

- Entry: `src/server.ts` (Hono server)
- UI: Preact components in `src/*.tsx`
- Shared: `common/` directory (eslint, tsconfig, util)
- Sessions: JSONL files in `db/session_*.jsonl`

## Tech Stack

- Node.js >=24 required
- pnpm package manager
- TypeScript + ESLint (flat config in `eslint.config.js`)
- Hono web framework + @hono/node-server
- Preact (not React) for templating

## Routing

URLs follow pattern: `{sessionId}__{baseUrl}.{publicHost}:{port}`
- `sessionId` - Unique session identifier (prefixed `SN`)
- `baseUrl` - Target site with dots replaced by underscores

## Environment

Required in `.env`:
- `localPort` - Local HTTPS port (default 443)
- `publicPort` - Exposed port (default 29443)
- `flaresolverr` - Optional Cloudflare bypass service (host:port)

Optional HTTPS certs:
- `httpsKey` - Path to private key
- `httpsCert` - Path to certificate

## Key Implementation Details

- TypeScript uses Preact JSX: `jsxFactory: "h"` in tsconfig
- Session IDs prefixed with `SN` (e.g., `SNrgYFjR7MbbqA3V`)
- Base URLs in hostnames use underscores instead of dots: `example_com.localhost:29443`
- Proxy rewrites responses, injecting session header into `<body>` and script into `<head>`
- Sessions stored in `db/session_*.jsonl`; metadata in `db/sessions.jsonl`
- Flaresolverr sessions created on-demand per session ID

## Gotchas

- Dev server requires HTTPS certificates - won't start without them
- Node.js >=24 required (check with `node --version`)
- Uses `package.json5` not `.json` - don't convert to JSON
- ESLint uses flat config (`eslint.config.js`), not legacy