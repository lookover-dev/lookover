// Whether the page may move: the head script sets `data-motion` on the root only when the system asks for no less
// motion: under reduced motion nothing plays and everything shows its last frame.

/** True when the page may play its motion. */
export const mayMove = () => document.documentElement.hasAttribute("data-motion");

/** A duration token (`--d-3`) in milliseconds, and an easing token (`--e-out`), as the page's CSS has them. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A duration token in milliseconds. */
export const ms = (name) => Number.parseFloat(token(name));
