/* eslint-disable */
// @ts-nocheck
/**
 * Reading-position anchoring — Phase 1 (pure client-side, no networking).
 *
 * The problem: two devices viewing the same session have different viewport
 * sizes, so a raw scrollY is meaningless across them. Instead we record *which
 * element the user is reading* plus how far through that element they are, and
 * the other device finds that same element in its own layout and scrolls it to
 * the equivalent spot.
 *
 * Critically, the "which column holds the content" scan runs independently on
 * every device and is NEVER transmitted — only the resolved element locator
 * crosses the wire. That is what makes divergent layouts a non-problem by
 * construction: the capturing device asks "what am I reading?" in its own
 * layout, the restoring device asks "where is that thing?" in its own. There is
 * no shared coordinate space to get wrong.
 *
 * Exposed as window.__webSyncrAnchor for Phase 2 (transport) and for tests.
 */
(function() {
  const HEADER_ID = `web-syncr-header`;
  // Wrapper that injected.js mounts the header into, appended to <html>.
  const ROOT_ID = `web-syncr-root`;

  // How far down the *usable* viewport (below the injected header) the reading
  // line sits. A third, not the centre: people read top-down, so the middle of
  // the screen is already-consumed text.
  const READING_FRACTION = 0.33;
  // Per-element contribution ceiling when scoring a column. Stops one giant
  // hero/wrapper element from winning a column by occupying every probe.
  const TEXT_CAP = 400;
  // A media element contributes this much "text" to a column score, so an
  // image-led column can still beat an empty one but loses to real prose.
  const MEDIA_WEIGHT = 60;
  const SIG_LEN = 80;
  const SCAN_COLUMNS = 7;
  const SCAN_ROWS = 9;
  // Elements taller than this multiple of the viewport are layout wrappers, not
  // content — anchoring to them is meaningless (they span the whole screen at
  // every scroll offset, exactly like a sticky header does).
  const MAX_ANCHOR_VIEWPORTS = 1.5;

  const EXCLUDED_TAGS = new Set([`NAV`, `ASIDE`, `HEADER`, `FOOTER`]);
  const EXCLUDED_ROLES = new Set([`navigation`, `complementary`, `banner`, `contentinfo`]);
  const MEDIA_TAGS = new Set([`IMG`, `VIDEO`, `CANVAS`, `SVG`, `PICTURE`]);

  // ── Geometry ───────────────────────────────────────────────────────────────

  /**
   * Live height of the injected header. Deliberately measured rather than
   * assuming the 4rem of body padding-top that the mount applies: the header is
   * `position: fixed` and wraps to multiple rows on a narrow viewport, so on a
   * phone its real height exceeds that padding.
   *
   * Returns 0 until the header is mounted, which now happens on `load` rather
   * than at parse time (see rewrite.ts) — callers only use this for scroll
   * offset maths, where a brief 0 is harmless.
   */
  function headerHeight() {
    const el = document.getElementById(HEADER_ID);
    if (!el) return 0;
    return el.getBoundingClientRect().height || 0;
  }

  function readingLineY() {
    const top = headerHeight();
    return top + (window.innerHeight - top) * READING_FRACTION;
  }

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  function median(nums) {
    if (!nums.length) return 0;
    const s = nums.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // ── Element eligibility ────────────────────────────────────────────────────

  function looksGenerated(id) {
    // React 18 useId (":r1:"), Ember, Angular, and any id carrying a long hex or
    // numeric run — all of these are re-minted per render/per device and are
    // worse than useless as a cross-device locator.
    return !id
      || /^[:#]/.test(id)
      || /[0-9a-f]{8,}/i.test(id)
      || /\d{4,}/.test(id)
      || /^(ember|ng-|react-|radix-|mui-|headlessui-)/i.test(id);
  }

  /**
   * True if the element lives somewhere we must never anchor to: our own
   * injected chrome, or the page's navigation/aside/footer furniture.
   *
   * `position: fixed|sticky` is the important one — a sticky header sits at the
   * same viewport coordinate at every scroll offset, so it would happily anchor
   * you to "wherever you are", meaning nowhere.
   */
  function inExcludedRegion(el) {
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth++ < 40) {
      if (cur.id === HEADER_ID || cur.id === ROOT_ID) return true;
      if (EXCLUDED_TAGS.has(cur.tagName)) return true;
      const role = cur.getAttribute && cur.getAttribute(`role`);
      if (role && EXCLUDED_ROLES.has(role)) return true;
      const pos = getComputedStyle(cur).position;
      if (pos === `fixed` || pos === `sticky`) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isMedia(el) {
    return MEDIA_TAGS.has(el.tagName);
  }

  function textOf(el) {
    return (el.textContent || ``).replace(/\s+/g, ` `).trim();
  }

  function isAnchorable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.height > window.innerHeight * MAX_ANCHOR_VIEWPORTS) return false;
    if (inExcludedRegion(el)) return false;
    return isMedia(el) || textOf(el).length > 0;
  }

  /**
   * Topmost *content* element at a viewport point.
   *
   * Uses elementsFromPoint (plural) rather than elementFromPoint deliberately:
   * the singular returns whatever paints on top, which on a real page is very
   * often a cookie banner, sticky header, or modal scrim. Walking down the
   * stack past excluded elements skips all of those, since they are precisely
   * the fixed/sticky/furniture cases inExcludedRegion already rejects.
   */
  function firstContentElement(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const el of stack) {
      if (el === document.body || el === document.documentElement) break;
      if (isAnchorable(el)) return el;
    }
    return null;
  }

  // ── Column scan ────────────────────────────────────────────────────────────

  function lowestCommonAncestor(els) {
    if (!els.length) return null;
    if (els.length === 1) return els[0].parentElement || els[0];
    const chain = [];
    for (let cur = els[0]; cur; cur = cur.parentElement) chain.push(cur);
    const rank = new Map(chain.map((el, i) => [el, i]));
    let best = 0;
    for (let i = 1; i < els.length; i++) {
      let cur = els[i];
      while (cur && !rank.has(cur)) cur = cur.parentElement;
      if (!cur) return document.body;
      best = Math.max(best, rank.get(cur));
    }
    return chain[best] || document.body;
  }

  /**
   * Find the column of the viewport that actually holds the content.
   *
   * The naive single reading line assumes text is centred, which holds on
   * mobile but breaks on any desktop layout with a rail or a left-aligned
   * content well. So probe several columns across the middle 3/4 and pick the
   * one carrying the most prose.
   *
   * Scoring is by text *volume* over the distinct elements hit, not hit count:
   * a sidebar column hitting eight nav links should not beat a content column
   * hitting three paragraphs. The distinct-set stops one tall paragraph being
   * counted nine times, and TEXT_CAP stops one huge element dominating.
   *
   * Falls out of the same pass: the LCA of the winning column's hits is the
   * content container, which is what the fraction fallback measures against.
   * Fraction-through-the-article is far more stable across devices than
   * fraction-through-the-document, since rails/headers/footers/ads differ
   * wildly in height between mobile and desktop layouts.
   */
  function scan() {
    const w = window.innerWidth;
    const top = headerHeight();
    const bottom = window.innerHeight;
    if (bottom - top < 20 || w < 20) return fallbackScan();

    let best = null;
    for (let i = 0; i < SCAN_COLUMNS; i++) {
      const x = w * (0.125 + (0.75 * i) / (SCAN_COLUMNS - 1));
      const hits = [];
      const seen = new Set();
      for (let j = 0; j < SCAN_ROWS; j++) {
        const y = top + 8 + ((bottom - top - 16) * j) / (SCAN_ROWS - 1);
        const el = firstContentElement(x, y);
        if (el && !seen.has(el)) {
          seen.add(el);
          hits.push(el);
        }
      }
      if (!hits.length) continue;
      let score = 0;
      const widths = [];
      for (const el of hits) {
        const len = textOf(el).length;
        score += len > 0 ? Math.min(len, TEXT_CAP) : (isMedia(el) ? MEDIA_WEIGHT : 0);
        widths.push(el.getBoundingClientRect().width);
      }
      // Tiebreak on median element width: content wells are wide, rails narrow.
      const cand = { x, hits, score, width: median(widths) };
      if (!best || cand.score > best.score
        || (cand.score === best.score && cand.width > best.width)) best = cand;
    }

    if (!best) return fallbackScan();
    return { x: best.x, hits: best.hits, container: lowestCommonAncestor(best.hits) };
  }

  function fallbackScan() {
    const container = document.querySelector(`main, article, [role="main"]`) || document.body;
    return { x: window.innerWidth / 2, hits: [], container };
  }

  // ── Locators ───────────────────────────────────────────────────────────────

  function textSig(el) {
    return textOf(el).slice(0, SIG_LEN);
  }

  /**
   * All leaf elements whose text signature matches. Restricted to leaves
   * (`children.length === 0`) on purpose: it keeps this an O(n) pass with cheap
   * per-element work, where scanning every element's textContent would be
   * O(n^2) on a large page. Elements found by firstContentElement are the
   * deepest painted element at a point, so they are leaves in the common case;
   * non-leaves simply fall through to the id/path locators instead.
   */
  function textMatches(sig) {
    const out = [];
    if (!sig) return out;
    const all = document.body.getElementsByTagName(`*`);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.children.length !== 0) continue;
      if (textSig(el) !== sig) continue;
      if (!isAnchorable(el)) continue;
      out.push(el);
    }
    return out;
  }

  function mediaSrc(el) {
    const raw = el.getAttribute && (el.getAttribute(`src`) || el.getAttribute(`href`));
    if (!raw) return null;
    try { return new URL(raw, location.href).pathname.split(`/`).pop() || null }
    catch { return raw.split(`/`).pop() || null }
  }

  function mediaMatches(src) {
    const out = [];
    const all = document.getElementsByTagName(`*`);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!isMedia(el)) continue;
      if (mediaSrc(el) !== src) continue;
      if (!isAnchorable(el)) continue;
      out.push(el);
    }
    return out;
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      if (cur.id && !looksGenerated(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      if (cur === document.body) {
        parts.unshift(`body`);
        break;
      }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling)
        if (sib.tagName === cur.tagName) n++;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${n})`);
      cur = cur.parentElement;
    }
    return parts.join(` > `);
  }

  /**
   * Ordered locator bundle for one element — best-surviving first.
   *
   * Text leads because it survives reflow, restyling and outright DOM
   * divergence, which matters most in `proxy` mode where the two devices may
   * receive genuinely different HTML from upstream (mobile UA, A/B tests, ads).
   * The structural path is last precisely because it survives none of that.
   */
  function locatorsFor(el) {
    const locs = [];
    if (el.children.length === 0) {
      const sig = textSig(el);
      if (sig) {
        const nth = textMatches(sig).indexOf(el);
        if (nth >= 0) locs.push({ kind: `text`, sig, nth });
      }
    }
    if (el.id && !looksGenerated(el.id)) locs.push({ kind: `id`, id: el.id });
    if (isMedia(el)) {
      const src = mediaSrc(el);
      if (src) {
        const nth = mediaMatches(src).indexOf(el);
        if (nth >= 0) locs.push({ kind: `media`, src, nth });
      }
    }
    locs.push({ kind: `path`, path: cssPath(el) });
    return locs;
  }

  function resolveLocator(loc) {
    try {
      switch (loc.kind) {
        case `text`: {
          const m = textMatches(loc.sig);
          return m[loc.nth] || m[0] || null;
        }
        case `id`: {
          const el = document.getElementById(loc.id);
          return el && isAnchorable(el) ? el : null;
        }
        case `media`: {
          const m = mediaMatches(loc.src);
          return m[loc.nth] || m[0] || null;
        }
        case `path`: {
          const el = document.querySelector(loc.path);
          return el && isAnchorable(el) ? el : null;
        }
        case `fraction`:
          return document.querySelector(loc.container) || document.body;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /**
   * Snapshot the current reading position.
   *
   * Records `offsetFraction` — how far through the anchor element the reading
   * line falls — rather than just "this element". A paragraph that is three
   * lines on desktop reflows to ten on a phone, so scrolling its *top* into
   * view can miss by half a screen; restoring "42% of the way through this
   * paragraph" survives the reflow.
   *
   * Captures three candidate elements, not one: if the top pick was an ad slot
   * or lazy image that never rendered on the other device, candidate 2 saves
   * the restore. Redundancy is nearly free here.
   */
  function capture() {
    const { x, container } = scan();
    const line = readingLineY();
    const top = headerHeight();
    const usable = window.innerHeight - top;

    const els = [];
    for (const dy of [0, usable * 0.12, usable * 0.24]) {
      const el = firstContentElement(x, Math.min(line + dy, window.innerHeight - 2));
      if (el && els.indexOf(el) === -1) els.push(el);
    }

    const primary = els[0];
    let offsetFraction = 0;
    if (primary) {
      const rect = primary.getBoundingClientRect();
      offsetFraction = clamp((line - rect.top) / Math.max(rect.height, 1), 0, 1);
    }

    const candidates = els.map(locatorsFor);

    // Always append the container-fraction bundle as the last resort, so a
    // restore never has *nothing* to go on.
    if (container) {
      const rect = container.getBoundingClientRect();
      candidates.push([{
        kind: `fraction`,
        container: cssPath(container),
        f: clamp((line - rect.top) / Math.max(rect.height, 1), 0, 1),
      }]);
    }

    // Whatever's directly below the header right now is the topmost text the
    // user can currently see. Restore uses this to cap the scroll distance —
    // see `topCandidates` on the Anchor type for why.
    const topEl = firstContentElement(x, Math.min(top + 2, window.innerHeight - 2));
    const topCandidates = topEl ? locatorsFor(topEl) : null;

    return { candidates, offsetFraction, topCandidates, capturedAt: new Date().toISOString() };
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /** First candidate bundle that resolves, with the fraction to apply to it. */
  function resolve(anchor) {
    if (!anchor || !anchor.candidates) return null;
    for (let i = 0; i < anchor.candidates.length; i++) {
      for (const loc of anchor.candidates[i]) {
        const el = resolveLocator(loc);
        if (!el) continue;
        const fraction = loc.kind === `fraction` ? loc.f : anchor.offsetFraction;
        return { el, fraction, via: loc.kind, candidate: i };
      }
    }
    return null;
  }

  /** Document scrollY that would put `fraction` through `el` on the reading line. */
  function targetScrollY(el, fraction) {
    const rect = el.getBoundingClientRect();
    const topInDoc = rect.top + window.scrollY;
    return Math.max(0, topInDoc + fraction * rect.height - readingLineY());
  }

  /** Resolves `topCandidates` the same way `resolve()` walks `candidates`. */
  function resolveTop(anchor) {
    if (!anchor || !anchor.topCandidates) return null;
    for (const loc of anchor.topCandidates) {
      const el = resolveLocator(loc);
      if (el) return el;
    }
    return null;
  }

  /**
   * The reading-line target, capped so the restore never scrolls the
   * capturing device's top-of-screen content entirely above the restoring
   * device's viewport.
   *
   * The reading-line fraction guarantees one shared point lines up, nothing
   * more — it says nothing about how much of the *preceding* text is still
   * visible above that point. On a much shorter viewport (desktop -> phone),
   * the same fraction can leave text the user hadn't finished reading
   * off-screen. Capping against the captured top-of-viewport element fixes
   * that without touching the reading-line math itself: we only ever scroll
   * *less* than the fraction wants, never more.
   */
  function boundedScrollY(anchor, hit) {
    const want = targetScrollY(hit.el, hit.fraction);
    const topEl = resolveTop(anchor);
    if (!topEl) return want;
    const rect = topEl.getBoundingClientRect();
    const topInDoc = rect.top + window.scrollY;
    const maxScrollY = Math.max(0, topInDoc - headerHeight());
    return Math.min(want, maxScrollY);
  }

  let applying = false;
  let applyingTimer = null;

  function markApplying() {
    applying = true;
    if (applyingTimer) clearTimeout(applyingTimer);
    // Held briefly past the last programmatic scroll so Phase 2's scroll
    // listener never mistakes our own restore for user input — the mistake
    // that makes two devices ping-pong forever.
    applyingTimer = setTimeout(() => { applying = false }, 150);
  }

  function scrollToAnchor(anchor) {
    const hit = resolve(anchor);
    if (!hit) return null;
    markApplying();
    // `behavior: 'instant'` (not the 2-arg form) so a page's own
    // `scroll-behavior: smooth` CSS can't turn this into a multi-second
    // animation — the 150ms applying window in markApplying() assumes the
    // scroll lands immediately.
    window.scrollTo({ top: boundedScrollY(anchor, hit), left: 0, behavior: `instant` });
    return hit;
  }

  /**
   * Apply an anchor and keep re-correcting as the page settles.
   *
   * A one-shot scroll on DOMContentLoaded lands wrong a large fraction of the
   * time: unsized images, lazy content and web fonts all shift layout *after*
   * the scroll. So re-measure at a handful of checkpoints and on the events
   * that actually cause reflow, aborting the moment the user takes over.
   *
   * Note this loop is NOT redundant with Chrome's built-in scroll anchoring.
   * That keeps the *viewport* stable when content is inserted above, which is a
   * different goal from putting our reading line back on a specific fraction of
   * a specific element — and it cannot help at all when the anchor element does
   * not exist yet (lazy-rendered/hydrated content), nor on sites that set
   * `overflow-anchor: none`. Hence the retry-until-resolved behaviour below.
   */
  function settleTo(anchor, opts) {
    const options = opts || {};
    const budgetMs = options.budgetMs || 2000;
    // Deliberately does NOT bail when this first attempt fails to resolve: with
    // lazily-rendered content the anchor element frequently does not exist yet,
    // and giving up here would mean never restoring at all on exactly the
    // JS-heavy pages that need it most.
    scrollToAnchor(anchor);

    // Otherwise the browser's own scroll restoration fights every correction.
    try { history.scrollRestoration = `manual` } catch {}

    return new Promise(resolve_ => {
      let aborted = false;
      const events = [`wheel`, `touchstart`, `pointerdown`, `keydown`];
      const abort = () => { if (!applying) aborted = true };
      for (const ev of events) addEventListener(ev, abort, { passive: true });

      let ro = null;
      const cleanup = () => {
        for (const ev of events) removeEventListener(ev, abort);
        if (ro) ro.disconnect();
      };

      const correct = () => {
        if (aborted) return;
        const hit = resolve(anchor);
        if (!hit) return;
        const want = boundedScrollY(anchor, hit);
        if (Math.abs(window.scrollY - want) > 4) {
          markApplying();
          window.scrollTo({ top: want, left: 0, behavior: `instant` });
        }
      };

      // Discrete checkpoints rather than a rAF loop: this covers image/font
      // settling without thrashing layout at 60fps for two seconds.
      for (const t of [50, 150, 400, 900, 1800]) {
        if (t < budgetMs) setTimeout(correct, t);
      }
      addEventListener(`load`, correct, { once: true });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(correct).catch(() => {});
      if (window.ResizeObserver) {
        let pending = null;
        ro = new ResizeObserver(() => {
          if (pending) clearTimeout(pending);
          pending = setTimeout(correct, 60);
        });
        try { ro.observe(document.documentElement) } catch {}
      }

      setTimeout(() => {
        correct();
        cleanup();
        resolve_(resolve(anchor));
      }, budgetMs);
    });
  }

  window.__webSyncrAnchor = {
    scan,
    capture,
    resolve,
    resolveTop,
    scrollToAnchor,
    settleTo,
    readingLineY,
    headerHeight,
    targetScrollY,
    boundedScrollY,
    isApplying: () => applying,
  };
})();
