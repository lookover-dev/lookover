import { describe, expect, test } from "bun:test";
import { APP_PERMISSIONS, commitSha, DEMO_API, githubLinks, type RepositoryRef } from "@lookover/contracts";
import { type FakeChange, FakeGitHost, fakeGitHubPages, memoryGh } from "./index.ts";

const sandbox: RepositoryRef = { owner: "sasensi", name: "lookover-sandbox" };
const ledger: RepositoryRef = { owner: "sasensi", name: "ledger-api" };
const notes: RepositoryRef = { owner: "sasensi", name: "notes" };
const bot = { id: 338297044, login: "lookover-spike-sasensi[bot]" };
const ORIGIN = "http://127.0.0.1:5173";
const web = `${ORIGIN}${DEMO_API.github}`;
const CALLBACK = `${ORIGIN}/api/v1/github/callback`;
const SETUP = `${ORIGIN}/api/v1/github/installed`;

/** The owner's account before onboarding: three repositories, no App yet. */
const fresh = () =>
  new FakeGitHost({
    repo: sandbox,
    repositories: [ledger, notes],
    bot,
    changes: [],
    app: { made: false },
  });

/** An organisation (ADR 0059): its sandbox, no App yet; the App made from a manifest is the organisation's. */
const LOOKOVER_DEV = { id: 338456971, login: "lookover-dev", type: "Organization" } as const;
const organisation = () =>
  new FakeGitHost({
    repo: { owner: "lookover-dev", name: "lookover-sandbox" },
    bot,
    changes: [],
    app: { owner: LOOKOVER_DEV, made: false },
  });

const manifest = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "lookover-k3x9qa",
    url: "https://github.com/lookover-dev/lookover",
    public: false,
    redirect_url: CALLBACK,
    setup_url: SETUP,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
    ...fields,
  });

/** The browser posting the manifest form to the "new App" page. */
const postManifest = (body: string, state = "s-1", organisation: string | null = null) =>
  new Request(githubLinks.newApp(web, organisation, state), {
    method: "POST",
    body: new URLSearchParams({ manifest: body }),
  });

const form = (url: string, fields: [string, string][]) =>
  new Request(url, { method: "POST", body: new URLSearchParams(fields) });

/** The App made through the pages, its code converted as the service's callback does. */
const made = async (host: FakeGitHost, pages: ReturnType<typeof fakeGitHubPages>) => {
  const answer = await pages(postManifest(manifest()));
  const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
  return host.convertManifest(code);
};

describe("fakeGitHubPages", () => {
  test("the new App page makes the App from the manifest and redirects to its callback with a code and the state", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);

    const answer = await pages(postManifest(manifest(), "flow state/1"));

    expect(answer?.status).toBe(302);
    const location = new URL(answer?.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("flow state/1");
    const { app, key } = await host.convertManifest(location.searchParams.get("code") ?? "");
    expect(app).toMatchObject({ slug: "lookover-k3x9qa", permissions: APP_PERMISSIONS });
    expect(key).toContain("PRIVATE KEY");
    // Made, not installed.
    expect(await host.installation({ id: app.id, key })).toBeNull();
  });

  test("a manifest without its name or callback, or not JSON, is refused and makes nothing", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    for (const bad of [manifest({ name: "" }), manifest({ redirect_url: undefined }), "{not json"]) {
      const answer = await pages(postManifest(bad));
      expect(answer?.status).toBe(422);
      expect(await answer?.text()).toContain("manifest");
    }
    expect(() => host.credentials()).toThrow("no App");
  });

  test("a callback or setup page that isn't an address on the request's origin is refused and makes nothing", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const elsewhere = ["https://github.com/settings", "not an address", "/api/v1/github/callback"];
    for (const bad of elsewhere.flatMap((url) => [
      manifest({ redirect_url: url }),
      manifest({ setup_url: url }),
    ])) {
      const answer = await pages(postManifest(bad));
      expect(answer?.status).toBe(422);
    }
    expect(() => host.credentials()).toThrow("no App");
  });

  test("the install page lists the owner's repositories, archived ones left out", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const { app } = await made(host, pages);
    host.archive(notes);

    const answer = await pages(new Request(githubLinks.install(web, app.slug)));

    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("content-type")).toContain("text/html");
    const page = await answer?.text();
    expect(page).toContain("sasensi/lookover-sandbox");
    expect(page).toContain("sasensi/ledger-api");
    expect(page).not.toContain("sasensi/notes");
  });

  test("the shared App's install page, named, is the host's App's (demo mode's): installed, the browser goes to the installation", async () => {
    const host = fresh();
    const { app, key } = await made(host, fakeGitHubPages(host, web));
    const pages = fakeGitHubPages(host, web, { sharedApp: "lookover-dev" });
    expect(
      (await fakeGitHubPages(host, web)(new Request(githubLinks.install(web, "lookover-dev"))))?.status,
    ).toBe(404);
    expect((await pages(new Request(githubLinks.install(web, "lookover-dev"))))?.status).toBe(200);

    const answer = await pages(form(githubLinks.install(web, "lookover-dev"), [["selection", "all"]]));

    const id = (await host.installation({ id: app.id, key }))?.id ?? 0;
    expect(id).not.toBe(0);
    expect(answer?.status).toBe(302);
    expect(answer?.headers.get("location")).toBe(githubLinks.installation(web, app.owner, id));
  });

  test("installing on chosen repositories grants those, then goes to the App's setup page with the installation", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const { app, key } = await made(host, pages);

    const answer = await pages(
      form(githubLinks.install(web, app.slug), [
        ["selection", "selected"],
        ["repository", "sasensi/ledger-api"],
        ["repository", "sasensi/notes"],
      ]),
    );

    const installation = await host.installation({ id: app.id, key });
    expect(installation).not.toBeNull();
    const id = installation?.id ?? 0;
    expect(answer?.status).toBe(302);
    expect(answer?.headers.get("location")).toBe(`${SETUP}?installation_id=${id}&setup_action=install`);
    expect(await host.repositories({ id: app.id, key }, id)).toEqual([ledger, notes]);
  });

  test("installing on all repositories grants every one; granting none leaves an installation with nothing", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const { app, key } = await made(host, pages);

    await pages(form(githubLinks.install(web, app.slug), [["selection", "all"]]));
    const id = (await host.installation({ id: app.id, key }))?.id ?? 0;
    expect(await host.repositories({ id: app.id, key }, id)).toEqual([sandbox, ledger, notes]);

    await pages(form(githubLinks.install(web, app.slug), [["selection", "selected"]]));
    expect(await host.repositories({ id: app.id, key }, id)).toEqual([]);
  });

  test("an App made with no setup page lands on its installation's page", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const answer = await pages(postManifest(manifest({ setup_url: undefined })));
    const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const { app, key } = await host.convertManifest(code);

    const installed = await pages(form(githubLinks.install(web, app.slug), [["selection", "all"]]));

    const id = (await host.installation({ id: app.id, key }))?.id ?? 0;
    expect(installed?.headers.get("location")).toBe(githubLinks.installation(web, app.owner, id));
  });

  test("the installation's page changes the repositories, suspends, lifts and uninstalls", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const { app, key } = await made(host, pages);
    const credentials = { id: app.id, key };
    await pages(form(githubLinks.install(web, app.slug), [["selection", "all"]]));
    const id = (await host.installation(credentials))?.id ?? 0;
    const page = githubLinks.installation(web, app.owner, id);

    expect(await (await pages(new Request(page)))?.text()).toContain("sasensi/ledger-api");
    const saved = await pages(
      form(page, [
        ["action", "save"],
        ["selection", "selected"],
        ["repository", "sasensi/notes"],
      ]),
    );
    expect([saved?.status, saved?.headers.get("location")]).toEqual([302, page]);
    expect(await host.repositories(credentials, id)).toEqual([notes]);

    await pages(form(page, [["action", "suspend"]]));
    expect((await host.installation(credentials))?.suspended).toBe(true);
    expect(await (await pages(new Request(page)))?.text()).toContain("Unsuspend");
    await pages(form(page, [["action", "unsuspend"]]));
    expect((await host.installation(credentials))?.suspended).toBe(false);

    const gone = await pages(form(page, [["action", "uninstall"]]));
    expect(gone?.status).toBe(200);
    expect(await host.installation(credentials)).toBeNull();
    expect((await pages(new Request(page)))?.status).toBe(404);
  });

  test("another App's install page or another installation is not found; a path not GitHub's is left to the caller", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    await made(host, pages);

    expect((await pages(new Request(githubLinks.install(web, "someone-else"))))?.status).toBe(404);
    expect(
      (await pages(new Request(githubLinks.installation(web, { login: "sasensi", type: "User" }, 1))))
        ?.status,
    ).toBe(404);
    expect(await pages(new Request(`${ORIGIN}/api/v1/snapshot`))).toBeNull();
    expect(await pages(new Request(`${web}/no/such/page/here`))).toBeNull();
  });

  test("the Apps page lists the owner's App, whose page gives its id and a new private key as a file", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    expect(await (await pages(new Request(`${web}/settings/apps`)))?.text()).toContain("No GitHub Apps");
    const { app } = await made(host, pages);

    const list = await (await pages(new Request(`${web}/settings/apps`)))?.text();
    expect(list).toContain(`href="${githubLinks.app(web, app.owner, app.slug)}"`);
    const page = await (await pages(new Request(githubLinks.app(web, app.owner, app.slug))))?.text();
    expect(page).toContain(`App ID: ${app.id}`);
    expect(page).toContain("Generate a private key");

    const answer = await pages(form(githubLinks.app(web, app.owner, app.slug), [["action", "generate-key"]]));

    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("content-disposition")).toBe(
      `attachment; filename="${app.slug}.private-key.pem"`,
    );
    const key = (await answer?.text()) ?? "";
    expect(key).toContain("PRIVATE KEY");
    // The App takes the new key: it describes itself to it.
    expect((await host.app({ id: app.id, key })).slug).toBe(app.slug);
    expect((await pages(new Request(githubLinks.app(web, app.owner, "someone-else"))))?.status).toBe(404);
  });

  test("an organisation's new App page makes the App on the organisation, which its conversion names (ADR 0059)", async () => {
    const host = organisation();
    const pages = fakeGitHubPages(host, web);

    const answer = await pages(postManifest(manifest(), "flow state/2", "Lookover-Dev"));

    expect(answer?.status).toBe(302);
    const location = new URL(answer?.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get("state")).toBe("flow state/2");
    const { app, key } = await host.convertManifest(location.searchParams.get("code") ?? "");
    expect(app).toMatchObject({ slug: "lookover-k3x9qa", owner: LOOKOVER_DEV, permissions: APP_PERMISSIONS });
    expect(await host.installation({ id: app.id, key })).toBeNull();
  });

  test("a new App page of another account than the host's is not found and makes nothing", async () => {
    // Your own account's page on an organisation's host, another organisation's, an organisation's on a person's.
    const theirs = organisation();
    const yours = fresh();
    for (const [host, on] of [
      [theirs, null],
      [theirs, "acme"],
      [yours, "lookover-dev"],
    ] as const) {
      const answer = await fakeGitHubPages(host, web)(postManifest(manifest(), "s-1", on));
      expect(answer?.status).toBe(404);
      expect(() => host.credentials()).toThrow("no App");
    }
  });

  test("an organisation's App is installed from its pages, which are the organisation's settings", async () => {
    const host = organisation();
    const pages = fakeGitHubPages(host, web);
    const answer = await pages(postManifest(manifest({ setup_url: undefined }), "s-1", "lookover-dev"));
    const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const { app, key } = await host.convertManifest(code);

    const installed = await pages(form(githubLinks.install(web, app.slug), [["selection", "all"]]));

    const id = (await host.installation({ id: app.id, key }))?.id ?? 0;
    const page = githubLinks.installation(web, LOOKOVER_DEV, id);
    expect(page).toContain("/organizations/lookover-dev/settings/installations/");
    expect(installed?.headers.get("location")).toBe(page);
    expect(await (await pages(new Request(page)))?.text()).toContain("lookover-dev/lookover-sandbox");
    const settings = await (await pages(new Request(githubLinks.app(web, LOOKOVER_DEV, app.slug))))?.text();
    expect(settings).toContain(`App ID: ${app.id}`);
    // Not under your own account's settings, nor another organisation's.
    expect(
      (await pages(new Request(githubLinks.installation(web, { login: "x", type: "User" }, id))))?.status,
    ).toBe(404);
    const elsewhere = { login: "acme", type: "Organization" } as const;
    expect((await pages(new Request(githubLinks.app(web, elsewhere, app.slug))))?.status).toBe(404);
  });

  test("an organisation's Apps list links to its App's page under the organisation's settings", async () => {
    const host = organisation();
    const pages = fakeGitHubPages(host, web);
    const answer = await pages(postManifest(manifest(), "s-1", "lookover-dev"));
    const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const { app } = await host.convertManifest(code);

    const list = await (await pages(new Request(`${web}/organizations/lookover-dev/settings/apps`)))?.text();
    const href = /<a href="([^"]*)">/.exec(list ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    expect(href).toBe(`${web}/organizations/lookover-dev/settings/apps/${app.slug}`);
    expect(await (await pages(new Request(href)))?.text()).toContain(`App ID: ${app.id}`);
    // Your own account's list is not the organisation's.
    expect((await pages(new Request(`${web}/settings/apps`)))?.status).toBe(404);
  });

  test("a repository's name is written into a page as text, never as markup", async () => {
    const host = fresh();
    const pages = fakeGitHubPages(host, web);
    const { app } = await made(host, pages);
    host.addRepository({ owner: "sasensi", name: "<b>bold</b>" });

    const page = await (await pages(new Request(githubLinks.install(web, app.slug))))?.text();

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
    const host = new FakeGitHost({ repo: sandbox, bot, changes: [change] });
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
  const install = githubLinks.install(web, "lookover-dev");
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
    return { host, pages: fakeGitHubPages(host, web, { sharedApp: "lookover-dev", gh }) };
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
    return { host, gh, pages: fakeGitHubPages(host, web, { sharedApp: "lookover-dev", gh }) };
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
