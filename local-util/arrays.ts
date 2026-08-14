import { pick, type PickSatisfying } from "./objects";
import type { OrArray } from "./types";

declare global {
  interface Array<T> {
    remove(...elems: T[]): Array<T>;
    clear(): Array<T>;
    unique(): Array<T>;
    set(arr: T[]): Array<T>;
    last(): T|undefined;
    minus(...elems: T[]): Array<T>;
    oxford(last: string): string;
    nonOxford(last: string): string;
    insert(value: T, where: (before: T) => boolean): number;
    shuffle(rand?: () => number, times?: number): this;
    shuffled(rand?: () => number, times?: number): this;
    random(rand?: () => number): T;
    sum(conv?: (val: T, index: number) => number): number;
    avg(conv?: (val: T, index: number) => number): number;
    count(cb?: (val: T, index: number) => boolean): number;
    rotate(amount: number): this;
    truthy(): Array<NonNullable<T>>;
    chunk(size: number): { chunk: T[]; start: number; end: number }[];
    groupBy<K extends PropertyKey>(groupFn: (e: T, index: number) => K): Map<K, T[]>;
    groupOn<K extends PropertyKey>(groupFn: (e: T, index: number) => K): T[][];
    groupByObj<O>(groupFn: (e: T) => O): Map<O, T[]>;
    uniqueBy(groupFn: (e: T, index: number) => string): Map<string, T>;
    uniqueByObj<O>(groupFn: (e: T) => O): Map<O, T>;
    groupByKeys< K extends keyof T>(...keys: K[]): Map<Pick<T, K>, T[]>;
    groupByKey <K extends keyof T>(key: K): Map<T[K], T[]>;
    uniqueByKeys< K extends keyof T>(...keys: K[]): Map<Pick<T, K>, T>;
    uniqueByKey <K extends keyof T>(key: K): Map<T[K], T>;
    prop<K extends keyof T>(key: K): T[K][];
    $<K extends keyof T>(key: K): T[K][];
    pick<K extends keyof T, R = {[key in K]: T[key] }>(...keys: K[]): R[];
    sortBy<Key extends keyof PickSatisfying<T, string|number>>(by: Key, direction?: `asc`|`desc`): this;
    sortBy<R extends string|number>(by: ((e: T) => R), direction?: `asc`|`desc`): this;
    sortBySeq(...by: ((e: T) => number)[]): this; // asc, lower numbers first
    topBy(...by: ((e: T) => number)[]): T;  // get first with highest score returned from by
  }
}
Array.prototype.remove = function<T>(this: T[], ...elems: T[]): T[] {
  for (const element of elems) {
    let index: number;
    while ((index = this.indexOf(element)) !== -1) {
      this.splice(index, 1);
    }
  }
  return this;
};
Array.prototype.clear = function<T>(this: T[]): T[] {
  this.splice(0, this.length);
  return this;
};
Array.prototype.unique = function<T>(this: T[]): T[] {
  return Array.from(new Set<T>(this));
};
Array.prototype.set = function<T>(this: T[], that: T[]): T[] {
  this.splice(0, this.length, ...that);
  return this;
};
Array.prototype.last = function<T>(this: T[]): T|undefined {
  return this[this.length - 1];
};
Array.prototype.minus = function<T>(this: T[], ...elems: T[]): T[] {
  const arr = this.slice();
  return arr.remove(...elems);
};
Array.prototype.oxford = function<T>(this: T[], last: string): string {
  let str = this.slice(0, this.length-1).join(`, `);
  if (this.length > 2) str += `,`;
  if (this.length > 1) str += ` `+last+` `;
  return str+this.last();
};
Array.prototype.nonOxford = function<T>(this: T[], last: string): string {
  let str = this.slice(0, this.length-1).join(`, `);
  if (this.length > 1) str += ` `+last+` `;
  return str+this.last();
};
Array.prototype.insert = function<T>(this: T[], value: T, where: (before: T) => boolean): number {
  let pos = this.length;
  for (let i=0; i<this.length; i++) {
    if (where(this[i]!)) {
      pos = i;
      break;
    }
  }
  this.splice(pos, 0, value);
  return pos;
};
Array.prototype.shuffle = function<T>(this: T[], rand: () => number = () => Math.random(), times = 3): T[] {
  for (let k=0; k<times; k++) {
    for (let i = this.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [this[i] as any, this[j] as any] = [this[j], this[i]];
    }
  }
  return this;
};
Array.prototype.shuffled = function<T>(this: T[], rand: () => number = () => Math.random(), times = 3): T[] {
  return this.slice().shuffle(rand, times);
};
Array.prototype.random = function<T>(this: T[], rand: () => number = () => Math.random()): T {
  const j = Math.floor(rand() * (this.length));
  return this[j]!;
};
Array.prototype.sum = function<T>(this: T[], conv?: (val: T, index: number) => number): number {
  return this.reduce((prev, cur, index) => prev + (conv? conv(cur, index) : cur as number), 0);
};
Array.prototype.avg = function<T>(this: T[], conv?: (val: T, index: number) => number): number {
  return this.sum(conv)/this.length;
};
Array.prototype.count = function<T>(this: T[], cb: (val: T, index: number) => boolean): number {
  return this.filter(cb).length;
};
Array.prototype.rotate = function<T>(this: T[], amount: number): T[] {
  while (amount > 0) {
    this.unshift(this.pop()!);
    amount--;
  }
  while (amount < 0) {
    this.push(this.shift()!);
    amount++;
  }
  return this;
};
Array.prototype.truthy = function<T>(this: T[]): NonNullable<T>[] {

  return this.filter(x => !!x) as any;
};

Array.prototype.chunk = function<T>(this: T[], size: number) {
  const result = [];
  for (let i = 0; i < this.length; i += size) {
    result.push({ chunk: this.slice(i, i + size), start: i, end: i + size });
  }
  return result;
};

Array.prototype.groupBy = function<T, K extends PropertyKey>(this: T[], groupFn: (e: T, index: number) => K) {
  const ret = new Map<K, T[]>();
  this.forEach((v, i) => {
    const key = groupFn(v, i);
    if (!ret.get(key)?.push(v))
      ret.set(key, [v]);
  });
  return ret;
};

Array.prototype.groupOn = function<T, K extends PropertyKey>(this: T[], groupFn: (e: T, index: number) => K) {
  const ret = new Map<K, T[]>();
  this.forEach((v, i) => {
    const key = groupFn(v, i);
    if (!ret.get(key)?.push(v))
      ret.set(key, [v]);
  });
  return Array.from(ret.values());
};

Array.prototype.groupByObj = function <T, O>(this: T[], groupFn: (e: T) => O): Map<O, T[]> {
  return new Map(
    Object.values(
      this.reduce<{[key: string]: { keyObj: O; values: T[] }}>(
        (grouped, obj) => {
          const keyObj = groupFn(obj);
          const key = `${JSON.stringify(keyObj)}`;
          return {
            ...grouped,
            [key]: {
              keyObj,
              values: [...(grouped[key]?.values ?? []), obj],
            },
          };
        },
        {},
      ),
    ).map(({ keyObj, values }) => [keyObj, values]),
  );
};

Array.prototype.groupByKeys = function<T extends Obj, K extends keyof T>(this: T[], ...keys: K[]): Map<Pick<T, K>, T[]> {
  return this.groupByObj((o) => pick(o, ...keys));
};
Array.prototype.groupByKey = function<T extends Obj, K extends keyof T>(this: T[], key: K): Map<T[K], T[]> {
  return this.groupByObj((o) => o[key]);
};
Array.prototype.prop = function<T extends Obj, K extends keyof T>(this: T[], key: K): T[K][] {
  return this.map(e => e[key]);
};
Array.prototype.$ = Array.prototype.prop;
Array.prototype.pick = function<T extends Obj, K extends keyof T>(this: T[], ...keys: K[]) {
  return this.map(e => pick(e, ...keys)) as Hack;
};
Array.prototype.sortBy = function<T, R extends string|number, Key extends keyof PickSatisfying<T, R>>(this: T[], by: ((e: T) => R)|Key, direction = `asc`) {
  return this.sort((a, b) => {
    let aV: R;
    let bV: R;
    if (typeof by === `function`) {
      aV = by(a);
      bV = by(b);
    }
    else {
      aV = a[by] as R;
      bV = b[by] as R;
    }

    if (typeof aV === `string`)
      return aV.localeCompare(bV as string) * (direction===`asc`? 1:-1);
    else
      return ((aV as Hack)-(bV as Hack)) * (direction===`asc`? 1:-1);
  });
};
Array.prototype.sortBySeq = function<T>(this: T[], ...bys: ((e: T) => number)[]) {
  return this.sort((a, b) => {
    let aV: number;
    let bV: number;
    do {
      const by = bys.shift()!;
      aV = by(a);
      bV = by(b);
    } while (aV === bV && bys.length);
    return aV-bV;
  });
};
Array.prototype.topBy = function<T>(this: T[], ...by: ((e: T) => number)[]): T {
  let ret = this[0];
  let best = by.map(b => b(ret!));
  for (const e of this) {
    if (e === ret) continue;
    const score = by.map(b => b(e));
    for (let i=0; i<score.length; i++) {
      if (score[i]! > best[i]!) {
        ret = e;
        best = score;
      }
      else if (score[i]! < best[i]!)
        break;
    }
  }

  return ret!;
};


export function arrayify<T>(data?: OrArray<T>): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  else return [data];
}
export function seq<T = number>(count: number, start=0): T[] {
  const ret: T[] = [];
  for (let i=start; i<count+start; i++)
    ret.push(i as any);
  return ret;
}

export function range<T = number>(start: number, end: number): T[] {
  const ret: T[] = [];
  for (let i=start; i<=end; i++)
    ret.push(i as any);
  return ret;
}

export function repeat<T>(x: T | (() => T), count: number): T[] {
  const ret: T[] = [];
  for (let i=0; i<count; i++)
    ret.push(typeof x === `function`? (x as (() => T))() : x);
  return ret;
}


/**
 * Zips any number of iterables. It will always zip() the largest Iterable returning undefined for shorter arrays.
 * @param  {...Iterable<any>} iterables
 *
 * from https://stackoverflow.com/a/72221748/190164
 */
export function* zip<T>(...iterables: Iterable<T, BuiltinIteratorReturn>[]) {
  // get the iterator of for each iterables
  const iters = [...iterables].map((iterable) => iterable[Symbol.iterator]());
  let next = iters.map((iter) => iter.next().value);
  // as long as any of the iterables returns something, yield a value (zip longest)
  while (anyOf(next)) {
    yield next;
    next = iters.map((iter) => iter.next().value);
  }

  function anyOf(arr: Array<T|undefined>) {
    return arr.some(v => v !== undefined);
  }
}
