// A real DOM for the tests of one file that need a page to click in (error boundaries, a presence, a group folding):
// happy-dom registered before the file's tests and unregistered after, and a React root per test. bun runs every test
// file in one process, so a preload would hand every other file a DOM. react-dom's client is imported once the DOM is
// there; a module that reads the DOM as it loads (react-dom, the app) is imported by the test the same way, in a
// `beforeAll` of its own after `withDom()`.
//
// happy-dom builds no CSS motion and ignores `getAnimations`' `subtree` option, but `el.animate()` runs, with
// `finished` and `finish()`: `exiting` starts an exit on an element by hand, as the leaving class's would run on it,
// so a presence has something to wait on. What it started is cancelled after the test, so none outlives it. `entries`
// stands in for a CSS entry: an element that matches its selector runs an entry while it matches, as the stylesheet's
// rule would start one, cancelled when it stops matching and started afresh when it matches again.
import { afterAll, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

export interface Dom {
  /** Renders `node` in the test's root, a fresh one after `unmount`. */
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
  /** Runs `work` (a click, a search, an animation ended) as React's act, the page settled after it. */
  act: (work: () => void) => Promise<void>;
  /** The element the roots render in. */
  host: () => HTMLElement;
  /** An exit as long as a test needs, on `el` itself; cancelled after the test if it still runs. Throws if no `el`. */
  exiting: (el: Element | null | undefined) => Animation;
  /**
   * Every element matching `selector` runs an entry while it matches, read through `getAnimations` as the browser's
   * style would start it; until the test ends. Returns the entry `el` runs now; throws if it runs none.
   */
  entries: (selector: string) => (el: Element | null | undefined) => Animation;
}

/** Registers the DOM around the calling file's tests; its functions work inside them. */
export function withDom(): Dom {
  // Set by the `beforeAll`: the functions below read them when called, so they may be taken off `dom` before it runs.
  let act: typeof import("react").act;
  let createRoot: typeof import("react-dom/client").createRoot;
  let host: HTMLElement;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
  const started: Animation[] = [];
  const restores: (() => void)[] = [];
  beforeAll(async () => {
    GlobalRegistrator.register();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    act = (await import("react")).act;
    createRoot = (await import("react-dom/client")).createRoot;
    host = document.createElement("div");
    document.body.append(host);
  });
  // A test that failed before its own `unmount` leaves no page to the next.
  afterEach(async () => {
    for (const restore of restores.splice(0)) restore();
    for (const running of started.splice(0)) running.cancel();
    await dom.unmount();
  });
  afterAll(async () => {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await GlobalRegistrator.unregister();
  });
  const dom: Dom = {
    render: (node) =>
      act(async () => {
        root ??= createRoot(host);
        root.render(node);
      }),
    unmount: () =>
      act(async () => {
        root?.unmount();
        root = null;
      }),
    act: (work) =>
      act(async () => {
        work();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
    host: () => host,
    exiting: (el) => {
      if (!el) throw new Error("not in the page");
      const exit = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 60_000 });
      exit.finished.catch(() => undefined);
      started.push(exit);
      return exit;
    },
    entries: (selector) => {
      const own = new WeakMap<Element, Animation>();
      const original = Element.prototype.getAnimations;
      // What the style would run on `el` now: one entry from when it starts matching (ended or cancelled, it stays so)
      // until it stops; matching again starts another.
      const sync = (el: Element) => {
        const entry = own.get(el);
        if (!el.matches(selector)) {
          own.delete(el);
          if (entry?.playState === "running") entry.cancel();
        } else if (!entry) {
          const fresh = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 60_000 });
          fresh.finished.catch(() => undefined);
          started.push(fresh);
          own.set(el, fresh);
        }
      };
      Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
        sync(this);
        return original.call(this, options);
      };
      restores.push(() => {
        Element.prototype.getAnimations = original;
      });
      return (el) => {
        if (!el) throw new Error("not in the page");
        sync(el);
        const entry = own.get(el);
        if (entry?.playState !== "running") throw new Error("it runs no entry");
        return entry;
      };
    },
  };
  return dom;
}
