// The review page's button place (design-system.md "Button"): while a review runs or waits, a status stands in the
// button's place, announced by one visually hidden status line beside it, never by the hidden slots that keep its
// width; a button there is the filled primary only when the person is needed, else a secondary.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewButton } from "../view-model/select.ts";
import { ReviewButtonPlace } from "./review.tsx";

const STATUS = /<p class="visually-hidden" role="status">([^<]*)<\/p>/g;

const place = (shown: ReviewButton, primary = false) =>
  renderToStaticMarkup(<ReviewButtonPlace shown={shown} primary={primary} again={() => undefined} />);

test("running or waiting: one status line says the shown state's words; no slot is a status", () => {
  for (const [shown, words] of [
    ["running", "Reviewing…"],
    ["waiting", "Waiting…"],
  ] as const) {
    const html = place(shown);
    const said = [...html.matchAll(STATUS)];
    expect(said).toHaveLength(1);
    expect(said[0]?.[1]).toBe(words);
    expect(html.match(/role="status"/g)).toHaveLength(1);
  }
});

test("a button shown: the status line is there, empty", () => {
  for (const shown of ["now", "again"] as const) {
    const said = [...place(shown).matchAll(STATUS)];
    expect(said).toHaveLength(1);
    expect(said[0]?.[1]).toBe("");
  }
});

test("the button is filled only when the person is needed: every label of the place drawn alike", () => {
  const variants = (html: string) => [...html.matchAll(/class="btn btn-(\w+)/g)].map((m) => m[1]);
  expect(variants(place("again", false))).toEqual(["secondary", "secondary", "secondary"]);
  expect(variants(place("retry", true))).toEqual(["primary", "primary", "primary"]);
});
