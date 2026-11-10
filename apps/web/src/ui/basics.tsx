// The design system's simple components. Names and states follow docs/product/design-system.md.

import {
  type ButtonHTMLAttributes,
  Fragment,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { WithCommand } from "../view-model/format.ts";
import type { LogRun } from "../view-model/logs.ts";
import { IN_DISPLAY, saidParts } from "../view-model/said.ts";
import type { SaveShown } from "../view-model/save.ts";
import { ICON_TILE, LOADER, MARK } from "./eyes.generated.ts";
import { type Fold, foldMarks } from "./fold.tsx";
import { CodePath } from "./path.tsx";
import { arrivedProps, leavingProps, type Shown, useEntry } from "./presence.tsx";

const ICONS = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  chevron: <path d="M4 6l4 4 4-4" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  external: <path d="M9 3h4v4M13 3L7 9M6 4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  pause: <path d="M5.5 3v10M10.5 3v10" />,
  run: <path d="M5 3l8 5-8 5z" />,
  again: <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6" />,
  settings: (
    <>
      <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4" />
      <circle cx="8" cy="8" r="2.5" />
    </>
  ),
  rule: <path d="M8 2.5l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.7l-3.6 1.9.7-4L2.2 6.8l4-.6z" />,
  file: <path d="M4 14V2h5l3 3v9zM9 2v3h3M6 8h4M6 11h4" />,
  time: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 5v3.5l2 1.5" />,
  lines: <path d="M3 4h10M3 8h10M3 12h6" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  // Added for the app (same grid and stroke): the three destinations on phone, and "next".
  repo: <path d="M4 2.5h8v11H4zM4 10.5h8M6.5 5h3" />,
  next: <path d="M6 4l4 4-4 4" />,
  // Back to what applied before: the one way back on a setting that differs.
  revert: <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6M3 6.5l3-3M3 6.5l3 3" />,
  // What is not done yet, in a state square before (design-system.md "State square"): to install, to sign in.
  install: <path d="M8 2.5v7.5M4.5 6.5L8 10l3.5-3.5M3 13.5h10" />,
  "sign-in": (
    <path d="M9.5 2.5H12a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5M2.5 8h7.5M7 4.5L10.5 8 7 11.5" />
  ),
  // An account's state before its detail (the accounts list): not installed, a dashed ring where the App would be;
  // ask its owners, two people; a cause holds it; another account to add.
  absent: <circle cx="8" cy="8" r="6" strokeDasharray="2.71 2" />,
  owners: (
    <>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.4a4.5 4.5 0 0 1 2.5 4.1" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.75v3.75M8 11.25v.01" />
    </>
  ),
  add: <path d="M8 3v10M3 8h10" />,
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`ic ${className}`} viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/**
 * The only loader. The eyes read a line in three stops and jump back while something runs; `still` looks down
 * and rests. Light on dark the eyes are solid and the pupil is a hole, as in the logo; dark on light they are
 * rings. Both are drawn, the styles show the one that fits the surface. Every number is the source's
 * (`eyes.generated.ts`, written by `bun run brand`); the box, the rest and the reading are in `system.css`.
 */
export function Eyes({ still = false, large = false }: { still?: boolean; large?: boolean }) {
  const mask = `eyes-${useId().replace(/:/g, "")}`;
  const { width, height, centres, cy, hole } = LOADER;
  const discs = (r: number) => centres.map((cx) => <circle key={cx} cx={cx} cy={cy} r={r} />);
  return (
    <span className={`eyes ${large ? "lg" : ""}`}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" fill="currentColor">
        <defs>
          <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
            <rect width={width} height={height} fill="#fff" />
            <g className={still ? "h" : "h read"} fill="#000">
              {centres.map((cx) => (
                <ellipse key={cx} cx={cx} cy={cy} rx={hole.rx} ry={hole.ry} />
              ))}
            </g>
          </mask>
        </defs>
        <g className="e-solid" mask={`url(#${mask})`}>
          {discs(LOADER.eye)}
        </g>
        <g className="e-ring">
          <g fill="none" stroke="currentColor" strokeWidth={LOADER.ring}>
            {discs(LOADER.ringRadius)}
          </g>
          <g className={still ? "p" : "p read"}>{discs(LOADER.dot)}</g>
        </g>
      </svg>
    </span>
  );
}

/** The mark's two lines: the first as wide as the pair, in `accent`; the second shorter, in `ink`. */
function MarkLines({ accent, ink }: { accent: string; ink: string }) {
  const { x, y1, y2, width1, width2, height } = MARK.lines;
  return (
    <>
      <rect x={x} y={y1} width={width1} height={height} fill={accent} />
      <rect x={x} y={y2} width={width2} height={height} fill={ink} />
    </>
  );
}

/**
 * The mark, in the colour of the text. Light on dark the eyes are solid with the pupil cut out; dark on light
 * they are rings, like the letter. Both are drawn, the styles show the one that fits the theme.
 */
export function Mark() {
  return (
    <svg
      className="mark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK.grid} ${MARK.grid}`}
      role="img"
      aria-label="Lookover"
    >
      <path className="mark-solid" fillRule="evenodd" fill="currentColor" d={MARK.solid} />
      <g className="mark-ring" fill="currentColor">
        <path fillRule="evenodd" d={MARK.ring} />
        <path d={MARK.pupils} />
      </g>
      <MarkLines accent="var(--acc)" ink="currentColor" />
    </svg>
  );
}

/**
 * The icon as its file draws it: the solid mark on its ink tile, in the file's fixed colours, standing for the
 * image GitHub shows as Lookover's avatar (design-system.md says why these colours are not the theme's).
 */
export function BrandIcon() {
  const { rx, tile, eyes, accent } = ICON_TILE;
  const { grid } = MARK;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${grid} ${grid}`} role="img" aria-label="Lookover">
      <rect width={grid} height={grid} rx={rx} fill={tile} />
      <path fillRule="evenodd" fill={eyes} d={MARK.solid} />
      <MarkLines accent={accent} ink={eyes} />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "quiet" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: IconName;
  kbd?: string;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  kbd,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const sizeClass = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "";
  return (
    <button type="button" className={`btn btn-${variant} ${sizeClass} ${className}`} {...rest}>
      {loading ? <Eyes /> : icon ? <Icon name={icon} /> : null}
      {children}
      {kbd ? <span className="kbd">{kbd}</span> : null}
    </button>
  );
}

/**
 * What a button's place says while what it would start is under way (design-system.md "Button"): not a button, a
 * status line, the state's words in its colour (lavender running, amber waiting) with the reading eyes before them, at
 * the start of the place, no fill and no edge, so it reads as Lookover at work, never as a dimmed control. Not a live region itself: inside `SameWidth`'s hidden
 * slots it would never be announced, so its caller says its words in one visually hidden status line beside it.
 */
export function BusyStatus({ tone, children }: { tone: "run" | "wait"; children: ReactNode }) {
  return (
    <span className="busy-status" data-tone={tone}>
      <Eyes />
      {children}
    </span>
  );
}

/**
 * One place for a button whose label changes with the state (design-system.md, Button: "keeps the width"): every
 * label it can take is laid out in the same cell, each under the state it stands for, and only the `shown` state's is
 * seen, so the place is as wide as the widest and nothing after it moves. The others are hidden, never focused nor
 * clicked, and hold width, never height (ADR 0086): laid out zero tall, so the place is as tall as the label it shows.
 */
export function SameWidth<K extends string>({ shown, labels }: { shown: K; labels: Record<K, ReactNode> }) {
  return (
    <span className="same-width">
      {Object.entries<ReactNode>(labels).map(([key, label]) => (
        <span key={key} className="same-width-slot" aria-hidden={key === shown ? undefined : true}>
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * A button that opens a page in a new tab (design-system.md, Link button): the button it stands for, with the
 * external icon at its start. A link, so the browser opens the tab itself; no referrer goes with it.
 */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className = "",
  onClick,
  kbd,
  title,
  label,
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** Runs as the tab opens: what the app records of it. It may stop the tab (`preventDefault`) to open it later. */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  kbd?: string;
  /** Said on hover: a label that may be cut, said whole. */
  title?: string;
  /** Its accessible name, when its words may be hidden (an icon alone on a phone). */
  label?: string;
  children: ReactNode;
}) {
  const sizeClass = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "";
  return (
    <a
      className={`btn btn-${variant} ${sizeClass} ${className}`}
      title={title}
      aria-label={label}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
    >
      <Icon name="external" />
      {children}
      {kbd ? <span className="kbd">{kbd}</span> : null}
    </a>
  );
}

/**
 * A value the owner copies into another program (design-system.md, Value to copy): the value in a block of its own,
 * the copy button level with its top.
 */
export function CopyLine({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <div className="copyline">
      <code>{value}</code>
      <IconButton icon="copy" label="Copy" onClick={onCopy} />
    </div>
  );
}

/**
 * What a chip says about a status, in colour (design-system.md, Chip): every tone one construction; `wait` is amber
 * as `warn` is, told apart by its dot, a ring.
 */
export type Tone = "need" | "run" | "ok" | "warn" | "wait" | "mute";

const CHIP_CLASS: Record<Tone, string> = {
  need: "c-need",
  run: "c-run",
  ok: "c-ok",
  warn: "c-warn",
  wait: "c-wait",
  mute: "c-mute",
};

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip ${CHIP_CLASS[tone]}`}>{children}</span>;
}

export function Tag({
  children,
  origin = false,
  title,
}: {
  children: ReactNode;
  origin?: boolean;
  title?: string;
}) {
  return (
    <span className={`tag ${origin ? "origin" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Search({ kbd, ...props }: InputHTMLAttributes<HTMLInputElement> & { kbd?: string }) {
  return (
    <div className="search">
      <Icon name="search" />
      <input className="input" type="search" {...props} />
      {kbd ? <span className="kbd">{kbd}</span> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  children,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
  label?: string;
  /**
   * Held where it is: drawn as any switch in its state, never dimmed, the not-allowed cursor; the caller says why in
   * words beside it (design-system.md, Switch).
   */
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "switch held" : "switch"}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i />
      {children}
    </label>
  );
}

/**
 * A checkbox. `mixed`, for one standing for several of which some are ticked, shows a bar and is announced as mixed;
 * it is not `checked`, so a click on it ticks them all. `label` names it when its visible text says less.
 */
export function Check({
  checked,
  onChange,
  children,
  disabled,
  mixed = false,
  label,
  describedBy,
  fold,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  mixed?: boolean;
  label?: string;
  /** The id of what describes the box beyond its label: setup's account count, "29 of 30 to review". */
  describedBy?: string;
  /** A row of a group that folds (`FoldRows`): setup's grouped checklist. */
  fold?: Fold;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // The browser clears `indeterminate` on a click; it is set again from `mixed` after every render.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  });
  return (
    <label
      className={fold === undefined ? "check" : fold.leaving ? "check fold-row leaving" : "check fold-row"}
      {...foldMarks(fold)}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked && !mixed}
        aria-checked={mixed ? "mixed" : undefined}
        aria-label={label}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

export function Radio({
  name,
  checked,
  onChange,
  disabled = false,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="check">
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  /** An option disabled alone can't be pressed but is drawn as any option not pressed, never dimmed; used for an option with nothing behind it. */
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  /** The whole control disabled: every option dimmed, said on the group. */
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label} aria-disabled={disabled ? true : undefined}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          disabled={disabled || o.disabled === true}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
  split = false,
}: {
  value: T;
  tabs: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  label?: string;
  /** A list's Mine / Everyone: each count holds room for three figures, so a growing count moves no tab. */
  split?: boolean;
}) {
  return (
    <div className={split ? "tabs split" : "tabs"} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          key={t.value}
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined ? <span className="n"> {t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * A surface card. `arrived`: it came after its gate's first commit (`useArrived`), so its CSS entry may play
 * (`data-arrived`, ADR 0087); the caller says whether, the card never decides.
 */
export function Card({
  children,
  className = "",
  arrived = false,
}: {
  children: ReactNode;
  className?: string;
  arrived?: boolean;
}) {
  return (
    <div className={`card ${className}`} {...arrivedProps(arrived)}>
      {children}
    </div>
  );
}

/** One pull request: chip, title, one meta line, at most one action. The whole row is clickable. */
export function Row({
  lead,
  title,
  meta,
  action,
  onOpen,
  fresh,
  status,
  selected,
  shown,
}: {
  lead: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  action?: ReactNode;
  onOpen?: () => void;
  /** It arrived in its list by a change of the world, not by a search or a filter: read once, as it mounts. */
  fresh?: boolean;
  /** The lead is a status chip: it gets a fixed column so titles line up down the list. */
  status?: boolean;
  selected?: boolean;
  /** In a list that keeps what leaves (`PresenceList`): whether it is leaving, and its mark. */
  shown?: Shown;
}) {
  // A fresh row rises in only if it arrived after the first paint (the first-paint gate), and only once: its entry
  // over, it keeps none for a later move in the list to replay. Leaving, it plays its exit instead; back while
  // leaving, it rises in again (`useEntry`).
  const { leaving, enters: rises, props } = useEntry(fresh, shown);
  const motion = leaving ? "leaving" : rises ? "new" : "";
  return (
    <div
      className={`rowi ${status ? "status" : ""} ${lead == null ? "nolead" : ""} ${motion} ${onOpen ? "" : "static"}`}
      {...props}
      tabIndex={onOpen ? 0 : undefined}
      role={onOpen ? "link" : undefined}
      data-row={onOpen ? "" : undefined}
      aria-current={selected || undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen?.();
      }}
    >
      {lead}
      <div className="rowi-main">
        <div className="ti">{title}</div>
        <div className="me">{meta}</div>
      </div>
      <span className="ac" onClick={(e) => e.stopPropagation()}>
        {action}
      </span>
    </div>
  );
}

/** A notice's tone: pink where the person is needed, amber while it waits, muted where it only informs. */
export type NoticeTone = "need" | "warn" | "mute";

/**
 * "Needs you": a surface card with a mono pink label and the still eyes. Buttons inside stay ordinary. A review
 * that waits says "Waiting" in amber, as the alert band does: pink is only for what needs you. What only informs (a
 * repository that left the installation) is `mute`: its label and eyes muted. Every notice is one layout
 * (design-system.md "Notice"): the eyes, the text column (the label over the sentence, flush), the action edge; what
 * opens under it (`below`) sits on the text column, after the actions, so Tab goes as the eye does.
 */
export function Notice({
  label = "Needs you",
  tone = "need",
  children,
  action,
  below,
  busy,
  shown,
}: {
  label?: string;
  tone?: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
  /** What opens under the notice, from the text column to the action edge: Left's list. */
  below?: ReactNode;
  busy?: boolean;
  /** In a list that keeps what leaves (`PresenceList`): whether it is leaving, and its mark. */
  shown?: Shown;
}) {
  const base = tone === "need" ? "banner" : `banner ${tone}`;
  return (
    <div {...leavingProps(base, shown)}>
      <Eyes still={!busy} />
      <span>
        <span className="lb">{label}</span>
        {children}
      </span>
      {action}
      {below}
    </div>
  );
}

/**
 * A notice whose list opens under it (design-system.md "Notice"): at its action edge a quiet Show (Hide once open),
 * as wide as either word (`SameWidth`) and named by what it opens, beside its ×, before what opens in Tab's order; what
 * opens (`below`) slides open on the text column, out of Tab's way while closed. The caller gives only the words, the
 * × and the list.
 */
export function NoticeDisclosure({
  label,
  tone,
  toggle,
  dismiss,
  below,
  children,
  shown,
}: {
  label: string;
  tone?: NoticeTone;
  /** In a list that keeps what leaves (`PresenceList`): whether it is leaving, and its mark. */
  shown?: Shown;
  /** The toggle's words, and its accessible names, which say what it opens. */
  toggle: { show: string; hide: string; showName: string; hideName: string };
  /** The × beside the toggle: its name and tooltip, and what it does. */
  dismiss: { label: string; onClick: () => void };
  below: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Notice
      label={label}
      {...(tone === undefined ? {} : { tone })}
      {...(shown === undefined ? {} : { shown })}
      action={
        <span className="banner-acts">
          <Button
            variant="quiet"
            size="sm"
            aria-label={open ? toggle.hideName : toggle.showName}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            <SameWidth shown={open ? "hide" : "show"} labels={{ show: toggle.show, hide: toggle.hide }} />
          </Button>
          <IconButton icon="close" label={dismiss.label} onClick={dismiss.onClick} />
        </span>
      }
      below={
        <div className={open ? "banner-below open" : "banner-below"} id={id} inert={!open}>
          <div>{below}</div>
        </div>
      }
    >
      {children}
    </Notice>
  );
}

/** A ring with the steps of the running round. No percentage: we do not know it. */
export function Ring({ value, of, label }: { value: number; of: number; label: string }) {
  const c = 100.5;
  return (
    <svg className="ring" viewBox="0 0 40 40" role="img" aria-label={label}>
      <circle className="bg" cx="20" cy="20" r="16" />
      <circle
        className="fg"
        cx="20"
        cy="20"
        r="16"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, value / of))}
      />
    </svg>
  );
}

/** @public Design-system component (list skeleton); no screen uses it yet. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["60%", "90%", "40%", "75%"];
  return (
    <Card className="sk-list">
      {Array.from({ length: rows }, (_, i) => (
        <span className="sk" key={widths[i % 4]} style={{ width: widths[i % 4] }} />
      ))}
    </Card>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="empty">
      <Eyes still large />
      <b>{title}</b>
      <span>{children}</span>
    </Card>
  );
}

/**
 * A status line no one sees (design-system.md "Visually hidden"): always there, so a screen reader hears what comes
 * into it, empty otherwise; one per place that announces (a refusal, a review starting).
 */
export function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p className="visually-hidden" role="status">
      {children}
    </p>
  );
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Eyes large />
    </div>
  );
}

/**
 * The session screen: shown alone once the service no longer knows the tab (design-system.md). The large still
 * eyes and one sentence, with the command to run as code inside it when there is one; a long command breaks only after
 * its path's separators and at its spaces (`CodePath`). Nothing to click: the next link is a new tab.
 */
export function Session({ words }: { words: string | WithCommand }) {
  return (
    <div className="session">
      <Eyes still large />
      <p>
        <Said words={words} max={IN_DISPLAY} />
      </p>
    </div>
  );
}

/**
 * A sentence, plain or with commands in it (design-system.md "Inline code"): a command short enough sits in it whole,
 * a step under the line's size (`CodePath`); one too long goes on its own line under the sentence said without it
 * (`saidParts`), a block broken only after its separators or at its spaces; a device code whole, in its own face
 * ("Device code"). Punctuation that follows a command (`, but`, `.`) sits against it.
 */
export function Said({ words, max }: { words: string | WithCommand; max?: number }) {
  if (typeof words === "string") return words;
  return (
    <span className="said">
      {saidParts(words, max).map((part, i) =>
        "text" in part ? (
          <Fragment key={i}>{part.text}</Fragment>
        ) : part.kind === "device-code" ? (
          <code key={i} className="device-code">
            {part.code}
          </code>
        ) : (
          <CodePath key={i} text={part.code} kind={part.kind} line={part.line} max={max} />
        ),
      )}
    </span>
  );
}

/**
 * Lines of code, numbered from `start`, the line `mark` marked; or one diff line, removed then added. Code keeps its
 * lines whole, scrolled sideways when one is too long; a `log`'s lines wrap under their text instead, clear of the
 * numbers (design-system.md "Code").
 */
export function Code({
  start,
  lines,
  mark,
  diff,
  log = false,
}: {
  start: number;
  lines: string[];
  mark?: number;
  diff?: { del: string; add: string };
  log?: boolean;
}) {
  return (
    <div className={log ? "code log" : "code"}>
      <pre>
        {diff ? (
          <>
            <span className="ln">{start}</span>
            <span className="del">- {diff.del.trimStart()}</span>
            {"\n"}
            <span className="ln">{start}</span>
            <span className="add">+ {diff.add.trimStart()}</span>
          </>
        ) : log ? (
          lines.map((line, i) => (
            <span key={start + i} className="line">
              <span className="ln">{start + i}</span>
              {line}
            </span>
          ))
        ) : (
          lines.map((line, i) => (
            <span key={start + i}>
              <span className="ln">{start + i}</span>
              {start + i === mark ? <span className="hl">{line}</span> : line}
              {"\n"}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}

/**
 * The log file's lines (the Logs page, ADR 0055): no numbers, since they come and go and a number would move with
 * them; each line's time in a column of its own, wider when it says the day, its words wrapping under its message
 * (round 4). A pull request is named once (ADR 0083, round 6): its run opens on a head naming it, over its lines'
 * words; a run about none has no head. The time's column is the run's: the day's wider one for the head and every
 * line when any line says the day, so a run across midnight keeps its words on one x.
 */
export function LogFile({ runs }: { runs: LogRun[] }) {
  return (
    <div className="code log file">
      <pre>
        {runs.map((run, r) => (
          // A run is its place: two may name the same pull request.
          <span key={r} className={run.day ? "run day" : "run"}>
            {run.pr === null ? null : <span className="head">{run.pr}</span>}
            {run.lines.map((line, i) => (
              // A line is its place: two may say the same.
              <span key={i} className="line">
                {line.time === null ? null : (
                  // The space after the time is inside its column, which is wider: copied, the line keeps it.
                  <span className="when">
                    {line.day === null ? `${line.time} ` : `${line.day} ${line.time} `}
                  </span>
                )}
                {line.words}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * The live log (ADR 0055): what the AI does while a round runs, newest line last, in a Code block eight lines tall
 * scrolled to the newest, its lines from the block's top. Each line as plain text, wrapping under its text, clear of
 * the AI's name; with none, `empty` in the same block, so it keeps its height.
 */
export function LiveLog({ lines, empty }: { lines: { who: string; text: string }[]; empty: string | null }) {
  return (
    <div className="code log live" role="log">
      <pre>
        {lines.length === 0 ? (
          <span className="cm">{empty}</span>
        ) : (
          lines.map((line, i) => (
            // A line is its place: two may say the same.
            <span key={i} className="line">
              <span className="who">{line.who}</span>
              {line.text}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}

export function SectionHead({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <p className="sec-h">
      {children}
      {count !== undefined ? <span className="n">{count}</span> : null}
    </p>
  );
}

/** A titled group of a page. `landing`: a link to a place in it opens the group itself (Settings' `openPlace`). */
export function Group({
  title,
  children,
  landing = false,
  fresh,
  shown,
}: {
  title: string;
  children: ReactNode;
  landing?: boolean;
  /** It came to the page by a change of the world (a section of Reviews with its first row): read once, as it mounts. */
  fresh?: boolean;
  /** In a list that keeps what leaves (`PresenceList`): whether it is leaving, and its mark. */
  shown?: Shown;
}) {
  const { leaving, enters: fades, props } = useEntry(fresh, shown);
  const motion = leaving ? " leaving" : fades ? " new" : "";
  return (
    <section className={`grp${motion}`} data-landing={landing || undefined} {...props}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/**
 * A settings row (design-system.md "Settings row"): title, help, the control on the right, and `extra`, the slot for
 * its one action under the help. `atTitle` aligns the control to the title instead of centring it: for a row whose
 * help changes length with the control, so the control stays under the pointer.
 */
export function SetRow({
  title,
  help,
  children,
  extra,
  atTitle = false,
}: {
  title: string;
  help: ReactNode;
  children: ReactNode;
  extra?: ReactNode;
  atTitle?: boolean;
}) {
  return (
    <div className={atTitle ? "setrow at-title" : "setrow"}>
      <div>
        <b>{title}</b>
        <span>{help}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

/**
 * Depth that opens in place. The chevron turns and the content slides open over 240 ms; nothing is native.
 * `row` draws it as a row whose summary says the key number. `defaultOpen` is read once, as it appears: what changes
 * after never opens or closes it, only the person does.
 */
export function Disclosure({
  summary,
  value,
  children,
  row = false,
  defaultOpen = false,
}: {
  summary: ReactNode;
  /** Row style only: the key number, shown while closed and open. */
  value?: ReactNode;
  children: ReactNode;
  row?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`disc ${row ? "disc-row" : ""} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="disc-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Icon name="next" />
        <span className="disc-k">{summary}</span>
        {value ? <span className="disc-v">{value}</span> : null}
      </button>
      <div className="disc-body" id={id} inert={!open}>
        <div>
          <div className="disc-in">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** An icon alone, for one well-known action next to the thing it acts on. Always with a tooltip that says it in words. */
export function IconButton({
  icon,
  label,
  onClick,
  end = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Its tooltip ends at its right edge (`Tip`'s `end`): for one near the screen's right edge. */
  end?: boolean;
}) {
  return (
    <span className={end ? "anchor tip-end" : "anchor"}>
      <button type="button" className="icon-btn" aria-label={label} onClick={onClick}>
        <Icon name={icon} />
      </button>
      <span className="tip" role="tooltip">
        {label}
      </span>
    </span>
  );
}

/**
 * "Saved", said quietly. Settings apply at once, so there is no toast per change: this shows the eyes while the
 * service has the change, then a check once it took it, and nothing when it refused it (the band and the toast
 * say why). Its place is reserved from the start, so nothing moves when it appears or goes.
 */
export function SaveState({ shown, text }: { shown: SaveShown; text: string }) {
  return (
    <span className={`save-state ${shown === "hidden" ? "hidden" : ""}`} aria-live="polite">
      {shown === "saving" ? <Eyes /> : <Icon name="check" />}
      {text}
    </span>
  );
}
