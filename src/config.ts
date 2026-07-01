import type { JsonDate, Opaque } from "common/util/index";

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
