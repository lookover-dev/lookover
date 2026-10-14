// The story section: the three-sided scene, scaled to its column, played once when it comes into view, then "Play
// again", which fades it out and plays it from the start. Under reduced motion, or when its timeline can't be
// built, it stays in its last frame, as its CSS draws it, and nothing moves.
import { mayMove } from "./motion.js";
import { fitThreeSides, replayThreeSides, threeSides } from "./three-sides.js";

/** Wires the story, if the page has one. */
export function story() {
  const host = document.querySelector("[data-story]");
  const wrap = host?.querySelector(".ts-wrap");
  const again = host?.querySelector("[data-replay]");
  if (!wrap || !again) return;
  fitThreeSides(wrap);
  if (!mayMove()) return;
  const drawn = wrap.innerHTML;
  let tl;
  try {
    tl = threeSides(wrap.querySelector(".ts-stage"));
  } catch (error) {
    // The scene is a picture of the loop: without its motion it shows as drawn, at its end.
    wrap.innerHTML = drawn;
    wrap.dataset.still = "";
    console.error(error);
    return;
  }
  tl.onEnd = () => {
    again.hidden = false;
  };
  // For `site:strip`, which shoots the scene a frame at a time, and `site:check`, which plays its end: how long it
  // is, a `story:seek` event (its time in ms as `detail`) that stops it there, and `story:play` that plays from there.
  wrap.dataset.duration = String(tl.duration);
  wrap.addEventListener("story:seek", (event) => {
    tl.pause();
    tl.seek(event.detail);
  });
  wrap.addEventListener("story:play", (event) => {
    tl.pause();
    tl.play(event.detail);
  });
  again.addEventListener("click", () => {
    // The button goes while the scene plays again: the focus stays in the story, on the scene's box, not the page.
    const box = again.closest("[tabindex]");
    const focused = document.activeElement === again;
    again.hidden = true;
    if (focused && box instanceof HTMLElement) box.focus({ preventScroll: true });
    replayThreeSides(tl, wrap);
  });
  if (!("IntersectionObserver" in window)) {
    tl.play(0);
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      tl.play(0);
    },
    { threshold: 0.4 },
  );
  seen.observe(wrap);
}
