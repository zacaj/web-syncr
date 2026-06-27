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

  // In magicurl mode, intercept link clicks before SPA frameworks (Inertia, etc.)
  // can turn them into XHR requests. Forces a full page navigate so the server
  // routes through renderPage instead of asset lookup.
  if (window.__webSyncrMode === `magicurl`) {
    document.addEventListener(`click`, function(e) {
      const anchor = e.target.closest(`a[href]`);
      if (!anchor) return;
      const href = anchor.getAttribute(`href`);
      if (!href || href.startsWith(`#`) || href.startsWith(`javascript:`)) return;
      if (anchor.hasAttribute(`download`) || anchor.target === `_blank`) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      location.assign(anchor.href);
    }, true);
  }
})();

function wrapAndNavigate(realUrl, sessionId) {
  try {
    const wrapped = realUrlToWrapped(realUrl, sessionId, new URL(location.href).host.split(`__.`)[1]);
    location.assign(wrapped);
  } catch (e) {
    console.error(`wrapAndNavigate failed for url "${realUrl}":`, e);
  }
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

function setSessionMode(sessionId, mode) {
  fetch(`/__session-mode`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ sessionId, mode }),
  }).then(() => location.reload()).catch(() => {});
}
