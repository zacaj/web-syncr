import { expect, test, type Browser, type Page } from '@playwright/test';
import type { SessionLiveState, SyncMode } from '../src/config';
import { createSession, extractSessionId } from './global-setup';

/**
 * Phase 2 of scroll-position sync: server-held live state, join-on-load, and
 * manual handoff. The anchor primitive itself is covered by anchor.spec.ts.
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const TOLERANCE = 2;

async function setSync(page: Page, sessionId: string, syncMode: SyncMode) {
  await page.evaluate(async ([sid, sm]) => {
    await fetch(`/__session-mode`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ sessionId: sid, syncMode: sm }),
    });
  }, [sessionId, syncMode]);
  await page.reload();
}

async function getState(page: Page, sessionId: string): Promise<SessionLiveState | null> {
  return page.evaluate(async (sid) => {
    const res = await fetch(`/__session-state?sessionId=` + encodeURIComponent(sid));
    const json = await res.json() as { state: SessionLiveState | null };
    return json.state;
  }, sessionId);
}

async function clientIdOf(page: Page): Promise<string | null> {
  return page.evaluate(() => sessionStorage.getItem(`__webSyncrClient`));
}

/**
 * Wait until the driver has stopped publishing.
 *
 * driveTo scrolls and then dispatches input, so the trailing `scrollend` can
 * fire *after* the claim — landing a second debounced publish up to ~300ms
 * later. Any test that compares `seq` across a window must first let that
 * settle, or it races its own setup.
 */
async function stableState(page: Page, sessionId: string): Promise<SessionLiveState | null> {
  let last = await getState(page, sessionId);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300);
    const now = await getState(page, sessionId);
    if (now && last && now.seq === last.seq) return now;
    last = now;
  }
  return last;
}

/** Scroll, then simulate genuine user input so this page claims the driver role. */
async function driveTo(page: Page, y: number) {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await page.evaluate(() => dispatchEvent(new WheelEvent(`wheel`, { deltaY: 100 })));
}

/** Open a second device on the same wrapped URL. */
async function openDevice(browser: Browser, url: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

test.describe(`sync`, () => {
  test(`continuous scrolling still publishes on a throttle, not only once it stops`, async ({ page }) => {
    // Regression: schedulePublish used to be a pure debounce — every wheel/
    // scroll tick reset a 300ms timer, so a reader who scrolls near-
    // continuously for a long stretch would publish nothing for the entire
    // span, since the timer never got a quiet window to fire in. It must now
    // fire periodically while still busy, not just on the trailing edge.
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    await setSync(page, sessionId, `manual`);

    await page.evaluate(async () => {
      // Simulate sustained scrolling: a wheel/scroll tick every 150ms, well
      // under both the old 300ms debounce and the new 1000ms throttle window,
      // for 2.5s straight — long enough that a pure debounce would still be
      // waiting when this resolves.
      for (let i = 0; i < 17; i++) {
        window.scrollTo(0, 200 * (i + 1));
        dispatchEvent(new WheelEvent(`wheel`, { deltaY: 100 }));
        dispatchEvent(new Event(`scroll`));
        await new Promise(r => setTimeout(r, 150));
      }
    });

    const state = await getState(page, sessionId);
    expect(state).not.toBeNull();
    // A pure debounce would report seq 1 (only the initial claim publish).
    // The throttle must have landed at least one more update mid-scroll.
    expect(state!.seq).toBeGreaterThan(1);
  });

  test(`syncMode off publishes nothing`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;

    await driveTo(page, 3000);
    await page.waitForTimeout(600);

    expect(await getState(page, sessionId)).toBeNull();
  });

  test(`driver publishes its reading position`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    await setSync(page, sessionId, `manual`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();

    const state = (await getState(page, sessionId))!;
    expect(state.driverId).toBe(await clientIdOf(page));
    expect(state.anchor).not.toBeNull();
    expect(state.url).toContain(`/long-article`);
    expect(state.deviceLabel).toBe(`Desktop`);
  });

  test(`a joining device restores the driver's reading position`, async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `manual`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();

    const expected = await page.evaluate(() => {
      const A = window.__webSyncrAnchor;
      const hit = A.resolve(A.capture());
      return hit ? (hit.el.textContent || ``).replace(/\s+/g, ` `).trim().slice(0, 40) : null;
    });

    // A phone joining the same session: different viewport, everything reflows.
    const { context, page: phone } = await openDevice(browser, url, PHONE);
    try {
      await phone.waitForFunction(() => window.scrollY > 100, undefined, { timeout: 5000 });

      const result = await phone.evaluate(async (sid) => {
        const res = await fetch(`/__session-state?sessionId=` + encodeURIComponent(sid));
        const { state } = await res.json() as { state: SessionLiveState };
        const A = window.__webSyncrAnchor;
        const hit = A.resolve(state.anchor!);
        if (!hit) return null;
        const rect = hit.el.getBoundingClientRect();
        return {
          drift: rect.top + hit.fraction * rect.height - A.readingLineY(),
          text: (hit.el.textContent || ``).replace(/\s+/g, ` `).trim().slice(0, 40),
        };
      }, sessionId);

      expect(result).not.toBeNull();
      expect(result!.text).toBe(expected);
      expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
    } finally {
      await context.close();
    }
  });

  test(`a passive device's restore does NOT steal the driver role`, async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `manual`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();
    const before = (await stableState(page, sessionId))!;
    expect(before.driverId).toBe(await clientIdOf(page));

    const { context, page: phone } = await openDevice(browser, url, PHONE);
    try {
      // The restore scrolls the phone, which fires scroll events. If those were
      // treated as user input the phone would publish off its own restore —
      // and the two devices would ping-pong forever.
      await phone.waitForFunction(() => window.scrollY > 100, undefined, { timeout: 5000 });
      await phone.waitForTimeout(800);

      const after = (await getState(phone, sessionId))!;
      expect(after.driverId).toBe(before.driverId);
      expect(after.driverId).not.toBe(await clientIdOf(phone));
      // seq is the assertion that actually bites. Checking driverId alone is
      // not enough: a passive device that publishes with claimDriver=false
      // leaves driverId untouched while still overwriting the shared position
      // with its own — the same ping-pong, just harder to see.
      expect(after.seq).toBe(before.seq);
    } finally {
      await context.close();
    }
  });

  test(`real input on the passive device transfers the driver role`, async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `manual`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();

    const { context, page: phone } = await openDevice(browser, url, PHONE);
    try {
      await phone.waitForFunction(() => window.scrollY > 100, undefined, { timeout: 5000 });
      const phoneId = await clientIdOf(phone);

      await driveTo(phone, 8000);
      await expect.poll(async () => (await getState(phone, sessionId))?.driverId).toBe(phoneId);
    } finally {
      await context.close();
    }
  });

  test(`a tab that claimed driver from a stray touch still notices it's been superseded (live mode)`, async ({ page }) => {
    // Regression: any wheel/touchstart/pointerdown/keydown claims the driver
    // role, not just deliberate scrolling — and the poll used to bail
    // permanently once `isDriver` was true. A tab that claimed driver from an
    // incidental tap would then never learn another device had taken over,
    // since the poll that would've told it was the very thing that stopped
    // running.
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `live`);

    // A stray touch, no scrolling — enough to claim driver.
    await page.evaluate(() => dispatchEvent(new PointerEvent(`pointerdown`)));
    const clientId = await clientIdOf(page);
    await expect.poll(async () => (await getState(page, sessionId))?.driverId).toBe(clientId);

    // Another device claims driver and moves to a different page. Sent as a
    // direct POST rather than through a second browser, to isolate the poll
    // behaviour under test from the mechanics of a real second device.
    await page.evaluate(async ([sid, wrappedUrl]) => {
      await fetch(`/__session-state`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          sessionId: sid,
          clientId: `other-device`,
          url: wrappedUrl.replace(`/long-article`, `/page2`),
          anchor: null,
          deviceLabel: `Other`,
          claimDriver: true,
        }),
      });
    }, [sessionId, url] as const);

    // The poll runs every 2s; give it a full cycle to notice and follow.
    await page.waitForURL(/\/page2/, { timeout: 5000 });
  });

  test(`a stale non-claiming publish from the old driver cannot clobber a takeover`, async ({ page }) => {
    // Regression: reloading a tab that WAS driving fires `pagehide` on the
    // outgoing document while its in-memory `isDriver` flag is still stale
    // (true) if the poll hasn't yet learned another device took over — e.g.
    // because the takeover happened less than one 2s poll cycle ago. That
    // beacon carries claimDriver:false, so the server correctly kept the new
    // driver's id, but used to overwrite url/anchor/deviceLabel with the
    // stale tab's own data anyway — silently reverting the shared position
    // and stranding the reloaded tab on its own old page forever, since
    // join() would then see itself as already "on" the (corrupted) state.
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `live`);

    const post = (body: object) => page.evaluate(async ([sid, b]) => {
      await fetch(`/__session-state`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ sessionId: sid, ...(b as object) }),
      });
    }, [sessionId, body] as const);

    // Device A claims driver on /long-article.
    await post({ clientId: `device-a`, url, anchor: null, deviceLabel: `A`, claimDriver: true });
    // Device B claims driver and moves to /page2.
    await post({
      clientId: `device-b`,
      url: url.replace(`/long-article`, `/page2`),
      anchor: null,
      deviceLabel: `B`,
      claimDriver: true,
    });
    // A's stale pagehide beacon lands after B's takeover, still pointing at
    // the old page, not claiming driver.
    await post({ clientId: `device-a`, url, anchor: null, deviceLabel: `A`, claimDriver: false });

    const state = (await getState(page, sessionId))!;
    expect(state.driverId).toBe(`device-b`);
    expect(state.url).toContain(`/page2`);
    expect(state.deviceLabel).toBe(`B`);
  });

  test(`a stray touch before join() resolves must not clobber the driver's position`, async ({ page, browser }) => {
    // Regression: the claimDriver listeners (wheel/touchstart/pointerdown/
    // keydown) are attached synchronously on script load, but join()'s
    // fetchState() round trip is async — so a real tap landing before that
    // fetch resolves used to claim driver immediately, publishing the
    // freshly-loaded (not-yet-synced) page's own top-of-page position and
    // stomping the real driver's state. In `live` mode that then drags the
    // real driver's tab along to the wrong spot on its next poll. Reproduced
    // here by delaying the join GET so a dispatched pointerdown reliably
    // lands inside the vulnerable window, rather than depending on real
    // network timing to lose the race.
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `live`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();
    const before = (await stableState(page, sessionId))!;
    expect(before.driverId).toBe(await clientIdOf(page));

    const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true });
    const phone = await context.newPage();
    try {
      await phone.route(`**/__session-state?*`, async route => {
        await new Promise(r => setTimeout(r, 800));
        await route.continue();
      });

      await phone.goto(url);
      // A tap landing before the delayed join() response arrives.
      await phone.evaluate(() => dispatchEvent(new PointerEvent(`pointerdown`)));
      const phoneId = await clientIdOf(phone);

      // Let the delayed join() response land and settle.
      await phone.waitForTimeout(1200);

      const after = (await getState(page, sessionId))!;
      expect(after.driverId).toBe(before.driverId);
      expect(after.driverId).not.toBe(phoneId);
      expect(after.seq).toBe(before.seq);
    } finally {
      await context.close();
    }
  });

  test(`navigating forward on the same device doesn't show a pill about itself`, async ({ page }) => {
    // Regression: injected.js is a fresh script execution on every full page
    // load, so `isDriver` resets to false on ordinary forward navigation
    // (clicking a link) even though the server still has this exact tab as
    // driver. join() used to read that as "the other device is on the page
    // you just left" and pop a pill about it — when it's actually just this
    // tab, one page ago.
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const url = page.url();
    await setSync(page, sessionId, `manual`);

    await driveTo(page, 4000);
    await expect.poll(() => getState(page, sessionId)).not.toBeNull();
    const clientId = await clientIdOf(page);

    // A plain forward navigation on the SAME tab — not a cross-device event.
    await page.goto(url.replace(`/long-article`, `/page2`));
    await expect.poll(async () => (await getState(page, sessionId))?.url).toContain(`/page2`);

    await expect(page.locator(`#web-syncr-pill`)).toBeHidden();
    const state = (await getState(page, sessionId))!;
    expect(state.driverId).toBe(clientId);
  });

  test(`manual mode offers a jump when the driver is on another page`, async ({ page, browser }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    const staleUrl = page.url();
    await setSync(page, sessionId, `manual`);

    // Second device parks on /long-article...
    const { context, page: phone } = await openDevice(browser, staleUrl, PHONE);
    try {
      // ...while the driver moves to a different page entirely.
      await page.goto(staleUrl.replace(`/long-article`, `/page2`));
      await driveTo(page, 0);
      await expect.poll(async () => (await getState(page, sessionId))?.url).toContain(`/page2`);

      // The stale device must not be silently teleported in manual mode — it
      // gets an offer naming the source device and the destination.
      const pill = phone.locator(`#web-syncr-pill`);
      await phone.evaluate(() => window.webSyncrJump());
      await phone.waitForURL(/\/page2/, { timeout: 5000 });
      expect(phone.url()).toContain(`/page2`);
      void pill;
    } finally {
      await context.close();
    }
  });

  test(`syncMode survives a load-mode switch`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    const sessionId = extractSessionId(page.url())!;
    await setSync(page, sessionId, `manual`);

    // Regression: the config writer used to rebuild the file from a fixed field
    // list ({mode, magicSessionId}), silently dropping every other key — so the
    // first touch of the load-mode dropdown would have eaten syncMode.
    const config = await page.evaluate(async (sid) => {
      const res = await fetch(`/__session-mode`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ sessionId: sid, mode: `magicurl` }),
      });
      return await res.json() as { config: { mode?: string; syncMode?: string }};
    }, sessionId);

    expect(config.config.mode).toBe(`magicurl`);
    expect(config.config.syncMode).toBe(`manual`);
  });
});
