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
import {
  addRepositoryLink,
  aiStepActs,
  aiStepLabels,
  chosenRepos,
  departedNotice,
  engineSetupNext,
  engineSetupText,
  pullRequestLink,
  repositoriesFoot,
} from "./onboarding.ts";

const NOW = Date.UTC(2026, 9, 10, 10, 0, 0);

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

test("the AI step waits for Continue (ADR 0058): both ready says so and offers Continue; one of two ready says which and offers it only; none, nothing", () => {
  const claude = engine("claude", "Claude");
  const codex = engine("codex", "Codex");
  const signedOut = { ...codex, state: "signed-out" } as const;
  expect(aiStepActs([claude, codex])).toEqual({ said: "Both are ready.", label: "Continue", enabled: true });
  expect(aiStepActs([claude, signedOut])).toEqual({
    said: "Claude is ready.",
    label: "Continue with Claude only",
    enabled: true,
  });
  expect(aiStepActs([{ ...claude, state: "signed-out" }, signedOut])).toEqual({
    said: "",
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
  // No copy says the step moves on by itself.
  for (const acts of [aiStepActs([claude, codex]), aiStepActs([claude, signedOut])]) {
    expect(acts.said).not.toContain("by itself");
    expect(acts.said).not.toContain("Moving on");
  }
});

test("each AI's line in the setup says its state; one that can't be used says why, the command included", () => {
  const codex = engine("codex", "Codex");
  expect(engineSetupText({ ...codex, detail: "ChatGPT Plus plan" })).toBe(
    "Ready · signed in, ChatGPT Plus plan · codex 1.0.0",
  );
  expect(engineSetupText({ ...codex, state: "missing", version: null })).toBe(
    "codex was not found on this computer",
  );
  // Not installed: the service's line, with this machine's command (ADR 0070).
  const install =
    "The codex program was not found on this computer. Install it, then check again: npm install -g @openai/codex";
  expect(engineSetupText({ ...codex, state: "missing", version: null, detail: install })).toBe(install);
  const tooOld =
    "gpt-6.1-sol needs Codex 0.162.0 or later; this one is 0.154.0. Update it, then check again: npm install -g @openai/codex@latest";
  expect(
    engineSetupText({
      ...codex,
      state: "missing",
      version: "0.154.0",
      detail: tooOld,
      unusable: { kind: "too-old", version: "0.154.0", model: "gpt-6.1-sol", needs: "0.162.0" },
    }),
  ).toBe(tooOld);
  expect(engineSetupText({ ...codex, state: "signed-out" })).toBe("Not signed in · codex 1.0.0 found");
  expect(engineSetupText({ ...codex, state: "signed-out", signingIn: true })).toBe(
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
  expect(engineSetupText({ ...claude, version: "2.4.1" })).toBe("Ready · signed in · claude 2.4.1");
  expect(engineSetupText({ ...claude, version: "2.4.1", detail: "Claude Max plan" })).toBe(
    "Ready · signed in, Claude Max plan · claude 2.4.1",
  );
  // At its limit or failing the safety check, it is signed in: the line says the state as the status menu does.
  expect(engineSetupText({ ...claude, version: "2.4.1", state: "limit" })).toBe(
    "At its limit · signed in · claude 2.4.1",
  );
  expect(
    engineSetupText({ ...claude, version: "2.4.1", state: "failed-self-test", detail: "Claude Max plan" }),
  ).toBe("Didn't pass Lookover's safety check · signed in, Claude Max plan · claude 2.4.1");
  const states: Engine["state"][] = ["ready", "signed-out", "missing", "limit", "failed-self-test"];
  for (const state of states) {
    for (const detail of ["", "Claude Max plan"]) {
      for (const version of [null, "2.4.1"]) {
        for (const signingIn of [false, true]) {
          const line = engineSetupText({ ...claude, state, detail, version, signingIn });
          expect(line).not.toMatch(/,\s*(·|$)|·\s*·|,\s*,|^\s*·|·\s*$|null|undefined|\s{2}/);
          expect(line.trim()).toBe(line);
          expect(line).not.toBe("");
        }
      }
    }
  }
});
