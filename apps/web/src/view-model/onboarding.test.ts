// What setup's AI and repositories steps and the links to GitHub say for a given snapshot (ADR 0053, ADR 0073: one
// way in, the person signed in). Snapshots are built by hand: the view model reads state only.
import { expect, test } from "bun:test";
import {
  type Connection,
  DEMO_API,
  type Engine,
  type EngineId,
  GITHUB_WEB,
  type Repository,
  type ResolvedSettings,
  repositoryId,
} from "@lookover/contracts";
import { clock } from "./format.ts";
import {
  addRepositoryLink,
  aiStepActs,
  aiStepLabels,
  chosenRepos,
  departedNotice,
  ENGINE_SETUP_LABELS,
  engineSetupAction,
  engineSetupNext,
  engineSetupText,
  pullRequestLink,
  repositoriesFoot,
} from "./onboarding.ts";

const NOW = Date.UTC(2026, 9, 10, 10, 0, 0);

/** An AI's line in setup, now. */
const setupText = (e: Engine) => engineSetupText(e, NOW);

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function engine(id: EngineId, name: string): Engine {
  return {
    id,
    name,
    cli: id,
    version: "1.0.0",
    state: "ready",
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
}

/** Every state an engine can be in. */
const STATES: Engine["state"][] = [
  "ready",
  "signed-out",
  "missing",
  "limit",
  "failed-self-test",
  "self-test-unfinished",
];

/** sam, signed in. */
const SAM = { id: 7, login: "sam" };

function repo(name: string): Repository {
  return { id: repositoryId(`sam/${name}`), owner: "sam", name, enabled: true, settings: DEFAULTS };
}

/** Nobody signed in yet, `patch` aside. The web never reads the way: no connection here names one. */
function connection(patch: Partial<Connection> = {}): Connection {
  return {
    id: null,
    state: "not-connected",
    cause: null,
    accounts: [],
    listed: true,
    listingCause: null,
    unreached: [],
    signIn: null,
    person: null,
    web: GITHUB_WEB,
    since: NOW,
    limitUntil: null,
    ...patch,
  };
}

const account = (
  id: number,
  login: string,
  type: "User" | "Organization",
): Connection["accounts"][number] => ({
  account: { id, login, type },
  installationId: id,
  cause: null,
  owner: null,
});

/** sam signed in and connected, on `accounts`. */
const signedIn = (accounts: Connection["accounts"]) =>
  connection({ state: "connected", person: SAM, accounts });

// ---- the repositories step ----

test("the repositories step ticks what the installation granted, keeps what the owner unticked, and follows GitHub", () => {
  const [app, site, docs] = [repo("app"), repo("site"), repo("docs")];
  const unticked = new Map([[site.id, false]]);
  expect(chosenRepos([app, site], unticked)).toEqual([app.id]);
  // Granted on GitHub after the step opened: it arrives ticked. Removed on GitHub: it goes.
  expect(chosenRepos([app, site, docs], unticked)).toEqual([app.id, docs.id]);
  expect(chosenRepos([site, docs], unticked)).toEqual([docs.id]);
  // A repository the service has off stays off until ticked.
  const off = { ...docs, enabled: false };
  expect(chosenRepos([off], new Map())).toEqual([]);
  expect(chosenRepos([off], new Map([[off.id, true]]))).toEqual([off.id]);
});

// ---- links ----

test("Add a repository: the installation's settings on the one account the person owns, and nothing before a sign-in", () => {
  expect(addRepositoryLink(signedIn([account(7, "sam", "User")]))).toBe(
    "https://github.com/settings/installations/7",
  );
  expect(addRepositoryLink(signedIn([]))).toBe("https://github.com/apps/lookover-dev/installations/new");
  expect(addRepositoryLink(connection())).toBeNull();
  // Accounts but nobody signed in (ADR 0073): no link.
  expect(addRepositoryLink(connection({ accounts: [account(7, "sam", "User")] }))).toBeNull();
});

test("Repositories' foot names the person signed in and every account reached (ADR 0066)", () => {
  expect(
    repositoriesFoot(signedIn([account(7, "sam", "User"), account(338, "ledger-dev", "Organization")])),
  ).toBe("Signed in to GitHub as sam, on sam and ledger-dev.");
  expect(
    repositoriesFoot(
      signedIn([
        account(7, "sam", "User"),
        account(338, "ledger-dev", "Organization"),
        account(9, "acme", "Organization"),
      ]),
    ),
  ).toBe("Signed in to GitHub as sam, on sam, ledger-dev and acme.");
  expect(repositoriesFoot(signedIn([]))).toBe("Signed in to GitHub as sam.");
  // Signed in only while GitHub takes the sign-in: otherwise the foot says what the status menu says.
  const out = { ...signedIn([account(7, "sam", "User")]), state: "disconnected" as const };
  expect(repositoriesFoot({ ...out, cause: { kind: "signed-out" } })).toBe(
    "Not connected to GitHub: signed out.",
  );
  expect(repositoriesFoot({ ...out, cause: { kind: "unreachable" } })).toBe(
    "Not connected to GitHub: unreachable.",
  );
  expect(repositoriesFoot({ ...out, state: "not-connected" })).toBe("Not connected to GitHub.");
});

test("Repositories' foot with nobody signed in says so, connected or not", () => {
  expect(repositoriesFoot(connection())).toBe("Not connected to GitHub.");
  expect(repositoriesFoot(connection({ state: "connected" }))).toBe("Not connected to GitHub.");
});

test("a departed repository is said in one sentence, labelled Left, and Add it back opens its account's installation settings (ADR 0059)", () => {
  const text =
    "left the App's installation and is no longer reviewed: moved, deleted, or taken off its access.";
  const sam = { ...account(7, "sam", "User"), owner: true };
  expect(departedNotice(signedIn([sam]), { owner: "sam" })).toEqual({
    label: "Left",
    text,
    addBack: "https://github.com/settings/installations/7",
  });
  // Its account no longer reached: GitHub's page lists every account.
  expect(departedNotice(signedIn([sam]), { owner: "acme" }).addBack).toBe(
    "https://github.com/apps/lookover-dev/installations/new",
  );
  expect(departedNotice(signedIn([sam]), { owner: "sam" }).text).toBe(text);
});

test("every link to GitHub is built on the connection's web address: demo mode's stays on GitHub's fake", () => {
  expect(addRepositoryLink({ ...signedIn([]), web: DEMO_API.github })).toBe(
    `${DEMO_API.github}/apps/lookover-dev/installations/new`,
  );
});

test("Open on GitHub opens the real pull request in live mode, and the simulated page in demo mode", () => {
  const change = { repoId: repositoryId("sam/site"), number: 12 };
  expect(pullRequestLink(connection(), change)).toEqual({ href: "https://github.com/sam/site/pull/12" });
  expect(pullRequestLink(connection({ web: DEMO_API.github }), change)).toEqual({
    path: "/github/sam/site/12",
  });
});

test("the AI step waits for Continue (ADR 0058): both ready offers Continue; one of two ready offers it only; none, a disabled one", () => {
  const claude = engine("claude", "Claude");
  const codex = engine("codex", "Codex");
  const signedOut = { ...codex, state: "signed-out" } as const;
  // Nothing said beside Continue: each AI's card says it is ready, and the label names the one it goes on with
  // (round 5: "Claude is ready." beside it said the card's word again).
  expect(aiStepActs([claude, codex])).toEqual({ label: "Continue", enabled: true });
  expect(aiStepActs([claude, signedOut])).toEqual({ label: "Continue with Claude only", enabled: true });
  expect(aiStepActs([{ ...claude, state: "signed-out" }, signedOut])).toEqual({
    label: "Sign in to continue",
    enabled: false,
  });
  // Continue keeps one width whichever label it shows: every one is laid out (`SameWidth`).
  expect(aiStepLabels([claude, codex])).toEqual([
    "Continue",
    "Continue with Claude only",
    "Continue with Codex only",
    "Sign in to continue",
  ]);
});

test("each AI's line in the setup says its state; one that can't be used says why, the command included", () => {
  const codex = engine("codex", "Codex");
  expect(setupText({ ...codex, detail: "ChatGPT Plus plan" })).toBe(
    "Ready · signed in, ChatGPT Plus plan · codex 1.0.0",
  );
  expect(setupText({ ...codex, state: "missing", version: null })).toBe(
    "codex was not found on this computer",
  );
  // Not installed: the service's line, with this machine's command (ADR 0070).
  const install =
    "The codex program was not found on this computer. Install it, then check again: npm install -g @openai/codex";
  expect(setupText({ ...codex, state: "missing", version: null, detail: install })).toBe(install);
  const tooOld =
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest";
  expect(
    setupText({
      ...codex,
      state: "missing",
      version: "0.154.0",
      detail: tooOld,
      unusable: { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    }),
  ).toBe(tooOld);
  expect(setupText({ ...codex, state: "signed-out" })).toBe("Not signed in · codex 1.0.0 found");
  expect(setupText({ ...codex, state: "signed-out", signingIn: true })).toBe(
    "A terminal is open. Sign in there; this page checks every few seconds.",
  );
});

test("a missing AI's row says what comes after the install, the sign-in, under the service's line", () => {
  const codex = engine("codex", "Codex");
  const install =
    "The codex program was not found on this computer. Install it, then check again: npm install -g @openai/codex";
  // The service's line stays as the band says it; the row adds the step after it on its own line.
  expect(engineSetupNext({ ...codex, state: "missing", version: null, detail: install })).toBe(
    "Once it's found, sign in here if it asks.",
  );
  expect(engineSetupNext({ ...codex, state: "missing", version: null })).toBe(
    "Once it's found, sign in here if it asks.",
  );
  // Found but unusable, signed out or ready: its own line says all there is.
  const tooOld = { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" } as const;
  expect(engineSetupNext({ ...codex, state: "missing", version: "0.154.0", unusable: tooOld })).toBeNull();
  expect(engineSetupNext({ ...codex, state: "signed-out" })).toBeNull();
  expect(engineSetupNext(codex)).toBeNull();
});

test("an AI's line joins only the parts it has: no stray comma, no doubled separator, in any state (#256)", () => {
  const claude = engine("claude", "Claude");
  // Claude ready with no plan said: the detail is left out, not printed empty.
  expect(setupText({ ...claude, version: "2.4.1" })).toBe("Ready · signed in · claude 2.4.1");
  expect(setupText({ ...claude, version: "2.4.1", detail: "Claude Max plan" })).toBe(
    "Ready · signed in, Claude Max plan · claude 2.4.1",
  );
  // At its limit or failing the safety check, it is signed in: the line says the state as the status menu does.
  expect(setupText({ ...claude, version: "2.4.1", state: "limit" })).toBe(
    "At its limit · signed in · claude 2.4.1",
  );
  expect(
    setupText({ ...claude, version: "2.4.1", state: "failed-self-test", detail: "Claude Max plan" }),
  ).toBe("Didn't pass Lookover's safety check · signed in, Claude Max plan · claude 2.4.1");
  for (const state of STATES) {
    for (const detail of ["", "Claude Max plan"]) {
      for (const version of [null, "2.4.1"]) {
        for (const signingIn of [false, true]) {
          const line = setupText({ ...claude, state, detail, version, signingIn });
          expect(line).not.toMatch(/,\s*(·|$)|·\s*·|,\s*,|^\s*·|·\s*$|null|undefined|\s{2}/);
          expect(line.trim()).toBe(line);
          expect(line).not.toBe("");
        }
      }
    }
  }
});

test("each AI's row offers the one action its state needs: a sign-in only to one signed out, Try again to one whose check couldn't finish", () => {
  const claude = { ...engine("claude", "Claude"), version: "2.4.1" };
  const check = { type: "engine.check" } as const;
  expect(engineSetupAction({ ...claude, state: "signed-out" })).toEqual({
    label: "Sign in from a terminal",
    command: { type: "engine.signIn", id: "claude" },
    enabled: true,
  });
  expect(engineSetupAction({ ...claude, state: "signed-out", signingIn: true })).toEqual({
    label: "Waiting…",
    command: { type: "engine.signIn", id: "claude" },
    enabled: false,
  });
  // Try again runs the check again (`engine.check`), never a sign-in, whose look leaves the hold in place.
  expect(engineSetupAction({ ...claude, state: "self-test-unfinished" })).toEqual({
    label: "Try again",
    command: check,
    enabled: true,
  });
  expect(engineSetupAction({ ...claude, state: "missing", version: null })).toEqual({
    label: "Check again",
    command: check,
    enabled: true,
  });
  expect(engineSetupAction({ ...claude, state: "failed-self-test" })).toEqual({
    label: "Check again",
    command: check,
    enabled: true,
  });
  // At its limit, Check again: during setup no job waits, so nothing else would look once it resets (F2 on #522).
  expect(engineSetupAction({ ...claude, state: "limit", limitUntil: NOW + 5 * 60_000 })).toEqual({
    label: "Check again",
    command: check,
    enabled: true,
  });
  // Ready, nothing to do.
  expect(engineSetupAction(claude)).toBeNull();
  // The action's place keeps its widest label's width: every label it can show is laid out.
  for (const state of STATES)
    for (const signingIn of [false, true]) {
      const action = engineSetupAction({ ...claude, state, signingIn });
      if (action !== null) expect(ENGINE_SETUP_LABELS).toContain(action.label);
    }
});

test("each AI's line in setup, in the five states not ready, says the state in the status menu's words", () => {
  const codex = { ...engine("codex", "Codex"), version: "0.163.0", detail: "ChatGPT Plus plan" };
  expect(setupText({ ...codex, state: "signed-out" })).toBe("Not signed in · codex 0.163.0 found");
  expect(setupText({ ...codex, state: "self-test-unfinished" })).toBe(
    "Couldn't finish Lookover's safety check · signed in, ChatGPT Plus plan · codex 0.163.0",
  );
  expect(setupText({ ...codex, state: "missing", detail: "", version: null })).toBe(
    "codex was not found on this computer",
  );
  expect(setupText({ ...codex, state: "failed-self-test" })).toBe(
    "Didn't pass Lookover's safety check · signed in, ChatGPT Plus plan · codex 0.163.0",
  );
  expect(setupText({ ...codex, state: "limit" })).toBe(
    "At its limit · signed in, ChatGPT Plus plan · codex 0.163.0",
  );
});

test("an AI at its limit in setup says when it resets, and Check again finds it back after the reset", () => {
  const reset = NOW + 5 * 60_000;
  const claude = {
    ...engine("claude", "Claude"),
    version: "2.4.1",
    state: "limit",
    limitUntil: reset,
  } as const;
  const codex = { ...claude, id: "codex", name: "Codex", cli: "codex" } as const;
  expect(setupText(claude)).toBe(`At its limit until ${clock(reset)} · signed in · claude 2.4.1`);
  // Its reset gone by with nothing checked since, the line names no time already past.
  expect(engineSetupText(claude, reset + 60_000)).toBe("At its limit · signed in · claude 2.4.1");
  // Both at their limit: no job waits during setup, so each row offers Check again, which reads the engines again.
  const check = { label: "Check again", command: { type: "engine.check" }, enabled: true } as const;
  expect([claude, codex].map(engineSetupAction)).toEqual([check, check]);
  expect(aiStepActs([claude, codex])).toEqual({ label: "Continue", enabled: false });
  // Once the check finds Claude ready after its reset, Continue goes on with it.
  expect(aiStepActs([{ ...claude, state: "ready", limitUntil: null }, codex])).toEqual({
    label: "Continue with Claude only",
    enabled: true,
  });
});

test("with no AI ready, Continue asks for a sign-in only when one is signed out; otherwise it is Continue, disabled", () => {
  const claude = engine("claude", "Claude");
  const codex = engine("codex", "Codex");
  const unfinished = { ...codex, state: "self-test-unfinished" } as const;
  const atLimit = { ...claude, state: "limit" } as const;
  expect(aiStepActs([atLimit, unfinished])).toEqual({ label: "Continue", enabled: false });
  expect(
    aiStepActs([
      { ...claude, state: "failed-self-test" },
      { ...codex, state: "missing" },
    ]),
  ).toEqual({
    label: "Continue",
    enabled: false,
  });
  expect(aiStepActs([atLimit, { ...codex, state: "signed-out" }])).toEqual({
    label: "Sign in to continue",
    enabled: false,
  });
  // One ready: Continue with it only, whatever the other's state.
  expect(aiStepActs([claude, unfinished])).toEqual({
    label: "Continue with Claude only",
    enabled: true,
  });
  // Every label it shows is among those laid out, so Continue keeps one width.
  expect(aiStepLabels([atLimit, unfinished])).toContain(aiStepActs([atLimit, unfinished]).label);
});
