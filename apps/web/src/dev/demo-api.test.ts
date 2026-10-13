// The drawer's door to the demo driver: what it asks the service and what it does with the answers. A stand-in
// for `fetch` records each request and answers as the service does (the routes are contracts' names, and the
// service's own tests play the same verbs through the same door).
import { expect, test } from "bun:test";
import { API, DEMO_API, type DemoListing, FAULTS } from "@lookover/contracts";
import { Refused } from "../api/http.ts";
import { DemoApi, DemoFeed, drawerRefusalLine, ListingFollower, nextEventLine } from "./demo-api.ts";

const T0 = Date.UTC(2026, 9, 6, 8, 52);

const LISTING: DemoListing = {
  scenarios: [
    {
      id: "S10",
      title: "A quiet day",
      what: "Three pull requests.",
      steps: ["Open #146."],
      later: "",
      path: "/",
    },
  ],
  current: "S10",
  clock: { now: T0, running: false, speed: 1, nextIn: 90_000 },
  faults: FAULTS,
};

interface Asked {
  url: string;
  method: string;
  body: unknown;
}

function service(answer: (asked: Asked) => Response) {
  const asked: Asked[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const one = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    asked.push(one);
    expect(init?.credentials).toBe("same-origin");
    return answer(one);
  };
  const lost: (string | null)[] = [];
  const api = new DemoApi({ base: "http://127.0.0.1:9", fetch, lost: (open) => lost.push(open) });
  return { asked, api, lost };
}

test("a verb or the listing answered 401 ends the session, as the app's own requests do (#68)", async () => {
  const { api, lost } = service(() => Response.json({ error: "no session" }, { status: 401 }));
  await expect(api.send({ type: "demo.step" })).rejects.toMatchObject({ status: 401, reason: "no session" });
  expect(lost).toEqual([null]);
  await expect(api.listing()).rejects.toMatchObject({ status: 401 });
  expect(lost).toEqual([null, null]);
});

test("a 401 that names the command that opens Lookover hands it on, as the app's own requests do (ADR 0058)", async () => {
  const open = String.raw`& 'C:\Users\Your Name\Downloads\lookover.exe' open`;
  const { api, lost } = service(() => Response.json({ error: "no session", open }, { status: 401 }));
  await expect(api.send({ type: "demo.step" })).rejects.toMatchObject({ status: 401 });
  await expect(api.listing()).rejects.toMatchObject({ status: 401 });
  expect(lost).toEqual([open, open]);
});

test("any other refusal leaves the session alone", async () => {
  const { api, lost } = service(() => Response.json({ error: "loading" }, { status: 409 }));
  await expect(api.send({ type: "demo.step" })).rejects.toMatchObject({ status: 409 });
  expect(lost).toEqual([]);
});

test("the listing is read from the demo route, with the session", async () => {
  const { asked, api } = service(() => Response.json(LISTING));
  expect(await api.listing()).toEqual(LISTING);
  expect(asked).toEqual([{ url: `http://127.0.0.1:9${DEMO_API.listing}`, method: "GET", body: null }]);
});

test("a dev verb is posted where a command is", async () => {
  const { asked, api } = service(() => new Response(null, { status: 204 }));
  await api.send({ type: "demo.load", id: "S10" });
  await api.send({ type: "demo.advance", ms: 60_000 });
  expect(asked).toEqual([
    { url: `http://127.0.0.1:9${API.commands}`, method: "POST", body: { type: "demo.load", id: "S10" } },
    { url: `http://127.0.0.1:9${API.commands}`, method: "POST", body: { type: "demo.advance", ms: 60_000 } },
  ]);
});

test("a refused verb rejects with the status and the service's words", async () => {
  const { api } = service(() =>
    Response.json({ error: "no pull request left to open in this scenario" }, { status: 409 }),
  );
  await expect(api.send({ type: "demo.inject", fault: "agent-opens-change" })).rejects.toMatchObject({
    status: 409,
    reason: "no pull request left to open in this scenario",
  });
});

test("a listing refused, as in live mode, rejects too", async () => {
  const { api } = service(() => Response.json({ error: "no demo in live mode" }, { status: 404 }));
  await expect(api.listing()).rejects.toMatchObject({ status: 404 });
});

test("the next event is said from the service's time, and nothing when none is armed", () => {
  const clock = { now: T0, running: true, speed: 1, nextIn: 90_000 };
  expect(nextEventLine(clock, T0)).toBe("The next event is in 1 min 30 s.");
  // The tab's time moved on since the listing was read: the line follows it.
  expect(nextEventLine(clock, T0 + 60_000)).toBe("The next event is in 30 s.");
  expect(nextEventLine(clock, T0 + 120_000)).toBe("The next event is due now.");
  // A pause until tomorrow is said in hours.
  expect(nextEventLine({ ...clock, nextIn: 26 * 3_600_000 + 5 * 60_000 }, T0)).toBe(
    "The next event is in 26 h 5 min.",
  );
  expect(nextEventLine({ ...clock, nextIn: null }, T0)).toBe(
    "Nothing is scheduled. Use the app, or make something happen below.",
  );
});

test("a refused verb is said in the drawer: the app's words, else the service's", () => {
  expect(drawerRefusalLine(new Refused(409, { error: "loading" }))).toBe(
    "Lookover couldn't do that. A scenario is loading.",
  );
  // The drawer is not the app: a fault with nothing to act on says what the service found missing.
  expect(drawerRefusalLine(new Refused(409, { error: "no pull request open" }))).toBe(
    "Lookover couldn't do that: no pull request open.",
  );
  expect(drawerRefusalLine(new Refused(500, {}))).toBe("Lookover couldn't do that.");
  expect(drawerRefusalLine(new TypeError("Failed to fetch"))).toBe(
    "Lookover couldn't do that. The service didn't answer.",
  );
});

/** Timers on a hand-moved time, and a listing read that answers when the test says. */
function following() {
  let time = 0;
  let armed: { at: number; fire: () => void }[] = [];
  const timers = {
    now: () => time,
    after: (ms: number, fire: () => void) => {
      const one = { at: time + ms, fire };
      armed.push(one);
      return () => {
        armed = armed.filter((a) => a !== one);
      };
    },
  };
  const reads: ((listing: DemoListing) => void)[] = [];
  const read = () => new Promise<DemoListing>((resolve) => reads.push(resolve));
  const shown: string[] = [];
  const follower = new ListingFollower(read, (listing) => shown.push(listing.current), timers);
  const pass = (ms: number) => {
    time += ms;
    for (const a of armed.filter((one) => one.at <= time)) {
      armed = armed.filter((one) => one !== a);
      a.fire();
    }
  };
  return { follower, reads, shown, pass, read, timers };
}

const named = (current: string): DemoListing => ({ ...LISTING, current });

test("the listing is read at once, then at most once a second however often the app's state moves", async () => {
  const { follower, reads, pass } = following();
  follower.moved();
  expect(reads).toHaveLength(1);
  // A running clock: the state moves many times a second.
  for (let i = 0; i < 10; i++) {
    pass(100);
    follower.moved();
  }
  expect(reads).toHaveLength(2);
  pass(400);
  expect(reads).toHaveLength(2);
  // The last move is read too, a second after the read before it.
  follower.moved();
  pass(600);
  expect(reads).toHaveLength(3);
  pass(5_000);
  expect(reads).toHaveLength(3);
});

test("a verb's answer is read at once, and only the latest read is shown", async () => {
  const { follower, reads, shown } = following();
  follower.moved();
  follower.readNow();
  expect(reads).toHaveLength(2);
  reads[1]?.(named("S4"));
  await Bun.sleep(0);
  // The older read answers late: what it says is stale.
  reads[0]?.(named("S10"));
  await Bun.sleep(0);
  expect(shown).toEqual(["S4"]);
  follower.stop();
  follower.moved();
  expect(reads).toHaveLength(2);
});

test("the app's running times follow demo mode's clock, read by the app whether or not the drawer is there", async () => {
  const { reads, pass, read, timers } = following();
  const feed = new DemoFeed(read, timers);
  // Nobody listens yet: nothing is read, and the clock is taken as standing still.
  feed.moved();
  expect([reads.length, feed.get(), feed.current()]).toEqual([0, 0, null]);
  let heard = 0;
  const leave = feed.subscribe(() => heard++);
  expect(reads).toHaveLength(1);
  reads[0]?.({ ...LISTING, clock: { ...LISTING.clock, running: true, speed: 60 } });
  await Bun.sleep(0);
  expect([feed.get(), feed.current()?.current, heard]).toEqual([60, "S10", 1]);
  // The app's state moves: read again, at most once a second, as the drawer's listing was.
  pass(1_000);
  feed.moved();
  expect(reads).toHaveLength(2);
  reads[1]?.({ ...LISTING, clock: { ...LISTING.clock, running: false, speed: 60 } });
  await Bun.sleep(0);
  expect([feed.get(), heard]).toEqual([0, 2]);
  // A verb's answer reads at once.
  feed.readNow();
  expect(reads).toHaveLength(3);
  // The last listener gone, nothing more is read.
  leave();
  pass(1_000);
  feed.moved();
  feed.readNow();
  expect(reads).toHaveLength(3);
});
