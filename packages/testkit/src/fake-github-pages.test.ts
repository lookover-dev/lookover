import { describe, expect, test } from "bun:test";
import { commitSha, DEMO_API, githubLinks, type RepositoryRef } from "@lookover/contracts";
import { type FakeChange, FakeGitHost, fakeGitHubPages, memoryGh } from "./index.ts";

const sandbox: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const ledger: RepositoryRef = { owner: "sasensi", name: "ledger-api" };
const notes: RepositoryRef = { owner: "sasensi", name: "notes" };
/** The shared App's bot: its slug, `lookover-dev`, is the install page's. */
const bot = { id: 338297045, login: "lookover-dev[bot]" };
const SLUG = "lookover-dev";
const ORIGIN = "http://127.0.0.1:5173";
const web = `${ORIGIN}${DEMO_API.github}`;
const SASENSI = { id: 1234567, login: "sasensi", type: "User" } as const;

/** The person's account before installing: three repositories, the shared App installed nowhere. */
const fresh = () =>
  new FakeGitHost({
    repo: sandbox,
    repositories: [ledger, notes],
    bot,
    person: { id: SASENSI.id, login: SASENSI.login },
    changes: [],
    installed: false,
  });

const form = (url: string, fields: [string, string][]) =>
  new Request(url, { method: "POST", body: new URLSearchParams(fields) });

/** The installation on the person's own account, as GitHub's pages show it; the test fails without one. */
const installationOf = (host: FakeGitHost) => {
  const installation = host.onGitHub().installation;
  if (installation === null) throw new Error("not installed");
  return installation;
};

describe("fakeGitHubPages", () => {
  test("the install page lists the person's repositories, archived ones left out", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    host.archive(notes);

    const answer = await pages(new Request(githubLinks.install(web, SLUG)));

    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("content-type")).toContain("text/html");
    const page = await answer?.text();
    expect(page).toContain("sasensi/lookover-sandbox");
    expect(page).toContain("sasensi/ledger-api");
    expect(page).not.toContain("sasensi/notes");
  });

  test("installing on chosen repositories grants those, then goes to the installation's page", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);

    const answer = await pages(
      form(githubLinks.install(web, SLUG), [
        ["selection", "selected"],
        ["repository", "sasensi/ledger-api"],
        ["repository", "sasensi/notes"],
      ]),
    );

    const installation = installationOf(host);
    expect(answer?.status).toBe(302);
    expect(answer?.headers.get("location")).toBe(githubLinks.installation(web, SASENSI, installation.id));
    expect(installation.granted).toEqual([ledger, notes]);
  });

  test("installing on all repositories grants every one; granting none leaves an installation with nothing", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);

    await pages(form(githubLinks.install(web, SLUG), [["selection", "all"]]));
    expect(installationOf(host).granted).toEqual([sandbox, ledger, notes]);

    await pages(form(githubLinks.install(web, SLUG), [["selection", "selected"]]));
    expect(installationOf(host).granted).toEqual([]);
  });

  test("the installation's page changes the repositories, suspends, lifts and uninstalls", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    await pages(form(githubLinks.install(web, SLUG), [["selection", "all"]]));
    const page = githubLinks.installation(web, SASENSI, installationOf(host).id);

    expect(await (await pages(new Request(page)))?.text()).toContain("sasensi/ledger-api");
    const saved = await pages(
      form(page, [
        ["action", "save"],
        ["selection", "selected"],
        ["repository", "sasensi/notes"],
      ]),
    );
    expect([saved?.status, saved?.headers.get("location")]).toEqual([302, page]);
    expect(installationOf(host).granted).toEqual([notes]);

    await pages(form(page, [["action", "suspend"]]));
    expect(installationOf(host).suspended).toBe(true);
    expect(await (await pages(new Request(page)))?.text()).toContain("Unsuspend");
    await pages(form(page, [["action", "unsuspend"]]));
    expect(installationOf(host).suspended).toBe(false);

    const gone = await pages(form(page, [["action", "uninstall"]]));
    expect(gone?.status).toBe(200);
    expect(host.onGitHub().installation).toBeNull();
    expect((await pages(new Request(page)))?.status).toBe(404);
  });

  test("another App's install page or another installation is not found; a path not GitHub's is left to the caller", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    host.install();

    expect((await pages(new Request(githubLinks.install(web, "someone-else"))))?.status).toBe(404);
    expect((await pages(new Request(githubLinks.installation(web, SASENSI, 1))))?.status).toBe(404);
    expect(await pages(new Request(`${ORIGIN}/api/v1/snapshot`))).toBeNull();
    expect(await pages(new Request(`${web}/no/such/page/here`))).toBeNull();
    // Pages an own App had are none: the App's settings, a new App.
    expect(await pages(new Request(`${web}/settings/apps`))).toBeNull();
    expect(await pages(form(`${web}/settings/apps/new?state=s-1`, [["manifest", "{}"]]))).toBeNull();
  });

  test("a repository's name is written into a page as text, never as markup", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    host.addRepository({ owner: "sasensi", name: "<b>bold</b>" });

    const page = await (await pages(new Request(githubLinks.install(web, SLUG))))?.text();

    expect(page).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(page).not.toContain("<b>bold");
  });
});

describe("fakeGitHubPages: the device page (ADR 0066)", () => {
  const device = `${web}/login/device`;
  /** The person who signs in to the shared App, its device flow naming the fake's page. */
  const signingIn = () =>
    new FakeGitHost({
      repo: sandbox,
      bot,
      changes: [],
      person: { id: 11247504, login: "sasensi" },
      devicePage: device,
    });

  test("the code GitHub gives names the fake's page, which asks for it", async () => {
    const host = signingIn();
    const pages = fakeGitHubPages(host, web);
    const grant = await host.startSignIn();
    expect(grant.verificationUri).toBe(device);

    const asked = await pages(new Request(device));
    expect(asked?.status).toBe(200);
    const page = await asked?.text();
    expect(page).toContain('name="user_code"');
    expect(page).toContain('value="authorize"');
    expect(page).toContain('value="cancel"');
  });

  test("the code given with Authorize is entered: the next poll signs the person in", async () => {
    const host = signingIn();
    const pages = fakeGitHubPages(host, web);
    const grant = await host.startSignIn();

    const answer = await pages(
      form(device, [
        ["user_code", grant.userCode],
        ["action", "authorize"],
      ]),
    );

    expect(answer?.status).toBe(200);
    expect(await answer?.text()).toContain("You're signed in");
    expect((await host.pollSignIn(grant)).kind).toBe("issued");
  });

  test("Cancel refuses the code: the next poll is denied", async () => {
    const host = signingIn();
    const pages = fakeGitHubPages(host, web);
    const grant = await host.startSignIn();

    const answer = await pages(
      form(device, [
        ["user_code", grant.userCode],
        ["action", "cancel"],
      ]),
    );

    expect(await answer?.text()).toContain("Sign-in cancelled");
    expect((await host.pollSignIn(grant)).kind).toBe("denied");
  });

  test("a code that doesn't wait is refused, and the one waiting stays as it was", async () => {
    const host = signingIn();
    const pages = fakeGitHubPages(host, web);
    const grant = await host.startSignIn();

    const answer = await pages(
      form(device, [
        ["user_code", "WRONG-0000"],
        ["action", "authorize"],
      ]),
    );

    expect(answer?.status).toBe(404);
    expect((await host.pollSignIn(grant)).kind).toBe("pending");
  });
});

describe("fakeGitHubPages: a pull request's page", () => {
  const change: FakeChange = {
    number: 7,
    title: "Add unpaid filter",
    url: "https://github.com/sasensi/lookover-sandbox/pull/7",
    author: { id: 1234567, login: "sasensi" },
    draft: false,
    head: { ref: "feature/unpaid", sha: commitSha("5d9114c0a1b2c3d4e5f60718293a4b5c6d7e8f9a") },
    base: { ref: "main", sha: commitSha("0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3") },
    diff: [{ path: "src/invoice.ts", side: "head", from: 2, to: 21 }],
  };
  const line = { path: "src/invoice.ts", side: "head" as const, line: 12, endLine: null, body: "Why?" };

  test("names who filed each review, in order; one GitHub hasn't is not found", async () => {
    const host = new FakeGitHost({
      repo: sandbox,
      bot,
      person: { id: 1234567, login: "sasensi" },
      changes: [change],
    });
    const pages = fakeGitHubPages(host, web);
    const pull = `${web}/sasensi/lookover-sandbox/pull/7`;
    const none = await pages(new Request(pull));
    expect(none?.status).toBe(200);
    expect(await none?.text()).toContain("No review yet.");

    host.seedInline({ repo: sandbox, number: 7 }, { id: 1234567, login: "sasensi" }, line);
    host.seedInline({ repo: sandbox, number: 7 }, bot, { ...line, line: 14 });
    const page = await (await pages(new Request(pull)))?.text();
    expect([...(page ?? "").matchAll(/Reviewed by ([^<]+)\./g)].map((m) => m[1])).toEqual([
      "sasensi",
      bot.login,
    ]);

    expect((await pages(new Request(`${web}/sasensi/lookover-sandbox/pull/8`)))?.status).toBe(404);
    expect((await pages(new Request(`${web}/sasensi/notes/pull/7`)))?.status).toBe(404);
  });
});

describe("fakeGitHubPages: the shared App's install page, on the person's accounts (ADR 0067)", () => {
  const PERSON = { id: 1, login: "sasensi" };
  const LABS = { id: 340, login: "ledger-labs", type: "Organization" } as const;
  const HQ = { id: 341, login: "ledger-hq", type: "Organization" } as const;
  const DEV = { id: 338, login: "ledger-dev", type: "Organization" } as const;
  const install = githubLinks.install(web, SLUG);
  /** The person signed in to the shared App: on ledger-dev, not on their own account, ledger-labs or ledger-hq. */
  const elsewhere = () => {
    const host = new FakeGitHost({
      repo: ledger,
      bot,
      person: PERSON,
      changes: [],
      installed: false,
      reaches: [{ account: DEV, repositories: [{ owner: "ledger-dev", name: "ledger-api" }] }],
      unreached: [
        { account: LABS, repositories: [{ owner: "ledger-labs", name: "ledger-cli" }] },
        { account: HQ, repositories: [{ owner: "ledger-hq", name: "ledger-app" }] },
      ],
    });
    const gh = memoryGh({ as: PERSON });
    gh.join(LABS, PERSON, { state: "active", admin: true });
    gh.join(HQ, PERSON, { state: "active", admin: false });
    return { host, pages: fakeGitHubPages(host, web, { gh }) };
  };
  const words = async (answer: Response | null) => {
    expect(answer?.status).toBe(200);
    return (await answer?.text()) ?? "";
  };
  const reached = async (host: FakeGitHost) =>
    (await host.accounts()).map((a) => a.installation.account.login);

  test("the page asks where: Install on the person's own account and an organisation they own, Request where a member", async () => {
    const { pages } = elsewhere();
    const page = await words(await pages(new Request(install)));
    expect(page).toContain('href="?target=sasensi">Install</a>');
    expect(page).toContain('href="?target=ledger-labs">Install</a>');
    expect(page).toContain('href="?target=ledger-hq">Request</a>');
    // Installed there already: named, not offered again.
    expect(page).toContain("ledger-dev: installed.");
    expect(page).not.toContain("?target=ledger-dev");
  });

  test("on the person's own account, the repositories to choose from, as without other accounts", async () => {
    const { pages } = elsewhere();
    const page = await words(await pages(new Request(`${install}?target=sasensi`)));
    expect(page).toContain("sasensi/ledger-api");
    expect(page).toContain("Install</button>");
  });

  test("an organisation the person owns: Install installs it there, on all its repositories", async () => {
    const { host, pages } = elsewhere();
    const page = await words(await pages(new Request(`${install}?target=ledger-labs`)));
    expect(page).toContain('value="install">Install</button>');

    const done = await words(await pages(form(`${install}?target=ledger-labs`, [["action", "install"]])));

    expect(done).toContain("Installed on ledger-labs.");
    expect(await reached(host)).toEqual(["ledger-dev", "ledger-labs"]);
  });

  test("a member's organisation: Request sends the request to its owners and records nothing on GitHub", async () => {
    const { host, pages } = elsewhere();
    const page = await words(await pages(new Request(`${install}?target=ledger-hq`)));
    expect(page).toContain("An owner of ledger-hq");
    expect(page).toContain('value="request">Request</button>');
    // Installing is an owner's: refused, nothing installed.
    expect((await pages(form(`${install}?target=ledger-hq`, [["action", "install"]])))?.status).toBe(403);

    const sent = await words(await pages(form(`${install}?target=ledger-hq`, [["action", "request"]])));

    expect(sent).toContain("Request sent");
    expect(await reached(host)).toEqual(["ledger-dev"]);
  });

  test("an account that isn't the person's without the App is not found", async () => {
    const { pages } = elsewhere();
    for (const target of ["ledger-dev", "acme"])
      expect((await pages(new Request(`${install}?target=${target}`)))?.status).toBe(404);
  });
});

describe("fakeGitHubPages: the pages an account's fix opens (ADR 0067)", () => {
  const PERSON = { id: 1, login: "sasensi" };
  const DEV = { id: 338, login: "ledger-dev", type: "Organization" } as const;
  const LABS = { id: 340, login: "ledger-labs", type: "Organization" } as const;
  const HQ = { id: 341, login: "ledger-hq", type: "Organization" } as const;
  /** Signed in to the shared App: on the person's own account and ledger-dev (mira owns it), not ledger-labs or ledger-hq. */
  const reaching = () => {
    const host = new FakeGitHost({
      repo: ledger,
      bot,
      person: PERSON,
      changes: [],
      reaches: [
        { account: DEV, repositories: [{ owner: "ledger-dev", name: "ledger-api" }], owners: ["mira"] },
      ],
      unreached: [
        { account: LABS, repositories: [{ owner: "ledger-labs", name: "ledger-cli" }] },
        { account: HQ, repositories: [{ owner: "ledger-hq", name: "ledger-app" }], owners: ["noor", "mira"] },
      ],
    });
    const gh = memoryGh({ as: PERSON });
    gh.join(DEV, PERSON, { state: "active", admin: true });
    gh.join(LABS, PERSON, { state: "active", admin: true });
    gh.join(HQ, PERSON, { state: "active", admin: false });
    return { host, gh, pages: fakeGitHubPages(host, web, { gh }) };
  };
  const words = async (answer: Response | null) => {
    expect(answer?.status).toBe(200);
    return (await answer?.text()) ?? "";
  };
  const reachedOn = async (host: FakeGitHost, login: string) =>
    (await host.accounts()).find((a) => a.installation.account.login === login);
  const idOn = async (host: FakeGitHost, login: string) =>
    (await reachedOn(host, login))?.installation.id ?? 0;

  test("an organisation's owners: those GitHub lists, the person among them where their `gh` says they own it", async () => {
    const { pages } = reaching();

    const hq = await words(await pages(new Request(githubLinks.owners(web, "ledger-hq"))));
    expect(hq).toContain("<li>noor</li>");
    expect(hq).toContain("<li>mira</li>");
    expect(hq).not.toContain("sasensi");

    const labs = await words(await pages(new Request(githubLinks.owners(web, "LEDGER-LABS"))));
    expect(labs).toContain("<li>sasensi</li>");

    const dev = await words(await pages(new Request(githubLinks.owners(web, "ledger-dev"))));
    expect(dev).toContain("<li>mira</li>");
    expect(dev).toContain("<li>sasensi</li>");

    expect((await pages(new Request(githubLinks.owners(web, "acme"))))?.status).toBe(404);
  });

  test("another account's installation settings: its repositories, and Unsuspend lifts a suspension", async () => {
    const { host, pages } = reaching();
    const settings = githubLinks.installation(web, DEV, await idOn(host, "ledger-dev"));
    const installed = await words(await pages(new Request(settings)));
    expect(installed).toContain("ledger-dev/ledger-api");
    expect(installed).toContain("Installed.");

    host.suspend("ledger-dev", "mira");
    const suspended = await words(await pages(new Request(settings)));
    expect(suspended).toContain("Suspended.");
    expect(suspended).toContain('value="unsuspend">Unsuspend</button>');

    const lifted = await pages(form(settings, [["action", "unsuspend"]]));
    expect(lifted?.status).toBe(302);
    expect(lifted?.headers.get("location")).toBe(settings);
    expect((await reachedOn(host, "ledger-dev"))?.cause).toBeNull();
  });

  test("a member can't change another account's installation: refused, nothing changes", async () => {
    const { host, gh, pages } = reaching();
    gh.join(DEV, PERSON, { state: "active", admin: false });
    host.suspend("ledger-dev", "mira");
    const settings = githubLinks.installation(web, DEV, await idOn(host, "ledger-dev"));

    expect((await pages(form(settings, [["action", "unsuspend"]])))?.status).toBe(403);
    expect((await reachedOn(host, "ledger-dev"))?.cause).toMatchObject({ suspended: true });
  });

  test("an installation id on the wrong account, or one the App hasn't, is not found", async () => {
    const { host, pages } = reaching();
    const id = await idOn(host, "ledger-dev");
    for (const url of [
      githubLinks.installation(web, LABS, id),
      githubLinks.installation(web, DEV, id + 100),
      githubLinks.installation(web, { login: "sasensi", type: "User" }, id),
    ])
      expect((await pages(new Request(url)))?.status).toBe(404);
  });

  test("an organisation's SSO page: Continue starts the session, and its repositories answer again", async () => {
    const { host, pages } = reaching();
    host.askSso("ledger-dev");
    const sso = githubLinks.sso(web, "ledger-dev");
    expect(await words(await pages(new Request(sso)))).toContain('value="continue">Continue</button>');

    const done = await words(await pages(form(sso, [["action", "continue"]])));

    expect(done).toContain("ledger-dev");
    expect((await reachedOn(host, "ledger-dev"))?.cause).toBeNull();
    // An organisation the person doesn't reach has no session to start here.
    expect((await pages(new Request(githubLinks.sso(web, "acme"))))?.status).toBe(404);
  });
});
