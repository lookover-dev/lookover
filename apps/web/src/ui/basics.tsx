// The design system's simple components. Names and states follow docs/product/design-system.md.

import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import type { WithCommand } from "../view-model/format.ts";
import type { SaveShown } from "../view-model/save.ts";
import { ICON_TILE, LOADER, MARK } from "./eyes.generated.ts";

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
  variant?: "primary" | "secondary" | "ghost" | "danger";
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
 * One place for a button whose label changes with the state (design-system.md, Button: "keeps the width"): every
 * label it can take is laid out in the same cell, each under the state it stands for, and only the `shown` state's is
 * seen, so the place is as wide as the widest and nothing after it moves. The others are hidden, never focused nor
 * clicked.
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
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** Runs as the tab opens: what the app records of it. It may stop the tab (`preventDefault`) to open it later. */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  kbd?: string;
  children: ReactNode;
}) {
  const sizeClass = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "";
  return (
    <a
      className={`btn btn-${variant} ${sizeClass} ${className}`}
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
 * A secret given as a file and never shown (design-system.md, Key file input): "Choose a file", then the chosen
 * file's name, or `placeholder` before one is chosen. Hands the file over; reading it is the caller's.
 */
export function KeyFile({
  id,
  name,
  placeholder,
  accept,
  invalid = false,
  onChoose,
}: {
  id: string;
  /** The chosen file's name; null before one is chosen. */
  name: string | null;
  placeholder: string;
  accept: string;
  invalid?: boolean;
  onChoose: (file: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="input keyfile" aria-invalid={invalid || undefined}>
      <Button id={id} size="sm" onClick={() => ref.current?.click()}>
        Choose a file
      </Button>
      <span className={`kf-name ${name === null ? "none" : ""}`}>{name ?? placeholder}</span>
      <input
        ref={ref}
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onChoose(e.target.files?.[0] ?? null);
          // Cleared, so choosing the same file again (after fixing it on disk) still fires.
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** A value the owner copies into another program (design-system.md, Value to copy): the value, then a copy button. */
export function CopyLine({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <span className="copyline">
      <code>{value}</code>
      <IconButton icon="copy" label="Copy" onClick={onCopy} />
    </span>
  );
}

/** What a chip says about a status, in colour (design-system.md, Chip). */
export type Tone = "need" | "run" | "ok" | "warn" | "mute";

const CHIP_CLASS: Record<Tone, string> = {
  need: "c-need",
  run: "c-run",
  ok: "c-ok",
  warn: "c-warn",
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

/** A form field: label above, help below, or the error in its place (design-system.md, Input). */
export function Field({
  label,
  help,
  error,
  htmlFor,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {/* The error in the help's place, the help kept unseen under it: the field keeps its height (Input). */}
      {error && help ? (
        <span className="field-note">
          <span className="help" aria-hidden="true">
            {help}
          </span>
          <span className="err">{error}</span>
        </span>
      ) : error ? (
        <span className="err">{error}</span>
      ) : help ? (
        <span className="help">{help}</span>
      ) : null}
    </div>
  );
}

/** An input on the page ground (design-system.md, Input). */
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ""}`} />;
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
  /** Held where it is: dims, and the caller's tooltip says why (design-system.md, Switch). */
  disabled?: boolean;
}) {
  return (
    <label className="switch">
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

export function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
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
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          disabled={disabled}
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
}: {
  value: T;
  tabs: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
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

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
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
}: {
  lead: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  action?: ReactNode;
  onOpen?: () => void;
  fresh?: boolean;
  /** The lead is a status chip: it gets a fixed column so titles line up down the list. */
  status?: boolean;
  selected?: boolean;
}) {
  return (
    <div
      className={`rowi ${status ? "status" : ""} ${lead == null ? "nolead" : ""} ${fresh ? "new" : ""} ${onOpen ? "" : "static"}`}
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

/**
 * "Needs you": a surface card with a mono pink label and the still eyes. Buttons inside stay ordinary. A review
 * that waits says "Waiting" in amber, as the alert band does: pink is only for what needs you. What only informs (a
 * repository that left the installation) is `mute`: its label and eyes muted.
 */
export function Notice({
  label = "Needs you",
  tone = "need",
  children,
  action,
  busy,
}: {
  label?: string;
  tone?: "need" | "warn" | "mute";
  children: ReactNode;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div className={tone === "need" ? "banner" : `banner ${tone}`}>
      <Eyes still={!busy} />
      <span>
        <span className="lb">{label}</span>
        {children}
      </span>
      {action}
    </div>
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

export function PageLoading() {
  return (
    <div className="page-loading">
      <Eyes large />
    </div>
  );
}

/**
 * The session screen: shown alone once the service no longer knows the tab (design-system.md). The large still
 * eyes and one sentence, with the command to run as code inside it when there is one; a long path wraps inside its
 * code. Nothing to click: the next link is a new tab.
 */
export function Session({ words }: { words: string | WithCommand }) {
  return (
    <div className="session">
      <Eyes still large />
      <p>
        <Said words={words} />
      </p>
    </div>
  );
}

/**
 * A sentence, plain or with commands in it: each command shown as inline code (design-system.md "Inline code"), at
 * the size of the line it is in. Punctuation that follows a command (`, but`, `.`) sits against it.
 */
export function Said({ words }: { words: string | WithCommand }) {
  if (typeof words === "string") return words;
  const next = typeof words.after === "string" ? words.after : words.after.before;
  const gap = /^[,.:;]/.test(next) ? "" : " ";
  return (
    <span className="said">
      {words.before} <code>{words.command}</code>
      {gap}
      <Said words={words.after} />
    </span>
  );
}

/**
 * Lines of code, numbered from `start`, the line `mark` marked; or one diff line, removed then added. Without `start`,
 * the lines have no numbers: a log's lines come and go, and a number would move with them.
 */
export function Code({
  start,
  lines,
  mark,
  diff,
}: {
  start?: number;
  lines: string[];
  mark?: number;
  diff?: { del: string; add: string };
}) {
  return (
    <div className="code">
      <pre>
        {diff && start !== undefined ? (
          <>
            <span className="ln">{start}</span>
            <span className="del">- {diff.del.trimStart()}</span>
            {"\n"}
            <span className="ln">{start}</span>
            <span className="add">+ {diff.add.trimStart()}</span>
          </>
        ) : start === undefined ? (
          lines.map((line, i) => (
            // A line is its place: two may say the same.
            <span key={i}>
              {line}
              {"\n"}
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
 * The live log (ADR 0055): what the AI does while a round runs, newest line last, in a Code block eight lines tall
 * scrolled to the newest. Each line as plain text; with none, `empty` in the same block, so it keeps its height.
 */
export function LiveLog({ lines, empty }: { lines: { who: string; text: string }[]; empty: string | null }) {
  return (
    <div className="code live" role="log">
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

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grp">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

export function SetRow({
  title,
  help,
  children,
  extra,
}: {
  title: string;
  help: ReactNode;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="setrow">
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
 * `row` draws it as a row whose summary says the key number.
 */
export function Disclosure({
  summary,
  value,
  children,
  row = false,
}: {
  summary: ReactNode;
  /** Row style only: the key number, shown while closed and open. */
  value?: ReactNode;
  children: ReactNode;
  row?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
export function IconButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <span className="anchor">
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
