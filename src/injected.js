function realUrlToWrapped(realUrl, sessionId, publicHost) {
  const newURL = new URL(realUrl);
  const baseUrl = new URL(realUrl).host;
  newURL.host = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return newURL;
}

function wrappedUrlToReal(wrappedUrl) {
  const url = new URL(wrappedUrl);
  const [subdomain, publicHost] = url.host.split(`__.`);
  if (!publicHost) return wrappedUrl;
  const [sessionId, baseUrl] = subdomain.split(`__`, 2);
  if (!baseUrl) return wrappedUrl;
  const realBaseUrl = baseUrl.replace(/_/g, `.`);
  return `https://${realBaseUrl}${url.pathname}${url.search}${url.hash}`;
}

function getSessionId() {
  const host = new URL(location.href).host;
  const [subdomain] = host.split(`__`);
  return subdomain.split(`__`)[0];
}

function reportClientNavigation() {
  const sessionId = getSessionId();
  if (!sessionId || sessionId.length < 2) return;
  const wrappedUrl = location.href;
  const realUrl = wrappedUrlToReal(wrappedUrl);
  const html = document.documentElement.outerHTML;
  fetch(`/__client-nav`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ sessionId, url: realUrl, html }),
  }).catch(() => {});
}

function wrapAndNavigate(realUrl, sessionId) {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]));
};

(function() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    reportClientNavigation();
  };
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    reportClientNavigation();
  };
  addEventListener(`popstate`, reportClientNavigation);
})();

function navigateToSessionId(sessionId, publicHost = new URL(location.href).host.split(`__.`)[1]) {
  location.assign(`https://${sessionId.toLowerCase()}__.${publicHost}`);
}

function toggleSessions() {
  const e = document.getElementById(`sessions`);
  e.style.display = e.style.display != `none` ? `none` : `block`;
}
