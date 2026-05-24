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
  const newURL = new URL(realUrl);
  const baseUrl = new URL(realUrl).host;
  newURL.protocol = `https:`;
  newURL.host = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return newURL;
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
