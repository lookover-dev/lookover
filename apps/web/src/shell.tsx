// What is always there: the top bar with the three destinations, the status pill, Ctrl K and the shortcuts.
import type { Command, Engine, State } from "@lookover/contracts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FixButton } from "./screens/github-app.tsx";
import { reviewPath, useApp, useAppState, useSend, useStoreStatus, useTheme } from "./store.tsx";
import { Button, Chip, Eyes, Icon, IconButton, type IconName, Kbd, Mark, Said } from "./ui/basics.tsx";
import { Dialog, Layer, MenuItem, useToast } from "./ui/layers.tsx";
import { clock } from "./view-model/format.ts";
import { checkLine, engineStateText, serviceStatus } from "./view-model/health.ts";
import { type Refusal, refusalText } from "./view-model/refusal.ts";
import {
  authorLabel,
  changeLabel,
  changeReviews,
  chip,
  fixOn,
  githubStatus,
  pill,
  problems,
  REVIEW_KEY,
  REVIEWERS_TEXT,
  sendElsewhere,
  status,
} from "./view-model/select.ts";
import { settingValueText } from "./view-model/settings.ts";

const PLACES: { to: string; label: string; icon: IconName; key: string }[] = [
  { to: "/", label: "Reviews", icon: "lines", key: "1" },
  { to: "/repositories", label: "Repositories", icon: "repo", key: "2" },
  { to: "/settings", label: "Settings", icon: "settings", key: "3" },
];

function isCurrent(path: string, to: string): boolean {
  // The logs sit under Reviews (their breadcrumb says so): its tab stays the current one there.
  return to === "/"
    ? path === "/" || path.startsWith("/reviews") || path.startsWith("/logs")
    : path.startsWith(to);
}

export function TopBar() {
  const { pathname } = useLocation();
  return (
    <header className="top">
      <Link to="/" className="mk" aria-label="Lookover, reviews">
        <Mark />
      </Link>
      <span className="navsep" />
      <nav className="navtop" aria-label="Main">
        {PLACES.map((p) => (
          <Link key={p.to} to={p.to} aria-current={isCurrent(pathname, p.to) ? "page" : undefined}>
            {p.label}
          </Link>
        ))}
      </nav>
      <StatusPill />
    </header>
  );
}

/** Phone: the same three destinations at the bottom. */
export function TabBar() {
  const { pathname } = useLocation();
  return (
    <nav className="tabbar" aria-label="Main">
      {PLACES.map((p) => (
        <Link key={p.to} to={p.to} aria-current={isCurrent(pathname, p.to) ? "page" : undefined}>
          <Icon name={p.icon} />
          {p.label}
        </Link>
      ))}
    </nav>
  );
}

/** One status line: the dot says fine, warn, or nothing judged (`ok` null: the fact alone), then the words. */
function StatusLine({
  ok,
  children,
  action,
}: {
  ok: boolean | null;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <span>
      <i className={ok === null ? "mute" : ok ? "" : "warn"} />
      <span className="st-text">{children}</span>
      {action}
    </span>
  );
}

function EngineStatus({ engine }: { engine: Engine }) {
  const state = useAppState();
  const send = useSend();
  const problem = problems(state).find((x) => x.id === engine.id);
  // Reviews waiting for this AI: the owner may send them to the other one. Never automatic (ADR 0029).
  const elsewhere = sendElsewhere(state, engine.id);
  return (
    <div className="st-block">
      <StatusLine
        ok={engine.state === "ready"}
        // The view model's fix, the one the band offers too.
        action={problem ? <FixButton problem={problem} busyLabel="Waiting…" /> : null}
      >
        {engine.name}: {engineStateText(engine)}
      </StatusLine>
      {problem ? (
        <small className="code-whole">
          <Said words={problem.detail} />
        </small>
      ) : null}
      {elsewhere ? (
        <button
          type="button"
          className="st-link"
          onClick={() => send({ type: "engine.reroute", from: engine.id })}
        >
          Send the {elsewhere.count === 1 ? "waiting review" : `${elsewhere.count} waiting reviews`} to{" "}
          {state.engines[elsewhere.to].name}
        </button>
      ) : null}
    </div>
  );
}

function HostAndServiceStatus() {
  const state = useAppState();
  // Every GitHub problem (ADR 0067): the connection's on GitHub's own line, with its one fix (Reconnect, or the page
  // on GitHub that fixes its cause, ADR 0053); then each account's on the shared App, in GitHub's order, a line each.
  const github = githubStatus(state);
  const connectionProblem = github.problems.find((x) => x.account === undefined);
  const accountProblems = github.problems.filter((x) => x.account !== undefined);
  // Whether it starts at login for real (ADR 0054), with the alert band's fix when the machine didn't do as chosen.
  const service = serviceStatus(state.service);
  const login = problems(state).find((x) => x.id === "login");
  return (
    <>
      <div className="st-block">
        <StatusLine
          ok={github.ok}
          action={connectionProblem ? <FixButton problem={connectionProblem} busyLabel="Waiting…" /> : null}
        >
          GitHub: {github.text}
        </StatusLine>
        {connectionProblem ? (
          <small className="code-whole">
            <Said words={connectionProblem.detail} />
          </small>
        ) : null}
      </div>
      {/* An account's line names it, and its fix may too ("Ask an owner of ledger-dev"): the fix goes under the
          line and its detail, so the title isn't squeezed beside it. */}
      {accountProblems.map((p) => (
        <div key={p.id} className="st-block">
          <StatusLine ok={false}>{p.title}</StatusLine>
          <small className="code-whole">
            <Said words={p.detail} />
          </small>
          <div className="st-fix">
            <FixButton problem={p} busyLabel="Waiting…" />
          </div>
        </div>
      ))}
      <div className="st-block">
        <StatusLine
          ok={service.ok}
          action={login ? <FixButton problem={login} busyLabel="Waiting…" /> : null}
        >
          Service: {service.text}
        </StatusLine>
        {login ? (
          <small className="code-whole">
            <Said words={login.detail} />
          </small>
        ) : null}
      </div>
    </>
  );
}

function PauseControls() {
  const { service } = useAppState();
  const send = useSend();
  if (service.paused) {
    return (
      <MenuItem
        onSelect={() => send({ type: "service.resume" })}
        hint={service.paused.until ? `paused until ${clock(service.paused.until)}` : "paused until resumed"}
      >
        <Icon name="run" />
        Resume reviews
      </MenuItem>
    );
  }
  return (
    <>
      <div className="h">Pause reviews</div>
      <div className="pause">
        <Button size="sm" onClick={() => send({ type: "service.pause", for: "hour" })}>
          For 1 hour
        </Button>
        <Button size="sm" onClick={() => send({ type: "service.pause", for: "tomorrow" })}>
          Until tomorrow
        </Button>
        <Button size="sm" onClick={() => send({ type: "service.pause", for: "forever" })}>
          Until I resume
        </Button>
      </div>
      <small className="st-note">
        Nothing starts while paused. Review requests wait, in the app or by comment.
      </small>
    </>
  );
}

function Checks() {
  const { service, engines } = useAppState();
  const send = useSend();
  const finished = service.checks && !service.checks.running ? service.checks : null;
  return (
    <>
      <MenuItem
        onSelect={() => send({ type: "service.runChecks" })}
        hint={finished ? `checked at ${clock(finished.at)}` : undefined}
      >
        {service.checks?.running ? <Eyes /> : null}
        Run all checks
      </MenuItem>
      {finished ? (
        <div className="st checks">
          {finished.items
            .map((item) => checkLine(engines, item))
            .map((c) => (
              <StatusLine key={c.label} ok={c.ok}>
                {c.label}: {c.detail}
              </StatusLine>
            ))}
        </div>
      ) : null}
    </>
  );
}

function StatusMenu({ close }: { close: () => void }) {
  const state = useAppState();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <div className="menu">
      <div className="h">Status</div>
      <div className="st">
        {Object.values(state.engines).map((e) => (
          <EngineStatus key={e.id} engine={e} />
        ))}
        <HostAndServiceStatus />
      </div>
      <hr />
      <PauseControls />
      <hr />
      <Checks />
      <MenuItem
        onSelect={() => {
          navigator.clipboard?.writeText(diagnostics(state));
          toast({ text: "Diagnostics copied. Secrets removed." });
          close();
        }}
      >
        Copy diagnostics
      </MenuItem>
      <MenuItem
        onSelect={() => {
          void navigate("/logs");
          close();
        }}
      >
        Open logs
      </MenuItem>
    </div>
  );
}

function StatusPill() {
  const state = useAppState();
  const p = pill(state);
  const dot = p.tone === "warn" ? "warn" : p.tone === "mute" ? "mute" : "";
  return (
    <Layer
      align="right"
      width={372}
      className="pill-menu"
      trigger={(props) => (
        <button type="button" className="pill" {...props} data-pill>
          <i className={dot} />
          {p.label}
        </button>
      )}
    >
      {(close) => <StatusMenu close={close} />}
    </Layer>
  );
}

function diagnostics(state: State): string {
  const e = Object.values(state.engines).map((x) => `${x.cli} ${x.version ?? "-"}: ${x.state}`);
  return [`lookover ${state.service.version}`, ...e, `github: ${state.connection.state}`].join("\n");
}

interface PaletteItem {
  group: "Pull requests" | "Actions" | "Settings";
  label: string;
  hint?: string;
  lead?: ReactNode;
  keywords: string;
  run: () => void;
}

/**
 * The settings pages behind the common ones. Each is one click from Settings and one search from Ctrl K.
 * "Posting on GitHub" and "Import and export" went with the settings writer (ADR 0049).
 */
export const MORE_SETTINGS: { id: string; title: string; line: string }[] = [
  {
    id: "rules",
    title: "Review rules",
    line: "From REVIEW.md, AGENTS.md and CLAUDE.md, with how often each one fires",
  },
];

/**
 * What needs the person, said once, above every page. It is not a row: it is a band under the top bar,
 * so it is never mistaken for a pull request. Each line carries its one fix. A command the service refused is
 * a line of it too, with a × in place of the fix: the toast says it once, the band keeps it until dismissed.
 */
export function Alerts() {
  const state = useAppState();
  const { store } = useApp();
  const { refusal } = useStoreStatus(store);
  const { pathname } = useLocation();
  const list = problems(state).map((p) => ({ ...p, fix: fixOn(p, pathname) }));
  if (list.length === 0 && !refusal) return null;
  return (
    <section className="alerts" aria-label="Needs you">
      <div className="alerts-in">
        {list.map((p) => (
          <div className={`alert ${p.tone}`} key={p.id}>
            <span className="alert-label">{p.tone === "need" ? "Needs you" : "Waiting"}</span>
            <span className="alert-text code-whole">
              <b>{p.title}.</b> <Said words={p.detail} />
            </span>
            <FixButton problem={p} busyLabel="Waiting for the sign-in…" />
          </div>
        ))}
        {/* Last, so the lines above keep their place when it appears or goes: only the band's bottom edge moves. */}
        {refusal ? <RefusedLine refusal={refusal} dismiss={store.dismiss} /> : null}
      </div>
    </section>
  );
}

function RefusedLine({ refusal, dismiss }: { refusal: Refusal; dismiss: () => void }) {
  const { title, detail } = refusalText(refusal);
  return (
    <div className="alert warn refused">
      <span className="alert-label">Refused</span>
      <span className="alert-text">
        <b>{title}.</b> {detail}
      </span>
      <IconButton icon="close" label="Dismiss" onClick={dismiss} />
    </div>
  );
}

/** Ctrl K: pull requests, actions, settings, in this order. Enter runs the first match. */
export function Palette({ mode, onClose }: { mode: "all" | "review" | null; onClose: () => void }) {
  const state = useAppState();
  const send = useSend();
  const navigate = useNavigate();
  const toast = useToast();
  const { openShortcuts } = useApp();
  const [theme, setTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery("");
    setIndex(0);
  }, [mode]);

  const all = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => navigate(to);
    const reviewable = changeReviews(state).filter(
      (it) =>
        mode !== "review" ||
        (it.change.author !== "other" && !["running", "waiting"].includes(status(it).kind)),
    );
    const changes: PaletteItem[] = reviewable.map((it) => {
      const c = chip(it);
      return {
        group: "Pull requests",
        label: it.change.title,
        hint: changeLabel(it.change),
        lead: <Chip tone={c.tone}>{c.label}</Chip>,
        keywords: `${it.change.title} ${changeLabel(it.change)} ${it.change.number} ${authorLabel(it.change)}`,
        run:
          mode === "review"
            ? () => {
                send({ type: "review.request", changeId: it.change.id });
                void navigate(reviewPath(it.change));
              }
            : go(reviewPath(it.change)),
      };
    });
    if (mode === "review") return changes;
    const act = (label: string, command: Command, done?: string): PaletteItem => ({
      group: "Actions",
      label,
      keywords: label,
      run: () => {
        // Said once the service took it: on a locked server after the unlock; never if cancelled or refused.
        send(command, done ? () => toast({ text: done }) : undefined);
      },
    });
    const actions: PaletteItem[] = [
      state.service.paused
        ? act("Resume reviews", { type: "service.resume" }, "Reviews resumed.")
        : act("Pause reviews", { type: "service.pause", for: "forever" }, "Reviews paused until you resume."),
      {
        group: "Actions",
        label: "Run all checks",
        keywords: "run all checks doctor",
        run: () => {
          send({ type: "service.runChecks" });
          // The result shows where status lives: in the pill's menu.
          setTimeout(() => document.querySelector<HTMLElement>("[data-pill]")?.click(), 50);
        },
      },
      { group: "Actions", label: "All reviews", keywords: "all reviews history", run: go("/reviews") },
      {
        group: "Actions",
        label: "Show keyboard shortcuts",
        hint: "?",
        keywords: "keyboard shortcuts help",
        run: openShortcuts,
      },
      {
        group: "Actions",
        label: `Switch to the ${theme === "light" ? "dark" : "light"} theme`,
        keywords: "theme dark light appearance",
        run: () => setTheme(theme === "light" ? "dark" : "light"),
      },
    ];
    const s = state.settings;
    const setting = (label: string, hint: string, anchor: string): PaletteItem => ({
      group: "Settings",
      label,
      hint,
      keywords: label,
      run: go(`/settings#${anchor}`),
    });
    const settings: PaletteItem[] = [
      setting("Strictness", settingValueText("strictness", s.strictness.value), "strictness"),
      setting("Depth", settingValueText("depth", s.depth.value), "depth"),
      setting("Who reviews", REVIEWERS_TEXT[s.reviewers.value], "reviewers"),
      setting("When to review", s.onPush.value ? "on open and on every push" : "on open", "when"),
      ...MORE_SETTINGS.map<PaletteItem>((m) => ({
        group: "Settings",
        label: m.title,
        keywords: `${m.title} ${m.line}`,
        run: go(`/settings/${m.id}`),
      })),
    ];
    return [...changes, ...actions, ...settings];
  }, [state, mode, theme, navigate, send, toast, openShortcuts, setTheme]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? all.filter((i) => i.keywords.toLowerCase().includes(q))
    : mode === "review"
      ? all
      : [
          ...all.filter((i) => i.group === "Pull requests").slice(0, 5),
          ...all.filter((i) => i.group !== "Pull requests"),
        ];
  const active = Math.min(index, shown.length - 1);
  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  useEffect(() => {
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  });

  let lastGroup = "";
  return (
    <Dialog open={mode !== null} onClose={onClose} className="cmdk">
      <div className="search">
        <Icon name="search" />
        <input
          className="input"
          autoFocus
          placeholder={
            mode === "review" ? "Which pull request should be reviewed?" : "Pull requests, actions, settings…"
          }
          aria-label="Search pull requests, actions and settings"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex(Math.min(active + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setIndex(Math.max(active - 1, 0));
            else if (e.key === "Enter") pick(shown[active]);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <div className="menu" ref={listRef}>
        {shown.length === 0 ? <div className="cmdk-none">Nothing matches “{query}”.</div> : null}
        {shown.map((item, i) => {
          const head = item.group !== lastGroup ? <div className="h">{item.group}</div> : null;
          lastGroup = item.group;
          return (
            <div key={`${item.group}-${item.label}-${item.hint ?? ""}`}>
              {head}
              <button
                type="button"
                tabIndex={-1}
                data-active={i === active}
                onClick={() => pick(item)}
                onMouseMove={() => setIndex(i)}
              >
                {item.lead ? <span className="cmdk-lead">{item.lead}</span> : null}
                <span className="cmdk-label">{item.label}</span>
                {item.hint ? <span className="r">{item.hint}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

const SHORTCUTS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      [["Ctrl", "K"], "Find a pull request, an action or a setting"],
      [["?"], "Show this list"],
      [["1"], "Reviews"],
      [["2"], "Repositories"],
      [["3"], "Settings"],
      [["S"], "Open the status pill"],
      [["P"], "Pause or resume reviews"],
      [["Esc"], "Close what is open, or go back"],
    ],
  },
  {
    title: "In a list",
    keys: [
      [["J"], "Next pull request"],
      [["K"], "Previous pull request"],
      [["Enter"], "Open it"],
      [["/"], "Search the list"],
    ],
  },
  {
    title: "On a review",
    keys: [
      [["R"], REVIEW_KEY],
      [["C"], "Copy a fix prompt for my agent"],
      [["G"], "Open on GitHub"],
    ],
  },
];

/** The list of shortcuts. Reference, not a question: the one place a dialog only informs. */
export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" className="keys">
      <div className="keys-grid">
        {SHORTCUTS.map((group) => (
          <section key={group.title}>
            <div className="t-label">{group.title}</div>
            {group.keys.map(([keys, text]) => (
              <div className="keys-row" key={text}>
                <span>{text}</span>
                <span className="keys-k">
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function typing(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

function isPaletteKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
}

/** A key pressed with a modifier, while typing, or under an open dialog is not a shortcut. */
function withModifier(e: KeyboardEvent): boolean {
  return (
    e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector("dialog[open]") !== null
  );
}

/** Moves the focus one row down (1) or up (-1); the first key press lands on the first row. */
function focusRow(step: 1 | -1) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  rows[Math.min(Math.max(at + step, 0), rows.length - 1)]?.focus();
}

/** Runs the global shortcut for a key. Returns whether the key was one. */
function runGlobalKey(
  key: string,
  {
    openShortcuts,
    go,
    togglePause,
  }: { openShortcuts: () => void; go: (to: string) => void; togglePause: () => void },
): boolean {
  switch (key) {
    case "?":
      openShortcuts();
      return true;
    case "1":
      go("/");
      return true;
    case "2":
      go("/repositories");
      return true;
    case "3":
      go("/settings");
      return true;
    case "s":
      document.querySelector<HTMLElement>("[data-pill]")?.click();
      return true;
    case "p":
      togglePause();
      return true;
    case "j":
      focusRow(1);
      return true;
    case "k":
      focusRow(-1);
      return true;
    case "/": {
      const search = document.querySelector<HTMLElement>("main input[type='search']");
      search?.focus();
      return search !== null;
    }
    default:
      return false;
  }
}

/** Global keys. Page-specific keys (R, C, G on a review) are registered with usePageKeys. */
export function useGlobalKeys(openPalette: () => void, openShortcuts: () => void) {
  const navigate = useNavigate();
  const send = useSend();
  const state = useAppState();
  const paused = state.service.paused !== null;
  const ready = state.setup.done;
  const toast = useToast();

  useEffect(() => {
    const go = (to: string) => void navigate(to);
    const togglePause = () => {
      // The toast waits for the service to take the command: a locked server asks to unlock first.
      send(paused ? { type: "service.resume" } : { type: "service.pause", for: "forever" }, () =>
        toast({ text: paused ? "Reviews resumed." : "Reviews paused until you resume." }),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault();
        if (ready) openPalette();
        return;
      }
      if (!ready || withModifier(e)) return;
      if (runGlobalKey(e.key, { openShortcuts, go, togglePause })) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, send, paused, ready, openPalette, openShortcuts, toast]);
}

/** Single-letter keys for the current page. */
export function usePageKeys(keys: Record<string, (() => void) | undefined>) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (withModifier(e)) return;
      const run = ref.current[e.key.toLowerCase()];
      if (!run) return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
