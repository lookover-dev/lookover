// Coming back reads at once (ADR 0088, 0091): signed in, the window gaining focus or the tab shown again sends
// `connection.returned` once per return, whatever the copy says of the look (a hidden tab's copy is behind),
// so the person back from GitHub sees the listing of that moment while one runs; signed out, or on a server this
// session has not unlocked, nothing; a return refused is said nowhere. `LookOnReturn` as the app mounts
// it, in a real DOM, on a store whose service keeps what it is sent, the tab's presence faked by hand. The DOM is
// `withDom`'s, this file's only; the component is imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import type { Command, LookoverApi, State } from "@lookover/contracts";
import { Refused } from "./api/http.ts";
import type { Presence } from "./look-on-return.tsx";
import { Providers, world } from "./screens/repositories.test-support.tsx";
import { Store } from "./store.tsx";
import { withDom } from "./ui/dom.test-support.tsx";
import { LOOK } from "./view-model/accounts.ts";

const dom = withDom();
let LookOnReturn: typeof import("./look-on-return.tsx").LookOnReturn;
let RETURNED: typeof import("./look-on-return.tsx").RETURNED;

beforeAll(async () => {
  ({ LookOnReturn, RETURNED } = await import("./look-on-return.tsx"));
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

/**
 * `LookOnReturn` on `state`, on a store whose service keeps in `sent` what it is sent, refusing it (`refusing`, a
 * status) or not; `sends` holds what each `store.send` answered; `draw` renders a new state.
 */
async function tab(state: State, { refusing }: { refusing?: number } = {}) {
  const presence = new FakePresence();
  const sent: Command[] = [];
  const api: LookoverApi = {
    snapshot: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    send: (command) => {
      sent.push(command);
      return refusing === undefined
        ? Promise.resolve()
        : Promise.reject(new Refused(refusing, { error: "refused" }));
    },
    logs: () => Promise.resolve([]),
    subscribeLogs: () => () => undefined,
  };
  const store = new Store(api);
  const sends: Promise<boolean>[] = [];
  const send = store.send;
  store.send = (command) => {
    const answered = send(command);
    sends.push(answered);
    return answered;
  };
  const draw = async (next: State) => {
    store.state = next;
    await dom.render(
      <Providers store={store} state={next}>
        <LookOnReturn presence={presence} />
      </Providers>,
    );
  };
  await draw(state);
  return { presence, sent, sends, draw, store };
}

/** The person goes to GitHub's tab and comes back. */
const away = (presence: FakePresence) => {
  presence.say(false);
  presence.say(true);
};

test("signed in, the copy saying a look runs, coming back sends one return: focus and the tab shown again are one", async () => {
  const { presence, sent } = await tab(at());
  away(presence);
  // The browser says both as the person comes back from GitHub's tab: one return, one command.
  presence.say(true);
  expect(sent).toEqual([RETURNED]);
  // Away again, back again: a second return.
  away(presence);
  expect(sent).toEqual([RETURNED, RETURNED]);
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

test("the copy saying no look runs, coming back sends the return all the same: the service knows", async () => {
  // The look ended while the tab was hidden, the patch saying so not applied yet; or one began as the tab hid.
  const { presence, sent } = await tab(at({ running: false }));
  away(presence);
  expect(sent).toEqual([RETURNED]);
});

test("a look that starts or ends while the person is away changes nothing: every return sends the return", async () => {
  const { presence, sent, draw } = await tab(at({ running: false }));
  presence.say(false);
  await draw(at());
  presence.say(true);
  expect(sent).toEqual([RETURNED]);
  presence.say(false);
  await draw(at({ running: false }));
  presence.say(true);
  expect(sent).toEqual([RETURNED, RETURNED]);
});

test("a return refused is said nowhere: no toast, no band line", async () => {
  const { presence, sent, sends, store } = await tab(at(), { refusing: 409 });
  away(presence);
  expect(sent).toEqual([RETURNED]);
  expect(await Promise.all(sends)).toEqual([false]);
  expect(store.getStatus().refusal).toBeNull();
});

test("a plain look refused, a link's or Check again's, is said: the store keeps its notice", async () => {
  const { store } = await tab(at(), { refusing: 409 });
  expect(await store.send(LOOK)).toBe(false);
  expect(store.getStatus().refusal).toMatchObject({ status: 409, command: LOOK });
});

test("focus that never left sends nothing: a return needs the tab to have gone first", async () => {
  const { presence, sent } = await tab(at());
  presence.say(true);
  expect(sent).toEqual([]);
});
