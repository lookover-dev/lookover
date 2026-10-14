// The copy buttons: a click copies the button's `data-copy` and shows the check beside the command
// for a moment, the feedback next to its trigger; the button's name says it was copied.

const SHOWN_MS = 1400;

/** Wires every `[data-copy]` button on the page. */
export function copyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    let timer = 0;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? "");
      } catch {
        return; // nothing was copied (no permission, no secure page), so nothing says it was
      }
      button.dataset.copied = "";
      button.setAttribute("aria-label", "Copied");
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", "Copy");
      }, SHOWN_MS);
    });
  }
}
