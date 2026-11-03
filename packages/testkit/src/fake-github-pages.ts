// GitHub's web side, faked for demo mode (ADR 0046, ADR 0053, ADR 0073): the pages of github.com the person's browser
// goes through to sign in to the shared App and install it, answered on `FakeGitHost`, so demo mode and `proof` never
// open github.com. The service serves them under its web base (`DEMO_API.github`), the address `Connection.web` holds
// in demo mode, so `githubLinks` built on it land here. `<settings>` is the settings of the person's own account
// (`onGitHub().account`): `<web>/settings`; another account's settings page is not found, but for an installation of
// the shared App on another account the person reaches.
// - `GET <web>/apps/<slug>/installations/new` (the shared App's slug, the host's `onGitHub().slug`): the install
//   page, the account's repositories (archived ones left out) to choose from, all or some. Its form posts back to it:
//   the App is installed on what was chosen (nothing chosen, an installation granting nothing) and the browser goes to
//   the installation's page. Signed in to the shared App with other accounts
//   than the host's (ADR 0067), the page first asks where (`?target=<login>`): the host's account as above, each one
//   it is installed on named, and each of the person's organisations without it offered Install where they own it
//   (all its repositories, `installOn`) or Request where their `gh` says they are a member, which sends GitHub's
//   request to its owners and records nothing on the fake. The page takes the person's role from their `gh`, as
//   if it were signed in: an organisation it doesn't list as a member's, or no `gh` given or signed in, is offered
//   Install, as to an owner. Each account installed is named with Configure, its installation's page.
// - `GET <settings>/installations/<id>`: the installation's page ("Add a repository", a suspended installation's
//   fix): its repositories changed, the installation suspended, lifted or uninstalled, each by a form posting back to
//   it. On another account the shared App reaches (`<web>/organizations/<login>/settings/installations/<id>`, "Choose
//   repositories", "Unsuspend it on GitHub"): its repositories, and Suspend or Unsuspend and Uninstall, posted by an
//   owner alone (the person's role from their `gh`, as the install page takes it; a member's form is refused, 403).
// - `GET <web>/orgs/<login>/people` ("Ask an owner of", its `?query=role:owner`): the organisation's owners, those the
//   fake lists for it (`FakeReach.owners`) and the person where their `gh` says they own it; one the person isn't in is
//   not found. `GET <web>/orgs/<login>/sso` ("Sign in with SSO"): on an organisation the App reaches, Continue posts
//   back and starts the person's SAML session there (`signInSso`).
// - `GET <web>/login/device`: GitHub's device page (ADR 0066), the code a sign-in to the shared App shows asked for;
//   its form posts back to it, entering the code (`enterCode`, Authorize) or refusing it (`denyCode`, Cancel). A code
//   that doesn't wait is a 404 page, and nothing changes. The page the fake's device flow names when made with
//   `devicePage` (demo mode's).
// - `GET <web>/<owner>/<name>/pull/<n>`: the pull request's page, who filed each of its reviews (the person a sign-in
//   posts as, or anyone replying): whom Lookover posted as.
// Any other path is left to the caller (null). Another account's settings page, another App's install page or an
// installation the App hasn't is a 404 page, and does nothing. The pages are plain HTML forms: no script, no style,
// so a strict policy (`form-action 'self'`) serves them. Every name is written as text, never markup.
import type { Gh, HostAccount, RepositoryRef } from "@lookover/contracts";
import { githubLinks, repositoryName } from "@lookover/contracts";
import type { FakeGitHost, FakeGitHubReached, FakeGitHubView } from "./fake-git-host.ts";

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
    `${slug} on ${view.account.login}`,
    `<p>${current.suspended ? "Suspended." : "Installed."}</p>` +
      `<form method="post">${chooser(view, all, current.granted)}` +
      `<button type="submit" name="action" value="save">Save</button></form>` +
      button(pause, label) +
      button("uninstall", "Uninstall"),
  );
}

/** The shared App's installation on another account the person reaches: its repositories, and its buttons. */
function reachedPage(slug: string, other: FakeGitHubReached): Response {
  const [pause, label] = other.suspended ? ["unsuspend", "Unsuspend"] : ["suspend", "Suspend"];
  const button = (action: string, words: string) =>
    `<form method="post"><button type="submit" name="action" value="${action}">${words}</button></form>`;
  const repositories =
    other.repositories.length === 0
      ? "<p>No repository.</p>"
      : `<ul>${other.repositories.map((r) => `<li>${text(repositoryName(r))}</li>`).join("")}</ul>`;
  return page(
    `${slug} on ${other.account.login}`,
    `<p>${other.suspended ? "Suspended." : "Installed."}</p><h2>Repository access</h2>${repositories}` +
      button(pause, label) +
      button("uninstall", "Uninstall"),
  );
}

/**
 * GitHub's pages for the person's account on `host`, under `web` (an absolute address, or a path on the request's
 * origin such as `DEMO_API.github`): a handler that answers a request for one of them, or null for any other.
 * `gh`: the person's own `gh`, which says their role in each organisation.
 */
export function fakeGitHubPages(
  host: FakeGitHost,
  web: string,
  o: { gh?: Pick<Gh, "memberships"> } = {},
): (request: Request) => Promise<Response | null> {
  /**
   * The person's role in `organisation`, as GitHub knows it: a member when their `gh` lists them one, an owner
   * otherwise (no `gh` given, or one that doesn't say).
   */
  const roleOf = async (organisation: string): Promise<"owner" | "member"> => {
    const listed = await o.gh?.memberships();
    if (listed?.kind !== "listed") return "owner";
    const found = listed.organisations.find(
      (m) => m.organisation.login.toLowerCase() === organisation.toLowerCase(),
    );
    return found?.role ?? "owner";
  };

  /** The install page's first question, with other accounts than the host's: on which. */
  const where = async (request: Request, slug: string, view: FakeGitHubView): Promise<Response> => {
    const installed = (account: HostAccount, id: number) =>
      `<li>${text(account.login)}: installed. ` +
      `<a href="${text(githubLinks.installation(base(request), account, id))}">Configure</a></li>`;
    const offered = (login: string, words: string) =>
      `<li>${text(login)}: <a href="?target=${text(encodeURIComponent(login))}">${words}</a></li>`;
    const rows = [
      view.installation === null
        ? offered(view.account.login, "Install")
        : installed(view.account, view.installation.id),
      ...view.reached.map((a) => installed(a.account, a.id)),
    ];
    for (const { account } of view.unreached)
      rows.push(offered(account.login, (await roleOf(account.login)) === "owner" ? "Install" : "Request"));
    return page(`Install ${slug}`, `<p>Where do you want to install it?</p><ul>${rows.join("")}</ul>`);
  };

  /**
   * The install page on one of the person's organisations without the App: Install where they own it (on all its
   * repositories), Request where they are a member, which sends the request to its owners and records nothing here.
   */
  const installElsewhere = async (
    request: Request,
    slug: string,
    organisation: string,
  ): Promise<Response> => {
    const name = text(organisation);
    const role = await roleOf(organisation);
    const button = (action: string, words: string) =>
      `<form method="post"><button type="submit" name="action" value="${action}">${words}</button></form>`;
    if (request.method !== "POST")
      return role === "owner"
        ? page(
            `Install ${slug} on ${organisation}`,
            `<p>On all of ${name}'s repositories.</p>${button("install", "Install")}`,
          )
        : page(
            `Request ${slug} on ${organisation}`,
            `<p>An owner of ${name} installs it. GitHub emails them your request.</p>${button("request", "Request")}`,
          );
    const action = (await request.formData()).get("action");
    if (action === "install" && role === "owner") {
      host.installOn(organisation);
      return page(`${slug} installed`, `<p>Installed on ${name}.</p>`);
    }
    if (action === "request" && role === "member")
      return page(
        "Request sent",
        `<p>GitHub emailed the owners of ${name}. Once one of them installs it, Lookover sees it.</p>`,
      );
    return page("Not allowed", `<p>Only an owner of ${name} installs it.</p>`, 403);
  };

  /**
   * The install page: with other accounts than the host's (the shared App's), first on which (`?target=<login>`
   * none); on the host's account, its repositories to choose from; on an organisation without the App, its own.
   */
  const install = async (request: Request, slug: string): Promise<Response> => {
    const view = host.onGitHub();
    if (view.slug !== slug) return notFound();
    const target = new URL(request.url).searchParams.get("target")?.toLowerCase() ?? null;
    if (target === null && view.reached.length + view.unreached.length > 0) return where(request, slug, view);
    if (target === null || target === view.account.login.toLowerCase())
      return installOwn(request, slug, view);
    const organisation = view.unreached.find((a) => a.account.login.toLowerCase() === target);
    return organisation === undefined
      ? notFound()
      : installElsewhere(request, slug, organisation.account.login);
  };

  /** The install page on the person's account: its repositories to choose from, all or some. */
  const installOwn = async (request: Request, slug: string, view: FakeGitHubView): Promise<Response> => {
    const owner = text(view.account.login);
    if (request.method !== "POST") {
      const granted = view.installation?.granted ?? [];
      return page(
        `Install ${slug}`,
        `<p>On ${owner}.</p><form method="post">${chooser(view, view.installation === null, granted)}` +
          `<button type="submit">Install</button></form>`,
      );
    }
    const id = host.install(chosen(await request.formData(), view));
    return redirect(githubLinks.installation(base(request), view.account, id));
  };

  const installation = async (request: Request, id: number): Promise<Response> => {
    const view = host.onGitHub();
    const { slug, installation: current } = view;
    if (current === null || current.id !== id) return notFound();
    if (request.method !== "POST") return installationPage(view, slug, current);
    const form = await request.formData();
    const action = form.get("action");
    if (action === "uninstall") {
      host.uninstall();
      return page(`${slug} uninstalled`, "<p>The App is no longer installed.</p>");
    }
    if (action === "suspend") host.suspend();
    else if (action === "unsuspend") host.unsuspend();
    else host.install(chosen(form, view));
    return redirect(githubLinks.installation(base(request), view.account, id));
  };

  /**
   * The installation's page on another account the shared App reaches (`<organisation>`'s settings): its
   * repositories, and Suspend or Unsuspend and Uninstall, an owner's alone (a member's form is refused, 403). An id
   * the App hasn't there is not found.
   */
  const otherInstallation = async (request: Request, organisation: string, id: number): Promise<Response> => {
    const view = host.onGitHub();
    const other = view.reached.find(
      (a) => a.id === id && a.account.login.toLowerCase() === organisation.toLowerCase(),
    );
    const slug = view.slug;
    if (other === undefined) return notFound();
    if (request.method !== "POST") return reachedPage(slug, other);
    const login = other.account.login;
    if ((await roleOf(login)) !== "owner")
      return page("Not allowed", `<p>Only an owner of ${text(login)} changes it.</p>`, 403);
    const action = (await request.formData()).get("action");
    if (action === "uninstall") {
      host.uninstall(login);
      return page(`${slug} uninstalled`, `<p>The App is no longer installed on ${text(login)}.</p>`);
    }
    if (action === "suspend") host.suspend(login);
    else if (action === "unsuspend") host.unsuspend(login);
    return redirect(githubLinks.installation(base(request), other.account, id));
  };

  /**
   * An organisation's people, its owners (`?query=role:owner`, the only filter the pages answer): those GitHub lists
   * for it, and the person where their `gh` says they own it. An organisation the person isn't in is not found.
   */
  const ownersPage = async (organisation: string): Promise<Response> => {
    const view = host.onGitHub();
    const same = (login: string) => login.toLowerCase() === organisation.toLowerCase();
    const listed = await o.gh?.memberships();
    const membership =
      listed?.kind === "listed" ? listed.organisations.find((m) => same(m.organisation.login)) : undefined;
    const known = [...view.reached, ...view.unreached].find((a) => same(a.account.login));
    if (known === undefined && membership === undefined) return notFound();
    const login = known?.account.login ?? membership?.organisation.login ?? organisation;
    const owners = [...(known?.owners ?? [])];
    if (listed?.kind === "listed" && membership?.role === "owner" && !owners.includes(listed.person.login))
      owners.push(listed.person.login);
    const rows =
      owners.length === 0
        ? "<p>No owner is listed.</p>"
        : `<ul>${owners.map((owner) => `<li>${text(owner)}</li>`).join("")}</ul>`;
    return page(`Owners of ${login}`, `<p>Ask one of them to install or unsuspend the App.</p>${rows}`);
  };

  /**
   * An organisation's single sign-on page (ADR 0066), one the shared App reaches: Continue starts the person's SAML
   * session there (`signInSso`), and its repositories answer again. Another organisation is not found.
   */
  const ssoPage = async (request: Request, organisation: string): Promise<Response> => {
    const other = host
      .onGitHub()
      .reached.find((a) => a.account.login.toLowerCase() === organisation.toLowerCase());
    if (other === undefined) return notFound();
    const login = text(other.account.login);
    if (request.method !== "POST")
      return page(
        `Single sign-on to ${other.account.login}`,
        `<p>${login} asks you to sign in with its identity provider.</p>` +
          `<form method="post"><button type="submit" name="action" value="continue">Continue</button></form>`,
      );
    host.signInSso(other.account.login);
    return page(
      "Signed in with SSO",
      `<p>Your session on ${login} is active. Lookover sees it at its next look.</p>`,
    );
  };

  /**
   * GitHub's device page (ADR 0066): the code asked for, then entered with Authorize or refused with Cancel, as the
   * person does on github.com/login/device. A code that doesn't wait is not found, and nothing changes.
   */
  const devicePage = async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return page(
        "Device activation",
        '<p>Enter the code Lookover shows.</p><form method="post">' +
          '<label>Code <input name="user_code" autocomplete="off"></label> ' +
          '<button type="submit" name="action" value="authorize">Authorize Lookover</button> ' +
          '<button type="submit" name="action" value="cancel">Cancel</button></form>',
      );
    const form = await request.formData();
    const code = String(form.get("user_code") ?? "")
      .trim()
      .toUpperCase();
    try {
      if (form.get("action") === "cancel") host.denyCode(code);
      else host.enterCode(code);
    } catch {
      return page(
        "No such code",
        "<p>That code isn't waiting. Check the code Lookover shows, then try again.</p>",
        404,
      );
    }
    return form.get("action") === "cancel"
      ? page("Sign-in cancelled", "<p>Lookover is not signed in. You can close this tab.</p>")
      : page("You're signed in", "<p>Lookover sees it within a few seconds. You can close this tab.</p>");
  };

  /**
   * A pull request's page: who filed each of its reviews, in order, as GitHub names them at the top of each (the person
   * a sign-in posts as, ADR 0066, or anyone replying). One the host hasn't is not found.
   */
  const pullPage = (repo: RepositoryRef, number: number): Response => {
    let reviewers: string[];
    try {
      reviewers = host.reviewers({ repo, number });
    } catch {
      return notFound();
    }
    const listed =
      reviewers.length === 0
        ? "<p>No review yet.</p>"
        : `<ul>${reviewers.map((login) => `<li>Reviewed by ${text(login)}.</li>`).join("")}</ul>`;
    return page(`${repositoryName(repo)} #${number}`, listed);
  };

  /** The web base as an absolute address, on the request's origin when it is a path. */
  const base = (request: Request) => new URL(web, request.url).href.replace(/\/$/, "");

  /** An organisation's page: its single sign-on (`sso`), or its owners (`people`, read only). */
  const organisationPage = (request: Request, organisation: string, which: string | undefined) => {
    if (which === "sso") return ssoPage(request, organisation);
    return request.method === "GET" ? ownersPage(organisation) : null;
  };

  /**
   * The person's settings, under `/settings`. Another account's (`/organizations/<login>/settings`, ADR 0059) are not
   * found, and do nothing, but for the installations of the shared App on the other accounts the person reaches.
   */
  const accountSettings = async (request: Request, path: string): Promise<Response | null> => {
    const settings = /^(?:\/organizations\/([^/]+))?\/settings(\/.+)$/.exec(path);
    if (settings?.[2] === undefined) return null;
    const [, organisation, rest] = settings;
    const id = /^\/installations\/(\d+)$/.exec(rest)?.[1];
    if (id === undefined) return null;
    return organisation === undefined
      ? installation(request, Number(id))
      : otherInstallation(request, decodeURIComponent(organisation), Number(id));
  };

  return async (request) => {
    const url = new URL(request.url);
    const root = base(request);
    if (!url.href.startsWith(`${root}/`)) return null;
    const path = url.href.slice(root.length).replace(/[?#].*$/, "");
    if (path === "/login/device") return devicePage(request);
    const installing = /^\/apps\/([^/]+)\/installations\/new$/.exec(path);
    if (installing?.[1] !== undefined) return install(request, decodeURIComponent(installing[1]));
    const org = /^\/orgs\/([^/]+)\/(people|sso)$/.exec(path);
    if (org?.[1] !== undefined) return organisationPage(request, decodeURIComponent(org[1]), org[2]);
    const pull = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(path);
    if (pull?.[1] !== undefined && pull[2] !== undefined && request.method === "GET") {
      const repo = { owner: decodeURIComponent(pull[1]), name: decodeURIComponent(pull[2]) };
      return pullPage(repo, Number(pull[3]));
    }
    return accountSettings(request, path);
  };
}
