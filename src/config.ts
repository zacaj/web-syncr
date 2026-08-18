import type { JsonDate, Opaque } from "@zacaj/util";

export const env = {
  localPort: 443,
  publicPort: 29443,
  publicHost: `localhost`,
  httpsKey: undefined as string | undefined,
  httpsCert: undefined as string | undefined,
  proxyPort: 443,
  proxyProtocol: `https`,
  dbPath: `./db`,
  magicurlApi: `http://100.111.42.92:3005`,
  magicurlMount: `/magicurl-data`,
  // Total per-fetch budget handed to magicurl. Must be generous enough for a
  // Cloudflare "Just a moment…" interstitial to auto-resolve (Camoufox passes
  // it in ~5-15s); the old 3s budget left ~0ms for challenge resolution, so the
  // challenge page was captured as-is.
  magicurlTimeoutMs: 30000,

  // ── Safety guards (all overridable via env; set to 0 to disable) ───────────
  // Hard ceiling on a single request. A load that exceeds this returns 504
  // instead of hanging a connection open forever. Must be > magicurlTimeoutMs.
  requestTimeoutMs: 60000,
  // Bodies larger than this skip the link-rewrite/header-inject pass entirely
  // (streamed through untouched). Prevents a pathological megabyte-scale page
  // from monopolising the single event-loop thread.
  rewriteMaxBytes: 8_000_000,
  // Watchdog: if the event loop stays blocked longer than this, a monitor
  // thread hard-kills the process so the container/pnpm supervisor restarts it.
  // This is the only thing that can recover a true CPU spin. 0 disables.
  watchdogMs: 30000,
  ...process.env,
};

export type LoadMode = `proxy` | `magicurl`;

/** Build the path to a session's config JSON file (mode + magicurl session ID) */
export function sessionConfigPath(sessionId: string) {
  return `${env.dbPath}/session_${sessionId}.config.json`;
}

export type Session = {
  url: string;
  timestamp: JsonDate;
};

export type SessionHead = {
  sessionId: Opaque<`session`>;
  userId: Opaque<`user`> | null;
  name: string;
};
