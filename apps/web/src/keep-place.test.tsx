// A place kept landed (ADR 0091, #655): `keepPlace` on a fake page, its size changing and the person's actions played
// by the test; then what gives the landing back to the person in a real DOM, their inputs as the browser sends them,
// never a scroll the app made. happy-dom lays nothing out and scrolls nothing, so each test sends the events a browser
// would (its page's size and frames faked where a test needs them); whose a page `scroll` is, frame by frame, is
// `scrollOwner`'s, tested alone. The DOM is `withDom`'s, this file's only.
import { afterEach, expect, test } from "bun:test";
import { browserLanding, keepPlace, type Landing, type Place, pageOf, scrollOwner } from "./keep-place.ts";
import { withDom } from "./ui/dom.test-support.tsx";

withDom();
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
});

/** A fake page to keep a landing on: its size changing and the person's actions, each played by the test. */
function fakeLanding() {
  const resized = new Set<() => void>();
  const acted = new Set<() => void>();
  const landing: Landing = {
    onResize: (listener) => {
      resized.add(listener);
      return () => resized.delete(listener);
    },
    onAct: (listener) => {
      acted.add(listener);
      return () => acted.delete(listener);
    },
  };
  return {
    landing,
    resize: () => {
      for (const listener of [...resized]) listener();
    },
    act: () => {
      for (const listener of [...acted]) listener();
    },
    listening: () => resized.size + acted.size,
  };
}

/** A section's own place, each landing said by how it scrolled (`undefined`: the page's own way, smooth). */
function landingPlace() {
  const landed: (ScrollBehavior | undefined)[] = [];
  const group = { scrollIntoView: (o?: ScrollIntoViewOptions) => landed.push(o?.behavior) };
  const place: Place = {
    scrollIntoView: () => {
      throw new Error("A section's own place lands its group");
    },
    closest: (selector: string) => (selector === "[data-landing]" ? group : null),
  };
  return { place, landed };
}

test("a landing kept: the first in the page's own way, then again at once each time the page changes size (ADR 0091)", () => {
  const page = fakeLanding();
  const { place, landed } = landingPlace();
  keepPlace(() => place, page.landing);
  expect(landed).toEqual([undefined]);
  page.resize();
  page.resize();
  expect(landed).toEqual([undefined, "instant", "instant"]);
});

test("the person's first action gives the page back: no landing again after it, nothing left listening", () => {
  const page = fakeLanding();
  const { place, landed } = landingPlace();
  keepPlace(() => place, page.landing);
  page.resize();
  page.act();
  page.resize();
  expect(landed).toEqual([undefined, "instant"]);
  expect(page.listening()).toBe(0);
});

test("a landing stopped (another place asked, the page left) lands no more, nothing left listening", () => {
  const page = fakeLanding();
  const { place, landed } = landingPlace();
  const stop = keepPlace(() => place, page.landing);
  stop();
  page.resize();
  expect(landed).toEqual([undefined]);
  expect(page.listening()).toBe(0);
});

test("a landing again finds the place as it is then: gone, nothing scrolls", () => {
  const page = fakeLanding();
  const { place, landed } = landingPlace();
  let now: Place | null = place;
  keepPlace(() => now, page.landing);
  now = null;
  expect(() => page.resize()).not.toThrow();
  expect(landed).toEqual([undefined]);
});

/**
 * The browser's landing on a fresh page, counting the actions it says are the person's. `scrollEnds` is the seam's
 * (absent, the browser's own); `onResize` too when `resizing` is given.
 */
function listening(scrollEnds?: boolean, resizing?: () => void): { count: () => number } {
  let count = 0;
  const landing = browserLanding(document.body, scrollEnds);
  if (resizing) stops.push(landing.onResize(resizing));
  stops.push(
    landing.onAct(() => {
      count += 1;
    }),
  );
  return { count: () => count };
}

/** An element of the page, from its markup. */
function element(markup: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  document.body.append(holder);
  const made = holder.firstElementChild;
  if (!(made instanceof HTMLElement)) throw new Error(`no element in ${markup}`);
  return made;
}

const key = (target: EventTarget, name: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

const pageScroll = () => document.dispatchEvent(new Event("scroll", { bubbles: true }));

test("any key pressed, on the page, in a field or on a button, is the person's first action: it gives the page back", () => {
  for (const markup of ["<p>words</p>", "<input>", "<button>Sign in again</button>"]) {
    for (const name of [" ", "ArrowDown", "PageDown", "Enter", "Escape", "a"]) {
      const page = listening();
      key(element(markup), name);
      expect({ markup, name, count: page.count() }).toEqual({ markup, name, count: 1 });
    }
  }
});

test("a key a control takes for itself (its default prevented, as the app's Select does with the arrows) gives the page back too", () => {
  const page = listening();
  const select = element('<div role="listbox" tabindex="0">options</div>');
  select.addEventListener("keydown", (e) => e.preventDefault());
  select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(page.count()).toBe(1);
});

test("a modifier pressed alone acts on nothing: it gives nothing back", () => {
  const page = listening();
  for (const name of ["Shift", "Control", "Alt", "Meta"]) key(document.body, name);
  expect(page.count()).toBe(0);
});

test("Tab moves the focus, not the page: pressed, on the page as in a field, it gives nothing back", () => {
  const page = listening();
  key(document.body, "Tab");
  key(element("<input>"), "Tab");
  expect(page.count()).toBe(0);
});

test("a scroll the focus brings once the landing's own has ended is the person's: the focused control stays in view", () => {
  const page = listening();
  document.dispatchEvent(new Event("scrollend", { bubbles: true }));
  key(document.body, "Tab");
  pageScroll();
  expect(page.count()).toBe(1);
});

test("a pointer down, whichever button and wherever on the page, is the person's first action: it gives the page back", () => {
  for (const button of [0, 1, 2]) {
    const page = listening();
    element("<button>Sign in again</button>").dispatchEvent(
      new PointerEvent("pointerdown", { button, bubbles: true }),
    );
    expect({ button, count: page.count() }).toEqual({ button, count: 1 });
  }
});

test("a page scroll while the landing's own runs is the landing's; once it has ended, the next is the person's", () => {
  const page = listening();
  pageScroll();
  expect(page.count()).toBe(0);
  document.dispatchEvent(new Event("scrollend", { bubbles: true }));
  pageScroll();
  expect(page.count()).toBe(1);
});

/** Past the wait a first landing has to start its glide: one that moved nothing has sent no `scroll` by then. */
const stillWait = () => new Promise<void>((done) => setTimeout(done, 300));

test("a first landing that moved nothing ends no scroll: its wait over, having seen none, scrolls are the person's", async () => {
  const page = listening();
  await stillWait();
  key(document.body, "Tab");
  pageScroll();
  expect(page.count()).toBe(1);
});

test("Tab at once after a first landing: the scroll it brings is the person's, whoever owns a scroll then", () => {
  const page = listening();
  key(document.body, "Tab");
  pageScroll();
  expect(page.count()).toBe(1);
});

test("a first landing that glides: its scrolls after the wait stay the landing's until it ends", async () => {
  const page = listening();
  pageScroll();
  await stillWait();
  pageScroll();
  expect(page.count()).toBe(0);
});

/**
 * The page's size and frames, played by the test: `grow` makes the page taller and says so as the browser's
 * `ResizeObserver` would; `frame` runs the frame callbacks asked since the last one. Both are put back after the test.
 */
function fakePage() {
  const real = { observer: globalThis.ResizeObserver, frame: globalThis.requestAnimationFrame };
  let observed = () => {};
  const frames: FrameRequestCallback[] = [];
  globalThis.ResizeObserver = class {
    constructor(said: ResizeObserverCallback) {
      observed = () => said([], this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (asked) => frames.push(asked);
  let height = 400;
  document.body.getBoundingClientRect = () => DOMRect.fromRect({ width: 800, height });
  stops.push(() => {
    globalThis.ResizeObserver = real.observer;
    globalThis.requestAnimationFrame = real.frame;
    Reflect.deleteProperty(document.body, "getBoundingClientRect");
  });
  return {
    grow: () => {
      height += 120;
      observed();
    },
    frame: () => {
      for (const asked of frames.splice(0)) asked(performance.now());
    },
  };
}

test("a landing again as the first landing's wait ends: its own scroll, a frame later, stays the landing's", async () => {
  const size = fakePage();
  const page = listening(true, () => {});
  // The page grows in this frame: landed again at once, its scroll comes in the next frame, after the first's wait.
  size.grow();
  await stillWait();
  pageScroll();
  size.frame();
  expect(page.count()).toBe(0);
});

/** Past the quiet that ends a landing's scroll where the browser sends no `scrollend`. */
const quietWait = () => new Promise<void>((done) => setTimeout(done, 200));

test("a browser with no scrollend: the landing's scrolls quiet a moment, the next page scroll is the person's", async () => {
  const page = listening(false);
  pageScroll();
  pageScroll();
  expect(page.count()).toBe(0);
  await quietWait();
  pageScroll();
  expect(page.count()).toBe(1);
});

test("a browser with no scrollend: the page landed again before the quiet ends, its scroll stays the landing's", async () => {
  const size = fakePage();
  const page = listening(false, () => {});
  pageScroll();
  await new Promise<void>((done) => setTimeout(done, 100));
  size.grow();
  await new Promise<void>((done) => setTimeout(done, 100));
  pageScroll();
  expect(page.count()).toBe(0);
});

test("a scroll inside a scrolling box of the page is not the page's", () => {
  const page = listening();
  document.dispatchEvent(new Event("scrollend", { bubbles: true }));
  element("<div>list</div>").dispatchEvent(new Event("scroll"));
  expect(page.count()).toBe(0);
});

test("whose a scroll is: the landing's until its scroll ends, the person's after, until the page lands again", () => {
  const owner = scrollOwner();
  expect(owner.scrolled()).toBe(false);
  owner.ended();
  expect(owner.scrolled()).toBe(true);
  owner.landed();
  expect(owner.scrolled()).toBe(false);
  owner.framed();
  expect(owner.scrolled()).toBe(false);
  owner.ended();
  expect(owner.scrolled()).toBe(true);
});

test("a landing again that moved nothing ends no scroll: the frame after it, seeing none, gives scrolls to the person", () => {
  const owner = scrollOwner();
  owner.ended();
  owner.landed();
  owner.framed();
  expect(owner.scrolled()).toBe(true);
});

test("the place's page is the main that holds it, or the body when none does", () => {
  element("<main class=page>first</main>");
  const second = element('<main class=page><h4 id="agent">Coding agent</h4></main>');
  expect(pageOf(document.getElementById("agent"))).toBe(second);
  expect(pageOf(element("<p>loose</p>"))).toBe(document.body);
  expect(pageOf(null)).toBe(document.body);
});
