/**
 * Event-loop watchdog.
 *
 * web-syncr runs on a single Node event-loop thread (Hono / @hono/node-server).
 * If one request drives that thread into a synchronous busy-loop — a catastrophic
 * regex, an O(n²) transform, an unbounded loop — every *other* request starves and
 * the server appears "down", yet the process never exits, so the container's
 * restart-on-crash policy never fires. That is exactly the failure this guards
 * against (see the 2026-07-23 timeout incident).
 *
 * A same-thread timer cannot detect an *ongoing* block (it can't run while the loop
 * is blocked), so we monitor from a separate worker thread. The main thread bumps a
 * counter in shared memory once per `beatMs`. The worker — which has its own,
 * unaffected event loop — watches that counter; if it stops advancing for longer
 * than `thresholdMs`, the main thread is wedged and the worker hard-kills the whole
 * process (SIGKILL, un-catchable, so it works even mid-spin). The supervisor
 * (Docker `unless-stopped` / pnpm) then restarts a healthy process.
 *
 * The worker code is passed inline (`eval: true`) so there is no separate file to
 * resolve differently under tsx (dev) vs compiled JS (prod).
 */
import { Worker } from 'node:worker_threads';

export function startWatchdog(opts: { thresholdMs: number; beatMs?: number } = { thresholdMs: 30_000 }): () => void {
  const thresholdMs = opts.thresholdMs;
  if (!thresholdMs || thresholdMs <= 0) return () => {}; // disabled

  const beatMs = opts.beatMs ?? 1_000;
  const checkMs = Math.min(beatMs, 1_000);

  // Single Int32 counter in memory shared with the worker.
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);

  let tick = 0;
  const beat = setInterval(() => {
    // Wraps harmlessly at 2^31; the worker only checks for *change*, not value.
    tick = (tick + 1) | 0;
    Atomics.store(view, 0, tick);
  }, beatMs);
  // Don't let the heartbeat timer keep the process alive on its own.
  beat.unref();

  const workerCode = `
    const { workerData } = require('node:worker_threads');
    const view = new Int32Array(workerData.shared);
    const thresholdMs = workerData.thresholdMs;
    const checkMs = workerData.checkMs;
    let lastTick = Atomics.load(view, 0);
    let lastChange = Date.now();
    setInterval(() => {
      const cur = Atomics.load(view, 0);
      const now = Date.now();
      if (cur !== lastTick) { lastTick = cur; lastChange = now; return; }
      const stalledMs = now - lastChange;
      if (stalledMs > thresholdMs) {
        process.stderr.write(
          '[watchdog] event loop blocked for ' + stalledMs + 'ms (threshold ' +
          thresholdMs + 'ms) — hard-killing process so the supervisor can restart it\\n'
        );
        // SIGKILL the whole process; can't be blocked by the wedged main thread.
        try { process.kill(process.pid, 'SIGKILL'); } catch { process.exit(1); }
      }
    }, checkMs);
  `;

  const worker = new Worker(workerCode, {
    eval: true,
    workerData: { shared, thresholdMs, checkMs },
  });
  // The monitor must never be the reason the process stays up.
  worker.unref();
  worker.on(`error`, err => console.error(`[watchdog] monitor thread error:`, err));

  return () => {
    clearInterval(beat);
    void worker.terminate();
  };
}
