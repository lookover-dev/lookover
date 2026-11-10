// The UI's copy of the state moves only through `apply` (AGENTS.md rule 3), a replaced snapshot included.
// Beside it, what the store knows of the service's answers: a refused command, kept as the notice until
// dismissed, and a session the service no longer knows (the session screen, #68).
import { expect, test } from "bun:test";
import {
  type Command,
  changeId,
  commitSha,
  type Event,
  emptyReview,
  GITHUB_WEB,
  type LookoverApi,
  type RepositoryId,
  type ResolvedSettings,
  repositoryId,
  type State,
} from "@lookover/contracts";
import { Refused } from "./api/http.ts";
import { cancelHeld, type SessionAware, Store, sendOrHold, unlockAndSend } from "./store.tsx";

const NOW = Date.UTC(2026, 9, 6, 10, 0, 0);

const DEFAULTS: ResolvedSettings = {
  strictness: { value: "recommended", origin: "lookover-default", overrode: null },
  reviewers: { value: "both", origin: "lookover-default", overrode: null },
  depth: { value: "standard", origin: "lookover-default", overrode: null },
  onOpen: { value: true, origin: "lookover-default", overrode: null },
  onPush: { value: false, origin: "lookover-default", overrode: null },
};

function snapshot(seq: number, title: string): State {
  const engine = {
    cli: "",
    version: null,
    state: "ready" as const,
    detail: "",
    unusable: null,
    since: NOW,
    limitUntil: null,
    signingIn: false,
  };
  return {
    seq,
    now: NOW,
    setup: {
      done: true,
      step: "background",
      reached: "background",
      github: "done",
      firstReviewChange: null,
    },
    engines: {
      claude: { ...engine, id: "claude", name: "Claude" },
      codex: { ...engine, id: "codex", name: title },
    },
    connection: {
      id: null,
      state: "connected",
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
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      atLogin: "this",
      loginItem: "os",
      paused: null,
      remote: false,
      unlocked: false,
      checks: null,
    },
    settings: DEFAULTS,
    repos: [],
    departed: [],
    rules: [],
    changes: {},
    reviews: {},
  };
}

/** Once the snapshot the store asked for has arrived. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A service that sends the events a test gives it. `refuse` is what its `send` rejects with; `lost` tells the
 * store the session is gone, as the HTTP client does when its stream reconnects into a 401. `next` is the snapshot
 * it serves from then on; `snapshots`, how many times it was asked for one.
 */
function service(first: State | Error, refuse?: Error) {
  const listeners: ((event: Event) => void)[] = [];
  const lostListeners: ((open: string | null) => void)[] = [];
  let served = first;
  let asked = 0;
  const api: LookoverApi & SessionAware = {
    snapshot: () => {
      asked++;
      return served instanceof Error ? Promise.reject(served) : Promise.resolve(served);
    },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    send: () => (refuse ? Promise.reject(refuse) : Promise.resolve()),
    // The log is the Logs page's, never the store's.
    logs: () => Promise.resolve([]),
    subscribeLogs: () => () => undefined,
    onSessionLost: (listener) => {
      lostListeners.push(listener);
      return () => undefined;
    },
  };
  const send = (event: Event) => {
    for (const l of listeners) l(event);
  };
  const lost = (open: string | null = null) => {
    for (const l of lostListeners) l(open);
  };
  const next = (state: State) => {
    served = state;
  };
  return { api, send, lost, next, snapshots: () => asked };
}

test("a replaced snapshot takes the copy's place whatever its number, and an ordinary older event changes nothing", async () => {
  const s = service(snapshot(5, "first"));
  const store = new Store(s.api);
  await settled();
  s.send({ type: "clock", at: NOW + 1000, seq: 4 });
  expect(store.get()).toMatchObject({ seq: 5, now: NOW });
  s.send({ type: "state.replaced", at: NOW, seq: 6, state: snapshot(30, "newer") });
  expect(store.get()).toMatchObject({ seq: 6, engines: { codex: { name: "newer" } } });
  // A reload after a data reset starts lower: the replacement still wins.
  s.send({ type: "state.replaced", at: NOW, seq: 2, state: snapshot(30, "reset") });
  expect(store.get()).toMatchObject({ seq: 2, engines: { codex: { name: "reset" } } });
});

test("the keepalive's clock event, at the copy's own number, moves now and is not stored as an event (#126 F1)", async () => {
  const s = service(snapshot(5, "first"));
  const store = new Store(s.api);
  await settled();
  s.send({ type: "clock", at: NOW + 15_000, seq: 5 });
  expect(store.get()).toMatchObject({ seq: 5, now: NOW + 15_000 });
  // The next stored event follows the last stored number, and the clock's time with it.
  s.send({ type: "clock", at: NOW + 16_000, seq: 6 });
  expect(store.get()).toMatchObject({ seq: 6, now: NOW + 16_000 });
});

test("a refused command is the notice until dismissed, and a new refusal is a new notice", async () => {
  const s = service(snapshot(5, "first"), new Refused(501, { error: "not available yet" }));
  const store = new Store(s.api);
  await settled();
  expect(store.getStatus()).toEqual({ session: "open", refusal: null });
  await store.send({ type: "settings.set", key: "onPush", value: true });
  await settled();
  const first = store.getStatus();
  expect(first).toEqual({
    session: "open",
    refusal: {
      status: 501,
      error: "not available yet",
      command: { type: "settings.set", key: "onPush", value: true },
    },
  });
  // Said again: the band's line is the same, the toast says it once more.
  await store.send({ type: "settings.set", key: "onPush", value: false });
  await settled();
  expect(store.getStatus()).toEqual({
    session: "open",
    refusal: {
      status: 501,
      error: "not available yet",
      command: { type: "settings.set", key: "onPush", value: false },
    },
  });
  expect(store.getStatus()).not.toBe(first);
  store.dismiss();
  expect(store.getStatus()).toEqual({ session: "open", refusal: null });
});

test("a pull request the service doesn't hold is a refusal too; a request that never reached it has no status", async () => {
  const noSuch = service(snapshot(5, "first"), new Refused(404, { error: "no such change" }));
  const store = new Store(noSuch.api);
  await settled();
  await store.send({ type: "review.request", changeId: changeId("sam/app#9") });
  await settled();
  expect(store.getStatus().refusal).toEqual({
    status: 404,
    error: "no such change",
    command: { type: "review.request", changeId: changeId("sam/app#9") },
  });
  const down = service(snapshot(5, "first"), new TypeError("fetch failed"));
  const other = new Store(down.api);
  await settled();
  await other.send({ type: "engine.check" });
  await settled();
  expect(other.getStatus().refusal).toEqual({ status: 0, error: null, command: { type: "engine.check" } });
});

test("a 404 on many repositories says nothing: the ones named are gone already, and the list follows the events (ADR 0082)", async () => {
  const ids: [RepositoryId] = [repositoryId("sasensi/ledger-api")];
  for (const [error, command] of [
    ["no such repository", { type: "repos.setEnabled", repoIds: ids, enabled: false }],
    ["no such departed repository", { type: "repos.dismiss", repoIds: ids }],
  ] satisfies [string, Command][]) {
    const gone = service(snapshot(5, "first"), new Refused(404, { error }));
    const store = new Store(gone.api);
    await settled();
    expect(await store.send(command)).toBe(false);
    await settled();
    expect(store.getStatus()).toEqual({ session: "open", refusal: null });
  }
  // One repository's switch refused is said, as before.
  const one = service(snapshot(5, "first"), new Refused(404, { error: "no such repository" }));
  const single = new Store(one.api);
  await settled();
  await single.send({ type: "repo.setEnabled", repoId: ids[0], enabled: false });
  await settled();
  expect(single.getStatus().refusal).toMatchObject({ status: 404, error: "no such repository" });
  // Any other refusal of them is the notice still.
  const down = service(snapshot(5, "first"), new TypeError("fetch failed"));
  const store = new Store(down.api);
  await settled();
  await store.send({ type: "repos.dismiss", repoIds: ids });
  await settled();
  expect(store.getStatus().refusal).toEqual({
    status: 0,
    error: null,
    command: { type: "repos.dismiss", repoIds: ids },
  });
});

test("a 401 snapshot, or the client saying the session is lost, shows the session screen; nothing is left unhandled (#68)", async () => {
  const refused = service(new Refused(401, { error: "no session" }));
  const store = new Store(refused.api);
  expect(store.getStatus().session).toBe("open");
  await settled();
  expect(store.get()).toBeNull();
  expect(store.getStatus().session).toEqual({ lost: true, open: null });

  // The stream reconnected into a 401 after the state was loaded: the screen replaces the app.
  const later = service(snapshot(5, "first"));
  const loaded = new Store(later.api);
  await settled();
  expect(loaded.get()).not.toBeNull();
  later.lost();
  expect(loaded.getStatus().session).toEqual({ lost: true, open: null });
});

test("the session screen gets the command the 401 named, from the snapshot or from the client (ADR 0058)", async () => {
  const open = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' open`;
  const refused = service(new Refused(401, { error: "no session", open }));
  const store = new Store(refused.api);
  expect(store.getStatus().session).toBe("open");
  await settled();
  expect(store.getStatus().session).toEqual({ lost: true, open });

  const later = service(snapshot(5, "first"));
  const loaded = new Store(later.api);
  await settled();
  later.lost("lookover open");
  // Said once: a second door's 401 changes nothing.
  later.lost(null);
  expect(loaded.getStatus().session).toEqual({ lost: true, open: "lookover open" });
});

test("events that arrive before the first snapshot are applied on it, by their number", async () => {
  const s = service(snapshot(5, "first"));
  const store = new Store(s.api);
  s.send({ type: "clock", at: NOW + 60_000, seq: 4 });
  s.send({ type: "state.replaced", at: NOW, seq: 7, state: snapshot(30, "newer") });
  await settled();
  expect(store.get()).toMatchObject({ seq: 7, now: NOW, engines: { codex: { name: "newer" } } });
});

test("an event this version doesn't know keeps the copy as it was, before the first snapshot or after (ADR 0085)", async () => {
  // A tab left open across an update: the newer service sends a type its `apply` doesn't know.
  const unknown: Event = JSON.parse(JSON.stringify({ type: "review.pinned", at: NOW, seq: 6 }));
  const s = service(snapshot(5, "first"));
  const store = new Store(s.api);
  s.send(unknown);
  await settled();
  expect(store.get()).toMatchObject({ seq: 5, engines: { codex: { name: "first" } } });
  s.send({ ...unknown, seq: 7 });
  s.send({ type: "clock", at: NOW + 1000, seq: 8 });
  expect(store.get()).toMatchObject({ seq: 8, now: NOW + 1000, engines: { codex: { name: "first" } } });
  // Skipped and nothing more: the snapshot was asked for once, at the start.
  expect(s.snapshots()).toBe(1);
});

test("an event of a known type that `apply` throws on asks for the snapshot again, the events after it applied on it", async () => {
  // A bug, not an update: the HTTP client already counted the event seen, so it is never sent again.
  const broken: Event = JSON.parse(JSON.stringify({ type: "rules.changed", at: NOW, seq: 6 }));
  const s = service(snapshot(5, "first"));
  const store = new Store(s.api);
  await settled();
  s.next(snapshot(6, "fresh"));
  s.send(broken);
  // One that arrives while the snapshot is on its way follows it.
  s.send({ type: "clock", at: NOW + 1000, seq: 7 });
  expect(store.get()).toMatchObject({ seq: 7, engines: { codex: { name: "first" } } });
  await settled();
  expect(s.snapshots()).toBe(2);
  expect(store.get()).toMatchObject({ seq: 7, now: NOW + 1000, engines: { codex: { name: "fresh" } } });
});

test("a known event that throws while a snapshot is on its way asks for one more once it comes, and only one (#683)", async () => {
  const broken = (seq: number): Event => JSON.parse(JSON.stringify({ type: "rules.changed", at: NOW, seq }));
  // The first snapshot on its way: 6 throws on it, 7 goes on; the snapshot after it holds 6's effects.
  const first = service(snapshot(5, "first"));
  const early = new Store(first.api);
  first.send(broken(6));
  first.send({ type: "clock", at: NOW + 1000, seq: 7 });
  first.next(snapshot(7, "fresh"));
  await settled();
  await settled();
  expect(first.snapshots()).toBe(2);
  expect(early.get()).toMatchObject({ seq: 7, engines: { codex: { name: "fresh" } } });

  // A snapshot asked for again on its way: 7 throws while it is, and it doesn't hold 7.
  const again = service(snapshot(5, "first"));
  const late = new Store(again.api);
  await settled();
  again.next(snapshot(6, "middle"));
  again.send(broken(6));
  again.send(broken(7));
  again.next(snapshot(7, "fresh"));
  await settled();
  await settled();
  expect(again.snapshots()).toBe(3);
  expect(late.get()).toMatchObject({ seq: 7, engines: { codex: { name: "fresh" } } });
});

/** A store on `first` that records the commands it really sends. */
async function recording(first: State) {
  const s = service(first);
  const sent: Command[] = [];
  s.api.send = (command) => {
    sent.push(command);
    return Promise.resolve();
  };
  const store = new Store(s.api);
  await settled();
  return { store, sent };
}

test("on a locked server, a command waits for the unlock dialog, and what follows it waits for it to be sent", async () => {
  const first = snapshot(5, "first");
  const { store, sent } = await recording({ ...first, service: { ...first.service, remote: true } });
  const toasts: string[] = [];
  const pause: Command = { type: "service.pause", for: "forever" };
  const held = sendOrHold(store, pause, () => toasts.push("Reviews paused until you resume."));
  // Held: nothing sent, nothing said, so Cancel drops it without a word.
  expect(held?.command).toEqual(pause);
  expect(sent).toEqual([]);
  expect(toasts).toEqual([]);
  // Unlocked: the command goes after the unlock, and only then the toast.
  if (held) unlockAndSend(store, held);
  await settled();
  expect(sent).toEqual([{ type: "service.unlock" }, pause]);
  expect(toasts).toEqual(["Reviews paused until you resume."]);
});

test("on this machine, or once unlocked, a command is sent at once and what follows it runs once taken", async () => {
  const { store, sent } = await recording(snapshot(5, "first"));
  const toasts: string[] = [];
  expect(sendOrHold(store, { type: "service.resume" }, () => toasts.push("Reviews resumed."))).toBeNull();
  expect(sent).toEqual([{ type: "service.resume" }]);
  // The service has not answered yet: nothing is said.
  expect(toasts).toEqual([]);
  await settled();
  expect(toasts).toEqual(["Reviews resumed."]);
});

test("what follows a command never runs when the service refused it, after an unlock too", async () => {
  const s = service(snapshot(5, "first"), new Refused(409, { error: "the checks are already running" }));
  const store = new Store(s.api);
  await settled();
  const toasts: string[] = [];
  sendOrHold(store, { type: "service.pause", for: "forever" }, () => toasts.push("Reviews paused."));
  await settled();
  expect(toasts).toEqual([]);
  expect(store.getStatus().refusal).toEqual({
    status: 409,
    error: "the checks are already running",
    command: { type: "service.pause", for: "forever" },
  });
  unlockAndSend(store, { command: { type: "service.resume" }, sent: () => toasts.push("Reviews resumed.") });
  await settled();
  expect(toasts).toEqual([]);
});

test("an unlock refused sends nothing after it", async () => {
  const first = snapshot(5, "first");
  const s = service({ ...first, service: { ...first.service, remote: true } });
  const sent: Command[] = [];
  s.api.send = (command) => {
    sent.push(command);
    return Promise.reject(new Refused(403, { error: "wrong unlock" }));
  };
  const store = new Store(s.api);
  await settled();
  const toasts: string[] = [];
  unlockAndSend(store, { command: { type: "service.resume" }, sent: () => toasts.push("Reviews resumed.") });
  await settled();
  expect(sent).toEqual([{ type: "service.unlock" }]);
  expect(toasts).toEqual([]);
});

test("send says whether the service took the command", async () => {
  const took = await recording(snapshot(5, "first"));
  expect(await took.store.send({ type: "service.resume" })).toBe(true);
  const s = service(snapshot(5, "first"), new Refused(501, { error: "not available yet" }));
  const store = new Store(s.api);
  await settled();
  expect(await store.send({ type: "service.resume" })).toBe(false);
});

test("a refusal, after an unlock too, runs what follows a refusal, never what follows a take (the save stamp)", async () => {
  const s = service(snapshot(5, "first"), new Refused(501, { error: "not available yet" }));
  const store = new Store(s.api);
  await settled();
  const said: string[] = [];
  const sent = () => said.push("saved");
  const refused = () => said.push("not saved");
  sendOrHold(store, { type: "service.startAtLogin", on: true }, sent, refused);
  await settled();
  expect(said).toEqual(["not saved"]);
  unlockAndSend(store, { command: { type: "service.resume" }, sent, refused });
  await settled();
  expect(said).toEqual(["not saved", "not saved"]);
  const took = await recording(snapshot(5, "first"));
  sendOrHold(took.store, { type: "service.startAtLogin", on: true }, sent, refused);
  await settled();
  expect(said).toEqual(["not saved", "not saved", "saved"]);
});

test("a cancelled unlock sends nothing and runs what follows a refusal, never what follows a take", async () => {
  const first = snapshot(5, "first");
  const { store, sent } = await recording({ ...first, service: { ...first.service, remote: true } });
  const said: string[] = [];
  const held = sendOrHold(
    store,
    { type: "settings.set", key: "depth", value: "deep" },
    () => said.push("saved"),
    () => said.push("not saved"),
  );
  cancelHeld(held);
  await settled();
  expect(sent).toEqual([]);
  expect(said).toEqual(["not saved"]);
  // Nothing held, nothing to say.
  cancelHeld(null);
  expect(said).toEqual(["not saved"]);
});

/** `state` with one open pull request of `author`'s in its one repository. */
function withPullRequest(state: State, author: "you" | "other"): State {
  const id = changeId("sam/app#1");
  const repo = repositoryId("sam/app");
  return {
    ...state,
    repos: [{ id: repo, owner: "sam", name: "app", enabled: true, settings: DEFAULTS }],
    changes: {
      [id]: {
        id,
        repoId: repo,
        number: 1,
        title: "A change",
        openedBy: author === "you" ? "sam" : "ana",
        author,
        writtenBy: null,
        headSha: commitSha("a1f9c2e"),
        openedAt: NOW,
        draft: false,
        fork: false,
        newCommits: 0,
      },
    },
    reviews: { [id]: emptyReview(id, NOW) },
  };
}

test("Mine and Everyone show once another author's pull request is listed, and stay while the page is open (ADR 0078)", async () => {
  const s = service(withPullRequest(snapshot(5, "first"), "you"));
  const store = new Store(s.api);
  await settled();
  expect(store.scope.get()).toEqual({ scope: "mine", shown: false });
  s.send({ type: "state.replaced", at: NOW, seq: 6, state: withPullRequest(snapshot(6, "x"), "other") });
  expect(store.scope.get()).toEqual({ scope: "mine", shown: true });
  store.scope.choose("everyone");
  // The teammate's pull request closed: the tabs and the choice stay.
  s.send({ type: "state.replaced", at: NOW, seq: 7, state: snapshot(7, "closed") });
  expect(store.scope.get()).toEqual({ scope: "everyone", shown: true });
});

/** `state` watching `count` repositories of sam's. */
const watching = (state: State, count: number): State => ({
  ...state,
  repos: Array.from({ length: count }, (_, i) => ({
    id: repositoryId(`sam/app-${i}`),
    owner: "sam",
    name: `app-${i}`,
    enabled: true,
    settings: DEFAULTS,
  })),
});

test("Repositories' search and filter show once more than ten are watched, and stay while the app is open (ADR 0082)", async () => {
  const s = service(watching(snapshot(5, "first"), 10));
  const store = new Store(s.api);
  await settled();
  expect(store.repositoriesBar.get()).toBe(false);
  s.send({ type: "state.replaced", at: NOW, seq: 6, state: watching(snapshot(6, "x"), 11) });
  expect(store.repositoriesBar.get()).toBe(true);
  // Two leave: nine are left, the bar stays.
  s.send({ type: "state.replaced", at: NOW, seq: 7, state: watching(snapshot(7, "y"), 9) });
  expect(store.repositoriesBar.get()).toBe(true);
});
