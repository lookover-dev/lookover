// "Use an existing App" (`connection.useApp`, ADR 0053): an App the owner has already (made on another computer, a
// new key for the App kept, the developers' test App) given by its id and private key file.
// - Checked before anything is kept: the text must hold a private key; while an App is kept, only its id is taken
//   (one App per data folder), and then it replaces the key and keeps everything else, the fix for a refused or lost
//   key. Then GitHub is asked, with the App's own token, what the App is: refused credentials (a wrong id, another
//   App's key) and an App lacking any of ADR 0022's permissions (each named) are refused. An organisation's App
//   (ADR 0059) is taken for the person the person's own `gh` is signed in as, when `gh` says that account is an
//   active member of the App's organisation, admin or not; refused as `gh` says otherwise (not installed, signed out,
//   no answer, or not a member, naming the account). A new key for the organisation's App kept keeps its account and
//   person, never whoever `gh` names now: refused when `gh` answers for another account, taken when it can't say.
//   A personal App never asks `gh`: its person is its account. Only
//   then is it adopted: kept in the App store, and its install waited for.
// - `live.json`'s App is never replaced: with no App store, any App is refused before GitHub is asked.
// - Once adopted, the App is kept whatever the reconnect that follows hits: the connection's cause says that.
// Ordering: the whole check and the adoption run in the room's `oneAtATime`, as GitHub's redirect back does, so two
// tabs giving two Apps at once keep one and refuse the other as another App.
// Errors: a refusal is data (`UseAppRefusal`), never words holding the key; a rate limit is `unreachable`, as the
// manifest flow says it. A refusal of GitHub's this can't word and the App store's failure are thrown.
// It must never know: the HTTP answer, the App store or the installation's wait (the room's `adopt` does those).
import {
  APP_PERMISSIONS,
  type AppPermission,
  connectionCauseOf,
  ghRefusalOf,
  type HostApp,
  HostError,
  type PermissionLevel,
  PRIVATE_KEY_ARMOUR,
  type UseAppRefusal,
} from "@lookover/contracts";
import { type Membership, type StoredApp, storedApp } from "./app-store.ts";
import { storedOf } from "./installation.ts";
import type { Room } from "./room.ts";

/** What "Use an existing App" answered: kept, or refused with why. */
export type UseAppAnswer = "ok" | { refused: UseAppRefusal };

/** How much each level grants: a level grants every lower one. */
const RANK: Record<PermissionLevel, number> = { read: 1, write: 2, admin: 3 };

/** ADR 0022's permissions, in their order: `APP_PERMISSIONS`' own. */
const PERMISSIONS: readonly AppPermission[] = Object.keys(APP_PERMISSIONS).filter(
  (name): name is AppPermission => Object.hasOwn(APP_PERMISSIONS, name),
);

/** ADR 0022's permissions the App holds less of than Lookover needs, in their order. */
function missing(app: HostApp): AppPermission[] {
  return PERMISSIONS.filter((permission) => {
    const held = app.permissions[permission];
    return held === undefined || RANK[held] < RANK[APP_PERMISSIONS[permission]];
  });
}

/**
 * Why GitHub refused the App given, as the form words it; null for a refusal it has no words for. A rate limit is
 * GitHub out of reach for now, as the manifest flow says it: try again later.
 */
function useAppRefusalOf(error: unknown): UseAppRefusal | null {
  if (!(error instanceof HostError)) return null;
  if (error.failure === "rate_limited") return { kind: "unreachable" };
  const cause = connectionCauseOf(error);
  if (cause?.kind === "key-refused") return { kind: "key-refused" };
  if (cause?.kind === "unreachable") return { kind: "unreachable" };
  return null;
}

/** The App given by `appId` and `key` checked, then adopted; or refused, with nothing kept. */
export function useApp(github: Room["github"], appId: number, key: string): Promise<UseAppAnswer> {
  // The App kept read and the one given adopted with no other check or adoption between: one App per data folder.
  return github.oneAtATime(() => checked(github, appId, key));
}

async function checked(github: Room["github"], appId: number, key: string): Promise<UseAppAnswer> {
  if (!github.keepsApps) return { refused: { kind: "live-config" } };
  if (!PRIVATE_KEY_ARMOUR.test(key)) return { refused: { kind: "not-a-key" } };
  const kept = github.app();
  if (kept !== null && kept.id !== appId) return { refused: { kind: "another-app" } };
  let app: HostApp;
  try {
    app = await github.installations.app({ id: appId, key });
  } catch (error) {
    const refused = useAppRefusalOf(error);
    if (refused === null) throw error;
    return { refused };
  }
  const taken: Taken | { refused: UseAppRefusal } =
    app.owner.type === "User"
      ? { app: storedOf(app) }
      : kept !== null
        ? await keptFor(github, kept)
        : await forMember(github, app);
  if ("refused" in taken) return taken;
  const lacking = missing(app);
  if (lacking.length > 0) return { refused: { kind: "missing-permissions", missing: lacking } };
  await github.adopt(taken.app, key, taken.membership);
  return "ok";
}

/** The App as it is to be kept, and what the person's `gh` just answered of their membership, when it was asked. */
interface Taken {
  app: StoredApp;
  membership?: Membership;
}

/**
 * The organisation's App kept, taking a new key: kept as it is, for the person it is kept for, never whoever `gh`
 * names now. Refused only when `gh` answers for another account; when it can't answer, the person kept stands. An
 * answer for that person goes with it (ADR 0059): no longer a member since the last check, the key is taken and
 * reviews stop at once.
 */
async function keptFor(github: Room["github"], kept: StoredApp): Promise<Taken | { refused: UseAppRefusal }> {
  const membership = await github.membership(kept.account.login);
  const named =
    membership.kind === "active" || membership.kind === "pending" || membership.kind === "absent"
      ? membership.person
      : null;
  if (named !== null && named.id !== kept.person.id)
    return { refused: { kind: "another-person", person: named.login, kept: kept.person.login } };
  const app = storedApp(kept.id, kept.slug, kept.account, kept.person);
  if (named === null) return { app };
  return { app, membership: membership.kind === "active" ? "member" : "not-a-member" };
}

/**
 * An organisation's App as the service keeps it, for the person the person's own `gh` is signed in as, when they are
 * an active member of its organisation (ADR 0059); else why not.
 */
async function forMember(github: Room["github"], app: HostApp): Promise<Taken | { refused: UseAppRefusal }> {
  const { owner } = app;
  const membership = await github.membership(owner.login);
  switch (membership.kind) {
    case "active":
      return { app: storedApp(app.id, app.slug, owner, membership.person), membership: "member" };
    case "pending":
    case "absent": {
      const invited = membership.kind === "pending";
      return {
        refused: {
          kind: "not-a-member",
          organisation: owner.login,
          person: membership.person.login,
          invited,
        },
      };
    }
    default:
      return { refused: ghRefusalOf(membership) };
  }
}
