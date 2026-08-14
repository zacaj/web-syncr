import type { PropOf } from "./objects";

export type FunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
}[keyof T];
export type EnumerableKeys<T> = keyof T extends infer U ? U : string;
// export type MockOfFn<F extends (...args: any) => any, Class = any> = jest.Mock<ReturnType<F>, Parameters<F>, Class>;
// export type SpyOfFn<Class extends Dict, Key extends FunctionKeys<Class>> = jest.SpyInstance<
//   ReturnType<Class[Key]>,
//   Parameters<Class[Key]>
// >;
export const iso8601Regex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/;

export type DeepPartial<T> = T extends object
  ? {
    [P in keyof T]?: DeepPartial<T[P]>;
  }
  : T;

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export type JSONObject = {[member: string]: JSONValue | undefined };
export type JSONArray = JSONValue[];

declare global {
  type Obj<V = any, K extends keyof any = PropertyKey> = {[key in K]?: V };

  // interface Obj<T = any> {
  //   [key: PropertyKey]: T | undefined;
  // }

  type Dict<T = any> = {
    [key: string]: T | undefined;
  };

  interface DictConstructor {
    keys<D extends Dict>(dict: D): PropOf<D>[];
  }

  var Dict: DictConstructor;

  type Hack = any;
}
Object.assign(globalThis, { Dict: Object }); // Dict = Object;// Dict.keys = Object.keys;//<D extends Dict>(dict: D) => Object.keys(dict);

export type ArrayElement<A> = A extends readonly (infer T)[] ? T : never;

export type KeyOfR<TObj extends object> = {
  [TKey in keyof TObj & (string | number)]:
  TObj[TKey] extends any[] ? `${TKey}` :
    TObj[TKey] extends object
      ? `${TKey}` | `${TKey}.${KeyOfR<TObj[TKey]>}`
      : `${TKey}`;
}[keyof TObj & (string | number)];

export type Nullable<T> = {
  [P in keyof T]: T[P] | null;
};

export type OptionalProps<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredProps<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

export type JsonDate = Opaque<`JsonDate`>; // if we feed a date into JSON from the API it comes out as a string, so for safety we shouldn't type them as Date but instead use Date.toISODateString()
export function jsonDate(date = new Date()) {
  return date.toISOString() as JsonDate;
}

// get all properties of parts of a type union
export type AllKeys<T> = T extends T ? keyof T : never;

// adds <key>?: undefined to parts of a type union (T) missing a key that another part of it contains, making optional property accesses compile safely
export type Undefinedify<T extends object, U = T> = T extends object
  ? {[K in AllKeys<U> as K extends keyof T ? never : K]?: undefined } & {[K in keyof T]: T[K] }
  : T;

export type UndefinedifyDeep<T extends object, U = Undefinedify<T>> = {
  [K in keyof U]: U[K] extends object ? UndefinedifyDeep<U[K]> : U[K];
};

// helper to apply UndefinedifyDeep to an object (and optionally transform the result via `cb`)
export const undefinedify = <
  T extends object | null | undefined,
  U = Undefinedify<Exclude<T, null | undefined>>,
  R = U
>(
  obj: T,
  cb: (obj: U) => R = (o) => o as any,
): T extends object ? R : T => (obj ? cb(obj as any) : obj) as any;
export const undefinedifyDeep = <
  T extends object | null | undefined,
  U = UndefinedifyDeep<Exclude<T, null | undefined>>,
  R = U
>(
  obj: T,
  cb: (obj: U) => R = (o) => o as any,
): T extends object ? R : T => (obj ? cb(obj as any) : obj) as any;


// makes a special type which acts just like T but isn't assignable to T
export type Opaque<Name extends string, T = string> = T & { __opaque__: Name };

export type ReadWrite<T> = {
  -readonly [P in keyof T]: T[P];
};
export type OrArray<T> = T|(T[]);

/** @deprecated */
export type AnyObj = Obj;

export class ImpossibleValueError extends Error {
  constructor(value: never, message = `Got impossible value`) {
    super(message + JSON.stringify(value as string));
  }
}

export type Assert<A, B extends A> = A;

export type Equals<T, V, Yes = true, No = false> = [T] extends [V] ? [V] extends [T] ? Yes : No : No;

export type ReplaceProp<O, P extends keyof O, T> = {[K in keyof O]: K extends P? T : O[K] };

export type Throws<Err extends Error> = Opaque<`Throws`, never>;

// A generic function type that takes an input I and returns an output O
type Fn<I, O> = (input: I) => O;

// Utility types to extract the input and output types of a function
type Input<F> = F extends Fn<infer U, any> ? U : never;
type Output<F> = F extends Fn<any, infer U> ? U : never;

// A recursive conditional type to validate the function chain
// It ensures the output of the head function matches the input of the tail
export type ChainLink<T extends any[], CurrentInput> = T extends [
  infer Head,
  ...infer Tail
]
  ? Head extends Fn<CurrentInput, infer Output>
    ? [Head, ...ChainLink<Tail, Output>]
    : never // Type error if the chain is broken
  : [];
