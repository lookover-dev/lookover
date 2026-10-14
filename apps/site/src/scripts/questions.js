// The questions' accordion, the design system's disclosure: the whole row is the control, the chevron
// turns, the answer slides open over `--d-3` and closed over `--d-2`; at once when the page may not move.
import { mayMove, ms, token } from "./motion.js";

/** Wires every `<details>` of the questions. */
export function questions() {
  for (const details of document.querySelectorAll(".faq details")) {
    const summary = details.querySelector("summary");
    const panel = details.querySelector(".panel");
    if (!(summary && panel)) continue;
    let busy = false;
    summary.addEventListener("click", (event) => {
      if (!mayMove()) return; // the browser opens and closes it itself
      event.preventDefault();
      if (busy) return;
      busy = true;
      if (details.open) {
        const height = panel.offsetHeight;
        const closing = panel.animate(
          [
            { height: `${height}px`, opacity: 1 },
            { height: "0px", opacity: 0 },
          ],
          { duration: ms("--d-2"), easing: token("--e-in") },
        );
        closing.onfinish = () => {
          details.open = false;
          busy = false;
        };
      } else {
        details.open = true;
        const height = panel.offsetHeight;
        const opening = panel.animate(
          [
            { height: "0px", opacity: 0 },
            { height: `${height}px`, opacity: 1 },
          ],
          { duration: ms("--d-3"), easing: token("--e-out") },
        );
        opening.onfinish = () => {
          busy = false;
        };
      }
    });
  }
}
