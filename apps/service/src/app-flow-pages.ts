// The manifest flow's pages (ADR 0053), at the paths `APP_FLOW` names, mounted on the API by one call:
// - `manifest`: what "Create it on GitHub" opens in a new tab, session-checked like the API. It opens a flow and posts
//   the App's manifest to GitHub's "new App" page with the flow's state (your own account's, or the organisation's
//   "Create it on GitHub" chose, ADR 0059: never one its query names), by its script once the page is read (a
//   button too, should the script not run). Its policy's `form-action` is GitHub's web base and nothing else. Its
//   referrer policy is `strict-origin`, not the API's `no-referrer`: the post then carries the app's origin, as a form
//   on any page does, where `no-referrer` would make it `Origin: null`. Refused under `live.json` or once an App is
//   kept: "No new App here"; and when the last "Create it on GitHub" wasn't taken: "Choose where to make the App".
//   Opened while that command still reads `gh`, it waits for the answer.
// - `callback`: where GitHub's redirect brings the code back. No session and no same-site request (`OPEN_PAGES`: the
//   session cookie is `SameSite=Strict`, which a redirect from github.com doesn't carry): the flow's state alone. Its
//   query is never logged. Kept, the tab goes to the App's install page with no referrer; otherwise a page says what
//   to do (create the App again from setup, or reload within the hour when GitHub was out of reach); an App GitHub
//   made on another account than chosen is named with that account, Lookover not using it.
// - `installed`: the install's `setup_url`, "Lookover is installed", reading nothing it is given.
// Every one is a stand-alone page (ADR 0058, design system "Stand-alone page"): the design system's own stylesheet
// (`@lookover/web/standalone`, one source, no copy) in its one style, and its one script setting the theme the app
// stored, both allowed by a nonce under the page's own policy, which replaces the API's; classes only, never a
// `style` attribute; the eyes, the app's own icon; Back to setup (Back to Lookover once setup is done), a plain link
// to the app, which a click from this page reaches as a same-site navigation, the session cookie with it. Still no
// app bundle and no session needed.
// In demo mode, GitHub's own pages are the fake's (`DEMO_API.github`, served by the demo driver), so the flow runs
// end to end on the fakes and never reaches github.com: their forms post back to the service, whose same-site guard
// takes them under a `same-origin` referrer policy; the manifest names the App the same each run. Demo mode also
// shows each refusal's page as it is (`DEMO_PAGES`), for proof: some can't happen on the fakes.
// The words are product copy (brand.md): short and plain, each page one thing to do.
import { randomBytes } from "node:crypto";
import { APP_FLOW, createAppRefusalText, DEMO_API, githubLinks, type NoNewApp } from "@lookover/contracts";
import { appManifest } from "@lookover/github";
import { EYES_SVG, STANDALONE_STYLE, THEME_KEY } from "@lookover/web/standalone";
import type { Context, Env, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FlowBack, MadeElsewhere, OpenRefusal } from "./app-flow.ts";
import type { DemoRoom } from "./demo/driver.ts";
import type { Room } from "./room.ts";

/** The pages GitHub's redirects reach: no session, no same-site check. */
export const OPEN_PAGES: ReadonlySet<string> = new Set([APP_FLOW.callback, APP_FLOW.installed]);

/** Demo mode only: each refusal's page, at `<DEMO_PAGES>/<refusal>`, session-checked like the API. */
const DEMO_PAGES = `${DEMO_API.listing}/pages`;

export interface AppFlowPagesDeps {
  /** The app's origin: the manifest's redirect and setup pages are on it. */
  origin: string;
  room(): Room;
  demo(): DemoRoom | null;
}

/** Text safe in HTML. */
const text = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A page, its status and its own content security policy. */
interface Page {
  html: string;
  status: ContentfulStatusCode;
  policy: string;
}

/**
 * Sets the theme the app stored before the page is drawn, as the app's store does: light, or the system's when it
 * says light; dark otherwise, and when the browser keeps nothing.
 */
const THEME_SCRIPT =
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});` +
  `if(t==="light"||(t==="system"&&matchMedia("(prefers-color-scheme: light)").matches))` +
  `document.documentElement.setAttribute("data-theme","light")}catch(e){}`;

/**
 * Where a page leads back to: setup while it runs, else Lookover itself (the flow started again from Settings), and
 * the name the lines give that place.
 */
interface Back {
  link: string;
  place: string;
}

const backTo = (setupDone: boolean): Back =>
  setupDone ? { link: "Back to Lookover", place: "Lookover" } : { link: "Back to setup", place: "setup" };

/**
 * A stand-alone page: the eyes, `title`, its lines and its one action (the link `back` names, unless `action` is
 * given), under a policy allowing its one style and its one script by a fresh nonce, and forms to `formAction` only
 * (none by default).
 */
function page(
  title: string,
  lines: string[],
  status: ContentfulStatusCode,
  o: ({ back: Back } | { action: string }) & { script?: string; formAction?: string },
): Page {
  const nonce = randomBytes(16).toString("base64");
  const body = lines.map((line) => `<p class="t-body-lg">${text(line)}</p>`).join("");
  const action = "action" in o ? o.action : `<a class="btn btn-primary" href="/">${text(o.back.link)}</a>`;
  return {
    html:
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${text(title)} · Lookover</title>` +
      `<script nonce="${nonce}">${THEME_SCRIPT}${o.script ?? ""}</script>` +
      `<style nonce="${nonce}">${STANDALONE_STYLE}</style></head>` +
      `<body><main class="standalone"><div class="standalone-mark">${EYES_SVG}</div>` +
      `<h1 class="t-h2">${text(title)}</h1>${body}${action}</main></body></html>\n`,
    status,
    policy: [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `form-action ${o.formAction ?? "'none'"}`,
    ].join("; "),
  };
}

const START_AGAIN = "Back in setup, choose “Create it on GitHub” again.";

type Refused = Extract<FlowBack, { refused: unknown }>["refused"] | OpenRefusal;

/** An App GitHub made elsewhere than asked: where it is, and that Lookover doesn't use it. */
const elsewhere = ({ slug, account, asked }: MadeElsewhere, back: Back): Page =>
  page(
    "GitHub made the App on another account",
    [
      `GitHub made ${slug} on ${account.login}, not on ${asked ?? "your GitHub account"}.`,
      "Lookover doesn't use it: you can delete it in its settings on GitHub.",
      START_AGAIN,
    ],
    400,
    { back },
  );

/** The App demo mode's page of `elsewhere` names: made on a person's account, an organisation asked for. */
const DEMO_ELSEWHERE: MadeElsewhere = {
  slug: "lookover-demo",
  account: { id: 1, login: "sam", type: "User" },
  asked: "acme",
};

/** The page for each refusal of the callback, and of the manifest page for the last three. */
const REFUSED: Record<Exclude<Refused, "elsewhere">, (back: Back) => Page> = {
  unknown: (back) =>
    page("This page ran out", ["It was used already, or never opened by Lookover.", START_AGAIN], 400, {
      back,
    }),
  expired: (back) =>
    page("This page ran out", ["GitHub's page is good for an hour, once.", START_AGAIN], 400, { back }),
  refused: (back) => page("GitHub refused to make the App", [START_AGAIN], 400, { back }),
  unreachable: (back) =>
    page(
      "GitHub couldn't be reached",
      ["Your App isn't lost: within the hour, reload this page to try again."],
      502,
      { back },
    ),
  "not-kept": (back) =>
    page(
      "Lookover couldn't keep the App's key",
      [
        "The App is made on GitHub. Generate a new key on its settings page, then give it to Lookover in setup, under “Use an existing App”.",
      ],
      500,
      { back },
    ),
  "live-config": (back) => noNewApp("live-config", back),
  "already-made": (back) => noNewApp("already-made", back),
  "no-place": (back) =>
    page(
      "Choose where to make the App",
      ["Lookover didn't take the account you chose last.", START_AGAIN],
      409,
      { back },
    ),
};

/** Why no App is made here, as the setup screen says it. */
function noNewApp(why: NoNewApp, back: Back): Page {
  const goesOn = back.place === "setup" ? "Setup goes on" : "Lookover goes on";
  return page(
    "No new App here",
    [createAppRefusalText({ kind: why }), `${goesOn} with the App Lookover keeps.`],
    409,
    {
      back,
    },
  );
}

/** The page that posts the manifest to GitHub: its form goes to `web` only, sent by its script once the page is read. */
function manifestPage(action: string, manifest: string, web: string): Page {
  const form =
    `<form id="manifest" method="post" action="${text(action)}">` +
    `<input type="hidden" name="manifest" value="${text(manifest)}">` +
    `<button class="btn btn-primary" type="submit">Continue to GitHub</button></form>`;
  return page("Opening GitHub…", ["GitHub may ask for your password, then you confirm."], 200, {
    action: form,
    script: `document.addEventListener("DOMContentLoaded",function(){document.getElementById("manifest").submit()});`,
    // A trailing slash: GitHub's whole site, or the fake's pages under its base, and nothing else.
    formAction: `${web}/`,
  });
}

/**
 * A page sent through the API's context, with the headers the API sets on every response, its policy replacing the
 * API's (set before the route).
 */
const shown = <E extends Env>(c: Context<E>, { html, status, policy }: Page) => {
  c.header("Content-Security-Policy", policy);
  return c.html(html, status);
};

const isRefused = (name: string): name is Refused => name === "elsewhere" || Object.hasOwn(REFUSED, name);

/** A refusal's page: `elsewhere`'s names where the App is. */
const refusedPage = (refused: Refused, back: Back, made: MadeElsewhere = DEMO_ELSEWHERE): Page =>
  refused === "elsewhere" ? elsewhere(made, back) : REFUSED[refused](back);

/** A refusal of the manifest flow, by the name of its page. */
export type RefusedPage = Refused;

/** Each refusal's page, by name, as demo mode shows it at `<DEMO_PAGES>/<name>`, for proof. */
export const REFUSED_PAGES: readonly RefusedPage[] = [...Object.keys(REFUSED), "elsewhere"].filter(isRefused);

/** The manifest flow's pages, and in demo mode GitHub's fake ones and each refusal's page, on the API. */
export function appFlowPages<E extends Env>(app: Hono<E>, deps: AppFlowPagesDeps): void {
  const { origin, room } = deps;
  /** GitHub's web base as an absolute address, without a trailing slash. */
  const webOf = () => new URL(room().snapshot().connection.web, origin).href.replace(/\/$/, "");
  /** Where the pages lead back to now: setup, or Lookover once setup is done. */
  const back = () => backTo(room().snapshot().setup.done);

  app.get(APP_FLOW.manifest, async (c) => {
    const opened = await room().github.flow.open();
    if ("refused" in opened) return shown(c, refusedPage(opened.refused, back()));
    const web = webOf();
    const manifest = appManifest({
      redirectUrl: `${origin}${APP_FLOW.callback}`,
      setupUrl: `${origin}${APP_FLOW.installed}`,
    });
    // Demo mode names it the same each run: GitHub's fake page takes the name as given.
    const named = deps.demo()?.appName;
    const posting = manifestPage(
      githubLinks.newApp(web, opened.organisation, opened.state),
      JSON.stringify(named === undefined ? manifest : { ...manifest, name: named }),
      web,
    );
    // Its form's post carries the app's origin, as a form on any page does (with no referrer at all, the browser
    // says `Origin: null`), and no more of the address.
    c.header("Referrer-Policy", "strict-origin");
    return shown(c, posting);
  });

  app.get(APP_FLOW.callback, async (c) => {
    const came = await room().github.flow.back(c.req.query("state") ?? "", c.req.query("code") ?? "");
    if ("refused" in came)
      return shown(
        c,
        came.refused === "elsewhere" ? elsewhere(came.made, back()) : REFUSED[came.refused](back()),
      );
    return c.redirect(githubLinks.install(room().snapshot().connection.web, came.done.slug), 303);
  });

  app.get(APP_FLOW.installed, (c) => {
    const to = back();
    const lines = [`Your repositories show in ${to.place} within a few seconds.`];
    return shown(c, page("Lookover is installed", lines, 200, { back: to }));
  });

  // Demo mode (ADR 0046): each refusal's page as GitHub's redirect would get it, for proof; nothing in live mode.
  app.get(`${DEMO_PAGES}/:refused`, (c) => {
    const refused = c.req.param("refused");
    if (deps.demo() === null || !isRefused(refused)) return c.json({ error: "no such page" }, 404);
    return shown(c, refusedPage(refused, back()));
  });

  // Demo mode (ADR 0046): GitHub's pages, faked on the demo world's host; nothing in live mode.
  app.all(`${DEMO_API.github}/*`, async (c) => {
    const pages = deps.demo()?.github ?? null;
    const answer = pages === null ? null : await pages(c.req.raw);
    if (answer === null) return c.json({ error: "no such page" }, 404);
    // Through the API's context, so they keep its policy and `nosniff`; their forms post back to the service,
    // which takes a post only from its own origin.
    c.header("Referrer-Policy", "same-origin");
    return c.newResponse(answer.body, answer);
  });
}
