import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { otherTheme, readTheme, shownTheme, storageKey, switchLabel } from "./theme.ts";

describe("the theme switch's rules", () => {
  test("the choice is kept under Starlight's own key, so the landing page and the docs share it", () => {
    expect(storageKey).toBe("starlight-theme");
  });

  test("only light or dark stored is a choice; anything else follows the system", () => {
    expect(readTheme("light")).toBe("light");
    expect(readTheme("dark")).toBe("dark");
    expect(readTheme("auto")).toBeUndefined();
    expect(readTheme("")).toBeUndefined();
    expect(readTheme(null)).toBeUndefined();
  });

  test("a stored choice wins over the system", () => {
    expect(shownTheme("dark", true)).toBe("dark");
    expect(shownTheme("light", false)).toBe("light");
  });

  test("with no choice the page follows the system, and a system that says nothing gets dark", () => {
    expect(shownTheme(undefined, true)).toBe("light");
    expect(shownTheme(undefined, false)).toBe("dark");
  });

  test("a click goes to the other theme", () => {
    expect(otherTheme("dark")).toBe("light");
    expect(otherTheme("light")).toBe("dark");
  });

  test("the switch's name says what a click does", () => {
    expect(switchLabel("dark")).toBe("Switch to light theme");
    expect(switchLabel("light")).toBe("Switch to dark theme");
  });
});

describe("the theme switch's markup", () => {
  const markup = readFileSync(new URL("./ThemeSwitch.astro", import.meta.url), "utf8");

  test("holds both names as text, one per theme, so the name is right before any script runs", () => {
    expect(switchLabel("dark")).toBe("Switch to light theme");
    expect(switchLabel("light")).toBe("Switch to dark theme");
    // Rendered at build time from `switchLabel`, so the words live once; `site:check` reads them in the built page.
    expect(markup).toContain('import { switchLabel } from "./theme.ts";');
    expect(markup).toContain(`<span class="name when-dark">{switchLabel("dark")}</span>`);
    expect(markup).toContain(`<span class="name when-light">{switchLabel("light")}</span>`);
  });

  test("names the button by that text, not by an attribute the script would have to fix", () => {
    expect(markup).not.toContain("aria-label");
  });
});
