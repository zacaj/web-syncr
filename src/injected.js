/* eslint-disable */
// @ts-nocheck
function realUrlToWrapped(realUrl, sessionId, publicHost) {
  const url = new URL(realUrl);
  // hostname (not host) — a port on realUrl is always re-derived server-side from
  // env.proxyPort, and a colon isn't valid inside a hostname label anyway.
  const baseUrl = url.hostname;
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

function setSyncMode(sessionId, syncMode) {
  fetch(`/__session-mode`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ sessionId, syncMode }),
  }).then(() => location.reload()).catch(() => {});
}

// ── Reading-position sync (Phase 2: join on load + manual handoff) ──────────
//
// Model: whichever device the user last actually touched is the "driver" and
// publishes its reading position; every other device is passive. Opening a
// page is a "join" — you take the current state of the most recent activity.
(function() {
  const syncMode = window.__webSyncrSyncMode || `off`;
  const sessionId = getSessionId();
  if (syncMode === `off` || !sessionId || sessionId.length < 2) return;

  const anchorApi = () => window.__webSyncrAnchor;

  // Per-tab identity. sessionStorage (not localStorage) so two tabs on one
  // machine are distinct drivers, and (not a plain variable) so a reload keeps
  // the same identity rather than looking like a brand-new device.
  let clientId = null;
  try { clientId = sessionStorage.getItem(`__webSyncrClient`) } catch {}
  if (!clientId) {
    clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
    try { sessionStorage.setItem(`__webSyncrClient`, clientId) } catch {}
  }

  const deviceLabel = window.innerWidth < 700 ? `Phone` : `Desktop`;
  let isDriver = false;
  // Highest state `seq` this tab has observed, from any source (join, poll,
  // or its own publish's response). `seq` is monotonic and server-assigned,
  // so it's what lets the poll below tell a genuinely newer state apart from
  // a response that merely raced a local claim and reflects pre-claim data.
  let lastKnownSeq = 0;
  // Set once join()'s initial fetchState() resolves. The claimDriver listeners
  // below are attached synchronously and fire on genuine input at any time,
  // but a real tap can easily land before that first network round trip
  // finishes — routine on a cold proxy fetch or a slow connection, and the
  // whole point of "open on another device" is that the user reaches for it
  // and starts reading right away. Claiming driver in that window would
  // publish whatever position the freshly-loaded, not-yet-synced page happens
  // to be at (usually the very top), stomping the real driver's position
  // before this tab ever received it — and in `live` mode dragging every
  // other device along to that wrong spot. Blocking claims until join()
  // resolves costs at most one stray touch; every listener stays attached, so
  // the next one claims normally.
  let joined = false;

  function myRealUrl() {
    return wrappedUrlToReal(location.href);
  }

  function payload(claimDriver) {
    const api = anchorApi();
    return JSON.stringify({
      sessionId,
      clientId,
      url: location.href,
      anchor: api ? api.capture() : null,
      deviceLabel,
      claimDriver: !!claimDriver,
    });
  }

  function publish(claimDriver) {
    try {
      // keepalive: claimDriver fires on pointerdown, which precedes the click
      // that (via the pushState override above) can trigger a same-tab
      // location.assign within milliseconds — well before this fetch's round
      // trip finishes. Without keepalive the navigation aborts it mid-flight,
      // silently dropping the claim (and, on the page that lands, the poll
      // sees stale state and can bounce this same device back to where it
      // came from). Same class of bug the pagehide handler below solves with
      // sendBeacon; keepalive is the fetch-native equivalent.
      fetch(`/__session-state`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: payload(claimDriver),
        keepalive: true,
      }).then(r => r.json()).then(res => {
        if (res && typeof res.seq === `number` && res.seq > lastKnownSeq) lastKnownSeq = res.seq;
      }).catch(() => {});
    } catch {}
  }

  /**
   * Becoming the driver requires *real* user input — never a scroll event.
   *
   * This is the single most important rule here: a restore scrolls the page,
   * which fires `scroll`, which would look exactly like the user scrolling.
   * Treating that as input makes two devices claim driver off each other's
   * restores and ping-pong forever.
   *
   * Note there is deliberately no isApplying() guard here, unlike on the scroll
   * path below. These four events are only ever produced by a human — the
   * restore never synthesises them — so suppressing them mid-settle would just
   * swallow a genuine takeover during the two-second convergence window.
   * anchor.js aborts its own convergence loop on these same events, so grabbing
   * the driver role here is exactly the right response.
   */
  function claimDriver() {
    if (!joined) return;
    if (!isDriver) {
      isDriver = true;
      publish(true);
    } else {
      schedulePublish();
    }
    correctUrlShortly();
  }

  /**
   * location.href at the moment of pointerdown/wheel/etc. is not reliably
   * the destination: many sites drive "navigation" from their own click
   * handler via history.replaceState or an SPA router — code that runs
   * *after* this event, not before it. publish() above captures whatever
   * href was current at the input event, which on those sites is still the
   * page the user is leaving. Re-read shortly after and correct the
   * published url if it moved, rather than waiting on the next scroll to
   * notice (which may never come, e.g. if the transition's own scroll-to-
   * top was a no-op because the user was already at the top).
   */
  function correctUrlShortly() {
    const urlAtInput = location.href;
    setTimeout(() => {
      if (!isDriver) return;
      if (location.href !== urlAtInput) publish(false);
    }, 200);
  }
  for (const ev of [`wheel`, `touchstart`, `pointerdown`, `keydown`])
    addEventListener(ev, claimDriver, { passive: true, capture: true });

  // Throttle, not debounce: a pure debounce (reset-on-every-tick) never fires
  // while scrolling stays continuous, since each new tick pushes the timer
  // back again — a reader who scrolls steadily for 20s would publish nothing
  // for that entire span. THROTTLE_MS bounds the gap between updates while
  // busy; the trailing setTimeout still fires once things go quiet, so the
  // final settled position is always published precisely, not just the last
  // throttled sample.
  const PUBLISH_THROTTLE_MS = 1000;
  let publishTimer = null;
  let lastPublishAt = 0;
  function schedulePublish() {
    if (!isDriver) return;
    const api = anchorApi();
    if (api && api.isApplying()) return;
    if (publishTimer) clearTimeout(publishTimer);
    const elapsed = Date.now() - lastPublishAt;
    if (elapsed >= PUBLISH_THROTTLE_MS) {
      lastPublishAt = Date.now();
      publish(false);
    } else {
      publishTimer = setTimeout(() => { lastPublishAt = Date.now(); publish(false) }, PUBLISH_THROTTLE_MS - elapsed);
    }
  }
  // `scrollend` fires once when scrolling actually stops; the debounced
  // `scroll` fallback covers browsers that lack it.
  addEventListener(`onscrollend` in window ? `scrollend` : `scroll`, schedulePublish, { passive: true });

  // "Closed the laptop, picked up the phone" IS the unload path, and fetch()
  // gets killed there while sendBeacon does not.
  addEventListener(`pagehide`, () => {
    if (!isDriver) return;
    try { navigator.sendBeacon(`/__session-state`, new Blob([payload(false)], { type: `application/json` })) }
    catch {}
  });

  // ── Receiving ────────────────────────────────────────────────────────────

  function hidePill() {
    const pill = document.getElementById(`web-syncr-pill`);
    if (pill) pill.style.display = `none`;
  }

  function showPill(state) {
    const pill = document.getElementById(`web-syncr-pill`);
    if (!pill) return;
    let path = state.url;
    try { path = new URL(state.url).pathname } catch {}
    pill.style.display = `inline-flex`;
    pill.textContent = ``;
    const text = document.createElement(`span`);
    text.textContent = `${state.deviceLabel} · ${path}`;
    const button = document.createElement(`button`);
    button.type = `button`;
    button.textContent = `jump`;
    button.style.cssText = `border:none;border-radius:999px;padding:0.1rem 0.6rem;cursor:pointer`;
    // Naming both the source device and the destination path matters: a silent
    // jump away from the page someone is reading reads as a bug, not a feature.
    button.addEventListener(`click`, () => followState(state));
    pill.appendChild(text);
    pill.appendChild(button);
  }

  function followState(state) {
    if (!state || !state.url) return;
    if (state.url === myRealUrl()) {
      const api = anchorApi();
      if (api && state.anchor) api.settleTo(state.anchor);
      return;
    }
    wrapAndNavigate(state.url, sessionId);
  }

  /**
   * Both join-on-load and a polled update run through here — the sole
   * difference between `manual` and `live` is whether a cross-page state
   * moves you or just offers to.
   */
  function applyState(state) {
    if (!state) return;
    if (state.url === myRealUrl()) {
      hidePill();
      const api = anchorApi();
      if (api && state.anchor) api.settleTo(state.anchor);
      return;
    }
    if (syncMode === `live`) followState(state);
    else showPill(state);
  }

  function fetchState() {
    return fetch(`/__session-state?sessionId=` + encodeURIComponent(sessionId))
      .then(r => r.json())
      .then(res => (res && res.state) || null)
      .catch(() => null);
  }

  // Join: always re-fetch after load rather than stashing anything across the
  // navigation. sessionStorage is keyed to the wrapped origin, which changes
  // whenever the session moves to a different site — a stash would silently
  // vanish on exactly the cross-site follow it was meant to carry.
  function join() {
    fetchState().then(state => {
      joined = true;
      if (!state) return;
      lastKnownSeq = state.seq;
      if (state.driverId === clientId) {
        // The last published state is OURS — the same tab, one page ago. A
        // normal forward navigation (clicking a link) resets `isDriver` to
        // false on every fresh load, since the server's driverId is the only
        // thing that survives a reload. Without this check that stale flag
        // makes join() read our own trail as "the other device is on the page
        // you just left" and show a pill about ourselves.
        isDriver = true;
        if (state.url !== myRealUrl()) {
          publish(false);
          return;
        }
      }
      applyState(state);
    });
  }

  // Exposed for tests / manual triggering; not currently wired to any header
  // control (the pill covers the same "where is the other device?" need with
  // less UI clutter — see the poll below for how it stays fresh without one).
  window.webSyncrJump = function() {
    fetchState().then(state => { if (state) { lastKnownSeq = Math.max(lastKnownSeq, state.seq); followState(state) } });
  };

  if (document.readyState === `loading`) addEventListener(`DOMContentLoaded`, join);
  else join();

  /**
   * Without this, a tab left open while the user starts driving from another
   * device goes stale silently — join() only ever runs once, at load. Polling
   * is a stand-in for the SSE push Phase 3 will add. 2s, not slower: this
   * tool is single-user, so the extra request volume costs nothing.
   *
   * Always polls, even while `isDriver` is true — a driving tab still needs a
   * way to find out it's been superseded (the user picked up another device),
   * and the only source for that is this same poll. What it must NOT do is
   * act on a response that merely raced its own just-sent claim: the POST and
   * this GET can be in flight together, and the GET can win the race with
   * pre-claim data. `seq` is server-assigned and monotonic, so comparing
   * against the highest `seq` this tab has already seen (from join, a prior
   * poll, or its own publish's response — see `lastKnownSeq`) tells a stale
   * race response apart from a real, newer takeover without any timing
   * assumptions.
   */
  setInterval(() => {
    fetchState().then(state => {
      if (!state || state.seq <= lastKnownSeq) return;
      lastKnownSeq = state.seq;
      if (state.driverId !== clientId) { isDriver = false; applyState(state) }
    });
  }, 2000);
})();

