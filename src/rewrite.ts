import { readFileSync } from "node:fs";
import { renderToStringAsync } from "preact-render-to-string";
import { Header } from "./Header";
import { readSessionConfig, type LoadMode, type Session } from "./config";

/**
 * Remove every `<script>` from an HTML document.
 *
 * Only ever applied to a magicurl snapshot (a DOM that is already rendered), and
 * always *before* `injectHeaderAndScript`, so our own injected script survives.
 * See `LoadMode` for why this is unsafe on a live proxied page.
 */
export function stripScripts(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ``)
    // Self-closing / unterminated tags left over after the paired pass.
    .replace(/<script\b[^>]*\/?>/gi, ``);
}

/**
 * Embed a string in an inline `<script>` safely.
 *
 * `JSON.stringify` alone is not enough: it leaves `</script>` intact, and the
 * HTML parser ends the script block at that byte sequence regardless of JS
 * string context. The header markup carries raw JS event-handler attributes, so
 * this is a real possibility rather than a theoretical one.
 */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/<\//g, `<\\/`);
}

/**
 * Replace every occurrence of each key in `replacements` with its value.
 *
 * Single forward pass: we collect output slices into an array and `join` once at
 * the end, instead of rebuilding the whole `body` string on every match. The old
 * implementation was O(n·M) (a full ~n-byte reallocation per match) which, on a
 * large page with many matches, could burn the single event-loop thread for a
 * long time. This version is O(n · keys) — effectively linear, since there are
 * only ever ≤3 keys (raw / encodeURI / encodeURIComponent of the base URL).
 *
 * A `nextPos` memo per key means a key that no longer matches is never re-scanned
 * to end-of-string on every iteration, which is what made the naive loop quadratic.
 */
export function replaceAllPatterns(body: string, replacements: Dict<string>): string | null {
  // Empty keys would match at every index and never advance — drop them.
  const keys = Object.keys(replacements).filter(k => k.length > 0);
  if (!keys.length) return null;

  // nextPos[k] = index of the next occurrence of k at or after our cursor, or -1.
  const nextPos: Record<string, number> = {};
  for (const k of keys) nextPos[k] = body.indexOf(k);

  const out: string[] = [];
  let i = 0;
  let replaced = 0;
  const len = body.length;
  while (i < len) {
    let bestPos = -1;
    let bestKey = ``;
    for (const k of keys) {
      let p = nextPos[k]!;
      // The cursor may have jumped past a stale hit (a longer key won the last
      // round) — re-scan from the cursor, but only when actually stale.
      if (p !== -1 && p < i) {
        p = body.indexOf(k, i);
        nextPos[k] = p;
      }
      if (p !== -1 && (bestPos === -1 || p < bestPos)) {
        bestPos = p;
        bestKey = k;
      }
    }
    if (bestPos === -1) {
      out.push(body.slice(i));
      break;
    }
    out.push(body.slice(i, bestPos), replacements[bestKey]!);
    i = bestPos + bestKey.length;
    nextPos[bestKey] = body.indexOf(bestKey, i);
    replaced++;
  }
  return replaced ? out.join(``) : null;
}

export async function injectHeaderAndScript(
  body: string,
  session: Session & { sessionId: string },
  history: Session[],
  injectedJs: string,
  mode: LoadMode = `proxy`,
): Promise<string> {
  const syncMode = readSessionConfig(session.sessionId).syncMode ?? `off`;
  const headerHtml = await renderToStringAsync(Header({ session, history, mode, syncMode }));
  // Read here rather than taking it as a parameter like injectedJs: it never
  // varies by caller, and threading it through all six call sites in server.ts
  // would be noise. Re-read per request to match injected.js's dev-reload feel.
  const anchorJs = readFileSync(`./src/anchor.js`, `utf8`);
  // Strip CSP meta tags — the response headers are already stripped, but inline
  // <meta http-equiv="Content-Security-Policy"> would still block our injected handlers.
  body = body.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, ``);
  // Regex matches <body ...> accounting for quoted attributes that may contain special chars
  const bodyOpenRegex = /(<body(?:[^>"']|"[^"]*"|'[^']*')*>)/i;
  // The header is deliberately NOT emitted as markup here.
  //
  // Sites that hydrate React over the served HTML (Next.js App Router hydrates
  // the whole document) reconcile <body>'s children *positionally*, so any
  // element we inject is a mismatch: React throws a hydration error and deletes
  // our nodes — the header would vanish on every such site. An injected
  // <script> is tolerated, so we ship the markup as a string and mount it from
  // JS after hydration has finished.
  //
  // Three details matter:
  //  - mount on `load`, not at parse time, so hydration is already done;
  //  - append the host to <html> rather than <body>, keeping it clear of the
  //    children React reconciles (but still in the light DOM, so anchor.js's
  //    `getElementById('web-syncr-header')` and injected.js's pill lookups keep
  //    working — a shadow root would break both);
  //  - re-check on an interval, so a client-side route change or framework
  //    re-render that drops the host heals itself.
  // Content offset is body padding rather than a spacer element, for the same
  // "no extra <body> children" reason.
  const mountJs = `
(function(){
  var HTML = ${jsString(headerHtml)};
  function mount(){
    if (document.getElementById('web-syncr-root')) return;
    var host = document.createElement('div');
    host.id = 'web-syncr-root';
    host.innerHTML = HTML;
    document.documentElement.appendChild(host);
    try { document.body.style.paddingTop = '4rem' } catch (e) { /* no body yet */ }
  }
  function start(){ mount(); setInterval(mount, 1000) }
  if (document.readyState === 'complete') start();
  else addEventListener('load', start);
})();
`;
  const suffix = `<script>window.__webSyncrMode=${JSON.stringify(mode)};window.__webSyncrSyncMode=${JSON.stringify(syncMode)};`
    + mountJs + anchorJs + injectedJs + `</script>`;
  // Replacer must be a function, not a string: a string replacer treats `$1`, `$&`,
  // `` $` ``, `$'` etc as backreference tokens, and injectedJs/headerHtml/the page's
  // own body tag can easily contain a literal "$" followed by a digit (injected.js's
  // own `$1_$2` dot-escaping regex text, for one) — which then gets silently swapped
  // for a captured/surrounding chunk of the page instead of staying literal text.
  body = body.replace(bodyOpenRegex, match => match + suffix);
  return body;
}
