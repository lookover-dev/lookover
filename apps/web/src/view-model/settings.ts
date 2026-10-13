// The settings in words: each setting's title and help, the choices of the three that are picked from a list, a
// value as the list of differences says it, and the command a change sends. Who reviews is said as ADR 0044 runs
// it: with both, the AI that didn't write the pull request finds, and the other double-checks each finding.
import type {
  Command,
  Depth,
  Repository,
  RepositoryId,
  Reviewers,
  Rule,
  SettingKey,
  SettingValue,
  SettingValues,
  Strictness,
} from "@lookover/contracts";
import { ruleText } from "@lookover/contracts";
import { REVIEWERS_TEXT } from "./select.ts";

/** One choice of a setting picked from a list: its value, its label and a line under it. */
export interface SettingChoice<T> {
  value: T;
  label: string;
  description?: string;
}

/** A setting picked from a list: the keys whose values are words, not on or off. */
export type PickKey = { [K in SettingKey]: SettingValues[K] extends string ? K : never }[SettingKey];

/**
 * The choices of each setting picked from a list, in the order the list shows them. Depth as ADR 0044 runs it: the
 * find pass once or twice, and the confirm pass or not.
 */
export const CHOICES: { [K in PickKey]: SettingChoice<SettingValues[K]>[] } = {
  strictness: Object.values({
    recommended: {
      value: "recommended",
      label: "Recommended",
      description: "Blocking and Should fix findings",
    },
    blocking: {
      value: "blocking",
      label: "Only blocking findings",
      description: "The rest stay in the check run and here",
    },
    everything: { value: "everything", label: "Everything", description: "For a final pass before release" },
  } satisfies Record<Strictness, SettingChoice<Strictness>>),
  depth: Object.values({
    quick: { value: "quick", label: "Quick", description: "Looks once, no double-check" },
    standard: { value: "standard", label: "Standard", description: "Looks once, then double-checks" },
    deep: { value: "deep", label: "Deep", description: "Looks twice, then double-checks" },
  } satisfies Record<Depth, SettingChoice<Depth>>),
  reviewers: Object.values({
    both: { value: "both", label: REVIEWERS_TEXT.both, description: "One finds, the other double-checks" },
    claude: { value: "claude", label: REVIEWERS_TEXT.claude },
    codex: { value: "codex", label: REVIEWERS_TEXT.codex },
  } satisfies Record<Reviewers, SettingChoice<Reviewers>>),
};

const isPick = (key: SettingKey): key is PickKey => Object.hasOwn(CHOICES, key);

/** A value picked from a list. */
type Picked = SettingValues[PickKey];

/**
 * `value` as `key`'s list shows it: the choice it is and the list's choices; null for a setting switched on or off,
 * or a value the list hasn't.
 */
export function pickOf(
  key: SettingKey,
  value: SettingValue,
): { choice: SettingChoice<Picked>; choices: SettingChoice<Picked>[] } | null {
  if (!isPick(key)) return null;
  const choices: SettingChoice<Picked>[] = CHOICES[key];
  const choice = choices.find((o) => o.value === value);
  return choice === undefined ? null : { choice, choices };
}

/**
 * Where a rule is from: the owner, or a repository's file at a line (contracts' `ruleText`), the number never
 * wrapped from its word, after the repository's name while it is listed.
 */
export function ruleSourceText(
  repos: Pick<Repository, "id" | "name">[],
  rule: Pick<Rule, "source" | "repoId" | "line">,
): string {
  if (rule.source === "yours") return "you";
  const where =
    rule.line === null
      ? rule.source
      : ruleText({ file: rule.source, line: rule.line }).replace(/ (\d+)$/, " $1");
  const repo = repos.find((r) => r.id === rule.repoId);
  return repo ? `${repo.name} · ${where}` : where;
}

/**
 * A rule's switch on the rules page (ADR 0049): its own switch, unless a rule it sits in is off. Then it shows off
 * and can't be moved, and says why; its own switch is kept for when that rule comes back on.
 */
export function ruleSwitch(rule: Pick<Rule, "enabled" | "parentOff">): {
  checked: boolean;
  why: string | null;
} {
  return rule.parentOff
    ? { checked: false, why: "Off with the rule it sits in." }
    : { checked: rule.enabled, why: null };
}

/**
 * Each setting's title, and the help under it (empty when the title says it all).
 */
export const SETTING_TEXT: Record<SettingKey, { title: string; help: string }> = {
  strictness: {
    title: "Strictness",
    help: "Recommended posts Blocking and Should fix findings. “Only blocking” keeps the rest in the check run and here.",
  },
  depth: {
    title: "Depth",
    help: "How hard each review looks. Deeper uses more of your Claude and ChatGPT plans.",
  },
  reviewers: {
    title: "Who reviews",
    help: "One AI, or both. With both, the one that didn't write the pull request finds, and the other double-checks each finding.",
  },
  onOpen: { title: "Review when a pull request is opened", help: "Or when a draft is marked ready." },
  onPush: {
    title: "Review again after every push",
    help: "Off: a pushed commit has no Lookover check until you or your agent ask, so a branch rule that requires the check waits.",
  },
};

/** Takes a list of keys only when it names every key: a new setting fails to compile until it is placed. */
function everyKey<const T extends readonly SettingKey[]>(
  keys: T & ([Exclude<SettingKey, T[number]>] extends [never] ? unknown : never),
): readonly SettingKey[] {
  return keys;
}

/** Every setting, in the order a repository's page lists them: depth beside strictness (ADR 0025). */
export const SETTING_KEYS = everyKey(["strictness", "depth", "reviewers", "onOpen", "onPush"]);

/** The help of your defaults' "When to review" row, the push switch's cost said in it (ADR 0049). */
export const WHEN_TEXT =
  "A /lookover review comment, yours or your agent's, or Review now starts a review unless reviews are paused. With “Again after every push” off, a pushed commit has no Lookover check until someone asks.";

/** A setting's value as the list of differences says it: a choice's label, on or off, else the value itself. */
export function settingValueText(key: SettingKey, value: SettingValue): string {
  const pick = pickOf(key, value);
  if (pick !== null) return pick.choice.label;
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/**
 * What choosing `value` in a setting's control sends: nothing when it is the value `shown`, else the change to
 * your defaults when `repoId` is null, or to that repository alone. Both pages' controls send through it.
 */
export function settingChange(
  repoId: RepositoryId | null,
  key: SettingKey,
  shown: SettingValue,
  value: SettingValue,
): Command | null {
  if (value === shown) return null;
  return repoId === null
    ? { type: "settings.set", key, value }
    : { type: "repo.setSetting", repoId, key, value };
}

/** Setup's line under the AIs: one or both, and what both do. */
export const SETUP_REVIEWERS_TEXT =
  "You can use one, or both. With both, one finds and the other double-checks each finding.";
