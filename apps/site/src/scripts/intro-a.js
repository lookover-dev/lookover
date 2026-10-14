// Intro A, "read first": the code prints, the eyes arrive and read it, the accent chunk lights when they find it,
// then the name completes around them and the eyes blink. Played once on the hero's wordmark; where the pupils look
// is the brand's own `GAZE`, never hand numbers. Once it ends, its animations and the styles it set go, so the
// wordmark's own CSS draws the last frame and follows the theme (the accent chunk's `--acc` included).
import { GAZE } from "../brand/eyes.generated.ts";
import { token } from "./motion.js";
import { Timeline } from "./timeline.js";

const at = ([x, y]) => `translate(${x}px,${y}px)`;

/** Moves both kinds of pupil (the solid eye's `.hole`, the ring eye's `.pupil`) from one gaze to another. */
function look(tl, svg, from, to, start, dur = 240) {
  for (const [kind, parts] of [
    ["solid", svg.querySelectorAll(".hole")],
    ["ring", svg.querySelectorAll(".pupil")],
  ]) {
    const gaze = GAZE.wordmark[kind];
    for (const part of parts)
      tl.add(part, [{ transform: at(gaze[from]) }, { transform: at(gaze[to]) }], { at: start, dur });
  }
}

/** Shuts and opens every lid. */
function blink(tl, svg, start, dur = 140) {
  for (const lid of svg.querySelectorAll(".lid"))
    tl.add(
      lid,
      [
        { transform: "scaleY(0)" },
        { transform: "scaleY(1)", offset: 0.45 },
        { transform: "scaleY(1)", offset: 0.55 },
        { transform: "scaleY(0)" },
      ],
      { at: start, dur, ease: token("--e-io") },
    );
}

/**
 * Intro A on a wordmark drawn by `wordmark()`: a timeline to play, its first frame already set. At its end it lets
 * go: its animations cancelled and the inline styles it set cleared, so the drawing is the one the CSS gives.
 */
export function introA(svg) {
  const tl = new Timeline();
  const chunks = [...svg.querySelectorAll(".chunk")];
  const eyes = [...svg.querySelectorAll("[data-eye]")];
  const letters = [...svg.querySelectorAll(".letter")];
  const ink = getComputedStyle(svg).color;
  const acc = getComputedStyle(svg).getPropertyValue("--acc").trim();
  for (const letter of letters) letter.style.opacity = "0";
  for (const eye of eyes) eye.style.opacity = "0";
  [0, 170, 330, 420, 560].forEach((start, i) => {
    chunks[i].style.transform = "scaleX(0)";
    tl.add(chunks[i], [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { at: start, dur: 240 });
  });
  tl.add(chunks[1], [{ fill: ink }, { fill: ink }], { at: 0, dur: 1 });
  for (const eye of eyes)
    tl.add(
      eye,
      [
        { opacity: 0, transform: "translateY(-90px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        at: 820,
        dur: 420,
      },
    );
  look(tl, svg, "up", "left", 820, 420);
  // the first line read: left, the middle (found), right
  look(tl, svg, "left", "rest", 1400, 200);
  tl.add(chunks[1], [{ fill: ink }, { fill: acc }], { at: 1640, dur: 180 });
  look(tl, svg, "rest", "right", 2000, 200);
  look(tl, svg, "right", "rest", 2500, 260);
  for (const [i, k] of ["l", "k", "o", "v", "e", "r"].entries())
    tl.add(
      svg.querySelector(`.letter-${k}`),
      [
        { opacity: 0, transform: "translateY(40px)" },
        { opacity: 1, transform: "none" },
      ],
      { at: 2440 + i * 70, dur: 360 },
    );
  blink(tl, svg, 3300);
  tl.onEnd = () => {
    tl.destroy();
    for (const el of [...letters, ...eyes]) el.style.opacity = "";
    for (const chunk of chunks) chunk.style.transform = "";
  };
  return tl.hold(3800).finish();
}
