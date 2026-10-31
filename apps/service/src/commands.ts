// The commands as they arrive over HTTP, parsed at the edge with Zod (spec #17): the app's `Command`, plus the
// developer drawer's `refresh` ("list the pull requests now") and the demo verbs (ADR 0046: a fault, the clock).
// Nothing past this file re-checks them. Each enum is tied to the contracts type it parses (`enumOf`).
import {
  type Command,
  changeId,
  type DemoCommand,
  type EngineId,
  enumOf,
  type FaultId,
  findingId,
  type PauseFor,
  repositoryId,
  type SettingKey,
  type SettingValue,
  type SetupStep,
} from "@lookover/contracts";
import { settingAccepts } from "@lookover/settings";
import { z } from "zod";

const engine = enumOf<EngineId>()(["claude", "codex"]);
const change = z.string().min(1).transform(changeId);
const finding = z.string().min(1).transform(findingId);
const repo = z.string().min(1).transform(repositoryId);
const settingKey = enumOf<SettingKey>()(["strictness", "reviewers", "depth", "onOpen", "onPush"]);
/**
 * What each key accepts is settings' check, the one a file's values are read with: a value no key accepts isn't a
 * setting, and one of another key's (strictness `true`, say) is refused, never written to a file.
 */
const settingValue = z.custom<SettingValue>((value) =>
  settingKey.options.some((key) => settingAccepts(key, value)),
);
/** The value is one its key accepts. */
const fits = ({ key, value }: { key: SettingKey; value: SettingValue }) => settingAccepts(key, value);
const FITS = { message: "the value is not one its key accepts", path: ["value"] };

const noise = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wrong"), changeId: change, findingId: finding }),
  z.object({ kind: z.literal("blocking-only"), changeId: change }),
  z.object({ kind: z.literal("rule-off"), changeId: change, findingId: finding }),
]);

/** Every command of `LookoverApi`, one variant each, so a new command fails here until it is added. */
const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("engine.signIn"), id: engine }),
  z.object({ type: z.literal("engine.check") }),
  z.object({ type: z.literal("engine.reroute"), from: engine }),
  // The organisation is taken only once the person's `gh` lists it as theirs to admin (ADR 0059): any text parses.
  z.object({ type: z.literal("connection.createApp"), organisation: z.string().min(1).nullable() }),
  z.object({ type: z.literal("gh.check") }),
  // The key is checked for being there only: a refusal of Zod's names the field, never its value (ADR 0053).
  z.object({
    type: z.literal("connection.useApp"),
    appId: z.number().int().positive(),
    key: z.string().min(1),
  }),
  z.object({ type: z.literal("connection.signIn") }),
  z.object({ type: z.literal("connection.cancelSignIn") }),
  // The account is taken only once it is one `Connection.unreached` names (ADR 0067): any login parses.
  z.object({ type: z.literal("connection.askToInstall"), account: z.string().min(1) }),
  z.object({ type: z.literal("connection.reconnect") }),
  z.object({
    type: z.literal("setup.goto"),
    step: enumOf<SetupStep>()(["ai", "github", "repos", "first-review", "agent", "background"]),
  }),
  z.object({ type: z.literal("setup.chooseRepos"), enabled: z.array(repo) }),
  z.object({ type: z.literal("setup.firstReview"), changeId: change, preview: z.boolean() }),
  z.object({ type: z.literal("setup.finish") }),
  z.object({ type: z.literal("review.request"), changeId: change }),
  z.object({ type: z.literal("noise.apply"), choice: noise }),
  z.object({ type: z.literal("service.pause"), for: enumOf<PauseFor>()(["hour", "tomorrow", "forever"]) }),
  z.object({ type: z.literal("service.resume") }),
  z.object({ type: z.literal("service.runChecks") }),
  z.object({ type: z.literal("service.unlock") }),
  z.object({ type: z.literal("service.startAtLogin"), on: z.boolean() }),
  z.object({ type: z.literal("agent.path"), on: z.boolean() }),
  z.object({ type: z.literal("agent.skill"), agent: engine, on: z.boolean() }),
  z.object({ type: z.literal("agent.check") }),
  z.object({ type: z.literal("settings.set"), key: settingKey, value: settingValue }).refine(fits, FITS),
  z.object({ type: z.literal("repo.setEnabled"), repoId: repo, enabled: z.boolean() }),
  z
    .object({ type: z.literal("repo.setSetting"), repoId: repo, key: settingKey, value: settingValue })
    .refine(fits, FITS),
  z.object({ type: z.literal("repo.resetSetting"), repoId: repo, key: settingKey }),
  z.object({ type: z.literal("repo.dismiss"), repoId: repo }),
  z.object({ type: z.literal("rule.setEnabled"), ruleId: z.string(), enabled: z.boolean() }),
]) satisfies z.ZodType<Command>;

/** A `Command` variant missing above fails here: `satisfies` alone would let the union stay narrower. */
type Unparsed = Exclude<Command["type"], z.infer<typeof command>["type"]>;
const _everyCommandIsParsed: [Unparsed] extends [never] ? true : never = true;

const refresh = z.object({ type: z.literal("refresh") });

// The demo verbs (ADR 0046), typed by `contracts/demo.ts`: each shape is held to its `DemoCommand` variant.
/** Loads the scenario with this id: a new engine room under the same server and session. */
const demoLoad = z.object({
  type: z.literal("demo.load"),
  id: z.string().min(1),
}) satisfies z.ZodType<Extract<DemoCommand, { type: "demo.load" }>>;

/** The developer drawer's fault: each id written once, held to `FaultId` both ways by `enumOf`. */
const demoInject = z.object({
  type: z.literal("demo.inject"),
  fault: enumOf<FaultId>()([
    "claude-signed-out",
    "codex-signed-out",
    "codex-limit",
    "codex-failed-self-test",
    "codex-too-old",
    "engines-missing",
    "sign-in-entered",
    "sign-in-denied",
    "github-signed-out",
    "sso-asked",
    "organisation-suspended",
    "owner-installs",
    "connection-lost",
    "app-uninstalled",
    "app-suspended",
    "key-refused",
    "key-lost",
    "nothing-granted",
    "repository-added",
    "repository-removed",
    "repository-back",
    "github-limit",
    "agent-opens-change",
    "other-opens-change",
    "you-push",
    "close-change",
    "codex-updated",
    "settings-unwritable",
    "login-refused",
    "path-refused",
    "launcher-stale",
    "npm-install",
    "npm-off-path",
    "skill-refused",
    "gh-signed-in",
    "gh-uninstalled",
    "gh-signed-out",
    "not-a-member",
  ]),
}) satisfies z.ZodType<Extract<DemoCommand, { type: "demo.inject" }>>;

/** Runs the room's clock with the real time at `speed` (its milliseconds per real one), or stands it still. */
const demoClock = z.object({
  type: z.literal("demo.clock"),
  running: z.boolean(),
  speed: z.number().positive().finite(),
}) satisfies z.ZodType<Extract<DemoCommand, { type: "demo.clock" }>>;

/** Moves the room's clock on by `ms`, firing every timer that falls due. */
const demoAdvance = z.object({
  type: z.literal("demo.advance"),
  ms: z.number().nonnegative().finite(),
}) satisfies z.ZodType<Extract<DemoCommand, { type: "demo.advance" }>>;

/** Moves the room's clock to its next timer. */
const demoStep = z.object({ type: z.literal("demo.step") }) satisfies z.ZodType<
  Extract<DemoCommand, { type: "demo.step" }>
>;

/** What the commands endpoint accepts. */
export const request = z.union([refresh, demoLoad, demoInject, demoClock, demoAdvance, demoStep, command]);
