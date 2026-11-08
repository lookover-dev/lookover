// Chips and the busy status (design-system.md "Chip", "Button"): every chip is one construction, Waiting and To fix
// both amber, Waiting told apart by its ring dot (its class, `c-wait`); a review under way is said by a status line in
// its tone's colour, neither a chip nor a button.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CHIPS } from "../view-model/select.ts";
import { BusyStatus, Chip } from "./basics.tsx";

const html = (c: { tone: Parameters<typeof Chip>[0]["tone"]; label: string }) =>
  renderToStaticMarkup(<Chip tone={c.tone}>{c.label}</Chip>);

test("Waiting and To fix: the same amber, Waiting its own class for its ring dot", () => {
  expect(CHIPS.waiting.tone).toBe("wait");
  expect(CHIPS["to-fix"].tone).toBe("warn");
  expect(html(CHIPS.waiting)).toBe('<span class="chip c-wait">Waiting</span>');
  expect(html(CHIPS["to-fix"])).toBe('<span class="chip c-warn">To fix</span>');
});

test("the busy status is a status line in its tone's colour with the reading eyes, neither a chip nor a button", () => {
  for (const tone of ["run", "wait"] as const) {
    const out = renderToStaticMarkup(<BusyStatus tone={tone}>Reviewing…</BusyStatus>);
    expect(out.startsWith(`<span class="busy-status" data-tone="${tone}">`)).toBe(true);
    expect(out).not.toContain("chip");
    expect(out).not.toContain("btn");
    expect(out).toContain('class="eyes');
  }
});
