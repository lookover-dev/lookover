import { describe, expect, test } from "bun:test";
import { APP_PERMISSIONS, DEMO_API, githubLinks, type RepositoryRef } from "@lookover/contracts";
import { FakeGitHost, fakeGitHubPages } from "./index.ts";

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
