// Accept as is on a finding's card (ADR 0100), in a real DOM: its popover says what it does, takes one optional line,
// and sends `finding.accept` with the reason typed, or with none; Back closes it and sends nothing. Its field has focus
// as it opens, Enter in it accepts, Escape closes it unsent; on a finding that doesn't need the person it is a ghost,
// before "Too noisy?".
//
// The DOM is `withDom`'s, this file's only; the screens are imported once it is there.
import { beforeAll, expect, test } from "bun:test";
import { type Command, changeId, findingId } from "@lookover/contracts";
import { withDom } from "../ui/dom.test-support.tsx";

type Support = typeof import("./review.test-support.tsx");

const dom = withDom();
let support: Support;

beforeAll(async () => {
  support = await import("./review.test-support.tsx");
});

const ID = changeId("sasensi/ledger-api#7");

/** The page on `found`, its commands kept in `sent`, each taken at once. */
async function render(found: ReturnType<Support["finding"]>, loop: "needs_owner" | "open" = "needs_owner") {
  const sent: Command[] = [];
  await dom.render(
    support.pageOf({ job: support.job("done"), loop, findings: [found], run: null }, ID, (command, took) => {
      sent.push(command);
      took?.();
    }),
  );
  return sent;
}

/** The page on an escalated F1 with a thread, Accept as is's popover open. */
async function open(): Promise<Command[]> {
  const sent = await render(support.finding("F1", "escalated", { severity: "blocking", commented: true }));
  const accept = button("Accept as is");
  // Escalated: a secondary on its card, the page's one way to settle it here.
  expect(accept.className).toContain("btn-secondary");
  await dom.act(() => accept.click());
  return sent;
}

function button(label: string): HTMLButtonElement {
  const found = [...dom.host().querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

const popover = () => dom.host().querySelector(".layer.pop:not(.leaving)");

function fieldIn(): HTMLInputElement {
  const found = dom.host().querySelector<HTMLInputElement>(".pop input");
  if (!found) throw new Error("No field");
  return found;
}

async function type(words: string) {
  const field = fieldIn();
  expect(field.maxLength).toBe(200);
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, words);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("the popover says what accepting does, and sends finding.accept with the reason typed", async () => {
  const sent = await open();
  expect(popover()?.querySelector("h4")?.textContent).toBe("Accept F1 as is");
  expect(popover()?.textContent).toContain("Lookover stops asking for a fix.");
  expect(popover()?.querySelector("label")?.textContent).toBe("Why, in one line");
  await type("Accepted deploy-window gap");
  await dom.act(() => button("Accept").click());
  expect(sent).toEqual([
    {
      type: "finding.accept",
      changeId: ID,
      findingId: findingId("F1"),
      reason: "Accepted deploy-window gap",
    },
  ]);
  expect(popover()).toBeNull();
});

test("nothing typed: finding.accept goes with no reason", async () => {
  const sent = await open();
  await dom.act(() => button("Accept").click());
  expect(sent).toEqual([{ type: "finding.accept", changeId: ID, findingId: findingId("F1") }]);
});

test("Back closes the popover and sends nothing", async () => {
  const sent = await open();
  await type("Not this one");
  await dom.act(() => button("Back").click());
  expect(popover()).toBeNull();
  expect(sent).toEqual([]);
});

test("the field has focus as the popover opens", async () => {
  await open();
  expect(document.activeElement).toBe(fieldIn());
});

test("Enter in the field accepts", async () => {
  const sent = await open();
  await type("Accepted deploy-window gap");
  // happy-dom has no implicit submission: as a browser does, Enter that nothing stopped submits the field's form.
  await dom.act(() => {
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    if (fieldIn().dispatchEvent(enter)) fieldIn().form?.requestSubmit();
  });
  expect(sent).toEqual([
    {
      type: "finding.accept",
      changeId: ID,
      findingId: findingId("F1"),
      reason: "Accepted deploy-window gap",
    },
  ]);
});

test("Escape closes the popover and sends nothing", async () => {
  const sent = await open();
  await type("Not this one");
  await dom.act(() =>
    fieldIn().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(popover()).toBeNull();
  expect(sent).toEqual([]);
});

test("on a counted finding that doesn't need the person, a ghost before Too noisy?", async () => {
  await render(support.finding("F2", "open", { commented: true }), "open");
  const accept = button("Accept as is");
  expect(accept.className).toContain("btn-ghost");
  const actions = [...(accept.closest(".finding")?.querySelectorAll("button") ?? [])].map(
    (b) => b.textContent,
  );
  expect(actions).toContain("Too noisy?");
  expect(actions.indexOf("Accept as is")).toBe(actions.indexOf("Too noisy?") - 1);
});
