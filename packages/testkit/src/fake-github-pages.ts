// GitHub's web side, faked for demo mode (ADR 0046, ADR 0053): the pages of github.com the owner's browser goes
// through to make and install the App, answered on `FakeGitHost`, so demo mode and `proof` never open github.com.
// The service serves them under its web base (`DEMO_API.github`), the address `Connection.web` holds in demo mode,
// so `githubLinks` built on it land here. `<settings>` is the settings of the host's account (`onGitHub().account`):
// `<web>/settings` when it is a person's, `<web>/organizations/<login>/settings` when it is an organisation's (ADR
// 0059, the login matched without case); another account's settings page is not found.
// - `POST <settings>/apps/new?state=…` with the form field `manifest` (GitHub's manifest JSON): makes the App on the
//   host's account (`createApp`) at once, with no page to confirm, and redirects to the manifest's `redirect_url`
//   with `code` and `state`, as GitHub does once the owner confirms. A manifest that isn't JSON, has no `name` or
//   `redirect_url`, or whose `redirect_url` or `setup_url` isn't an address on the request's origin is refused (422)
//   and makes nothing: the pages send the browser to the service only.
// - `GET <web>/apps/<slug>/installations/new`: the install page, the account's repositories (archived ones left out)
//   to choose from, all or some. Its form posts back to it: the App is installed on what was chosen (nothing chosen,
//   an installation granting nothing) and the browser goes to the manifest's `setup_url` with `installation_id` and
//   `setup_action=install`, or, with none, to the installation's page.
// - `GET <settings>/installations/<id>`: the installation's page ("Add a repository", a suspended installation's
//   fix): its repositories changed, the installation suspended, lifted or uninstalled, each by a form posting back to
//   it.
// - `GET <settings>/apps`: the account's Apps, each linking to its page. `GET <settings>/apps/<slug>`: the App's page,
//   its id and "Generate a private key", whose form posts back to it and answers the new key as a `.pem` file to
//   download, as GitHub does: what "Add a new key" and "Use an existing App" are given.
// Any other path is left to the caller (null). Another account's settings page, another App's install page or an
// installation the App hasn't is a 404 page, and does nothing. The pages are plain HTML forms: no script, no style,
// so a strict policy (`form-action 'self'`) serves them. Every name is written as text, never markup.
import type { HostAccount, RepositoryRef } from "@lookover/contracts";
import { githubLinks, repositoryName } from "@lookover/contracts";
import type { FakeGitHost, FakeGitHubView } from "./fake-git-host.ts";

/** A page's text, safe in HTML. */
const text = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${text(title)} · GitHub (demo)</title></head>` +
      `<body><main><h1>${text(title)}</h1>${body}</main></body></html>\n`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const notFound = () => page("Not found", "<p>This page is not on GitHub.</p>", 404);

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** The repositories to choose from, those `granted` ticked, and the choice of all or some. */
function chooser(view: FakeGitHubView, all: boolean, granted: RepositoryRef[]): string {
  const ticked = new Set(granted.map((r) => repositoryName(r).toLowerCase()));
  const rows = view.repositories
    .filter((r) => !r.archived)
    .map(({ repo }) => {
      const name = text(repositoryName(repo));
      const checked = ticked.has(repositoryName(repo).toLowerCase()) ? " checked" : "";
      return `<li><label><input type="checkbox" name="repository" value="${name}"${checked}> ${name}</label></li>`;
    })
    .join("");
  const choice = (value: string, label: string, on: boolean) =>
    `<label><input type="radio" name="selection" value="${value}"${on ? " checked" : ""}> ${label}</label>`;
  return (
    `<fieldset><legend>Repository access</legend>${choice("all", "All repositories", all)} ` +
    `${choice("selected", "Only select repositories", !all)}<ul>${rows}</ul></fieldset>`
  );
}

/** The repositories a form chose: none for "all", else each ticked one the owner has. */
function chosen(form: FormData, view: FakeGitHubView): RepositoryRef[] | undefined {
  if (form.get("selection") === "all") return undefined;
  const names = new Set(form.getAll("repository").map((v) => String(v).toLowerCase()));
  return view.repositories.map((r) => r.repo).filter((r) => names.has(repositoryName(r).toLowerCase()));
}

/** The installation's page: its repositories to change, and the buttons to suspend, lift or uninstall it. */
function installationPage(
  view: FakeGitHubView,
  slug: string,
  current: NonNullable<FakeGitHubView["installation"]>,
): Response {
  const all = current.granted.length === view.repositories.length;
  const [pause, label] = current.suspended ? ["unsuspend", "Unsuspend"] : ["suspend", "Suspend"];
  const button = (action: string, words: string) =>
    `<form method="post"><button type="submit" name="action" value="${action}">${words}</button></form>`;
  return page(
    `${slug} on ${view.app?.owner.login ?? ""}`,
    `<p>${current.suspended ? "Suspended." : "Installed."}</p>` +
      `<form method="post">${chooser(view, all, current.granted)}` +
      `<button type="submit" name="action" value="save">Save</button></form>` +
      button(pause, label) +
      button("uninstall", "Uninstall"),
  );
}

/** `raw` as an absolute address on `origin`, or null when it isn't one: the pages send the browser nowhere else. */
function onOrigin(raw: unknown, origin: string): string | null {
  const url = typeof raw === "string" && URL.canParse(raw) ? new URL(raw) : null;
  return url !== null && url.origin === origin ? url.href : null;
}

/**
 * A manifest's fields the fake reads, or null when it isn't one it takes: its callback and setup page (when it
 * names one) must be addresses on `origin`, the request's, so demo mode is never sent off to another site.
 */
function manifestOf(
  raw: unknown,
  origin: string,
): {
  name: string;
  redirect: string;
  setup: string | null;
  permissions: Record<string, "read" | "write" | "admin">;
} | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const fields: Map<string, unknown> = new Map(Object.entries(parsed));
  const name = fields.get("name");
  const redirect = onOrigin(fields.get("redirect_url"), origin);
  const setup = fields.has("setup_url") ? onOrigin(fields.get("setup_url"), origin) : undefined;
  if (typeof name !== "string" || name.trim() === "" || redirect === null || setup === null) return null;
  return {
    name,
    redirect,
    setup: setup ?? null,
    permissions: permissionsOf(fields.get("default_permissions")),
  };
}

/**
 * GitHub's pages for the owner's account on `host`, under `web` (an absolute address, or a path on the request's
 * origin such as `DEMO_API.github`): a handler that answers a request for one of them, or null for any other.
 */
export function fakeGitHubPages(
  host: FakeGitHost,
  web: string,
): (request: Request) => Promise<Response | null> {
  /** Each App's setup page, by slug, as its manifest named it. */
  const setupPages = new Map<string, string>();

  const newApp = async (request: Request, url: URL): Promise<Response> => {
    const manifest = manifestOf((await request.formData()).get("manifest"), url.origin);
    if (manifest === null)
      return page("Invalid manifest", "<p>The App's manifest could not be read.</p>", 422);
    const code = host.createApp({ name: manifest.name, permissions: manifest.permissions });
    const slug = host.onGitHub().app?.slug ?? "";
    if (manifest.setup !== null) setupPages.set(slug, manifest.setup);
    const back = new URL(manifest.redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return redirect(back.href);
  };

  const install = async (request: Request, slug: string): Promise<Response> => {
    const view = host.onGitHub();
    if (view.app === null || view.app.slug !== slug) return notFound();
    const owner = text(view.app.owner.login);
    if (request.method !== "POST") {
      const granted = view.installation?.granted ?? [];
      return page(
        `Install ${slug}`,
        `<p>On ${owner}.</p><form method="post">${chooser(view, view.installation === null, granted)}` +
          `<button type="submit">Install</button></form>`,
      );
    }
    const id = host.install(chosen(await request.formData(), view));
    const setup = setupPages.get(slug);
    if (setup === undefined) return redirect(githubLinks.installation(base(request), view.app.owner, id));
    const next = new URL(setup);
    next.searchParams.set("installation_id", String(id));
    next.searchParams.set("setup_action", "install");
    return redirect(next.href);
  };

  const installation = async (request: Request, id: number): Promise<Response> => {
    const view = host.onGitHub();
    const { app, installation: current } = view;
    if (app === null || current === null || current.id !== id) return notFound();
    if (request.method !== "POST") return installationPage(view, app.slug, current);
    const form = await request.formData();
    const action = form.get("action");
    if (action === "uninstall") {
      host.uninstall();
      return page(`${app.slug} uninstalled`, "<p>The App is no longer installed.</p>");
    }
    if (action === "suspend") host.suspend();
    else if (action === "unsuspend") host.unsuspend();
    else host.install(chosen(form, view));
    return redirect(githubLinks.installation(base(request), app.owner, id));
  };

  const apps = (request: Request): Response => {
    const { app } = host.onGitHub();
    if (app === null) return page("GitHub Apps", "<p>No GitHub Apps yet.</p>");
    const href = text(githubLinks.app(base(request), app.owner, app.slug));
    return page("GitHub Apps", `<ul><li><a href="${href}">${text(app.slug)}</a></li></ul>`);
  };

  const appPage = (request: Request, slug: string): Response => {
    const { app } = host.onGitHub();
    if (app === null || app.slug !== slug) return notFound();
    if (request.method === "POST") {
      return new Response(host.generateKey(), {
        headers: {
          "content-type": "application/x-pem-file",
          "content-disposition": `attachment; filename="${slug}.private-key.pem"`,
        },
      });
    }
    return page(
      slug,
      `<p>App ID: ${app.id}</p><p>Owned by ${text(app.owner.login)}.</p><h2>Private keys</h2>` +
        `<form method="post"><button type="submit" name="action" value="generate-key">` +
        "Generate a private key</button></form>",
    );
  };

  /** The web base as an absolute address, on the request's origin when it is a path. */
  const base = (request: Request) => new URL(web, request.url).href.replace(/\/$/, "");

  /** The settings page `page` of the account (`/settings<page>`) to answer, or null for one GitHub hasn't. */
  const settingsPage = (
    request: Request,
    url: URL,
    page: string,
  ): (() => Promise<Response> | Response) | null => {
    if (page === "/apps/new" && request.method === "POST") return () => newApp(request, url);
    const settings = /^\/installations\/(\d+)$/.exec(page);
    if (settings?.[1] !== undefined) return () => installation(request, Number(settings[1]));
    if (page === "/apps" && request.method === "GET") return () => apps(request);
    const appSettings = /^\/apps\/([^/]+)$/.exec(page);
    if (appSettings?.[1] !== undefined)
      return () => appPage(request, decodeURIComponent(appSettings[1] ?? ""));
    return null;
  };

  return async (request) => {
    const url = new URL(request.url);
    const root = base(request);
    if (!url.href.startsWith(`${root}/`)) return null;
    const path = url.href.slice(root.length).replace(/[?#].*$/, "");
    const installing = /^\/apps\/([^/]+)\/installations\/new$/.exec(path);
    if (installing?.[1] !== undefined) return install(request, decodeURIComponent(installing[1]));
    // The account's settings: a person's under `/settings`, an organisation's under `/organizations/<login>/settings`
    // (ADR 0059). Another account's are not found, and do nothing: the host holds one account.
    const settings = /^(?:\/organizations\/([^/]+))?\/settings(\/.+)$/.exec(path);
    if (settings?.[2] === undefined) return null;
    const answer = settingsPage(request, url, settings[2]);
    if (answer === null) return null;
    return isTheAccount(host.onGitHub().account, settings[1]) ? answer() : notFound();
  };
}

/** Whether a settings path's organisation (none: a person's own `/settings`) is `account`'s, without case as GitHub. */
function isTheAccount(account: HostAccount, organisation: string | undefined): boolean {
  if (organisation === undefined) return account.type === "User";
  return (
    account.type === "Organization" &&
    decodeURIComponent(organisation).toLowerCase() === account.login.toLowerCase()
  );
}

/** A manifest's permissions as the App holds them: GitHub's levels only. */
function permissionsOf(raw: unknown): Record<string, "read" | "write" | "admin"> {
  const held: Record<string, "read" | "write" | "admin"> = {};
  if (typeof raw !== "object" || raw === null) return held;
  for (const [name, level] of Object.entries(raw))
    if (level === "read" || level === "write" || level === "admin") held[name] = level;
  return held;
}
