import { lastJsonL } from "@common/util/files";
import { diffText } from "@common/util/primitives";
import { serve } from "@hono/node-server";
import "common/util/index";
import { jsonDate, type JsonDate, type Opaque } from "common/util/index";
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { prettyJSON } from 'hono/pretty-json';
import { proxy } from 'hono/proxy';
import { existsSync, readFileSync } from "node:fs";
import { createServer } from 'node:https';

const server = new Hono();

server.use(`*`, poweredBy());
server.use(`*`, logger());
server.onError((err, c) => {
  console.error(`${err}`, err);
  return c.text(`Custom Error Message`, 500);
});

const env = {
  localPort: 443,
  publicPort: 29443,
  publicHost: `localhost`,
};

type Session = {
  // id: Opaque<'session'>;
  url: string;
  timestamp: JsonDate;
};

server.all(`*`, async (c) => {
  const { req } = c;
  // const url = req.path.match(/(https?:\/\/.*$)/)?.[1];
  // if (!url)
  //   return c.text(`Couldn't find URL in '${req.url}'`);

  const _url = new URL(req.url);
  const subdomain = _url.hostname.split(`.${env.publicHost}`)[0];
  if (!subdomain)
    return c.text(`No subdomain found on `+_url);

  let [sessionIdOrBaseUrl, baseUrl] = subdomain.split(`_`, 2);
  let sessionId = sessionIdOrBaseUrl;
  if (!baseUrl && sessionIdOrBaseUrl?.includes(``)) {
    sessionId = undefined;
    baseUrl = sessionIdOrBaseUrl;
  }
  let session: Session|null;
  let realUrl: string;
  if (sessionId) {
    if (!baseUrl) {
      const _session = lastJsonL<Session>(`./db/sesson_${sessionId}.jsonl`, null);
      if (!_session)
        return c.text(`Invalid session "`+sessionId+`"`);

      session = _session;
      realUrl = session.url;
      baseUrl = new URL(realUrl).host;
    }
    else {
      const newUrl = new URL(req.url);
      newUrl.host = baseUrl+`:${env.localPort}`;
      newUrl.protocol = `https:`;
      realUrl = newUrl.toString();
      session = {
        url: newUrl.toString(),
        timestamp: jsonDate(),
      };
    }
  }
  else {
    if (baseUrl) {
      const newUrl = new URL(req.url);
      newUrl.host = baseUrl+`:${env.localPort}`;
      newUrl.protocol = `https:`;
      realUrl = newUrl.toString();
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
  replacements[baseUrl] ??= `${subdomain}.${env.publicHost}:${env.publicPort}`;
  replacements[encodeURIComponent(baseUrl)] ??= encodeURIComponent(`${subdomain}.${env.publicHost}:${env.publicPort}`);
  replacements[encodeURI(baseUrl)] ??= encodeURI(`${subdomain}.${env.publicHost}:${env.publicPort}`);

  const newBody = replaceAllPatterns(body, replacements);
  if (newBody) {
    console.info(`${realUrl}: replaced  v\n`+diffText(originalBody.wrap(), replaceAllPatterns(originalBody.wrap(), replacements)!)+`\n${realUrl}: replaced ^`);
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
    key: readFileSync(`./common/.config/localhost-key.pem`, `utf8`),
    cert: readFileSync(`./common/.config/localhost-cert.pem`, `utf8`),

  }}, (info) => {
  console.log(`Server started on https://${env.publicHost}:${env.publicPort}`);
});
