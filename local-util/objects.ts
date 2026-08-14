// import type { Dict, Obj } from "./types";

import type { Key } from "readline";
import { iso8601Regex, type AnyObj, type DeepPartial, type KeyOfR } from "./types";

export function getPropertyDescriptor<O extends Obj>(o: O|undefined, key: keyof O): PropertyDescriptor|undefined {
  if (!o) return undefined;
  const own = Object.getOwnPropertyDescriptor(o, key);
  if (own) return own;
  return getPropertyDescriptor(Object.getPrototypeOf(o) as O, key);
}

export function objectMap<Obj extends Record<any, any>, TResult, KResult extends PropertyKey = keyof Obj>(
  obj: Obj,
  valSelector: (val: Obj[keyof Obj], key: keyof Obj) => TResult,
  keySelector?: (key: keyof Obj, obj: Obj) => KResult,
  ctx?: any,
) {
  const ret = {} as Record<KResult, TResult>;
  for (const key of Object.keys(obj)) {
    const retKey = keySelector
      ? keySelector.call(ctx ?? null, key as any, obj)
      : key as KResult;
    const retVal = valSelector.call(ctx ?? null, obj[key], key);
    ret[retKey] = retVal;
  }
  return ret;
}

// makes a new object containing only the specified properties from `obj`
export function pick <T extends object, K extends keyof T, R = {[key in K]: T[key] }>(obj: T, ...keys: Array<K>): R {
  // return Object.entries(obj).reduce(
  //   (a, [k, v]) => {
  //     if (keys.includes(k)) {
  //       a[k] = v;
  //     }
  //     return a;
  //   },
  //   {} as Pick<T, keyof T>,
  // );

  return keys.reduce<Partial<T>>((o, key) => {
    o[key] = obj[key];
    return o;
  }, {}) as R;
};

export const hasKey = <O extends object>(obj: O, key: PropertyKey): key is keyof O => {
  return key in obj;
};

export const hasVal = <O extends object>(obj: O, key: PropertyKey): key is keyof O => {
  return key in obj && !!(obj as any)[key];
};

export const valOr = <O extends object, D = undefined>(obj: O, key: PropertyKey, def?: D): D => {
  return (key in obj && !!(obj as any)[key])? (obj as any)[key] : def as D;
};

declare global {
  interface Object {
  //   keys<K extends keyof typeof this>(): (K)[];
  //   entries<T = typeof this>(): [keyof T, T[keyof T]][];
    pick<T extends this, K extends keyof T>(...keys: Array<K>): {[key in K]: T[K] };
    has<T extends this>(key: PropertyKey): key is keyof T;
  }

  // interface ObjectConstructor {
  //   keys<T extends object>(o: T): (keyof T)[];
  //   values<T extends object>(o: T): (T[keyof T])[];
  //   entries<O extends object>(o: O): [keyof O, O[keyof O]][];
  // }
}

// Object.prototype.pick = pick as any;
// Object.prototype.has = hasVal as any;


export const removeNullProperties = <T extends object>(originalObj: T, recursive = false): T => {
  const newObj = {} as T;

  for (const key in originalObj) {
    if (Object.prototype.hasOwnProperty.call(originalObj, key) && originalObj[key] !== null) {
      const value = originalObj[key];
      newObj[key] =
        typeof value === `object` && recursive
          ? removeNullProperties<T[Extract<keyof T, string>] & object>(value as any, recursive)
          : value;
    }
  }

  return newObj;
};

// performs {...current, ...updates} recursively
export function deepMergeObject(current?: AnyObj, updates?: AnyObj): AnyObj | undefined {
  if (!current || !updates) return current ?? updates;
  current = { ...current };
  for (const key of Object.keys(updates)) {
    if (!Object.prototype.hasOwnProperty.call(current, key) || typeof updates[key] !== `object`)
      current[key] = updates[key];
    else if (Array.isArray(current[key]) || Array.isArray(updates[key])) {
      current[key] = updates[key];
    }
    else if ((hasVal(current, key) && (current[key]).constructor !== `Object`) || (hasVal(updates, key) && (updates[key]).constructor !== `Object`)) {
      current[key] = updates[key];
    }
    else (current as any)[key] = deepMergeObject(current[key], updates[key]);
  }
  return current;
}

export function deepEquals<T>(a: T, b: T): boolean {
  if (!a !== !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEquals(x, b[i]));
  }

  if (typeof a !== typeof b) return false;
  if (typeof a === `object`) {
    if (!a) return !b;
    const keys = Object.keys(a as any);
    if (!deepEquals(keys, Object.keys(b as any))) return false;
    return keys.every((k) => deepEquals((a as any)[k], (b as any)[k]));
  }

  return a === b;
}

export function extendObj<T extends object>(a: T, b: DeepPartial<T>): any {
  return deepMergeObject(a, b);
}



// recursively removes any properties with names in `props` from `obj`
// useful for snapshot testing when some fields like PKs change every test invocation
//
// use $dates as a prop to remove all dates
export const removeProperties = <T = any>(obj: T, ...props: (keyof T | PropertyKey | `$dates`)[]): T => {
  if (!obj) return obj;
  if (typeof obj !== `object` || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map((x: any) => removeProperties(x, ...props)) as T;
  const o: any = { ...obj };
  for (const key of Object.keys(o)) {
    if (props.includes(key)) delete o[key];
    if (
      props.includes(`$dates`) &&
      (o[key] instanceof Date || (typeof o[key] === `string` && iso8601Regex.test(o[key])))
    )
      delete o[key];
    else if (typeof o[key] === `object`) o[key] = removeProperties(o[key], ...props);
  }
  return o;
};
// returns only properties named in `props` from `obj` recursively, including arrays.  (maintains object structure)
export const filterProperties = <T extends object, K extends KeyOfR<T>>(obj: T|Nullish, ...props: K[]): T => {
  if (!obj) return obj as any;
  if (typeof obj !== `object` || obj instanceof Date) return obj;
  if (Array.isArray(obj)) {
    if (typeof obj[0] === `object`)
      return (obj as object[]).map((x) => filterProperties(x as any, ...props as any)).filter((x: any) => !!Object.keys(x).length) as T;
    return obj;
  }

  const o: any = { ...obj };
  for (const key of Object.keys(o)) {
    if (
      typeof o[key] === `object` &&
      !(o[key] instanceof Date) &&
      o[key] &&
      (!Array.isArray(o[key]) || typeof o[key][0] === `object`) &&
      !props.includes(key as K)
    ) {
      o[key] = filterProperties(o[key], ...props);
      if (Object.keys(o[key]).length === 0) delete o[key];
    } else if (!props.includes(key as K)) delete o[key];
  }
  return o;
};

// calls `cb` for all properties of obj and any objects recursively (including arrays) inside obj
export const forAllProps = <T extends Dict>(
  obj: T | Nullish,
  cb: (key: KeyOfR<T>, value: any, obj: any, path: string) => void,
  path = ``,
) => {
  if (!obj) return;
  if (typeof obj !== `object` || obj instanceof Date) return;
  if (Array.isArray(obj)) {
    if (typeof obj[0] === `object`) (obj as object[]).map((x, i) => forAllProps(x as any, cb, `${path}[${i}]`));
    return;
  }

  for (const key of Object.keys(obj) as KeyOfR<T>[]) {
    if (
      typeof obj[key] === `object` &&
      !(obj[key] as any instanceof Date) &&
      obj[key] &&
      (!Array.isArray(obj[key]) || typeof obj[key][0] === `object`)
    ) {
      forAllProps<T>(obj[key], cb, path ? `${path}.${key}` : key);
    } else {
      cb(key, obj[key], obj, path);
    }
  }
};


export function filterObj<T extends Obj>(obj: T, pred: (key: keyof T, val: T[keyof T]) => boolean): Partial<T> {
  const n: any = {};
  for (const [key, val] of Object.entries(obj)) {
    if (pred(key, val))
      n[key] = val;
  }
  return n;
}

export function removeKeys<T extends Dict, Keys extends keyof T>(obj: T, ...keys: Keys[]): Omit<T, Keys> {
  return filterObj(obj, (key) => !keys.includes(key as any)) as any;
}

export function mapObjFields<T extends Obj, O extends {[key in keyof T]: any } = T>(obj: T, pred: <Key extends keyof T>(key: Key, val: T[keyof T]) => O[Key]): O {
  const n: O = {} as any;
  for (const [key, _val] of Object.entries(obj)) {
    (n as any)[key] = pred(key, obj[key]);
  }
  return n;
}

export type PairsMatchingValue<T, V> = {[K in keyof T as T[K] extends V? K:never]: T[K] };



export interface AnyDeepKeyAndValue<K extends string = string, V = any> {
  key: K;
  value: V;
}
export type UnknownAccessor<TParent extends AnyDeepKeyAndValue> = TParent[`key`] extends never ? string : `${TParent[`key`]}.${string}`;
export interface UnknownDeepKeyAndValue<TParent extends AnyDeepKeyAndValue> extends AnyDeepKeyAndValue {
  key: UnknownAccessor<TParent>;
  value: unknown;
}
// export type DeepKeysAndValues<T> = DeepKeysAndValuesImpl<T> extends AnyDeepKeyAndValue ? DeepKeysAndValuesImpl<T> : never;
// export type DeepKeysAndValuesImpl<T, TParent extends AnyDeepKeyAndValue = never, TAcc = never> = unknown extends T ? TAcc | UnknownDeepKeyAndValue<TParent> : unknown extends T ? T : T extends string | number | boolean | bigint | Date ? TAcc : T extends ReadonlyArray<any> ? number extends T[`length`] ? DeepKeyAndValueArray<TParent, T, TAcc> : DeepKeyAndValueTuple<TParent, T, TAcc> : keyof T extends never ? TAcc | UnknownDeepKeyAndValue<TParent> : T extends object ? DeepKeyAndValueObject<TParent, T, TAcc> : TAcc;
// export type DeepRecord<T> = {
//   [TRecord in DeepKeysAndValues<T> as TRecord[`key`]]: TRecord[`value`];
// };
/**
 * The keys of an object or array, deeply nested.
 */
// export type DeepKeys<T> = unknown extends T ? string : DeepKeysAndValues<T>[`key`];
/**
 * Infer the type of a deeply nested property within an object or an array.
 */
// export type DeepValue<TValue, TAccessor> = unknown extends TValue ? TValue : TAccessor extends DeepKeys<TValue> ? DeepRecord<TValue>[TAccessor] : never;
/**
 * The keys of an object or array, deeply nested and only with a value of TValue
 */
// export type DeepKeysOfType<TData, TValue> = Extract<DeepKeysAndValues<TData>, AnyDeepKeyAndValue<string, TValue>>[`key`];
/**
 * Maps the deep keys of TFormData to the shallow keys of TFieldGroupData.
 *  Since using template strings as keys is impractical, it relies on shallow keys only.
 */
// export type FieldsMap<TFormData, TFieldGroupData> = TFieldGroupData extends any[] ? never : string extends keyof TFieldGroupData ? never : {
//   [K in keyof TFieldGroupData]: DeepKeysOfType<TFormData, TFieldGroupData[K]>;
// };


export type PickSatisfying<T, S> = {[K in keyof T]: S extends T[K]? T[K]:never };

export type PropOf<T extends Dict> = (keyof T)&string;
