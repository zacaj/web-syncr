/* eslint-disable */
// @ts-nocheck
function realUrlToWrapped(realUrl, sessionId, publicHost) {
  const url = new URL(realUrl);
  const baseUrl = url.host;
  const wrappedHost = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return `https://${wrappedHost}${url.pathname}${url.search}${url.hash}`;
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


(function() {
  const originalPushState = history.pushState;

  history.pushState = function(state, title, url) {
    // Convert SPA pushState into a full page load through the proxy so the main handler
    // runs: it saves HTML to disk, updates the session JSONL, and re-injects the header
    // bar with the correct path — none of which happens if we let the SPA handle it.
    if (url) {
      location.assign(url);
    } else {
      originalPushState.call(this, state, title, url);
    }
  };

  // Browser back/forward: force a full reload so the proxy re-serves the correct page.
  addEventListener(`popstate`, () => {
    // reportClientNavigation();
    location.replace(location.href);
  });
})();

function wrapAndNavigate(realUrl, sessionId) {
  location.assign(realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]));
};

const origHtml = document.documentElement.outerHTML;
setTimeout(() => {
  if (document.documentElement.outerHTML !== origHtml)
    reportClientNavigation();
}, 1000);

function navigateToSessionId(sessionId, publicHost = new URL(location.href).host.split(`__.`)[1]) {
  location.assign(`https://${sessionId.toLowerCase()}__.${publicHost}`);
}

function toggleSessions() {
  const e = document.getElementById(`sessions`);
  e.style.display = e.style.display !== `none` ? `none` : `block`;
}
