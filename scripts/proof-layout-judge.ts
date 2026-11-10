// The layout pass's judge (ADR 0086), run in the page: `judgeScript` sends it as source, the class whole, so it closes
// over nothing of proof's. What it measures is said in scripts/proof-layout.ts.

/** What the page found: the measure, the element and its child described, how many px of room. */
export interface Failure {
  measure: "held" | "room";
  element: string;
  child: string;
  by: number;
  /** The index in `ALLOWANCES` of the allowance it falls under, or null. */
  allowedBy: number | null;
}

/** An allowance as the page reads it: its index, the element's selector, the child's. */
export type AllowedInPage = [number, string, string | null];

interface Extent {
  top: number;
  bottom: number;
}

/** A failure while judged: the element and the child holding its room, kept to tell lines apart. */
type Found = Failure & { el: Element; holder: Element };

/** Elements whose whole box is what they show: controls and replaced boxes. */
const CONTROL_TAGS = [
  "IMG",
  "SVG",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "BUTTON",
  "A",
  "LABEL",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "HR",
  "PROGRESS",
  "METER",
];
const CONTROL_ROLES = ["button", "switch", "tab", "checkbox", "radio", "link"];

class LayoutJudge {
  styles = new Map<Element, CSSStyleDeclaration>();
  fadedMemo = new Map<Element, boolean>();
  stretchedMemo = new Map<Element, boolean>();
  ruleList: CSSStyleRule[] | null = null;
  found: Found[] = [];
  scope: Element;
  allowed: AllowedInPage[];
  controlTags: string[];
  controlRoles: string[];

  constructor(scope: Element, allowed: AllowedInPage[], controlTags: string[], controlRoles: string[]) {
    this.scope = scope;
    this.allowed = allowed;
    this.controlTags = controlTags;
    this.controlRoles = controlRoles;
  }

  style(e: Element): CSSStyleDeclaration {
    let s = this.styles.get(e);
    if (s === undefined) {
      s = getComputedStyle(e);
      this.styles.set(e, s);
    }
    return s;
  }

  px(value: string): number {
    return Number.parseFloat(value) || 0;
  }

  isControl(e: Element): boolean {
    return (
      this.controlTags.includes(e.tagName.toUpperCase()) ||
      this.controlRoles.includes(e.getAttribute("role") ?? "")
    );
  }

  /** It or an ancestor at opacity 0. */
  faded(e: Element | null): boolean {
    if (e === null) return false;
    const known = this.fadedMemo.get(e);
    if (known !== undefined) return known;
    const is = this.style(e).opacity === "0" || this.faded(e.parentElement);
    this.fadedMemo.set(e, is);
    return is;
  }

  visible(e: Element): boolean {
    return this.style(e).visibility === "visible" && !this.faded(e);
  }

  /** Hidden itself, its parent shown: the top of a hidden copy. */
  hiddenTop(e: Element): boolean {
    const s = this.style(e);
    if (s.visibility === "visible" && s.opacity !== "0") return false;
    const parent = e.parentElement;
    return parent === null || (this.style(parent).visibility === "visible" && !this.faded(parent));
  }

  opaque(colour: string): boolean {
    return colour !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(colour);
  }

  /** Its box is drawn: a fill, a border or a shadow shows where it ends. */
  drawn(s: CSSStyleDeclaration): boolean {
    if (this.opaque(s.backgroundColor) || s.backgroundImage !== "none" || s.boxShadow !== "none") return true;
    return (["Top", "Right", "Bottom", "Left"] as const).some(
      (side) =>
        this.px(s[`border${side}Width`]) > 0 &&
        s[`border${side}Style`] !== "none" &&
        this.opaque(s[`border${side}Color`]),
    );
  }

  outOfFlow(e: Element): boolean {
    const { position, display } = this.style(e);
    return position === "absolute" || position === "fixed" || display === "none";
  }

  /** The box its layout is in: the parent, past any `display: contents`. */
  layoutParent(e: Element): Element | null {
    let p = e.parentElement;
    while (p !== null && this.style(p).display === "contents") p = p.parentElement;
    return p;
  }

  /** Its children as boxes: text nodes, and elements, past any `display: contents`. */
  childrenOf(e: Element): Node[] {
    return [...e.childNodes].flatMap((n) =>
      n instanceof Element && this.style(n).display === "contents" ? this.childrenOf(n) : [n],
    );
  }

  /** Its parent lays it out in a row that stretches it: a flex row, or a grid. */
  inStretchingRow(e: Element): boolean {
    const p = this.layoutParent(e);
    if (p === null) return false;
    const s = this.style(e);
    const ps = this.style(p);
    const align = s.alignSelf === "auto" ? ps.alignItems : s.alignSelf;
    if (align !== "normal" && align !== "stretch") return false;
    return (
      ps.display.includes("grid") || (ps.display.includes("flex") && !ps.flexDirection.startsWith("column"))
    );
  }

  /**
   * Its height comes from beside it: a table cell, or an item a flex row or a grid stretches to the end of a sibling's
   * content beside it, or to the end of a parent its own `min-height` holds (the app's frame). The taller of two
   * cards, the one no sibling's content reaches the end of, is as tall as itself, and judged.
   */
  stretched(e: Element): boolean {
    if (this.style(e).display === "table-cell") return true;
    const known = this.stretchedMemo.get(e);
    if (known !== undefined) return known;
    // While it is being judged, a sibling asking about it takes it as stretched: its own content, never its box.
    this.stretchedMemo.set(e, true);
    const is = this.stretchedNow(e);
    this.stretchedMemo.set(e, is);
    return is;
  }

  stretchedNow(e: Element): boolean {
    const p = this.layoutParent(e);
    if (p === null || !this.inStretchingRow(e)) return false;
    const r = e.getBoundingClientRect();
    if (this.px(this.style(p).minHeight) >= p.getBoundingClientRect().height - 1) return true;
    return this.childrenOf(p).some((n) => {
      if (!(n instanceof Element) || n === e || this.outOfFlow(n)) return false;
      const o = n.getBoundingClientRect();
      if (o.height === 0 || o.top >= r.bottom - 1 || o.bottom <= r.top + 1) return false;
      const reach = this.ownExtent(n);
      return reach !== null && reach.bottom + this.px(this.style(n).marginBottom) >= r.bottom - 1;
    });
  }

  /** What a box shows of itself, never its stretched box: a control whole, else its content inside its padding. */
  ownExtent(e: Element): Extent | null {
    const s = this.style(e);
    if (s.display === "none" || this.faded(e)) return null;
    const r = e.getBoundingClientRect();
    if (s.visibility === "visible" && this.isControl(e)) return { top: r.top, bottom: r.bottom };
    const content = this.contentOf(e);
    if (content === null) return null;
    return {
      top: content.top,
      bottom: content.bottom + this.px(s.paddingBottom) + this.px(s.borderBottomWidth),
    };
  }

  join(a: Extent | null, b: Extent | null): Extent | null {
    if (a === null) return b;
    if (b === null) return a;
    return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
  }

  /** A text node's lines, each to its line box: the text's box grown to the line height around its middle. */
  linesOf(text: Text): Extent | null {
    const parent = text.parentElement;
    if (parent === null || !this.visible(parent) || (text.textContent ?? "").trim() === "") return null;
    const { lineHeight } = this.style(parent);
    const range = document.createRange();
    range.selectNodeContents(text);
    let out: Extent | null = null;
    for (const r of range.getClientRects()) {
      if (r.width === 0 && r.height === 0) continue;
      const half = lineHeight === "normal" ? r.height / 2 : this.px(lineHeight) / 2;
      const middle = r.top + r.height / 2;
      out = this.join(out, { top: middle - half, bottom: middle + half });
    }
    return out;
  }

  /** A child's part of its parent's content: what it shows and its margins. */
  childExtent(n: Node, skip: Element | null): Extent | null {
    if (n instanceof Text) return this.linesOf(n);
    if (!(n instanceof Element) || n === skip || this.outOfFlow(n)) return null;
    const shown = this.shownOf(n);
    if (shown === null) return null;
    const s = this.style(n);
    return { top: shown.top - this.px(s.marginTop), bottom: shown.bottom + this.px(s.marginBottom) };
  }

  /** What a box's content shows, inside its padding: its text lines and the children it shows, cut where it clips. */
  contentOf(e: Element, skip: Element | null = null): Extent | null {
    let out: Extent | null = null;
    for (const n of this.childrenOf(e)) out = this.join(out, this.childExtent(n, skip));
    const s = this.style(e);
    if (out === null || (s.overflowY === "visible" && s.overflowX === "visible")) return out;
    const r = e.getBoundingClientRect();
    return {
      top: Math.max(out.top, r.top + this.px(s.borderTopWidth)),
      bottom: Math.min(out.bottom, r.bottom - this.px(s.borderBottomWidth)),
    };
  }

  /** Its whole box is what it shows: a control, or a drawn box no row stretches. */
  shownWhole(e: Element): boolean {
    const s = this.style(e);
    if (s.visibility !== "visible") return false;
    return this.isControl(e) || (this.drawn(s) && s.display !== "inline" && !this.stretched(e));
  }

  /** What a box shows, from its top to its bottom, or null: nothing hidden, nothing faded. */
  shownOf(e: Element): Extent | null {
    const s = this.style(e);
    if (s.display === "none" || this.faded(e)) return null;
    const r = e.getBoundingClientRect();
    if (this.shownWhole(e)) return { top: r.top, bottom: r.bottom };
    const content = this.contentOf(e);
    if (content === null || s.display === "inline") return content;
    // Its padding and border count once it shows anything: room the design gives, not room held.
    return {
      top: Math.max(r.top, content.top - this.px(s.paddingTop) - this.px(s.borderTopWidth)),
      bottom: Math.min(r.bottom, content.bottom + this.px(s.paddingBottom) + this.px(s.borderBottomWidth)),
    };
  }

  /** Where its content box starts and ends. */
  contentBox(e: Element): Extent {
    const s = this.style(e);
    const r = e.getBoundingClientRect();
    return {
      top: r.top + this.px(s.borderTopWidth) + this.px(s.paddingTop),
      bottom: r.bottom - this.px(s.borderBottomWidth) - this.px(s.paddingBottom),
    };
  }

  nameOf(e: Element): string {
    const classes = [...e.classList].slice(0, 3).map((c) => `.${c}`);
    return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${classes.join("")}`;
  }

  pathOf(e: Element): string {
    const names = [this.nameOf(e)];
    for (let p = e.parentElement; p !== null && p !== this.scope && names.length < 3; p = p.parentElement)
      names.unshift(this.nameOf(p));
    return names.join(" > ");
  }

  childOf(holder: Element, hidden: boolean): string {
    const text = (holder.textContent ?? "").replace(/\s+/g, " ").trim();
    const said = text === "" ? "" : ` "${text.length > 48 ? `${text.slice(0, 47)}…` : text}"`;
    return `${this.nameOf(holder)}${hidden ? " (hidden)" : ""}${said}`;
  }

  allowanceOf(element: Element, child: Element): number | null {
    const hit = this.allowed.find(([, el, ch]) => element.matches(el) && (ch === null || child.matches(ch)));
    return hit === undefined ? null : hit[0];
  }

  /**
   * Where a hidden copy's room ends, or null when it holds none: its margin box; one in a line (inline-level) that
   * starts below everything its cell shows sits on a line of its own, which its width put it on: it holds that line
   * whole, zero tall or not (a chip held at a title's end, wrapped under it). Zero tall otherwise, it holds nothing.
   */
  heldBottom(h: Element, cell: Element, shownBottom: number): number | null {
    const r = h.getBoundingClientRect();
    const s = this.style(h);
    const own = r.bottom + this.px(s.marginBottom);
    const top = r.top - this.px(s.marginTop);
    if (!s.display.startsWith("inline") || top < shownBottom - 1) return r.height === 0 ? null : own;
    const { lineHeight } = this.style(cell);
    return Math.max(own, top + (lineHeight === "normal" ? r.height : this.px(lineHeight)));
  }

  /** held: a hidden copy in flow, top of its kind, ending below all its cell shows, one line per cell. */
  held(h: Element): void {
    if (!this.hiddenTop(h) || this.outOfFlow(h)) return;
    const cell = this.layoutParent(h);
    if (cell === null) return;
    const box = this.contentBox(cell);
    const shownBottom = this.contentOf(cell, h)?.bottom ?? box.top;
    const bottom = this.heldBottom(h, cell, shownBottom);
    if (bottom === null) return;
    // Only the room the cell takes: a copy a clipping cell cuts (a folded disclosure's body) holds none.
    const by = Math.round(Math.min(bottom, box.bottom) - shownBottom);
    const known = this.found.find((f) => f.measure === "held" && f.el === cell);
    const line = { by, child: this.childOf(h, true), holder: h, allowedBy: this.allowanceOf(cell, h) };
    if (known !== undefined) {
      if (by > known.by) Object.assign(known, line);
    } else if (by > 1) this.found.push({ measure: "held", element: this.pathOf(cell), el: cell, ...line });
  }

  /** A row or a card, shown, not sized by a sibling nor scrolling: the boxes the room measure judges. */
  judged(e: Element): boolean {
    const s = this.style(e);
    if (!this.visible(e) || this.isControl(e) || s.display.startsWith("inline")) return false;
    if (s.overflowY === "auto" || s.overflowY === "scroll" || s.display === "table-cell") return false;
    const rowish = s.display === "table-row" || s.display === "list-item" || e.getAttribute("role") === "row";
    if (!rowish && !this.drawn(s) && this.px(s.minHeight) === 0) return false;
    // The app's frame fills the window whatever its page holds: room for the window, not held for a sentence.
    if (this.px(s.minHeight) >= window.innerHeight - 1) return false;
    return s.display === "table-row" || !this.stretched(e);
  }

  /** The lowest hidden copy in `x` that ends below `bottom`, or null. */
  lowestHidden(x: Element, bottom: number): Element | null {
    let holder: Element | null = null;
    let lowest = bottom + 1;
    for (const h of x.querySelectorAll("*")) {
      if (!this.hiddenTop(h) || this.outOfFlow(h)) continue;
      const hb = h.getBoundingClientRect().bottom;
      if (hb > lowest) {
        lowest = hb;
        holder = h;
      }
    }
    return holder;
  }

  /** The child of `at` that reaches its bottom past its own content: a box holding room of its own. */
  reachingChild(at: Element): Element | undefined {
    const atBottom = this.contentBox(at).bottom - 1;
    return this.childrenOf(at).find(
      (n): n is Element =>
        n instanceof Element &&
        !this.outOfFlow(n) &&
        n.getBoundingClientRect().bottom >= atBottom &&
        (this.contentOf(n)?.bottom ?? Number.NEGATIVE_INFINITY) < n.getBoundingClientRect().bottom - 1,
    );
  }

  /** What holds `x`'s room: the lowest hidden copy past what it shows, else the deepest box holding room, else it. */
  holderOf(x: Element, bottom: number): Element {
    const hidden = this.lowestHidden(x, bottom);
    if (hidden !== null) return hidden;
    let holder = x;
    for (let next = this.reachingChild(x); next !== undefined; next = this.reachingChild(next)) holder = next;
    return holder;
  }

  /** Every style rule of the page's sheets and adopted sheets, inside the media that apply now. */
  rules(): CSSStyleRule[] {
    if (this.ruleList !== null) return this.ruleList;
    const out: CSSStyleRule[] = [];
    const walk = (list: CSSRuleList) => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) out.push(rule);
        if (rule instanceof CSSMediaRule && !window.matchMedia(rule.media.mediaText).matches) continue;
        if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
      }
    };
    // The app's sheets are its own origin's: one it can't read throws, and the screen fails saying so.
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) walk(sheet.cssRules);
    this.ruleList = out;
    return out;
  }

  /**
   * Its height is the design's, not its content's: its cascaded height or least height is a length or a token (a bar's
   * height, a control's; a table row's, set on its cells), and no rule matching it counts that height in lines (`lh`,
   * `em`): content centred in such a box holds no room for anything. A box held to lines (`min-height: 2lh`), or as
   * tall as what's in it, is not.
   */
  heightByDesign(e: Element): boolean {
    if (this.style(e).display === "table-row")
      return [...e.children].some((cell) => this.heightByDesign(cell));
    const computed = e.computedStyleMap();
    const set = (p: string) => {
      const v = computed.get(p);
      return v instanceof CSSUnitValue && v.value > 0;
    };
    if (!set("height") && !set("min-height")) return false;
    const props = ["height", "min-height", "block-size", "min-block-size"];
    return !this.rules().some((rule) => {
      if (!props.some((p) => /\d(r?lh|r?em|ex|ch|cap)\b/.test(rule.style.getPropertyValue(p)))) return false;
      try {
        return e.matches(rule.selectorText);
      } catch {
        return false;
      }
    });
  }

  /**
   * room: a judged box whose content ends more than a pixel above its end; content centred in it (as much room above)
   * passes only in a box whose height is the design's (`heightByDesign`).
   */
  room(x: Element): void {
    if (!this.judged(x) || x.getBoundingClientRect().height === 0) return;
    const content = this.contentOf(x);
    if (content === null) return;
    const box = this.contentBox(x);
    const below = box.bottom - content.bottom;
    if (below <= 1) return;
    if (below <= content.top - box.top + 1 && this.heightByDesign(x)) return;
    const holder = this.holderOf(x, content.bottom);
    this.found.push({
      measure: "room",
      element: this.pathOf(x),
      child:
        holder === x
          ? "its own height"
          : this.childOf(holder, holder.closest('[aria-hidden="true"]') !== null),
      by: Math.round(below),
      allowedBy: this.allowanceOf(x, holder),
      el: x,
      holder,
    });
  }

  judge(): Failure[] {
    const all = [...this.scope.querySelectorAll("*")].filter((e) => this.style(e).display !== "none");
    for (const e of all) this.held(e);
    for (const e of all) this.room(e);
    // One line per room held: a box holding a row's room is named on the innermost row or card it fails, and a
    // hidden copy the held measure names is not named again by the room one.
    const outer = (f: Found) =>
      this.found.some(
        (g) =>
          g !== f &&
          g.holder === f.holder &&
          ((g.measure === f.measure && f.el !== g.el && f.el.contains(g.el)) ||
            (g.measure === "held" && f.measure === "room")),
      );
    return this.found
      .filter((f) => !outer(f))
      .map(({ measure, element, child, by, allowedBy }) => ({ measure, element, child, by, allowedBy }));
  }
}

/**
 * The page script that judges the page under `root` at scroll top, as `page.evaluate` takes it: an expression, so a
 * page under a CSP runs it too. It returns each failure of the two measures, marked with the allowance it falls under.
 */
export function judgeScript(root: string, allowed: AllowedInPage[]): string {
  const args = JSON.stringify([root, allowed, CONTROL_TAGS, CONTROL_ROLES]);
  return `(() => {
  ${LayoutJudge.toString()}
  const [root, allowed, tags, roles] = ${args};
  window.scrollTo(0, 0);
  const scope = document.querySelector(root);
  if (scope === null) throw new Error("No " + root + " on the page");
  return new LayoutJudge(scope, allowed, tags, roles).judge();
})()`;
}
