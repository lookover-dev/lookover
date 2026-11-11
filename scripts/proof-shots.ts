// What `bun run proof` shoots (the harness is scripts/proof.ts): the app on the service in demo mode (ADR 0046),
// the scripted GitHub and engines, no network. Each shot names the world it needs: a scenario loaded
// (`demo.load`, the clock standing still at the fixed instant once its seed is played), the clock moved on
// (`demo.advance`), faults made to happen (`demo.inject`). Then the page opens, its act runs, and it is shot.
// Shots of the same world share one load; a shot whose act changes what the service holds (`alone`) gets a load
// of its own. Each shot lands on the screen its path routes to, or the one it names (`screen`): a shot that lands
// elsewhere (the session screen, the setup in place of the app, "No such pull request") fails.
import { API, type ConnectionCause, DEMO_API, type FaultId } from "@lookover/contracts";
import type { Page } from "playwright";
// Every line "Your accounts" can say, of which the page shows only the one its state picks: only the view model holds
// them all (a copy here would go stale without a word), and apps/web has no module entry (its `exports` are
// stylesheets), so this relative import is the one way to them (ADR 0086's `accountsLinesFit`).
import { ACCOUNTS_TEXT } from "../apps/web/src/view-model/sign-in.ts";
import { NARROW_PHONE, PHONE, WIDTHS } from "./proof-layout.ts";

/** What an act may ask of the demo, as the developer drawer would. */
export interface Demo {
  /** Moves the clock on, once every command the page sent has been answered. */
  advance(ms: number): Promise<void>;
  /** Makes a fault happen now, as the drawer does: one that needs what the act set up first. */
  inject(fault: FaultId): Promise<void>;
}

/** A screen to shoot: the world it needs, where it opens, and what to do on it first. */
export interface Shot {
  name: string;
  /** The scenario loaded, as the drawer lists it. */
  scenario: string;
  /** Milliseconds the clock moves on from the load before the page opens. */
  advance?: number;
  /** Faults made to happen once the clock moved, before the page opens. */
  inject?: FaultId[];
  /** Milliseconds the clock moves on once the faults happened, before the page opens. */
  afterFaults?: number;
  path?: string;
  /** A phone's width, 390 px; `narrow`, the narrowest phone a screen must fit, 375 px. */
  phone?: boolean | "narrow";
  /** A desktop window's width in px, 1180 by default: 1024 and 1440 show what a held width does (ADR 0086). */
  width?: number;
  drawer?: boolean;
  fullPage?: boolean;
  /** A tab without the session cookie, as one left open across a restart (the session screen). */
  noSession?: boolean;
  /** Its act changes what the service holds: shot on a load of its own, one theme at a time. */
  alone?: boolean;
  /**
   * The selector of the screen it must show: by default the screen its path routes to, the session screen
   * without a session.
   */
  screen?: string;
  act?: (page: Page, demo: Demo) => Promise<unknown>;
  /**
   * A frames shot (ADR 0087, scripts/proof-motion.ts): its act starts a motion, the page's timeline standing still
   * from just before it. proof pauses every animation, seeks each with `currentTime` to fixed times from 0 to the
   * motion's end, then finishes it and settles the page, shooting each, and lays the frames side by side into one
   * strip per theme, `.proof/frames/<name>-<theme>.png`: listed in the index, never compared by `--diff`. `around`:
   * the elements whose box of the whole motion every frame shows, the settled one too (ADR 0089): the union of their
   * box at each frame time, a margin round it, so a shrinking thing shrinks inside a fixed frame; the window when
   * absent. The reduced-motion pass replays its act under `reduce`, where nothing may start.
   */
  frames?: { around?: string };
  /**
   * The errors its page is made to log, each a pattern of a line proof reads ("console error: …", "page error: …"):
   * every one must match a line, and every line one of them. Any other error fails the shot (ADR 0085).
   */
  console?: readonly RegExp[];
}

/** The browser's line for an answer of `status` to a request at one of `paths`, proof naming the address after " at ". */
function failedLoad(status: number, ...paths: string[]): RegExp {
  const at = paths.map((path) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
  return new RegExp(
    `^console error: Failed to load resource: the server responded with a status of ${status} .* at https?://[^/]+(?:${at})$`,
  );
}

/** What a command the service refuses logs: the browser's line for the answer, then the app's (`store.tsx`). */
const REFUSED_COMMAND = [failedLoad(500, API.commands), /^console error: Lookover refused a command /];

/**
 * The app's routes (apps/web/src/app.tsx: proof-shots.test.ts keeps the two lists the same) and the screen each
 * shows, as its page marks itself (`data-screen`).
 * A page that found nothing ("No such pull request") carries no mark, and neither does Home in place of a path
 * the app doesn't route (it falls back to Home), so neither passes as the screen a shot asked for.
 */
export const ROUTES: [RegExp, string][] = [
  [/^\/$/, '[data-screen="home"]'],
  [/^\/reviews$/, '[data-screen="reviews"]'],
  [/^\/reviews\/[^/]+\/[^/]+\/\d+$/, '[data-screen="review"]'],
  [/^\/repositories$/, '[data-screen="repositories"]'],
  [/^\/repositories\/[^/]+\/[^/]+$/, '[data-screen="repository"]'],
  [/^\/settings$/, '[data-screen="settings"]'],
  [/^\/settings\/[^/]+$/, '[data-screen="settings-section"]'],
  [/^\/logs$/, '[data-screen="logs"]'],
  // Only a pull request GitHub holds has the page, not the strip shown for a number it doesn't know.
  [/^\/github\/[^/]+\/[^/]+\/\d+$/, ".gh .gh-page"],
];

/**
 * The screen a shot must land on: the one it names, the session screen, or the one its path routes to, a place on
 * the page (`/settings#github`) aside.
 */
export function screenOf(shot: Shot): string {
  if (shot.screen) return shot.screen;
  if (shot.noSession) return ".session";
  const path = (shot.path ?? "/").replace(/#.*/, "");
  const route = ROUTES.find(([pattern]) => pattern.test(path));
  if (!route) throw new Error(`${shot.name}: the app routes no screen at ${path}`);
  return route[1];
}

const SEC = 1_000;
const MIN = 60_000;
const button = (page: Page, name: string) => page.getByRole("button", { name }).first();
/**
 * Waits up to 5 s for every finite animation in the page to play out on its own (ADR 0087: shots run with motion on),
 * and fails naming those that didn't. An act that measures where things rest waits for it: a screen or a step coming
 * in rises 6 px while its entry plays. Unlike proof's settle, it finishes nothing: the act sees the motion end.
 */
async function entriesPlayed(page: Page) {
  const left = await page.evaluate(async (limit) => {
    const playing = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity);
    const ended = Promise.allSettled(playing.map((a) => a.finished)).then(() => []);
    const late = new Promise<string[]>((ok) =>
      setTimeout(() => {
        const names = playing
          .filter((a) => a.playState === "running" || a.playState === "paused")
          .map((a) => {
            if (a instanceof CSSAnimation) return `animation ${a.animationName}`;
            if (a instanceof CSSTransition) return `transition of ${a.transitionProperty}`;
            return a.id === "" ? "a script's animation" : `animation ${a.id}`;
          });
        ok(names);
      }, limit),
    );
    return Promise.race([ended, late]);
  }, 5 * SEC);
  if (left.length > 0) throw new Error(`Motion didn't play out within 5 s: ${left.join(", ")}`);
}
/** Repositories scrolled to its search and filter, a little under the top bar, the pointer off the table. */
async function reposBarAtTop(page: Page) {
  await page
    .getByRole("searchbox", { name: "Search repositories" })
    .evaluate((bar) => window.scrollTo(0, bar.getBoundingClientRect().top + window.scrollY - 120));
  await page.mouse.move(0, 0);
}
/** Opens fernhill's group on S18's Repositories, folded at first past ten (ADR 0083), from its chevron. */
async function openFernhill(page: Page) {
  await page.getByRole("button", { name: "fernhill's repositories", expanded: false }).click();
  await page.getByRole("button", { name: "fernhill's repositories", expanded: true }).waitFor();
}
/**
 * Fails unless `later`'s head, stuck, covers `earlier`'s stuck under it whole: a table cell sticks for the whole table,
 * so every head stuck at one line, a taller one under a shorter one shows from under it (Lookover's F5).
 */
async function headCovered(page: Page, earlier: string, later: string) {
  const cells = (account: string) =>
    page
      .locator("tr.repos-group:not(.repos-group-more)")
      .filter({ has: page.getByRole("button", { name: `${account}'s repositories` }) })
      .locator(":scope > *");
  const boxes = async (account: string) => {
    const all = await cells(account).evaluateAll((els) =>
      els.map((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        return { top, bottom };
      }),
    );
    if (all.length === 0) throw new Error(`${account}'s head isn't on the page`);
    return all;
  };
  const under = await boxes(earlier);
  const over = await boxes(later);
  const overTop = Math.min(...over.map((b) => b.top));
  const overBottom = Math.min(...over.map((b) => b.bottom));
  const underTop = Math.min(...under.map((b) => b.top));
  const underBottom = Math.max(...under.map((b) => b.bottom));
  if (Math.abs(overTop - underTop) > 0.5)
    throw new Error(
      `${later}'s head isn't stuck where ${earlier}'s is: at ${overTop}, ${earlier}'s at ${underTop}`,
    );
  if (underBottom > overBottom + 0.5)
    throw new Error(
      `${earlier}'s head shows from under ${later}'s: down to ${underBottom}, ${later}'s to ${overBottom}`,
    );
}
/** The shortest window `headToStuckLine` shortens to: below it a shot shows a head and little else. */
const SHORTEST = 400;
/**
 * Scrolls Repositories so `account`'s head comes up to the line heads stick at, its rows under it, every earlier head
 * stuck under it there.
 *
 * This changes the window's height. When the page ends too soon under `account`'s head, no scroll brings that head up
 * to the stuck line, so the window is first made shorter by exactly what the page lacks (S18's phone page under the
 * Reviewing filter lacks 60 px at 560, so 500; S20's, 8 repositories, about 390 at 820, so about 430). On a window as
 * tall as the shot's first one, a person can't reach this state at all: the shot shows it on the tallest window that
 * can. It hides no failure: no rule here reads the window's height (the `100vh` floors only grow a page shorter than
 * the window), and `headCovered` after it still throws when the head didn't reach the stuck line. A window under
 * `SHORTEST` throws instead of making a shot of almost nothing.
 */
async function headToStuckLine(page: Page, account: string) {
  const group = page
    .locator("tbody")
    .filter({ has: page.getByRole("button", { name: `${account}'s repositories` }) });
  const lacks = await group.evaluate((g) => {
    const cell = g.querySelector("tr > :is(th, td)");
    if (cell === null) throw new Error("a group with no head");
    const stuckAt = Number.parseFloat(getComputedStyle(cell).top);
    const by = g.getBoundingClientRect().top - stuckAt;
    const room = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    return Math.max(0, Math.ceil(by - room));
  });
  const size = page.viewportSize();
  if (size === null) throw new Error("no viewport");
  if (size.height - lacks < SHORTEST)
    throw new Error(
      `${account}'s head can't reach the stuck line: the page lacks ${lacks} px, a window under ${SHORTEST} px tall`,
    );
  if (lacks > 0) await page.setViewportSize({ width: size.width, height: size.height - lacks });
  await group.evaluate((g) => {
    const cell = g.querySelector("tr > :is(th, td)");
    if (cell === null) throw new Error("a group with no head");
    window.scrollBy({
      top: g.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(cell).top),
      behavior: "instant",
    });
  });
  await page.mouse.move(0, 0);
}
/** Opens Details › Log on a review page: its history, then the live log (ADR 0055). */
const openLog = (page: Page) => page.getByRole("button", { name: /^Log/ }).first().click();
/** A link that opens a page in a new tab: "Create it on GitHub" (ADR 0053). */
const link = (page: Page, name: string) => page.getByRole("link", { name }).first();

/**
 * Settings' Start at login switched off while another Lookover holds it (ADR 0068): its help says so, and "Start this
 * one instead" goes with the switch on. The input is hidden under its track: the click lands on the track, as the
 * person's does.
 */
async function switchLoginOffWhileTaken(page: Page) {
  const login = loginSwitch(page);
  await centre(login);
  const before = await login.boundingBox();
  await login.click();
  await page.getByText("Off: after you log in,", { exact: false }).waitFor();
  await button(page, "Start this one instead").waitFor({ state: "detached" });
  // The switch stays under the pointer (rule 5): the shot fails when flipping it moved it.
  const after = await login.boundingBox();
  if (before?.x !== after?.x || before?.y !== after?.y)
    throw new Error(
      `Start at login's switch moved: from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
    );
}

/**
 * Every line "Your accounts" can say (`ACCOUNTS_TEXT`), laid out in its place at 390 and 375 px: each fails unless it
 * keeps to one line and leaves the list's action places where they were, so the buttons under it stay under the
 * pointer whichever state the step is in (ADR 0086: the line holds no height). The page's own words are put back.
 */
async function accountsLinesFit(page: Page) {
  const desktop = page.viewportSize();
  if (desktop === null) throw new Error("The page has no viewport size");
  // Your accounts is the sub-step holding the accounts list.
  const detail = page.locator(".substep:has(.account-row) > .substep-detail");
  const lines = Object.values(ACCOUNTS_TEXT);
  for (const width of [PHONE, NARROW_PHONE]) {
    await page.setViewportSize({ width, height: desktop.height });
    await entriesPlayed(page);
    const wrong = await detail.evaluate((e, lines) => {
      const text = e.firstChild;
      if (e.childNodes.length !== 1 || text?.nodeType !== Node.TEXT_NODE)
        return ["Your accounts' detail is not one line of text"];
      const own = text.nodeValue;
      const lineHeight = Number.parseFloat(getComputedStyle(e).lineHeight);
      const places = () =>
        JSON.stringify(
          [...document.querySelectorAll(".account-actions")].map((a) => {
            const r = a.getBoundingClientRect();
            return [r.x, r.y + window.scrollY, r.width, r.height];
          }),
        );
      const at = places();
      const said: string[] = [];
      for (const line of lines) {
        text.nodeValue = line;
        const { height } = e.getBoundingClientRect();
        if (height > lineHeight * 1.5)
          said.push(`"${line}" takes ${height} px, more than a line of ${lineHeight}`);
        else if (places() !== at) said.push(`"${line}" moved the list's action places`);
      }
      text.nodeValue = own;
      return said;
    }, lines);
    if (wrong.length > 0) throw new Error(`At ${width} px: ${wrong.join("; ")}`);
  }
  await page.setViewportSize(desktop);
}

/**
 * "Don't start at login" pressed on setup's last step: the line it changes is under the footer, so the footer's
 * buttons keep their boxes, at the desktop width and at 375 px (ADR 0086), and the line says the new choice.
 */
async function startAtLoginStays(page: Page) {
  const desktop = page.viewportSize();
  if (desktop === null) throw new Error("The page has no viewport size");
  const places = page.locator(".setup-acts, .setup-acts > *");
  const boxes = async () => {
    const at: string[] = [];
    for (const width of [desktop.width, NARROW_PHONE]) {
      await page.setViewportSize({ width, height: desktop.height });
      await entriesPlayed(page);
      // On the page, not the window: the click scrolls the button into view.
      at.push(
        JSON.stringify(
          await places.evaluateAll((all) =>
            all.map((e) => {
              const r = e.getBoundingClientRect();
              return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
            }),
          ),
        ),
      );
    }
    await page.setViewportSize(desktop);
    return at;
  };
  const before = await boxes();
  await button(page, "Don't start at login").click();
  await button(page, "Start at login after all").waitFor();
  await page.locator(".at-login-line").getByText("won't start at login", { exact: false }).waitFor();
  const after = await boxes();
  if (before.join() !== after.join())
    throw new Error(`The last step's footer moved: from ${before.join(" ")} to ${after.join(" ")}`);
}

/**
 * Clicks Add to my PATH, waits for `landed`, and fails when the PATH row's state square moved or changed size, or its
 * action place moved sideways or changed width, at the desktop width and at 375 px (#642): both sit on the title's line,
 * so the button stays under the pointer whichever sentence, and line, follows. The place holds width,
 * never height (ADR 0086): with no button left it is as tall as nothing, so its height and its top are not compared.
 * Unless the click is `refused` (a problem arriving, said alone on the row, may take its line), it also fails when,
 * at the desktop width, anything under the row moved: the skill rows' buttons the pointer goes to next, and the end of
 * Try it, which the setup's footer and Settings' next section sit under (ADR 0086: the PATH row keeps its shape, Try
 * it changes its command's words, never its lines).
 */
async function addToPathStays(page: Page, landed: () => Promise<void>, { refused = false } = {}) {
  const below = async () => {
    const ys = await page.evaluate(() => {
      const top = document.querySelector(".coding-agent")?.getBoundingClientRect().top ?? 0;
      return [
        ...document.querySelectorAll(".agent-row ~ .agent-row > .agent-act, .coding-agent > .try-it"),
      ].map((e) => Math.round(e.getBoundingClientRect().bottom - top));
    });
    // A skill row's action and Try it at least, or the check compares nothing.
    if (ys.length < 2)
      throw new Error(`Found ${ys.length} of a skill row's action and Try it under the PATH row`);
    return ys.join(",");
  };
  const under = await below();
  const row = page.locator(".agent-row").filter({ hasText: "in your terminal" });
  const places = row.locator(":scope > .lg, :scope > .agent-act");
  const desktop = page.viewportSize();
  if (desktop === null) throw new Error("The page has no viewport size");
  const boxes = async () => {
    const at: string[] = [];
    for (const width of [desktop.width, NARROW_PHONE]) {
      await page.setViewportSize({ width, height: desktop.height });
      await entriesPlayed(page);
      at.push(
        JSON.stringify(
          await places.evaluateAll((all) =>
            all.map((e) => {
              const r = e.getBoundingClientRect();
              const top = e.closest(".agent-row")?.getBoundingClientRect().top ?? 0;
              const held = e.classList.contains("agent-act") ? {} : { y: r.y - top, height: r.height };
              return { x: r.x, width: r.width, ...held };
            }),
          ),
        ),
      );
    }
    await page.setViewportSize(desktop);
    return at;
  };
  const before = await boxes();
  await button(page, "Add to my PATH").click();
  await landed();
  const after = await boxes();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(`The PATH row's square or action moved: from ${before.join(" ")} to ${after.join(" ")}`);
  const now = await below();
  if (!refused && now !== under)
    throw new Error(
      `Add to my PATH moved what is under its row: the buttons and Try it's end from ${under} to ${now}`,
    );
}

/**
 * Fails unless the palette's list ends under a whole row (design-system.md "Command palette", round 6): the last row
 * that starts inside the list's box ends at or above its bottom edge, its padding under it, so the edge cuts no row.
 */
async function paletteShowsWholeRows(page: Page) {
  const list = page.locator(".cmdk .menu");
  await list.waitFor();
  // At rest: the dialog's entry scales it while it plays, and the rule is the palette's resting edge.
  await entriesPlayed(page);
  const cut = await list.evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    const bottom =
      box.top +
      menu.clientTop +
      menu.clientHeight -
      (Number.parseFloat(getComputedStyle(menu).paddingBottom) || 0);
    const seen = [...menu.children].filter((row) => row.getBoundingClientRect().top < bottom);
    const last = seen.at(-1)?.getBoundingClientRect();
    return last && last.bottom > bottom + 0.5 ? { row: last.bottom, edge: bottom } : null;
  });
  if (cut)
    throw new Error(
      `The palette's edge cuts its last row: the row ends at ${cut.row}, the list at ${cut.edge}`,
    );
}

/** Settings' Start at login switch: its track, which the person clicks. */
const loginSwitch = (page: Page) =>
  page.locator("label.switch").filter({ has: page.getByLabel("Start at login", { exact: true }) });

/** Scrolls `target` to the middle of the screen: shots of one row, on and off, show it at the same place. */
const centre = (target: ReturnType<Page["locator"]>) =>
  target.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));

/** Sign in again from the band, signed out of the shared App (ADR 0066): its code shows there once GitHub gave one. */
async function signInAgain(page: Page) {
  await button(page, "Sign in again").click();
  await link(page, "Copy code and open GitHub").waitFor();
}

/**
 * "Ask to install on ledger-hq" in the accounts list (ADR 0067): GitHub's fake install page opens on its picker,
 * ledger-hq's Request there, the ask is kept beside it, and the row waits for an owner of ledger-hq. The tab is closed:
 * a Request records nothing.
 */
async function askToInstallOnLedgerHq(page: Page) {
  const [tab] = await Promise.all([
    page.waitForEvent("popup"),
    link(page, "Ask to install on ledger-hq").click(),
  ]);
  await tab.getByRole("link", { name: "Request" }).waitFor();
  await tab.close();
  // The row holds its line as said on a later day too, hidden: the one shown.
  await page
    .locator(".account-row", { hasText: "ledger-hq" })
    .getByText("Waiting for an owner,", { exact: false })
    .filter({ visible: true })
    .waitFor();
}

/**
 * Install on ledger-labs pressed (S16, S17: an organisation the person owns, without the App): GitHub's fake page
 * opens in a tab, where Install is clicked or not (`install`), and the tab is closed. The look the link started runs
 * (ADR 0088), the clock standing still until the act moves it.
 */
async function installOnLedgerLabs(page: Page, install: boolean) {
  const [tab] = await Promise.all([page.waitForEvent("popup"), link(page, "Install on ledger-labs").click()]);
  // GitHub's page first asks where, the person having other accounts: ledger-labs, then its own page.
  await tab
    .locator("li", { hasText: "ledger-labs" })
    .getByRole("link", { name: "Install", exact: true })
    .click();
  const press = tab.getByRole("button", { name: "Install" });
  await press.waitFor();
  if (install) {
    await press.click();
    await tab.getByText("Installed on", { exact: false }).waitFor();
  }
  await tab.close();
}

/**
 * Repositories' Add a repository pressed (S16): GitHub's fake page for the person's own installation opens in a tab,
 * closed with nothing changed there. The look the link started runs (ADR 0088).
 */
async function addARepository(page: Page) {
  const [tab] = await Promise.all([page.waitForEvent("popup"), link(page, "Add a repository").click()]);
  await tab.waitForLoadState();
  await tab.close();
}

/** Fails if Check again's box changed between `before` and `after`, as `what` happened. */
function checkAgainStayed(what: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(`Check again moved ${what}: ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
}

/**
 * The look line's words, whichever place says them: Settings › GitHub's line, or setup's Your accounts line, which
 * says them in its own detail.
 */
const lookWords = (page: Page) =>
  page.locator(".look-line-said, .substep:has(.account-row) > .substep-detail");

/**
 * The look running, its listing at once answered: the demo clock moved one look's step (4 s), the line saying it
 * looks every few seconds and when it last did, to the second, in the place it said the state before. Fails if Check
 * again moved as the look began.
 */
async function looksForLedgerLabs(page: Page, demo: { advance: (ms: number) => Promise<void> }) {
  const again = page.getByRole("button", { name: "Check again" });
  const before = await again.boundingBox();
  await installOnLedgerLabs(page, false);
  await demo.advance(4 * SEC);
  await lookWords(page).getByText("Looking every few seconds, last at", { exact: false }).waitFor();
  await lookWords(page).locator(".clock-s").waitFor();
  const after = await again.boundingBox();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      `Check again moved as the look began: ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
    );
}

/**
 * ledger-labs installed on GitHub's fake page, then the demo clock moved in the look's 4 s steps until the line says
 * it arrived (a minute at most): the look found it, no drawer's Reconnect.
 */
async function ledgerLabsArrives(page: Page, demo: { advance: (ms: number) => Promise<void> }) {
  await installOnLedgerLabs(page, true);
  const arrived = lookWords(page).getByText("ledger-labs arrived:", { exact: false });
  for (let step = 0; step < 15 && !(await arrived.isVisible()); step++) await demo.advance(4 * SEC);
  await arrived.waitFor();
  await entriesPlayed(page);
}

/**
 * The person back from GitHub's page without installing: the demo clock moved past the look's 3-minute bound in its
 * 4 s steps, and the line says nothing new and that Lookover keeps checking. Fails if Check again moved between the
 * look running and its end: aligned to the words' first line, it stays put however the words wrap.
 */
async function nothingNewForLedgerLabs(page: Page, demo: { advance: (ms: number) => Promise<void> }) {
  const again = page.getByRole("button", { name: "Check again" });
  await installOnLedgerLabs(page, false);
  await demo.advance(4 * SEC);
  await lookWords(page).getByText("Looking every few seconds", { exact: false }).waitFor();
  await entriesPlayed(page);
  const looking = await again.boundingBox();
  for (let step = 0; step < 46; step++) await demo.advance(4 * SEC);
  await lookWords(page).getByText("every 2 minutes", { exact: false }).waitFor();
  await lookWords(page).getByText("Nothing new yet.", { exact: false }).waitFor();
  await entriesPlayed(page);
  const nothing = await again.boundingBox();
  if (JSON.stringify(looking) !== JSON.stringify(nothing))
    throw new Error(
      `Check again moved between looking and nothing new: ${JSON.stringify(looking)} to ${JSON.stringify(nothing)}`,
    );
}

/**
 * The band's Install on sasensi, the App uninstalled everywhere: GitHub's install page opens in a tab, closed again,
 * and the look its link started runs (ADR 0088), the clock standing still: "Looking…" in the fix's place. Fails if
 * the fix's place or the line's words moved, or the fix still shows.
 */
async function bandLooks(page: Page) {
  const line = page.locator(".alert", { hasText: "no longer installed" });
  const place = line.locator(".same-width");
  const words = line.locator(".alert-text");
  await place.waitFor();
  await entriesPlayed(page);
  const before = { place: await place.boundingBox(), words: await words.boundingBox() };
  const [tab] = await Promise.all([page.waitForEvent("popup"), link(page, "Install on sasensi").click()]);
  await tab.getByText("Where do you want to install it?").waitFor();
  await tab.close();
  await line.locator(".busy-status", { hasText: "Looking…" }).waitFor();
  await page.mouse.move(0, 0);
  await entriesPlayed(page);
  const after = { place: await place.boundingBox(), words: await words.boundingBox() };
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error(`The band's line moved as its look began: ${JSON.stringify({ before, after })}`);
  if (await line.getByRole("link", { name: "Install on sasensi" }).isVisible())
    throw new Error("The band still shows Install on sasensi while its look runs");
}

/**
 * The status menu's Install on sasensi, the App uninstalled everywhere: the menu opened on its fix, GitHub's install
 * page opened from it and closed again, and the menu open again on "Looking…" in the fix's place (ADR 0088), the
 * clock standing still. Fails if the fix's place moved, or the fix still shows.
 */
async function menuLooks(page: Page) {
  const pill = button(page, "GitHub App uninstalled");
  const menu = page.locator(".menu");
  const place = menu.locator(".st-fix .same-width");
  await pill.click();
  await place.waitFor();
  await entriesPlayed(page);
  const before = await place.boundingBox();
  const [tab] = await Promise.all([
    page.waitForEvent("popup"),
    menu.getByRole("link", { name: "Install on sasensi" }).click(),
  ]);
  await tab.getByText("Where do you want to install it?").waitFor();
  await tab.close();
  // The link may close the menu as its tab opens: open it again where it was.
  if (!(await menu.isVisible())) await pill.click();
  await menu.locator(".st-fix .busy-status", { hasText: "Looking…" }).waitFor();
  await page.mouse.move(0, 0);
  await entriesPlayed(page);
  const after = await place.boundingBox();
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error(`The menu's fix moved as its look began: ${JSON.stringify({ before, after })}`);
  if (await menu.getByRole("link", { name: "Install on sasensi" }).isVisible())
    throw new Error("The menu still shows Install on sasensi while its look runs");
}

/** Waits for the page's scroll to come to rest: a smooth scroll the app started is shot where it ends. */
async function scrollAtRest(page: Page) {
  let last = Number.NaN;
  for (let i = 0; i < 50; i++) {
    const y = await page.evaluate(
      () => new Promise<number>((done) => setTimeout(() => done(window.scrollY), 100)),
    );
    if (y === last) return;
    last = y;
  }
  throw new Error("The page's scroll never came to rest");
}

/**
 * Fails unless the section `#id` opened has landed: its label at the top bar's line (`--h-top` + `--s-5`, the group's
 * scroll margin, to the pixel), and what is above it ending at or above the top bar's bottom, nothing of it showing
 * under the bar. A window taller than the page below the section can't scroll its label that far up; the proof's
 * windows aren't.
 */
async function landedUnderTopBar(page: Page, id: string) {
  const over = await page.evaluate((id) => {
    const section = document.getElementById(id)?.closest("[data-landing]");
    const above = section?.previousElementSibling;
    const label = section?.querySelector(":scope > h4");
    if (!above || !label) return `#${id} is in no section opened by link, or nothing is above it`;
    const token = (name: string) =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    const bar = token("--h-top");
    const line = bar + token("--s-5");
    const top = label.getBoundingClientRect().top;
    if (Math.abs(top - line) > 1) return `#${id}'s label is ${top - line} px off the top bar's line`;
    const bottom = above.getBoundingClientRect().bottom;
    return bottom > bar + 0.5 ? `what is above #${id} ends ${bottom - bar} px under the top bar` : null;
  }, id);
  if (over) throw new Error(over);
}

/**
 * Settings › GitHub on the shared App, opened by link (`/settings#github`) as the app scrolls to it, its label under
 * the top bar: who is signed in, the list, once it names ledger-hq (`gh` is read right after the start).
 */
const toSharedGitHub = async (page: Page) => {
  await page.locator(".accounts-list").getByText("ledger-hq", { exact: true }).waitFor();
  await scrollAtRest(page);
  await landedUnderTopBar(page, "github");
};

/** S20's and S21's organisation as long as a GitHub login can be (39 characters), which asks for SSO. */
const LONGEST = "northwind-platform-infrastructure-group";
/** S20's and S21's meridian pull request title, in Chinese (`s20-real-names.ts`'s `CLAIMS_TITLE`). */
const CLAIMS_TITLE = "记录每笔被拒绝理赔的原因，并在月度报表中按原因汇总";
/** S20's other organisation, long-named, with no problem: its group comes after northwind's. */
const MERIDIAN = "meridian-health-analytics";

/** Settings › GitHub on S20, opened by link as `toSharedGitHub` does, once the list names the longest login. */
const toNamesGitHub = async (page: Page) => {
  await page.locator(".accounts-list").getByText(LONGEST, { exact: true }).waitFor();
  await scrollAtRest(page);
  await landedUnderTopBar(page, "github");
};

/**
 * Settings › Your coding agent, opened by link (`/settings#agent`) as the app scrolls to it, its label under the top
 * bar, once every account of GitHub's list above it is read (the owner's says how many repositories, none still
 * "Reading its repositories…"), so it grows no more by its reads.
 */
const toAgent = async (page: Page) => {
  await page
    .locator(".accounts-list .account-row")
    .first()
    .locator(".account-detail")
    .getByText(/\d+ repositor/)
    .waitFor();
  await page.locator('.accounts-list .account-row[data-state="reading"]').waitFor({ state: "detached" });
  await scrollAtRest(page);
  await landedUnderTopBar(page, "agent");
};

/**
 * Presses Everyone on Home or All reviews (ADR 0078), then waits for a teammate's row: the list it adds is up. The
 * pointer leaves the tab, so the shot shows it at rest.
 */
const toEveryone = async (page: Page) => {
  await page
    .getByRole("tablist", { name: "Whose pull requests" })
    .getByRole("tab", { name: /^Everyone/ })
    .click();
  await page.getByText("Link the testing guide from CONTRIBUTING").first().waitFor();
  await page.mouse.move(0, 0);
};

/** "Too noisy?" on the finding card whose title holds `title`. */
const tooNoisy = (page: Page, title: string) =>
  page.locator(".card.finding", { hasText: title }).getByRole("button", { name: "Too noisy?" });

/** S1 from Codex signed out to both AIs ready: Codex signed in; the step says so and waits for Continue (ADR 0058). */
async function setupUntilBothReady(page: Page, demo: Demo) {
  await button(page, "Sign in from a terminal").click();
  // The scripted Codex is signed in 5 s on.
  await demo.advance(5 * SEC);
  // Both ready, Continue names no AI: nothing beside it says so, the cards do (round 6).
  const goOn = page.getByRole("button", { name: "Continue", exact: true });
  await goOn.waitFor();
  // The step used to move on by itself 1.4 s later, on the page's own timer: wait past it and see it still here.
  await page.waitForTimeout(2 * SEC);
  if (!(await goOn.isVisible()) || !(await page.getByText("Which AI reviews your code?").isVisible()))
    throw new Error("The AI step moved on by itself: setup waits for Continue (ADR 0058).");
  // The exact "Continue" is the label once both are ready; it must be one the person can click.
  if (!(await goOn.isEnabled())) throw new Error("The AI step's Continue is disabled with both AIs ready.");
}

/** S1 on to the GitHub step: both AIs ready, then Continue; the step is Sign in with GitHub (ADR 0066, ADR 0073). */
async function setupUntilGitHub(page: Page, demo: Demo) {
  await setupUntilBothReady(page, demo);
  await button(page, "Continue").click();
  await button(page, "Sign in with GitHub").waitFor();
}

/** S1's Sign in with GitHub asked: the code GitHub's fake gave, with Copy code and open GitHub. */
async function setupUntilCode(page: Page, demo: Demo) {
  await setupUntilGitHub(page, demo);
  await button(page, "Sign in with GitHub").click();
  await link(page, "Copy code and open GitHub").waitFor();
}

/**
 * S1 until the GitHub step is done: the code entered on GitHub's fake, the sign-in kept 5 s on, then the install's next
 * check (4 s) finds the accounts; the step waits for Continue (ADR 0058).
 */
async function setupUntilSignedIn(page: Page, demo: Demo) {
  await setupUntilCode(page, demo);
  await demo.inject("sign-in-entered");
  await demo.advance(5 * SEC);
  await page.locator(".substep.done").first().waitFor();
  await demo.advance(4 * SEC);
  await page.getByText("GitHub is connected.").waitFor();
}

/**
 * S1 set up to the end through the sign-in (ADR 0066, ADR 0073): signed in, ledger-api kept, #148 reviewed, then Home.
 */
async function setUpSignedIn(page: Page, demo: Demo) {
  await setupUntilAgent(page, demo);
  await button(page, "Go to my reviews").click();
  await page.locator('[data-screen="home"]').waitFor();
}

/** S1 on to the repositories step: the GitHub step done, then Continue. */
async function setupUntilRepositories(page: Page, demo: Demo) {
  await setupUntilSignedIn(page, demo);
  await button(page, "Continue").click();
  await page.getByText("Pick the repositories to review.").waitFor();
}

/** S1 on to Your coding agent (ADR 0058): ledger-api kept, #148 reviewed and posted, then Continue. */
async function setupUntilAgent(page: Page, demo: Demo) {
  await setupUntilRepositories(page, demo);
  await button(page, "Continue").click();
  await button(page, "Review this pull request").click();
  await demo.advance(5 * MIN);
  await button(page, "Continue").click();
  await page.getByText("Let your coding agent run the loop.").waitFor();
}

/** Each way the connection can't be used (ADR 0053), as the drawer makes it happen, and the pill it shows. */
interface CauseShot {
  /** The shots' names: `home-<name>` and `status-pill-<name>`. */
  name: string;
  pill: string;
  scenario: string;
  advance?: number;
  inject?: FaultId[];
}

/** By the cause's kind, so a new cause can't go without its shots. */
const CAUSES = {
  // S13 a minute on: GitHub out of reach.
  unreachable: [{ name: "github-down", pill: "GitHub unreachable", scenario: "S13", advance: MIN }],
  uninstalled: [
    // The shared App uninstalled from every account the sign-in reaches (ADR 0067): the connection itself down.
    { name: "app-uninstalled", pill: "GitHub App uninstalled", scenario: "S16", inject: ["app-uninstalled"] },
    // The shared App suspended on the person's own account: theirs to unsuspend, ledger-dev going on.
    { name: "app-suspended", pill: "App suspended on sasensi", scenario: "S16", inject: ["app-suspended"] },
    // An owner of ledger-dev suspends the shared App there (ADR 0067): the pill names the account, the connection up.
    {
      name: "organisation-suspended",
      pill: "App suspended on ledger-dev",
      scenario: "S16",
      inject: ["organisation-suspended"],
    },
  ],
  // Signed out of the shared App (ADR 0066): S16 signed in on two accounts, GitHub no longer renewing the sign-in.
  "signed-out": [
    { name: "signed-out", pill: "GitHub signed out", scenario: "S16", inject: ["github-signed-out"] },
  ],
  // ledger-dev asking for SSO (ADR 0066): its account's cause on the shared App, the connection still up.
  sso: [{ name: "sso", pill: "ledger-dev needs SSO", scenario: "S16", inject: ["sso-asked"] }],
} satisfies Record<ConnectionCause["kind"], CauseShot[]>;

/**
 * S2 with Codex at its limit from the load, resetting two days on (the drawer's `codex-limit`, ADR 0055): #148,
 * opened twenty seconds on and found by Codex, waits for the reset.
 */
const CODEX_AT_LIMIT = {
  scenario: "S2",
  inject: ["codex-limit"],
  afterFaults: 30 * SEC,
} satisfies Partial<Shot>;

// S14, the planted sandbox's #1 (ADR 0044): round 1 found by Claude and double-checked by Codex, the fix pushed,
// round 2; #2 closed; reviews paused with #1 asked again; a newer Codex failing its self-test. Its stages, from
// the load: round 1 under way (0), round 1 posted (2 min), the fix pushed (3), round 2 posted (5), #2 closed (6),
// paused (8).
const PLANTED = "/reviews/sasensi/lookover-sandbox/1";
const PLANTED_GITHUB = "/github/sasensi/lookover-sandbox/1";
const ROUND_1 = 2 * MIN;
const PUSHED = 3 * MIN;
const ROUND_2 = 5 * MIN;
const CLOSED = 6 * MIN;
const PAUSED = 8 * MIN;

const LISTED: Shot[] = [
  // Home
  { name: "home-needs-you", scenario: "S12" },
  // The narrowest phone: a running row's meta line wraps, its dot going down with the running time.
  { name: "home-needs-you-phone", scenario: "S12", phone: "narrow" },
  // S10's day on Mine; Everyone adds teammates' pull requests nobody asked about, in Not reviewed (ADR 0078).
  { name: "home-quiet", scenario: "S10" },
  { name: "home-everyone", scenario: "S10", act: toEveryone },
  // S18's Home with four of fernhill's repositories off (ADR 0084): Mine, then Everyone, whose tabs count 3 and 20,
  // none of the off repositories' five pull requests listed.
  { name: "home-org", scenario: "S18", path: "/" },
  // S20's real-looking names (ADR 0086): the person's two pull requests, one on an organisation's long-named repository.
  { name: "home-names", scenario: "S20", path: "/" },
  {
    name: "home-org-everyone",
    scenario: "S18",
    path: "/",
    fullPage: true,
    act: async (p) => {
      await p
        .getByRole("tablist", { name: "Whose pull requests" })
        .getByRole("tab", { name: /^Everyone/ })
        .click();
      await p.getByText("Paginate the audit log").waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // GitHub's rate limit, as the service's poll shows it (ADR 0043): a warning with nothing to do.
  { name: "home-github-limit", scenario: "S10", inject: ["github-limit"] },
  // An AI at its limit until a day that isn't today: the band, then the status menu (ADR 0055).
  { name: "home-engine-limit", ...CODEX_AT_LIMIT },
  {
    name: "status-pill-engine-limit",
    ...CODEX_AT_LIMIT,
    act: (p) => button(p, "Codex at its limit").click(),
  },
  { name: "home-waiting-engine", scenario: "S3", advance: 2 * MIN },
  // GitHub out of reach, the App suspended on an account, signed out, SSO asked: the band with its one fix, then the
  // status menu.
  ...Object.values(CAUSES).flatMap((shots: CauseShot[]) =>
    shots.flatMap(({ name, pill, ...world }): Shot[] => [
      { name: `home-${name}`, ...world, act: (p) => button(p, pill).waitFor() },
      { name: `status-pill-${name}`, ...world, act: (p) => button(p, pill).click() },
    ]),
  ),
  // The App uninstalled everywhere, the band's Install on sasensi clicked (ADR 0088): its look runs, "Looking…" in
  // the fix's place, nothing on the line moved; then the status menu's own Install on sasensi, the same.
  {
    name: "home-app-uninstalled-looking",
    scenario: "S16",
    inject: ["app-uninstalled"],
    alone: true,
    act: bandLooks,
  },
  {
    name: "status-pill-app-uninstalled-looking",
    scenario: "S16",
    inject: ["app-uninstalled"],
    alone: true,
    act: menuLooks,
  },
  // Both AIs missing too: each with its one fix.
  { name: "home-service-problems", scenario: "S13", advance: 7 * MIN },
  { name: "home-paused-waiting", scenario: "S8", advance: 3 * MIN },
  { name: "home-skipped", scenario: "S5", advance: 2 * MIN },
  { name: "status-pill", scenario: "S12", act: (p) => button(p, "Claude needs attention").click() },
  // On a phone the scrim covers the bottom tab bar too: only the top bar stays bright (design-system.md, Elevation).
  {
    name: "status-pill-phone",
    scenario: "S12",
    phone: true,
    act: (p) => button(p, "Claude needs attention").click(),
  },
  {
    name: "status-pill-checks",
    scenario: "S10",
    alone: true,
    act: async (p, demo) => {
      await button(p, "All good").click();
      await button(p, "Run all checks").click();
      await demo.advance(2 * SEC);
    },
  },
  // Start at login chosen, but the computer refused it at the restart (ADR 0054): the alert band and Home say it needs
  // you, the pill names it, and the service's line warns, with "Open Settings".
  { name: "home-login-refused", scenario: "S10", inject: ["login-refused"] },
  {
    name: "status-pill-login-refused",
    scenario: "S10",
    inject: ["login-refused"],
    act: (p) => button(p, "Start at login refused").click(),
  },
  // Another Lookover holds start at login (ADR 0068): no band, the pill all good; its menu says so and names the
  // command the computer runs at login.
  {
    name: "status-pill-login-taken",
    scenario: "S10",
    inject: ["login-taken"],
    act: (p) => button(p, "All good").click(),
  },
  // A Codex version that failed Lookover's self-test (ADR 0044): the banner, then the status menu.
  { name: "home-failed-self-test", scenario: "S10", inject: ["codex-failed-self-test"] },
  {
    name: "status-pill-failed-self-test",
    scenario: "S10",
    inject: ["codex-failed-self-test"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  // A newer Codex whose safety check couldn't finish twice (ADR 0075): the need line with Try again, in the band,
  // then the status menu.
  { name: "home-self-test-unfinished", scenario: "S10", inject: ["codex-self-test-unfinished"] },
  {
    name: "status-pill-self-test-unfinished",
    scenario: "S10",
    inject: ["codex-self-test-unfinished"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  // A Codex too old for its model: the status menu says so, with the command that updates it, and "Check again".
  {
    name: "status-pill-codex-too-old",
    scenario: "S10",
    inject: ["codex-too-old"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  {
    name: "palette",
    scenario: "S12",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await paletteShowsWholeRows(p);
    },
  },
  {
    name: "palette-search",
    scenario: "S12",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.keyboard.type("re");
      await paletteShowsWholeRows(p);
    },
  },
  { name: "shortcuts", scenario: "S12", act: (p) => p.keyboard.press("?") },
  // Signed in to the shared App on two accounts (ADR 0066): a #151 on each account's ledger-api, both reviewed.
  { name: "home-two-accounts", scenario: "S16" },
  { name: "review-other-account", scenario: "S16", path: "/reviews/ledger-dev/ledger-api/151" },
  { name: "repositories-two-accounts", scenario: "S16", path: "/repositories" },
  // Repositories' foot (ADR 0088): Add a repository opened GitHub's page, and the foot's look line says Lookover
  // looks every few seconds; then a repository added there arrives, said in the line and in a toast.
  {
    name: "repositories-look-looking",
    scenario: "S16",
    path: "/repositories",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      const again = p.getByRole("button", { name: "Check again" });
      const before = await again.boundingBox();
      await addARepository(p);
      await demo.advance(4 * SEC);
      await lookWords(p).getByText("Looking every few seconds, last at", { exact: false }).waitFor();
      checkAgainStayed("as the look began", before, await again.boundingBox());
    },
  },
  {
    name: "repositories-look-arrived",
    scenario: "S16",
    path: "/repositories",
    fullPage: true,
    alone: true,
    // The new repository's row is added to the table above the foot, which moves down with it: the line's own place
    // is checked while the look runs (above).
    act: async (p, demo) => {
      await addARepository(p);
      await demo.advance(4 * SEC);
      await lookWords(p).getByText("Looking every few seconds", { exact: false }).waitFor();
      await demo.inject("repository-added");
      await lookWords(p).getByText("1 repository arrived.", { exact: true }).waitFor();
      await p.locator(".toast", { hasText: "1 repository arrived." }).waitFor();
      await entriesPlayed(p);
    },
  },
  // An owner of ledger-dev suspends the App there (ADR 0067): its group's head says who, with its fix, on a phone too.
  {
    name: "repositories-organisation-suspended",
    scenario: "S16",
    path: "/repositories",
    inject: ["organisation-suspended"],
  },
  {
    name: "repositories-organisation-suspended-phone",
    scenario: "S16",
    path: "/repositories",
    inject: ["organisation-suspended"],
    phone: true,
  },
  // A repository of the second account: its crumb names the account.
  { name: "repository-other-account", scenario: "S16", path: "/repositories/ledger-dev/ledger-api" },
  // Several problems at once: the App suspended on ledger-dev and Codex signed out, each its own line in the menu.
  {
    name: "status-pill-several",
    scenario: "S16",
    inject: ["organisation-suspended", "codex-signed-out"],
    act: (p) => button(p, "2 things need attention").click(),
  },
  // Signed out, then Sign in again from the band: its code in the band, and in the status menu's GitHub line. Each
  // alone: the sign-in it asks for stays on the service, and a second one would be refused.
  {
    name: "home-signed-out-code",
    scenario: "S16",
    inject: ["github-signed-out"],
    alone: true,
    act: signInAgain,
  },
  {
    name: "status-pill-signed-out-code",
    scenario: "S16",
    inject: ["github-signed-out"],
    alone: true,
    act: async (p) => {
      await signInAgain(p);
      await button(p, "GitHub signed out").click();
    },
  },
  // A review
  {
    name: "review-to-fix",
    scenario: "S4",
    path: "/reviews/sasensi/ledger-api/149",
    advance: 4 * MIN,
    fullPage: true,
  },
  // The agent answered the blocking finding "won't fix": round 2 kept it, its reply on the card (ADR 0052).
  {
    name: "review-kept",
    scenario: "S4",
    path: "/reviews/sasensi/ledger-api/149",
    advance: 8 * MIN,
    fullPage: true,
  },
  // Answered "won't fix" again, round 3 kept it a second time: escalated, it needs the owner.
  {
    name: "review-escalated",
    scenario: "S4",
    path: "/reviews/sasensi/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
  },
  // On the finding that follows a rule: every choice, "This finding is wrong" first (ADR 0049, ADR 0052).
  {
    name: "review-too-noisy",
    scenario: "S7",
    path: "/reviews/sasensi/ledger-api/148",
    act: (p) => tooNoisy(p, "The page size is not capped").click(),
  },
  {
    name: "review-too-noisy-wrong",
    scenario: "S7",
    path: "/reviews/sasensi/ledger-api/148",
    act: async (p) => {
      await tooNoisy(p, "The page size is not capped").click();
      await p.getByRole("button", { name: /This finding is wrong/ }).click();
    },
  },
  {
    name: "review-done-tab",
    scenario: "S2",
    path: "/reviews/sasensi/ledger-api/148",
    advance: 7 * MIN,
    act: (p) => p.getByRole("tab", { name: /Done/ }).click(),
  },
  // GitHub's limit meets round 1 of #148 while Codex finds: once the round posts, its step says the outbox and the
  // wait (ADR 0055), in the two lines it holds.
  {
    name: "review-posting-wait",
    scenario: "S2",
    path: "/reviews/sasensi/ledger-api/148",
    advance: MIN,
    inject: ["github-limit"],
    act: (_p, demo) => demo.advance(3 * MIN),
  },
  // The posting step saying the longest it can (`postingText`'s two-digit counts and a day named, run.test.ts): no
  // demo world waits on GitHub into another day with fourteen posts owed, so the waiting step's words are set to it.
  // Measured at 1024 and 1440 px: one line there, the step's row as tall as every other (ADR 0086).
  {
    name: "review-posting-longest",
    scenario: "S2",
    path: "/reviews/sasensi/ledger-api/148",
    advance: MIN,
    inject: ["github-limit"],
    // The clock moved on before the page opens, so its shots (three widths, two themes, the layout pass) don't move
    // it again, each, past GitHub's wait.
    afterFaults: 3 * MIN,
    act: async (p) => {
      const words = p.locator(".steplist .two-lines > span").getByText("GitHub asked to wait");
      await words.waitFor();
      await words.evaluate((span) => {
        span.textContent = "Posted 12 of 14. GitHub didn't answer, trying again on Wed 14 Oct at 14:05.";
      });
    },
  },
  // The same on a phone: the longest outbox still holds its two lines.
  {
    name: "phone-review-posting-wait",
    scenario: "S2",
    phone: true,
    path: "/reviews/sasensi/ledger-api/148",
    advance: MIN,
    inject: ["github-limit"],
    act: (_p, demo) => demo.advance(3 * MIN),
  },
  { name: "review-running", scenario: "S3", path: "/reviews/sasensi/ledger-api/151" },
  // Details › Log open while Claude reads (ADR 0055): the live log under the review's history, newest last.
  {
    name: "review-running-log",
    scenario: "S3",
    path: "/reviews/sasensi/ledger-api/151",
    fullPage: true,
    act: openLog,
  },
  {
    name: "phone-review-running-log",
    scenario: "S3",
    phone: true,
    path: "/reviews/sasensi/ledger-api/151",
    // Scrolled to the live log: a phone's full page would draw the tab bar over the middle of it.
    act: async (p) => {
      await openLog(p);
      await p.getByRole("log").first().scrollIntoViewIfNeeded();
    },
  },
  {
    name: "review-details-open",
    scenario: "S4",
    path: "/reviews/sasensi/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
    act: async (p) => {
      await button(p, "Rounds").click();
      await button(p, "How this review ran").click();
    },
  },
  { name: "review-waiting-limit", path: "/reviews/sasensi/ledger-api/148", ...CODEX_AT_LIMIT },
  {
    name: "review-waiting-engine",
    scenario: "S3",
    path: "/reviews/sasensi/ledger-api/151",
    advance: 2 * MIN,
  },
  { name: "review-paused-review-again", scenario: "S8", path: "/reviews/sasensi/lookover-sandbox/160" },
  // Resumed, #162 waits its turn and says behind what: both AIs on #161 (ADR 0055).
  {
    name: "review-waiting-turn",
    scenario: "S8",
    path: "/reviews/sasensi/lookover-sandbox/162",
    advance: 3 * MIN,
    alone: true,
    act: async (p) => {
      await button(p, "Resume reviews").click();
      await p.getByText("This one starts after it.").waitFor();
    },
  },
  {
    name: "home-paused-review-again",
    scenario: "S6",
    advance: MIN,
    alone: true,
    act: async (p) => {
      await p.keyboard.press("p");
      await button(p, "Paused").waitFor();
      await button(p, "Review again").hover();
      // The tooltip waits 400 ms before it shows.
      await p.waitForTimeout(700);
    },
  },
  { name: "phone-review-paused", scenario: "S8", phone: true, path: "/reviews/sasensi/lookover-sandbox/160" },
  // A failed review says its cause (ADR 0081). The agent's #149 opens on a fetch that runs past its limit: no try
  // once more, what would change it; Home's row says the phrase.
  ...[
    { name: "review-failed-time-limit", path: "/reviews/sasensi/lookover-sandbox/149" },
    { name: "home-failed-time-limit" },
  ].map((shot) => ({
    ...shot,
    scenario: "S10",
    inject: ["fetch-too-long", "agent-opens-change"] satisfies FaultId[],
    afterFaults: SEC,
  })),
  // Codex gives no usable review of #149: another try can help, so the page's one primary says "Try again". The notice
  // says the cause and no more: Details › Log, opened from its row, holds the log.
  ...[
    { name: "review-failed-retry", path: "/reviews/sasensi/lookover-sandbox/149" },
    {
      name: "review-failed-log",
      path: "/reviews/sasensi/lookover-sandbox/149",
      act: async (p: Page) => {
        await p.getByRole("button", { name: /^Log\b/ }).click();
        await p.locator(".disc-row.open .code.log").first().waitFor();
      },
    },
    { name: "home-failed-retry" },
  ].map((shot) => ({
    ...shot,
    scenario: "S10",
    inject: ["codex-no-review", "agent-opens-change"] satisfies FaultId[],
    afterFaults: 4 * MIN,
  })),
  // A push lands on the reviewed #141 and its review fails on a stalled fetch: the notice above the round says so,
  // the round and the pill keep the loop's state (ADR 0029).
  {
    name: "review-failed-after-round",
    scenario: "S10",
    path: "/reviews/sasensi/lookover-sandbox/141",
    inject: ["you-push", "fetch-silent"],
    alone: true,
    act: async (p) => {
      await button(p, "Review again").click();
      await p.getByText("Couldn't look over", { exact: false }).waitFor();
    },
  },
  { name: "review-settled", scenario: "S10", path: "/reviews/sasensi/lookover-sandbox/146", fullPage: true },
  { name: "review-clean", scenario: "S10", path: "/reviews/sasensi/lookover-sandbox/135" },
  // A finding that follows main's REVIEW.md (ADR 0048): "Why it was raised" names the rule and where it is.
  { name: "review-rule", scenario: "S10", path: "/reviews/sasensi/lookover-sandbox/139" },
  { name: "review-new-commits", scenario: "S6", path: "/reviews/sasensi/ledger-api/153", advance: MIN },
  // A teammate's pull request you haven't asked about: nothing posted, and how to ask (ADR 0078).
  {
    name: "review-not-asked",
    scenario: "S10",
    path: "/reviews/sasensi/lookover-sandbox/137",
    act: (p) => p.getByText("Why wasn't it reviewed?").click(),
  },
  // The person's own pull request from a fork (ADR 0048, 0078): never reviewed by itself; Claude only, when asked.
  {
    name: "review-skipped-fork",
    scenario: "S5",
    path: "/reviews/sasensi/ledger-api/153",
    advance: 2 * MIN,
    act: (p) => p.getByText("Why wasn't it reviewed?").click(),
  },
  { name: "all-reviews", scenario: "S12", path: "/reviews" },
  // Mine, then Everyone with teammates' pull requests nobody asked about (ADR 0078).
  { name: "all-reviews-mine", scenario: "S10", path: "/reviews" },
  { name: "all-reviews-everyone", scenario: "S10", path: "/reviews", act: toEveryone },
  // After setup's first review was a preview of #148 (ADR 0072): its findings are the owner's to read, so Home
  // counts it ("1 preview to read.") and All reviews files it under Needs you. Each opens on the setup.
  {
    name: "home-after-preview",
    scenario: "S1",
    screen: '.setup, [data-screen="home"]',
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Preview here only, post nothing").click();
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await button(p, "Go to my reviews").click();
      await p.getByText("1 preview to read.").waitFor();
    },
  },
  {
    name: "all-reviews-after-preview",
    scenario: "S1",
    screen: '.setup, [data-screen="reviews"]',
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Preview here only, post nothing").click();
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await button(p, "Go to my reviews").click();
      await p.getByRole("link", { name: /All reviews/ }).click();
      await button(p, "Needs you").click();
      await p.getByText("found · nothing posted").waitFor();
    },
  },
  // GitHub, as the fake host holds it
  // The agent's reply under the escalated finding's comment, Lookover's "The owner decides this one" after it; the
  // status block in the description says "Needs your look" (ADR 0074).
  {
    name: "github-escalated",
    scenario: "S4",
    path: "/github/sasensi/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
  },
  { name: "github-in-progress", scenario: "S2", path: "/github/sasensi/ledger-api/148", advance: MIN },
  // From round 2 a new Consider is not posted (ADR 0042): round 2's stays in the app.
  { name: "review-not-posted", scenario: "S2", path: "/reviews/sasensi/ledger-api/148", advance: 7 * MIN },
  {
    name: "github-not-posted",
    scenario: "S2",
    path: "/github/sasensi/ledger-api/148",
    advance: 7 * MIN,
    fullPage: true,
  },
  {
    name: "github-settled",
    scenario: "S2",
    path: "/github/sasensi/ledger-api/148",
    advance: 11 * MIN,
    fullPage: true,
  },
  // Settled with round 2's Consider still in the app: the verdict says so, and not that the rest can go.
  { name: "review-settled-kept", scenario: "S2", path: "/reviews/sasensi/ledger-api/148", advance: 11 * MIN },
  // New commits after the last round have no check until a review is asked for.
  {
    name: "github-new-commits",
    scenario: "S6",
    path: "/github/sasensi/ledger-api/153",
    advance: MIN,
    fullPage: true,
  },
  // F3's file isn't in the diff: no line comment, the status block lists it "Not in the diff" with its lines.
  { name: "github-not-in-diff", scenario: "S6", path: "/github/sasensi/ledger-api/153" },
  // Claude signed out mid-run: the block waits on the commit, saying why and when the review starts.
  { name: "github-waiting", scenario: "S3", path: "/github/sasensi/ledger-api/151", advance: 2 * MIN },
  // The service stopped twice while #151 ran: the second time the job fails, and the block says so.
  {
    name: "github-failed",
    scenario: "S3",
    path: "/github/sasensi/ledger-api/151",
    inject: ["npm-install", "npm-install"],
  },
  // The owner marks the page size finding as wrong in the app: its thread's root is hidden on GitHub, Lookover's
  // reply under it.
  {
    name: "github-dismissed",
    scenario: "S7",
    path: "/github/sasensi/ledger-api/148",
    alone: true,
    fullPage: true,
    act: async (p) => {
      const github = p.url();
      await p.goto(github.replace("/github/", "/reviews/"));
      await tooNoisy(p, "The page size is not capped").click();
      await p.getByRole("button", { name: /This finding is wrong/ }).click();
      await button(p, "Save").click();
      await p.getByText("Marked as wrong. The finding is dismissed.").waitFor();
      await p.goto(github);
      // `lookover wait` resolved its thread (#148 is the agent's): opened, as a reader would, to show what it holds.
      const thread = p.locator("details.gh-thread", { hasText: "Dismissed by the owner" });
      await thread.waitFor({ state: "attached" });
      await thread.evaluate((el) => {
        if (el instanceof HTMLDetailsElement) el.open = true;
      });
    },
  },
  // Repositories and settings
  { name: "repositories", scenario: "S9", path: "/repositories" },
  // The App on seven repositories, each watched (ADR 0053).
  { name: "repositories-many", scenario: "S12", path: "/repositories" },
  // A large organisation (row 46, ADR 0082): 28 watched in three accounts, ten gone from fernhill, ledger-labs gone;
  // fernhill's twenty folded at first, its head carrying its counts (ADR 0083, round 4).
  { name: "repositories-org", scenario: "S18", path: "/repositories", fullPage: true },
  // S20 (ADR 0086): a short login and two long ones, northwind's head (39 characters) asking for SSO with its fix,
  // the others holding no problem.
  {
    name: "repositories-names",
    scenario: "S20",
    path: "/repositories",
    fullPage: true,
    act: (p) => p.getByRole("button", { name: `${LONGEST}'s repositories` }).waitFor(),
  },
  // S20 at 1024 and 1440 (ADR 0086): northwind's head, its SSO cause and fix in its second row, scrolled past,
  // meridian's head stuck over its stuck row: only the first row sticks, so meridian's covers it whole, a long cause
  // or none.
  ...WIDTHS.map(
    (width): Shot => ({
      name: `repositories-names-covered-${width}`,
      scenario: "S20",
      path: "/repositories",
      width,
      act: async (p) => {
        await p.locator(".repos-group-more").getByText("Asks you to sign in with SSO.").waitFor();
        await headToStuckLine(p, MERIDIAN);
        await headCovered(p, LONGEST, MERIDIAN);
      },
    }),
  ),
  // fernhill switched off from its head (ADR 0082): every one of its repositories off, "None of 20 reviewed". Four of
  // them start off (ADR 0084), so its switch is mixed: the first press turns every one on, the second off.
  {
    name: "repositories-org-account-off",
    scenario: "S18",
    path: "/repositories",
    alone: true,
    act: async (p) => {
      const fernhill = p
        .locator("label.switch")
        .filter({ has: p.getByRole("switch", { name: "Review every repository in fernhill" }) });
      await fernhill.click();
      await p.getByText("All 20 reviewed").waitFor();
      await fernhill.click();
      await p.getByText("None of 20 reviewed").waitFor();
      await fernhill.scrollIntoViewIfNeeded();
    },
  },
  // On the narrowest phone the head keeps the account, its count and its switch in one row, the cause under it.
  {
    name: "repositories-org-phone",
    scenario: "S18",
    path: "/repositories",
    phone: "narrow",
    // fernhill's head a little under the top bar, sasensi's last rows above it, fernhill opened from its chevron.
    act: async (p) => {
      await openFernhill(p);
      await p
        .locator("th", { hasText: "fernhill" })
        .evaluate((head) => window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 240));
    },
  },
  // Scrolled into fernhill's twenty, opened from its chevron (ADR 0082): the search and filter, the column heads and
  // fernhill's head stuck under the top bar, the rows passing under them. The viewport, not the full page.
  {
    name: "repositories-org-stuck",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await openFernhill(p);
      await p
        .locator("th", { hasText: "fernhill" })
        .evaluate((head) => window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY + 384));
      await p.mouse.move(0, 0);
    },
  },
  // fernhill folded, as it starts past ten (ADR 0083): its head kept, switch, count and all; ledger-dev's group right
  // under it.
  {
    name: "repositories-org-collapsed",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await p.getByRole("button", { name: "fernhill's repositories", expanded: false }).waitFor();
      await p.getByRole("button", { name: "sasensi's repositories" }).evaluate((head) => {
        window.scrollTo(0, head.getBoundingClientRect().top + window.scrollY - 160);
      });
      // The pointer off the table, so no row shows its hover.
      await p.mouse.move(0, 0);
    },
  },
  // A search (ADR 0082): "ledger" finds sasensi/ledger-api by its name and ledger-dev's three by their account.
  {
    name: "repositories-org-search",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await p.getByRole("searchbox", { name: "Search repositories" }).fill("ledger");
      await p.getByRole("link", { name: "ledger-dev/ledger-docs", exact: true }).waitFor();
      await reposBarAtTop(p);
    },
  },
  // A search that finds nothing: All reviews' empty line in the table's place, the bar where it was.
  {
    name: "repositories-org-empty",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await p.getByRole("searchbox", { name: "Search repositories" }).fill("nowhere");
      await p.getByText("No repository here").waitFor();
      await reposBarAtTop(p);
    },
  },
  // The Off filter after two more repositories were switched off, beside the four of fernhill's that start off (ADR
  // 0084): only they are left, their groups' counts the account's; fernhill folded again, its head saying how many of
  // it the filter shows ("15 of 20 reviewed · 5 off").
  {
    name: "repositories-org-off",
    scenario: "S18",
    path: "/repositories",
    alone: true,
    act: async (p) => {
      await openFernhill(p);
      // Each switched off from its row, its head's count said once the service took it.
      for (const [name, count] of [
        ["sasensi/dotfiles", "4 of 5 reviewed"],
        ["fernhill/docs", "15 of 20 reviewed"],
      ] as const) {
        await p
          .locator("label.switch")
          .filter({ has: p.getByRole("switch", { name: `Review ${name}` }) })
          .click();
        await p.getByText(count).waitFor();
      }
      // fernhill folded again from its chevron.
      await p.getByRole("button", { name: "fernhill's repositories", expanded: true }).click();
      await p.getByRole("button", { name: "fernhill's repositories", expanded: false }).waitFor();
      await p.getByRole("group", { name: "Show" }).getByRole("button", { name: "Off" }).click();
      await p.getByRole("button", { name: "Off", pressed: true }).waitFor();
      await reposBarAtTop(p);
    },
  },
  // The Reviewing filter: fernhill, folded, says "16 repositories shown" in its head's second row, where a cause goes,
  // never under its count; the heads holding nothing to say have no second row.
  {
    name: "repositories-org-reviewing",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await p.getByRole("group", { name: "Show" }).getByRole("button", { name: "Reviewing" }).click();
      await p.getByRole("button", { name: "Reviewing", pressed: true }).waitFor();
      await p.locator(".repos-group-more").getByText("16 repositories shown").waitFor();
      await reposBarAtTop(p);
    },
  },
  // The Reviewing filter on the narrowest phone, scrolled into ledger-dev's rows: fernhill, folded, says what the
  // filter shows in its head's second row, never under its count; ledger-dev's head, open, has no second row, its
  // stuck row as tall as fernhill's, so it covers fernhill's head stuck under it whole (Lookover's F5).
  {
    name: "repositories-org-reviewing-phone",
    scenario: "S18",
    path: "/repositories",
    phone: "narrow",
    act: async (p) => {
      await p.getByRole("group", { name: "Show" }).getByRole("button", { name: "Reviewing" }).click();
      await p.getByRole("button", { name: "Reviewing", pressed: true }).waitFor();
      await p.locator(".repos-group-more").getByText("16 repositories shown").waitFor();
      // A short phone's viewport, an iPhone SE's under its browser's bars, ledger-dev's head scrolled up to the line
      // fernhill's is stuck at (the window shortened by what the page lacks, `headToStuckLine`).
      await p.setViewportSize({ width: NARROW_PHONE, height: 560 });
      await headToStuckLine(p, "ledger-dev");
      await headCovered(p, "fernhill", "ledger-dev");
    },
  },
  // S18's departed (ADR 0082): ledger-labs gone, its No access notice with its fix; fernhill's ten in the summary,
  // opened.
  {
    name: "repositories-org-departed-open",
    scenario: "S18",
    path: "/repositories",
    act: async (p) => {
      await p.getByText("10 repositories left the App's installation.").waitFor();
      await p.getByRole("button", { name: "Show the 10 repositories" }).click();
      await p.getByRole("button", { name: "Dismiss fernhill/onboarding" }).waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // Dismiss all reached by Tab from Show, the list open: Tab goes as the eye does, the × beside it at the top right
  // before the lines under it (#643), its focus ring whole.
  {
    name: "repositories-org-departed-focus",
    scenario: "S18",
    path: "/repositories",
    alone: true,
    act: async (p) => {
      await p.getByRole("button", { name: "Show the 10 repositories" }).click();
      await p.getByRole("button", { name: "Dismiss fernhill/legacy-portal" }).waitFor();
      await p.getByRole("button", { name: "Hide the 10 repositories" }).focus();
      await p.keyboard.press("Tab");
      await p.getByRole("button", { name: "Dismiss all" }).and(p.locator(":focus")).waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // Dismiss all: the summary goes, ledger-labs' No access notice stays.
  {
    name: "repositories-org-dismissed-all",
    scenario: "S18",
    path: "/repositories",
    alone: true,
    act: async (p) => {
      await button(p, "Dismiss all").click();
      await p.getByText("left the App's installation.").waitFor({ state: "detached" });
      await p.mouse.move(0, 0);
    },
  },
  // On the narrowest phone, the top: ledger-labs' No access notice and the closed summary, each fitting its width.
  { name: "repositories-org-departed-phone", scenario: "S18", path: "/repositories", phone: "narrow" },
  // The shared App uninstalled everywhere (ADR 0082): the band says it, every departed repository quiet in the
  // summary, no No access notice.
  {
    name: "repositories-app-uninstalled",
    scenario: "S16",
    path: "/repositories",
    inject: ["app-uninstalled"],
  },
  // Two repositories gone from the installation, said quietly in one summary until back or dismissed (ADR 0059, 0082).
  {
    name: "repositories-departed",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
  },
  // The list opened and one dismissed from its line: the other is still said, the summary kept, down to one.
  {
    name: "repositories-departed-dismissed",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
    alone: true,
    act: async (p) => {
      await p.getByText("2 repositories left the App's installation.").waitFor();
      await p.getByRole("button", { name: "Show the 2 repositories" }).click();
      const dotfiles = p.getByRole("button", { name: /^Dismiss \S+\/dotfiles$/ });
      await dotfiles.click();
      await dotfiles.waitFor({ state: "detached" });
      await p.getByText("1 repository left the App's installation.").waitFor();
      await p.mouse.move(0, 0);
    },
  },
  {
    name: "repositories-departed-phone",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
    phone: true,
  },
  { name: "repository", scenario: "S9", path: "/repositories/sasensi/lookover-sandbox", fullPage: true },
  {
    name: "repositories-one-off",
    scenario: "S9",
    path: "/repositories",
    alone: true,
    // A group of one: its row's switch, the head's the account's (ADR 0083, round 4).
    act: (p) =>
      p
        .locator("label.switch")
        .filter({ has: p.getByRole("switch", { name: "Review sasensi/lookover-sandbox" }) })
        .click(),
  },
  { name: "settings", scenario: "S10", path: "/settings", fullPage: true },
  {
    name: "settings-select",
    scenario: "S10",
    path: "/settings",
    act: (p) => button(p, "Strictness").click(),
  },
  // Depth beside strictness, its three choices open (ADR 0049).
  {
    name: "settings-depth",
    scenario: "S10",
    path: "/settings",
    act: (p) => button(p, "Depth").click(),
  },
  {
    name: "settings-rules",
    scenario: "S10",
    path: "/settings/rules",
    alone: true,
    // The cents rule switched off: written to the repository's file, its row and counts kept, the stamp saved; the
    // rule nested in it held off with it, its switch drawn held and why said under its words.
    act: async (p) => {
      await p.locator("tbody tr", { hasText: "Amounts stay" }).locator(".switch").click();
      await p.getByText("Saved", { exact: true }).waitFor();
      await p.locator("tbody tr").last().getByText("Off with the rule it sits in.").waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // The same switch while the service has the change: the stamp says "Saving…" beside the eyes, in the place
  // "Saved" takes. The command is held in the browser, never sent, so the service's state is S10's as loaded.
  {
    name: "settings-rules-saving",
    scenario: "S10",
    path: "/settings/rules",
    act: async (p) => {
      await p.route(`**${API.commands}`, () => undefined);
      await p.locator("tbody tr", { hasText: "Amounts stay" }).locator(".switch").click();
      await p.getByText("Saving…", { exact: true }).waitFor();
    },
  },
  // Settings' GitHub group once set up through the sign-in: who is signed in, Sign in again, the accounts; nothing
  // else (ADR 0073). It opens on the setup.
  {
    name: "settings-github",
    scenario: "S1",
    screen: '.setup, [data-screen="settings"]',
    alone: true,
    act: async (p, demo) => {
      await setUpSignedIn(p, demo);
      await link(p, "Settings").click();
      await centre(p.locator(".signed-in-row"));
    },
  },
  // Settings › GitHub on the shared App (ADR 0067): signed in, the accounts list setup shows.
  { name: "settings-github-shared", scenario: "S16", path: "/settings#github", act: toSharedGitHub },
  // The same list on S20's real-looking names (ADR 0086).
  { name: "settings-github-names", scenario: "S20", path: "/settings#github", act: toNamesGitHub },
  // On a phone each row stacks: the account over its detail, its fix's place beneath (Ask again inside it).
  {
    name: "settings-github-shared-phone",
    scenario: "S16",
    path: "/settings#github",
    phone: true,
    act: toSharedGitHub,
  },
  // Sign in again while connected: the code in place of the button, Cancel beside it; nothing else moves.
  {
    name: "settings-github-shared-code",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p) => {
      await toSharedGitHub(p);
      await button(p, "Sign in again").click();
      await link(p, "Copy code and open GitHub").waitFor();
    },
  },
  // An owner of ledger-dev suspended the App there: its row says who, and asks an owner of it.
  {
    name: "settings-github-shared-suspended",
    scenario: "S16",
    path: "/settings#github",
    inject: ["organisation-suspended"],
    act: async (p) => {
      await p.getByText("Suspended by mira.", { exact: false }).first().waitFor();
      await toSharedGitHub(p);
    },
  },
  // The look line (ADR 0088): Install on ledger-labs opened GitHub's page, and Lookover looks every few seconds,
  // saying when it last did; then ledger-labs installed there arrives; or, nothing installed, the look ends with
  // nothing new past its 3 minutes.
  {
    name: "settings-github-look-looking",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p, demo) => {
      await toSharedGitHub(p);
      await looksForLedgerLabs(p, demo);
    },
  },
  {
    name: "settings-github-look-arrived",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p, demo) => {
      await toSharedGitHub(p);
      await ledgerLabsArrives(p, demo);
    },
  },
  {
    name: "settings-github-look-nothing",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p, demo) => {
      await toSharedGitHub(p);
      await nothingNewForLedgerLabs(p, demo);
    },
  },
  // An ask an owner approves later (ADR 0088): Ask to install on ledger-hq, the look it started ends past its 3
  // minutes with nothing new, then an owner of ledger-hq approves on GitHub with nothing listed at once; the 2-minute
  // base cadence finds it: ledger-hq's row is reached, and the line and a toast say it arrived.
  {
    name: "settings-github-approved-later",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p, demo) => {
      await toSharedGitHub(p);
      await askToInstallOnLedgerHq(p);
      for (let step = 0; step < 46; step++) await demo.advance(4 * SEC);
      await lookWords(p).getByText("an owner may still have to approve", { exact: false }).waitFor();
      await demo.inject("owner-approves");
      const asked = link(p, "Ask again");
      for (let step = 0; step < 13 && (await asked.isVisible()); step++) await demo.advance(10 * SEC);
      await asked.waitFor({ state: "detached" });
      await lookWords(p).getByText("ledger-hq arrived: 1 repository.", { exact: true }).waitFor();
      await p.locator(".toast", { hasText: "ledger-hq arrived: 1 repository." }).waitFor();
      await entriesPlayed(p);
      await p.mouse.move(0, 0);
    },
  },
  // Asked an owner of ledger-hq to install it: the row waits for them, with Ask again.
  {
    name: "settings-github-shared-waiting",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    act: async (p) => {
      await toSharedGitHub(p);
      await askToInstallOnLedgerHq(p);
    },
  },
  {
    name: "settings-github-shared-waiting-phone",
    scenario: "S16",
    path: "/settings#github",
    alone: true,
    phone: true,
    act: async (p) => {
      await toSharedGitHub(p);
      await askToInstallOnLedgerHq(p);
    },
  },
  // Start at login chosen, not registered (ADR 0054): its help says so, and how to try again.
  {
    name: "settings-login-refused",
    scenario: "S10",
    path: "/settings",
    inject: ["login-refused"],
    act: (p) => p.getByLabel("Start at login", { exact: true }).scrollIntoViewIfNeeded(),
  },
  // Another Lookover holds start at login (ADR 0068): the help names its command, the switch is still the choice, and
  // while it is on "Start this one instead" takes it on purpose; on a phone the command wraps inside its code and the
  // switch stays level with the title. Taken over, the row says this one starts.
  {
    name: "settings-login-taken",
    scenario: "S10",
    path: "/settings",
    inject: ["login-taken"],
    act: async (p) => {
      await button(p, "Start this one instead").waitFor();
      await centre(loginSwitch(p));
    },
  },
  {
    name: "settings-login-taken-phone",
    scenario: "S10",
    path: "/settings",
    phone: true,
    inject: ["login-taken"],
    act: async (p) => {
      await button(p, "Start this one instead").waitFor();
      await centre(loginSwitch(p));
    },
  },
  {
    name: "settings-login-taken-over",
    scenario: "S10",
    path: "/settings",
    inject: ["login-taken"],
    alone: true,
    act: async (p) => {
      await button(p, "Start this one instead").click();
      await p.getByText("Lookover starts each time you log in to this computer.", { exact: false }).waitFor();
      await p.getByLabel("Start at login", { exact: true }).scrollIntoViewIfNeeded();
    },
  },
  // Taken and switched off: the help says it is off and names the other, "Start this one instead" gone, the switch
  // level with the title where it was, on a phone too (rule 5).
  {
    name: "settings-login-taken-off",
    scenario: "S10",
    path: "/settings",
    inject: ["login-taken"],
    alone: true,
    act: switchLoginOffWhileTaken,
  },
  {
    name: "settings-login-taken-off-phone",
    scenario: "S10",
    path: "/settings",
    phone: true,
    inject: ["login-taken"],
    alone: true,
    act: switchLoginOffWhileTaken,
  },
  // The log file of the scratch data folder (ADR 0055), from the shot's own load on: its self-tests, then S10's seed.
  // The file holds every load the proof service made before it, which shots ran first decides, and the start's
  // banner, which carries the port the worktree's path picks: those lines are hidden, so the shot is the same in a
  // full run, a `--diff` run and any worktree.
  {
    name: "logs",
    scenario: "S10",
    path: "/logs",
    act: async (p) => {
      await p.locator(".code pre .line", { hasText: "self-test of claude" }).first().waitFor();
      await p.evaluate(() => {
        // Lines, not runs: the start's banner and the self-tests are about no pull request, so one run holds them.
        const lines = [...document.querySelectorAll<HTMLElement>(".code pre .line")];
        const load = lines.findLastIndex((line) => line.textContent?.includes("self-test of claude"));
        for (const line of lines.slice(0, load)) line.style.display = "none";
        // A run left with no line shown goes with its head; the first one shown opens the block, with no gap.
        const runs = [...document.querySelectorAll<HTMLElement>(".code pre > .run")];
        const shown = (run: HTMLElement) =>
          [...run.querySelectorAll<HTMLElement>(".line")].some((line) => line.style.display !== "none");
        for (const run of runs) if (!shown(run)) run.style.display = "none";
        const first = runs.find(shown);
        if (first) first.style.marginTop = "0";
      });
    },
  },
  // The first run
  { name: "setup-1-ai", scenario: "S1", screen: ".setup" },
  // Neither AI installed: each row gives this machine's command to install it (ADR 0070).
  { name: "setup-1-ai-missing", scenario: "S1", inject: ["engines-missing"], screen: ".setup" },
  // Both AIs ready: the step says so and waits for Continue; nothing moves by itself (ADR 0058).
  { name: "setup-1-ai-ready", scenario: "S1", screen: ".setup", alone: true, act: setupUntilBothReady },
  // Codex signed in, its safety check couldn't finish twice (ADR 0075): its row says so and offers Try again, never
  // a sign-in; Continue goes on with Claude only.
  {
    name: "setup-1-ai-self-test-unfinished",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilBothReady(p, demo);
      await demo.inject("codex-self-test-unfinished");
      await p.getByText("Couldn't finish Lookover's safety check", { exact: false }).waitFor();
      await button(p, "Try again").waitFor();
    },
  },
  // Sign in with GitHub, the one way in (ADR 0066, ADR 0073): the step's start; the code GitHub gave, with Copy code
  // and open GitHub and Cancel; a code that ran out; one GitHub didn't sign in (cancelled on its page); then who you
  // are and the accounts reached. GitHub's fake device page, where the code is entered.
  { name: "setup-2-github", scenario: "S1", screen: ".setup", alone: true, act: setupUntilGitHub },
  { name: "setup-github-sign-in-code", scenario: "S1", screen: ".setup", alone: true, act: setupUntilCode },
  {
    name: "setup-github-sign-in-expired",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.advance(15 * MIN);
      await p.getByText("The code ran out before it was entered.").waitFor();
    },
  },
  {
    name: "setup-github-sign-in-denied",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.inject("sign-in-denied");
      await demo.advance(5 * SEC);
      await p.getByText("GitHub didn't sign you in.").waitFor();
    },
  },
  // Kept on disk, then the install's next check (4 s) finds the accounts.
  { name: "setup-github-signed-in", scenario: "S1", screen: ".setup", alone: true, act: setupUntilSignedIn },
  // Signed in, GitHub still listing the accounts (#670, ADR 0086): who you are, your own row looking, with no action
  // and nothing said missing, until GitHub answers.
  {
    name: "setup-github-signed-in-looking",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.inject("accounts-slow");
      await demo.inject("sign-in-entered");
      await demo.advance(5 * SEC);
      await p.getByText("Signed in as sasensi.").waitFor();
      const row = p.locator('.account-row[data-state="looking"]');
      await row.getByText("Looking…").waitFor();
      const rows = await p.locator(".account-row").count();
      if (rows !== 1) throw new Error(`Setup lists ${rows} account rows while looking, not 1`);
      if ((await row.locator(".account-actions a, .account-actions button").count()) !== 0)
        throw new Error("Setup's looking row offers an action");
      if ((await p.getByText("Not installed", { exact: false }).count()) !== 0)
        throw new Error("Setup says an account isn't installed while it is still looking");
    },
  },
  // Signed in, the shared App installed on none of your accounts: GitHub has answered, so your own row says so, with
  // Install on it, and the list offers the installs.
  {
    name: "setup-github-installed-nowhere",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.inject("app-uninstalled");
      await demo.inject("sign-in-entered");
      await demo.advance(5 * SEC);
      await p.locator(".substep.done").first().waitFor();
      await demo.advance(4 * SEC);
      await p.getByText("Looking for your accounts", { exact: false }).waitFor();
      await p.getByRole("link", { name: "Install on sasensi" }).waitFor();
      // Install on another account's link is the fake's install page for the shared App, not a 404.
      const [tab] = await Promise.all([
        p.waitForEvent("popup"),
        p.getByRole("link", { name: "Install on another account" }).click(),
      ]);
      await tab.getByRole("button", { name: "Install" }).waitFor();
      await tab.close();
    },
  },
  // Signed in before the install, then signed out on GitHub (the same as a sign-in lost with the keychain): the step
  // at its start again, and why.
  {
    name: "setup-github-signed-out",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.inject("app-uninstalled");
      await demo.inject("sign-in-entered");
      await demo.advance(5 * SEC);
      await p.locator(".substep.done").first().waitFor();
      await demo.inject("github-signed-out");
      await demo.advance(4 * SEC);
      await p.getByText("You're signed out of GitHub.", { exact: false }).waitFor();
    },
  },
  // Signed in, the shared App installed on no repository: GitHub's page again, to pick some.
  {
    name: "setup-github-signed-in-nothing-granted",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilCode(p, demo);
      await demo.inject("nothing-granted");
      await demo.inject("sign-in-entered");
      await demo.advance(5 * SEC);
      await p.locator(".substep.done").first().waitFor();
      await demo.advance(4 * SEC);
      await p.getByText("Installed, with no repository chosen.", { exact: true }).waitFor();
    },
  },
  // S21 (ADR 0086): setup's GitHub step on S20's real-looking names, northwind (39 characters) asking for SSO.
  {
    name: "setup-github-names",
    scenario: "S21",
    screen: ".setup",
    fullPage: true,
    act: (p) => p.locator(".accounts-list").getByText(LONGEST, { exact: true }).waitFor(),
  },
  // Its Repositories step, the same names on the groups' heads.
  {
    name: "setup-3-repositories-names",
    scenario: "S21",
    screen: ".setup",
    alone: true,
    act: async (p) => {
      await button(p, "Continue").click();
      await p.getByRole("group", { name: LONGEST, exact: true }).waitFor();
    },
  },
  // Its First review step: meridian's pull request titled in Chinese, no space to break at (row 52). Its title wraps
  // in its own column at every width, a phone's too, never past it into the link's or off the screen.
  {
    name: "setup-4-first-review-names",
    scenario: "S21",
    screen: ".setup",
    alone: true,
    act: async (p) => {
      await button(p, "Continue").click();
      await p.getByRole("group", { name: LONGEST, exact: true }).waitFor();
      await button(p, "Continue").click();
      await p.locator(".first-row").getByText(CLAIMS_TITLE.slice(0, 8)).waitFor();
      const desktop = p.viewportSize();
      if (desktop === null) throw new Error("The page has no viewport size");
      for (const width of [desktop.width, PHONE, NARROW_PHONE]) {
        await p.setViewportSize({ width, height: desktop.height });
        await entriesPlayed(p);
        const past = await p.locator(".first-row > .check > span > b").evaluateAll((titles) =>
          titles.flatMap((b) => {
            // The title's own words, the chip's held labels left out.
            const box = b.getBoundingClientRect();
            const texts: Text[] = [];
            const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n !== null; n = walk.nextNode())
              if (n instanceof Text && n.parentElement?.closest(".first-row-chip") === null) texts.push(n);
            const right = Math.max(
              ...texts.flatMap((t) => {
                const words = document.createRange();
                words.selectNodeContents(t);
                return [...words.getClientRects()].map((r) => r.right);
              }),
            );
            const title = texts.map((t) => t.data).join("");
            return right > box.right + 0.5 || right > window.innerWidth
              ? [`${title}: ${Math.round(right - box.right)} px past its column`]
              : [];
          }),
        );
        if (past.length > 0) throw new Error(`First review's titles at ${width} px: ${past.join("; ")}`);
      }
      await p.setViewportSize(desktop);
    },
  },
  // S17 (ADR 0067): every account state at setup: ledger-dev reached, ledger-ops asking for SSO, sasensi and
  // ledger-labs to install on, ledger-hq to ask an owner of (listed once `gh` is read, right after the start).
  {
    name: "setup-github-every-account",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    act: (p) => link(p, "Ask to install on ledger-hq").waitFor(),
  },
  // On a phone each row stacks: the account over its detail, its fix's place beneath (Ask again inside it).
  {
    name: "setup-github-every-account-phone",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    phone: true,
    act: async (p) => {
      await link(p, "Ask to install on ledger-hq").waitFor();
      await accountsLinesFit(p);
    },
  },
  // The look line in setup (ADR 0088): Your accounts says the look in its own line, Check again its action.
  {
    name: "setup-github-look-looking",
    scenario: "S17",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await link(p, "Install on ledger-labs").waitFor();
      await looksForLedgerLabs(p, demo);
    },
  },
  {
    name: "setup-github-look-arrived",
    scenario: "S17",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await link(p, "Install on ledger-labs").waitFor();
      await ledgerLabsArrives(p, demo);
    },
  },
  {
    name: "setup-github-look-nothing",
    scenario: "S17",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await link(p, "Install on ledger-labs").waitFor();
      await nothingNewForLedgerLabs(p, demo);
    },
  },
  // Asked: ledger-hq's row waits for an owner, with Ask again; then an owner installs it, and it is reached.
  {
    name: "setup-github-waiting",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: askToInstallOnLedgerHq,
  },
  {
    name: "setup-github-waiting-phone",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    alone: true,
    phone: true,
    act: askToInstallOnLedgerHq,
  },
  {
    name: "setup-github-owner-installed",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await askToInstallOnLedgerHq(p);
      await demo.inject("owner-installs");
      // Reached: ledger-hq moves to the list's reached part, and Ask again detaching is the sign it did.
      await link(p, "Ask again").waitFor({ state: "detached" });
      // The pointer off the row, so no button shows its hover.
      await p.mouse.move(0, 0);
    },
  },
  // An owner approves the ask later and the look finds it (ADR 0091), GitHub slow to read its repositories the first
  // time: ledger-hq is being read, with no action, never "No repository yet." with Choose repositories, and the
  // step's line says so in place of the look's arrival.
  {
    name: "setup-github-owner-installed-reading",
    scenario: "S17",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await askToInstallOnLedgerHq(p);
      await demo.inject("first-read-slow");
      await demo.inject("owner-approves");
      await demo.advance(4 * SEC);
      const row = p.locator('.account-row[data-state="reading"]', { hasText: "ledger-hq" });
      await row.getByText("Reading its repositories…").waitFor();
      await p.getByText("Reading your accounts' repositories…", { exact: true }).waitFor();
      // Its place holds its hidden labels' width, never a button shown.
      if (
        (await row
          .locator(".account-actions a, .account-actions button")
          .filter({ visible: true })
          .count()) !== 0
      )
        throw new Error("ledger-hq's row offers an action while its repositories are read");
      if ((await p.getByText("No repository yet.", { exact: true }).count()) !== 0)
        throw new Error("Setup says No repository yet. while ledger-hq's repositories are read");
      await p.mouse.move(0, 0);
    },
  },
  { name: "github-device", scenario: "S1", path: `${DEMO_API.github}/login/device`, screen: "main" },
  {
    name: "setup-3-repositories",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: setupUntilRepositories,
  },
  // S18's world at setup's Repositories step (row 46): 40 repositories in four accounts, every one ticked, fernhill's
  // thirty folded as on Repositories (ADR 0083, round 6).
  {
    name: "setup-3-repositories-org",
    scenario: "S19",
    screen: ".setup",
    fullPage: true,
    act: async (p) => {
      await p.getByText("Pick the repositories to review.").waitFor();
      await p.getByRole("button", { name: "fernhill's repositories", expanded: false }).waitFor();
    },
  },
  // The same step, fernhill opened, one of its repositories unticked (its account's box mixed) and ledger-dev's
  // account unticked (none): the open counts down the rows' right edge.
  {
    name: "setup-3-repositories-org-mixed",
    scenario: "S19",
    screen: ".setup",
    fullPage: true,
    act: async (p) => {
      const account = (login: string) => p.getByLabel(`Review every repository in ${login}`, { exact: true });
      await openFernhill(p);
      await account("ledger-dev").click();
      await p
        .getByRole("group", { name: "fernhill", exact: true })
        .getByLabel(/^fernhill\/api,/)
        .click();
      await p.locator('input[aria-checked="mixed"]').waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // fernhill folded back after one of its thirty is unticked: its head's box mixed, its count "29 of 30 to review".
  {
    name: "setup-3-repositories-org-mixed-folded",
    scenario: "S19",
    screen: ".setup",
    act: async (p) => {
      await openFernhill(p);
      await p
        .getByRole("group", { name: "fernhill", exact: true })
        .getByLabel(/^fernhill\/api,/)
        .click();
      await p.getByRole("button", { name: "fernhill's repositories", expanded: true }).click();
      await p.getByRole("button", { name: "fernhill's repositories", expanded: false }).waitFor();
      await p.locator('input[aria-checked="mixed"]').waitFor();
      await p.getByText("29 of 30 to review", { exact: true }).waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // The window, not the full page, scrolled into fernhill's thirty, opened (ADR 0083): Continue's footer stuck at its
  // bottom.
  {
    name: "setup-3-repositories-org-scrolled",
    scenario: "S19",
    screen: ".setup",
    act: async (p) => {
      await p.getByText("Pick the repositories to review.").waitFor();
      await openFernhill(p);
      await p.mouse.move(0, 0);
      await p
        .getByRole("group", { name: "fernhill", exact: true })
        .evaluate((g) => window.scrollTo(0, g.getBoundingClientRect().top + window.scrollY - 120));
    },
  },
  // A search for "api" with fernhill folded as it starts: the matches of every account, fernhill's shown though folded.
  {
    name: "setup-3-repositories-org-search",
    scenario: "S19",
    screen: ".setup",
    act: async (p) => {
      await p.getByRole("button", { name: "fernhill's repositories", expanded: false }).waitFor();
      await p.getByRole("searchbox", { name: "Search repositories" }).fill("api");
      await p
        .getByRole("group", { name: "fernhill", exact: true })
        .getByLabel(/^fernhill\/api,/)
        .waitFor();
      await p.mouse.move(0, 0);
    },
  },
  // On the narrowest phone: one line per repository, the footer in reach.
  {
    name: "setup-3-repositories-org-phone",
    scenario: "S19",
    screen: ".setup",
    phone: "narrow",
    act: (p) => p.getByText("Pick the repositories to review.").waitFor(),
  },
  // S17's step: each account reached with one repository, a group of one, its head with no box.
  {
    name: "setup-3-repositories-one-each",
    scenario: "S17",
    screen: ".setup",
    alone: true,
    act: async (p) => {
      await button(p, "Continue").click();
      await p.getByRole("group", { name: "ledger-dev", exact: true }).waitFor();
    },
  },
  // The agent opens #152 while Repositories is on screen (ADR 0068): ledger-api counts it with no reload.
  {
    name: "setup-3-repositories-new-pr",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await p.getByText("2 open", { exact: true }).waitFor();
      await demo.inject("agent-opens-change");
      await p.getByText("3 open", { exact: true }).waitFor();
    },
  },
  {
    name: "setup-back-to-github",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Back").click();
      await p.getByText("Signed in as", { exact: false }).waitFor();
    },
  },
  {
    name: "setup-pick-pull-request",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      // #131's age is GitHub's opened time, not when Lookover first listed it (ADR 0068).
      await p.getByText("19 days ago").waitFor();
    },
  },
  // The agent opens #152 while First review is on screen (ADR 0068): listed with no reload, #148 still picked.
  {
    name: "setup-4-first-review-new-pr",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      await demo.inject("agent-opens-change");
      await p.getByText("Cache exchange rates for an hour").waitFor();
      await p
        .getByRole("radio", { name: /Add rate limiting to \/v1\/invoices/ })
        .and(p.locator(":checked"))
        .waitFor();
    },
  },
  // #152, opened while First review is on screen, is reviewed by itself (#425): its row stays, its radio off, with
  // its state chip and "Open on GitHub"; #148 still picked. A review by itself is a first review (ADR 0072): Continue
  // is the primary, the line names #152 and what #148's pick leaves, and Review this pull request is still there as a
  // ghost. The bar holds its places and sizes, at the desktop width and at 375 px; the line arrives under it, the
  // step's end, where it moves nothing (ADR 0086).
  {
    name: "setup-4-first-review-reviewed",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      await demo.inject("agent-opens-change");
      await p.getByText("Cache exchange rates for an hour").waitFor();
      // Before the review lands, one Review this pull request a person can reach: the primary.
      const reviews = await p.getByRole("button", { name: "Review this pull request" }).count();
      if (reviews !== 1)
        throw new Error(`First review offers ${reviews} Review this pull request buttons, not 1`);
      // The boxes of the bar and each of its places, at the desktop width and at 375 px.
      const desktop = p.viewportSize();
      if (desktop === null) throw new Error("The page has no viewport size");
      const places = p.locator(".first-review-acts, .first-review-acts > *");
      const boxes = async () => {
        const at: string[] = [];
        for (const width of [desktop.width, NARROW_PHONE]) {
          await p.setViewportSize({ width, height: desktop.height });
          await entriesPlayed(p);
          at.push(
            JSON.stringify(await places.evaluateAll((all) => all.map((e) => e.getBoundingClientRect()))),
          );
        }
        await p.setViewportSize(desktop);
        return at;
      };
      const before = await boxes();
      await demo.advance(5 * MIN);
      await p
        .getByRole("radio", { name: /Cache exchange rates for an hour/ })
        .and(p.locator(":disabled"))
        .waitFor();
      await button(p, "Open on GitHub").waitFor();
      await p
        .getByRole("radio", { name: /Add rate limiting to \/v1\/invoices/ })
        .and(p.locator(":checked"))
        .waitFor();
      // The line names #152 and the pull request picked, whose radio is on (round 4). Each sentence a block of its own
      // (round 6).
      const sentences = p.locator(".first-reviewed-line > .line-sentence");
      await sentences
        .nth(0)
        .filter({ hasText: /^Lookover already reviewed sasensi\/ledger-api #152 by itself: Clean\.$/ })
        .waitFor();
      if ((await sentences.count()) !== 2)
        throw new Error(`First review's line shows ${await sentences.count()} sentences, not 2`);
      const pick = (await sentences.nth(1).innerText()).match(
        /^Go on, or review (sasensi\/ledger-api #\d+) too\.$/,
      )?.[1];
      const checked = await p
        .locator(".first-row")
        .filter({ has: p.getByRole("radio", { checked: true }) })
        .innerText();
      if (pick === undefined || !checked.includes(pick))
        throw new Error(
          `First review's line names ${pick ?? "no pull request"}, not the one picked: ${checked}`,
        );
      // Continue is the one primary, and the middle place offers Review this pull request instead of the preview, a
      // secondary as the preview is, so it reads as a choice and nothing beside Continue is filled (round 5).
      const bar = p.locator(".first-review-acts");
      await bar.locator(".btn-primary").getByText("Continue").waitFor();
      await bar.locator(".btn-secondary").getByText("Review this pull request").waitFor();
      const shown = bar.locator(".same-width-slot:not([aria-hidden])");
      if ((await shown.locator(".btn-primary").count()) !== 1)
        throw new Error("First review's bar has more than one primary once a review is posted");
      const previews = await p.getByRole("button", { name: "Preview here only, post nothing" }).count();
      if (previews !== 0) throw new Error("First review still offers a preview once a review is posted");
      // Once it lands, still one Review this pull request a person can reach: the middle place's.
      const reviewsAfter = await p.getByRole("button", { name: "Review this pull request" }).count();
      if (reviewsAfter !== 1)
        throw new Error(
          `First review offers ${reviewsAfter} Review this pull request buttons once reviewed, not 1`,
        );
      const after = await boxes();
      if (before.join() !== after.join())
        throw new Error(`First review's bar or line moved: from ${before.join(" ")} to ${after.join(" ")}`);
      // At the desktop width, the bar's three places on one line (on a phone, where the layout pass lays it out too,
      // it wraps by design).
      const middles = await p
        .locator(".first-review-acts > *")
        .evaluateAll((all) => all.map((e) => e.getBoundingClientRect()).map((r) => r.top + r.height / 2));
      if (desktop.width > PHONE && new Set(middles).size !== 1)
        throw new Error(`First review's bar wraps: ${middles.join(", ")}`);
    },
  },
  // The same on a phone: the reviewed row's Open on GitHub is a small square, its icon alone, said on hover by its tip
  // (design-system.md "Icon button"), which ends inside the screen.
  {
    name: "setup-4-first-review-reviewed-phone",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    phone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      await demo.inject("agent-opens-change");
      await p.getByText("Cache exchange rates for an hour").waitFor();
      await demo.advance(5 * MIN);
      // A button in demo mode (the simulated page), a link in live mode: named by its words either way.
      const link = p.locator(
        '.first-row.reviewed .first-row-reviewed .btn-square[aria-label="Open on GitHub"]',
      );
      await link.hover();
      // The tooltip waits 400 ms before it shows.
      await p.waitForTimeout(700);
      const square = await link.boundingBox();
      if (square === null || Math.abs(square.width - square.height) > 0.5)
        throw new Error(`Open on GitHub is not a square on a phone: ${JSON.stringify(square)}`);
      const tip = p.locator(".first-row.reviewed .tip", { hasText: "Open on GitHub" });
      const box = await tip.boundingBox();
      const width = p.viewportSize()?.width ?? 0;
      if (box === null || box.x < 0 || box.x + box.width > width)
        throw new Error(`Open on GitHub's tip runs past the screen: ${JSON.stringify(box)}`);
      if (Number(await tip.evaluate((e) => getComputedStyle(e).opacity)) !== 1)
        throw new Error("Open on GitHub's tip does not show on hover");
    },
  },
  // The agent opens #152 while Repositories is on screen: before the repositories are chosen nothing is asked of it
  // (ADR 0079), so five minutes on, First review offers it as any pull request to pick: no row reviewed, no Continue.
  {
    name: "setup-4-first-review-opened-on-repos",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await demo.inject("agent-opens-change");
      await p.getByText("3 open", { exact: true }).waitFor();
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      await p.getByText("Cache exchange rates for an hour").waitFor();
      // Not reviewed by itself: the primary is still Review this pull request, not Continue (ADR 0072).
      if ((await p.locator(".first-review-acts").getByRole("button", { name: "Continue" }).count()) !== 0)
        throw new Error(
          "First review offers Continue: #152, opened before the choice, was reviewed by itself",
        );
    },
  },
  // The owner's path (#458): the agent opens #152 once the repositories are chosen, reviewed by itself five minutes
  // on; First review then offers Continue, its line naming #152, and Continue on through Your coding agent lands on
  // Home with #152's Clean row.
  {
    name: "setup-4-first-review-reviewed-to-home",
    scenario: "S1",
    // It opens on setup and ends on Home, which its act waits for.
    screen: '.setup, [data-screen="home"]',
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").waitFor();
      await demo.inject("agent-opens-change");
      await p.getByText("Cache exchange rates for an hour").waitFor();
      await demo.advance(5 * MIN);
      await p
        .locator(".first-reviewed-line")
        .getByText(/^Lookover already reviewed sasensi\/ledger-api #152 by itself: Clean\./)
        .waitFor();
      await p.locator(".first-review-acts .btn-primary").getByText("Continue").click();
      await p.getByText("Let your coding agent run the loop.").waitFor();
      await button(p, "Go to my reviews").click();
      await p.locator('[data-screen="home"]').waitFor();
      await p.getByText("Nothing needs you.").waitFor();
      await p
        .locator(".rowi")
        .filter({ hasText: "Cache exchange rates for an hour" })
        .getByText("Clean", { exact: true })
        .waitFor();
    },
  },
  // ledger-api unticked: no pull request open in the repositories kept. The empty card, then the bar, no blank line
  // held between them (the "none left" line is held only under a list).
  {
    name: "setup-4-first-review-empty",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      // Shown by its name alone under its account's head, a repository is named in full.
      await p.getByLabel(/^sasensi\/ledger-api,/).uncheck();
      await button(p, "Continue").click();
      await p.getByText("No open pull request in the repositories you picked.", { exact: false }).waitFor();
    },
  },
  {
    name: "setup-4-first-review",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Review this pull request").click();
      await demo.advance(5 * MIN);
      await p.getByText("Done in").waitFor();
    },
  },
  // "Don't start at login" clicked on the last step (ADR 0054): the line under the footer says what to run after a
  // login, and the footer's buttons stay where they were (ADR 0086).
  {
    name: "setup-5-agent-no-start-at-login",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await startAtLoginStays(p);
    },
  },
  // Another Lookover holds start at login (ADR 0068): the last step says this one won't start, with its command, and
  // where to change that; the finish leaves the other's alone.
  {
    name: "setup-5-agent-login-taken",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    inject: ["login-taken"],
    act: setupUntilAgent,
  },
  // Taken, then "Don't start at login": the line under the footer changes, the buttons where they were.
  {
    name: "setup-5-agent-login-taken-off",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    inject: ["login-taken"],
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await startAtLoginStays(p);
    },
  },
  // On a phone, reaching the service from another device: looking is free, a change asks to unlock.
  { name: "phone-home", scenario: "S11", phone: true },
  { name: "phone-review", scenario: "S11", phone: true, path: "/reviews/sasensi/lookover-sandbox/180" },
  // Its details open: the Rounds table, who found and checked each round and its tokens, scrolls sideways (ADR 0055).
  {
    name: "phone-review-details-open",
    scenario: "S11",
    phone: true,
    path: "/reviews/sasensi/lookover-sandbox/180",
    // Scrolled to the table, which is scrolled to its end: a phone's full page would draw the tab bar over it, and
    // its last columns are the new ones.
    act: async (p) => {
      await button(p, "How this review ran").click();
      await button(p, "Rounds").click();
      await p.locator(".tbl-wrap").evaluate((wrap) => {
        wrap.scrollIntoView({ block: "center" });
        wrap.scrollLeft = wrap.scrollWidth;
      });
    },
  },
  {
    name: "phone-unlock",
    scenario: "S11",
    phone: true,
    path: "/reviews/sasensi/lookover-sandbox/180",
    act: async (p) => {
      await button(p, "Review again").click();
      await p.getByText("Unlock to make changes?").waitFor();
    },
  },
  // The developer's own pages
  { name: "drawer", scenario: "S3", drawer: true },
  { name: "how-to-try", scenario: "S10", path: "/try", screen: ".page" },
  // S14, the planted sandbox: round 1 under way at the load.
  { name: "service-home", scenario: "S14", path: "/" },
  { name: "service-drawer", scenario: "S14", path: "/", drawer: true },
  {
    name: "service-palette",
    scenario: "S14",
    path: "/",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.getByText("Add unpaid filter").first().waitFor();
    },
  },
  { name: "service-all-reviews", scenario: "S14", path: "/reviews" },
  { name: "service-review-running", scenario: "S14", path: PLANTED },
  // Details › Log open in round 1's find: Claude's recorded tool calls (ADR 0055).
  { name: "service-review-running-log", scenario: "S14", path: PLANTED, fullPage: true, act: openLog },
  {
    // The same page, Log still open, just after round 1 ends: the live log's block holds its height.
    name: "service-review-ended-log",
    scenario: "S14",
    path: PLANTED,
    fullPage: true,
    // Its act moves the clock: a load of its own, so the shots of S14 at load still show round 1 running.
    alone: true,
    act: async (p, demo) => {
      await openLog(p);
      await demo.advance(MIN);
    },
  },
  {
    // A settings save the service refuses, its file held open by another program (the drawer's "Settings can't be
    // saved"): the stamp goes, the band's Refused line and the toast say why.
    name: "service-refused",
    scenario: "S14",
    path: "/settings",
    inject: ["settings-unwritable"],
    console: REFUSED_COMMAND,
    act: async (p) => {
      await p.getByLabel("Again after every push", { exact: true }).click();
      await p.getByText("Refused", { exact: true }).first().waitFor();
    },
  },
  // A tab without the session (401, #68): the session screen in place of the app, with the program's sentence: S14
  // plants the binary's command, which the 401 names (ADR 0058).
  {
    name: "service-session",
    scenario: "S14",
    path: "/",
    noSession: true,
    // The snapshot's answer, and the event stream's when it opens before the app stops.
    console: [failedLoad(401, API.snapshot, API.events)],
  },
  // Round 1 posted: F1 blocking confirmed, F2 unsure, one candidate ruled out by Codex.
  { name: "service-review-round-1", scenario: "S14", path: PLANTED, advance: ROUND_1, fullPage: true },
  {
    // Who found, who double-checked and what was ruled out (ADR 0044).
    name: "service-review-round-1-details",
    scenario: "S14",
    path: PLANTED,
    advance: ROUND_1,
    fullPage: true,
    act: (p) => button(p, "How this review ran").click(),
  },
  { name: "service-github-round-1", scenario: "S14", path: PLANTED_GITHUB, advance: ROUND_1, fullPage: true },
  { name: "service-home-round-1", scenario: "S14", path: "/", advance: ROUND_1 },
  { name: "service-review-pushed", scenario: "S14", path: PLANTED, advance: PUSHED },
  // Round 2: F1 verified fixed, F2 still open, F3 found.
  { name: "service-review-round-2", scenario: "S14", path: PLANTED, advance: ROUND_2, fullPage: true },
  { name: "service-github-round-2", scenario: "S14", path: PLANTED_GITHUB, advance: ROUND_2, fullPage: true },
  { name: "service-home-round-2", scenario: "S14", path: "/", advance: ROUND_2 },
  { name: "service-phone-review-round-2", scenario: "S14", path: PLANTED, advance: ROUND_2, phone: true },
  // Pull request #2 closed on GitHub: the poll sees it gone, and it leaves the list (ADR 0043).
  { name: "service-home-closed", scenario: "S14", path: "/", advance: CLOSED },
  { name: "service-all-reviews-closed", scenario: "S14", path: "/reviews", advance: CLOSED },
  // Reviews paused for an hour, then "Review now": the review waits for the resume (ADR 0040).
  { name: "service-home-paused", scenario: "S14", path: "/", advance: PAUSED },
  { name: "service-review-paused", scenario: "S14", path: PLANTED, advance: PAUSED },
  {
    name: "service-status-paused",
    scenario: "S14",
    path: "/",
    advance: PAUSED,
    act: (p) => button(p, "Paused").click(),
  },
  // A newer Codex fails Lookover's self-test (ADR 0044): the banner, then the status menu.
  {
    name: "service-home-failed-self-test",
    scenario: "S14",
    path: "/",
    advance: PAUSED,
    inject: ["codex-failed-self-test"],
  },
  {
    name: "service-status-failed-self-test",
    scenario: "S14",
    path: "/",
    advance: PAUSED,
    inject: ["codex-failed-self-test"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  // Your coding agent, setup's last step (ADR 0058): fresh after a posted first review (the binary off the PATH, both
  // agents found, Try it naming #148), then Claude Code's skill installed, then the PATH added (each row keeps its
  // height, so nothing under it moves), then a write the computer refuses, then
  // after a preview, which posted nothing for the agent to read.
  {
    name: "setup-5-agent",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: setupUntilAgent,
  },
  {
    name: "setup-5-agent-skill-installed",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await button(p, "Install the skill").click();
      // Claude Code's row says its skill is in.
      await p.getByText("which calls this Lookover, is in").first().waitFor();
    },
  },
  {
    name: "setup-5-agent-path-added",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await addToPathStays(p, () => p.getByText("A terminal runs this Lookover as:").waitFor());
    },
  },
  {
    name: "setup-5-agent-refused",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    inject: ["path-refused"],
    console: REFUSED_COMMAND,
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await addToPathStays(
        p,
        () =>
          p
            .locator(".agent-row.mark-refused > .substep-detail")
            .getByText("This computer refused to change your PATH.")
            .waitFor(),
        { refused: true },
      );
    },
  },
  {
    name: "setup-5-agent-after-preview",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Preview here only, post nothing").click();
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await p.getByText("Your first review was a preview").waitFor();
    },
  },
  // #148 previewed as the first review, then #152, opened while it runs, reviewed by itself and posted clean (once a
  // review is posted, First review offers no preview, ADR 0072): Try it names #152 and says `wait` reports a pass
  // (#459), not that the first review was a preview.
  {
    name: "setup-5-agent-after-preview-posted",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Continue").click();
      await button(p, "Preview here only, post nothing").click();
      await demo.inject("agent-opens-change");
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await p.getByText("Get pull request #152 of sasensi/ledger-api through Lookover's review.").waitFor();
      // Try it says the clean pull request's next step, its command on a line of its own.
      await p.locator(".try-next").getByText("Lookover found nothing to fix there").waitFor();
    },
  },
  // Settings › Your coding agent (ADR 0058): the setup step's rows, read again when shown. Fresh (the binary off the
  // PATH, no skill yet), then each row done offering its undo, then a write the computer refuses, said
  // on its row.
  {
    name: "settings-agent",
    scenario: "S10",
    path: "/settings#agent",
    act: toAgent,
  },
  // Opened at Your coding agent while `gh` is slow (ADR 0091, #655): the label lands at the top bar's line, then the
  // organisations arrive 30 s on and the GitHub card above grows by their rows; the label is still on that line. Then
  // a wheel gives the page back: shot 120 px up from the line, where the person left it.
  {
    name: "settings-agent-gh-slow",
    scenario: "S16",
    path: "/settings#agent",
    alone: true,
    inject: ["gh-slow"],
    act: async (p, demo) => {
      await toAgent(p);
      const list = p.locator(".accounts-list");
      if (await list.getByText("ledger-hq", { exact: true }).isVisible())
        throw new Error("gh named the organisations before the page landed");
      // Chromium anchors the scroll to what is under the bar, which would hide a landing not kept; not every browser
      // does (ADR 0091), so the shot proves the app's own.
      await p.evaluate(() => {
        document.documentElement.style.overflowAnchor = "none";
        document.body.style.overflowAnchor = "none";
      });
      const before = await list.boundingBox();
      await demo.advance(30_000);
      await list.getByText("ledger-hq", { exact: true }).waitFor();
      const after = await list.boundingBox();
      if (!before || !after || after.height <= before.height)
        throw new Error(`GitHub's list didn't grow as gh answered: ${JSON.stringify({ before, after })}`);
      await scrollAtRest(p);
      await landedUnderTopBar(p, "agent");
      // The person's wheel gives the page back: the page growing again above the label (a block put in by hand, as
      // the hold is over) moves it down with what is above, no landing again.
      await p.mouse.move(640, 400);
      await p.mouse.wheel(0, -120);
      await scrollAtRest(p);
      const labelTop = () =>
        p.evaluate(
          () =>
            document
              .getElementById("agent")
              ?.closest("[data-landing]")
              ?.querySelector(":scope > h4")
              ?.getBoundingClientRect().top ?? Number.NaN,
        );
      const wheeled = await labelTop();
      await p.evaluate(() => {
        const grown = document.createElement("div");
        grown.id = "proof-grown";
        grown.style.height = "200px";
        document.querySelector("main")?.prepend(grown);
      });
      await scrollAtRest(p);
      const grown = await labelTop();
      await p.evaluate(() => document.getElementById("proof-grown")?.remove());
      await scrollAtRest(p);
      // Down by the block and the page's gap before it; landed again, it would be back up on the top bar's line.
      if (grown - wheeled < 200)
        throw new Error(
          `After the wheel, the page growing moved the label ${grown - wheeled} px, not 200 or more: landed again`,
        );
    },
  },
  {
    name: "settings-agent-done",
    scenario: "S10",
    path: "/settings#agent",
    alone: true,
    act: async (p) => {
      await toAgent(p);
      await addToPathStays(p, () => button(p, "Remove from my PATH").waitFor());
      await button(p, "Install the skill").click();
      await button(p, "Remove the skill").waitFor();
    },
  },
  {
    name: "settings-agent-refused",
    scenario: "S10",
    path: "/settings#agent",
    alone: true,
    inject: ["path-refused"],
    console: REFUSED_COMMAND,
    act: async (p) => {
      await toAgent(p);
      await addToPathStays(
        p,
        () =>
          p
            .locator(".agent-row.mark-refused > .substep-detail")
            .getByText("This computer refused to change your PATH.")
            .waitFor(),
        { refused: true },
      );
    },
  },
  {
    name: "settings-agent-stale",
    scenario: "S10",
    path: "/settings#agent",
    alone: true,
    inject: ["launcher-stale"],
    act: async (p) => {
      await toAgent(p);
      await button(p, "Point it at this Lookover").waitFor();
    },
  },
  // An npm install (ADR 0061): npm put `lookover` on the PATH, so the row says so and offers nothing.
  {
    name: "settings-agent-npm",
    scenario: "S10",
    path: "/settings#agent",
    alone: true,
    inject: ["npm-install"],
    act: async (p) => {
      await toAgent(p);
      await p.getByText("npm put it on your PATH").waitFor();
    },
  },
  // npm's folder off the PATH (a Node installed without it): said with that folder, nothing offered.
  {
    name: "settings-agent-npm-off-path",
    scenario: "S10",
    path: "/settings#agent",
    alone: true,
    inject: ["npm-off-path"],
    act: async (p) => {
      await toAgent(p);
      await p.getByText("then open a new terminal").waitFor();
    },
  },
  // Setup's last step on an npm install: the PATH row says npm put it there, and offers nothing.
  {
    name: "setup-5-agent-npm",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    inject: ["npm-install"],
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await p.getByText("npm put it on your PATH").waitFor();
    },
  },
  // Frames shots (ADR 0087): each motion stopped at fixed times from its start to its end, into a strip per theme.
  // A repository's switch flipped off: the knob slides, the track takes the off colour.
  {
    name: "frames-switch",
    scenario: "S9",
    path: "/repositories",
    alone: true,
    // The Reviewing column: the repository's switch and its account's under the head.
    frames: { around: ".tbl.repos :is(td, th):has(.switch)" },
    act: (p) =>
      p
        .locator("label.switch")
        .filter({ has: p.getByRole("switch", { name: "Review sasensi/lookover-sandbox" }) })
        .click(),
  },
  // A review's "How this review ran" opening: the chevron turns, the content slides open.
  {
    name: "frames-disclosure",
    scenario: "S10",
    path: "/reviews/sasensi/lookover-sandbox/146",
    frames: { around: ".disc.open" },
    act: async (p) => {
      // Its button a little under the top bar, so what opens under it shows whole.
      await button(p, "How this review ran").evaluate((b) =>
        window.scrollTo({ top: b.getBoundingClientRect().top + window.scrollY - 120, behavior: "instant" }),
      );
      await button(p, "How this review ran").click();
    },
  },
  // The status menu opening from the pill: the menu comes down, the page under the top bar dims.
  {
    name: "frames-status-menu",
    scenario: "S12",
    frames: { around: ".anchor:has(> .layer), .layer" },
    act: (p) => button(p, "Claude needs attention").click(),
  },
  // The status menu closing by Esc (the presence, #699): focus is back on the pill at once, the menu and the scrim
  // fade out, easing in, and are gone at the end.
  {
    name: "frames-status-menu-closing",
    scenario: "S12",
    frames: { around: ".anchor:has(> .layer), .layer" },
    act: async (p) => {
      await button(p, "Claude needs attention").click();
      await p.keyboard.press("Escape");
    },
  },
  // A toast leaving when its 5 s are up: back out to the right, the way it came. Under reduced motion it is gone at
  // once, so the act waits for no toast left that isn't leaving, which both read.
  {
    name: "frames-toast-leaving",
    scenario: "S14",
    path: "/settings",
    inject: ["settings-unwritable"],
    console: REFUSED_COMMAND,
    frames: { around: ".toasts" },
    act: async (p) => {
      await p.getByLabel("Again after every push", { exact: true }).click();
      await p.locator(".toast").waitFor({ state: "attached" });
      await p.waitForFunction(() => document.querySelector(".toast:not(.leaving)") === null, null, {
        timeout: 8000,
      });
    },
  },
  // Dialogs (ADR 0087 "A dialog closes at once", #700). The palette opening: it rises in, the page dims.
  {
    name: "frames-palette-opening",
    scenario: "S12",
    frames: { around: "dialog.cmdk" },
    act: (p) => p.keyboard.press("Control+k"),
  },
  // The palette closing by Esc: closed at once, focus back where it was and the page under it live, while it and its
  // backdrop fade out, easing in. The whole window: at the fade's end the dialog is no longer displayed, so it has no
  // box to frame, and the backdrop's fade is the page's.
  {
    name: "frames-palette-closing",
    scenario: "S12",
    frames: {},
    act: paletteClosesAtOnce,
  },
  // Opened again while it fades: shown as on any opening, its input taking the keys.
  {
    name: "palette-reopened",
    scenario: "S12",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.locator("dialog.cmdk[open]").waitFor();
      await p.keyboard.press("Escape");
      // The app heard the close a task later: the old palette is fading when it is asked for again.
      await p.locator("dialog.cmdk[data-leaving]").waitFor({ state: "attached" });
      await p.keyboard.press("Control+k");
      const typed = await p
        .locator("dialog.cmdk[open] input")
        .evaluate((input) => document.activeElement === input);
      if (!typed)
        throw new Error("The palette opened again during its fade, but its input doesn't have focus");
      await paletteShowsWholeRows(p);
    },
  },
  // A review's steps (#703): the page opens on #148's round 1 with Codex finding, still; the clock moves on past
  // the find, and its eyes give way to the check while the double-check's dot gives way to the eyes, each a fade and
  // a scale from .9. The words and the times change in place.
  {
    name: "frames-step-advancing",
    scenario: "S2",
    path: "/reviews/sasensi/ledger-api/148",
    advance: MIN,
    alone: true,
    frames: { around: ".running" },
    act: async (p, demo) => {
      await p.locator(".steplist li.active .step-mark:not([data-arrived])").waitFor();
      await demo.advance(100 * SEC);
      await p.locator(".steplist li.done .step-mark[data-arrived]").waitFor();
      await p.locator(".steplist li.active .step-mark[data-arrived]").waitFor();
    },
  },
  // The page opens on #148's round 1 double-checking; the clock moves on past its end, and the verdict takes the
  // Running card's place, coming in like a section.
  {
    name: "frames-verdict-arriving",
    scenario: "S2",
    path: "/reviews/sasensi/ledger-api/148",
    advance: 3 * MIN,
    alone: true,
    frames: { around: ".verdict" },
    act: async (p, demo) => {
      await p.locator(".running").waitFor();
      await demo.advance(2 * MIN);
      await p.locator(".verdict[data-arrived]").waitFor();
    },
  },
  // A group folding by its rows (#701): ledger-dev's three on Repositories leave, falling 4 px as they fade, and the
  // group closes up at the end; opened again, they rise in. Then setup's checklist, the same.
  {
    name: "frames-repositories-folding",
    scenario: "S18",
    path: "/repositories",
    frames: { around: groupOf("tbody", "ledger-dev") },
    act: async (p) => {
      await headNearTop(p, "ledger-dev");
      await chevron(p, "ledger-dev", true).click();
    },
  },
  {
    name: "frames-repositories-unfolding",
    scenario: "S18",
    path: "/repositories",
    frames: { around: groupOf("tbody", "ledger-dev") },
    act: async (p) => {
      await headNearTop(p, "ledger-dev");
      await foldAway(p, "ledger-dev", `${groupOf("tbody", "ledger-dev")} .fold-row`);
      await chevron(p, "ledger-dev", false).click();
    },
  },
  {
    name: "frames-setup-repos-folding",
    scenario: "S19",
    screen: ".setup",
    frames: { around: groupOf(".checklist-group", "ledger-dev") },
    act: async (p) => {
      await headNearTop(p, "ledger-dev");
      await chevron(p, "ledger-dev", true).click();
    },
  },
  {
    name: "frames-setup-repos-unfolding",
    scenario: "S19",
    screen: ".setup",
    frames: { around: groupOf(".checklist-group", "ledger-dev") },
    act: async (p) => {
      await headNearTop(p, "ledger-dev");
      await foldAway(p, "ledger-dev", `${groupOf(".checklist-group", "ledger-dev")} .fold-row`);
      await chevron(p, "ledger-dev", false).click();
    },
  },
  // An account arriving in setup's accounts list (#713): ledger-hq asked, an owner installs there and Lookover lists
  // it at once (S17's owner-installs); its row leaves the part not reached and fades in, dropping 6 px into place, at its new place
  // among the accounts reached. The rows around it change nothing. Under reduced motion it is there at once.
  {
    name: "frames-account-arriving",
    scenario: "S17",
    screen: ".setup",
    alone: true,
    frames: { around: ".accounts-list" },
    act: async (p, demo) => {
      await askToInstallOnLedgerHq(p);
      // The pointer off the list, so no row's hover joins the motion.
      await p.mouse.move(0, 0);
      await demo.inject("owner-installs");
      await p.locator(".account-row[data-arrived]", { hasText: "ledger-hq" }).waitFor();
    },
  },
  // Rows and notices leaving (#702). A review ending on Home: #192's row leaves Reviewing now, the section with its
  // last row, and rises in where it lands. The act waits for the row in its new section, which both motion and
  // reduced motion show.
  {
    name: "frames-row-moving",
    scenario: "S12",
    alone: true,
    frames: { around: ".page > .grp" },
    act: async (p, demo) => {
      await demo.advance(5 * MIN);
      await p
        .locator(".grp:not(.leaving)")
        .filter({ hasNot: p.locator("h4", { hasText: "Reviewing now" }) })
        .locator(".rowi", { hasText: "Kinder words in the payment reminder" })
        .waitFor();
    },
  },
  // A departed notice dismissed: fernhill's summary, Dismiss all, fades out; ledger-labs' No access stays.
  {
    name: "frames-notice-dismissed",
    scenario: "S18",
    path: "/repositories",
    alone: true,
    frames: { around: ".departed" },
    act: (p) => button(p, "Dismiss all").click(),
  },
  // A line of the alert band leaving: the refused command's line dismissed by its ×, Claude's line staying.
  {
    name: "frames-alert-line-leaving",
    scenario: "S12",
    path: "/settings",
    alone: true,
    inject: ["settings-unwritable"],
    console: REFUSED_COMMAND,
    frames: { around: ".alerts" },
    act: async (p) => {
      await p.getByLabel("Again after every push", { exact: true }).click();
      await p.locator(".alert.refused").getByRole("button", { name: "Dismiss" }).click();
    },
  },
];

/** `account`'s group, as `element` (Repositories' `tbody`, setup's `.checklist-group`): the one holding its chevron. */
function groupOf(element: string, account: string): string {
  return `${element}:has(button[aria-label="${account}'s repositories"])`;
}

/** `account`'s chevron, open or folded. */
const chevron = (p: Page, account: string, expanded: boolean) =>
  p.getByRole("button", { name: `${account}'s repositories`, expanded });

/** `account`'s head a little under the top bar, the pointer off the rows: its group shows whole. */
async function headNearTop(p: Page, account: string) {
  await chevron(p, account, true).evaluate((head) =>
    window.scrollTo({ top: head.getBoundingClientRect().top + window.scrollY - 160, behavior: "instant" }),
  );
  await p.mouse.move(0, 0);
}

/**
 * Folds `account`'s group and lets its rows leave, the page's timeline standing still for the frames: their exit (and
 * the chevron's turn) finished by hand, then nothing matches `rows`. Under reduced motion nothing runs: gone at once.
 */
async function foldAway(p: Page, account: string, rows: string) {
  await chevron(p, account, true).click();
  await p.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
  });
  await p.waitForFunction((selector) => document.querySelector(selector) === null, rows);
}

/**
 * The palette, opened from the top bar's Reviews link, closed by Esc: fails unless focus is back on the link at once
 * and the page under the dialog takes a click while the dialog still shows, fading. Its entry is played to its end
 * first: the frames shot's timeline stands still from before the act, and a fade started mid-entry would start from
 * its first frame, where the dialog is not yet shown.
 */
async function paletteClosesAtOnce(page: Page) {
  const reviews = page.locator(".navtop a", { hasText: "Reviews" }).first();
  await reviews.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.locator("dialog.cmdk[open]");
  await dialog.waitFor();
  await page.evaluate(() => {
    for (const a of document.getAnimations())
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
  });
  const box = await dialog.boundingBox();
  await page.keyboard.press("Escape");
  const back = await reviews.evaluate((link) => document.activeElement === link);
  if (!back)
    throw new Error("Esc closed the palette, but focus isn't back on the Reviews link it was opened from");
  if (!box) throw new Error("The palette had no box on screen");
  const under = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit === null ? "nothing" : hit.closest("dialog") ? "the dialog" : null;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  if (under)
    throw new Error(`The palette is closed, but a click at its centre lands on ${under}, not the page`);
  // The app heard the close (the dialog's close event comes a task after it): the presence holds it, leaving, before
  // proof pauses its fade. Only under reduced motion may it be gone at once: anywhere else, a palette gone without
  // its leaving mark is a fade that never started, and the strip would show no palette at all.
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (reduced) {
    await page.waitForFunction(() => document.querySelector("dialog.cmdk:not([data-leaving])") === null);
    return;
  }
  const leaving = await page
    .locator("dialog.cmdk[data-leaving]")
    .waitFor({ state: "attached", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!leaving) throw new Error("Esc closed the palette, but it never faded: it left with no leaving mark");
}

/**
 * The shots also taken at 1024 and 1440 px wide (ADR 0086): what a held width does with a long name or a short line
 * shows at the window's width, not at proof's 1180 alone. Each is named `<shot>-<width>`.
 */
const WIDE = [
  "repositories-org",
  "repositories-names",
  "settings-github-names",
  "settings-agent",
  "review-posting-longest",
  "setup-github-names",
  "setup-github-signed-in-looking",
  "settings-github-look-looking",
  "settings-github-look-arrived",
  "settings-github-look-nothing",
  "setup-github-look-looking",
  "setup-github-look-arrived",
  "setup-github-look-nothing",
  "repositories-look-looking",
  "repositories-look-arrived",
  "settings-github-approved-later",
] as const;

/** `name`'s shot at each of the two widths. */
function atWidths(name: string): Shot[] {
  const shot = LISTED.find((s) => s.name === name);
  if (shot === undefined) throw new Error(`No shot ${name} to take at other widths`);
  return WIDTHS.map((width) => ({ ...shot, name: `${name}-${width}`, width }));
}

export const SHOTS: Shot[] = [...LISTED, ...WIDE.flatMap(atWidths)];
