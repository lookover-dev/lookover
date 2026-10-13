// The UI's copy of the state moves only through `apply` (AGENTS.md rule 3), a replaced snapshot included.
// Beside it, what the store knows of the service's answers: a refused command, kept as the notice until
// dismissed, and a session the service no longer knows (the session screen, #68).
import { expect, test } from "bun:test";
import {
  type Command,
  changeId,
  type Event,
  GITHUB_WEB,
  type LookoverApi,
  type ResolvedSettings,
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
    gh: null,
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
      githubRefused: null,
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
      bot: null,
      app: null,
      installationId: null,
      web: GITHUB_WEB,
      since: NOW,
      limitUntil: null,
      gh: null,
    },
    service: {
      state: "running",
      since: NOW,
      version: "0.1.0",
      command: "lookover",
      agent: { path: { reach: "no", folder: "~/.local/bin" }, offer: "binary", skills: [] },
      startAtLogin: true,
      startsAtLogin: true,
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
 * store the session is gone, as the HTTP client does when its stream reconnects into a 401.
 */
function service(first: State | Error, refuse?: Error) {
  const listeners: ((event: Event) => void)[] = [];
  const lostListeners: ((open: string | null) => void)[] = [];
  const api: LookoverApi & SessionAware = {
    snapshot: () => (first instanceof Error ? Promise.reject(first) : Promise.resolve(first)),
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
  return { api, send, lost };
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
  await store.send({ type: "review.request", changeId: changeId("app#9") });
  await settled();
  expect(store.getStatus().refusal).toEqual({
    status: 404,
    error: "no such change",
    command: { type: "review.request", changeId: changeId("app#9") },
  });
  const down = service(snapshot(5, "first"), new TypeError("fetch failed"));
  const other = new Store(down.api);
  await settled();
  await other.send({ type: "engine.check" });
  await settled();
  expect(other.getStatus().refusal).toEqual({ status: 0, error: null, command: { type: "engine.check" } });
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

test("a refused Use an existing App is said in the console without its key (ADR 0053)", async () => {
  const s = service(snapshot(5, "first"), new Refused(501, { error: "not available yet" }));
  const store = new Store(s.api);
  await settled();
  const said: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => said.push(JSON.stringify(args));
  try {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret0key\n-----END RSA PRIVATE KEY-----\n";
    expect(await store.send({ type: "connection.useApp", appId: 4242, key })).toBe(false);
  } finally {
    console.error = error;
  }
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("connection.useApp");
  expect(said[0]).toContain("4242");
  expect(said[0]).not.toContain("secret0key");
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
