// A timeline: a group of Web Animations with one clock, so a scene can play, seek and hold its end. Intro A plays on
// it; the three-sided story can too. The motion stays JavaScript.
import { token } from "./motion.js";

export class Timeline {
  constructor() {
    this.anims = [];
    this.duration = 0;
    this.rate = 1;
    this.master = null;
    this.onTick = null;
    this.onTickExtra = null;
    /** Called once a play reaches the end and holds its last frame. */
    this.onEnd = null;
    this._raf = 0;
  }

  /** Animates `el` from `at` ms for `dur` ms; keyframes as `element.animate()` takes them; the easing `--e-out`. */
  add(el, keyframes, { at = 0, dur = 300, ease = token("--e-out"), fill = "forwards", iterations = 1 } = {}) {
    if (!el) throw new Error("Timeline.add: missing element");
    // endDelay: a finished fill-forwards animation loses its end value about half the time while the page plays
    // (Chromium, measured); one that never finishes during the scene holds it.
    const a = el.animate(keyframes, {
      duration: dur,
      delay: at,
      easing: ease,
      fill,
      iterations,
      endDelay: iterations === Number.POSITIVE_INFINITY ? 0 : 3600000,
    });
    a.persist(); // or the browser removes a finished fill-forwards animation once a later one covers the property
    a.pause();
    a.currentTime = 0;
    this.anims.push(a);
    this.duration = Math.max(
      this.duration,
      at + dur * (iterations === Number.POSITIVE_INFINITY ? 1 : iterations),
    );
    return this;
  }

  /** Shows an element at `at` (hidden before): opacity only, no movement. */
  show(el, at, dur = 1) {
    return this.add(el, [{ opacity: 0 }, { opacity: 1 }], { at, dur, ease: "steps(1,end)" });
  }

  /** Hides an element at `at`. */
  hide(el, at, dur = 1) {
    return this.add(el, [{ opacity: 1 }, { opacity: 0 }], { at, dur, ease: "steps(1,end)" });
  }

  /** Rises in: fade and 8 px up, the design system's section reveal. */
  rise(el, at, dur = 320, dy = 8) {
    return this.add(
      el,
      [
        { opacity: 0, transform: `translateY(${dy}px)` },
        { opacity: 1, transform: "none" },
      ],
      {
        at,
        dur,
      },
    );
  }

  /** Types an inline-block with its overflow hidden: its width in ch, stepped. */
  type(el, at, msPerChar = 38) {
    const n = el.textContent.length;
    el.style.width = "0ch";
    return this.add(el, [{ width: "0ch" }, { width: `${n}ch` }], {
      at,
      dur: n * msPerChar,
      ease: `steps(${n},end)`,
    });
  }

  /** Appends another timeline at `at` ms: its animations move into this one, their delays shifted. */
  append(sub, at) {
    sub.finish();
    for (const a of sub.anims) {
      if (a === sub.master) {
        a.cancel();
        a.effect?.target?.remove();
        continue;
      }
      a.effect.updateTiming({ delay: a.effect.getTiming().delay + at });
      this.anims.push(a);
    }
    this.duration = Math.max(this.duration, at + sub.duration);
    if (sub.onTickExtra) {
      const prev = this.onTickExtra;
      const f = sub.onTickExtra;
      this.onTickExtra = (t) => {
        prev?.(t);
        f(t - at);
      };
    }
    return this;
  }

  /** Holds the end: extends the duration, nothing more. */
  hold(until) {
    this.duration = Math.max(this.duration, until);
    return this;
  }

  /** Closes the timeline: its clock, an animation as long as the whole, which says when it ends. */
  finish() {
    if (!this.master) {
      const d = document.createElement("i");
      d.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
      document.body.appendChild(d);
      this.master = d.animate([{ opacity: 1 }, { opacity: 1 }], { duration: this.duration, fill: "both" });
      this.master.pause();
      this.master.currentTime = 0;
      this.anims.push(this.master);
    }
    return this;
  }

  get time() {
    return Number(this.master?.currentTime ?? 0);
  }

  get playing() {
    return this.master?.playState === "running";
  }

  _emit(t) {
    this.onTickExtra?.(t);
    this.onTick?.(t);
  }

  seek(t) {
    this.finish();
    const c = Math.max(0, Math.min(this.duration, t));
    for (const a of this.anims) a.currentTime = c;
    this._emit(c);
  }

  pause() {
    for (const a of this.anims) a.pause();
    cancelAnimationFrame(this._raf);
    this._emit(this.time);
  }

  setRate(r) {
    this.rate = r;
    for (const a of this.anims) a.playbackRate = r;
  }

  /** Plays from `from`, or from where it is (from the start once it has ended); holds the last frame at the end. */
  play(from) {
    this.finish();
    if (from !== undefined || this.time >= this.duration) this.seek(from ?? 0);
    for (const a of this.anims) {
      a.playbackRate = this.rate;
      a.play();
    }
    const tick = () => {
      this._emit(this.time);
      if (this.master.playState === "running") this._raf = requestAnimationFrame(tick);
      else {
        for (const a of this.anims) a.pause();
        this.seek(this.duration);
        this.onEnd?.();
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    for (const a of this.anims) a.cancel();
    this.master?.effect?.target?.remove();
  }
}
