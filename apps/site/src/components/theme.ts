// The theme switch's rules (design-system.md, "The site"), pure so they are tested as they are. The choice lives
// where Starlight keeps its own: `light` or `dark` under `starlight-theme`; nothing stored (or Starlight's empty
// "auto") follows the system, and a system that says nothing gets dark. Starlight's head script, the landing
// page's and the switch all read that one value.

/** A theme a page shows. */
export type Theme = "light" | "dark";

/** Starlight's key in `localStorage` (@astrojs/starlight 0.42.5, ThemeSelect.astro and ThemeProvider.astro). */
export const storageKey = "starlight-theme";

/** The theme a stored value names; anything but light or dark is no choice: the system's. */
export function readTheme(stored: string | null): Theme | undefined {
  return stored === "light" || stored === "dark" ? stored : undefined;
}

/** The theme a page shows: the stored one, else the system's, dark when the system doesn't ask for light. */
export function shownTheme(stored: Theme | undefined, prefersLight: boolean): Theme {
  return stored ?? (prefersLight ? "light" : "dark");
}

/** The theme a click on the switch goes to. */
export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** The switch's accessible name while `theme` shows: what a click does. */
export function switchLabel(theme: Theme): string {
  return `Switch to ${otherTheme(theme)} theme`;
}
