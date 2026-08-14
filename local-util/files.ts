
import { promises as readline } from 'readline';
// export async function* streamJsonL<T extends JSONValue>(path: string): AsyncGenerator<T, void, unknown>;
// export async function* streamJsonL<T extends JSONValue, Default extends T>(path: string, onNoFile?: 'errorOnNoFile'): AsyncGenerator<T | Default, void, unknown> {
export async function* streamJsonL<T extends JSONValue>(path: string, onNoFile?: `errorOnNoFile`): AsyncGenerator<T, void, unknown> {
  // if (notExistsValue !== undefined)
  //   if (!existsSync(path))
  //     yield* notExistsValue;
  if (onNoFile !== `errorOnNoFile`)
    if (!existsSync(path))
      return;
  // stream.on(`error`, (err: any) => {
  //   if (err.code === `ENOENT`) {
      //   yield notExistsValue[0];
      // }});

  const stream = createReadStream(path);

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  // const jsonl = await fs.readFile(path, `utf-8`);
  // return rl.
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as T;
    }
    catch (err) {
      console.error(`could not parse JSON '${line}' from file '${path}'`, err);
      throw err;
    }
  }
}

export function readJsonL<T extends JSONValue>(path: string, onNoFile?: `errorOnNoFile`): T[]|undefined {
  if (onNoFile !== `errorOnNoFile`)
    if (!existsSync(path))
      return undefined;
  return readFileSync(path, { encoding: `utf-8` }).split(`\n`).filter(l => !!l.trim()).map(l => JSON.parse(l) as T);
}

// export async function findJsonL<T extends JSONValue>(path: string, cb: (value: T) => boolean): Promise<T|undefined>;
// export async function findJsonL<T extends JSONValue>(path: string, cb: (value: T) => boolean, defaultValue: T): Promise<T>;
// export async function findJsonL<T extends JSONValue>(path: string, cb: (value: T) => boolean, defaultValue: null): Promise<T|null>;
export async function findJsonL<T extends JSONValue>(path: string, cb: (value: T) => boolean, onNoFile?: `errorOnNoFile`): Promise<T|undefined> {
  if (onNoFile !== `errorOnNoFile`)
    if (!existsSync(path))
      return undefined;

  for await (const row of streamJsonL<T>(path)) {
    if (cb(row))
      return row;
  }

  return undefined;
  // return notExistsValue as Hack;
}

import { appendFileSync, closeSync, createReadStream, existsSync, promises as fs, openSync, readdirSync, readSync, statSync } from 'fs';
import { removeKeys } from './objects';
import { number } from './primitives';
import type { JSONValue } from './types';
export function appendJsonL<T extends Dict>(path: string, line: T): T {
  const o: Dict = {};
  if (`timestamp` in line)
    o.timestamp = line.timestamp;
  if (`message` in line)
    o.message = line.message;
  appendFileSync(path, JSON.stringify({ ...o, ...removeKeys(line, `timestamp`, `message`) })+`\n`);
  return line;
}

export function lastJsonL<T extends JSONValue>(path: string): T;
export function lastJsonL<T extends JSONValue, Default extends T|null>(path: string, notExistsValue?: Default): T | Default {
  if (notExistsValue !== undefined)
    if (!existsSync(path))
      return notExistsValue;

  return lastJsonLs<T>(path, 1)[0]!;
}
export function lastJsonLs<T extends JSONValue>(path: string, maxLines: number, notExistsValue?: T[]): T[];
export function lastJsonLs<T extends JSONValue, Default extends T>(path: string, maxLines: number, notExistsValue?: Default[]): T[] | Default[] {
  if (notExistsValue !== undefined)
    if (!existsSync(path))
      return notExistsValue;

  const lines = lastLines(path, maxLines);
  return lines.map(line => {
    try {
      return JSON.parse(line) as T;
    }
    catch (err) {
      console.error(`could not parse JSON '`+line+`' from file '${path}'`, err);
      throw err;
    }
  });
}

export function lastLine(path: string) {
  return lastLines(path, 1)[0]!;
}
export function lastLines(path: string, maxLines: number): string[] {
  const chunkSize = 1024;
  let fd = 0;
  const ret: string[] = [];
  try {
    const stat = statSync(path);
    fd = openSync(path, `r`);
    let end = stat.size;
    const buffer = Buffer.alloc(chunkSize);
    let lastStr = ``;
    while (end >=0) {
      buffer.fill(0);
      // Bound toString() to bytesRead — a partial chunk otherwise decodes the
      // trailing zero-fill as literal NUL characters, relying entirely on
      // strings.ts's custom trimEnd(/[\0\r ]*/) (a global side effect) to strip
      // them back out.
      const bytesRead = readSync(fd, buffer, 0, Math.min(chunkSize, end), Math.max(end-chunkSize, 0));
      const str = buffer.toString(`utf8`, 0, bytesRead).trimEnd(/[\0\r ]*/);
      let endOffset = 0;
      if (str.endsWith(`\n`)) {
        if (lastStr.trim()) {
          ret.push(lastStr.trim());
          if (ret.length === maxLines)
            return ret;
          lastStr = ``;
        }

        endOffset = 1;
      }
      do {
        // Once endOffset consumes the whole chunk, this index goes negative.
        // lastIndexOf clamps a negative fromIndex to 0 instead of returning -1,
        // so if str[0] happens to be '\n' it keeps "finding" position 0 forever
        // — endOffset climbs by 1 every iteration and the loop never reaches
        // the terminating else-branch. Confirmed by live CPU profile (97.9% of
        // samples here) during the 2026-07-23 hang.
        const searchIdx = str.length - endOffset - 1;
        const newLine = searchIdx < 0 ? -1 : str.lastIndexOf(`\n`, searchIdx);
        if (newLine !== -1) {
          const line = str.slice(newLine + 1, -endOffset || str.length);
          if (line.trim()) {
            ret.push(line.trim()+ lastStr);
            if (ret.length === maxLines)
              return ret;
            lastStr = ``;
          }
          endOffset += line.length+1;
        }
        else {
          lastStr = str.slice(0, -endOffset || str.length).trim() + lastStr;
          break;
        }
      } while (true);
      end -= chunkSize;
    }
    if (lastStr.trim())
      ret.push(lastStr.trim());
    return ret;
  }
  finally {
    if (fd)
      closeSync(fd);
  }
}

import { readFileSync } from 'node:fs';
import * as Path from 'node:path';
export function listFiles(path: string, { ext, regex }: { ext?: string; regex?: RegExp } = {}): string[] {
  return readdirSync(path, { withFileTypes: true }).filter(t => {
    if (t.isDirectory()) return false;
    if (t.isSymbolicLink()) throw new Error(`unimplemented`);
    return t.isFile();
  })
    .filter(t => {
      if (ext && !t.name.endsWith(ext))
        return false;
      if (regex && !regex.test(t.name))
        return false;
      return true;
    })
    .map(t => Path.join(path, t.name));
}
