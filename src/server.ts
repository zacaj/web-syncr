import { serve } from "@hono/node-server";
import { appendJsonL, findJsonL, lastJsonL, lastJsonLs } from "common/util/files";
import "common/util/index";
import { jsonDate, zid, type JsonDate, type Opaque } from "common/util/index";
import { diffText } from "common/util/primitives";
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { prettyJSON } from 'hono/pretty-json';
import { proxy } from 'hono/proxy';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import type { BlankEnv, BlankInput, H } from "hono/types";
import { existsSync, readFile, readFileSync } from "node:fs";
import { createServer } from 'node:https';
import { renderToStringAsync } from "preact-render-to-string";
import { Header } from "./Header";
import { Home } from "./Home";


// const routes: {[method: string]: Map<RegExp, any>} = {};
const server = new Hono({
//    router: {
//   add(method, path, handler) {
//     const regex = new RegExp(path);
//     (routes[method]??=new Map()).set(regex, handler);
//   },
//   match(method, path) {
//     if (!routes[method]) return
//   },
// }
});

const ignoreProxy: H<BlankEnv, any, BlankInput, any> = async (c) => {
  try {
    const { req } = c;
    const _url = new URL(req.url);

    const [subdomain, publicHost] = _url.host.split(`__.`);
    if (!publicHost)
      return c.text(`No subdomain found on `+_url);

    let [sessionIdOrBaseUrl, baseUrl] = subdomain!.split(`__`, 2);
    let sessionId = sessionIdOrBaseUrl;

    if (!baseUrl && sessionIdOrBaseUrl?.includes(`.`)) {
      sessionId = undefined;
      baseUrl = sessionIdOrBaseUrl;
    }
    baseUrl = baseUrl?.replaceAll(/([^_])_([^_])/g, `$1.$2`);
    const newUrl = new URL(req.url);
    newUrl.host = baseUrl+`:443`;
    newUrl.protocol = `https:`;
    const realUrl = newUrl.toString();

    const response = await proxy(realUrl, {
      ...req.raw, // eslint-disable-line @typescript-eslint/no-misused-spread
    }).catch(err => {
      console.error(`Proxy Error: ${req.method} ${realUrl}: `, err);
      throw err;
    });
    return response;
  }
  catch (_err) {
    c.status(500);
    return c.text(`ignored`);
  }
};
server.get(`/favicon.ico`, ignoreProxy);
server.get(`/.well-known/*`, ignoreProxy);
server.get(`/**/*.js`, ignoreProxy);

server.use(`*`, poweredBy());
server.use(`*`, logger());
server.onError((err, c) => {
  const traceId = zid(`TR`);
  console.error(`${traceId}: ${err}`, err);
  return c.text(`Custom Error Message.  ${traceId}`, 500);
});

const env = {
  localPort: 443,
  publicPort: 29443,
  publicHost: `localhost`,
  httpsKey: undefined as string|undefined,
  httpsCert: undefined as string|undefined,
  ...process.env,
};

export type Session = {
  // id: Opaque<'session'>;
  url: string;
  timestamp: JsonDate;
};

server.post(`/`, async c => {
  const { url } = await c.req.parseBody<{ url: string }>();
  let [subdomainOrPublicHost, publicHost] = new URL(c.req.url).host.split(`__.`);
  publicHost ??= subdomainOrPublicHost!;
  // publicHost ??= new URL(url).hostname; //`${env.publicHost}:${env.publicPort}`;
  const sessionId = zid(`SN`).toLowerCase();
  appendJsonL<Session>(sessionPath(sessionId), {
    url,
    timestamp: jsonDate(),
  });
  return c.redirect(realUrlToWrapped(url, sessionId, publicHost));
});

console.log(`Version: 9`);

server.all(`*`, async (c) => {
  const { req } = c;
  // const url = req.path.match(/(https?:\/\/.*$)/)?.[1];
  // if (!url)
  //   return c.text(`Couldn't find URL in '${req.url}'`);

  const _url = new URL(req.url);
  if (!_url.host.includes(`__.`) || _url.host.startsWith(`__.`)) {
    //     return c.html(`
    // <p>No base URL or session id found in ${_url}.</p><p>Would you like to start a new session?</p>
    // <form action="/" method="post">
    //   <input type="url" name="url" placeholder="URL to sync" style="width: 100%" />
    //   <button type="submit">Go</button>
    // </form>
    //     `);
    return c.html(await renderToStringAsync(Home({ currentUrl: _url.toString() })));
  }
  const [subdomain, publicHost] = _url.host.split(`__.`);
  if (!publicHost)
    return c.text(`No subdomain found on `+_url);

  let [sessionIdOrBaseUrl, baseUrl] = subdomain!.split(`__`, 2);
  let sessionId = sessionIdOrBaseUrl;
  if (!baseUrl && sessionIdOrBaseUrl?.includes(`.`)) {
    sessionId = undefined;
    baseUrl = sessionIdOrBaseUrl;
  }
  baseUrl = baseUrl?.replaceAll(/([^_])_([^_])/g, `$1.$2`);
  let session: Session|null;
  let sessions: Session[];
  let realUrl: string;
  if (sessionId) {
    sessions = lastJsonLs<Session>(sessionPath(sessionId), 10, []);
    const _session = sessions[0];
    if (_session)
      _session.url = new URL(_session.url).toString();

    if (!baseUrl || _url.pathname.length <= 1) {
      // load existing session
      if (!_session)
        return c.text(`Invalid session "`+sessionId+`"`);

      // session = _session;
      // realUrl = session.url;
      // baseUrl = new URL(realUrl).host;
      // const newURL = new URL(realUrl);
      // newURL.host = `${sessionId}_${baseUrl}.${env.publicHost}:${env.publicPort}`;
      return c.redirect(realUrlToWrapped(_session.url, sessionId, publicHost));
    }
    else {
      const newUrl = new URL(req.url);
      newUrl.host = baseUrl+`:443`;
      newUrl.protocol = `https:`;
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
        session = _session?.url !== newUrl.toString() ? {
          url: newUrl.toString(),
          timestamp: jsonDate(),
        } : _session;
    }
  }
  else {
    sessions = [];
    if (baseUrl) {
      const newUrl = new URL(req.url);
      newUrl.host = baseUrl+`:443`;
      newUrl.protocol = `https:`;
      realUrl = newUrl.toString();
      session = {
        url: realUrl.toString(),
        timestamp: jsonDate(),
      };
      sessionId = zid(`SN`);
    }
    else if (req.path.match(/https?:\/\/.*\..*\//)) {
      const newUrl = req.url.split(publicHost)[1]!;
      const sessionId = zid(`SN`).toLowerCase();
      appendJsonL<Session>(sessionPath(sessionId), {
        url: newUrl,
        timestamp: jsonDate(),
      });
      return c.redirect(realUrlToWrapped(newUrl, sessionId, publicHost));
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

  const body = await response.text();
  const originalBody = body;

  const replacements: Dict<string> = {};
  replacements[baseUrl] ??= `${subdomain}__.${publicHost}`;
  replacements[encodeURIComponent(baseUrl)] ??= encodeURIComponent(`${subdomain}__.${publicHost}`);
  replacements[encodeURI(baseUrl)] ??= encodeURI(`${subdomain}__.${publicHost}`);

  let newBody = replaceAllPatterns(body, replacements);
  if (newBody) {
    // console.info(`${realUrl}: replaced  v\n`+diffText(originalBody.wrap(), replaceAllPatterns(originalBody.wrap(), replacements)!)+`\n${realUrl}: replaced ^`);

    newBody = newBody.replace(/(<\s*body[^>]*>)/i, `$1`+await renderToStringAsync(Header({ session: { ...session, sessionId }, history: sessions })));
    newBody = newBody.replace(/(<\/\s*head)/i, (m, a, b) => `<script>${readFileSync(`./src/injected.js`, `utf8`)}</script>${a}`);
    return new Response(newBody, response);
  }
  else
    return originalResponse;

  function replaceAllPatterns(body: string, replacements: Dict<string>) {
    let replaced = 0;
    // for (const [original, replacement] of Object.entries(replacements)) {
    //   body = body.replaceAll(original, replacement!);
    // }
    for (let i = 0; i < body.length && i >= 0;) {
      const nextMatch = Object.entries(replacements).map(([o, n]) => [o, n!, body.indexOf(o, i)] as const).filter(x => x[2] !== -1);
      if (!nextMatch.length)
        break;
      const x = Math.min(...nextMatch.map(x => x[2]));
      const debug = body.slice(x, x + 100);
      const rep = nextMatch.find(m => m[2] === x)!;
      body = body.slice(0, x)+rep[1]+body.slice(x+rep[0].length);
      replaced++;
      i = x + rep[1].length;
    }
    if (replaced)
      return body;
    return null;
  }
},
);

serve({
  fetch: server.fetch,
  createServer,
  port: env.localPort,
  serverOptions: {
    key: env.httpsKey? readFileSync(env.httpsKey, `utf8`) : undefined,
    cert: env.httpsCert? readFileSync(env.httpsCert, `utf8`) : undefined,
  }}, (info) => {
  console.log(`Server started on https://${env.publicHost}:${env.publicPort} / https://localhost:${env.localPort}`);
});


function sessionPath(sessionId: string) {
  return `./db/session_${sessionId}.jsonl`;
}

export function realUrlToWrapped(realUrl: string, sessionId: string, publicHost: string) {
  const newURL = new URL(realUrl);
  const baseUrl = new URL(realUrl).host;
  newURL.host = `${sessionId.toLowerCase()}__${baseUrl.replaceAll(/([^.])\.([^.])/g, `$1_$2`)}__.${publicHost}`;
  return newURL;
}

