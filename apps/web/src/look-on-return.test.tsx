// Coming back reads at once (ADR 0088): while an install look runs, the window gaining focus or the tab shown again
// sends `connection.look` once per return, so the person back from GitHub sees the listing of that moment; with no
// look running, signed out, or on a server this session has not unlocked, nothing. `LookOnReturn` as the app mounts
// it, in a real DOM, on a store whose service keeps what it is sent, the tab's presence faked by hand. The DOM is
// `withDom`'s, this file's only; the component is imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import type { Command, LookoverApi, State } from "@lookover/contracts";
import type { Presence } from "./look-on-return.tsx";
import { Providers, world } from "./screens/repositories.test-support.tsx";
import { Store } from "./store.tsx";
import { withDom } from "./ui/dom.test-support.tsx";

const dom = withDom();
let LookOnReturn: typeof import("./look-on-return.tsx").LookOnReturn;

beforeAll(async () => {
  LookOnReturn = (await import("./look-on-return.tsx")).LookOnReturn;
});

/** The tab, moved by hand: `say(false)` as it goes (blurred, hidden), `say(true)` as it comes back (focused, shown). */
class FakePresence implements Presence {
  private readonly listeners = new Set<(here: boolean) => void>();
  onChange(listener: (here: boolean) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  say(here: boolean) {
    for (const l of this.listeners) l(here);
  }
}

const LOOK = { type: "connection.look" } as const;

/** The world signed in, a look running or not; `locked` on a server this session has not unlocked. */
function at({ running = true, signedOut = false, locked = false } = {}): State {
  const state = world();
  return {
    ...state,
    connection: {
      ...state.connection,
      ...(signedOut ? { state: "disconnected", cause: { kind: "signed-out" } } : {}),
      look: running
        ? {
            since: state.now - 10_000,
            until: state.now + 170_000,
            lookedAt: state.now - 2_000,
            ended: null,
            arrived: null,
            stopped: null,
          }
        : null,
    },
    service: { ...state.service, remote: locked, unlocked: false },
  };
}

/** `LookOnReturn` on `state`, on a store whose service keeps in `sent` what it is sent; `draw` renders a new state. */
async function tab(state: State) {
  const presence = new FakePresence();
  const sent: Command[] = [];
  const api: LookoverApi = {
    snapshot: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    send: (command) => {
      sent.push(command);
      return Promise.resolve();
    },
    logs: () => Promise.resolve([]),
    subscribeLogs: () => () => undefined,
  };
  const store = new Store(api);
  const draw = async (next: State) => {
    store.state = next;
    await dom.render(
      <Providers store={store} state={next}>
        <LookOnReturn presence={presence} />
      </Providers>,
    );
  };
  await draw(state);
  return { presence, sent, draw };
}

/** The person goes to GitHub's tab and comes back. */
const away = (presence: FakePresence) => {
  presence.say(false);
  presence.say(true);
};

test("signed in, while a look runs, coming back sends one look: focus and the tab shown again are the same return", async () => {
  const { presence, sent } = await tab(at());
  away(presence);
  // The browser says both as the person comes back from GitHub's tab: one return, one look.
  presence.say(true);
  expect(sent).toEqual([LOOK]);
  // Away again, back again: a second return.
  away(presence);
  expect(sent).toEqual([LOOK, LOOK]);
});

test("on a server this session has not unlocked, coming back sends nothing: a return never asks to unlock", async () => {
  const { presence, sent } = await tab(at({ locked: true }));
  away(presence);
  expect(sent).toEqual([]);
});

test("signed out, coming back sends nothing, whatever the look", async () => {
  const { presence, sent } = await tab(at({ signedOut: true }));
  away(presence);
  expect(sent).toEqual([]);
});

test("with no look running, coming back sends nothing", async () => {
  const { presence, sent } = await tab(at({ running: false }));
  away(presence);
  expect(sent).toEqual([]);
});

test("a look that starts while the person is away is read as they come back; one that ended meanwhile is not", async () => {
  const { presence, sent, draw } = await tab(at({ running: false }));
  presence.say(false);
  // The link's own command started it as GitHub's tab opened.
  await draw(at());
  presence.say(true);
  expect(sent).toEqual([LOOK]);
  presence.say(false);
  await draw(at({ running: false }));
  presence.say(true);
  expect(sent).toEqual([LOOK]);
});

test("focus that never left sends nothing: a return needs the tab to have gone first", async () => {
  const { presence, sent } = await tab(at());
  presence.say(true);
  expect(sent).toEqual([]);
});
