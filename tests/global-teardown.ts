import { readFileSync, rmSync, unlinkSync } from 'node:fs';
import { DB_TEST_PATH, PID_FILE } from './global-setup.ts';

export default async function globalTeardown() {
  const mockServer = (globalThis as Record<string, unknown>).__mockServer as { close(cb: () => void): void } | undefined;
  if (mockServer) await new Promise<void>(r => mockServer.close(() => r()));

  try {
    const pid = parseInt(readFileSync(PID_FILE, `utf8`), 10);
    process.kill(pid, `SIGTERM`);
    unlinkSync(PID_FILE);
  } catch {
    // server already gone
  }

  rmSync(DB_TEST_PATH, { recursive: true, force: true });
}
