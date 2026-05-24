import { serve } from "@hono/node-server";
import { appendJsonL, lastJsonLs, readJsonL } from "common/util/files";
import { jsonDate, zid, type Opaque } from "common/util/index";
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { proxy } from 'hono/proxy';
import type { BlankEnv, H } from "hono/types";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import * as Path from 'node:path';
import { renderToStringAsync } from "preact-render-to-string";
import { env, type Session, type SessionHead } from "./config";
import { Home } from "./Home";
import { injectHeaderAndScript, replaceAllPatterns } from "./rewrite";
import { parseSubdomain, realUrlToWrapped, wrappedUrlToReal } from "./urls";

export { realUrlToWrapped };
export type { Session, SessionHead };

function sessionPath(sessionId: string) {
  return `${env.dbPath}/session_${sessionId}.jsonl`;
}

const server = new Hono();

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

    return await proxy(realUrl, {
      ...req.raw, // eslint-disable-line @typescript-eslint/no-misused-spread
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
server.use(`*`, logger());
server.onError((err, c) => {
  const traceId = zid(`TR`);
  console.error(`${traceId}: ${err}`, err);
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

  try {
    const response = await fetch(realUrl);
    const html = await response.text();

    if (!existsSync(path)) {
      await mkdir(Path.dirname(path), { recursive: true });
      await writeFile(path, html);
    }
  } catch (err) {
    console.error(`Error fetching client-nav HTML for ${realUrl}:`, err);
  }

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

  const response = await proxy(realUrl, {
    ...req.raw, // eslint-disable-line @typescript-eslint/no-misused-spread
  }).catch(err => {
    console.error(`Proxy Error: ${req.method} ${realUrl}: `, err);
    throw err;
  });
  const originalResponse = response.clone();

  // const buffer = await response.text();
  // const body = new TextDecoder().decode(buffer);
  const body = await response.text();
  const originalBody = body;

  try {
    let path = Path.join(`${env.dbPath}/session_${sessionId}`, new URL(realUrl).pathname);
    if (path.endsWith(`/`))
      path += `index.html`;
    else if (!Path.extname(path))
      path += `.html`;
    if (!existsSync(path)) {
      console.info(`Save ${realUrl} to ${path}`);
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
    newBody = await injectHeaderAndScript(newBody, { ...session, sessionId: sessionId }, sessions, injectedJs);
    return new Response(newBody, response);
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
