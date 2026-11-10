// Things that float: menu, popover, tooltip, dialog, toast, and the custom select.
import {
  type CSSProperties,
  createContext,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Eyes, Icon, type IconName } from "./basics.tsx";
import { Boundary } from "./boundary.tsx";
import { leavingProps, Presence, PresenceList, type Shown } from "./presence.tsx";

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input, [tabindex='0']")];
}

/** Arrow keys move between the items of a menu or a listbox. */
function arrowKeys(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = focusables(e.currentTarget);
  const active = document.activeElement;
  const i = active instanceof HTMLElement ? list.indexOf(active) : -1;
  const next = e.key === "ArrowDown" ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
  list[next]?.focus();
  e.preventDefault();
}

/** A layer closed by Esc or its scrim gives focus back to its trigger, the anchor's first button, never to the page. */
export function returnFocus(anchor: { querySelector(selector: "button"): { focus(): void } | null } | null) {
  anchor?.querySelector("button")?.focus();
}

/**
 * Focus moved out of the anchor, to `next` (a focusout's `relatedTarget`): a layer with a scrim closes, so Tab never
 * reaches the dimmed page. Focus going nowhere (a click on the layer's words, another window) keeps it open.
 */
export function focusLeaves<N>(anchor: { contains(node: N): boolean } | null, next: N | null): boolean {
  return next !== null && anchor !== null && !anchor.contains(next);
}

interface TriggerProps {
  "aria-expanded": boolean;
  onClick: () => void;
}

/**
 * A layer that opens from its anchor, rises 4 px, and closes on Esc or a click outside. `scrim`: the page under the top
 * bar dims while it is open, as under a dialog (the status menu, wide and over the alert band); a click on it closes the
 * layer and gives focus back to the trigger, as Esc does, and focus leaving the anchor (Tab) closes it.
 */
export function Layer({
  trigger,
  children,
  align = "left",
  className = "",
  width,
  scrim = false,
}: {
  trigger: (props: TriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  width?: number;
  scrim?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Each opening's own content: a menu reopened while it still leaves is the same panel, holding what it holds afresh
  // (a boundary that failed tries again, a menu's own state starts over).
  const [opens, setOpens] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // The panel, even one still leaving from its last close: reopened, it is the same element, and takes focus again.
    const panel = anchor.current?.querySelector<HTMLElement>(":scope > .layer");
    const first = panel ? focusables(panel)[0] : null;
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && anchor.current?.contains(e.target))) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      returnFocus(anchor.current);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const style: CSSProperties = {
    top: "calc(100% + 6px)",
    [align]: 0,
    minWidth: width,
    transformOrigin: `top ${align}`,
  };
  return (
    <div
      className="anchor"
      ref={anchor}
      onBlur={
        open && scrim
          ? (e) => {
              if (focusLeaves(anchor.current, e.relatedTarget)) setOpen(false);
            }
          : undefined
      }
    >
      {trigger({
        "aria-expanded": open,
        onClick: () => {
          if (!open) setOpens((n) => n + 1);
          setOpen(!open);
        },
      })}
      {/* Closed, it leaves through the presence: inert at once, the page live, gone when its fade ends. */}
      <Presence present={open}>
        {(shown) => (
          <>
            {scrim ? (
              <div
                {...leavingProps("scrim", shown)}
                aria-hidden="true"
                onMouseDown={(e) => {
                  // Keep the browser from moving focus to the page under it: it goes back to the trigger.
                  e.preventDefault();
                  setOpen(false);
                  returnFocus(anchor.current);
                }}
              />
            ) : null}
            <div {...leavingProps(`layer ${className}`, shown)} style={style} onKeyDown={arrowKeys}>
              <Fragment key={opens}>{children(() => setOpen(false))}</Fragment>
            </div>
          </>
        )}
      </Presence>
    </div>
  );
}

/**
 * A menu's item. With an `icon` it is drawn as an action (`.act`): the icon first, in a place of its own (`.act-ic`)
 * where the loader stands while it works (`busy`), so its words never move.
 */
export function MenuItem({
  children,
  onSelect,
  icon,
  busy,
  kbd,
  hint,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  icon?: IconName;
  busy?: boolean;
  kbd?: string;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={icon ? "act" : undefined}
      onClick={onSelect}
      disabled={disabled}
      style={danger ? { color: "var(--acc-text)" } : undefined}
    >
      {icon ? <span className="act-ic">{busy ? <Eyes /> : <Icon name={icon} />}</span> : null}
      {children}
      {kbd ? <span className="kbd">{kbd}</span> : hint ? <span className="r">{hint}</span> : null}
    </button>
  );
}

/** One line, after 400 ms on hover or focus. Never holds anything clickable. */
export function Tip({
  text,
  end = false,
  children,
}: {
  text: string;
  /** Ends at its anchor's right edge rather than centred on it: for an anchor near the screen's right edge. */
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={end ? "anchor tip-end" : "anchor"}>
      {children}
      <span className="tip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

/** One question, at most two buttons, the safe one on the left. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  // Closed, it leaves through the presence (ADR 0087): closed at once by its own close(), so the browser gives focus
  // back and the page is live, and kept with what it holds while its CSS fade runs; gone at once when none runs.
  return (
    <Presence present={open}>
      {({ leaving, mark }) => (
        <ModalDialog leaving={leaving} mark={mark} onClose={onClose} className={className}>
          {/* What it holds fails alone, inside it: the dialog still closes on Esc and its scrim, the page stays. */}
          <Boundary what="dialog">
            {title ? <h4>{title}</h4> : null}
            {children}
            {actions ? <div className="acts">{actions}</div> : null}
          </Boundary>
        </ModalDialog>
      )}
    </Presence>
  );
}

/** The native dialog, shown modal while present and closed by its own close() the moment it starts leaving. */
function ModalDialog({
  leaving,
  mark,
  onClose,
  className,
  children,
}: Shown & { onClose: () => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const markRef = mark.ref;
  const refs = useCallback(
    (el: HTMLDialogElement | null) => {
      ref.current = el;
      return markRef(el);
    },
    [markRef],
  );
  // Opened before the paint and before what it holds measures itself in its own layout effects (the palette's whole
  // rows): opened in a passive effect, the palette's list was measured hidden and kept a cut row. Closed here, before
  // the presence reads what runs: the fade starts with the close.
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!leaving && !d.open) d.showModal();
    if (leaving && d.open) d.close();
  }, [leaving]);
  return (
    <dialog
      {...leavingProps(`dlg ${className}`, { leaving, mark })}
      ref={refs}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "need";
  action?: { label: string; run: () => void };
}
type ToastInput = { text: string; tone?: "ok" | "need"; action?: { label: string; run: () => void } };

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastContext);

/** Says what just happened: one line, bottom right, 5 s, at most one action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  // Gone from the list at once; the presence keeps it on screen while its exit runs.
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, tone: "ok", ...toast }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        <PresenceList items={toasts} keyOf={(t) => t.id} exits>
          {(t, shown) => (
            <div {...leavingProps(`toast ${t.tone === "need" ? "need" : ""}`, shown)}>
              <i>
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {t.tone === "need" ? <path d="M6 2.5v4M6 9.2v.1" /> : <path d="M2.5 6.5l2.3 2.3L9.5 4" />}
                </svg>
              </i>
              <span>{t.text}</span>
              {t.action ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </Button>
              ) : null}
            </div>
          )}
        </PresenceList>
      </div>
    </ToastContext.Provider>
  );
}

export interface Option<T> {
  value: T;
  label: string;
  description?: string;
}

/** Never native: a button the height of an input and a listbox. Arrows move, Enter picks, Esc closes, typing jumps. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  width,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // The listbox, even one still leaving from its last close: reopened, it is the same element.
  const listbox = () => root.current?.querySelector<HTMLElement>(":scope > [role='listbox']") ?? null;
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    listbox()?.querySelector<HTMLElement>("[aria-selected='true']")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>("button")?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    } else if (open && /^[a-z]$/i.test(e.key)) {
      const list = listbox();
      const items = list ? focusables(list) : [];
      items.find((el) => el.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()))?.focus();
    }
  };

  return (
    <div className="sel" ref={root} style={{ width }} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="v">{current?.label}</span>
        <Icon name="chevron" />
      </button>
      <Presence present={open}>
        {(shown) => (
          <div {...leavingProps("layer", shown)} role="listbox" style={{ top: 40 }} onKeyDown={arrowKeys}>
            {options.map((o) => (
              <button
                type="button"
                role="option"
                key={o.value}
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
              >
                {o.label}
                {o.description ? <small>{o.description}</small> : null}
              </button>
            ))}
          </div>
        )}
      </Presence>
    </div>
  );
}
