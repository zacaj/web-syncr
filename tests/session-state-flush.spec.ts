import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as https from 'node:https';
import { expect, test } from '@playwright/test';
import { jsonDate } from '@zacaj/util';
import type { SessionLiveState } from '../src/config';
import { readDotEnv, waitForServer } from './global-setup';

/**
 * Regression coverage for the deploy-loses-your-place bug: `docker compose`
 * swaps containers by sending SIGTERM, which is a known, imminent shutdown —
 * not the unpredictable crash the live-state persistence debounce is sized
 * for. Without a shutdown flush, any reading position published in the last
 * PERSIST_DEBOUNCE_MS before a deploy never reaches disk, and the fresh
 * process comes up with nothing to restore — the pill silently doesn't show
 * on the very next reload.
 *
 * This spawns real server processes (not the shared test server other specs
 * use), publishes a state, and sends a real SIGTERM well inside the debounce
 * window — the only way to honestly prove the shutdown path works. Playwright
 * runs specs in parallel, so port/db-path are allocated per test rather than
 * shared module-level constants.
 */

const SESSION_ID = `flushtest01`;

class TestServer {
  readonly port: number;
  readonly dbPath: string;

  constructor(port: number, dbPath: string) {
    this.port = port;
    this.dbPath = dbPath;
  }

  statePath() {
    return `${this.dbPath}/session_${SESSION_ID}.state.json`;
  }

  seedSession() {
    rmSync(this.dbPath, { recursive: true, force: true });
    mkdirSync(this.dbPath, { recursive: true });
    // The /__session-state endpoint requires the session to already exist.
    writeFileSync(
      `${this.dbPath}/session_${SESSION_ID}.jsonl`,
      JSON.stringify({ url: `http://localhost/long-article`, timestamp: jsonDate() }) + `\n`,
    );
  }

  async start(): Promise<ChildProcess> {
    const baseEnv = readDotEnv(`./.env`);
    const env = {
      ...process.env,
      ...baseEnv,
      localPort: String(this.port),
      publicPort: String(this.port),
      publicHost: `localhost:${this.port}`,
      proxyPort: `38080`,
      proxyProtocol: `http`,
      dbPath: this.dbPath,
      watchdogMs: `0`,
      magicurlApi: `http://localhost:38081`,
    };
    const proc = spawn(`node_modules/.bin/tsx`, [`src/server`], { env, stdio: `pipe`, cwd: process.cwd() });
    proc.stderr.on(`data`, (d: Buffer) => process.stderr.write(`[flush-test server :${this.port}] ${d.toString()}`));
    await waitForServer(`https://localhost:${this.port}`);
    return proc;
  }

  /** POST JSON over HTTPS, ignoring the self-signed dev cert (same as playwright.config.ts's ignoreHTTPSErrors). */
  postJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const body: string = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = https.request(`https://localhost:${this.port}${path}`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json`, 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
      }, r => {
        let data = ``;
        r.on(`data`, (c: Buffer) => data += c);
        r.on(`end`, () => { try { resolve(JSON.parse(data)) } catch (err) { reject(err instanceof Error ? err : new Error(String(err))) } });
      });
      req.on(`error`, reject);
      req.write(body);
      req.end();
    });
  }

  getJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.get(`https://localhost:${this.port}${path}`, { rejectUnauthorized: false }, r => {
        let data = ``;
        r.on(`data`, (c: Buffer) => data += c);
        r.on(`end`, () => { try { resolve(JSON.parse(data)) } catch (err) { reject(err instanceof Error ? err : new Error(String(err))) } });
      });
      req.on(`error`, reject);
    });
  }
}

function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise(resolve => proc.once(`exit`, () => resolve()));
}

test.describe(`live-state survives a deploy-style restart`, () => {
  test(`a SIGTERM well inside the persist debounce still flushes state to disk`, async () => {
    const server = new TestServer(29450 + (process.pid % 1000), `/tmp/web-syncr-flush-test-db-${process.pid}-a`);
    server.seedSession();
    const proc = await server.start();
    try {
      const res = await server.postJson(`/__session-state`, {
        sessionId: SESSION_ID,
        clientId: `client-a`,
        url: `https://${SESSION_ID}__localhost__.localhost:${server.port}/long-article`,
        anchor: null,
        deviceLabel: `Desktop`,
        claimDriver: true,
      }) as { ok: boolean };
      expect(res.ok).toBe(true);

      // Well under PERSIST_DEBOUNCE_MS (2000ms) — this is the exact race a
      // real deploy wins nearly every time without the flush-on-signal fix.
      await new Promise(r => setTimeout(r, 150));
      expect(existsSync(server.statePath())).toBe(false);

      proc.kill(`SIGTERM`);
      await waitForExit(proc);

      expect(existsSync(server.statePath())).toBe(true);
      const persisted = JSON.parse(readFileSync(server.statePath(), `utf8`)) as SessionLiveState;
      expect(persisted.driverId).toBe(`client-a`);
      expect(persisted.url).toContain(`/long-article`);
    } finally {
      if (!proc.killed) proc.kill(`SIGKILL`);
      rmSync(server.dbPath, { recursive: true, force: true });
    }
  });

  test(`a fresh process hydrates the flushed state on the very next request`, async () => {
    const server = new TestServer(29460 + (process.pid % 1000), `/tmp/web-syncr-flush-test-db-${process.pid}-b`);
    server.seedSession();
    const first = await server.start();
    try {
      await server.postJson(`/__session-state`, {
        sessionId: SESSION_ID,
        clientId: `client-b`,
        url: `https://${SESSION_ID}__localhost__.localhost:${server.port}/long-article`,
        anchor: null,
        deviceLabel: `Phone`,
        claimDriver: true,
      });

      first.kill(`SIGTERM`);
      await waitForExit(first);
    } finally {
      if (!first.killed) first.kill(`SIGKILL`);
    }

    // Simulates the user's exact report: deploy (process replaced), then
    // reload — a brand new process must see the pre-restart state.
    const second = await server.start();
    try {
      const res = await server.getJson(`/__session-state?sessionId=${SESSION_ID}`) as { state: SessionLiveState | null };
      expect(res.state).not.toBeNull();
      expect(res.state!.driverId).toBe(`client-b`);
      expect(res.state!.deviceLabel).toBe(`Phone`);
    } finally {
      second.kill(`SIGKILL`);
      rmSync(server.dbPath, { recursive: true, force: true });
    }
  });
});
