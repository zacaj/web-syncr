import { expect, test, type Page } from '@playwright/test';
import type { Anchor } from '../src/config';
import { createSession } from './global-setup';

/**
 * Phase 1 of scroll-position sync: the anchor primitive on its own, with no
 * transport. These tests answer the make-or-break question — does a reading
 * position captured on one viewport land accurately on a very different one?
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** How far (px) the restored reading position may drift from the captured one. */
const TOLERANCE = 2;

type ScanResult = { x: number; width: number; containerId: string; containerTag: string };
type Drift = { drift: number; via: string; candidate: number; text: string } | null;

/** Capture an anchor at the current scroll position. */
async function capture(page: Page): Promise<Anchor> {
  return page.evaluate(() => window.__webSyncrAnchor.capture());
}

/**
 * Restore `anchor`, then report how far the anchor element's reading point
 * ended up from the reading line.
 *
 * Asserting on this drift rather than on raw scrollY is the whole point: the
 * two viewports legitimately have different scrollY for the same reading
 * position, so a scrollY assertion would bake in a false expectation.
 */
async function settleAndMeasure(page: Page, anchor: Anchor, budgetMs = 600): Promise<Drift> {
  return page.evaluate(async ([a, budget]: [Anchor, number]) => {
    const A = window.__webSyncrAnchor;
    await A.settleTo(a, { budgetMs: budget });
    const hit = A.resolve(a);
    if (!hit) return null;
    const rect = hit.el.getBoundingClientRect();
    const point = rect.top + hit.fraction * rect.height;
    return {
      drift: point - A.readingLineY(),
      via: hit.via,
      candidate: hit.candidate,
      text: (hit.el.textContent || ``).replace(/\s+/g, ` `).trim().slice(0, 40),
    };
  }, [anchor, budgetMs] as [Anchor, number]);
}

test.describe(`anchor`, () => {
  test(`column scan picks the prose column, not the rail`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);

    const scan = await page.evaluate((): ScanResult => {
      const s = window.__webSyncrAnchor.scan();
      return {
        x: s.x,
        width: window.innerWidth,
        containerId: s.container?.id ?? ``,
        containerTag: s.container?.tagName ?? ``,
      };
    });

    // The rail occupies the leftmost ~180px (14% of 1280), and the scan's
    // first column sits at 12.5% — inside it. Text volume must reject it.
    expect(scan.x).toBeGreaterThan(200);
    // The LCA of the winning column's hits should be the article itself.
    expect(scan.containerId).toBe(`article`);
  });

  test(`never anchors to the sticky banner`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 3000));

    const anchor = await capture(page);
    const resolved = await page.evaluate((a) => {
      const hit = window.__webSyncrAnchor.resolve(a);
      return hit ? (hit.el.className || ``) + `|` + (hit.el.textContent || ``).slice(0, 20) : null;
    }, anchor);

    expect(resolved).not.toContain(`banner`);
    expect(resolved).not.toContain(`Sticky banner`);
  });

  test(`round-trips at the same viewport`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 4000));

    const anchor = await capture(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    const result = await settleAndMeasure(page, anchor);
    expect(result).not.toBeNull();
    expect(result!.via).toBe(`text`);
    expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
  });

  test(`desktop capture restores accurately on a phone viewport`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 4000));

    const before = await page.evaluate(() => {
      const A = window.__webSyncrAnchor;
      const hit = A.resolve(A.capture());
      return hit ? (hit.el.textContent || ``).replace(/\s+/g, ` `).trim().slice(0, 40) : null;
    });
    const anchor = await capture(page);

    // Same document, ~3x narrower and taller — every paragraph reflows.
    await page.setViewportSize(PHONE);
    await page.evaluate(() => window.scrollTo(0, 0));

    const result = await settleAndMeasure(page, anchor);
    expect(result).not.toBeNull();
    // Resolved via text, on the first candidate, to the same paragraph.
    expect(result!.via).toBe(`text`);
    expect(result!.candidate).toBe(0);
    expect(result!.text).toBe(before);
    expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
  });

  test(`phone capture restores accurately on a desktop viewport`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 6000));

    const anchor = await capture(page);

    await page.setViewportSize(DESKTOP);
    await page.evaluate(() => window.scrollTo(0, 0));

    const result = await settleAndMeasure(page, anchor);
    expect(result).not.toBeNull();
    expect(result!.via).toBe(`text`);
    expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
  });

  test(`falls back to container fraction when the text is gone`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 4000));

    const anchor = await capture(page);

    // Simulate the proxy-mode case where the other device got different HTML:
    // rewrite every paragraph's text so no text locator can resolve.
    await page.evaluate(() => {
      document.querySelectorAll(`article p`).forEach((p, i) => {
        p.textContent = `Completely different content ${i}`;
      });
    });

    const result = await settleAndMeasure(page, anchor);
    expect(result).not.toBeNull();
    // Should degrade gracefully rather than resolving to nothing.
    expect([`fraction`, `path`, `id`]).toContain(result!.via);
  });

  test(`corrects for content inserted above after the restore`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/late-shift`);
    await page.evaluate(() => window.scrollTo(0, 4000));
    const anchor = await capture(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    // Restore first, THEN grow 400px of content above the anchor. The fixture
    // sets overflow-anchor:none, so nothing but our loop can fix this.
    const result = await page.evaluate(async (a) => {
      const A = window.__webSyncrAnchor;
      const done = A.settleTo(a, { budgetMs: 1500 });
      await new Promise(r => setTimeout(r, 200));
      window.__insertShift();
      await done;
      const hit = A.resolve(a);
      if (!hit) return null;
      const rect = hit.el.getBoundingClientRect();
      return { drift: rect.top + hit.fraction * rect.height - A.readingLineY(), via: hit.via };
    }, anchor);

    expect(result).not.toBeNull();
    expect(result!.via).toBe(`text`);
    expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
  });

  test(`restores an anchor that only renders after the restore starts`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 4000));
    const anchor = await capture(page);

    // The lazy-render / hydration case: the anchor element does not exist at
    // all when the restore begins. Native scroll anchoring cannot help here —
    // only retrying resolution through the budget can.
    const result = await page.evaluate(async (a) => {
      const A = window.__webSyncrAnchor;
      const article = document.getElementById(`article`)!;
      const saved = article.innerHTML;
      article.innerHTML = `<div style="height:200px">loading…</div>`;
      window.scrollTo(0, 0);

      const done = A.settleTo(a, { budgetMs: 1500 });
      await new Promise(r => setTimeout(r, 250));
      article.innerHTML = saved;
      await done;

      const hit = A.resolve(a);
      if (!hit) return null;
      const rect = hit.el.getBoundingClientRect();
      return { drift: rect.top + hit.fraction * rect.height - A.readingLineY(), via: hit.via };
    }, anchor);

    expect(result).not.toBeNull();
    expect(result!.via).toBe(`text`);
    expect(Math.abs(result!.drift)).toBeLessThanOrEqual(TOLERANCE);
  });

  test(`never scrolls the capturing device's top-of-screen text off the restoring device's screen`, async ({ page }) => {
    // A tall, wide monitor: the reading line (1/3 down) sits far below the
    // top of the screen in absolute pixels, so several paragraphs are
    // visible above it at capture time.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await createSession(page, `http://localhost/long-article`);

    // Put paragraph 10 right at the top of the usable viewport.
    const topParaId = await page.evaluate(() => {
      const A = window.__webSyncrAnchor;
      const target = document.getElementById(`para-10`)!;
      const rect = target.getBoundingClientRect();
      window.scrollTo(0, rect.top + window.scrollY - A.headerHeight() - 2);
      return target.id;
    });
    const anchor = await capture(page);

    // A phone viewport, shorter than usual as if the browser's own chrome
    // (address bar, keyboard) is eating a chunk of the screen — exactly the
    // squeeze that pushes reading-line math further down the document than
    // the capturing device needed to travel.
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.evaluate(async (a) => {
      await window.__webSyncrAnchor.settleTo(a, { budgetMs: 600 });
    }, anchor);

    const visible = await page.evaluate((id) => {
      const A = window.__webSyncrAnchor;
      const el = document.getElementById(id)!;
      const rect = el.getBoundingClientRect();
      return rect.bottom > A.headerHeight() && rect.top < window.innerHeight;
    }, topParaId);

    expect(visible).toBe(true);
  });

  test(`user input aborts an in-flight restore`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await createSession(page, `http://localhost/long-article`);
    await page.evaluate(() => window.scrollTo(0, 4000));
    const anchor = await capture(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    const scrollY = await page.evaluate(async (a) => {
      const A = window.__webSyncrAnchor;
      const done = A.settleTo(a, { budgetMs: 1500 });
      // Real user input mid-settle: the convergence loop must stand down and
      // leave the user where they put themselves.
      await new Promise(r => setTimeout(r, 250));
      dispatchEvent(new WheelEvent(`wheel`, { deltaY: 100 }));
      window.scrollTo(0, 500);
      await done;
      return window.scrollY;
    }, anchor);

    expect(scrollY).toBe(500);
  });
});
