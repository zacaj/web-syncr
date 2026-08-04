export type ParsedSubdomain = {
  subdomain: string;
  sessionId?: string;
  baseUrl?: string;
  publicHost: string;
};

/** Decodes the proxy subdomain format: `{sessionId}__{baseUrl-dots-as-underscores}__.{publicHost}` */
export function parseSubdomain(host: string): ParsedSubdomain | null {
  const [subdomain, publicHost] = host.split(`__.`);
  if (!publicHost || !subdomain) return null;

  let [sessionIdOrBaseUrl, baseUrl] = subdomain.split(`__`, 2);
  let sessionId: string | undefined = sessionIdOrBaseUrl;

  if (!baseUrl && sessionIdOrBaseUrl?.includes(`.`)) {
    sessionId = undefined;
    baseUrl = sessionIdOrBaseUrl;
  }
  baseUrl = baseUrl?.replaceAll(/([^_])_([^_])/g, `$1.$2`);

  return { subdomain, sessionId, baseUrl, publicHost };
}

export function realUrlToWrapped(realUrl: string, sessionId: string, publicHost: string): URL {
  const orig = new URL(realUrl);
  // Use `hostname` (never `host`) — any port on `realUrl` is discarded by design:
  // parseSubdomain()/server.ts always re-derive the upstream port from env.proxyPort,
  // never from the wrapped hostname, and a colon isn't valid inside a hostname label
  // anyway. Also build the wrapped URL fresh from a string rather than mutating
  // `.host` on an existing URL — the WHATWG host setter treats embedded colons as a
  // port separator and silently truncates or throws on the malformed result.
  const baseUrl = orig.hostname;
  const wrappedHost = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return new URL(`https://${wrappedHost}${orig.pathname}${orig.search}${orig.hash}`);
}

export function wrappedUrlToReal(wrappedUrl: string): string {
  const url = new URL(wrappedUrl);
  const [subdomain, publicHost] = url.host.split(`__.`);
  if (!publicHost) return wrappedUrl;
  const [, baseUrl] = subdomain!.split(`__`, 2);
  if (!baseUrl) return wrappedUrl;
  const realBaseUrl = baseUrl.replace(/_/g, `.`);
  return `https://${realBaseUrl}${url.pathname}${url.search}${url.hash}`;
}
