// Your coding agent's rows on the screen (design-system.md "Your coding agent"): a refused write is said on its row
// and announced once by the rows' one status line, which holds only that refusal; the rows themselves announce
// nothing, so a row done or undone is never read out.
import { expect, spyOn, test } from "bun:test";
import type { Command, LookoverApi } from "@lookover/contracts";
import { Refused } from "../api/http.ts";
import { Store } from "../store.tsx";
import { CodingAgent } from "./coding-agent.tsx";
import { app, screen, world } from "./repositories.test-support.tsx";

/** A store whose service refuses every command with `refused`. */
function refusing(refused: Refused): Store {
  const api: LookoverApi = {
    snapshot: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    send: () => Promise.reject(refused),
    logs: () => Promise.resolve([]),
    subscribeLogs: () => () => undefined,
  };
  return new Store(api);
}

const state = () => {
  const s = world();
  return {
    ...s,
    service: {
      ...s.service,
      agent: {
        ...s.service.agent,
        skills: [{ agent: "claude" as const, state: "none" as const, folder: "~/.claude" }],
      },
    },
  };
};

/** The rows as they render once `command` was refused with `refused`. */
async function rowsAfter(command: Command, refused: Refused): Promise<string> {
  const store = refusing(refused);
  const quiet = spyOn(console, "error").mockImplementation(() => undefined);
  await store.send(command);
  quiet.mockRestore();
  return screen(store, state(), () => <CodingAgent place="settings" />);
}

const STATUS = /<p class="visually-hidden" role="status">([^<]*)<\/p>/;

test("the rows announce nothing themselves: no live region around them", async () => {
  const html = await rowsAfter({ type: "agent.path", on: true }, new Refused(500, { error: "denied" }));
  expect(html).not.toContain("aria-live");
});

test("one status line per rows holds the refusal said on a row, and nothing else", async () => {
  const html = await rowsAfter({ type: "agent.path", on: true }, new Refused(500, { error: "denied" }));
  expect(html.match(new RegExp(STATUS, "g"))?.length).toBe(1);
  expect(STATUS.exec(html)?.[1]).toBe("This computer refused to change your PATH. Try again.");
  // Said on its row, in place of its detail, its square refused.
  expect(html).toContain(
    '<div class="engine substep agent-row current mark-refused"><span class="lg refused">',
  );
  expect(html).toContain(
    '<span class="substep-detail">This computer refused to change your PATH. Try again.</span>',
  );
});

test("with no refusal of the rows', the status line is there, empty", async () => {
  const other = await rowsAfter({ type: "agent.check" }, new Refused(500, {}));
  expect(STATUS.exec(other)?.[1]).toBe("");
  const none = screen(app(), state(), () => <CodingAgent place="setup" />);
  expect(STATUS.exec(none)?.[1]).toBe("");
});

/** Try it's card in `html`: from its class to the end of its last line. */
const tryItCard = (html: string) =>
  /<div class="card try-it">.*?try-next.*?<\/p><\/div>/.exec(html)?.[0] ?? "";

test("Try it is one form in setup and Settings: a card titled at the cards' title size, under the rows, no group head", () => {
  const setup = screen(app(), state(), () => <CodingAgent place="setup" />);
  const settings = screen(app(), state(), () => <CodingAgent place="settings" />);
  expect(tryItCard(setup)).toStartWith('<div class="card try-it"><h4 class="card-title">Try it</h4>');
  expect(tryItCard(settings)).toBe(tryItCard(setup));
  for (const html of [setup, settings]) {
    expect(html).not.toContain('class="grp"');
    expect(html.indexOf("try-it")).toBeGreaterThan(html.indexOf("agent-rows"));
  }
});

test("the installs are one card of rows, in setup and Settings alike (round 6)", () => {
  for (const place of ["setup", "settings"] as const) {
    const html = screen(app(), state(), () => <CodingAgent place={place} />);
    const card = html.slice(
      html.indexOf('<div class="card agent-rows">'),
      html.indexOf('<div class="card try-it">'),
    );
    expect(card).toStartWith('<div class="card agent-rows">');
    // Every row in it: the PATH's and the one skill's.
    expect(card.match(/<div class="engine substep agent-row /g)?.length).toBe(2);
  }
});

/** The agents' three rows on Windows: the PATH's folder and each skill's too long for a sentence. */
const windows = () => {
  const s = state();
  const skills = [
    {
      agent: "claude" as const,
      state: "none" as const,
      folder: "C:\\Users\\Your Name\\.claude\\skills\\lookover-review-loop",
    },
    {
      agent: "codex" as const,
      state: "none" as const,
      folder: "C:\\Users\\Your Name\\.agents\\skills\\lookover-review-loop",
    },
  ];
  const path = { reach: "no" as const, folder: "C:\\Users\\Your Name\\AppData\\Local\\Lookover\\bin" };
  return { ...s, service: { ...s.service, agent: { ...s.service.agent, path, skills } } };
};

/** Each agent row's markup, in order, its held copy apart: what is seen, and what only holds room. */
const agentRows = (html: string) =>
  html
    .split('<div class="engine substep agent-row')
    .slice(1)
    .map((row) => {
      const at = row.indexOf('<div class="agent-held"');
      return { seen: row.slice(0, at), held: row.slice(at) };
    });

test("the three rows share one layout: title, sentence, action, then the value on its line, the PATH row too", () => {
  for (const place of ["setup", "settings"] as const) {
    const rows = agentRows(screen(app(), windows(), () => <CodingAgent place={place} />));
    expect(rows.length).toBe(3);
    for (const [i, value] of ["Lookover\\bin", ".claude\\skills", ".agents\\skills"].entries()) {
      const { seen } = rows[i] ?? { seen: "" };
      // Square, title, sentence, action, line: in that order, each in its own place.
      const order = [
        '<span class="lg',
        "<b>",
        'class="substep-detail"',
        'class="agent-act"',
        'class="agent-line"',
      ];
      const at = order.map((piece) => seen.indexOf(piece));
      expect(at.every((n) => n >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      // The value is on its line, never in the sentence.
      const sentence = seen.slice(seen.indexOf("substep-detail"), seen.indexOf('class="agent-act"'));
      expect(sentence).not.toContain("<code");
      expect(seen.slice(seen.indexOf("agent-line"))).toMatch(/<code class="path line">/);
      expect(seen.slice(seen.indexOf("agent-line")).replace(/<[^>]*>/g, "")).toContain(value);
    }
  }
});

test("each row holds every other detail it can show, with its line, in a copy hidden from everyone, no button in it", () => {
  const rows = agentRows(screen(app(), windows(), () => <CodingAgent place="settings" />));
  for (const { held } of rows) {
    expect(held).toStartWith('<div class="agent-held" aria-hidden="true">');
    expect(held).not.toContain("<button");
    expect(held.match(/class="agent-held-one"/g)?.length).toBeGreaterThan(0);
  }
  // The skill row holds its done sentence with the same folder on its line.
  expect(rows[1]?.held).toContain("The review loop&#x27;s skill, which calls this Lookover, is in:");
});
