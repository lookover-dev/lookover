// proof's motion (ADR 0087): the loops it keeps still are every loop the app's CSS has, a frames shot's times run from
// its motion's start to its end, its clip holds the whole motion (ADR 0089), a strip lays its frames side by side, and
// settle sees what starts while it waits (on stubs). What a motion does in the page is proved in the browser each
// time `bun run proof` runs (the frames strips, the reduced-motion pass and its bite): no test here runs a real
// animation.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  frameTimes,
  LOOPS,
  MOTION_BITE_PAGE,
  MOTION_BITES,
  motionClip,
  motionSeen,
  STILL,
  settle,
  stripPage,
  unionOf,
  watchMotion,
} from "./proof-motion.ts";
import { SHOTS } from "./proof-shots.ts";

const styles = join(import.meta.dir, "..", "apps", "web", "src", "styles");
const css = (file: string) =>
  readFileSync(join(styles, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // The reduced-motion block names every element and no loop.
    .replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\}\s*\}/, "");

/** Every rule of the app's CSS whose animation runs on (`infinite`) or lights a linked setting (`target`). */
function loopSelectors(): string[] {
  const found: string[] = [];
  for (const file of ["system.css", "app.css"])
    for (const [, prelude = "", body = ""] of css(file).matchAll(/([^{}]+)\{([^{}]*)\}/g))
      if (/animation:[^;]*(\binfinite\b|\btarget\b)/.test(body))
        found.push(...prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")));
  return found;
}

test("the still sheet holds every loop of the app's CSS, and nothing else", () => {
  const loops = loopSelectors();
  expect(loops.length).toBeGreaterThan(0);
  expect([...LOOPS].map(String).sort()).toEqual([...new Set(loops)].sort());
  expect(STILL).toBe(`${LOOPS.join(", ")} { animation: none !important; }`);
});

test("a frames shot's times run from its motion's start to its end, evenly", () => {
  expect(frameTimes(240)).toEqual([0, 48, 96, 144, 192, 240]);
  expect(frameTimes(180)).toEqual([0, 36, 72, 108, 144, 180]);
  // Whole milliseconds, the last its end.
  expect(frameTimes(100)).toEqual([0, 20, 40, 60, 80, 100]);
  expect(frameTimes(7).at(-1)).toBe(7);
});

test("a frames shot's clip holds its subject's box at every frame: a folding group shrinks inside it", () => {
  const window = { width: 1440, height: 900 };
  // A group folding from 400 px tall at 0 ms to 60 px at its end: the clip is the start's box, not the end's.
  const folding = [
    { x: 200, y: 100, width: 600, height: 400 },
    { x: 200, y: 100, width: 600, height: 240 },
    { x: 200, y: 100, width: 600, height: 60 },
  ];
  expect(motionClip(folding, 24, window)).toEqual({ x: 176, y: 76, width: 648, height: 448 });
  // A frame where the subject was absent leaves the clip to those it was measured in.
  expect(motionClip([null, { x: 200, y: 100, width: 600, height: 60 }, null], 24, window)).toEqual({
    x: 176,
    y: 76,
    width: 648,
    height: 108,
  });
  // Boxes apart: the clip runs from the leftmost top to the rightmost bottom.
  const apart = [
    { x: 300, y: 200, width: 100, height: 50 },
    { x: 100, y: 400, width: 50, height: 100 },
  ];
  expect(motionClip(apart, 0, window)).toEqual({ x: 100, y: 200, width: 300, height: 300 });
  // Within the window: the margin never runs past its edges.
  const edge = [{ x: 10, y: 5, width: 1420, height: 890 }];
  expect(motionClip(edge, 24, window)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
});

test("the union of boxes holds each one present, and is nothing when none is", () => {
  const start = { x: 200, y: 100, width: 600, height: 400 };
  const end = { x: 220, y: 120, width: 300, height: 60 };
  expect(unionOf([start, end])).toEqual(start);
  expect(unionOf([end, null, { x: 900, y: 50, width: 10, height: 10 }])).toEqual({
    x: 220,
    y: 50,
    width: 690,
    height: 130,
  });
  expect(unionOf([null])).toBeNull();
  expect(unionOf([])).toBeNull();
});

test("a frames shot whose subject is in no frame has no clip", () => {
  expect(motionClip([null, null], 24, { width: 1440, height: 900 })).toBeNull();
  expect(motionClip([], 24, { width: 1440, height: 900 })).toBeNull();
});

test("a strip lays its frames side by side, each named by its time, the settled page last", () => {
  const page = stripPage("switch-flip", "dark", [
    { label: "0 ms", png: "AAAA" },
    { label: "180 ms", png: "BBBB" },
    { label: "settled", png: "CCCC" },
  ]);
  expect(page).toContain("switch-flip");
  expect(page).toContain("dark");
  const order = ["0 ms", "180 ms", "settled"].map((label) => page.indexOf(`<b>${label}</b>`));
  expect(order.every((at) => at > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(page).toContain('src="data:image/png;base64,CCCC"');
});

test("the reduced-motion pass bites on a page that moves and passes one that keeps still", () => {
  expect(MOTION_BITES.map((b) => b.moves)).toEqual([true, false]);
  const [moving, still] = MOTION_BITES;
  expect(moving?.css).toMatch(/transition:/);
  expect(moving?.css).toMatch(/animation:/);
  expect(still?.css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
  // A script's motion fires no event and is over, a token's length, before the pass looks: both ways to start one,
  // and the still page keeps them for those who don't ask for less.
  for (const js of [moving?.js, still?.js]) {
    expect(js).toMatch(/\.animate\(frames, \{ duration: 180, id: "nudge" \}\)/);
    expect(js).toMatch(/new Animation\(new KeyframeEffect\(line, frames, 180\)\)/);
  }
  expect(still?.js).toContain('matchMedia("(prefers-reduced-motion: no-preference)")');
  expect(MOTION_BITE_PAGE).toContain('<script src="/motion.js"></script>');
});

test("the reduced-motion pass records a script's animation as it starts, though it ends before anyone looks", () => {
  // The page's two ways to start one, as the browser has them: `element.animate`, and `new Animation(effect).play()`.
  // Neither animation is still running when the pass looks: only what was recorded as it started can show them.
  class Played {
    id = "";
    play(): void {}
  }
  class Box {
    animate(_frames: unknown, options?: { id?: string }): Played {
      const played = new Played();
      played.id = options?.id ?? "";
      return played;
    }
  }
  const page = globalThis;
  const names = ["Element", "Animation", "document"] as const;
  const before = names.map((name) => [name, Reflect.get(page, name)] as const);
  Object.assign(page, { Element: Box, Animation: Played, document: { getAnimations: () => [] } });
  try {
    watchMotion();
    new Box().animate([], { id: "nudge" });
    const push = new Played();
    push.id = "push";
    push.play();
    new Box().animate([]);
    expect(motionSeen()).toEqual(["a script's animation", "animation nudge", "animation push"]);
  } finally {
    for (const [name, value] of before) Reflect.set(page, name, value);
    Reflect.deleteProperty(page, "__moved");
  }
});

test("settle keeps waiting when an animation starts during the frames it waits", async () => {
  // A render on the first awaited frame starts a finite animation: settle must see it after the wait, not the empty
  // list it read before.
  class Running {
    playState = "running";
    effect = { getComputedTiming: () => ({ endTime: 180 }) };
    finish(): void {
      this.playState = "finished";
    }
  }
  const late = new Running();
  const animations: Running[] = [];
  let frames = 0;
  const page = globalThis;
  const names = ["document", "requestAnimationFrame", "scrollX", "scrollY"] as const;
  const before = names.map((name) => [name, Reflect.get(page, name)] as const);
  Object.assign(page, {
    document: {
      getAnimations: () => animations.filter((a) => a.playState !== "finished"),
      querySelector: () => null,
    },
    requestAnimationFrame: (run: () => void) => {
      frames += 1;
      if (frames === 1) animations.push(late);
      setTimeout(run, 0);
      return frames;
    },
    scrollX: 0,
    scrollY: 0,
  });
  try {
    const result = await settle(5000);
    expect(late.playState).toBe("finished");
    expect(result).toBeNull();
  } finally {
    for (const [name, value] of before) Reflect.set(page, name, value);
  }
});

test("the frames shots: a switch flipping, a Disclosure opening, the status menu opening and closing, the palette opening and closing, a toast, a row, a notice and a band line leaving", () => {
  const framed = SHOTS.filter((s) => s.frames !== undefined).map((s) => s.name);
  expect(framed).toEqual(
    expect.arrayContaining([
      "frames-switch",
      "frames-disclosure",
      "frames-status-menu",
      "frames-status-menu-closing",
      "frames-toast-leaving",
      "frames-palette-opening",
      "frames-palette-closing",
      "frames-row-moving",
      "frames-notice-dismissed",
      "frames-alert-line-leaving",
    ]),
  );
  // A group folding by its rows, and opening, on Repositories and in setup's checklist (#701).
  expect(framed).toEqual(
    expect.arrayContaining([
      "frames-repositories-folding",
      "frames-repositories-unfolding",
      "frames-setup-repos-folding",
      "frames-setup-repos-unfolding",
    ]),
  );
  // A frames shot's act is what starts its motion.
  for (const shot of SHOTS.filter((s) => s.frames !== undefined)) expect(shot.act).toBeDefined();
});

test("the step list's frames shots: a step advancing by its marks, the verdict taking the Running card's place", () => {
  const framed = SHOTS.filter((s) => s.frames !== undefined).map((s) => s.name);
  expect(framed).toEqual(expect.arrayContaining(["frames-step-advancing", "frames-verdict-arriving"]));
});

test("the accounts list's frames shot: an account an owner approves arriving at its place among those reached (#713)", () => {
  const shot = SHOTS.find((s) => s.name === "frames-account-arriving");
  expect(shot?.frames).toEqual({ around: ".accounts-list" });
  expect(shot?.scenario).toBe("S17");
});
