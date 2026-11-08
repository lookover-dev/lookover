// Things that float: menu, popover, tooltip, dialog, toast, and the custom select.
import {
  type CSSProperties,
  createContext,
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
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = panel.current ? focusables(panel.current)[0] : null;
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
      {trigger({ "aria-expanded": open, onClick: () => setOpen((o) => !o) })}
      {open && scrim ? (
        <div
          className="scrim"
          aria-hidden="true"
          onMouseDown={(e) => {
            // Keep the browser from moving focus to the page under it: it goes back to the trigger.
            e.preventDefault();
            setOpen(false);
            returnFocus(anchor.current);
          }}
        />
      ) : null}
      {open ? (
        <div className={`layer ${className}`} ref={panel} style={style} onKeyDown={arrowKeys}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
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
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="anchor">
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
  const ref = useRef<HTMLDialogElement>(null);
  // open before the paint and before what it holds measures itself in its own layout effects (the palette's whole
  // rows): opened in a passive effect, the palette's list was measured hidden and kept a cut row
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      className={`dlg ${className}`}
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <>
          {title ? <h4>{title}</h4> : null}
          {children}
          {actions ? <div className="acts">{actions}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "need";
  action?: { label: string; run: () => void };
  out: boolean;
}
type ToastInput = { text: string; tone?: "ok" | "need"; action?: { label: string; run: () => void } };

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastContext);

/** Says what just happened: one line, bottom right, 5 s, at most one action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, out: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 220);
  }, []);
  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, tone: "ok", out: false, ...toast }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.tone === "need" ? "need" : ""} ${t.out ? "out" : ""}`} key={t.id}>
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
        ))}
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
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus();
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
      const items = list.current ? focusables(list.current) : [];
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
      {open ? (
        <div className="layer" role="listbox" ref={list} style={{ top: 40 }} onKeyDown={arrowKeys}>
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
      ) : null}
    </div>
  );
}
