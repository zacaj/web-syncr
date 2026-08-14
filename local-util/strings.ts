import { WatchDirectoryFlags } from "typescript";
import { repeat } from "./arrays";
import { pick } from "./objects";
import type { Opaque, OrArray } from "./types";

declare global {
  interface String {
    splitUp(input: string, ...on: string[]): string[];
    wrap(this: string, maxLineLength?: number, insert?: string): string;
    trimEnd(this: string, what?: string|RegExp, alsoDefault?: `alsoWhitespace`): string;
    trimStart(this: string, what?: string|RegExp, alsoDefault?: `alsoWhitespace`): string;
  }

  type NumericStr = `${number}`;
}
declare global {
  interface RegExpConstructor {
    escape(str: string): string;
  }
}
String.prototype.splitUp = function(input: string, ...on: string[]): string[] {
  let at = 0;
  const ret: string[] = [];
  for (const x of on) {
    const next = input.indexOf(x, at);
    if (next === -1) {
      break;
    }
    ret.push(input.slice(at, next));
    at = next + x.length;
  }
  if (at < input.length)
    ret.push(input.slice(at));
  return ret;
};
String.prototype.wrap = function(this: string, maxLineLength = 120, insert = `\n`): string {
  return this.split(`\n`).flatMap(line => {
    if (line.length <= maxLineLength)
      return [line];
    const ret: string[] = [];
    let at = 0;
    do {
      const r =line.slice(at, at+maxLineLength);
      at += r.length;
      ret.push(r);
    }
    while (line.length-at > maxLineLength);
    ret.push(line.slice(at));
    return ret;
  }).join(insert);
};
String.prototype.trimEnd = function(this: string, what?: string|RegExp, alsoDefault?: `alsoWhitespace`): string {
  if (!what) {
    const mvsIsWS = (/^\s$/).test(`\u180E`);
    /* eslint-disable no-control-regex */
    // from https://github.com/es-shims/String.prototype.trimEnd/blob/main/implementation.js
    what = mvsIsWS
      ? /[\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF]+$/
      : /[\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF]+$/;
    /* eslint-enable no-control-regex */
  }
  else if (what instanceof RegExp) {
    if (!what.source.endsWith(`$`))
      what = new RegExp(what.source+`$`);
  }

  return (alsoDefault===`alsoWhitespace`? this.trimEnd() : this).replace(typeof what === `string`? new RegExp(RegExp.escape(what)+`$`) : what, ``);
};
String.prototype.trimStart = function(this: string, what?: string|RegExp, alsoDefault?: `alsoWhitespace`): string {
  if (!what) {
    const mvsIsWS = (/^\s$/).test(`\u180E`);
    /* eslint-disable no-control-regex */
    what = mvsIsWS
      ? /[\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF]+$/
      : /[\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF]+$/;
    /* eslint-enable no-control-regex */
  }
  else if (what instanceof RegExp) {
    if (!what.source.startsWith(`^`))
      what = new RegExp(what.source+`^`);
  }

  return (alsoDefault===`alsoWhitespace`? this.trimStart() : this).replace(typeof what === `string`? new RegExp(`^`+RegExp.escape(what)) : what, ``);
};

export const zidRegex = /[A-Z][A-Z\d][a-z][A-Za-z\d_]{13}/;
export const zid = <T extends string = ``>(prefix?: T) => ((prefix??``)+`abcdefghijklmnopqrstuvwxyz`.split(``).random()+
  repeat(() => `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890`.split(``).random(), 13).join(``)) as Opaque<T>;
