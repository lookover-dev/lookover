// A place kept landed (ADR 0091, #655): a page opened at a place (Settings at #agent, say) lands it, then lands it
// again at once each time the page changes size (a card above it growing as GitHub answers), until the person's first
// action gives the page back. What counts as theirs is the browser's inputs alone (a wheel, a touch, a pointer down, a
// key but Tab or a lone modifier, a page scroll after the landing's own has ended), never a scroll the app made.
// `keepPlace` holds the rule over a `Landing` seam (faked in tests); `browserLanding` is the browser's, on the page
// `pageOf` finds. It knows no screen's content: a place is any element, a section's own one inside an element marked
// `data-landing` (a `Group`'s `landing`).

/** What `openPlace` scrolls: an element of the page, and the section it lands on when it is one's own place. */
export interface Place {
  closest(selector: string): { scrollIntoView(options?: ScrollIntoViewOptions): void } | null;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/**
 * A page opened at a place: a section's own (#github, #agent, in a `Group` marked `landing`) opens its group, the
 * label under the top bar and nothing of the card above it showing (`.page > .grp`'s scroll margin); a setting's row
 * is brought to the middle, where it is lit. `behavior` absent, the page's own (smooth, instant under reduced motion).
 */
export function openPlace(target: Place | null, behavior?: ScrollBehavior) {
  const how = behavior === undefined ? {} : { behavior };
  const group = target?.closest("[data-landing]");
  if (group) group.scrollIntoView({ block: "start", ...how });
  else target?.scrollIntoView({ block: "center", ...how });
}

/**
 * What keeps a landing (ADR 0091): the page changing size, and the person's first action (a wheel, a touch, a pointer
 * down, a key, a scroll after the landing's own has ended), never a scroll the app made. Each returns its stop.
 */
export interface Landing {
  onResize(resized: () => void): () => void;
  onAct(acted: () => void): () => void;
}

/**
 * A place landed and kept (ADR 0091, #655): landed once in the page's own way, then, until the person's first action,
 * landed again at once each time the page changes size (the GitHub card above growing as the organisations arrive),
 * which cuts a first glide short. `place` is read at each landing. The stop it returns (another place asked, the page
 * left) and the person's first action end it.
 */
export function keepPlace(place: () => Place | null, landing: Landing): () => void {
  openPlace(place());
  const stops: (() => void)[] = [];
  const stop = () => {
    for (const off of stops.splice(0)) off();
  };
  stops.push(
    landing.onResize(() => openPlace(place(), "instant")),
    landing.onAct(stop),
  );
  return stop;
}

/**
 * The keys that act on nothing: a modifier pressed alone, and Tab, which moves the focus, not the page. A scroll Tab
 * brings is still the person's (`STILL_MS`), so the place found never pulls the focused control out of view.
 */
const NO_ACTION_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta"]);

/**
 * Whose a page `scroll` is (ADR 0091): the landing's from each landing (the first, gliding, and each again at once as
 * the page changes size) until its scroll ends (`scrollend`, or its quiet where the browser sends none); the person's
 * after that, until the page lands again. A landing again that moved nothing sends no `scrollend`: the frame after it
 * (`framed`), having seen no scroll, ends it too. A scroll the browser made on its own as the page grew (scroll
 * anchoring) is seen by that frame and stays the landing's.
 */
export function scrollOwner() {
  let landing = true;
  let seen = false;
  return {
    landed: () => {
      landing = true;
      seen = false;
    },
    framed: () => {
      if (!seen) landing = false;
    },
    ended: () => {
      landing = false;
    },
    /** A page scroll now: whether it is the person's. */
    scrolled: () => {
      seen = true;
      return !landing;
    },
  };
}

/** The page a place sits in, whose size moves it: the `main` holding it, or the body. */
export function pageOf(place: Element | null): Element {
  return place?.closest("main") ?? document.body;
}

/**
 * How long a first landing may take to start its glide: none by then, it moved nothing. A frame or two in a browser at
 * rest; a headless one under load was seen to start later than two frames, so it is a time, not a frame count.
 */
const STILL_MS = 250;

/**
 * Where the browser sends no `scrollend` (older Safari), how long a landing's scrolls stay quiet before it has ended:
 * a smooth scroll sends one a frame, so a pause of several frames is its end, and short enough that a scroll bar
 * dragged or Find in page just after is the person's, not the landing's.
 */
const QUIET_MS = 150;

/**
 * The browser's, on the page `page`, asked right after the first landing: its border box changing size, and the
 * person's first action. That is a wheel, a touch, a pointer down (any button, anywhere: the scroll bar, or a button
 * the page landing again would move from under the pointer), a key but Tab or a lone modifier, and a page `scroll`
 * `scrollOwner` says is not the landing's: a bar drawn over the page, or Find in page, is seen by the scroll it makes.
 * `scrollEnds`: whether the browser sends `scrollend` (a seam for tests); without it, a landing's scroll ends once
 * quiet for `QUIET_MS`.
 */
export function browserLanding(page: Element, scrollEnds = "onscrollend" in window): Landing {
  const owner = scrollOwner();
  // What ends a landing's ownership by time (the first's wait, a scroll's quiet) belongs to that landing alone: the
  // page landing again cancels it, as its own scroll may come only in the next frame, after such a wait would end it.
  let still: ReturnType<typeof setTimeout> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const forget = () => {
    clearTimeout(still);
    clearTimeout(quiet);
  };
  return {
    onResize: (resized) => {
      const sizeOf = () => {
        const { width, height } = page.getBoundingClientRect();
        return `${width}x${height}`;
      };
      // An observer says the size once as it begins: only a change from the size landed on counts.
      let last = sizeOf();
      const observer = new ResizeObserver(() => {
        const now = sizeOf();
        if (now === last) return;
        last = now;
        forget();
        owner.landed();
        resized();
        requestAnimationFrame(owner.framed);
      });
      observer.observe(page);
      return () => observer.disconnect();
    },
    onAct: (acted) => {
      // The first landing, just asked, moved nothing when no scroll comes within `STILL_MS` of it: it sends no
      // `scrollend` either, so that wait ends it, as `framed` does a landing again.
      still = setTimeout(owner.framed, STILL_MS);
      // Tab moves the focus: a page scroll within `STILL_MS` of it is the focus brought into view, the person's
      // whoever else might own a scroll then (a landing's glide not yet seen ended).
      let tabbedAt = Number.NEGATIVE_INFINITY;
      const key = (e: KeyboardEvent) => {
        if (e.key === "Tab") tabbedAt = performance.now();
        if (!NO_ACTION_KEYS.has(e.key)) acted();
      };
      // The page's own scrolls reach the window from the document; a scrolling box's inside the page don't bubble.
      const scroll = (e: Event) => {
        if (e.target !== document) return;
        clearTimeout(still);
        if (owner.scrolled() || performance.now() - tabbedAt < STILL_MS) acted();
        else if (!scrollEnds) {
          clearTimeout(quiet);
          quiet = setTimeout(owner.ended, QUIET_MS);
        }
      };
      const ended = (e: Event) => {
        if (e.target === document) owner.ended();
      };
      const options = { passive: true, capture: true } as const;
      const bubbling = { passive: true } as const;
      window.addEventListener("wheel", acted, options);
      window.addEventListener("touchstart", acted, options);
      window.addEventListener("pointerdown", acted, options);
      window.addEventListener("keydown", key, options);
      window.addEventListener("scroll", scroll, bubbling);
      window.addEventListener("scrollend", ended, bubbling);
      return () => {
        forget();
        window.removeEventListener("wheel", acted, options);
        window.removeEventListener("touchstart", acted, options);
        window.removeEventListener("pointerdown", acted, options);
        window.removeEventListener("keydown", key, options);
        window.removeEventListener("scroll", scroll);
        window.removeEventListener("scrollend", ended);
      };
    },
  };
}
