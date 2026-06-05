import { renderToStringAsync } from "preact-render-to-string";
import { Header } from "./Header";
import type { Session } from "./config";

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
): Promise<string> {
  const headerHtml = await renderToStringAsync(Header({ session, history }));
  body = body.replace(/(<\s*body[^>]*>)/i, `$1` + headerHtml + `<div id="web-syncr-spacer" style="height:2rem"></div>`);
  body = body.replace(/(<\/\s*head)/i, `<script>${injectedJs}</script>$1`);
  return body;
}
