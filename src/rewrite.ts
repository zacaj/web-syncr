import { renderToStringAsync } from "preact-render-to-string";
import { Header } from "./Header";
import type { LoadMode, Session } from "./config";

export function replaceAllPatterns(body: string, replacements: Dict<string>): string | null {
  let replaced = 0;
  for (let i = 0; i < body.length && i >= 0;) {
    const nextMatch = Object.entries(replacements)
      .map(([o, n]) => [o, n!, body.indexOf(o, i)] as const)
      .filter(x => x[2] !== -1);
    if (!nextMatch.length) break;
    const x = Math.min(...nextMatch.map(x => x[2]));
    const rep = nextMatch.find(m => m[2] === x)!;
    body = body.slice(0, x) + rep[1] + body.slice(x + rep[0].length);
    replaced++;
    i = x + rep[1].length;
  }
  return replaced ? body : null;
}

export async function injectHeaderAndScript(
  body: string,
  session: Session & { sessionId: string },
  history: Session[],
  injectedJs: string,
  mode: LoadMode = `proxy`,
): Promise<string> {
  const headerHtml = await renderToStringAsync(Header({ session, history, mode }));
  // Strip CSP meta tags — the response headers are already stripped, but inline
  // <meta http-equiv="Content-Security-Policy"> would still block our injected handlers.
  body = body.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, ``);
  body = body.replace(/(<\s*body[^>]*>)/i, `$1<script>window.__webSyncrMode=${JSON.stringify(mode)};${injectedJs}</script>` + headerHtml + `<div id="web-syncr-spacer" style="height:2rem"></div>`);
  return body;
}
