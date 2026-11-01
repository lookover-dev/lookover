// A refused or lost key of your own App (ADR 0070): its fix lives in one place, Settings' GitHub group. The band
// says the problem and where ("Open Settings"); Settings says it again in the same words, with how to get a new key,
// "Add a new key" (the App's page on GitHub) and "Use an existing App" open. The shared App has no key (ADR 0066).

import type { Connection, ConnectionCause, HostAccount, KeyRefusal } from "@lookover/contracts";

/**
 * "an admin of acme" on an organisation's App or installation (ADR 0059): who changes it on GitHub. Null on a
 * personal account, or none.
 */
export function adminOf(account: HostAccount | undefined): string | null {
  return account?.type === "Organization" ? `an admin of ${account.login}` : null;
}

/** Every cause a new key fixes, by what it says: a clock that is off is not one (a new key can't fix a clock). */
type KeyCause = Exclude<KeyRefusal, "clock"> | "unknown" | "lost";

/** A key cause the connection has, or null: none, or one a new key doesn't fix. */
function keyCause(cause: ConnectionCause | null): KeyCause | null {
  if (cause?.kind === "key-lost") return "lost";
  if (cause?.kind !== "key-refused" || cause.why === "clock") return null;
  return cause.why ?? "unknown";
}

/**
 * Where the band sends the person for a new key: Settings (`settings`), the page already open (`here`, the band shows
 * no button there), or nowhere while no App is known or on the shared App, which has no key (`reconnect`).
 */
export type KeyPlace = "settings" | "here" | "reconnect";

/**
 * Reconnect, the band's button for a key problem a new key can't fix: no App known, or the shared App, with no page to
 * make a key on, and a clock that is off. Its sentences below say it in the same word.
 */
export const RECONNECT = { label: "Reconnect GitHub", command: { type: "connection.reconnect" } } as const;

/** With no App known, or on the shared App: no page to make a key on, so Reconnect. */
const RECONNECT_TEXT = "Reconnect to set up GitHub again.";

/** A clock that is off: fixed on this computer, then reconnected, since a new key can't fix a clock. */
const CLOCK_OFF =
  "This computer's clock is off, so GitHub can't trust the key. Set the clock right, then reconnect.";

/** Each key problem's title, the band's; Settings' line starts with the same words. */
const KEY_TITLE = {
  refused: "GitHub refused the App's key",
  lost: "Lookover can't open the App's key",
} as const;

/** "a new key in Settings": the band's way to the fix, once ("a new key" on Settings itself). */
const newKey = (place: Exclude<KeyPlace, "reconnect">): string =>
  `a new key${place === "settings" ? " in Settings" : ""}`;

/** "Give the App a new key in Settings.", or Reconnect's sentence while there is no key to give. */
const giveKey = (place: KeyPlace): string =>
  place === "reconnect" ? RECONNECT_TEXT : `Give the App ${newKey(place)}.`;

/**
 * What each key cause says: in the band, after its title (`band`, by where it sends the person); in Settings, on its
 * own line, the same problem (`problem`) then who can get a new key and where it goes (`how`, short: the steps are in
 * the form below it), with who can on an organisation's App (`can`, " (an admin of acme can)").
 */
const keyTexts = (
  can: string,
): Record<KeyCause, { band: (place: KeyPlace) => string; problem: string; how: string }> => {
  const how = `Add a new key${can}, then give it below.`;
  return {
    revoked: {
      band: (place) => `The key was revoked on GitHub. ${giveKey(place)}`,
      problem: "The key was revoked on GitHub.",
      how,
    },
    "app-deleted": {
      band: (place) =>
        place === "reconnect"
          ? `GitHub says the App was deleted. ${RECONNECT_TEXT}`
          : `GitHub says the App was deleted. If it still is on GitHub, give it ${newKey(place)}.`,
      problem: "GitHub says the App was deleted.",
      how: `If it still is on GitHub, add a new key${can}, then give it below.`,
    },
    unknown: {
      band: (place) => `It may have been revoked, or the App deleted. ${giveKey(place)}`,
      problem: `${KEY_TITLE.refused}. It may have been revoked, or the App deleted.`,
      how,
    },
    lost: {
      band: (place) => `Its entry in this computer's keychain is gone. ${giveKey(place)}`,
      problem: `${KEY_TITLE.lost}: its entry in this computer's keychain is gone.`,
      how,
    },
  };
};

/** What Settings' "Your App" row says of a key cause: the problem, then who can get a new key and where it goes. */
const settingsText = (t: { problem: string; how: string }) => `${t.problem} ${t.how}`;

/**
 * A refused or lost key as the band says it at `place`: its title and sentence, and whether a new key fixes it
 * (`newKey`: not for a clock that is off, which says to set it right and reconnect).
 */
export function keyBand(
  cause: Extract<ConnectionCause, { kind: "key-refused" | "key-lost" }>,
  place: KeyPlace,
): { title: string; detail: string; newKey: boolean } {
  const title = cause.kind === "key-lost" ? KEY_TITLE.lost : KEY_TITLE.refused;
  const key = keyCause(cause);
  if (key === null) return { title, detail: CLOCK_OFF, newKey: false };
  return { title, detail: keyTexts("")[key].band(place), newKey: true };
}

/**
 * Settings' "Your App" row on your own App: while a new key fixes its connection, the problem and how (`text`), and
 * "Use an existing App" to open; every text a key cause can say (`held`), so one coming or going moves nothing. Null
 * texts with no App known: there is no page to make a key on.
 */
export function keyProblem(connection: Pick<Connection, "cause" | "app">): {
  text: string | null;
  held: string[];
} {
  const { app } = connection;
  if (app === null) return { text: null, held: [] };
  const admin = adminOf(app.account);
  const texts = keyTexts(admin === null ? "" : ` (${admin} can)`);
  const key = keyCause(connection.cause);
  return {
    text: key === null ? null : settingsText(texts[key]),
    held: Object.values(texts).map(settingsText),
  };
}
