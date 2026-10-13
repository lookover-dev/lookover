// What `bun run proof` shoots (the harness is scripts/proof.ts): the app on the service in demo mode (ADR 0046),
// the scripted GitHub and engines, no network. Each shot names the world it needs: a scenario loaded
// (`demo.load`, the clock standing still at the fixed instant once its seed is played), the clock moved on
// (`demo.advance`), faults made to happen (`demo.inject`). Then the page opens, its act runs, and it is shot.
// Shots of the same world share one load; a shot whose act changes what the service holds (`alone`) gets a load
// of its own. Each shot lands on the screen its path routes to, or the one it names (`screen`): a shot that lands
// elsewhere (the session screen, the setup in place of the app, "No such pull request") fails.
import { APP_FLOW, type ConnectionCause, DEMO_API, type FaultId } from "@lookover/contracts";
import { HANDED_APP, MADE_APP, REFUSED_PAGES } from "@lookover/service";
import type { Page } from "playwright";

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
  phone?: boolean;
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
}

/**
 * The app's routes (apps/web/src/app.tsx: proof-shots.test.ts keeps the two lists the same) and the screen each
 * shows, as its page marks itself (`data-screen`).
 * A page that found nothing ("No such pull request") carries no mark, and neither does Home in place of a path
 * the app doesn't route (it falls back to Home), so neither passes as the screen a shot asked for.
 */
export const ROUTES: [RegExp, string][] = [
  [/^\/$/, '[data-screen="home"]'],
  [/^\/reviews$/, '[data-screen="reviews"]'],
  [/^\/reviews\/[^/]+\/\d+$/, '[data-screen="review"]'],
  [/^\/repositories$/, '[data-screen="repositories"]'],
  [/^\/repositories\/[^/]+$/, '[data-screen="repository"]'],
  [/^\/settings$/, '[data-screen="settings"]'],
  [/^\/settings\/[^/]+$/, '[data-screen="settings-section"]'],
  [/^\/logs$/, '[data-screen="logs"]'],
  // Only a pull request GitHub holds has the page, not the strip shown for a number it doesn't know.
  [/^\/github\/[^/]+\/\d+$/, ".gh .gh-page"],
];

/** The screen a shot must land on: the one it names, the session screen, or the one its path routes to. */
export function screenOf(shot: Shot): string {
  if (shot.screen) return shot.screen;
  if (shot.noSession) return ".session";
  const path = shot.path ?? "/";
  const route = ROUTES.find(([pattern]) => pattern.test(path));
  if (!route) throw new Error(`${shot.name}: the app routes no screen at ${path}`);
  return route[1];
}

const SEC = 1_000;
const MIN = 60_000;
const button = (page: Page, name: string) => page.getByRole("button", { name }).first();
/** Opens Details › Log on a review page: its history, then the live log (ADR 0055). */
const openLog = (page: Page) => page.getByRole("button", { name: /^Log/ }).first().click();
/** A link that opens a page in a new tab: "Create it on GitHub" (ADR 0053). */
const link = (page: Page, name: string) => page.getByRole("link", { name }).first();

/** "Too noisy?" on the finding card whose title holds `title`. */
const tooNoisy = (page: Page, title: string) =>
  page.locator(".card.finding", { hasText: title }).getByRole("button", { name: "Too noisy?" });

/** S1 from Codex signed out to both AIs ready: Codex signed in; the step says so and waits for Continue (ADR 0058). */
async function setupUntilBothReady(page: Page, demo: Demo) {
  await button(page, "Sign in in a terminal").click();
  // The scripted Codex is signed in 5 s on.
  await demo.advance(5 * SEC);
  await page.getByText("Both are ready.").waitFor();
  // The step used to move on by itself 1.4 s later, on the page's own timer: wait past it and see it still here.
  await page.waitForTimeout(2 * SEC);
  if (!(await page.getByText("Both are ready.").isVisible()) || !(await button(page, "Continue").isVisible()))
    throw new Error("The AI step moved on by itself: setup waits for Continue (ADR 0058).");
}

/** S1 on to the GitHub step: both AIs ready, then Continue. */
async function setupUntilGitHub(page: Page, demo: Demo) {
  await setupUntilBothReady(page, demo);
  await button(page, "Continue").click();
  await link(page, "Create it on GitHub").waitFor();
}

/**
 * S1's "Create it on GitHub" (ADR 0053): its page opens in a new tab and posts the manifest to GitHub's fake "new App"
 * page, which makes the App at once; GitHub's redirect brings the tab back to the service, which keeps the App and
 * sends the tab on to the App's install page. The tab, there.
 */
async function createApp(page: Page): Promise<Page> {
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    link(page, "Create it on GitHub").click(),
  ]);
  await tab.getByRole("button", { name: "Install" }).waitFor();
  return tab;
}

/**
 * S15's "Create it on GitHub" on ledger-dev (ADR 0059): the organisation picked, its tab opened once the service took
 * it, GitHub's fake making the App on the organisation's page and sending the tab on to its install page. The tab,
 * there.
 */
async function createOnOrganisation(page: Page): Promise<Page> {
  await page.getByLabel("ledger-dev").check();
  return createApp(page);
}

/**
 * "Advanced: use an existing App" opened on the GitHub step, the App id given and a file chosen (`text` its words): the
 * App made before (on another computer, or by S15's ledger-dev admin) is `MADE_APP`, id 1, the one ledger-co's admin
 * handed over (ADR 0059) `HANDED_APP`, id 7.
 */
async function useExistingApp(page: Page, file: string, text: string, id = 1) {
  await button(page, "Advanced: use an existing App").click();
  await page.getByLabel("App id").fill(String(id));
  await page
    .locator(".use-app input[type=file]")
    .setInputFiles({ name: file, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
  await page.getByText(file).waitFor();
}

/**
 * S1 until the GitHub step is done: the App made, installed on GitHub's fake install page and found 4 s on; the step
 * waits for Continue (ADR 0058).
 */
async function setupUntilInstalled(page: Page, demo: Demo) {
  await setupUntilGitHub(page, demo);
  const tab = await createApp(page);
  await tab.getByRole("button", { name: "Install" }).click();
  await tab.getByText("Lookover is installed").waitFor();
  await tab.close();
  await demo.advance(4 * SEC);
  await page.getByText("GitHub is connected.").waitFor();
}

/**
 * S15 set up on ledger-dev to the end (ADR 0059): the App made and installed on the organisation, its repositories
 * taken, the owner's #148 reviewed, then Home.
 */
async function setUpOnOrganisation(page: Page, demo: Demo) {
  const tab = await createOnOrganisation(page);
  await tab.getByRole("button", { name: "Install" }).click();
  await tab.getByText("Lookover is installed").waitFor();
  await tab.close();
  await demo.advance(4 * SEC);
  await button(page, "Continue").click();
  await page.getByText("Pick the repositories to review.").waitFor();
  await button(page, "Continue").click();
  await button(page, "Review this pull request").click();
  await demo.advance(5 * MIN);
  await button(page, "Continue").click();
  await button(page, "Go to my reviews").click();
  await page.locator('[data-screen="home"]').waitFor();
}

/** S1 on to the repositories step: the GitHub step done, then Continue. */
async function setupUntilRepositories(page: Page, demo: Demo) {
  await setupUntilInstalled(page, demo);
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

/**
 * The tab GitHub sends back once the App is installed (ADR 0058): it arrives from another site, as from github.com
 * (a page of an address no service has, answered by the browser itself), on the installed page, carrying no session
 * cookie (`SameSite=Strict`); then Back to setup, a same-site navigation that carries it, lands on setup, never on the
 * session screen. Each navigation's own request headers say so: the page's own requests carry the cookie anyway.
 */
async function backToSetupFromGitHub(page: Page) {
  // Plain HTTP, as the app is: from HTTPS, the browser would send no referrer to say where the tab came from.
  const github = "http://github.example/apps/lookover/installations/new";
  const installed = new URL(`${APP_FLOW.installed}?installation_id=1&setup_action=install`, page.url()).href;
  const setup = new URL("/", page.url()).href;
  const session = (await page.context().cookies(setup)).find((c) => c.sameSite === "Strict" && c.httpOnly);
  if (session === undefined) throw new Error("The app holds no session cookie to go with the click");
  const sent = `${session.name}=${session.value}`;
  /**
   * The cookie and referer headers the navigation to `url` carried, once `act` makes it, as the browser sent them
   * (Playwright shows no `Sec-Fetch-Site`: the referer says where a navigation came from).
   */
  const headersOf = async (url: string, act: () => Promise<void>) => {
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url() === url && r.isNavigationRequest()),
      act(),
    ]);
    const headers = await request.allHeaders();
    return { cookie: headers.cookie ?? "", from: headers.referer ?? "" };
  };
  await page.route(github, (route) =>
    route.fulfill({ contentType: "text/html", body: `<a href="${installed}">Back to Lookover</a>` }),
  );
  await page.goto(github);
  const arrived = await headersOf(installed, () => link(page, "Back to Lookover").click());
  await page.getByText("Lookover is installed").waitFor();
  if (arrived.cookie.includes(sent) || arrived.from !== `${new URL(github).origin}/`)
    throw new Error(`The installed page wasn't reached as from another site: ${JSON.stringify(arrived)}`);
  const back = await headersOf(setup, () => link(page, "Back to setup").click());
  if (!back.cookie.includes(sent))
    throw new Error(`Back to setup didn't carry the session cookie: ${JSON.stringify(back)}`);
  await page.locator(".setup").waitFor();
  if ((await page.locator(".session").count()) > 0)
    throw new Error("Back to setup reached the session screen");
}

/** Each way the connection can't be used (ADR 0053), as the drawer makes it happen, and the pill it shows. */
interface CauseShot {
  /** The shots' names: `home-<name>` and `status-pill-<name>`. */
  name: string;
  pill: string;
  scenario: string;
  advance?: number;
  inject?: FaultId[];
  /**
   * What happens once the page is open, before the shot (the pill clicked after it): S15 set up on ledger-dev, then
   * its fault. Such a shot is `alone`, opening on the setup.
   */
  setUp?: (page: Page, demo: Demo) => Promise<void>;
}

/** S15 set up on ledger-dev (ADR 0059), then `fault` made to happen: the cause in the organisation's words. */
const onLedgerDev =
  (fault: FaultId) =>
  async (page: Page, demo: Demo): Promise<void> => {
    await setUpOnOrganisation(page, demo);
    await demo.inject(fault);
  };

/** By the cause's kind, so a new cause can't go without its shots. */
const CAUSES = {
  // S13 a minute on: GitHub out of reach.
  unreachable: [{ name: "github-down", pill: "GitHub unreachable", scenario: "S13", advance: MIN }],
  uninstalled: [
    { name: "app-uninstalled", pill: "GitHub App uninstalled", scenario: "S10", inject: ["app-uninstalled"] },
    { name: "app-suspended", pill: "GitHub App suspended", scenario: "S10", inject: ["app-suspended"] },
    // An organisation's App: its admins reinstall or unsuspend it.
    {
      name: "app-uninstalled-organisation",
      pill: "GitHub App uninstalled",
      scenario: "S15",
      setUp: onLedgerDev("app-uninstalled"),
    },
    {
      name: "app-suspended-organisation",
      pill: "GitHub App suspended",
      scenario: "S15",
      setUp: onLedgerDev("app-suspended"),
    },
  ],
  "key-refused": [
    { name: "key-refused", pill: "GitHub key refused", scenario: "S10", inject: ["key-refused"] },
    {
      name: "key-refused-organisation",
      pill: "GitHub key refused",
      scenario: "S15",
      setUp: onLedgerDev("key-refused"),
    },
  ],
  "key-lost": [{ name: "key-lost", pill: "GitHub key lost", scenario: "S10", inject: ["key-lost"] }],
  // The person removed from ledger-dev: reviews stop until an admin adds them back and they check again.
  "not-a-member": [
    {
      name: "not-a-member",
      pill: "GitHub membership lost",
      scenario: "S15",
      setUp: onLedgerDev("not-a-member"),
    },
  ],
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
const PLANTED = "/reviews/lookover-sandbox/1";
const PLANTED_GITHUB = "/github/lookover-sandbox/1";
const ROUND_1 = 2 * MIN;
const PUSHED = 3 * MIN;
const ROUND_2 = 5 * MIN;
const CLOSED = 6 * MIN;
const PAUSED = 8 * MIN;

export const SHOTS: Shot[] = [
  // Home
  { name: "home-needs-you", scenario: "S12" },
  { name: "home-quiet", scenario: "S10" },
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
  // GitHub out of reach, the App uninstalled or suspended, its key refused or lost: the band with its one fix, then
  // the status menu.
  ...Object.values(CAUSES).flatMap((shots: CauseShot[]) =>
    shots.flatMap(({ name, pill, setUp, ...world }): Shot[] => {
      const alone = setUp === undefined ? {} : { alone: true, screen: '.setup, [data-screen="home"]' };
      return [
        {
          name: `home-${name}`,
          ...world,
          ...alone,
          act: async (p, demo) => {
            await setUp?.(p, demo);
            await button(p, pill).waitFor();
          },
        },
        {
          name: `status-pill-${name}`,
          ...world,
          ...alone,
          act: async (p, demo) => {
            await setUp?.(p, demo);
            await button(p, pill).click();
          },
        },
      ];
    }),
  ),
  // Both AIs missing too: each with its one fix.
  { name: "home-service-problems", scenario: "S13", advance: 7 * MIN },
  { name: "home-paused-waiting", scenario: "S8", advance: 3 * MIN },
  { name: "home-skipped", scenario: "S5", advance: 2 * MIN },
  { name: "status-pill", scenario: "S12", act: (p) => button(p, "Claude needs attention").click() },
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
  // A Codex version that failed Lookover's self-test (ADR 0044): the banner, then the status menu.
  { name: "home-failed-self-test", scenario: "S10", inject: ["codex-failed-self-test"] },
  {
    name: "status-pill-failed-self-test",
    scenario: "S10",
    inject: ["codex-failed-self-test"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  // A Codex too old for its model: the status menu says so, with the command that updates it, and "Check again".
  {
    name: "status-pill-codex-too-old",
    scenario: "S10",
    inject: ["codex-too-old"],
    act: (p) => button(p, "Codex needs attention").click(),
  },
  { name: "palette", scenario: "S12", act: (p) => p.keyboard.press("Control+k") },
  {
    name: "palette-search",
    scenario: "S12",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.keyboard.type("re");
    },
  },
  { name: "shortcuts", scenario: "S12", act: (p) => p.keyboard.press("?") },
  // A review
  {
    name: "review-to-fix",
    scenario: "S4",
    path: "/reviews/ledger-api/149",
    advance: 4 * MIN,
    fullPage: true,
  },
  // The agent answered the blocking finding "won't fix": round 2 kept it, its reply on the card (ADR 0052).
  {
    name: "review-kept",
    scenario: "S4",
    path: "/reviews/ledger-api/149",
    advance: 8 * MIN,
    fullPage: true,
  },
  // Answered "won't fix" again, round 3 kept it a second time: escalated, it needs the owner.
  {
    name: "review-escalated",
    scenario: "S4",
    path: "/reviews/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
  },
  // On the finding that follows a rule: every choice, "This finding is wrong" first (ADR 0049, ADR 0052).
  {
    name: "review-too-noisy",
    scenario: "S7",
    path: "/reviews/ledger-api/148",
    act: (p) => tooNoisy(p, "The page size is not capped").click(),
  },
  {
    name: "review-too-noisy-wrong",
    scenario: "S7",
    path: "/reviews/ledger-api/148",
    act: async (p) => {
      await tooNoisy(p, "The page size is not capped").click();
      await p.getByRole("button", { name: /This finding is wrong/ }).click();
    },
  },
  {
    name: "review-done-tab",
    scenario: "S2",
    path: "/reviews/ledger-api/148",
    advance: 7 * MIN,
    act: (p) => p.getByRole("tab", { name: /Done/ }).click(),
  },
  // GitHub's limit meets round 1 of #148 while Codex finds: once the round posts, its step says the outbox and the
  // wait (ADR 0055), in the two lines it holds.
  {
    name: "review-posting-wait",
    scenario: "S2",
    path: "/reviews/ledger-api/148",
    advance: MIN,
    inject: ["github-limit"],
    act: (_p, demo) => demo.advance(3 * MIN),
  },
  // The same on a phone: the longest outbox still holds its two lines.
  {
    name: "phone-review-posting-wait",
    scenario: "S2",
    phone: true,
    path: "/reviews/ledger-api/148",
    advance: MIN,
    inject: ["github-limit"],
    act: (_p, demo) => demo.advance(3 * MIN),
  },
  { name: "review-running", scenario: "S3", path: "/reviews/ledger-api/151" },
  // Details › Log open while Claude reads (ADR 0055): the live log under the review's history, newest last.
  {
    name: "review-running-log",
    scenario: "S3",
    path: "/reviews/ledger-api/151",
    fullPage: true,
    act: openLog,
  },
  {
    name: "phone-review-running-log",
    scenario: "S3",
    phone: true,
    path: "/reviews/ledger-api/151",
    // Scrolled to the live log: a phone's full page would draw the tab bar over the middle of it.
    act: async (p) => {
      await openLog(p);
      await p.getByRole("log").first().scrollIntoViewIfNeeded();
    },
  },
  {
    name: "review-details-open",
    scenario: "S4",
    path: "/reviews/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
    act: async (p) => {
      await button(p, "Rounds").click();
      await button(p, "How this review ran").click();
    },
  },
  { name: "review-waiting-limit", path: "/reviews/ledger-api/148", ...CODEX_AT_LIMIT },
  { name: "review-waiting-engine", scenario: "S3", path: "/reviews/ledger-api/151", advance: 2 * MIN },
  { name: "review-paused-review-again", scenario: "S8", path: "/reviews/lookover-sandbox/160" },
  // Resumed, #162 waits its turn and says behind what: both AIs on #161 (ADR 0055).
  {
    name: "review-waiting-turn",
    scenario: "S8",
    path: "/reviews/lookover-sandbox/162",
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
  { name: "phone-review-paused", scenario: "S8", phone: true, path: "/reviews/lookover-sandbox/160" },
  { name: "review-settled", scenario: "S10", path: "/reviews/lookover-sandbox/146", fullPage: true },
  { name: "review-clean", scenario: "S10", path: "/reviews/lookover-sandbox/135" },
  // A finding that follows main's REVIEW.md (ADR 0048): "Why it was raised" names the rule and where it is.
  { name: "review-rule", scenario: "S10", path: "/reviews/lookover-sandbox/139" },
  { name: "review-new-commits", scenario: "S6", path: "/reviews/ledger-api/153", advance: MIN },
  {
    name: "review-skipped",
    scenario: "S10",
    path: "/reviews/lookover-sandbox/137",
    act: (p) => p.getByText("Why wasn't it reviewed?").click(),
  },
  // A colleague's pull request from her fork (ADR 0048): never reviewed by itself; Claude only, when asked.
  {
    name: "review-skipped-fork",
    scenario: "S5",
    path: "/reviews/ledger-api/152",
    advance: 2 * MIN,
    act: (p) => p.getByText("Why wasn't it reviewed?").click(),
  },
  { name: "all-reviews", scenario: "S12", path: "/reviews" },
  // GitHub, as the fake host holds it
  // The agent's reply under the escalated finding's comment; the summary says the owner settles it.
  {
    name: "github-escalated",
    scenario: "S4",
    path: "/github/ledger-api/149",
    advance: 11 * MIN,
    fullPage: true,
  },
  { name: "github-in-progress", scenario: "S2", path: "/github/ledger-api/148", advance: MIN },
  // From round 2 a new Consider is not posted (ADR 0042): round 2's stays in the app.
  { name: "review-not-posted", scenario: "S2", path: "/reviews/ledger-api/148", advance: 7 * MIN },
  {
    name: "github-not-posted",
    scenario: "S2",
    path: "/github/ledger-api/148",
    advance: 7 * MIN,
    fullPage: true,
  },
  {
    name: "github-settled",
    scenario: "S2",
    path: "/github/ledger-api/148",
    advance: 11 * MIN,
    fullPage: true,
  },
  // Settled with round 2's Consider still in the app: the verdict says so, and not that the rest can go.
  { name: "review-settled-kept", scenario: "S2", path: "/reviews/ledger-api/148", advance: 11 * MIN },
  // New commits after the last round have no check until a review is asked for.
  {
    name: "github-new-commits",
    scenario: "S6",
    path: "/github/ledger-api/153",
    advance: MIN,
    fullPage: true,
  },
  // Repositories and settings
  { name: "repositories", scenario: "S9", path: "/repositories" },
  // The App on seven repositories, each watched (ADR 0053).
  { name: "repositories-many", scenario: "S12", path: "/repositories" },
  // Two repositories gone from the installation, each said once above the table until back or dismissed (ADR 0059).
  {
    name: "repositories-departed",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
  },
  // One dismissed: the other is still said.
  {
    name: "repositories-departed-dismissed",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
    alone: true,
    act: async (p) => {
      await p.locator(".banner", { hasText: "dotfiles" }).getByRole("button", { name: "Dismiss" }).click();
      await p.locator(".banner", { hasText: "dotfiles" }).waitFor({ state: "detached" });
    },
  },
  {
    name: "repositories-departed-phone",
    scenario: "S12",
    path: "/repositories",
    inject: ["repository-removed", "repository-removed"],
    phone: true,
  },
  { name: "repository", scenario: "S9", path: "/repositories/lookover-sandbox", fullPage: true },
  {
    name: "repositories-one-off",
    scenario: "S9",
    path: "/repositories",
    alone: true,
    act: (p) => p.locator("tr", { hasText: "lookover-sandbox" }).locator(".switch").click(),
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
    // rule nested in it held off with it, its tooltip saying why.
    act: async (p) => {
      await p.locator("tbody tr", { hasText: "Amounts stay" }).locator(".switch").click();
      await p.getByText("Saved", { exact: true }).waitFor();
      await p.locator("tbody tr").last().locator(".switch").hover();
      await p.getByRole("tooltip", { name: "Off with the rule it sits in." }).waitFor();
    },
  },
  // The key refused: Settings' GitHub group, its App and the slug line, "Use an existing App" open for the new key.
  {
    name: "settings-github",
    scenario: "S10",
    path: "/settings",
    inject: ["key-refused"],
    act: async (p) => {
      await p.getByText("Use an existing App", { exact: true }).click();
      await p.getByLabel("App id").scrollIntoViewIfNeeded();
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
  // The log file of the scratch data folder (ADR 0055), from the shot's own load on: its self-tests, then S10's seed.
  // The file holds every load the proof service made before it, which shots ran first decides, and the start's
  // banner, which carries the port the worktree's path picks: those lines are hidden, so the shot is the same in a
  // full run, a `--diff` run and any worktree.
  {
    name: "logs",
    scenario: "S10",
    path: "/logs",
    act: async (p) => {
      await p.locator(".code pre > span", { hasText: "self-test of claude" }).first().waitFor();
      await p.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".code pre > span")];
        const load = rows.findLastIndex((row) => row.textContent?.includes("self-test of claude"));
        for (const row of rows.slice(0, load)) row.style.display = "none";
      });
    },
  },
  // The first run
  { name: "setup-1-ai", scenario: "S1", screen: ".setup" },
  // Both AIs ready: the step says so and waits for Continue; nothing moves by itself (ADR 0058).
  { name: "setup-1-ai-ready", scenario: "S1", screen: ".setup", alone: true, act: setupUntilBothReady },
  {
    name: "setup-2-github",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await (await createApp(p)).close();
      await p.locator(".substep.done").first().waitFor();
    },
  },
  // Where the App lives (ADR 0059): S1's gh signed out, so its line says `gh auth login` beside Check again, your own
  // account the one choice; S15's lists ledger-dev, picked, under it how a member who isn't an admin gets an App.
  {
    name: "setup-github-gh-signed-out",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await p.getByText("To create it on an organisation, run").waitFor();
    },
  },
  // gh not on the computer: the line says to install it, then sign in.
  {
    name: "setup-github-gh-missing",
    scenario: "S1",
    inject: ["gh-uninstalled"],
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await p.getByText("To create it on an organisation, install gh").first().waitFor();
    },
  },
  {
    name: "setup-github-organisation",
    scenario: "S15",
    screen: ".setup",
    alone: true,
    act: async (p) => {
      await p.getByLabel("ledger-dev").check();
      await p.getByText("Not an admin of your organisation?").waitFor();
    },
  },
  // Made on ledger-dev's pages of GitHub's fake and installed there: the step done, the choice kept on ledger-dev,
  // disabled.
  {
    name: "setup-github-organisation-installed",
    scenario: "S15",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      const tab = await createOnOrganisation(p);
      await tab.getByRole("button", { name: "Install" }).click();
      await tab.getByText("Lookover is installed").waitFor();
      await tab.close();
      await demo.advance(4 * SEC);
      await p.getByText("GitHub is connected.").waitFor();
    },
  },
  // The App a ledger-dev admin made before, taken by "Use an existing App" (ADR 0059): gh says the person is a member,
  // and it is installed there, so the step is done a few seconds on.
  {
    name: "setup-github-organisation-existing-app",
    scenario: "S15",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await useExistingApp(p, "lookover-ledger-dev.private-key.pem", MADE_APP.key, MADE_APP.id);
      await button(p, "Use this App").click();
      await demo.advance(4 * SEC);
      await p.getByText("GitHub is connected.").waitFor();
    },
  },
  // GitHub's fake, on the organisation: its Apps (the one an admin made before, for "Use an existing App"), and an
  // App's install page, the organisation's repositories to choose from.
  {
    name: "github-organisation-apps",
    scenario: "S15",
    path: `${DEMO_API.github}/organizations/ledger-dev/settings/apps`,
    screen: "main",
  },
  {
    name: "github-organisation-install",
    scenario: "S15",
    path: `${DEMO_API.github}/apps/lookover-ledger-dev/installations/new`,
    screen: "main",
  },
  // Once set up on ledger-dev: the owner's #148 reviewed first, then two teammates' pull requests skipped. It opens
  // on the setup and ends on Home.
  {
    name: "home-organisation",
    scenario: "S15",
    screen: '.setup, [data-screen="home"]',
    alone: true,
    act: async (p, demo) => {
      const tab = await createOnOrganisation(p);
      await tab.getByRole("button", { name: "Install" }).click();
      await tab.getByText("Lookover is installed").waitFor();
      await tab.close();
      await demo.advance(4 * SEC);
      await button(p, "Continue").click();
      await p.getByText("Pick the repositories to review.").waitFor();
      await button(p, "Continue").click();
      await button(p, "Review this pull request").click();
      await demo.advance(5 * MIN);
      await button(p, "Continue").click();
      await button(p, "Go to my reviews").click();
      await demo.advance(10 * MIN);
      await p.getByText("#153").first().waitFor();
    },
  },
  // Set up on ledger-dev, the account is named where the App is (ADR 0059): Settings › GitHub with the person reviews
  // are for, Repositories, and the status menu. Each opens on the setup.
  {
    name: "settings-organisation",
    scenario: "S15",
    screen: '.setup, [data-screen="settings"]',
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setUpOnOrganisation(p, demo);
      await link(p, "Settings").click();
      await p.getByText("on the ledger-dev organisation").waitFor();
    },
  },
  {
    name: "repositories-organisation",
    scenario: "S15",
    screen: '.setup, [data-screen="repositories"]',
    alone: true,
    act: async (p, demo) => {
      await setUpOnOrganisation(p, demo);
      await link(p, "Repositories").click();
      await p.getByText("on the ledger-dev organisation.").waitFor();
    },
  },
  // A repository that left the organisation's installation: Add it back opens the organisation's installation settings.
  {
    name: "repositories-departed-organisation",
    scenario: "S15",
    screen: '.setup, [data-screen="repositories"]',
    alone: true,
    act: async (p, demo) => {
      await setUpOnOrganisation(p, demo);
      await demo.inject("repository-removed");
      await link(p, "Repositories").click();
      await p.getByText("is no longer reviewed").waitFor();
    },
  },
  {
    name: "status-pill-organisation",
    scenario: "S15",
    screen: '.setup, [data-screen="home"]',
    alone: true,
    act: async (p, demo) => {
      await setUpOnOrganisation(p, demo);
      await button(p, "All good").click();
      await p.getByText("on the ledger-dev organisation").waitFor();
    },
  },
  // The App installed on no repository: the step says so, GitHub's page its one way on (ADR 0053).
  {
    name: "setup-github-nothing-granted",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      const tab = await createApp(p);
      await tab.getByLabel("Only select repositories").check();
      await tab.getByRole("button", { name: "Install" }).click();
      await tab.getByText("Lookover is installed").waitFor();
      await tab.close();
      await demo.advance(4 * SEC);
      await p.getByText("Installed, with no repository.").waitFor();
    },
  },
  // The App installed on three repositories: the step says it is done and waits for Continue (ADR 0058).
  {
    name: "setup-github-installed",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: setupUntilInstalled,
  },
  // "Use an existing App": the App made on another computer, its id and key file given; then a file that holds no
  // key, refused under the form.
  {
    name: "setup-github-existing-app",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await useExistingApp(p, "lookover-spike-sasensi.private-key.pem", "-----BEGIN RSA PRIVATE KEY-----");
    },
  },
  {
    name: "setup-github-existing-app-refused",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await useExistingApp(p, "notes.txt", "my notes");
      await button(p, "Use this App").click();
      await p.getByText("That file holds no private key.").first().waitFor();
    },
  },
  // ledger-co's App, handed over by its admin (ADR 0059): refused while gh is signed out, then, gh signed in, as the
  // owner isn't a member of ledger-co.
  {
    name: "setup-github-existing-app-gh-signed-out",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await useExistingApp(p, "ledger-co.private-key.pem", HANDED_APP.key, HANDED_APP.id);
      await button(p, "Use this App").click();
      await p.getByText("needs gh signed in").first().waitFor();
    },
  },
  {
    name: "setup-github-existing-app-not-a-member",
    scenario: "S1",
    inject: ["gh-signed-in"],
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilGitHub(p, demo);
      await useExistingApp(p, "ledger-co.private-key.pem", HANDED_APP.key, HANDED_APP.id);
      await button(p, "Use this App").click();
      await p.getByText("who isn't a member of ledger-co").first().waitFor();
    },
  },
  {
    name: "setup-3-repositories",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: setupUntilRepositories,
  },
  {
    name: "setup-back-to-github",
    scenario: "S1",
    screen: ".setup",
    alone: true,
    act: async (p, demo) => {
      await setupUntilRepositories(p, demo);
      await button(p, "Back").click();
      await p.getByText("Already using Lookover on another computer?").click();
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
  // "Don't start at login" clicked on the last step (ADR 0054): the line under it says what to run after a login.
  {
    name: "setup-5-agent-no-start-at-login",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await button(p, "Don't start at login").click();
      await button(p, "Start at login after all").waitFor();
    },
  },
  // On a phone, reaching the service from another device: looking is free, a change asks to unlock.
  { name: "phone-home", scenario: "S11", phone: true },
  { name: "phone-review", scenario: "S11", phone: true, path: "/reviews/lookover-sandbox/180" },
  // Its details open: the Rounds table, who found and checked each round and its tokens, scrolls sideways (ADR 0055).
  {
    name: "phone-review-details-open",
    scenario: "S11",
    phone: true,
    path: "/reviews/lookover-sandbox/180",
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
    path: "/reviews/lookover-sandbox/180",
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
    act: async (p) => {
      await p.getByLabel("Again after every push", { exact: true }).click();
      await p.getByText("Refused", { exact: true }).first().waitFor();
    },
  },
  // A tab without the session (401, #68): the session screen in place of the app, with the program's sentence: S14
  // plants the binary's command, which the 401 names (ADR 0058).
  { name: "service-session", scenario: "S14", path: "/", noSession: true },
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
  // The pages GitHub's redirects reach, stand-alone pages without the app (ADR 0058): the install's, then each
  // refusal's as demo mode shows it (some can't happen on the fakes), then the tab GitHub sends back taken to setup.
  { name: "github-return-installed", scenario: "S1", path: APP_FLOW.installed, screen: ".standalone" },
  ...REFUSED_PAGES.map(
    (refused): Shot => ({
      name: `github-return-${refused}`,
      scenario: "S1",
      path: `${DEMO_API.listing}/pages/${refused}`,
      screen: ".standalone",
    }),
  ),
  { name: "github-return-back-to-setup", scenario: "S1", screen: ".setup", act: backToSetupFromGitHub },
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
      // Each row holds its other details, hidden: Claude Code's is the first to show.
      await p.getByText("The review loop's skill is in").first().waitFor();
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
      await button(p, "Add to my PATH").click();
      await p.getByText("runs this Lookover.").waitFor();
    },
  },
  {
    name: "setup-5-agent-refused",
    scenario: "S1",
    screen: ".setup",
    fullPage: true,
    alone: true,
    inject: ["path-refused"],
    act: async (p, demo) => {
      await setupUntilAgent(p, demo);
      await button(p, "Add to my PATH").click();
      await p.getByText("This computer refused to change your PATH.").waitFor();
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
  // Settings › Your coding agent (ADR 0058): the setup step's rows, read again when shown. Fresh (the binary off the
  // PATH, no skill yet), then each row done offering its undo, then a write the computer refuses, said on the line
  // under the rows.
  {
    name: "settings-agent",
    scenario: "S10",
    path: "/settings",
    act: (p) => p.locator("#agent").scrollIntoViewIfNeeded(),
  },
  {
    name: "settings-agent-done",
    scenario: "S10",
    path: "/settings",
    alone: true,
    act: async (p) => {
      await p.locator("#agent").scrollIntoViewIfNeeded();
      await button(p, "Add to my PATH").click();
      await button(p, "Remove from my PATH").waitFor();
      await button(p, "Install the skill").click();
      await button(p, "Remove the skill").waitFor();
    },
  },
  {
    name: "settings-agent-refused",
    scenario: "S10",
    path: "/settings",
    alone: true,
    inject: ["path-refused"],
    act: async (p) => {
      await p.locator("#agent").scrollIntoViewIfNeeded();
      await button(p, "Add to my PATH").click();
      await p.getByText("This computer refused to change your PATH.").waitFor();
    },
  },
  {
    name: "settings-agent-stale",
    scenario: "S10",
    path: "/settings",
    alone: true,
    inject: ["launcher-stale"],
    act: async (p) => {
      await p.locator("#agent").scrollIntoViewIfNeeded();
      await button(p, "Point it at this Lookover").waitFor();
    },
  },
  // An npm install (ADR 0061): npm put `lookover` on the PATH, so the row says so and offers nothing.
  {
    name: "settings-agent-npm",
    scenario: "S10",
    path: "/settings",
    alone: true,
    inject: ["npm-install"],
    act: async (p) => {
      await p.locator("#agent").scrollIntoViewIfNeeded();
      await p.getByText("npm put it on your PATH").waitFor();
    },
  },
  // npm's folder off the PATH (a Node installed without it): said with that folder, nothing offered.
  {
    name: "settings-agent-npm-off-path",
    scenario: "S10",
    path: "/settings",
    alone: true,
    inject: ["npm-off-path"],
    act: async (p) => {
      await p.locator("#agent").scrollIntoViewIfNeeded();
      await p.getByText("but that folder isn't on your PATH").waitFor();
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
  // Settings › GitHub: the App, and the line for a coding agent on another computer under its one sentence.
  {
    name: "settings-github-agent-app",
    scenario: "S10",
    path: "/settings",
    act: (p) => p.locator(".agent-app").evaluate((el) => el.scrollIntoView({ block: "center" })),
  },
];
