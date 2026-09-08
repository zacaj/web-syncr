import { jsonDate } from "@zacaj/util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { env, type SessionLiveState } from "./config";

/**
 * Live reading-position state, one record per session.
 *
 * Held in memory because it changes on every scroll settle — writing that to
 * the session JSONL would flood the navigation history, and writing it
 * synchronously to disk would put a file write on the scroll path. A debounced
 * snapshot to `session_{id}.state.json` is enough: losing a second or two of
 * scroll position across a server restart costs the user nothing, whereas
 * losing it entirely would mean a restart silently drops your place.
 */

const PERSIST_DEBOUNCE_MS = 2000;

const states = new Map<string, SessionLiveState>();
const pendingWrites = new Map<string, NodeJS.Timeout>();

function statePath(sessionId: string) {
  return `${env.dbPath}/session_${sessionId}.state.json`;
}

function schedulePersist(sessionId: string) {
  const existing = pendingWrites.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWrites.delete(sessionId);
    const state = states.get(sessionId);
    if (!state) return;
    try { writeFileSync(statePath(sessionId), JSON.stringify(state)) }
    catch (err) { console.warn(`Failed to persist live state for ${sessionId}:`, err) }
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the process open just to flush a scroll position.
  timer.unref();
  pendingWrites.set(sessionId, timer);
}

/** Current live state, hydrating from disk on first access after a restart. */
export function getLiveState(sessionId: string): SessionLiveState | null {
  const cached = states.get(sessionId);
  if (cached) return cached;
  const path = statePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const loaded = JSON.parse(readFileSync(path, `utf8`)) as SessionLiveState;
    states.set(sessionId, loaded);
    return loaded;
  } catch {
    return null;
  }
}

/**
 * Record a position published by `clientId`.
 *
 * Driver claims are last-write-wins with no arbitration: the user is one
 * person physically moving between devices, so a contested claim means they
 * touched two screens within seconds of each other and the most recent touch
 * is the one they meant.
 */
export function publishLiveState(
  sessionId: string,
  update: Pick<SessionLiveState, `url` | `anchor` | `deviceLabel`> & { clientId: string; claimDriver?: boolean },
): SessionLiveState {
  const prev = getLiveState(sessionId);
  // A missing prior state counts as a claim: the first device to publish in a
  // session is trivially the one being used.
  const keepDriver = prev !== null && !update.claimDriver;
  const driverId = keepDriver ? prev.driverId : update.clientId;
  // A non-claiming publish from someone who isn't the (possibly just-kept)
  // driver must not touch url/anchor/deviceLabel. Without this, a client
  // whose local `isDriver` flag has gone stale relative to the server — e.g.
  // a tab that was driving until another device claimed the role a moment
  // ago, and hasn't polled since — can still fire a claimDriver:false publish
  // (notably the `pagehide` beacon on reload) that loses the driverId check
  // but wins the position: driverId correctly stays with the real driver,
  // while url/anchor get silently overwritten with the stale tab's own data.
  if (keepDriver && driverId !== update.clientId) return prev!;
  const next: SessionLiveState = {
    driverId,
    driverSince: keepDriver ? prev!.driverSince : jsonDate(),
    seq: (prev?.seq ?? 0) + 1,
    url: update.url,
    anchor: update.anchor,
    deviceLabel: update.deviceLabel,
  };
  states.set(sessionId, next);
  schedulePersist(sessionId);
  return next;
}

/** Test/reset hook — drops in-memory state without touching disk. */
export function clearLiveState(sessionId: string) {
  states.delete(sessionId);
}

/**
 * Flush every debounced write immediately.
 *
 * The debounce trades a couple seconds of durability for keeping file writes
 * off the scroll path — fine for a crash, but not for a deploy, which kills
 * the process on a known schedule rather than an unpredictable one. Without
 * this, any position published in the last PERSIST_DEBOUNCE_MS before a
 * `docker compose` restart is silently lost: it's in memory, never hit disk,
 * and the fresh process has nothing to hydrate from.
 */
export function flushLiveState() {
  for (const [sessionId, timer] of pendingWrites) {
    clearTimeout(timer);
    pendingWrites.delete(sessionId);
    const state = states.get(sessionId);
    if (!state) continue;
    try { writeFileSync(statePath(sessionId), JSON.stringify(state)) }
    catch (err) { console.warn(`Failed to flush live state for ${sessionId}:`, err) }
  }
}
