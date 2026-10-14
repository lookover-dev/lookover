// The landing page's script: intro A once on the hero's wordmark, then nothing moves there; the reveals, the
// three-sided story, the copy buttons, the questions' accordion. What moves waits for `mayMove()` (motion.js).
// `data-motion="on"` says the motion is wired: the head script takes `data-motion` away when the page is parsed
// without it, so a script that failed to load or threw leaves every element in its last frame, never hidden.
import { copyButtons } from "./copy.js";
import { introA } from "./intro-a.js";
import { mayMove } from "./motion.js";
import { questions } from "./questions.js";
import { reveals } from "./reveal.js";
import { story } from "./story.js";

const root = document.documentElement;
const wordmark = document.querySelector("[data-hero-intro] .wordmark");
if (wordmark && mayMove()) {
  const drawn = wordmark.outerHTML;
  try {
    introA(wordmark).play();
  } catch (error) {
    // The intro is a flourish: without it the wordmark shows as drawn.
    wordmark.outerHTML = drawn;
    console.error(error);
  }
}
reveals();
story();
// The first frame is set (by the intro, or by nothing) and the reveals wired: the CSS that held the page lets go.
if (root.dataset.motion === "intro") root.dataset.motion = "on";

copyButtons();
questions();
