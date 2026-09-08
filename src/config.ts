import type { JsonDate, Opaque } from "@zacaj/util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

/**
 * How a session propagates reading position between devices.
 * - `off`    — no publishing, no restoring.
 * - `manual` — restore on page load; a header button jumps to the other
 *              device's position on demand.
 * - `live`   — additionally follow the driver's navigations automatically.
 */
export type SyncMode = `off` | `manual` | `live`;

export type SessionConfig = {
  mode?: LoadMode;
  magicSessionId?: string;
  syncMode?: SyncMode;
};

export function readSessionConfig(sessionId: string): SessionConfig {
  const path = sessionConfigPath(sessionId);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, `utf8`)) as SessionConfig }
  catch { return {} }
}

/**
 * Merge `patch` into a session's config.
 *
 * Spreads the existing config rather than rebuilding it from a fixed field
 * list: the previous version named `mode` and `magicSessionId` explicitly, so
 * every other key was silently dropped on any mode switch — which would have
 * quietly eaten `syncMode` the first time a user touched the mode dropdown.
 */
export function writeSessionConfig(sessionId: string, patch: SessionConfig): SessionConfig {
  const merged = { ...readSessionConfig(sessionId), ...patch };
  writeFileSync(sessionConfigPath(sessionId), JSON.stringify(merged));
  return merged;
}

export type Session = {
  url: string;
  timestamp: JsonDate;
};

/**
 * A cross-device locator for one element. Ordered bundles of these are tried
 * best-surviving-first: `text` leads because it survives reflow, restyling and
 * outright DOM divergence (which happens in `proxy` mode when two devices get
 * different HTML from upstream); `path` is last because it survives none of it.
 * `fraction` is the never-fails fallback, measured through the content
 * container rather than the whole document — rails, headers and ad slots differ
 * wildly in height between mobile and desktop, so document fraction can be way off.
 */
export type Locator =
  | { kind: `text`; sig: string; nth: number }
  | { kind: `id`; id: string }
  | { kind: `media`; src: string; nth: number }
  | { kind: `path`; path: string }
  | { kind: `fraction`; container: string; f: number };

/** A captured reading position. See `src/anchor.js`. */
export type Anchor = {
  /** ~3 candidate elements, each with its own ordered locator bundle. */
  candidates: Locator[][];
  /** How far through the primary element the reading line fell (0..1). */
  offsetFraction: number;
  /**
   * Locator bundle for whatever content sat at the very top of the capturing
   * device's usable viewport. Restoring caps its scroll so this never ends up
   * entirely above the other device's viewport — the reading-line fraction
   * alone only guarantees *one* shared point lines up, which on a much
   * shorter viewport can still push text the user hadn't finished reading
   * off-screen above.
   */
  topCandidates: Locator[] | null;
  capturedAt: string;
};

/**
 * The session's current reading position, as last published by whichever
 * device is driving. Ephemeral and high-frequency — deliberately kept out of
 * the session JSONL, which is the durable navigation history and would be
 * flooded by scroll updates.
 */
export type SessionLiveState = {
  /** clientId of the device currently driving. */
  driverId: string;
  driverSince: JsonDate;
  /** Monotonic; lets a client ignore updates older than what it already has. */
  seq: number;
  /** Real (unwrapped) URL the driver is on. */
  url: string;
  anchor: Anchor | null;
  /** Human label for the header pill, e.g. "Phone". */
  deviceLabel: string;
};

export type SessionHead = {
  sessionId: Opaque<`session`>;
  userId: Opaque<`user`> | null;
  name: string;
};
