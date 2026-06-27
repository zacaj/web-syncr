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
  magicurlApi: `http://host.docker.internal:3005`,
  magicurlMount: `/magicurl-data`,
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
