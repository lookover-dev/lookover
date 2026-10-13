// Settings over their layers (ADR 0030, ADR 0011): Lookover's defaults, the owner's defaults, the owner's own
// value for one repository. Each key says what applies, where it comes from and what it overrode.
import { expect, test } from "bun:test";
import type { SettingsLayer, SettingValues } from "@lookover/contracts";
import { resolve, settingValues } from "./index.ts";

const owner = (values: Partial<SettingValues>): SettingsLayer => ({ origin: "owner-default", values });
const repository = (values: Partial<SettingValues>): SettingsLayer => ({
  origin: "owner-repository",
  values,
});

test("with nothing set, every key is Lookover's default and overrides nothing", () => {
  expect(resolve([])).toEqual({
    strictness: { value: "recommended", origin: "lookover-default", overrode: null },
    reviewers: { value: "both", origin: "lookover-default", overrode: null },
    depth: { value: "standard", origin: "lookover-default", overrode: null },
    onOpen: { value: true, origin: "lookover-default", overrode: null },
    onPush: { value: false, origin: "lookover-default", overrode: null },
  });
});

test("an owner's default overrides Lookover's", () => {
  const settings = resolve([owner({ onPush: true })]);
  expect(settings.onPush).toEqual({
    value: true,
    origin: "owner-default",
    overrode: { value: false, origin: "lookover-default" },
  });
  expect(settings.strictness.origin).toBe("lookover-default");
});

test("a repository's own value overrides what applies without it, whichever layer that is", () => {
  const settings = resolve([
    owner({ strictness: "everything" }),
    repository({ strictness: "blocking", reviewers: "claude" }),
  ]);
  expect(settings.strictness).toEqual({
    value: "blocking",
    origin: "owner-repository",
    overrode: { value: "everything", origin: "owner-default" },
  });
  expect(settings.reviewers).toEqual({
    value: "claude",
    origin: "owner-repository",
    overrode: { value: "both", origin: "lookover-default" },
  });
  expect(settings.onOpen).toEqual({ value: true, origin: "lookover-default", overrode: null });
});

test("layers out of order, an origin twice, or Lookover's own defaults as a layer are refused", () => {
  expect(() => resolve([repository({}), owner({})])).toThrow();
  expect(() => resolve([owner({}), owner({})])).toThrow();
  expect(() => resolve([{ origin: "lookover-default", values: {} }])).toThrow();
  expect(() => resolve([repository({ onPush: true })])).not.toThrow();
});

test("the values that apply are read without their origins", () => {
  expect(settingValues(resolve([owner({ onPush: true }), repository({ reviewers: "codex" })]))).toEqual({
    strictness: "recommended",
    reviewers: "codex",
    depth: "standard",
    onOpen: true,
    onPush: true,
  });
});
