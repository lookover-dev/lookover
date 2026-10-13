import { expect, test } from "bun:test";
import { type ConnectionCause, connectionCauseOf, type HostApp, HostError } from "@lookover/contracts";
import {
  APP,
  AT,
  acceptedJwt,
  HOUR,
  iso,
  KEY,
  type Route,
  stubGitHub,
  withToken,
} from "./github.test-support.ts";
import { appManifest, createGitHub, createHostInstallations } from "./index.ts";

const LINKS = {
  redirectUrl: "http://127.0.0.1:5173/api/v1/github/callback",
  setupUrl: "http://127.0.0.1:5173/api/v1/github/installed",
};

test("the manifest asks for exactly ADR 0022's five permissions, private, with no webhook and no events", () => {
  const manifest = appManifest(LINKS);
  expect(manifest.default_permissions).toEqual({
    metadata: "read",
    contents: "read",
    pull_requests: "write",
    checks: "write",
    issues: "write",
  });
  expect(manifest.public).toBe(false);
  expect(manifest.default_events).toEqual([]);
  expect("hook_attributes" in manifest).toBe(false);
  expect(manifest.redirect_url).toBe(LINKS.redirectUrl);
  expect(manifest.setup_url).toBe(LINKS.setupUrl);
  expect(manifest.url).toBe("https://github.com/lookover-dev/lookover");
});

test("the manifest's name is lookover- and six random characters, another each time", () => {
  const names = new Set(Array.from({ length: 20 }, () => appManifest(LINKS).name));
  for (const name of names) expect(name).toMatch(/^lookover-[a-z0-9]{6}$/);
  expect(names.size).toBe(20);
});

// The App and its owner as GitHub gives them (spike 03's recording, trimmed to what is read and a little more).
const CREDENTIALS = { id: 5202093, key: KEY };
const OWNER = { login: "sasensi", id: 11247504, type: "User" };
const PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  checks: "write",
  issues: "write",
} as const;
const GITHUB_APP = {
  id: 5202093,
  slug: "lookover-spike-sasensi",
  node_id: "A_kwDOAKufkM4AT2Ct",
  owner: { ...OWNER, node_id: "MDQ6VXNlcjExMjQ3NTA0", site_admin: false },
  name: "lookover-spike-sasensi",
  html_url: "https://github.com/apps/lookover-spike-sasensi",
  permissions: PERMISSIONS,
  events: [],
};
const HOST_APP: HostApp = {
  id: 5202093,
  slug: "lookover-spike-sasensi",
  owner: { id: 11247504, login: "sasensi", type: "User" },
  permissions: PERMISSIONS,
};

const clock = { now: () => AT };

/** What a refused call threw, with the connection's cause it gives. */
async function refusal(call: Promise<unknown>): Promise<{ failure: string; cause: ConnectionCause | null }> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof HostError)) throw new Error(`expected a HostError, got ${String(error)}`);
  return { failure: error.failure, cause: connectionCauseOf(error) };
}

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIE…\n-----END RSA PRIVATE KEY-----\n";

test("a manifest's code is converted with no credentials, at the API address given: the App and its key", async () => {
  const api = stubGitHub((call) =>
    call.method === "POST" && call.path === "/api/v3/app-manifests/c0de/conversions"
      ? {
          status: 201,
          body: {
            ...GITHUB_APP,
            client_id: "Iv23lifFqYv2raaBgVS1",
            client_secret: "secret",
            webhook_secret: null,
            pem: PEM,
          },
        }
      : undefined,
  );
  const host = createHostInstallations({ api: "http://github.test/api/v3", fetch: api.fetch, clock });
  expect(await host.convertManifest("c0de")).toEqual({ app: HOST_APP, key: PEM });
  expect(api.calls.map((c) => [c.origin, c.authorization])).toEqual([["http://github.test", ""]]);
});

test("a code GitHub doesn't know (expired, used) is not found; GitHub out of reach is unreachable", async () => {
  const gone = stubGitHub();
  const host = createHostInstallations({ fetch: gone.fetch, clock });
  expect(await refusal(host.convertManifest("old"))).toEqual({ failure: "not_found", cause: null });
  expect(gone.calls.map((c) => c.origin)).toEqual(["https://api.github.com"]);
  const down = createHostInstallations({
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
    clock,
  });
  expect(await refusal(down.convertManifest("c0de"))).toEqual({
    failure: "unavailable",
    cause: { kind: "unreachable" },
  });
});

/** `GET /app` answering only to the App's own JWT. */
const theApp: Route = (call) =>
  call.path === "/app" && acceptedJwt(call.authorization, AT) ? { status: 200, body: GITHUB_APP } : undefined;

test("the App is read with its own JWT: its owner, its slug and what it holds", async () => {
  const api = stubGitHub(theApp);
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.app(CREDENTIALS)).toEqual(HOST_APP);
});

test("the App level gives `secret` every secret it meets: the key and the JWTs of each call, the code, the new key, the token", async () => {
  const PEM_GIVEN = "-----BEGIN RSA PRIVATE KEY-----\nMIIgiven\n-----END RSA PRIVATE KEY-----\n";
  const api = stubGitHub(
    theApp,
    (call) =>
      call.method === "POST" && call.path === "/app-manifests/c0de-c0de/conversions"
        ? {
            status: 201,
            body: {
              ...GITHUB_APP,
              client_id: "Iv1",
              client_secret: "s",
              webhook_secret: null,
              pem: PEM_GIVEN,
            },
          }
        : undefined,
    granted([repo("sasensi", "lookover-sandbox")], []),
  );
  const secrets: string[] = [];
  const host = createHostInstallations({ fetch: api.fetch, clock, secret: (value) => secrets.push(value) });
  await host.convertManifest("c0de-c0de");
  expect(secrets).toEqual(["c0de-c0de", PEM_GIVEN]);
  await host.app(CREDENTIALS);
  await host.repositories(CREDENTIALS, INSTALLATION.id);
  expect(secrets).toContain(KEY);
  for (const call of api.calls.filter((c) => c.authorization.startsWith("Bearer ey")))
    expect(secrets).toContain(call.authorization.slice("Bearer ".length));
  expect(secrets).toContain("ghs_listing");
});

test("a key GitHub refuses is key-refused, the clock named when GitHub names iat or exp", async () => {
  const refusing = (message: string) =>
    createHostInstallations({ fetch: stubGitHub(() => ({ status: 401, body: { message } })).fetch, clock });
  const cases: [string, ConnectionCause][] = [
    ["Bad credentials", { kind: "key-refused", why: null }],
    [
      "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
      { kind: "key-refused", why: "clock" },
    ],
    ["'Expiration time' claim ('exp') is too far in the future", { kind: "key-refused", why: "clock" }],
    ["A JSON web token could not be decoded", { kind: "key-refused", why: "revoked" }],
    ["Integration not found", { kind: "key-refused", why: "app-deleted" }],
  ];
  for (const [message, cause] of cases)
    expect(await refusal(refusing(message).app(CREDENTIALS))).toEqual({ failure: "unauthorized", cause });
});

test("a key that can't sign is key-refused before any request", async () => {
  const api = stubGitHub(theApp);
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await refusal(host.app({ id: 5202093, key: "not a key" }))).toEqual({
    failure: "unauthorized",
    cause: { kind: "key-refused", why: null },
  });
  expect(api.calls).toEqual([]);
});

const INSTALLATION = {
  id: 168269016,
  account: { ...OWNER, node_id: "MDQ6VXNlcjExMjQ3NTA0" },
  repository_selection: "selected",
  app_id: 5202093,
  target_id: 11247504,
  target_type: "User",
  permissions: PERMISSIONS,
  suspended_at: null,
};
const ELSEWHERE = {
  ...INSTALLATION,
  id: 170000001,
  account: { login: "acme", id: 99, type: "Organization" },
  target_id: 99,
  target_type: "Organization",
};
const SOMEONE = {
  ...INSTALLATION,
  id: 170000002,
  account: { login: "someone", id: 42, type: "User" },
  target_id: 42,
};
const NEXT_INSTALLATIONS = "https://api.github.com/app/installations?per_page=100&page=2";

/** The App's installations, `first` on the first page, `second` on the next: to the spike App's JWT unless `appId`. */
const installations =
  (first: unknown[], second: unknown[], appId = CREDENTIALS.id): Route =>
  (call) => {
    if (!acceptedJwt(call.authorization, AT, appId)) return undefined;
    if (call.path === "/app/installations?per_page=100")
      return { status: 200, body: first, headers: { link: `<${NEXT_INSTALLATIONS}>; rel="next"` } };
    if (call.path === "/app/installations?per_page=100&page=2") return { status: 200, body: second };
    return undefined;
  };

test("the installation is the one on the App's owner's account, read past the first page; others are ignored", async () => {
  const api = stubGitHub(theApp, installations([ELSEWHERE, SOMEONE], [INSTALLATION]));
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.installation(CREDENTIALS)).toEqual({
    id: 168269016,
    account: { id: 11247504, login: "sasensi", type: "User" },
    suspended: false,
  });
});

// An organisation's App as GitHub gives it (ADR 0059): the organisation `lookover-dev` as GitHub describes it, its
// App, its installation on the organisation and a repository of the organisation's (the App's id and slug made up:
// the shapes and the organisation's ids are GitHub's, read on 2026-10-13).
const ORGANISATION = { login: "lookover-dev", id: 338456971, node_id: "O_kgDOFCxxiw", type: "Organization" };
const ORG_CREDENTIALS = { id: 6100001, key: KEY };
const ORG_APP = {
  ...GITHUB_APP,
  id: 6100001,
  slug: "lookover-k3v9qa",
  node_id: "A_kwDOFCxxi84AXRxx",
  owner: { ...ORGANISATION, site_admin: false },
  name: "lookover-k3v9qa",
  html_url: "https://github.com/apps/lookover-k3v9qa",
};
const ORG_INSTALLATION = {
  ...INSTALLATION,
  id: 171000001,
  account: { ...ORGANISATION, site_admin: false },
  repository_selection: "all",
  app_id: 6100001,
  target_id: 338456971,
  target_type: "Organization",
};
const orgRepo = (id: number, name: string) => ({
  id,
  name,
  full_name: `lookover-dev/${name}`,
  owner: { ...ORGANISATION, site_admin: false },
  private: true,
  archived: false,
});

/** `GET /app` answering the organisation's App to its own JWT. */
const theOrgApp: Route = (call) =>
  call.path === "/app" && acceptedJwt(call.authorization, AT, ORG_APP.id)
    ? { status: 200, body: ORG_APP }
    : undefined;

test("an organisation's App is described with the organisation as its owner, converted or read", async () => {
  const described: HostApp = {
    id: 6100001,
    slug: "lookover-k3v9qa",
    owner: { id: 338456971, login: "lookover-dev", type: "Organization" },
    permissions: PERMISSIONS,
  };
  const api = stubGitHub(theOrgApp, (call) =>
    call.method === "POST" && call.path === "/app-manifests/c0de/conversions"
      ? {
          status: 201,
          body: { ...ORG_APP, client_id: "Iv1", client_secret: "s", webhook_secret: null, pem: PEM },
        }
      : undefined,
  );
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.convertManifest("c0de")).toEqual({ app: described, key: PEM });
  expect(await host.app(ORG_CREDENTIALS)).toEqual(described);
});

test("an organisation's App's installation is the one on the organisation, a person's ignored", async () => {
  const api = stubGitHub(theOrgApp, installations([SOMEONE, INSTALLATION], [ORG_INSTALLATION], ORG_APP.id));
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.installation(ORG_CREDENTIALS)).toEqual({
    id: 171000001,
    account: { id: 338456971, login: "lookover-dev", type: "Organization" },
    suspended: false,
  });
  const elsewhere = createHostInstallations({
    fetch: stubGitHub(theOrgApp, installations([ELSEWHERE], [INSTALLATION], ORG_APP.id)).fetch,
    clock,
  });
  expect(await elsewhere.installation(ORG_CREDENTIALS)).toBeNull();
});

test("an organisation's installation lists the organisation's repositories", async () => {
  const api = stubGitHub(
    (call) =>
      call.method === "POST" &&
      call.path === `/app/installations/${ORG_INSTALLATION.id}/access_tokens` &&
      acceptedJwt(call.authorization, AT, ORG_APP.id)
        ? { status: 201, body: { token: "ghs_org", expires_at: iso(AT + HOUR) } }
        : undefined,
    withToken("ghs_org", (listing) =>
      listing.path === "/installation/repositories?per_page=100"
        ? {
            status: 200,
            body: {
              total_count: 2,
              repositories: [orgRepo(1416152976, "lookover"), orgRepo(1416152977, "lookover-sandbox")],
            },
          }
        : undefined,
    ),
  );
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.repositories(ORG_CREDENTIALS, ORG_INSTALLATION.id)).toEqual([
    { owner: "lookover-dev", name: "lookover" },
    { owner: "lookover-dev", name: "lookover-sandbox" },
  ]);
});

test("no installation on the owner's account is none; a suspended one says so", async () => {
  const none = createHostInstallations({
    fetch: stubGitHub(theApp, installations([ELSEWHERE], [SOMEONE])).fetch,
    clock,
  });
  expect(await none.installation(CREDENTIALS)).toBeNull();
  const suspended = { ...INSTALLATION, suspended_at: "2026-10-06T11:00:00Z" };
  const host = createHostInstallations({
    fetch: stubGitHub(theApp, installations([suspended], [])).fetch,
    clock,
  });
  expect(await host.installation(CREDENTIALS)).toMatchObject({ id: 168269016, suspended: true });
});

test("the installation's read refuses as the App's does: a refused key, GitHub out of reach", async () => {
  const refused = createHostInstallations({
    fetch: stubGitHub(() => ({ status: 401, body: { message: "Bad credentials" } })).fetch,
    clock,
  });
  expect(await refusal(refused.installation(CREDENTIALS))).toEqual({
    failure: "unauthorized",
    cause: { kind: "key-refused", why: null },
  });
  const down = createHostInstallations({ fetch: stubGitHub(() => ({ status: 503 })).fetch, clock });
  expect(await refusal(down.installation(CREDENTIALS))).toEqual({
    failure: "unavailable",
    cause: { kind: "unreachable" },
  });
});

const repo = (owner: string, name: string, archived = false) => ({
  id: name.length,
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner, id: 11247504, type: "User" },
  private: true,
  archived,
});
const NEXT_REPOSITORIES = "https://api.github.com/installation/repositories?per_page=100&page=2";

/** The installation's token, bought with the App's JWT, and the repositories it lists on two pages. */
const granted =
  (first: unknown[], second: unknown[]): Route =>
  (call) => {
    if (call.method === "POST" && call.path === `/app/installations/${INSTALLATION.id}/access_tokens`)
      return acceptedJwt(call.authorization, AT)
        ? { status: 201, body: { token: "ghs_listing", expires_at: iso(AT + HOUR) } }
        : { status: 401 };
    return withToken("ghs_listing", (listing) => {
      if (listing.path === "/installation/repositories?per_page=100")
        return {
          status: 200,
          body: { total_count: first.length + second.length, repositories: first },
          headers: { link: `<${NEXT_REPOSITORIES}>; rel="next"` },
        };
      if (listing.path === "/installation/repositories?per_page=100&page=2")
        return { status: 200, body: { total_count: first.length + second.length, repositories: second } };
      return undefined;
    })(call);
  };

test("the installation's repositories are listed past the first page, archived ones left out", async () => {
  const api = stubGitHub(
    granted([repo("sasensi", "lookover-sandbox"), repo("sasensi", "old", true)], [repo("sasensi", "notes")]),
  );
  const host = createHostInstallations({ fetch: api.fetch, clock });
  expect(await host.repositories(CREDENTIALS, INSTALLATION.id)).toEqual([
    { owner: "sasensi", name: "lookover-sandbox" },
    { owner: "sasensi", name: "notes" },
  ]);
  // The listing's token reads the metadata and nothing more.
  expect(api.calls[0]?.body).toEqual({ permissions: { metadata: "read" } });
});

test("with an allow-list, a listed repository outside it is left out, whatever its case", async () => {
  const api = stubGitHub(
    granted([repo("Sasensi", "Lookover-Sandbox"), repo("sasensi", "notes")], [repo("sasensi", "ledger")]),
  );
  const host = createHostInstallations({
    fetch: api.fetch,
    clock,
    repositories: [{ owner: "sasensi", name: "lookover-sandbox" }],
  });
  expect(await host.repositories(CREDENTIALS, INSTALLATION.id)).toEqual([
    { owner: "Sasensi", name: "Lookover-Sandbox" },
  ]);
});

test("an installation gone is uninstalled, a suspended one uninstalled and suspended, a refused key key-refused", async () => {
  const answering = (status: number, message: string) =>
    createHostInstallations({ fetch: stubGitHub(() => ({ status, body: { message } })).fetch, clock });
  expect(await refusal(answering(404, "Not Found").repositories(CREDENTIALS, 1))).toEqual({
    failure: "not_found",
    cause: { kind: "uninstalled", suspended: false },
  });
  expect(
    await refusal(answering(403, "This installation has been suspended").repositories(CREDENTIALS, 1)),
  ).toEqual({
    failure: "unauthorized",
    cause: { kind: "uninstalled", suspended: true },
  });
  expect(await refusal(answering(401, "Bad credentials").repositories(CREDENTIALS, 1))).toEqual({
    failure: "unauthorized",
    cause: { kind: "key-refused", why: null },
  });
});

test("no refusal of a conversion carries the manifest's code: it is a credential for an hour", async () => {
  const CODE = "s3cr3t-c0de";
  const answering = (status: number, body: unknown) =>
    createHostInstallations({ fetch: stubGitHub(() => ({ status, body })).fetch, clock });
  const failures = [
    [404, { message: "Not Found" }, "not_found"],
    [422, { message: "Validation Failed" }, "invalid"],
    [500, { message: "Server Error" }, "unavailable"],
    [201, { surprise: true }, "unavailable"],
  ] as const;
  for (const [status, body, failure] of failures) {
    const error = await answering(status, body)
      .convertManifest(CODE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({
      failure,
      message: expect.stringContaining("/app-manifests/…/conversions"),
    });
    expect(error).toMatchObject({ message: expect.not.stringContaining(CODE) });
  }
  const echoing = createHostInstallations({
    fetch: async (input) => {
      throw new Error(`connect ECONNREFUSED ${input}`);
    },
    clock,
  });
  const down = await echoing.convertManifest(CODE).catch((e: unknown) => e);
  expect(down).toMatchObject({ failure: "unavailable", message: expect.not.stringContaining(CODE) });
});

test("a JWT read of an App GitHub doesn't have (deleted) is key-refused, the App deleted", async () => {
  const host = createHostInstallations({ fetch: stubGitHub().fetch, clock });
  expect(await refusal(host.app(CREDENTIALS))).toEqual({
    failure: "unauthorized",
    cause: { kind: "key-refused", why: "app-deleted" },
  });
});

test("an App id GitHub doesn't know is the App deleted on every JWT request, not an uninstall (seen live)", async () => {
  // GitHub answers every JWT request for an App id it has not with a 404 "Integration not found" (checked on the
  // real API for `/app`, `/app/installations`, `/repos/x/installation` and a token purchase, #192).
  const gone = stubGitHub(() => ({ status: 404, body: { message: "Integration not found" } }));
  const host = createHostInstallations({ fetch: gone.fetch, clock });
  const deleted = { failure: "unauthorized", cause: { kind: "key-refused", why: "app-deleted" } } as const;
  expect(await refusal(host.app(CREDENTIALS))).toEqual(deleted);
  expect(await refusal(host.installation(CREDENTIALS))).toEqual(deleted);
  expect(await refusal(host.repositories(CREDENTIALS, 168269016))).toEqual(deleted);
  // The repository ports too: their installation lookup is a JWT request, and the App is gone, not the repository.
  const ports = createGitHub({ app: APP, fetch: gone.fetch, clock });
  expect(await refusal(ports.intake.listOpenChanges({ owner: "sasensi", name: "lookover-sandbox" }))).toEqual(
    deleted,
  );
});

test("a token purchase refused 403 is never the key: GitHub took the JWT, the installation refuses", async () => {
  const host = createHostInstallations({
    fetch: stubGitHub(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }))
      .fetch,
    clock,
  });
  expect(await refusal(host.repositories(CREDENTIALS, 1))).toEqual({
    failure: "unauthorized",
    cause: { kind: "uninstalled", suspended: true },
  });
});

test("a token purchase asked to wait is rate limited, and cuts nothing", async () => {
  const host = createHostInstallations({
    fetch: stubGitHub(() => ({
      status: 403,
      body: { message: "You have exceeded a secondary rate limit" },
      headers: { "retry-after": "60" },
    })).fetch,
    clock,
  });
  expect(await refusal(host.repositories(CREDENTIALS, 1))).toEqual({ failure: "rate_limited", cause: null });
});

test("the listing refused after its token was bought: suspended meanwhile, or GitHub out of reach", async () => {
  const listingRefused = (status: number, message: string) =>
    createHostInstallations({
      fetch: stubGitHub(
        withToken("ghs_listing", () => ({ status, body: { message } })),
        granted([], []),
      ).fetch,
      clock,
    });
  const suspended = listingRefused(403, "This installation has been suspended");
  expect(await refusal(suspended.repositories(CREDENTIALS, INSTALLATION.id))).toEqual({
    failure: "unauthorized",
    cause: { kind: "uninstalled", suspended: true },
  });
  const down = listingRefused(502, "Bad Gateway");
  expect(await refusal(down.repositories(CREDENTIALS, INSTALLATION.id))).toEqual({
    failure: "unavailable",
    cause: { kind: "unreachable" },
  });
});
