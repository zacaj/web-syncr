import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { env } from './config';

/**
 * Public, per-attempt access to magicurl's noVNC.
 *
 * noVNC itself only listens on plain http over Tailscale, which an https
 * challenge page can't embed (mixed content) and a phone off Tailscale can't
 * reach. So web-syncr serves it on its own https origin, under
 * `/__vnc/<token>/…`, forwarding page assets and the websocket upstream.
 *
 * The token is the only protection (web-syncr's login is not real auth), so a
 * grant is scoped to one web-syncr session, expires after a quiet TTL, and is
 * revoked — open sockets included — as soon as that session gets past its
 * challenge. Whoever holds a live URL controls the remote browser until then.
 */

export const VNC_PREFIX = `/__vnc/`;

type Grant = {
  sessionId: string;
  /** Upstream noVNC origin, e.g. `http://100.1.2.3:6080`. */
  upstream: URL;
  expiresAt: number;
  sockets: Set<Duplex>;
};

const grants = new Map<string, Grant>();

function ttlMs(): number {
  return Number(env.vncTokenTtlMs) || 15 * 60_000;
}

/**
 * Mint a grant for one challenge attempt. Returns the path (on the caller's own
 * host) to load noVNC from; `path=` points noVNC's websocket back through the
 * same token, since by default it would connect to `/websockify` at the root.
 */
export function mintVncUrl(sessionId: string, upstreamVnc: string): string {
  const token = randomBytes(16).toString(`base64url`);
  grants.set(token, { sessionId, upstream: new URL(upstreamVnc), expiresAt: Date.now() + ttlMs(), sockets: new Set() });
  return `${VNC_PREFIX}${token}/vnc.html?path=${encodeURIComponent(`${VNC_PREFIX.slice(1)}${token}/websockify`)}`;
}

/** End every grant for a session, closing any live VNC connection on it. */
export function revokeVncTokens(sessionId: string): void {
  for (const [token, grant] of grants) {
    if (grant.sessionId !== sessionId) continue;
    grants.delete(token);
    for (const s of grant.sockets) s.destroy();
  }
}

type Resolved = { grant: Grant; upstreamPath: string } | { refused: string };

/**
 * Split `/__vnc/<token>/<rest>` into a live grant and the upstream path, or a
 * reason it was refused. Unknown and expired are told apart because they mean
 * different things in a log: expired is a page left open too long, unknown is
 * almost always a page from before a restart (grants live in memory only).
 */
function resolve(pathAndQuery: string): Resolved {
  if (!pathAndQuery.startsWith(VNC_PREFIX)) return { refused: `not a VNC path` };
  const rest = pathAndQuery.slice(VNC_PREFIX.length);
  const slash = rest.indexOf(`/`);
  if (slash < 0) return { refused: `no path after token` };
  const token = rest.slice(0, slash);
  const grant = grants.get(token);
  if (!grant) return { refused: `unknown token ${tokenHint(token)} (revoked, or minted before a restart)` };
  if (grant.expiresAt < Date.now()) {
    grants.delete(token);
    return { refused: `expired token ${tokenHint(token)}` };
  }
  // Sliding expiry: an attempt someone is actively using stays alive.
  grant.expiresAt = Date.now() + ttlMs();
  return { grant, upstreamPath: rest.slice(slash) };
}

/** Enough of a token to correlate log lines, not enough to use it. */
function tokenHint(token: string): string {
  return `${token.slice(0, 4)}…`;
}

/** Hono handler for noVNC's page and static assets. */
export async function vncHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const hit = resolve(url.pathname + url.search);
  if (`refused` in hit) {
    console.warn(`VNC http refused: ${hit.refused}`);
    return new Response(`This VNC link has expired or is invalid — reload the challenge page for a new one.`, { status: 404 });
  }
  const { grant, upstreamPath } = hit;

  const upstream = await fetch(new URL(upstreamPath, grant.upstream), {
    method: req.method,
    signal: AbortSignal.timeout(15_000),
  });
  const headers = new Headers();
  for (const name of [`content-type`, `last-modified`, `etag`]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  // The token is in the URL: never hand it to anything noVNC links to.
  headers.set(`referrer-policy`, `no-referrer`);
  headers.set(`cache-control`, `no-store`);

  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * `upgrade` listener for the https server: pipe a token-bearing websocket
 * straight through to websockify. Raw socket splicing rather than a WS library
 * — the frames are noVNC's business, we only gate and re-path the handshake.
 * Nothing else on this server accepts websockets, so any other upgrade is refused.
 */
export function vncUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const hit = resolve(req.url ?? ``);
  if (`refused` in hit) {
    console.warn(`VNC websocket refused: ${hit.refused}`);
    socket.end(`HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n`);
    return;
  }
  const { grant, upstreamPath } = hit;
  console.info(`VNC websocket open: session=${grant.sessionId} -> ${grant.upstream.host}${upstreamPath}`);
  const port = Number(grant.upstream.port) || 80;
  const upstream = connect(port, grant.upstream.hostname);
  const lines = [`${req.method ?? `GET`} ${upstreamPath} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (lower === `host`) lines.push(`Host: ${grant.upstream.host}`);
    // websockify can be configured to check Origin; ours is the public host, not its own.
    else if (lower !== `origin`) lines.push(`${name}: ${req.rawHeaders[i + 1]!}`);
  }
  upstream.on(`connect`, () => {
    upstream.write(lines.join(`\r\n`) + `\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  grant.sockets.add(socket);
  let closed = false;
  const close = (why: string) => (err?: Error) => {
    if (closed) return;
    closed = true;
    console.info(`VNC websocket closed (${why}${err ? `: ${err.message}` : ``}): session=${grant.sessionId}`);
    grant.sockets.delete(socket);
    upstream.destroy();
    socket.destroy();
  };
  upstream.on(`error`, close(`upstream error`));
  upstream.on(`close`, close(`upstream closed`));
  socket.on(`error`, close(`client error`));
  socket.on(`close`, close(`client closed`));
}
