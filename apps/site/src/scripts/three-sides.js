// The three-sided story's motion: one timeline over the stage `story.ts` builds, about 20 s, one focus at a time
// (a halo around the side that acts, its title in ink), hand-offs as a line drawn behind a travelling dot, every
// change a crossfade in a reserved slot. Its colours are the page's tokens, as `var()` in the keyframes, so a
// theme switch mid-scene or at its end recolours it. The stage is drawn in its last frame by its CSS; taking it
// (`data-motion` on the root, the stage not `data-still`) shows its first frame, which the timeline plays from.
import { token } from "./motion.js";
import { Timeline } from "./timeline.js";

/* geometry on the 1280×712 stage */
const X = { agentR: 374, ghL: 438, ghR: 842, appL: 906, panelTop: 76 };

/** The time the agent's 17-character `lookover wait 148` took to type: `lookover wait` takes the same. */
const WAIT_TYPED = 17;

/** Builds the story's timeline on `stage`, at its first frame. */
export function threeSides(stage) {
  const EASE_IN = token("--e-in");
  const tl = new Timeline();
  const $ = (s) => stage.querySelector(s);
  const $$ = (s) => [...stage.querySelectorAll(s)];
  const ln = (n) => $(`[data-l="${n}"]`);
  const show = (el, at) => tl.show(el, at);
  const hide = (el, at) => tl.hide(el, at);
  const swap = (from, to, at, dur = 220) => {
    if (from) tl.add(from, [{ opacity: 1 }, { opacity: 0 }], { at, dur: 150, ease: EASE_IN });
    if (to) tl.add(to, [{ opacity: 0 }, { opacity: 1 }], { at: at + (from ? 140 : 0), dur });
  };
  const sides = {
    agent: $('[data-side="agent"]'),
    github: $('[data-side="github"]'),
    app: $('[data-side="app"]'),
  };
  const cur = { agent: 0, github: 0, app: 0 };
  /* the active side is lit: a halo around its panel and its title in ink; the others are left as they are */
  const title = (lit) => (lit ? "var(--ink)" : "var(--ink-2)");
  const focus = (at, on) => {
    for (const k of Object.keys(sides)) {
      const to = on.includes(k) ? 1 : 0;
      if (to === cur[k]) continue;
      tl.add(sides[k].querySelector(".ts-halo"), [{ opacity: cur[k] }, { opacity: to }], { at, dur: 420 });
      tl.add(sides[k].querySelector(".ts-label b"), [{ color: title(cur[k]) }, { color: title(to) }], {
        at,
        dur: 420,
      });
      cur[k] = to;
    }
  };
  const LINK = 760;
  const LINK1 = 900;
  const REACH = 18; // default reach of a line into a panel
  const links = $(".ts-links");
  let lid = 0;
  /* a hand-off: the dot leaves the sender and travels; the line is drawn behind it, never ahead; the line and
     the word stay a moment after it has arrived, then fade. `from` and `to` say how far inside each panel the
     line starts and ends (px), so a hand-off starts at the thing that acted and ends at the thing that answers. */
  const link = (x1, x2, y, at, label = "", dur = LINK, { from = REACH, to = REACH } = {}) => {
    const id = `tsl${++lid}`;
    const dir = x2 > x1 ? 1 : -1;
    const a = x1 - dir * from;
    const b = x2 + dir * to;
    const gapLeft = X.ghL - 32;
    const gapRight = X.ghR + 32;
    const c = (a + b) / 2;
    const mid = Math.abs(c - gapRight) < Math.abs(c - gapLeft) ? gapRight : gapLeft;
    links.insertAdjacentHTML(
      "beforeend",
      `<line id="${id}" x1="${a}" y1="${y}" x2="${b}" y2="${y}"/><text id="${id}t" x="${mid}" y="${y - 12}" text-anchor="middle">${label}</text><g class="ts-ldot" id="${id}d"><circle cx="0" cy="${y}" r="7"/></g>`,
    );
    const line = $(`#${id}`);
    const dot = $(`#${id}d`);
    const text = $(`#${id}t`);
    const len = Math.abs(b - a);
    const TRAVEL = "cubic-bezier(.3,0,.2,1)";
    line.style.strokeDasharray = len;
    // the dash pattern starts at (a, y), the sender, whatever the direction: a positive offset that shrinks to 0
    // grows the stroke from the sender; a negative one would grow it from the far end, ahead of the dot
    line.style.strokeDashoffset = len;
    tl.add(line, [{ opacity: 1 }, { opacity: 1 }], { at, dur: 1 });
    tl.add(line, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { at, dur, ease: TRAVEL });
    tl.add(line, [{ opacity: 1 }, { opacity: 0 }], { at: at + dur + 420, dur: 320, ease: EASE_IN });
    tl.add(
      dot,
      [
        { opacity: 1, transform: `translateX(${a}px)` },
        { opacity: 1, transform: `translateX(${b}px)` },
      ],
      { at, dur, ease: TRAVEL },
    );
    tl.add(dot, [{ opacity: 1 }, { opacity: 0 }], { at: at + dur, dur: 220, ease: EASE_IN });
    tl.add(text, [{ opacity: 0 }, { opacity: 1 }], { at: at + 120, dur: 220 });
    tl.add(text, [{ opacity: 1 }, { opacity: 0 }], { at: at + dur + 420, dur: 320, ease: EASE_IN });
    return at + dur; // when it arrives
  };
  const BUS = X.panelTop + 176; // one height for every hand-off: the row of the check run, what they talk through
  const Y = { push: BUS, seen: BUS, post: BUS, back: BUS };
  /* types a command at `cps` ms a character, or in the time `chars` characters take; returns when it is typed */
  const typeLine = (n, at, chars) => {
    const cps = 17;
    const l = ln(n);
    show(l, at);
    const ty = l.querySelector(".ts-ty");
    const caret = l.querySelector(".ts-caret");
    const n0 = chars ?? ty.textContent.length;
    tl.type(ty, at + 40, (cps * n0) / ty.textContent.length);
    tl.add(caret, [{ opacity: 1 }, { opacity: 1 }], { at, dur: 1 });
    tl.add(caret, [{ opacity: 1 }, { opacity: 0 }], {
      at: at + 40 + n0 * cps + 200,
      dur: 1,
      ease: "steps(1,end)",
    });
    return at + 40 + n0 * cps;
  };
  const steps = (round, times) => {
    const lis = $$(`[data-round="${round}"] .ts-astep`);
    lis.forEach((li, i) => {
      const [from, to] = times[i];
      hide(li.querySelector(".ts-aring-s"), from);
      show(li.querySelector(".ts-aeyes"), from);
      hide(li.querySelector(".ts-aeyes"), to);
      show(li.querySelector(".ts-acheck"), to);
      tl.add(li.querySelector(".ts-alabel"), [{ color: "var(--faint)" }, { color: "var(--ink)" }], {
        at: from,
        dur: 200,
      });
    });
    tl.add($(`[data-round="${round}"] .prg`), [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], {
      at: times[0][0],
      dur: times[lis.length - 1][1] - times[0][0],
      ease: "linear",
    });
  };
  for (const el of $$(".ts-ln")) el.style.opacity = 0;

  // 1 · the agent opens the pull request (0 – 2.6 s)
  focus(0, ["agent"]);
  let t = typeLine(1, 100);
  show(ln(2), t + 250);
  let arrive = link(X.agentR, X.ghL, Y.push, t + 350, "push", LINK1, { from: 30, to: 18 });
  focus(t + 350, ["agent", "github"]);
  swap($("[data-gh=empty]"), $("[data-gh=pr]"), arrive, 240);
  show($('[data-chk="wait"]'), arrive);
  t = typeLine(4, arrive + 150, WAIT_TYPED);
  show(ln(5), t + 300);
  // 2 · Lookover sees it and runs the review (2.6 – 6 s)
  const seen = t + 500;
  arrive = link(X.ghR, X.appL, Y.seen, seen, "seen", LINK, { from: 18, to: 16 });
  focus(seen, ["github", "app"]);
  swap($("[data-ap=home]"), $("[data-ap=review]"), arrive, 240);
  show($('[data-chip="r1"]'), arrive + 100);
  tl.rise($('[data-round="1"]'), arrive + 150, 300);
  swap($('[data-chk="wait"]'), $('[data-chk="r1"]'), arrive + 100);
  focus(arrive + 300, ["app"]);
  const n1 = $$('[data-round="1"] .ts-astep').length;
  const r1 = [];
  const s0 = arrive + 350;
  const s1 = s0 + 2900;
  const per = (s1 - s0 - 300) / (n1 - 1);
  for (let i = 0; i < n1 - 1; i++) r1.push([s0 + per * i, s0 + per * (i + 1)]);
  r1.push([s1 - 300, s1]);
  steps(1, r1);
  // 3 · one review lands; the finding is held (≈6 – 9.3 s)
  const post = s1 + 100;
  arrive = link(X.appL, X.ghR, Y.post, post, "review", LINK, { from: 16, to: 18 });
  focus(post, ["app", "github"]);
  swap($('[data-round="1"]'), $('.ts-acard[data-verdict="1"]'), post + 200, 240);
  swap($('[data-chip="r1"]'), $('[data-chip="fix"]'), post + 300);
  tl.rise($("[data-review]"), arrive, 300);
  show($('.ts-rvtext[data-verdict="1"]'), arrive);
  tl.rise($("[data-finding]"), arrive + 200, 300);
  tl.add($(".ts-mkr"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
    at: arrive + 480,
    dur: 360,
  });
  show($('[data-sev="blocking"]'), arrive + 480);
  swap($('[data-chk="r1"]'), $('[data-chk="found"]'), arrive + 560);
  focus(arrive + 400, ["github"]);
  // 4 · the agent is told, fixes, asks again (≈9.3 – 14 s)
  const back = arrive + 480 + 2900;
  arrive = link(X.ghL, X.agentR, Y.back, back, "to fix", LINK, { from: 18, to: 30 });
  focus(back, ["github", "agent"]);
  swap(ln(5), ln(6), arrive);
  focus(arrive + 200, ["agent"]);
  t = typeLine(7, arrive + 450);
  show(ln(8), t + 250);
  const push2 = t + 400;
  arrive = link(X.agentR, X.ghL, Y.push, push2, "push", LINK, { from: 30, to: 18 });
  focus(push2, ["agent", "github"]);
  tl.add($(".ts-thread"), [{ opacity: 0 }, { opacity: 1 }], { at: arrive, dur: 200 });
  tl.rise($("[data-reply]"), arrive + 40, 240);
  t = typeLine(10, arrive + 100, WAIT_TYPED);
  show(ln(11), t + 250);
  const seen2 = t + 900; // the agent's fix and reply stay on screen before the hand-off back
  arrive = link(X.ghR, X.appL, Y.seen, seen2, "round 2", LINK, { from: 18, to: 16 });
  focus(seen2, ["github", "app"]);
  swap($('.ts-acard[data-verdict="1"]'), $('[data-round="2"]'), arrive, 240);
  swap($('[data-chip="fix"]'), $('[data-chip="r2"]'), arrive + 100);
  swap($('[data-chk="found"]'), $('[data-chk="r2"]'), arrive + 100);
  focus(arrive + 300, ["app"]);
  steps(2, [
    [arrive + 300, arrive + 1300],
    [arrive + 1300, arrive + 1550],
  ]);
  // 5 · verified fixed: one resolution, then a short hold
  const post2 = arrive + 1650;
  arrive = link(X.appL, X.ghR, Y.post, post2, "verified", LINK, { from: 16, to: 18 });
  focus(post2, ["app", "github"]);
  swap($('[data-round="2"]'), $('.ts-acard[data-verdict="2"]'), post2 + 150, 240);
  swap($('[data-chip="r2"]'), $('[data-chip="clean"]'), post2 + 250);
  tl.rise($("[data-verified]"), arrive, 240);
  swap($('[data-sev="blocking"]'), $('[data-sev="fixed"]'), arrive + 60);
  tl.add($(".ts-mkr"), [{ backgroundColor: "var(--acc-soft)" }, { backgroundColor: "var(--ok-soft)" }], {
    at: arrive + 60,
    dur: 300,
  });
  swap($('[data-chk="r2"]'), $('[data-chk="clear"]'), arrive + 150);
  swap($('.ts-rvtext[data-verdict="1"]'), $('.ts-rvtext[data-verdict="2"]'), arrive + 150);
  const back2 = arrive + 250;
  const arrive2 = link(X.ghL, X.agentR, Y.back, back2, "clear", LINK, { from: 18, to: 30 });
  focus(back2, ["agent", "github", "app"]);
  swap(ln(11), ln(12), arrive2);
  tl.rise($("[data-merge]"), arrive2 + 150, 320);
  tl.hold(arrive2 + 2000).finish();
  const det = { rounds: $('[data-det="rounds"]'), sha: $('[data-det="sha"]'), addr: $("[data-addr]") };
  tl.onTickExtra = (t2) => {
    const r2 = t2 >= seen2 + LINK;
    det.rounds.textContent = r2 ? "2" : "1";
    det.sha.textContent = r2 ? "b2c3d4e" : "a1f9c2e";
    det.addr.textContent = t2 >= seen + LINK ? "/reviews/148" : "/reviews";
  };
  tl.onTickExtra(0);
  return tl;
}

/** Replay without a snap: fade the stage out, seek to the start, fade back in and play. */
export function replayThreeSides(tl, wrap, done) {
  const out = wrap.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 260,
    easing: token("--e-in"),
    fill: "forwards",
  });
  out.onfinish = () => {
    tl.pause();
    tl.seek(0);
    wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: token("--e-out") }).onfinish =
      () => {
        out.cancel();
        tl.play(0);
        done?.();
      };
  };
}

/** Scales the stage to its host's width, now and whenever the host's width changes. */
export function fitThreeSides(host) {
  const scale = () => {
    const stage = host.querySelector(".ts-stage");
    if (stage) stage.style.transform = `scale(${host.clientWidth / 1280})`;
  };
  new ResizeObserver(scale).observe(host);
  scale();
}
