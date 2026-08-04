import { renderToStringAsync } from "preact-render-to-string";
import { Header } from "./Header";
import type { LoadMode, Session } from "./config";

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
  const headerHtml = await renderToStringAsync(Header({ session, history, mode }));
  // Strip CSP meta tags — the response headers are already stripped, but inline
  // <meta http-equiv="Content-Security-Policy"> would still block our injected handlers.
  body = body.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, ``);
  // Regex matches <body ...> accounting for quoted attributes that may contain special chars
  const bodyOpenRegex = /(<body(?:[^>"']|"[^"]*"|'[^']*')*>)/i;
  const suffix = `<script>window.__webSyncrMode=${JSON.stringify(mode)};` + injectedJs + `</script>` + headerHtml + `<div id="web-syncr-spacer" style="height:4rem"></div>`;
  // Replacer must be a function, not a string: a string replacer treats `$1`, `$&`,
  // `` $` ``, `$'` etc as backreference tokens, and injectedJs/headerHtml/the page's
  // own body tag can easily contain a literal "$" followed by a digit (injected.js's
  // own `$1_$2` dot-escaping regex text, for one) — which then gets silently swapped
  // for a captured/surrounding chunk of the page instead of staying literal text.
  body = body.replace(bodyOpenRegex, match => match + suffix);
  return body;
}
