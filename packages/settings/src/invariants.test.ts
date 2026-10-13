// The invariants of layered settings over their files (ADR 0011, ADR 0030, ADR 0049), over generated changes: a value
// set is read back; a reset gives the inherited value with the lower origin; setting the inherited value stores
// nothing; the origin always names a layer whose file holds the key; and what the changes wrote reads back as they
// left it, rule switches included, whatever order unrelated keys were written in. Runs capped at 100 each.
import { expect, test } from "bun:test";
import type {
  RulesFileName,
  SettingKey,
  SettingOrigin,
  SettingValue,
  SettingValues,
} from "@lookover/contracts";
import { normalisedRuleText } from "@lookover/contracts";
import fc from "fast-check";
import { type RepositoryFiles, type SettingsFiles, type SettingsRoom, settingsFiles } from "./index.ts";

const RUNS = { numRuns: 100 };
const OWNER = "settings.yaml";
const REPO = "acme/api/settings.yaml";

function memory(): { files: SettingsFiles; disk: Map<string, string> } {
  const disk = new Map<string, string>();
  return {
    disk,
    files: {
      read: async (file) => disk.get(file) ?? null,
      write: async (file, text) => {
        disk.set(file, text);
      },
      remove: async (file) => {
        disk.delete(file);
      },
    },
  };
}

/** One change: a key and a value it accepts. */
type Edit = { [K in SettingKey]: { key: K; value: SettingValues[K] } }[SettingKey];
type Origin = "owner-default" | "owner-repository";

const VALUES: { [K in SettingKey]: fc.Arbitrary<SettingValues[K]> } = {
  strictness: fc.constantFrom("recommended", "blocking", "everything"),
  reviewers: fc.constantFrom("both", "claude", "codex"),
  depth: fc.constantFrom("quick", "standard", "deep"),
  onOpen: fc.boolean(),
  onPush: fc.boolean(),
};
const KEYS = Object.keys(VALUES).filter((k): k is SettingKey => k in VALUES);
const edit: fc.Arbitrary<Edit> = fc.oneof(
  VALUES.strictness.map((value): Edit => ({ key: "strictness", value })),
  VALUES.reviewers.map((value): Edit => ({ key: "reviewers", value })),
  VALUES.depth.map((value): Edit => ({ key: "depth", value })),
  VALUES.onOpen.map((value): Edit => ({ key: "onOpen", value })),
  VALUES.onPush.map((value): Edit => ({ key: "onPush", value })),
);
const origin = fc.constantFrom<Origin>("owner-default", "owner-repository");
const key = fc.constantFrom(...KEYS);

/** A rule's text: words with any spacing around them, a YAML-looking word or a quote now and then. */
const ruleText = fc
  .array(
    fc.constantFrom("Never", "log", "a", "token.", "#", "key:", "'x'", "- y", "true", "  ", "\n", "\t"),
    {
      minLength: 1,
      maxLength: 8,
    },
  )
  .map((words) => words.join(" "))
  .filter((text) => text.trim() !== "");
const rulesFile = fc.constantFrom<RulesFileName>("REVIEW.md", "AGENTS.md", "CLAUDE.md");
/** A repository's rules, one per file and normalised text, as core reads them. */
const rules = fc
  .uniqueArray(fc.record({ source: rulesFile, text: ruleText }), {
    selector: (r) => `${r.source}\n${normalisedRuleText(r.text)}`,
    maxLength: 4,
  })
  .map((list) => list.map((r, i) => ({ id: `r${i}`, ...r })));

type Step =
  | { kind: "set"; origin: Origin; edit: Edit }
  | { kind: "reset"; origin: Origin; key: SettingKey }
  | { kind: "rule"; index: number; enabled: boolean };
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), origin, edit }),
  fc.record({ kind: fc.constant("reset" as const), origin, key }),
  fc.record({ kind: fc.constant("rule" as const), index: fc.nat(3), enabled: fc.boolean() }),
);

/** Sets one value in the layer at `o`. */
async function setIn(room: SettingsRoom, at: RepositoryFiles, o: Origin, e: Edit): Promise<void> {
  const written =
    o === "owner-default"
      ? await room.setDefault(at.owner, e.key, e.value)
      : await room.set(at, e.key, e.value);
  if (!written.ok) throw new Error("a valid file was refused");
}

/** Runs the steps; a rule step for a rule the repository doesn't have is skipped. */
async function play(files: SettingsFiles, at: RepositoryFiles, steps: Step[]): Promise<void> {
  const room = settingsFiles(files);
  for (const s of steps) {
    if (s.kind === "set") await setIn(room, at, s.origin, s.edit);
    else if (s.kind === "reset" && s.origin === "owner-default") await room.resetDefault(at.owner, s.key);
    else if (s.kind === "reset") await room.reset(at, s.key);
    else {
      const rule = at.rules[s.index];
      if (rule) await room.setRule(at, rule.id, s.enabled);
    }
  }
}

/** Lookover's defaults, as ADR 0025, 0026 and 0044 give them. */
const LOOKOVER: SettingValues = {
  strictness: "recommended",
  reviewers: "both",
  depth: "standard",
  onOpen: true,
  onPush: false,
};

/** One step on the model: a value equal to the layer below's is not kept; a reset drops it; a switch is the last one. */
function model(
  layers: Record<Origin, Partial<SettingValues>>,
  off: Set<string>,
  list: { id: string }[],
  s: Step,
): void {
  if (s.kind === "rule") {
    const rule = list[s.index];
    if (rule && s.enabled) off.delete(rule.id);
    else if (rule) off.add(rule.id);
    return;
  }
  const values: Partial<Record<SettingKey, unknown>> = layers[s.origin];
  if (s.kind === "reset") {
    delete values[s.key];
    return;
  }
  const { key: k, value } = s.edit;
  const below = s.origin === "owner-default" ? LOOKOVER[k] : (layers["owner-default"][k] ?? LOOKOVER[k]);
  if (value === below) delete values[k];
  else values[k] = value;
}

/** Whether the file holds `key` as a top-level line. */
const holds = (text: string | undefined, k: string) =>
  text?.split("\n").some((l) => l.startsWith(`${k}:`)) ?? false;

test("a value set is read back, from the layer it was set in or, when equal to the layer below's, from that one", async () => {
  await fc.assert(
    fc.asyncProperty(rules, fc.array(step, { maxLength: 8 }), origin, edit, async (list, steps, o, e) => {
      const { files } = memory();
      const at = { owner: OWNER, repository: REPO, rules: list };
      await play(files, at, steps);
      const room = settingsFiles(files);
      await setIn(room, at, o, e);
      const now =
        o === "owner-default" ? (await room.readDefaults(OWNER)).defaults : (await room.read(at)).settings;
      expect(now[e.key].value).toEqual(e.value);
    }),
    RUNS,
  );
});

test("a reset gives the inherited value, with the lower layer's origin", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { maxLength: 8 }), key, async (steps, k) => {
      const { files } = memory();
      const at = { owner: OWNER, repository: REPO, rules: [] };
      await play(files, at, steps);
      const room = settingsFiles(files);
      const before = await room.read(at);
      const written = await room.reset(at, k);
      if (!written.ok) throw new Error("a valid file was refused");
      expect(written.now.settings[k]).toEqual(before.defaults[k]);
      const owner = await room.resetDefault(OWNER, k);
      if (!owner.ok) throw new Error("a valid file was refused");
      expect(owner.now.defaults[k].origin).toBe("lookover-default");
    }),
    RUNS,
  );
});

test("setting the value the layer below gives stores nothing: the key leaves the file and keeps the lower origin", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { maxLength: 8 }), key, async (steps, k) => {
      const { files, disk } = memory();
      const at = { owner: OWNER, repository: REPO, rules: [] };
      await play(files, at, steps);
      const room = settingsFiles(files);
      const inherited = (await room.read(at)).defaults[k];
      const written = await room.set(at, k, inherited.value);
      if (!written.ok) throw new Error("a valid file was refused");
      expect(holds(disk.get(REPO), k)).toBe(false);
      expect(written.now.settings[k]).toEqual(inherited);
    }),
    RUNS,
  );
});

test("the origin always names a layer whose file holds the key; Lookover's default, neither file", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(step, { maxLength: 12 }), async (steps) => {
      const { files, disk } = memory();
      const at = { owner: OWNER, repository: REPO, rules: [] };
      await play(files, at, steps);
      const { settings } = await settingsFiles(files).read(at);
      for (const k of KEYS) {
        const { origin: from } = settings[k];
        expect(holds(disk.get(REPO), k)).toBe(from === "owner-repository");
        if (from === "owner-default") expect(holds(disk.get(OWNER), k)).toBe(true);
        if (from === "lookover-default") expect(holds(disk.get(OWNER), k)).toBe(false);
      }
    }),
    RUNS,
  );
});

test("what the changes wrote reads back as they left it, rule switches included, in a fresh read of the files", async () => {
  await fc.assert(
    fc.asyncProperty(rules, fc.array(step, { maxLength: 12 }), async (list, steps) => {
      const { files } = memory();
      const at = { owner: OWNER, repository: REPO, rules: list };
      // The model: each layer's values and each rule's switch, as the steps leave them.
      const layers: Record<Origin, Partial<SettingValues>> = { "owner-default": {}, "owner-repository": {} };
      const off = new Set<string>();
      for (const s of steps) model(layers, off, list, s);
      await play(files, at, steps);
      const read = await settingsFiles(files).read(at);
      expect(read.invalid).toEqual([]);
      expect([...read.rulesOff].sort()).toEqual([...off].sort());
      for (const k of KEYS) {
        const own = layers["owner-repository"][k];
        const owners = layers["owner-default"][k];
        const [value, from]: [SettingValue, SettingOrigin] =
          own !== undefined
            ? [own, "owner-repository"]
            : owners !== undefined
              ? [owners, "owner-default"]
              : [LOOKOVER[k], "lookover-default"];
        expect([read.settings[k].value, read.settings[k].origin]).toEqual([value, from]);
      }
    }),
    RUNS,
  );
});

test("unrelated keys written in any order resolve the same", async () => {
  const unrelated = fc
    .uniqueArray(fc.tuple(origin, edit), { selector: ([o, e]) => `${o}:${e.key}`, maxLength: 8 })
    .chain((list) => fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length })));
  await fc.assert(
    fc.asyncProperty(unrelated, async ([list, shuffled]) => {
      const at = { owner: OWNER, repository: REPO, rules: [] };
      const resolved = async (order: [Origin, Edit][]) => {
        const { files } = memory();
        // The owner's defaults first: a repository's value is kept only when it differs from what they give.
        const sorted = order
          .filter(([o]) => o === "owner-default")
          .concat(order.filter(([o]) => o !== "owner-default"));
        await play(
          files,
          at,
          sorted.map(([o, e]) => ({ kind: "set", origin: o, edit: e })),
        );
        return (await settingsFiles(files).read(at)).settings;
      };
      expect(await resolved(shuffled)).toEqual(await resolved(list));
    }),
    RUNS,
  );
});
