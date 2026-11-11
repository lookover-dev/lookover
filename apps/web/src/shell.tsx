// What is always there: the top bar with the three destinations, the status pill, Ctrl K and the shortcuts.
import type { Command, State } from "@lookover/contracts";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { FixButton } from "./screens/github-app.tsx";
import { reviewPath, useApp, useAppState, useSend, useStoreStatus, useTheme } from "./store.tsx";
import { Button, Chip, Icon, IconButton, type IconName, Kbd, Mark, Said } from "./ui/basics.tsx";
import { Boundary } from "./ui/boundary.tsx";
import { Dialog, Layer, MenuItem, useToast } from "./ui/layers.tsx";
import { arrivedProps, leavingProps, PresenceList, type Shown, useArrived } from "./ui/presence.tsx";
import { fitWholeRows } from "./ui/whole-rows.ts";
import { clock } from "./view-model/format.ts";
import { checkLine } from "./view-model/health.ts";
import { type Refusal, refusalText } from "./view-model/refusal.ts";
import {
  authorLabel,
  bandOn,
  changeLabel,
  chip,
  type PaletteMode,
  type Problem,
  paletteReviews,
  pill,
  problems,
  REVIEW_KEY,
  REVIEWERS_TEXT,
  type StatusDot,
  type StatusMenuLine,
  sendElsewhere,
  statusMenuGroups,
  statusMenuLines,
} from "./view-model/select.ts";
import { settingValueText } from "./view-model/settings.ts";
import { atLoginDetail } from "./view-model/start-at-login.ts";

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
      <Boundary what="status" look="pill">
        <StatusPill />
      </Boundary>
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

/**
 * One status line: its dot, green when fine, grey when nothing was judged (the fact alone), else its problem's tone,
 * pink when it needs the person and amber when it waits, as the band says it (ADR 0070).
 */
function StatusLine({ dot, children }: { dot: StatusDot | "mute"; children: ReactNode }) {
  return (
    <span>
      <i className={dot === "ok" ? "" : dot} />
      <span className="st-text">{children}</span>
    </span>
  );
}

/** Under an AI's line, reviews waiting for it: the owner may send them to the other one. Never automatic (ADR 0029). */
function SendElsewhere({ line }: { line: string }) {
  const state = useAppState();
  const send = useSend();
  const engine = Object.values(state.engines).find((e) => e.id === line)?.id;
  const elsewhere = engine ? sendElsewhere(state, engine) : null;
  if (!(engine && elsewhere)) return null;
  return (
    <button type="button" className="st-link" onClick={() => send({ type: "engine.reroute", from: engine })}>
      Send the {elsewhere.count === 1 ? "waiting review" : `${elsewhere.count} waiting reviews`} to{" "}
      {state.engines[elsewhere.to].name}
    </button>
  );
}

/**
 * The status lines (`statusMenuLines`): the ones with a problem first, each in a well of its own (`.leads`), then the
 * fine ones together in one well of the same inset on the menu's surface (`.st-fine`), so every line starts at one x
 * (round 5: the fine lines flush beside the boxed ones made the list's edge jump). Under problems, the fine well has a
 * heading, "Fine", so the healthy group reads apart and quieter, never as a third problem (round 6). Every line with a
 * problem is laid out alike: its line, its detail, its fix under the detail, the view model's, the one the band offers
 * too. Under, never beside: a fix may name what its line names ("Ask an owner of ledger-dev") and side by side the line
 * would wrap.
 */
function StatusLines() {
  const state = useAppState();
  const { leads, fine, fineHeading } = statusMenuGroups(statusMenuLines(state));
  return (
    <>
      {leads.map((line) => (
        <OneStatusLine key={line.id} line={line} className="st-block leads" />
      ))}
      {fineHeading ? <div className="h st-h">{fineHeading}</div> : null}
      {fine.length > 0 ? (
        <div className="st-fine">
          {fine.map((line) => (
            <OneStatusLine key={line.id} line={line} className="st-block" />
          ))}
        </div>
      ) : null}
    </>
  );
}

function OneStatusLine({ line, className }: { line: StatusMenuLine; className: string }) {
  const state = useAppState();
  // Another Lookover holds the start at login (ADR 0068): which one, by its command; said, not warned, no fix.
  const takenDetail = atLoginDetail(state.service);
  return (
    <div className={className}>
      <StatusLine dot={line.dot}>{line.text}</StatusLine>
      {line.problem ? (
        <>
          <small>
            <Said words={line.problem.detail} />
          </small>
          {line.problem.fix ? (
            <div className="st-fix">
              <FixButton problem={line.problem} busyLabel="Waiting…" />
            </div>
          ) : null}
        </>
      ) : null}
      <SendElsewhere line={line.id} />
      {line.id === "service" && takenDetail ? (
        <small>
          <Said words={takenDetail} />
        </small>
      ) : null}
    </div>
  );
}

function PauseControls() {
  const { service } = useAppState();
  const send = useSend();
  if (service.paused) {
    return (
      <MenuItem
        icon="run"
        onSelect={() => send({ type: "service.resume" })}
        hint={service.paused.until ? `paused until ${clock(service.paused.until)}` : "paused until resumed"}
      >
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
        icon="again"
        busy={service.checks?.running === true}
        onSelect={() => send({ type: "service.runChecks" })}
        hint={finished ? `checked at ${clock(finished.at)}` : undefined}
      >
        Run all checks
      </MenuItem>
      {finished ? (
        <div className="st checks">
          {finished.items
            .map((item) => checkLine(engines, item))
            .map((c) => (
              <StatusLine key={c.label} dot={c.ok === null ? "mute" : c.ok ? "ok" : "warn"}>
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
        <StatusLines />
      </div>
      <hr />
      <PauseControls />
      <hr />
      <Checks />
      <MenuItem
        icon="copy"
        onSelect={() => {
          navigator.clipboard?.writeText(diagnostics(state));
          toast({ text: "Diagnostics copied. Secrets removed." });
          close();
        }}
      >
        Copy diagnostics
      </MenuItem>
      <MenuItem
        icon="lines"
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
  const dot = p.tone === "ok" ? "" : p.tone;
  return (
    <Layer
      align="right"
      width={400}
      scrim
      className="pill-menu"
      trigger={(props) => (
        <button type="button" className="pill" {...props} data-pill>
          <i className={dot} />
          {p.label}
        </button>
      )}
    >
      {(close) => (
        // Inside the layer, which gives each opening fresh content, a reopening while it leaves too: a menu that failed
        // tries again on the next.
        <Boundary what="status-menu">
          <StatusMenu close={close} />
        </Boundary>
      )}
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
  /** A setting's value, in the value column on the right. */
  hint?: string;
  /** The key that does the same from anywhere ("?"), as a key cap at the row's end. */
  kbd?: string;
  /** A pull request's second line: its repository and number ("sasensi/ledger-api #151"), whole under its title. */
  meta?: string;
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
  const lines: BandLine[] = [
    ...problems(state).map((p): BandLine => ({ problem: bandOn(p, pathname) })),
    // Last, so the lines above keep their place when it appears or goes: only the band's bottom edge moves.
    ...(refusal ? [{ refusal }] : []),
  ];
  // A line resolved or dismissed leaves (ADR 0087); the band leaves with its last one, whole, as it last was.
  return (
    <PresenceList items={lines.length > 0 ? [lines] : []} keyOf={() => "band"} exits>
      {(held, band) => (
        <Band shown={band}>
          <div className="alerts-in">
            <PresenceList
              items={held}
              keyOf={(line) => ("problem" in line ? line.problem.id : REFUSED)}
              exits
            >
              {(line, shown) =>
                "problem" in line ? (
                  <AlertLine
                    problem={line.problem}
                    fix={<FixButton problem={line.problem} busyLabel="Waiting for the sign-in…" />}
                    shown={shown}
                  />
                ) : (
                  <RefusedLine refusal={line.refusal} dismiss={store.dismiss} shown={shown} />
                )
              }
            </PresenceList>
          </div>
        </Band>
      )}
    </PresenceList>
  );
}

/** One line of the band: a problem, or the command the service refused. */
type BandLine = { problem: Problem } | { refusal: Refusal };
const REFUSED = "refused";

/**
 * The band itself, there while it has a line to hold: one that appears after the page's first paint slides in
 * (`data-arrived`), one there when the page first shows is still.
 */
function Band({ shown, children }: { shown: Shown; children: ReactNode }) {
  const arrived = useArrived();
  return (
    <section {...leavingProps("alerts", shown)} aria-label="Needs you" {...arrivedProps(arrived)}>
      {children}
    </section>
  );
}

/**
 * One line of the band, tinted by its own tone (round 4): pink when it needs the person, amber when it only waits,
 * so a Waiting line beside one that needs you is never on pink.
 */
export function AlertLine({ problem, fix, shown }: { problem: Problem; fix: ReactNode; shown?: Shown }) {
  return (
    <div {...leavingProps(`alert ${problem.tone}`, shown)}>
      <span className="alert-label">{problem.tone === "need" ? "Needs you" : "Waiting"}</span>
      <span className="alert-text">
        <b>{problem.title}.</b> <Said words={problem.detail} />
      </span>
      {fix}
    </div>
  );
}

/** The refused command's line: amber, as a Waiting line, the band's last. */
export function RefusedLine({
  refusal,
  dismiss,
  shown,
}: {
  refusal: Refusal;
  dismiss: () => void;
  shown?: Shown;
}) {
  const { title, detail } = refusalText(refusal);
  return (
    <div {...leavingProps("alert warn refused", shown)}>
      <span className="alert-label">Refused</span>
      <span className="alert-text">
        <b>{title}.</b> {detail}
      </span>
      <IconButton icon="close" label="Dismiss" onClick={dismiss} />
    </div>
  );
}

/**
 * A palette row's words. A pull request's: two lines, its title whole on the first and its repository and number on
 * the second, so neither is cut. Any other: one line, its value in the value column on the right, or its key as a key
 * cap at the row's end.
 */
export function PaletteRow({ item }: { item: Pick<PaletteItem, "label" | "hint" | "kbd" | "meta"> }) {
  if (item.meta) {
    return (
      <span className="cmdk-title">
        <span className="cmdk-label">{item.label}</span>
        <span className="cmdk-meta">{item.meta}</span>
      </span>
    );
  }
  return (
    <>
      <span className="cmdk-label">{item.label}</span>
      {item.hint ? <span className="r">{item.hint}</span> : null}
      {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
    </>
  );
}

/** Ctrl K: pull requests, actions, settings, in this order. Enter runs the first match. */
export function Palette({ mode: asked, onClose }: { mode: PaletteMode | null; onClose: () => void }) {
  // What it shows is the last mode it was opened in: closed, it fades out showing what it showed (ADR 0087).
  const [mode, setMode] = useState<PaletteMode>(asked ?? "all");
  if (asked !== null && asked !== mode) setMode(asked);
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
    // Review a pull request…: only those its review page offers Review now or Review again for
    // (ADR 0092), the person's first, then others' (ADR 0078).
    const reviewable = paletteReviews(state, mode);
    const changes: PaletteItem[] = reviewable.map((it) => {
      const c = chip(it);
      return {
        group: "Pull requests",
        label: it.change.title,
        meta: changeLabel(it.change),
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
        kbd: "?",
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

  // whole rows only: the list ends under the last row that fits (design-system.md "Command palette", round 6), fitted
  // before the paint, so no frame shows a stale height, and again on every resize of the window, whose height its room is
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    fitWholeRows(list);
    list.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  });
  useLayoutEffect(() => {
    const refit = () => {
      if (listRef.current) fitWholeRows(listRef.current);
    };
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  let lastGroup = "";
  return (
    <Dialog open={asked !== null} onClose={onClose} className="cmdk">
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
            <div key={`${item.group}-${item.label}-${item.meta ?? ""}${item.hint ?? ""}`}>
              {head}
              <button
                type="button"
                tabIndex={-1}
                data-active={i === active}
                onClick={() => pick(item)}
                onMouseMove={() => setIndex(i)}
              >
                {item.lead ? <span className="cmdk-lead">{item.lead}</span> : null}
                <PaletteRow item={item} />
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

/**
 * Moves the focus one row down (1) or up (-1); the first key press lands on the first row. What leaves (marked
 * `data-leaving`, the row or the section around it) is no row any more: its copy is inert.
 */
function focusRow(step: 1 | -1) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")].filter(
    (r) => !r.closest("[data-leaving]"),
  );
  const active = document.activeElement;
  const at = active instanceof HTMLElement ? rows.indexOf(active) : -1;
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
