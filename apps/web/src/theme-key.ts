// Where this browser keeps the theme it was given (`dark`, `light` or `system`; dark when none): the app's store
// reads and writes it, and the service's stand-alone pages read it (`standalone.ts`, ADR 0058).
export const THEME_KEY = "lookover.theme";
