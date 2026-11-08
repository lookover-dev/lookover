// A notice whose list opens under it (design-system.md "Notice"): a quiet Show beside its ×, named by what it opens,
// as wide as Hide; what opens is the button's, out of Tab's way while closed.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeDisclosure } from "./basics.tsx";

const html = renderToStaticMarkup(
  <NoticeDisclosure
    label="Left"
    tone="mute"
    toggle={{
      show: "Show",
      hide: "Hide",
      showName: "Show the 2 repositories",
      hideName: "Hide the 2 repositories",
    }}
    dismiss={{ label: "Dismiss all", onClick: () => {} }}
    below={<ul className="departed-list" />}
  >
    2 repositories left the App's installation.
  </NoticeDisclosure>,
);

test("its toggle is named by the list it opens, and holds the other word's width (SameWidth)", () => {
  expect(html).toMatch(
    /<span class="banner-acts"><button type="button" class="btn btn-quiet btn-sm " aria-label="Show the 2 repositories" aria-expanded="false" aria-controls="[^"]+">/,
  );
  expect(html).toContain(
    '<span class="same-width"><span class="same-width-slot">Show</span><span class="same-width-slot" aria-hidden="true">Hide</span></span></button>',
  );
  expect(html).toContain('aria-label="Dismiss all"');
  expect(html).not.toContain("held-detail");
});

test("what opens is the button's, closed and inert until it is pressed", () => {
  const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
  expect(controls).toBeDefined();
  expect(html).toContain(
    `<div class="banner-below" id="${controls}" inert=""><div><ul class="departed-list"></ul>`,
  );
});
