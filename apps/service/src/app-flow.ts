// The manifest flow (ADR 0053, exploration 09 D3): how a new owner's App is made on GitHub from Lookover. "Create it
// on GitHub" records where the App is made and that the setup waits for it (`createApp`); the page it opens opens a
// flow (`open`): a new random state, kept in the store by its hash with the moment it was opened and the place it was
// opened for, so a restart doesn't lose it. GitHub's redirect brings the state back with a code (`back`): accepted
// only for a flow opened in the last hour; the code converted on GitHub; the App (its id, slug, account and key;
// GitHub's client and webhook secrets are never kept) adopted by the room (kept in the App store, its install then
// waited for); the flow used up only once the code is spent, so a conversion GitHub could not be reached for can be
// tried again within the hour. Why it stopped short is the setup's to show (`githubRefused`): the flow ran out,
// GitHub out of reach, or GitHub refusing the code.
// Where (ADR 0059): your own account, as before, never asking the person's `gh`; or an organisation, accepted only
// when `gh`, read then (`gh.read`, which the setup's GitHub step shows), is signed in and lists it among the
// organisations its account is an active admin of. The organisation and that person are kept as the place chosen
// (the store's), each flow keeps the place its page was opened for, and the page posts to that organisation's "new
// App" page: never where a query says. A choice is nowhere until it is taken: the page opened while `gh` is read for
// it waits for the answer (the screen opens it as it sends the command), and after a refusal, or a restart that cut
// the read short, the page refuses (`no-place`) rather than go to the place chosen before; the last choice sent is the
// place, whichever `gh` answers last. Back from GitHub, an organisation's App is kept for the person its flow kept;
// your own account's for the account GitHub names, the person being it. An App GitHub made elsewhere than the flow's
// place is not kept (`elsewhere`: the page and the setup say where it is, and that it can be deleted on GitHub).
// Refusals: under `live.json` (the developers' runs never create an App, ADR 0045) and once an App is kept, both
// `createApp` and the page refuse, and so does a redirect that comes back after an App was kept meanwhile (nothing is
// converted then: GitHub would hand a second App's key to nobody). `createApp` on an organisation also refuses as `gh`
// says (`gh-missing`, `gh-signed-out`, `gh-unanswered`) or for one it doesn't list (`not-an-admin`), changing nothing.
// Ordering: redirects are handled one at a time, and one at a time with "Use an existing App" (the room's
// `oneAtATime`), so a tab reloaded while its first try converts finds the flow used up rather than spending the code
// twice, and an App given in another tab meanwhile is kept or refused, never both kept.
// It must never know: HTTP (the pages are `app-flow-pages.ts`'s), or how the App is kept (the room's `adopt`); and it
// never logs, sends or keeps the code or the key.
import { createHash, randomBytes } from "node:crypto";
import {
  type Clock,
  type CreateAppRefusal,
  type GhAdminOrganisations,
  type GhPerson,
  type GhUnanswered,
  ghRefusalOf,
  type HostAccount,
  HostError,
  type HostInstallations,
  type ManifestConversion,
  type NoNewApp,
  type SetupGitHubRefusal,
} from "@lookover/contracts";
import type { AppPlace, Store } from "@lookover/store";
import { type StoredApp, storedApp } from "./app-store.ts";
import { storedOf } from "./installation.ts";
import { flowLines } from "./log-lines.ts";
import { said } from "./said.ts";

/** How long a flow's state is accepted after its page was opened: GitHub's code lives as long. */
const FLOW_MS = 60 * 60_000;

/**
 * What the person's own `gh` said, as `GhChoices` says it but with `gh`'s own words when it couldn't answer: those go
 * to the log, never to the UI.
 */
export interface GhRead {
  person: GhPerson;
  organisations: GhAdminOrganisations;
}

export interface AppFlowDeps {
  store: Pick<Store, "appFlows">;
  clock: Clock;
  /** The App kept now (none: a flow may open), GitHub at the App level, and the room's adoption of a new App. */
  github: {
    app(): StoredApp | null;
    installations: Pick<HostInstallations, "convertManifest">;
    adopt(app: StoredApp, key: string): Promise<void>;
    /** `work` after every other check and adoption of an App ("Use an existing App"'s too), one at a time. */
    oneAtATime<T>(work: () => Promise<T>): Promise<T>;
  };
  /** The person's own `gh`, read now (and shown by the setup's GitHub step): who it is, the organisations they admin. */
  gh: { read(): Promise<GhRead> };
  /** The setup's GitHub step: waiting for the App, or why the flow stopped short. */
  setup: { waitForApp(): void; flowRefused(why: SetupGitHubRefusal): void };
  /** `live.json` guards this run: no App is ever created. */
  liveConfig: boolean;
  log(line: string): void;
}

/**
 * What a redirect back from GitHub came to: the App kept; or refused: a state no flow opened (forged, used up, or
 * missing its code), one opened over an hour ago or a code GitHub no longer takes (`expired`), GitHub out of reach
 * (try again), GitHub refusing the code, an App kept already or `live.json`, or the App made but not kept (the App
 * store failed); or the App made elsewhere than asked (`elsewhere`), with where it is.
 */
export type FlowBack =
  | { done: StoredApp }
  | { refused: "unknown" | NotConverted | "not-kept" | NoNewApp }
  | { refused: "elsewhere"; made: MadeElsewhere };

/** Why the code wasn't converted, or its flow had run out, as the setup says it. */
type NotConverted = Exclude<SetupGitHubRefusal, "elsewhere">;

/** An App GitHub made on another account than the one chosen: its slug, its account, and the organisation asked for. */
export interface MadeElsewhere {
  slug: string;
  account: HostAccount;
  /** The organisation's login the flow asked for; null: your own account. */
  asked: string | null;
}

/**
 * Why the page opens no flow: no App may be made here, or `no-place`: the last "Create it on GitHub" wasn't taken
 * (refused, or the service stopped while it read `gh`), so the page goes nowhere rather than to the place before.
 */
export type OpenRefusal = NoNewApp | "no-place";

export interface AppFlow {
  /** Why no App may be made now; null when one may. */
  refusal(): NoNewApp | null;
  /**
   * "Create it on GitHub": the App made on your own account (`organisation` null) or on that organisation, the setup
   * waiting for it; refused as `refusal` says, or as the person's `gh` says of the organisation.
   */
  createApp(organisation: string | null): Promise<"ok" | CreateAppRefusal>;
  /**
   * The page opened: once every "Create it on GitHub" still reading `gh` has answered, a new flow for the place chosen
   * last, its state to send to GitHub and the organisation whose page it goes to (null: your own account's); refused
   * as `refusal` says, or `no-place` when the last choice wasn't taken.
   */
  open(): Promise<{ state: string; organisation: string | null } | { refused: OpenRefusal }>;
  /** GitHub's redirect back with the flow's state and the code: converted, kept and adopted, or why not. */
  back(state: string, code: string): Promise<FlowBack>;
}

/** What the store keeps of a state: never the state itself. */
const hashOf = (state: string) => createHash("sha256").update(state).digest("hex");

/**
 * Why the setup says the flow stopped short, from GitHub's refusal of the code. A rate limit is GitHub out of reach
 * for now, as "Use an existing App" says it: try again later.
 */
function flowRefusalOf(error: HostError): NotConverted {
  if (error.failure === "unavailable" || error.failure === "rate_limited") return "unreachable";
  return error.failure === "not_found" ? "expired" : "refused";
}

/**
 * The App GitHub made, as the service keeps it, when it is where the flow asked: your own account's for the account
 * GitHub names (its person), an organisation's for the person the flow kept. Null when GitHub made it elsewhere.
 */
function storedFor({ id, slug, owner }: ManifestConversion["app"], place: AppPlace | null): StoredApp | null {
  if (place === null) return owner.type === "User" ? storedOf({ id, slug, owner }) : null;
  if (owner.type !== "Organization" || owner.id !== place.organisation.id) return null;
  return storedApp(id, slug, owner, place.person);
}

export function createAppFlow(d: AppFlowDeps): AppFlow {
  const refusal = (): NoNewApp | null => {
    if (d.liveConfig) return "live-config";
    return d.github.app() === null ? null : "already-made";
  };

  /** Why an organisation is refused when `gh` gave no answer: logged with `gh`'s words when it couldn't answer. */
  const ghRefused = (no: GhUnanswered): CreateAppRefusal => {
    if (no.kind === "unanswered") d.log(flowLines.ghUnanswered(no.why, no.detail));
    return ghRefusalOf(no);
  };

  /** The organisation of `login` with the person `gh` is signed in as, when `gh` lists it as theirs to admin. */
  const placeOn = async (login: string): Promise<AppPlace | CreateAppRefusal> => {
    const { person, organisations } = await d.gh.read();
    if (person.kind !== "signed-in") return ghRefused(person);
    if (organisations.kind !== "listed") return ghRefused(organisations);
    const organisation = organisations.organisations.find(
      (o) => o.login.toLowerCase() === login.toLowerCase(),
    );
    if (organisation === undefined) return { kind: "not-an-admin" };
    return { organisation: { ...organisation }, person: { ...person.account } };
  };

  /** The flow of `hash`, when opened within the hour; one opened earlier is gone, and the setup says so. */
  const current = (hash: string): { place: AppPlace | null } | "unknown" | "expired" => {
    const flow = d.store.appFlows.flow(hash);
    if (flow === null) return "unknown";
    if (d.clock.now() - flow.openedAt <= FLOW_MS) return { place: flow.place };
    d.store.appFlows.usedUp(hash);
    d.setup.flowRefused("expired");
    return "expired";
  };

  /** The code converted on GitHub, or why not, as the setup then says. */
  const converted = async (code: string): Promise<ManifestConversion | NotConverted> => {
    try {
      return await d.github.installations.convertManifest(code);
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      const why = flowRefusalOf(error);
      d.setup.flowRefused(why);
      d.log(flowLines.notMade(error.failure));
      return why;
    }
  };

  /** The App GitHub made, kept and adopted by the room, when it is where the flow asked. */
  const kept = async ({ app: made, key }: ManifestConversion, place: AppPlace | null): Promise<FlowBack> => {
    const app = storedFor(made, place);
    if (app === null) {
      const { id, login, type } = made.owner;
      const elsewhere = {
        slug: made.slug,
        account: { id, login, type },
        asked: place?.organisation.login ?? null,
      };
      d.log(flowLines.elsewhere(elsewhere.slug, login, elsewhere.asked));
      d.setup.flowRefused("elsewhere");
      return { refused: "elsewhere", made: elsewhere };
    }
    try {
      await d.github.adopt(app, key);
      return { done: app };
    } catch (error) {
      d.log(flowLines.notKept(app.slug, said(error)));
      return { refused: "not-kept" };
    }
  };

  const convert = async (state: string, code: string): Promise<FlowBack> => {
    const refused = refusal();
    if (refused !== null) return { refused };
    const hash = hashOf(state);
    const flow = state === "" || code === "" ? "unknown" : current(hash);
    if (typeof flow === "string") return { refused: flow };
    const conversion = await converted(code);
    if (typeof conversion === "string") return { refused: conversion };
    // The code is spent now, whatever comes next.
    d.store.appFlows.usedUp(hash);
    return kept(conversion, flow.place);
  };

  /** How many "Create it on GitHub" were sent: only the last one's place is kept, whichever `gh` answers last. */
  let lastChoice = 0;

  /**
   * Where the App is made, chosen: nowhere until the choice is taken, so a refusal leaves no place to fall back on.
   * A choice another one followed while `gh` answered it keeps nothing: the place is the last one's, or none.
   */
  const choose = async (organisation: string | null): Promise<"ok" | CreateAppRefusal> => {
    lastChoice += 1;
    const mine = lastChoice;
    d.store.appFlows.choose("none");
    const before = refusal();
    if (before !== null) return { kind: before };
    const place = organisation === null ? null : await placeOn(organisation);
    if (place !== null && "kind" in place) return place;
    // While `gh` answered, another tab may have kept an App.
    const after = refusal();
    if (after !== null) return { kind: after };
    // A later choice was made while `gh` answered this one: the later one is the place, taken or refused.
    if (mine !== lastChoice) return "ok";
    d.store.appFlows.choose(place);
    d.setup.waitForApp();
    return "ok";
  };

  /** The choices still reading `gh`: the page waits for them, so it never opens a flow for the place before. */
  const choosing = new Set<Promise<unknown>>();

  return {
    refusal,
    createApp: (organisation) => {
      const chose = choose(organisation);
      const settled = chose.catch(() => {});
      choosing.add(settled);
      void settled.then(() => choosing.delete(settled));
      return chose;
    },
    open: async () => {
      while (choosing.size > 0) await Promise.all(choosing);
      const refused = refusal();
      if (refused !== null) return { refused };
      const place = d.store.appFlows.chosen();
      if (place === "none") return { refused: "no-place" };
      const now = d.clock.now();
      d.store.appFlows.forget(now - FLOW_MS);
      const state = randomBytes(32).toString("base64url");
      d.store.appFlows.opened(hashOf(state), now, place);
      return { state, organisation: place?.organisation.login ?? null };
    },
    back: (state, code) => d.github.oneAtATime(() => convert(state, code)),
  };
}
