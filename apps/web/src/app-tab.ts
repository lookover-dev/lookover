// The tab "Create it on GitHub" opens (ADR 0059): opened at once, blank, while the click may still open one (a
// browser blocks a tab opened later, once the service answered), then sent to the page once the service took the place
// chosen, or closed when it refused. `open` is the browser's `window.open`.

/** A tab as this page holds it: where it is, the page that opened it, and closing it. */
interface Tab {
  opener: unknown;
  location: { href: string };
  close(): void;
}

/** The browser's `window.open`: the tab, or null when the browser blocked it. */
export type OpenTab = (url: string, target: string, features?: string) => Tab | null;

/** Opens the blank tab now; `sent` and `refused` are what the service's answer does with it. */
export function tabWhenTaken(open: OpenTab, page: string): { sent(): void; refused(): void } {
  const tab = open("", "_blank");
  if (tab) tab.opener = null;
  return {
    sent: () => {
      if (tab) tab.location.href = page;
      else open(page, "_blank", "noopener");
    },
    refused: () => tab?.close(),
  };
}
