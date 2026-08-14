export function short(number: number, minWidth = 0): string {
  const SI_PREFIXES = [
    { value: 1, symbol: `` },
    { value: 1e3, symbol: `k` },
    { value: 1e6, symbol: `M` },
    { value: 1e9, symbol: `G` },
    { value: 1e12, symbol: `T` },
    { value: 1e15, symbol: `P` },
    { value: 1e18, symbol: `E` },

  ].reverse();

  if (number === 0) return `00`;

  const tier = SI_PREFIXES.find((n) => number >= n.value)!;
  let numberFixed = (number / tier.value).toFixed(1);
  if (numberFixed.endsWith(`.0`))
    numberFixed = numberFixed.slice(0, numberFixed.length-2);

  return `${numberFixed}${tier.symbol}`.padStart(minWidth, ` `);
}

export function round(num: number, nearest: number, lowest = 0) {
  return Math.max(lowest, Math.ceil(num/nearest)*nearest);
}
export function roundDown(num: number, nearest: number, lowest = 0) {
  return Math.max(lowest, Math.floor(num/nearest)*nearest);
}


export function comma(value: number, minWidth = 0): string {
  const s = Math.abs(value).toFixed();
  const commad = (value<0? `-`:``)+Array.from({ length: Math.ceil(s.length/3) },
    (_, i) => s.slice(i*3-(i===0?0:3-(s.length%3||3)), i===0? s.length%3||3 : 3)).join(`,`);
  return commad.padStart(minWidth, ` `);
}

export function money(value: number, minWidth = 0, plus = ``): string {
  const s = comma(value, 0);
  return ((s.startsWith(`-`)? `-`:plus)+`$`+(s.startsWith(`-`)? s.slice(1):s)).padStart(minWidth, ` `);
}

export function isDebugging(): boolean {
  const argv = process.execArgv.join();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-call
  const isDebug = argv.includes(`inspect`) || argv.includes(`debug`) || !!require(`inspector`).url();
  return isDebug;
}

export type HashHaver = {
  hash: string;
};
export function eq<T>(a: T, b: T): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => eq(v, b[i]));
  }

  if (typeof a === `object` && typeof b === `object` && a && b) {
    if (`hash` in a && `hash` in b)
      return (a as HashHaver).hash === (b as HashHaver).hash;
  }

  return a === b;
}

export function wrap(i: number, max: number, min = 0): number {
  if (i < 0) return wrap(max + i, max, min);
  if (i >= max) return wrap(i - max, max, min);
  return i;
}

export function num(input: string, def?: number): number {
  const num = parseInt(input, 10);
  if (isNaN(num)) {
    if (def !== undefined) return def;
    else throw new Error(`could not parse '${input}' as number`);
  }
  return num;
}

export function number<T>(val: T): number | null | (T extends undefined? undefined : never) {
  if (val === undefined) return undefined as any;
  if (!val) return null;
  const n = Number(val);
  if (Number.isNaN(n)) return null;
  return n;
}


export function tryNum(str: any): number|undefined {
  if (typeof str === `number`) return str;
  const first = (str as string).charCodeAt(0);
  if (first >= 48 && first <= 57) return str as number;
  try {
    return num(str);
  } catch {
    return undefined;
  }
}


export function isNum(input: any): boolean {
  return (typeof input === `number` && !Number.isNaN(input)) || tryNum(input) !== undefined;
}

declare global {
  type Nullish = null | undefined;
  type Falsy = Nullish | false | ``;
}

import { type diff as JestDiff } from 'jest-diff';
export function diffText(a: string, b: string, options?: Parameters<typeof JestDiff>[2]): string | null {
  const jestDiff= require(`jest-diff`).diff as typeof JestDiff; // eslint-disable-line @typescript-eslint/no-require-imports
  const chalk = require(`chalk`); // eslint-disable-line @typescript-eslint/no-require-imports
  const diff = jestDiff(a, b, {
    aAnnotation: `original`,
    bAnnotation: `new`,
    aColor: chalk.red,
    bColor: chalk.green,
    contextLines: 2,
    includeChangeCounts: true,
    expand: false,
    patchColor: chalk.yellow,
    ...options,
  });
  if (diff && !diff.includes(`Compared values have no visual difference.`))
    return diff;
  return null;
}


declare global {
  interface Number {
    factorial(): number;
    choose(k: number): number;
  }
}
Number.prototype.factorial = function(this: number) {
  if (this<=1) return 1;
  return this * (this-1).factorial();
};
Number.prototype.choose = function(this: number, k: number) {
  return biCoef(this, k);
};

export function biCoef(n: number, k: number): number {
  return n.factorial() / (k.factorial()*(n-k).factorial());
}
