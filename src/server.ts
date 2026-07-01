import { serve } from "@hono/node-server";
import { appendJsonL, lastJsonLs, readJsonL } from "common/util/files";
import { jsonDate, zid, type Opaque } from "common/util/index";
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { proxy } from 'hono/proxy';
import type { BlankEnv, H } from "hono/types";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import * as Path from 'node:path';
import { renderToStringAsync } from "preact-render-to-string";
import { env, sessionConfigPath as sessionConfigPathFn, type LoadMode, type Session, type SessionHead } from "./config";
import { Home } from "./Home";
import { detectUnresolvedChallenge, getDomHtml, isChallengeTimeout, lookupAsset, renderPage, streamAsset, vncUrl } from './magicurl';
import { injectHeaderAndScript, replaceAllPatterns } from "./rewrite";
import { parseSubdomain, realUrlToWrapped, wrappedUrlToReal } from "./urls";

export { realUrlToWrapped };
export type { Session, SessionHead };

function sessionPath(sessionId: string) {
  return `${env.dbPath}/session_${sessionId}.jsonl`;
}

function getSessionMode(sessionId: string): LoadMode {
  const path = sessionConfigPathFn(sessionId);
  if (existsSync(path)) {
    try { return (JSON.parse(readFileSync(path, `utf8`)) as { mode?: LoadMode }).mode ?? `proxy` }
    catch { return `proxy` }
  }
  return `proxy`;
}

/** Build the HTML for the challenge-pending waiting page. Injected JS handles auto-polling. */
function buildChallengePage(challengeName: string, realUrl: string, sessionId: string, vncLink: string): string {
  const safeUrl = realUrl.replace(/</g, `&lt;`);
  const safeChallenge = challengeName.replace(/</g, `&lt;`);
  const jsSessionId = JSON.stringify(sessionId);
  const jsRealUrl = JSON.stringify(realUrl);
  return `<html><head><title>Challenge pending — ${safeChallenge}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f14;color:#e0e0e0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#challenge-bar{padding:10px 16px;background:#1a1a2e;border-bottom:2px solid #e94560;display:flex;align-items:center;gap:12px;flex-shrink:0}
#challenge-bar h2{font-size:14px;color:#e94560;white-space:nowrap}
#challenge-bar code{font-size:12px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}
#challenge-bar .hint{font-size:12px;color:#888;flex:1}
#done-btn{padding:7px 14px;background:#e94560;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;white-space:nowrap}
#done-btn:hover{background:#c73350}
#poll-status{font-size:12px;color:#888;white-space:nowrap}
iframe{flex:1;border:none;width:100%;display:block}
</style></head><body>
<div id="challenge-bar">
  <h2>${safeChallenge} challenge</h2>
  <code title="${safeUrl}">${safeUrl}</code>
  <span class="hint">Solve in the browser below, then click Done.</span>
  <span id="poll-status">Auto-checking in 20s…</span>
  <button id="done-btn" onclick="location.reload()">Done — Check Now</button>
</div>
<iframe src="${vncLink.replace(/"/g, `&quot;`)}"></iframe>
<script>
var SESSION_ID=${jsSessionId},REAL_URL=${jsRealUrl},countdown=20,timer;
function tick(){
  countdown--;
  var s=document.getElementById('poll-status');
  if(countdown>0){s.textContent='Auto-checking in '+countdown+'s…';}
  else{clearInterval(timer);s.textContent='Checking…';poll();}
}
async function poll(){
  try{
    var r=await fetch('/__poll-challenge?sessionId='+encodeURIComponent(SESSION_ID)+'&url='+encodeURIComponent(REAL_URL));
    var d=await r.json();
    if(!d.pending){location.reload();return;}
  }catch(e){}
  countdown=20;
  document.getElementById('poll-status').textContent='Auto-checking in 20s…';
  timer=setInterval(tick,1000);
}
timer=setInterval(tick,1000);
</script>
</body></html>`;
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
    if (sessionId && getSessionMode(sessionId) === `magicurl`) {
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
server.get(`/**/*.js`, ignoreProxy);

server.use(`*`, poweredBy());
server.use(`*`, logger((str, ...rest) => console.log(`[${ts()}]`, str, ...rest)));
server.onError((err, c) => {
  const traceId = zid(`TR`);
  console.error(`[${ts()}] ${traceId}: ${err}`, err);
  return c.text(`Error loading URL, traceId: ${traceId}\n${err}`, 500);
});

server.post(`/`, async c => {
  const { url } = await c.req.parseBody<{ url: string }>();
  let [subdomainOrPublicHost, publicHost] = new URL(c.req.url).host.split(`__.`);
  publicHost ??= subdomainOrPublicHost!;
  const sessionId = zid(`SN`).toLowerCase() as Opaque<`session`>;
  appendJsonL<Session>(sessionPath(sessionId), { url, timestamp: jsonDate() });
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
  const prevSession = sessions.find(s => new URL(s.url).toString() === realUrl);
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

server.get(`/__poll-challenge`, async c => {
  const sessionId = c.req.query(`sessionId`);
  const url = c.req.query(`url`);
  if (!sessionId || !url) return c.json({ error: `missing params` }, 400);
  try {
    const result = await renderPage(sessionId, url, { force: true });
    return c.json({ pending: result.challengePending ?? false });
  } catch (err) {
    console.warn(`Error while polling for challenge update on sessionId=${sessionId}: `, err);
    return c.json({ pending: true, error: err instanceof Error ? err.message : String(err) });
  }
});

server.post(`/__session-mode`, async c => {
  const { sessionId, mode } = await c.req.json<{ sessionId: string; mode: LoadMode }>();
  if (!existsSync(sessionPath(sessionId))) {
    c.status(404);
    return c.json({ error: `Session not found` });
  }
  // Preserve existing magicSessionId when switching modes
  const cfgPath = sessionConfigPathFn(sessionId);
  const existing = existsSync(cfgPath)
    ? (() => { try { return JSON.parse(readFileSync(cfgPath, `utf8`)) as Dict } catch { return {} } })()
    : {};
  await writeFile(cfgPath, JSON.stringify({ mode, magicSessionId: existing.magicSessionId }));
  return c.json({ ok: true });
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
      const prevSession = sessions.find(s => new URL(s.url).toString() === realUrl && s.timestamp !== _session?.timestamp);
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
  if (mode === `magicurl`) {
    const isPage = req.header(`Sec-Fetch-Mode`) === `navigate`;
    const isRefresh = req.header(`Referer`) === req.url || req.header(`Refresh`);

    try {
      if (isPage) {
        // Page navigation: render through magicurl
        const result = await renderPage(sessionId, realUrl, { force: !!isRefresh });

        // New API: challenge returns immediately with challengePending: true + vnc link
        const pendingChallenge = result.challengePending ? (result.challengeName ?? `unknown`) : null;
        if (pendingChallenge) {
          console.warn(
            `MAGICURL CHALLENGE PENDING (${pendingChallenge}): ${realUrl} — returning interactive challenge page`,
          );
          const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
          const challengeHtml = buildChallengePage(pendingChallenge, realUrl, sessionId, result.vnc ?? vncUrl());
          const challengeBody = await injectHeaderAndScript(challengeHtml, { ...session, sessionId }, sessions, injectedJs, mode);
          const responseHeaders = new Headers();
          responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
          responseHeaders.set(`x-load-mode`, `magicurl`);
          responseHeaders.set(`x-magicurl-challenge`, pendingChallenge);
          return new Response(challengeBody, { status: 200, headers: responseHeaders });
        }

        const body = await getDomHtml(result.fetchId);

        // Fallback: DOM-based detection for older API versions that don't set challengePending
        const legacyChallenge = detectUnresolvedChallenge(result, body);
        if (legacyChallenge) {
          console.warn(
            `MAGICURL CHALLENGE (${legacyChallenge}): ${realUrl} status=${result.status} `
            + `warnings=${JSON.stringify(result.warnings ?? [])} — interstitial not resolved`,
          );
          const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
          const challengeHtml = buildChallengePage(legacyChallenge, realUrl, sessionId, vncUrl());
          const challengeBody = await injectHeaderAndScript(challengeHtml, { ...session, sessionId }, sessions, injectedJs, mode);
          const responseHeaders = new Headers();
          responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
          responseHeaders.set(`x-load-mode`, `magicurl`);
          responseHeaders.set(`x-magicurl-challenge`, legacyChallenge);
          return new Response(challengeBody, { status: 200, headers: responseHeaders });
        }

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
        let newBody = replaceAllPatterns(body, replacements) ?? body;
        newBody = await injectHeaderAndScript(newBody, { ...session, sessionId }, sessions, injectedJs, mode);

        const responseHeaders = new Headers();
        responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
        responseHeaders.set(`x-load-mode`, `magicurl`);
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
        const pageHtml = challenged
          ? buildChallengePage(`cloudflare`, realUrl, sessionId, vncUrl())
          : `<html><head><title>Magicurl Error</title></head><body>`
            + `<h1>Magicurl failed to load this page</h1>`
            + `<pre>${msg.replace(/</g, `&lt;`)}</pre>`
            + `<p>The page could not be rendered through magicurl. `
            + `You can switch back to proxy mode or try reloading.</p>`
            + `</body></html>`;
        const errorBody = await injectHeaderAndScript(pageHtml, { ...session, sessionId }, sessions, injectedJs, mode);
        const responseHeaders = new Headers();
        responseHeaders.set(`content-type`, `text/html; charset=utf-8`);
        responseHeaders.set(`x-load-mode`, `magicurl`);
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

  const isHtml = (response.headers.get(`content-type`) ?? ``).includes(`text/html`);
  const injectedJs = readFileSync(`./src/injected.js`, `utf8`);
  let newBody = replaceAllPatterns(body, replacements) ?? (isHtml ? body : null);
  if (newBody) {
    newBody = await injectHeaderAndScript(newBody, { ...session, sessionId: sessionId }, sessions, injectedJs, mode);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete(`content-security-policy`);
    responseHeaders.delete(`content-security-policy-report-only`);
    responseHeaders.delete(`x-frame-options`);
    return new Response(newBody, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  }
  else
    return originalResponse;
});

serve({
  fetch: server.fetch,
  createServer,
  port: env.localPort,
  serverOptions: {
    key: env.httpsKey ? readFileSync(env.httpsKey, `utf8`) : undefined,
    cert: env.httpsCert ? readFileSync(env.httpsCert, `utf8`) : undefined,
  },
}, () => {
  console.log(`Server started on https://${env.publicHost}:${env.publicPort} / https://localhost:${env.localPort}`);
});
