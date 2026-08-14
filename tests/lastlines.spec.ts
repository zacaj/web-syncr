import { expect, test } from '@playwright/test';
// Side-effect import: local-util/strings.ts installs a custom
// String.prototype.trimEnd/trimStart (accepting a char-class argument) that
// lastLines() below depends on. src/server.ts gets this for free via its own
// import of local-util/index; a test importing local-util/files in isolation
// would NOT have it installed, so we import it explicitly here to match real
// runtime behavior.
import 'local-util/index';
import { lastLines } from 'local-util/files';
import { unlinkSync, writeFileSync } from 'node:fs';

// Tests in this file can run in parallel across workers (fullyParallel), so
// each gets its own path rather than sharing one.
function tmpPath(name: string): string {
  return `/tmp/web-syncr-test-db-lastlines-${name}-${process.pid}.jsonl`;
}

test(`lastLines returns the last N lines, newest first, for an ordinary file`, () => {
  const path = tmpPath(`ordinary`);
  writeFileSync(path, `{"n":1}\n{"n":2}\n{"n":3}\n`);
  try {
    expect(lastLines(path, 20)).toEqual([`{"n":3}`, `{"n":2}`, `{"n":1}`]);
  } finally {
    unlinkSync(path);
  }
});

test(`lastLines terminates when a chunk read starts on a newline (was: infinite 100% CPU loop)`, () => {
  // A file under 1024 bytes whose FIRST byte is '\n' reproduces the exact
  // production hang: lastLines reads the whole file in one 1024-byte chunk, so
  // that leading '\n' is str[0]. Once endOffset (walking backward through
  // parsed lines) has consumed the whole chunk, `str.length-endOffset-1` goes
  // negative; lastIndexOf clamps a negative fromIndex to 0 instead of
  // returning -1, and since str[0] === '\n' it "finds" a match there forever —
  // endOffset climbs by 1 every iteration with no I/O and no exit. This matches
  // the 2026-07-23 incident exactly (CPU pegged at 105%, no further log
  // output), confirmed via a live CPU profile of the wedged process (97.9% of
  // samples in this function).
  const path = tmpPath(`leading-newline`);
  writeFileSync(path, `\n{"n":1}\n{"n":2}\n{"n":3}\n`);
  try {
    const start = Date.now();
    const lines = lastLines(path, 20);
    const elapsedMs = Date.now() - start;

    expect(lines).toEqual([`{"n":3}`, `{"n":2}`, `{"n":1}`]);
    expect(elapsedMs).toBeLessThan(2_000);
  } finally {
    unlinkSync(path);
  }
});

test(`lastLines respects maxLines and stops early`, () => {
  const path = tmpPath(`maxlines`);
  writeFileSync(path, `{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n`);
  try {
    expect(lastLines(path, 2)).toEqual([`{"n":4}`, `{"n":3}`]);
  } finally {
    unlinkSync(path);
  }
});
