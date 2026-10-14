import { expect, test } from "bun:test";
import { STANDALONE_STYLE } from "./standalone.ts";

/** The declarations of the first rule whose selector is exactly `selector`, as `{ name: value }`. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return {};
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(
    body
      .split(";")
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, "").trim())
      .filter((line) => line.startsWith("--"))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
}

test("the stand-alone pages get the tokens of both themes", () => {
  const dark = block(STANDALONE_STYLE, ":root");
  const light = block(STANDALONE_STYLE, ':root[data-theme="light"]');
  expect(dark["--bg"]).toBe("#17150f");
  expect(dark["--ink"]).toBe("#f4f1ea");
  expect(light["--bg"]).toBe("#f7f6f2");
  expect(light["--ink"]).toBe("#16130f");
});

test("the tokens come before the rules that read them, and nothing is fetched for them", () => {
  expect(STANDALONE_STYLE.indexOf("--bg:")).toBeLessThan(STANDALONE_STYLE.indexOf(".standalone"));
  expect(STANDALONE_STYLE).not.toContain("@import");
});
