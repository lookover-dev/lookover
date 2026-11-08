// What the band's Refused line and the toast say of a command the service refused: "Lookover couldn't do that."
// and the reason the UI knows from the status and the service's answer (spec #105), never the service's own words.
import { expect, test } from "bun:test";
import { Refused } from "../api/http.ts";
import { refusalOf, refusalText, refusalToast, sessionLost } from "./refusal.ts";

test("a refusal is read from what the request rejected with: the service's answer, or no status when it never got there", () => {
  expect(refusalOf(new Refused(409, { error: "loading" }))).toEqual({ status: 409, error: "loading" });
  expect(refusalOf(new Refused(500, {}))).toEqual({ status: 500, error: null });
  // A request that never reached the service carries no words of the service's: the console keeps the error.
  expect(refusalOf(new TypeError("Failed to fetch"))).toEqual({ status: 0, error: null });
});

test("each status the UI knows gets its reason; an unknown one gets the sentence alone", () => {
  expect(refusalText({ status: 501, error: "not available yet" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "It is not available yet.",
  });
  expect(refusalText({ status: 404, error: "no such change" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "There is no such pull request.",
  });
  expect(refusalText({ status: 409, error: "loading" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "A scenario is loading.",
  });
  expect(refusalText({ status: 409, error: "the checks are already running" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "It is already running.",
  });
  // A conflict the UI has no words for: the sentence alone, the console the service's.
  expect(refusalText({ status: 409, error: "review the pull request first" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "",
  });
  // The request never reached the service: no status at all.
  expect(refusalText({ status: 0, error: null })).toEqual({
    title: "Lookover couldn't do that",
    detail: "The service didn't answer.",
  });
  expect(refusalText({ status: 502, error: "rate_limited" })).toEqual({
    title: "Lookover couldn't do that",
    detail: "",
  });
});

test("a 404 or a 501 is said by what the service answered, and one the UI has no words for gets the title alone", () => {
  const detail = (status: number, error: string | null) => refusalText({ status, error }).detail;
  expect(detail(404, "no such change")).toBe("There is no such pull request.");
  expect(detail(404, "no such repository")).toBe("Lookover doesn't watch that repository.");
  expect(detail(404, "no scenario S99")).toBe("There is no such scenario.");
  expect(detail(404, "no demo in live mode")).toBe("");
  expect(detail(404, null)).toBe("");
  // The service sends no "comes with onboarding" any more (setup makes the App, ADR 0053): read as any unknown 501.
  expect(detail(501, "comes with onboarding")).toBe("");
  expect(detail(501, "not available yet")).toBe("It is not available yet.");
  expect(detail(501, "nothing scripted in live mode")).toBe("");
  expect(detail(501, null)).toBe("");
});

test("a settings command refused is said by the code the service sent, never by its words (ADR 0049)", () => {
  const said = (status: number, refused: unknown) =>
    refusalText(refusalOf(new Refused(status, { error: "anything", refused }))).detail;
  expect(said(404, "no_such_rule")).toBe("That rule isn't in the rules files any more.");
  // "Too noisy?" on a finding the service doesn't hold, or that follows no rule.
  expect(said(404, "no_such_finding")).toBe("That finding isn't on this pull request.");
  expect(said(409, "no_rule")).toBe("That finding follows no rule.");
  // "This finding is wrong" on a finding settled meanwhile, or while a round of the pull request runs (ADR 0052).
  expect(said(409, "settled")).toBe("That finding is already settled, or isn't on the pull request.");
  expect(said(409, "reviewing")).toBe(
    "A review of this pull request is running. Try again once it is posted.",
  );
  // A repository whose name can't be a folder (`con` on Windows): its settings can't be kept.
  expect(said(409, "unnamed")).toBe(
    "This repository's name can't be a folder on this computer, so its settings can't be saved.",
  );
  // The words alone, without the code, say nothing; a code the UI doesn't know isn't taken.
  expect(refusalText({ status: 404, error: "no such rule" }).detail).toBe("");
  expect(refusalOf(new Refused(409, { error: "x", refused: "gone" }))).toEqual({ status: 409, error: "x" });
  expect(refusalOf(new Refused(409, { error: "x", refused: "no_rule" }))).toEqual({
    status: 409,
    error: "x",
    refused: "no_rule",
  });
});

test("an App of its own refused (`useApp`, `createApp`) is no longer read: the generic line, as any other conflict (ADR 0073)", () => {
  for (const data of [
    { useApp: { kind: "missing-permissions", missing: ["checks"] } },
    { useApp: { kind: "not-a-key" } },
    { createApp: { kind: "already-made" } },
  ]) {
    const refused = refusalOf(new Refused(409, { error: "x", ...data }));
    expect(refused).toEqual({ status: 409, error: "x" });
    expect(refusalToast(refused)).toBe("Lookover couldn't do that.");
  }
});

test("Sign in with GitHub refused (ADR 0066): why, from the service's `signIn` or GitHub giving no code; said in place, no toast", () => {
  const signIn = { type: "connection.signIn" } as const;
  const pending = refusalOf(new Refused(409, { error: "x", signIn: "pending" }), signIn);
  expect(pending).toEqual({ status: 409, error: "x", signIn: "pending", command: signIn });
  expect(refusalText(pending).detail).toBe("A sign-in already waits for its code.");
  // Said in place by the setup's GitHub step; Sign in again anywhere else (the alert band) has only the toast.
  expect(refusalToast(pending, { setup: true })).toBeNull();
  expect(refusalToast(pending, { setup: false })).toBe(
    "Lookover couldn't do that. A sign-in already waits for its code.",
  );
  const github = refusalOf(new Refused(502, { error: "unavailable" }), signIn);
  expect(github).toMatchObject({ status: 502, signIn: "github" });
  expect(refusalText(github).detail).toBe("GitHub didn't give a code. Try again.");
  // Another command's 502 is not a sign-in's, and a kind the UI doesn't know is not taken.
  expect(refusalOf(new Refused(502, { error: "unavailable" }), { type: "engine.check" })).not.toHaveProperty(
    "signIn",
  );
  expect(refusalOf(new Refused(409, { error: "x", signIn: "weather" }))).toEqual({ status: 409, error: "x" });
  // Every service offers the shared App: "unavailable" is no reason a sign-in is refused any more.
  expect(refusalOf(new Refused(409, { error: "x", signIn: "unavailable" }), signIn)).toEqual({
    status: 409,
    error: "x",
    command: signIn,
  });
});

test("Ask to install refused (ADR 0067): why, from the service's `askToInstall`, in the toast; a kind the UI doesn't know is not taken", () => {
  const ask = { type: "connection.askToInstall", account: "ledger-co" } as const;
  const said = (askToInstall: string) =>
    refusalText(refusalOf(new Refused(409, { error: "x", askToInstall }), ask)).detail;
  expect(refusalOf(new Refused(409, { error: "x", askToInstall: "owner" }), ask)).toEqual({
    status: 409,
    error: "x",
    askToInstall: "owner",
    command: ask,
  });
  expect(said("signed-out")).toBe("Lookover isn't signed in to GitHub here.");
  expect(said("not-named")).toBe("That account isn't waiting to be installed any more.");
  expect(said("owner")).toBe("You own that account: install it there yourself.");
  expect(refusalToast(refusalOf(new Refused(409, { error: "x", askToInstall: "owner" }), ask))).toBe(
    "Lookover couldn't do that. You own that account: install it there yourself.",
  );
  expect(refusalOf(new Refused(409, { error: "x", askToInstall: "weather" }))).toEqual({
    status: 409,
    error: "x",
  });
});

test("any refusal but a sign-in's on setup has its toast", () => {
  const loading = refusalOf(new Refused(409, { error: "loading" }));
  expect(refusalToast(loading)).toBe("Lookover couldn't do that. A scenario is loading.");
});

test("a settings file that doesn't read is named with why, and how to go on; the answer's data is kept (ADR 0049)", () => {
  const invalid = { file: "settings.yaml", problem: "wrong_type", key: "depth" } as const;
  const refusal = refusalOf(new Refused(409, { error: "settings.yaml doesn't read", invalid }));
  expect(refusal).toEqual({ status: 409, error: "settings.yaml doesn't read", invalid });
  expect(refusalText(refusal).detail).toBe(
    "settings.yaml in Lookover's data folder doesn't read: depth has a wrong value. Fix the file, then try again.",
  );
  const unreadable = { file: "acme/api/settings.yaml", problem: "unreadable", key: null } as const;
  expect(refusalText({ status: 409, error: "x", invalid: unreadable }).detail).toBe(
    "acme/api/settings.yaml doesn't read: it can't be opened. Fix the file, then try again.",
  );
  // An answer whose data isn't of that shape is not taken.
  expect(refusalOf(new Refused(409, { error: "x", invalid: { file: 3 } }))).toEqual({
    status: 409,
    error: "x",
  });
});

test("a settings file that couldn't be saved says whether another program holds it (ADR 0049)", () => {
  const unwritten = { file: "settings.yaml", why: "held-open" } as const;
  const held = refusalOf(new Refused(500, { error: "x", unwritten }));
  expect(held).toEqual({ status: 500, error: "x", unwritten });
  expect(refusalText(held).detail).toBe(
    "settings.yaml in Lookover's data folder is open in another program. Close it, then try again.",
  );
  const other = { file: "acme/api/settings.yaml", why: "other" } as const;
  expect(refusalText({ status: 500, error: "x", unwritten: other }).detail).toBe(
    "acme/api/settings.yaml couldn't be saved.",
  );
  expect(refusalOf(new Refused(500, { error: "x", unwritten: { file: "s", why: "full" } }))).toEqual({
    status: 500,
    error: "x",
  });
});

test("the session screen says the tab isn't signed in, and names the command the 401 named (ADR 0058)", () => {
  // The program's build has no demo: proof shoots this sentence from S14, which plants a program's command.
  const binary = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' open`;
  for (const mode of ["program", "demo", "live"] as const)
    expect(sessionLost(mode, binary)).toEqual({
      before: "This tab isn't signed in. Run",
      command: binary,
      after: "to open Lookover.",
      alone: "This tab isn't signed in. To open Lookover, run:",
    });
  expect(sessionLost("program", "bun run lookover open")).toEqual({
    before: "This tab isn't signed in. Run",
    command: "bun run lookover open",
    after: "to open Lookover.",
    alone: "This tab isn't signed in. To open Lookover, run:",
  });
});

test("in development the session screen names the link `bun dev` printed", () => {
  expect(sessionLost("demo", null)).toEqual({
    before: "This tab isn't signed in. Open the link",
    command: "bun dev",
    after: "printed.",
  });
  expect(sessionLost("live", null)).toEqual({
    before: "This tab isn't signed in. Open the link",
    command: "bun dev --live",
    after: "printed.",
  });
});

test("a 401 that named no command gets the sentence without one", () => {
  expect(sessionLost("program", null)).toBe(
    "This tab isn't signed in. Open Lookover again from your terminal.",
  );
});
