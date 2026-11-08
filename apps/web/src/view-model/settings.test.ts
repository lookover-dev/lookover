import { expect, test } from "bun:test";
import { repositoryId } from "@lookover/contracts";
import {
  CHOICES,
  pickOf,
  ruleSource,
  ruleSwitch,
  SETTING_KEYS,
  settingChange,
  settingValueText,
} from "./settings.ts";

test("a rule's switch is its own, unless a rule it sits in is off: then off, held, and why", () => {
  expect(ruleSwitch({ enabled: true, parentOff: false })).toEqual({ checked: true, why: null });
  expect(ruleSwitch({ enabled: false, parentOff: false })).toEqual({ checked: false, why: null });
  const held = { checked: false, why: "Off with the rule it sits in." };
  expect(ruleSwitch({ enabled: true, parentOff: true })).toEqual(held);
  expect(ruleSwitch({ enabled: false, parentOff: true })).toEqual(held);
});

test("a rule says where it is from, its repository over its file and line, the line's number kept with its word; the owner's, you", () => {
  const billing = { id: repositoryId("sasensi/billing"), name: "billing" };
  const rule = { source: "REVIEW.md", repoId: billing.id, line: 3 } as const;
  // Two lines in the From column, so it is as narrow as a repository's name and the rule's words get the room
  // (round 6: on one line, "Amounts stay in integer cents…" wrapped beside a From column with room to spare). The
  // line's number is kept with its word by a no-break space.
  expect(ruleSource([billing], rule)).toEqual({ repo: "billing", where: "REVIEW.md, line 3" });
  // A repository no longer listed is never named "undefined": the file and line alone.
  expect(ruleSource([], rule)).toEqual({ repo: null, where: "REVIEW.md, line 3" });
  expect(ruleSource([billing], { source: "yours", repoId: null, line: null })).toEqual({
    repo: null,
    where: "you",
  });
});

test("depth is a three-way choice, said by its label, listed right after strictness", () => {
  expect(CHOICES.depth.map((c) => c.label)).toEqual(["Quick", "Standard", "Deep"]);
  expect(settingValueText("depth", "deep")).toBe("Deep");
  expect(SETTING_KEYS.slice(0, 2)).toEqual(["strictness", "depth"]);
  expect([...SETTING_KEYS].sort()).toEqual(["depth", "onOpen", "onPush", "reviewers", "strictness"]);
});

test("a setting picked from a list is said by its choice's label; a switch, on or off; a value no list has, as it is", () => {
  expect(settingValueText("strictness", "blocking")).toBe("Only blocking findings");
  expect(settingValueText("reviewers", "codex")).toBe("Codex");
  expect(settingValueText("onPush", false)).toBe("off");
  expect(pickOf("onPush", true)).toBeNull();
  // A value of another key's is no choice of this list: the picker isn't shown for it.
  expect(pickOf("depth", "blocking")).toBeNull();
  expect(settingValueText("depth", "blocking")).toBe("blocking");
  expect(pickOf("strictness", "everything")?.choice.label).toBe("Everything");
  expect(pickOf("strictness", "everything")?.choices).toBe(CHOICES.strictness);
});

test("depth on your defaults sends settings.set; on a repository, repo.setSetting for it alone", () => {
  const billing = repositoryId("sasensi/billing");
  expect(settingChange(null, "depth", "standard", "quick")).toEqual({
    type: "settings.set",
    key: "depth",
    value: "quick",
  });
  expect(settingChange(billing, "depth", "standard", "deep")).toEqual({
    type: "repo.setSetting",
    repoId: billing,
    key: "depth",
    value: "deep",
  });
});

test("choosing the value already shown sends nothing, on either page", () => {
  expect(settingChange(null, "depth", "deep", "deep")).toBeNull();
  expect(settingChange(repositoryId("sasensi/billing"), "depth", "quick", "quick")).toBeNull();
  expect(settingChange(null, "onPush", false, false)).toBeNull();
});
