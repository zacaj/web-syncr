import { serve } from "@hono/node-server";
import { appendJsonL, lastJsonLs, readJsonL } from "@zacaj/util/files";
import { jsonDate, zid, type Opaque } from "@zacaj/util";
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { proxy } from 'hono/proxy';
import { timeout } from 'hono/timeout';
import type { BlankEnv, H } from "hono/types";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import * as Path from 'node:path';
import { renderToStringAsync } from "preact-render-to-string";
import { ChallengePage } from "./ChallengePage";
import { env, readSessionConfig, stripsScripts, usesMagicurl, writeSessionConfig, type Anchor, type LoadMode, type Session, type SessionHead, type SyncMode } from "./config";
import { flushLiveState, getLiveState, publishLiveState } from "./session-state";
import { Home } from "./Home";
import { challengeOf, challengeStatus, checkChallenge, getDomHtml, isChallengeTimeout, lookupAsset, renderPage, streamAsset, vncUrl } from './magicurl';
import { injectHeaderAndScript, replaceAllPatterns, stripScripts } from "./rewrite";
import { parseSubdomain, realUrlToWrapped, wrappedUrlToReal } from "./urls";
import { mintVncUrl, revokeVncTokens, VNC_PREFIX, vncHttp, vncUpgrade } from "./vnc-proxy";
import { startWatchdog } from "./watchdog";

export { realUrlToWrapped };
export type { Session, SessionHead };

function sessionPath(sessionId: string) {
  return `${env.dbPath}/session_${sessionId}.jsonl`;
}

// How many lines the reload/nav-dedup URL lookup scans before giving up and
// treating a page as "new". Deliberately far larger than the ~20-entry window
// used for the history dropdown/Latest-button UI: a real session accumulates
// many more page visits than that dropdown ever needs to show, and if an
// older page falls out of a too-small dedup window, reloading it gets
// misread as a fresh navigation and re-appended as the newest entry —
// burying whatever another tab/browser had navigated to since.
const dedupLookbackLines = 500;

/**
 * Finds `realUrl` in the session's recent history. `sessions` is the small
 * window already loaded for UI purposes — if that window is full (so the
 * file may hold more lines it doesn't cover) and the URL isn't in it, falls
 * back to a much wider read before concluding the URL was never visited.
 */
function findPrevSession(sessionId: string, sessions: Session[], realUrl: string, excludeTimestamp?: string): Session | undefined {
  const matches = (s: Session) => new URL(s.url).toString() === realUrl && s.timestamp !== excludeTimestamp;
  const found = sessions.find(matches);
  if (found || sessions.length < 20)
    return found;
  const wider = lastJsonLs<Session>(sessionPath(sessionId), dedupLookbackLines, []);
  return wider.find(matches);
}

function getSessionMode(sessionId: string): LoadMode {
  return readSessionConfig(sessionId).mode ?? `proxy`;
}

const server = new Hono();

function forwardHeaders(req: { raw: Request }) {
  const headers = new Headers(req.raw.headers);
  headers.delete(`host`);
  headers.delete(`cookie`);
  return headers;
}

const ignoreProxy: H<BlankEnv> = async (c) => {
  try {
    const { req } = c;
    const _url = new URL(req.url);
    const parsed = parseSubdomain(_url.host);
    if (!parsed?.baseUrl)
      return c.text(`No subdomain found on ` + _url);

    const newUrl = new URL(req.url);
    newUrl.host = `${parsed.baseUrl}:${env.proxyPort}`;
    newUrl.protocol = `${env.proxyProtocol}:`;
    const realUrl = newUrl.toString();
    const sessionId = parsed.sessionId;

    // If magicurl mode, try serving from mount first
    if (sessionId && usesMagicurl(getSessionMode(sessionId))) {
      const hit = await lookupAsset(sessionId, realUrl);
      if (hit) {
        const stream = streamAsset(hit.absPath);
        if (stream) {
          const headers = new Headers();
          headers.set(`content-type`, hit.mimeType);
          headers.set(`content-length`, String(stream.contentLength));
          return new Response(stream.stream, { status: 200, headers });
        }
      }
      // Miss — fall through to live proxy with warning
      console.warn(`MAGICURL MISS (ignoreProxy): ${realUrl} not in snapshot — falling back to live proxy`);
    }

    return await proxy(realUrl, {
      ...req.raw, // eslint-disable-line @typescript-eslint/no-misused-spread
      method: req.method,
      headers: forwardHeaders(req),
      body: req.raw.body,
      signal: AbortSignal.any([req.raw.signal, AbortSignal.timeout(30_000)]),
    }).catch(err => {
      console.error(`Proxy Error: ${req.method} ${realUrl}: `, err);
      throw err;
    });
  }
  catch (_err) {
    c.status(500);
    return c.text(`ignored`);
  }
};
server.get(`/favicon.ico`, ignoreProxy);
server.get(`/robots.txt`, ignoreProxy);
server.get(`/.well-known/*`, ignoreProxy);

// Liveness probe. Wire a container healthcheck at this path so that a wedged
// event loop (which cannot answer) fails the check and triggers a restart. It is
// registered before the timeout/proxy middleware so it stays cheap and local.
server.get(`/__healthz`, c => c.text(`ok`));

server.use(`*`, poweredBy());
server.use(`*`, logger((str, ...rest) => console.log(`[${ts()}]`, str, ...rest)));
// Hard per-request deadline. Bounds any *asynchronous* hang (e.g. an upstream or
// magicurl socket that never finishes) — the request returns 504 instead of
// holding a connection open forever. A synchronous CPU spin can't be interrupted
// from the same thread; the watchdog thread covers that case.
const requestTimeoutMs = Number(env.requestTimeoutMs) || 0;
if (requestTimeoutMs > 0)
  server.use(`*`, timeout(requestTimeoutMs));
server.onError((err, c) => {
  // Preserve intentional HTTP errors (e.g. the 504 thrown by the timeout
  // middleware) instead of masking them as a generic 500.
  if (err instanceof HTTPException) return err.getResponse();
  const traceId = zid(`TR`);
  console.error(`[${ts()}] ${traceId}: ${err}`, err);
  return c.text(`Error loading URL, traceId: ${traceId}\n${err}`, 500);
});

server.post(`/`, async c => {
  const { url, syncMode } = await c.req.parseBody<{ url: string; syncMode?: SyncMode }>();
  let [subdomainOrPublicHost, publicHost] = new URL(c.req.url).host.split(`__.`);
  publicHost ??= subdomainOrPublicHost!;
  const sessionId = zid(`SN`).toLowerCase() as Opaque<`session`>;
  appendJsonL<Session>(sessionPath(sessionId), { url, timestamp: jsonDate() });
  // `off` is already the implicit default (readSessionConfig().syncMode ?? `off`),
  // so skip writing a config file for it — keeps a fresh session config-free,
  // same as the default `proxy` load mode.
  if (syncMode && syncMode !== `off`) writeSessionConfig(sessionId, { syncMode });
  const userId = getCookie(c, `z.web-syncr.userId`) as Opaque<`user`> | null;
  if (userId)
    appendJsonL<SessionHead>(`${env.dbPath}/sessions.jsonl`, {
      sessionId,
      userId,
      name: url.replaceAll(/(www.)|(https?:\/\/)/g, ``),
    });
  return c.redirect(realUrlToWrapped(url, sessionId, publicHost));
});

server.post(`/login`, async c => {
  const { username, password } = await c.req.parseBody<{ username: string; password: string }>();
  setCookie(c, `z.web-syncr.userId`, username, { sameSite: `none`, secure: true });
  return c.redirect(`/`);
});

server.post(`/__client-nav`, async (c) => {
  const { sessionId, url: wrappedUrl, html: clientHtml } = await c.req.json<{
    sessionId: string;
    url: string;
    html?: string;
  }>();

  if (!existsSync(sessionPath(sessionId))) {
    c.status(404);
    return c.json({ error: `Session not found` });
  }

  const realUrl = wrappedUrlToReal(wrappedUrl);

  const sessions = lastJsonLs<Session>(sessionPath(sessionId), 20, []);
  const prevSession = findPrevSession(sessionId, sessions, realUrl);
  const session = prevSession ?? appendJsonL<Session>(sessionPath(sessionId), {
    url: realUrl,
    timestamp: jsonDate(),
  });

  const safePath = new URL(realUrl).pathname;
  let path = Path.join(`${env.dbPath}/session_${sessionId}`, safePath);
  if (path.endsWith(`/`)) path += `index.html`;
  else if (!Path.extname(path)) path += `.html`;

  // try {
  //   const response = await fetch(realUrl);
  //   const html = await response.text();

  //   if (!existsSync(path)) {
  //     await mkdir(Path.dirname(path), { recursive: true });
  //     await writeFile(path, html);
  //   }
  // } catch (err) {
  //   console.error(`Error fetching client-nav HTML for ${realUrl}:`, err);
  // }

  if (clientHtml) {
    try {
      path+=`.cli.html`;
      if (!existsSync(path)) {
        await mkdir(Path.dirname(path), { recursive: true });
        await writeFile(path, clientHtml);
      }
    } catch (err) {
      console.error(`Error saving client-nav HTML for ${realUrl}:`, err);
    }
  }

  c.status(200);
  return c.json({ ok: true, session });
});

// noVNC for the challenge page, behind a per-attempt token (see vnc-proxy.ts).
server.all(`${VNC_PREFIX}*`, c => vncHttp(c.req.raw));

server.get(`/__poll-challenge`, async c => {
  const sessionId = c.req.query(`sessionId`);
  const url = c.req.query(`url`);
  if (!sessionId || !url) return c.json({ error: `missing params` }, 400);
  // `force` (the Check Now button) re-renders, which is the only way to learn
  // whether a solve in VNC actually worked. The periodic auto-check must not:
  // each fresh render of a still-challenged page closes the VNC page the user
  // may be mid-solve on (possibly from another device). It only reads the cache,
  // which catches a re-render done by Check Now on any device.
  if (c.req.query(`force`) !== `1`) {
    try {
      const status = await challengeStatus(sessionId, url);
      if (!status.pending) revokeVncTokens(sessionId);
      return c.json(status);
    } catch (err) {
      return c.json({ pending: true, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const result = await checkChallenge(sessionId, url);
  if (!result.pending) revokeVncTokens(sessionId);
  return c.json(result, result.error ? 502 : 200);
});

server.post(`/__session-mode`, async c => {
  const { sessionId, mode, syncMode } = await c.req.json<{ sessionId: string; mode?: LoadMode; syncMode?: SyncMode }>();
  if (!existsSync(sessionPath(sessionId))) {
    c.status(404);
    return c.json({ error: `Session not found` });
  }
  // writeSessionConfig merges, so an unrelated key (magicSessionId, syncMode)
  // survives a change to any other one.
  const patch: { mode?: LoadMode; syncMode?: SyncMode } = {};
  if (mode) patch.mode = mode;
  if (syncMode) patch.syncMode = syncMode;
  return c.json({ ok: true, config: writeSessionConfig(sessionId, patch) });
});

// ── Reading-position sync ───────────────────────────────────────────────────

server.get(`/__session-state`, c => {
  const sessionId = c.req.query(`sessionId`);
  if (!sessionId || !existsSync(sessionPath(sessionId))) {
    c.status(404);
    return c.json({ error: `Session not found` });
  }
  return c.json({ state: getLiveState(sessionId), syncMode: readSessionConfig(sessionId).syncMode ?? `off` });
});

server.post(`/__session-state`, async c => {
  const { sessionId, clientId, url, anchor, deviceLabel, claimDriver } = await c.req.json<{
    sessionId: string;
    clientId: string;
    url: string;
    anchor: Anchor | null;
    deviceLabel: string;
    claimDriver?: boolean;
  }>();
  if (!sessionId || !existsSync(sessionPath(sessionId))) {
    c.status(404);
    return c.json({ error: `Session not found` });
  }
  const state = publishLiveState(sessionId, {
    clientId,
    url: wrappedUrlToReal(url),
    anchor: anchor ?? null,
    deviceLabel: deviceLabel || `device`,
    claimDriver,
  });
  return c.json({ ok: true, seq: state.seq, driverId: state.driverId });
});

const ts = () => new Date().toISOString().replace(`T`, ` `).slice(0, 23);

console.log(`Version: 5.1`);
server.all(`*`, async (c) => {
  const { req } = c;
  const _url = new URL(req.url);

  const parsed = parseSubdomain(_url.host);
  if (!parsed) {
    const userId = getCookie(c, `z.web-syncr.userId`);
    const sessions = userId
      ? (readJsonL<SessionHead>(`${env.dbPath}/sessions.jsonl`) ?? []).filter((h) => h.userId === userId)
      : undefined;
    return c.html(`<html><head>
        <script>${readFileSync(`./src/injected.js`, `utf8`)}</script>
      </head>
      <body>
        ${await renderToStringAsync(Home({ currentUrl: _url.toString(), sessions }))}
      </body>
    </html>`);
  }

  let { subdomain, sessionId, baseUrl, publicHost } = parsed;
  let session: Session|null;
  let sessions: Session[];
  let realUrl: string;
  if (sessionId) {
    sessions = lastJsonLs<Session>(sessionPath(sessionId), 20, []);
    const _session = sessions[0];
    if (_session)
      _session.url = new URL(_session.url).toString();

    if (!baseUrl || _url.pathname.length <= 1) {
      // load existing session
      if (!_session)
        return c.text(`Invalid session "`+sessionId+`"`);

      const redirectTarget = realUrlToWrapped(_session.url, sessionId, publicHost);
      if (redirectTarget.toString() !== req.url)
        return c.redirect(redirectTarget);

      // Already at the wrapped session URL — proxy it directly
      const sessionUrl = new URL(_session.url);
      sessionUrl.protocol = `${env.proxyProtocol}:`;
      sessionUrl.host = `${sessionUrl.hostname}:${env.proxyPort}`;
      realUrl = sessionUrl.toString();
      baseUrl ??= sessionUrl.hostname;
      session = _session;
    }
    else {
      const newUrl = new URL(req.url);
      newUrl.host = `${baseUrl}:${env.proxyPort}`;
      newUrl.protocol = `${env.proxyProtocol}:`;
      realUrl = newUrl.toString();
      const prevSession = findPrevSession(sessionId, sessions, realUrl, _session?.timestamp);
      const isPage = req.header(`Sec-Fetch-Mode`) === `navigate` && newUrl.pathname.length > 1;
      if (isPage && _session?.url !== realUrl) {
        const isNotRefresh = req.header(`Sec-Purpose`) === `prefetch` || (req.header(`Cache-Control`) && req.header(`Cache-Control`)!==`no-cache` && req.header(`Cache-Control`)!==`max-age=0`);
        const isRefresh = req.header(`Referer`) === req.url || req.header(`Refresh`);
        const why = {
          prevSession: prevSession?.timestamp ?? null,
          isPage,
          isNotRefresh,
          isRefresh,
          _session: _session?.timestamp ?? null,
          reqUrl: req.url,
          headers: {
            Refresh: req.header(`Refresh`),
            Referer: req.header(`Referer`),
            SecPurpose: req.header(`Sec-Purpose`),
            CacheControl: req.header(`Cache-Control`),
          },
        };
        if (prevSession && _session/* && (!isNotRefresh || isRefresh)*/) {
          // console.warn(`Reloaded older session on ${realUrl}, redirecting to newest ${_session.url}`, why);
          // const newURL = realUrlToWrapped(_session.url, sessionId, publicHost);
          // return c.redirect(newURL);
          session = prevSession;
        }
        else if (_session && isRefresh) {
          // Refreshing a page not in recent history — don't re-add it as the newest entry.
          // Use a sentinel timestamp so the Latest button appears.
          console.warn(`Refresh of older session on ${realUrl}`, why);
          session = { url: realUrl, timestamp: jsonDate(new Date(0)) };
        }
        else {
          console.warn(`Update session ${sessionId} to ${realUrl}`, why);
          session = appendJsonL<Session>(sessionPath(sessionId), {
            url: realUrl,
            timestamp: jsonDate(),
          });
        }
      }
      else
        // session = _session?.url !== newUrl.toString() ? {
        //   url: newUrl.toString(),
        //   timestamp: jsonDate(),
        // } : _session;
        session = _session ?? {
          url: newUrl.toString(),
          timestamp: jsonDate(),
        };
    }
  }
  else {
    sessions = [];
    if (baseUrl) {
      const newUrl = new URL(req.url);
      newUrl.host = `${baseUrl}:${env.proxyPort}`;
      newUrl.protocol = `${env.proxyProtocol}:`;
      realUrl = newUrl.toString();
      session = { url: realUrl, timestamp: jsonDate() };
      sessionId = zid(`SN`);
    }
    else if (req.path.match(/https?:\/\/.*\..*\//)) {
      const newUrl = req.url.split(publicHost)[1]!;
      const newSessionId = zid(`SN`).toLowerCase();
      appendJsonL<Session>(sessionPath(newSessionId), { url: newUrl, timestamp: jsonDate() });
      return c.redirect(realUrlToWrapped(newUrl, newSessionId, publicHost));
    }
    else
      return c.text(`No session or URL found`);
  }

  const mode = getSessionMode(sessionId);

  // ── Magicurl mode ──────────────────────────────────────────────────────────
  if (usesMagicurl(mode)) {
    const isPage = req.header(`Sec-Fetch-Mode`) === `navigate`;
    const isRefresh = req.header(`Referer`) === req.url || req.header(`Refresh`);

    try {
      if (isPage) {
        // Page navigation: render through magicurl
        const result = await renderPage(sessionId, realUrl, { force: !!isRefresh });

        // challengePending (magicurl returned early with a VNC link), or a DOM
        // that is still an interstitial (a challenge magicurl didn't flag).
        const challenge = await challengeOf(result);
        if (challenge) {
          console.warn(
            `MAGICURL CHALLENGE (${challenge}): ${realUrl} status=${result.status} pending=${result.challengePending ?? false} `
            + `warnings=${JSON.stringify(result.warnings ?? [])} — returning interactive challenge page`,
          );
          const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
          const challengeHtml = await renderToStringAsync(ChallengePage({ challengeName: challenge, realUrl, sessionId, vnc: mintVncUrl(sessionId, result.vnc ?? vncUrl()) }));
          const challengeBody = await injectHeaderAndScript(challengeHtml, { ...session, sessionId }, sessions, injectedJs, mode);
          const responseHeaders = new Headers();
          responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
          responseHeaders.set(`x-load-mode`, mode);
          responseHeaders.set(`x-magicurl-challenge`, challenge);
          return new Response(challengeBody, { status: 200, headers: responseHeaders });
        }

        // Past the challenge: nothing left to solve, so no VNC link should stay live.
        revokeVncTokens(sessionId);
        const body = await getDomHtml(result.fetchId);

        try {
          let savePath = Path.join(`${env.dbPath}/session_${sessionId}`, new URL(realUrl).pathname);
          if (savePath.endsWith(`/`))
            savePath += `index.html`;
          else if (!Path.extname(savePath))
            savePath += `.html`;
          if (!existsSync(savePath) || statSync(savePath).size < 1000) {
            console.info(`Save ${realUrl} to ${savePath} (${Math.round(body.length / 1024)}kB)`);
            await mkdir(Path.dirname(savePath), { recursive: true });
            await writeFile(savePath, body);
          }
        } catch (err) {
          console.error(`Error saving ${realUrl}:`, err);
        }

        // Run existing rewrite pipeline (backend-agnostic)
        const replacements: Dict<string> = {};
        replacements[baseUrl] ??= `${subdomain}__.${publicHost}`;
        replacements[encodeURIComponent(baseUrl)] ??= encodeURIComponent(`${subdomain}__.${publicHost}`);
        replacements[encodeURI(baseUrl)] ??= encodeURI(`${subdomain}__.${publicHost}`);

        const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
        // Strip before rewriting and before injecting: rewriting a document whose
        // scripts are already gone can no longer corrupt a framework payload, and
        // injecting afterwards keeps our own script. The copy saved to disk above
        // is deliberately the unstripped original.
        let newBody = stripsScripts(mode) ? stripScripts(body) : body;
        newBody = replaceAllPatterns(newBody, replacements) ?? newBody;
        newBody = await injectHeaderAndScript(newBody, { ...session, sessionId }, sessions, injectedJs, mode);

        const responseHeaders = new Headers();
        responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
        responseHeaders.set(`x-load-mode`, mode);
        responseHeaders.delete(`content-security-policy`);
        responseHeaders.delete(`content-security-policy-report-only`);
        responseHeaders.delete(`x-frame-options`);
        return new Response(newBody, { status: 200, headers: responseHeaders });
      }
      else {
        // Asset request: try mount first, fall through to proxy on miss
        const hit = await lookupAsset(sessionId, realUrl);
        if (hit) {
          const stream = streamAsset(hit.absPath);
          if (stream) {
            const headers = new Headers();
            headers.set(`content-type`, hit.mimeType);
            headers.set(`content-length`, String(stream.contentLength));
            return new Response(stream.stream, { status: 200, headers });
          }
          else
            console.warn(`MAGICURL MISS: ${realUrl} missing on disk — falling back to live proxy`);
        }
        else
        // Miss — fall through to proxy with warning
          console.warn(`MAGICURL MISS: ${realUrl} not listed in snapshot — falling back to live proxy`);
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
      const causeStr = !cause ? `` : cause instanceof Error ? cause.message : typeof cause === `string` ? cause : ``;
      if (isPage) {
        // A challenge timeout means magicurl couldn't auto-solve a bot-challenge
        // (e.g. Cloudflare managed challenge from a flagged egress IP). That's not
        // a generic failure — it needs a human, so point at VNC.
        const challenged = isChallengeTimeout(err);
        console.error(
          `[${ts()}] MAGICURL ERROR (page)${challenged ? ` [challenge]` : ``}: `
          + `session=${sessionId} url=${realUrl}\n  error: ${msg}`
          + (causeStr ? `\n  cause: ${causeStr}` : ``),
        );
        const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
        const html = challenged
          ? await renderToStringAsync(ChallengePage({ challengeName: `cloudflare`, realUrl, sessionId, vnc: mintVncUrl(sessionId, vncUrl()) }))
          : `<html><head><title>Magicurl Error</title></head><body>`
            + `<h1>Magicurl failed to load this page</h1>`
            + `<pre>${msg.replace(/</g, `&lt;`)}</pre>`
            + `<p>The page could not be rendered through magicurl. `
            + `You can switch back to proxy mode or try reloading.</p>`
            + `</body></html>`;
        const errorBody = await injectHeaderAndScript(html, { ...session, sessionId }, sessions, injectedJs, mode);
        const responseHeaders = new Headers();
        responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
        responseHeaders.set(`x-load-mode`, mode);
        if (challenged) responseHeaders.set(`x-magicurl-challenge`, `cloudflare`);
        return new Response(errorBody, { status: challenged ? 200 : 502, headers: responseHeaders });
      }
      console.warn(`[${ts()}] MAGICURL ERROR (asset): session=${sessionId} url=${realUrl}\n  error: ${msg}${causeStr ? `\n  cause: ${causeStr}` : ``} — falling back to live proxy`);
    }
  }

  // ── Proxy mode (or magicurl miss fallback) ─────────────────────────────────
  const response = await proxy(realUrl, {
    method: req.method,
    headers: forwardHeaders(req),
    body: req.raw.body,
    signal: AbortSignal.any([req.raw.signal, AbortSignal.timeout(30_000)]),
    redirect: `manual`,
  }).catch(err => {
    console.error(`Proxy Error: ${req.method} ${realUrl}: `, err);
    throw err;
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get(`location`);
    if (location) {
      const absLocation = new URL(location, realUrl).toString();
      const wrappedLocation = realUrlToWrapped(absLocation, sessionId, publicHost);
      const newHeaders = new Headers(response.headers);
      newHeaders.set(`location`, wrappedLocation.toString());
      return new Response(null, { status: response.status, statusText: response.statusText, headers: newHeaders });
    }
  }

  const originalResponse = response.clone();

  // const buffer = await response.text();
  // const body = new TextDecoder().decode(buffer);
  const body = await response.text();
  const originalBody = body;

  // backup file to disk
  try {
    let path = Path.join(`${env.dbPath}/session_${sessionId}`, new URL(realUrl).pathname);
    if (path.endsWith(`/`))
      path += `index.html`;
    else if (!Path.extname(path))
      path += `.html`;
    if (!existsSync(path) || statSync(path).size<1000) {
      console.info(`Save ${realUrl} to ${path} (${Math.round(body.length/1024)}kB)`);
      await mkdir(Path.dirname(path), { recursive: true });
      await writeFile(path, body);
    }
  } catch (err) {
    console.error(`Error saving ${realUrl}:`, err);
  }

  const replacements: Dict<string> = {};
  replacements[baseUrl] ??= `${subdomain}__.${publicHost}`;
  replacements[encodeURIComponent(baseUrl)] ??= encodeURIComponent(`${subdomain}__.${publicHost}`);
  replacements[encodeURI(baseUrl)] ??= encodeURI(`${subdomain}__.${publicHost}`);

  const contentType = (response.headers.get(`content-type`) ?? ``).toLowerCase();
  const isHtml = contentType.includes(`text/html`);
  const isCss = contentType.includes(`text/css`) || contentType.includes(`css`);
  const isJs = contentType.includes(`javascript`) || contentType.includes(`application/json`);
  const isRewritable = isHtml || isCss || isJs;

  const injectedJs = readFileSync(`./src/injected.js`, `utf8`);

  // Guard: never run the (event-loop-blocking) rewrite/inject pass on an absurdly
  // large body. Degrading to "served untouched, no header bar" is far better than
  // monopolising the single thread on a multi-megabyte page.
  const maxRewriteBytes = Number(env.rewriteMaxBytes) || 0;
  const tooLargeToRewrite = maxRewriteBytes > 0 && body.length > maxRewriteBytes;
  if (tooLargeToRewrite)
    console.warn(`[${ts()}] Skipping rewrite for oversized ${contentType || `?`} body `
      + `(${Math.round(body.length / 1024)}kB > ${Math.round(maxRewriteBytes / 1024)}kB): ${realUrl}`);

  if (isRewritable && !tooLargeToRewrite) {
    let newBody = replaceAllPatterns(body, replacements) ?? body;
    const changed = newBody !== body;
    if (isHtml || changed) {
      if (isHtml)
        newBody = await injectHeaderAndScript(newBody, { ...session, sessionId: sessionId }, sessions, injectedJs, mode);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete(`content-security-policy`);
      responseHeaders.delete(`content-security-policy-report-only`);
      responseHeaders.delete(`x-frame-options`);
      return new Response(newBody, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    }
  }

  // Passthrough for everything else: non-rewritable content, a rewritable-but-
  // unchanged non-HTML asset (e.g. a CSS/JS file with no base-URL occurrences), or
  // an oversized body. This return is mandatory — falling through without a
  // Response is what produced Hono's "Context is not finalized" 500s on the
  // magicurl-miss → live-proxy asset path.
  return originalResponse;
});

const httpsServer = serve({
  fetch: server.fetch,
  createServer,
  port: env.localPort,
  serverOptions: {
    key: env.httpsKey ? readFileSync(env.httpsKey, `utf8`) : undefined,
    cert: env.httpsCert ? readFileSync(env.httpsCert, `utf8`) : undefined,
  },
}, () => {
  console.log(`Server started on https://${env.publicHost}:${env.publicPort} / https://localhost:${env.localPort}`);
  // Self-heal a wedged event loop: if a request drives the single thread into a
  // synchronous spin, a monitor thread hard-kills the process so the supervisor
  // restarts it. Set watchdogMs=0 to disable (e.g. under a debugger).
  const watchdogMs = Number(env.watchdogMs) || 0;
  if (watchdogMs > 0) {
    startWatchdog({ thresholdMs: watchdogMs });
    console.log(`Event-loop watchdog armed (threshold ${watchdogMs}ms)`);
  }
});

// `docker compose` swaps containers on a deploy by sending SIGTERM (falling
// back to SIGKILL after its grace period) — a known, imminent shutdown, not
// the unpredictable crash the live-state debounce is sized for. Without this,
// any reading position published in the last couple seconds before a deploy
// never reaches disk, and the fresh process comes up with nothing to restore.
httpsServer.on(`upgrade`, vncUpgrade);

for (const sig of [`SIGTERM`, `SIGINT`] as const) {
  process.on(sig, () => {
    flushLiveState();
    process.exit(0);
  });
}
