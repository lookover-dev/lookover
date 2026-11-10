// `bun run proof`'s motion (ADR 0087): the app is shot with its motion on, as it ships. What this file holds:
// - `STILL`, the sheet that keeps the loops still from before the first paint (the eyes' reading, the running pulse,
//   the skeleton's shimmer, a linked setting's highlight): a loop stopped after it ran once left Chrome painting a
//   stale frame (the eyes' pupils, cut out by an SVG mask, stayed where the animation left them). Nothing else is
//   stilled.
// - `settle`, run in the page before each screenshot and each layout measure, and before a shot's act: every finite
//   animation finished, then, two animation frames on, nothing left leaving (`[data-leaving]`, the presence's mark),
//   no scroll still moving, nothing new started; it says what didn't settle in time.
// - A frames shot's motion: `motionStarted` waits for the motion its act started (the page's timeline stood still by
//   proof before the act, so it can't run away from it), `pauseMotion` pauses every animation and gives the motion's
//   end, `seekMotion` sets every one to a time (`currentTime`, never the clock), `frameTimes` the times shot, from 0 to
//   the end, `unpausedMotion` what started after the pause (frozen in the frames, so the shot fails); `stripPage` lays the frames side by side, a page the browser shoots into the strip (site:strip's way, no
//   image library).
// - The reduced-motion pass: `watchMotion` records, from before the page's first script, every animation and
//   transition that starts (`animationstart`, `transitionrun`, and a script's `animate` or `play`), `motionSeen` those
//   and any still running. `MOTION_BITES` are its self-test, run through the service pass's lifecycle (settled, acted
//   on by `biteAct`, looked at after the same wait): a page that moves under reduced motion must be seen moving, a
//   180 ms script animation that is over by then included; one that keeps its motion for those who ask for it must
//   be seen still, both under the service's CSP.
// Each function run in the page (`settle`, `motionStarted`, …) is whole in itself: Playwright sends its source.

/** The loops of the app's CSS: each kept still from the first paint, so the shots stand still. */
export const LOOPS = [
  ".eyes .p.read",
  ".eyes .h.read",
  ".c-run::before",
  ".pill i.warn",
  ".pill i.need",
  ".sk",
  ".setcard > div[data-target]",
] as const;

/** The loops stopped, nothing else: an adopted sheet, which a page under the service's CSP accepts. */
export const STILL = `${LOOPS.join(", ")} { animation: none !important; }`;

/** How many times a frames shot seeks its motion to, from its start to its end; the settled page comes after. */
export const FRAMES = 6;

/** The times a motion ending at `end` ms is shot at: evenly from 0 to its end, in whole milliseconds. */
export function frameTimes(end: number, count = FRAMES): number[] {
  return Array.from({ length: count }, (_, i) => Math.round((end * i) / (count - 1)));
}

/** One frame of a strip: its caption, and the PNG's bytes in base64. */
export interface Frame {
  label: string;
  png: string;
}

/**
 * A strip's page: the frames side by side, each under its caption, at their own size. A proof-only page, never shipped,
 * so its colours stand outside the design system (as site:strip's sheet).
 */
export function stripPage(name: string, theme: string, frames: readonly Frame[]): string {
  const cells = frames
    .map((f) => `<figure><b>${f.label}</b><img src="data:image/png;base64,${f.png}" alt=""></figure>`)
    .join("");
  return [
    `<!doctype html><meta charset="utf-8"><title>${name}, ${theme}</title>`,
    "<style>body{margin:0;padding:16px;background:#111;color:#ddd;font:12px system-ui;width:max-content}",
    "h1{font-size:14px;margin:0 0 12px}main{display:flex;flex-wrap:nowrap;gap:12px}",
    "figure{margin:0;display:flex;flex-direction:column;gap:4px}img{display:block;border:1px solid #333}</style>",
    `<h1>${name} · ${theme}</h1><main>${cells}</main>`,
  ].join("");
}

// ---- In the page --------------------------------------------------------------------------------------------

/**
 * Settles the page: every finite animation finished, then two animation frames on, nothing leaving, no scroll moving
 * and nothing new started. What still moved after `limit` ms, or null.
 */
export async function settle(limit: number): Promise<string | null> {
  const frame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));
  const begun = performance.now();
  const moving = () =>
    document
      .getAnimations()
      .filter((a) => a.playState !== "finished" && a.effect?.getComputedTiming().endTime !== Infinity);
  for (;;) {
    for (const a of moving()) a.finish();
    const at = [scrollX, scrollY];
    await frame();
    await frame();
    // Read again after the wait: a render in either frame may have started one.
    const started = moving().length > 0;
    const leaving = document.querySelector("[data-leaving]");
    const scrolled = scrollX !== at[0] || scrollY !== at[1];
    if (leaving === null && !scrolled && !started) return null;
    if (performance.now() - begun > limit) {
      if (leaving !== null) return `${leaving.tagName.toLowerCase()}.${leaving.className} stayed leaving`;
      return scrolled ? "the page kept scrolling" : "animations kept starting";
    }
  }
}

/** Waits up to `limit` ms for a finite animation to be in the page: whether one came. */
export async function motionStarted(limit: number): Promise<boolean> {
  const frame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));
  const begun = performance.now();
  const finite = () =>
    document
      .getAnimations()
      .some((a) => a.playState !== "finished" && a.effect?.getComputedTiming().endTime !== Infinity);
  while (!finite()) {
    if (performance.now() - begun > limit) return false;
    await frame();
  }
  // Two more frames: what the same change starts a frame later (a re-render's entry) joins it.
  await frame();
  await frame();
  return true;
}

/**
 * Pauses every finite animation in the page and keeps them (`__paused`): one sought to its end is no longer among the
 * page's animations, and must still be sought back. The end of the last, in ms of its own time.
 */
export function pauseMotion(): number {
  let end = 0;
  const paused: Animation[] = [];
  for (const a of document.getAnimations()) {
    const ends = a.effect?.getComputedTiming().endTime;
    if (a.playState === "finished" || typeof ends !== "number" || ends === Infinity) continue;
    a.pause();
    paused.push(a);
    end = Math.max(end, ends);
  }
  Reflect.set(window, "__paused", paused);
  return Math.ceil(end);
}

/** Seeks every animation `pauseMotion` paused to `ms`, none past its own end. */
export function seekMotion(ms: number): void {
  const kept: unknown = Reflect.get(window, "__paused");
  for (const a of Array.isArray(kept) ? kept : []) {
    if (!(a instanceof Animation)) continue;
    const ends = a.effect?.getComputedTiming().endTime;
    if (typeof ends === "number") a.currentTime = Math.min(ms, ends);
  }
}

/** Finishes every animation `pauseMotion` paused: what waits for one to end (a leaving thing) goes on. */
export function finishMotion(): void {
  const kept: unknown = Reflect.get(window, "__paused");
  for (const a of Array.isArray(kept) ? kept : []) if (a instanceof Animation) a.finish();
}

/**
 * Every finite animation in the page `pauseMotion` didn't pause: one that started after it, held at its first frame by
 * the still timeline, which the frames would show frozen. Each by its name.
 */
export function unpausedMotion(): string[] {
  const kept: unknown = Reflect.get(window, "__paused");
  const paused = new Set<unknown>(Array.isArray(kept) ? kept : []);
  return document
    .getAnimations()
    .filter((a) => !paused.has(a) && a.playState !== "finished")
    .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    .map((a) => {
      if (a instanceof CSSAnimation) return `animation ${a.animationName}`;
      if (a instanceof CSSTransition) return `transition of ${a.transitionProperty}`;
      return a.id === "" ? "a script's animation" : `animation ${a.id}`;
    });
}

/** The page's box around every element `selector` matches, `margin` px wider each side, within the window. */
export function regionOf({ selector, margin }: { selector: string; margin: number }) {
  const boxes = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect());
  if (boxes.length === 0) return null;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.top)) - margin);
  const right = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + margin);
  const bottom = Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + margin);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * From before the page's first script: every animation and transition that starts, kept in `__moved`. CSS motion says
 * so by its events (`animationstart`, `transitionrun`); a script's fires none, so `element.animate` and
 * `Animation.prototype.play` (what `new Animation(effect).play()` calls) are wrapped to say it as it starts: one that
 * ends before the pass looks (a 180 ms nudge, finished by the settle before the act) is still seen.
 */
export function watchMotion(): void {
  const moved: string[] = [];
  Reflect.set(globalThis, "__moved", moved);
  const note = (event: Event) => {
    if (event instanceof AnimationEvent) moved.push(`animation ${event.animationName}`);
    if (event instanceof TransitionEvent) moved.push(`transition of ${event.propertyName}`);
  };
  addEventListener("animationstart", note, true);
  addEventListener("transitionrun", note, true);
  const named = (a: Animation) => {
    if ("animationName" in a) return `animation ${String(a.animationName)}`;
    if ("transitionProperty" in a) return `transition of ${String(a.transitionProperty)}`;
    return a.id === "" ? "a script's animation" : `animation ${a.id}`;
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
    const started = animate.apply(this, args);
    moved.push(named(started));
    return started;
  };
  const play = Animation.prototype.play;
  Animation.prototype.play = function (this: Animation) {
    moved.push(named(this));
    play.call(this);
  };
}

/** What `watchMotion` saw start, and every animation still running: each once, in order. */
export function motionSeen(): string[] {
  const kept: unknown = Reflect.get(globalThis, "__moved");
  const started = Array.isArray(kept) ? kept.map(String) : [];
  const running = document
    .getAnimations()
    .filter((a) => a.playState === "running")
    .map((a) => {
      if (a instanceof CSSAnimation) return `animation ${a.animationName}`;
      if (a instanceof CSSTransition) return `transition of ${a.transitionProperty}`;
      return a.id === "" ? "a script's animation" : `animation ${a.id}`;
    });
  return [...new Set([...started, ...running])].sort();
}

// ---- The reduced-motion pass's self-test ------------------------------------------------------------------------

/**
 * A page of the pass's self-test: its stylesheet, its script (served as `/motion.js`), and whether it moves under
 * reduced motion.
 */
export interface MotionBite {
  name: string;
  css: string;
  js: string;
  moves: boolean;
}

const SPIN = "@keyframes spin { to { transform: rotate(1turn); } } .spin { animation: spin 1s infinite; }";
const FADE = ".fade { transition: opacity 200ms; } .fade.on { opacity: 0.5; }";
/**
 * A script's motion, a token's length (180 ms) and firing no `animationstart` nor `transitionrun`: a nudge as the page
 * loads (`element.animate`, finished by the settle before the act) and a push when the line is clicked (`new
 * Animation(effect).play()`, over before the pass looks). Only `watchMotion`'s record of their start shows them.
 */
const NUDGE = [
  'const line = document.querySelector(".nudge");',
  'const frames = [{ translate: "0" }, { translate: "4px" }];',
  'line?.animate(frames, { duration: 180, id: "nudge" });',
  'line?.addEventListener("click", () => { const push = new Animation(new KeyframeEffect(line, frames, 180)); push.id = "push"; push.play(); });',
].join(" ");

/**
 * The pass's self-test, each page a spinning mark, a line that fades once proof turns it `on` and a line its script
 * nudges and pushes: one that moves whatever the person asked, one that moves only for those who ask for no less.
 */
export const MOTION_BITES: readonly MotionBite[] = [
  {
    name: "a loop, a fade and a script's nudge and push that ignore reduced motion",
    css: `${SPIN} ${FADE}`,
    js: NUDGE,
    moves: true,
  },
  {
    name: "a loop, a fade and a script's nudge and push kept for those who don't ask for less",
    css: `@media (prefers-reduced-motion: no-preference) { ${SPIN} ${FADE} }`,
    js: `if (matchMedia("(prefers-reduced-motion: no-preference)").matches) { ${NUDGE} }`,
    moves: false,
  },
];

/** What the pass must see on the page that moves: its loop, its fade and its script's nudge and push. */
export const BITE_MOTION = [
  "animation nudge",
  "animation push",
  "animation spin",
  "transition of opacity",
] as const;

/** The bite's act, as a frames shot's: the fading line turned `on`, the nudged line clicked. */
export function biteAct(): void {
  document.querySelector(".fade")?.classList.add("on");
  document.querySelector<HTMLElement>(".nudge")?.click();
}

/** A bite page's markup: a mark that may spin, a line that may fade, a line that may be nudged. */
export const MOTION_BITE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Motion</title><link rel="stylesheet" href="/motion.css"></head><body><p class="spin">Lookover</p><p class="fade">A second look</p><p class="nudge">Before merge</p><script src="/motion.js"></script></body></html>';
