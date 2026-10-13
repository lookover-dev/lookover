// Dev only: the developer drawer, one for both modes, and the demo's pages. It talks to the service's demo
// driver through `DemoApi` (ADR 0046), never to the app's state: what it changes comes back to the app as
// events, like anything else. In demo mode it lists the scenarios, loads and resets one, runs, stops, speeds up
// and jumps the service's clock, and makes things happen; in live mode (the real GitHub App, `claude` and
// `codex`) it says so and offers "Refresh" alone. The listing is the app's one (`DemoFeed`), followed as the app's
// state moves (an event, a reload, the keepalive's clock; at most once a second) and read after each verb, so
// another tab's load shows here too.
import type { DemoCommand, DemoListing } from "@lookover/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, Route, useNavigate } from "react-router-dom";
import { Sentence } from "../screens/common.tsx";
import { useAppState } from "../store.tsx";
import { Button, Icon, Kbd, Segmented } from "../ui/basics.tsx";
import { type DemoApi, type DemoFeed, drawerRefusalLine, nextEventLine } from "./demo-api.ts";

const OPEN_KEY = "lookover.drawer";

/** The demo's pages, as routes for the app's router: the phone preview and "How to try it". */
export function devRoutes(api: DemoApi, feed: DemoFeed) {
  return [
    <Route key="phone" path="/phone" element={<PhoneFrame />} />,
    <Route key="try" path="/try" element={<TryPage api={api} feed={feed} />} />,
  ];
}

/** Whether the drawer is open: remembered by this browser, toggled with Ctrl+. */
function useDrawerOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "closed");

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, open ? "open" : "closed");
    document.documentElement.toggleAttribute("data-drawer", open);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return [open, setOpen];
}

const NO_FEED = {
  subscribe: () => () => undefined,
  current: () => null,
  readNow: () => undefined,
};

/**
 * The demo listing, the app's one (`DemoFeed`: followed as the app's state moves, at most once a second); `again`
 * reads it now, after a verb. Null until the first, and in live mode (no feed).
 */
function useListing(feed: DemoFeed | null): { listing: DemoListing | null; again: () => void } {
  const { subscribe, current, readNow } = feed ?? NO_FEED;
  const listing = useSyncExternalStore(subscribe, current);
  return { listing, again: readNow };
}

/**
 * Runs one verb at a time: `busy` while it is under way, the refusal's line after one is refused (cleared by the
 * next that goes through), then `done` on success.
 */
function useVerbs(api: DemoApi, again: () => void) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const run = (command: DemoCommand, done?: () => void) => {
    setBusy(true);
    api
      .send(command)
      .then(
        () => {
          setSaid("");
          done?.();
        },
        (error: unknown) => {
          console.error("The demo refused a verb", command, error);
          setSaid(drawerRefusalLine(error));
        },
      )
      .finally(() => {
        setBusy(false);
        again();
      });
  };
  return { busy, said, run };
}

const SPEEDS = [
  { value: 1, label: "1×" },
  { value: 10, label: "10×" },
  { value: 60, label: "60×" },
];

const JUMPS = [
  { ms: 60_000, label: "1 min" },
  { ms: 10 * 60_000, label: "10 min" },
  { ms: 60 * 60_000, label: "1 h" },
  { ms: 24 * 60 * 60_000, label: "1 day" },
];

/** `feed`: demo mode's listing; none in live mode. */
export function Drawer({ api, feed }: { api: DemoApi; feed: DemoFeed | null }) {
  const live = feed === null;
  const [open, setOpen] = useDrawerOpen();
  const { listing, again } = useListing(feed);
  const tab = live ? "Live" : listing ? `Demo · ${listing.current}` : null;

  if (!open) {
    // In demo the tab names the scenario: it is drawn once the listing says which, never grown after.
    if (tab === null) return null;
    return (
      <button
        type="button"
        className="drawer-tab"
        onClick={() => setOpen(true)}
        title="Open the developer drawer (Ctrl .)"
      >
        {tab}
      </button>
    );
  }
  return (
    <aside
      className="drawer"
      aria-label={live ? "Developer drawer (live mode)" : "Scenario drawer (demo mode)"}
    >
      <div className="drawer-head">
        <span className="t-label">
          {live ? "Live mode · not part of the app" : "Demo mode · not part of the app"}
        </span>
        <button
          type="button"
          className="drawer-x"
          onClick={() => setOpen(false)}
          aria-label="Close the drawer"
        >
          <Icon name="close" />
        </button>
      </div>
      {live ? (
        <LiveBody api={api} />
      ) : listing ? (
        <DemoBody api={api} listing={listing} again={again} />
      ) : null}
    </aside>
  );
}

function LiveBody({ api }: { api: DemoApi }) {
  const { busy, said, run } = useVerbs(api, () => undefined);
  return (
    <div className="drawer-body">
      <p className="t-small">
        The app runs on the service in live mode: the real GitHub App, the real Claude and the real Codex, on
        the repositories the live config lists and the App is installed on. A pull request you open is
        reviewed by itself, and Review now posts a real review. The service checks GitHub every minute, every
        10 s while a review is going on.
      </p>
      <div className="drawer-row">
        <Button size="sm" icon="again" disabled={busy} onClick={() => run({ type: "refresh" })}>
          Refresh
        </Button>
      </div>
      <p className="t-small">
        Push a fix to the pull request yourself; Refresh shows it at once. Round 2 starts when you comment{" "}
        <code>/lookover review</code>, when your agent runs <code>lookover wait</code>, or by itself with
        “Review again after every push” on.
      </p>
      <div className="drawer-links">
        <span>
          <Kbd>Ctrl</Kbd>
          <Kbd>.</Kbd> hides this
        </span>
      </div>
      {/* Last in the body: nothing is under it to move when it is said. */}
      <p className="t-small" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

function DemoBody({ api, listing, again }: { api: DemoApi; listing: DemoListing; again: () => void }) {
  const navigate = useNavigate();
  const { now } = useAppState();
  const { busy, said, run } = useVerbs(api, again);
  const scenario = listing.scenarios.find((s) => s.id === listing.current);
  const { clock } = listing;

  const load = (id: string) => {
    const next = listing.scenarios.find((s) => s.id === id);
    run({ type: "demo.load", id }, () => void navigate(next?.path ?? "/"));
  };

  return (
    <div className="drawer-body">
      <div className="drawer-scn">
        {listing.scenarios.map((s) => (
          <button
            type="button"
            key={s.id}
            aria-pressed={s.id === listing.current}
            disabled={busy}
            onClick={() => load(s.id)}
          >
            <code>{s.id}</code>
            {s.title}
          </button>
        ))}
      </div>
      {scenario ? (
        <div className="drawer-what">
          <b>{scenario.title}</b>
          <p>{scenario.what}</p>
          <ol>
            {scenario.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {scenario.later ? <p className="t-small">{scenario.later}</p> : null}
        </div>
      ) : null}
      <div className="t-label">Time</div>
      <div className="drawer-row">
        <Button
          size="sm"
          icon={clock.running ? "pause" : "run"}
          disabled={busy}
          onClick={() => run({ type: "demo.clock", running: !clock.running, speed: clock.speed })}
        >
          {clock.running ? "Pause time" : "Run time"}
        </Button>
        <Segmented
          label="Speed"
          value={clock.speed}
          onChange={(speed) => run({ type: "demo.clock", running: clock.running, speed })}
          options={SPEEDS}
          disabled={busy}
        />
      </div>
      <div className="drawer-row" role="group" aria-label="Jump ahead">
        <span className="t-small">Jump</span>
        {JUMPS.map((j) => (
          <Button
            key={j.ms}
            size="sm"
            disabled={busy}
            onClick={() => run({ type: "demo.advance", ms: j.ms })}
          >
            {j.label}
          </Button>
        ))}
      </div>
      <div className="drawer-row">
        <Button
          size="sm"
          icon="next"
          disabled={busy || clock.nextIn === null}
          onClick={() => run({ type: "demo.step" })}
        >
          Step to the next event
        </Button>
      </div>
      <p className="t-small">{nextEventLine(clock, now)}</p>
      <div className="t-label">Make something happen</div>
      <div className="drawer-faults">
        {listing.faults.map((f) => (
          <button
            type="button"
            key={f.id}
            disabled={busy}
            onClick={() => run({ type: "demo.inject", fault: f.id })}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="t-small dev-said" aria-live="polite">
        {said}
      </p>
      <div className="drawer-row">
        <Button size="sm" icon="again" disabled={busy} onClick={() => load(listing.current)}>
          Reset this scenario
        </Button>
      </div>
      <div className="drawer-links">
        <Link to="/phone">Phone preview</Link>
        <Link to="/try">How to try it</Link>
        <span>
          <Kbd>Ctrl</Kbd>
          <Kbd>.</Kbd> hides this
        </span>
      </div>
    </div>
  );
}

/** The app in a phone-sized frame: the same page on the same service, so it follows the same scenario. */
function PhoneFrame() {
  return (
    <div className="phone-page">
      <p className="t-small">
        Phone preview, 390 × 780. It follows the same service as this page.{" "}
        <Link to="/">Back to the desktop app</Link>
      </p>
      <iframe className="phone" title="Lookover on a phone" src="/?embed=1" />
    </div>
  );
}

function TryPage({ api, feed }: { api: DemoApi; feed: DemoFeed }) {
  const navigate = useNavigate();
  const { listing, again } = useListing(feed);
  const { busy, said, run } = useVerbs(api, again);
  return (
    <main className="page">
      <div className="crumb">
        <Link to="/">Back to the app</Link>
      </div>
      <Sentence
        title="How to try it."
        small="This is Lookover in demo mode: the real service on a fake GitHub, with a Claude and a Codex that answer from a script. No account, no network. Nothing you do here spends anything."
      />
      <div className="try-notes">
        <p>
          <b>The drawer on the right</b> is not part of the app. It loads a scenario, runs or pauses time, and
          makes things happen. <Kbd>Ctrl</Kbd> <Kbd>.</Kbd> hides it.
        </p>
        <p>
          <b>Time is yours.</b> Run it at 1×, 10× or 60×, jump ahead, or step straight to the next event: a
          review's steps, a pause until tomorrow, GitHub's wait.
        </p>
        <p>
          <b>Every tab shows the same story.</b> Loading a scenario resets the world, and each open tab
          follows. “Reset this scenario” starts it again.
        </p>
        <p>
          <b>Write what you feel</b> in <code>docs/product/ux-feedback.md</code>, one section per scenario:
          what felt wrong, what was missing, what was too much.
        </p>
        <p className="t-small dev-said" aria-live="polite">
          {said}
        </p>
      </div>
      {listing ? (
        <div className="list">
          {listing.scenarios.map((s) => (
            <div className="card try-card" key={s.id}>
              <div>
                <b>
                  <code>{s.id}</code> {s.title}
                </b>
                <p>{s.what}</p>
                <ol>
                  {s.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {s.later ? <p className="t-small">{s.later}</p> : null}
              </div>
              <Button
                disabled={busy}
                onClick={() => run({ type: "demo.load", id: s.id }, () => void navigate(s.path))}
              >
                Start
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}
