// Where "Create your App" makes the App (ADR 0059): your own account, or an organisation the person's own `gh` lists
// them as an admin of; and the one line under the choice: why no organisation can be offered (`gh` not installed,
// signed out, or unable to answer, with the one command and Check again), or, once `gh` answered, how a member who
// isn't an admin gets an App all the same. The list keeps the room of two organisations (`spare`) and the line the
// height of every line it can show (`held`), so nothing under them moves when `gh` answers. Once the App is made, the choice is where it was made, and can't change; the line
// says where it is.
import {
  type Connection,
  GH_FIX_BEFORE,
  GH_SIGN_IN,
  type GhNoAnswer,
  type GhWhy,
  USE_EXISTING_APP,
} from "@lookover/contracts";
import type { WithCommand } from "./format.ts";

/** One place the App can be made: your own account (`organisation` null) or an organisation, by its login. */
interface PlaceOption {
  organisation: string | null;
  label: string;
  detail: string;
}

export interface AppPlaceView {
  /** Your own account first, then each organisation. */
  options: PlaceOption[];
  /**
   * The rows kept empty under them: the list holds the room of your own account and two organisations (`ROOM`) from
   * the start, so the organisations `gh` lists move nothing under it. More than two grow it.
   */
  spare: number;
  /** The organisation chosen, null for your own account. */
  chosen: string | null;
  /** Whether the choice can change, and `gh` be read again (Check again): until the App is made. */
  enabled: boolean;
  line: string | WithCommand;
  /** Every line it can show, `line` among them: its row is as tall as the tallest. */
  held: (string | WithCommand)[];
}

const OWN: PlaceOption = {
  organisation: null,
  label: "Your GitHub account",
  detail: "Repositories you own.",
};
const organisation = (login: string): PlaceOption => ({
  organisation: login,
  label: login,
  detail: "An organisation you're an admin of.",
});

/** The rows the list is as tall as from the start: your own account and two organisations. */
const ROOM = 3;
const spareOf = (options: PlaceOption[]) => Math.max(0, ROOM - options.length);

const LOOKING = "Looking for the organisations you're an admin of…";
const NOT_AN_ADMIN = `Not an admin of your organisation? Ask an admin to create the App there, then give it under “${USE_EXISTING_APP}”, below.`;
const AGAIN = "Check again in a moment.";

/** Why `gh` listed no organisation, said with its one fix; one that couldn't answer says why (`UNANSWERED`). */
const NO_ANSWER: Record<Exclude<GhNoAnswer["kind"], "unanswered">, WithCommand> = {
  missing: {
    before: `To create it on an organisation, ${GH_FIX_BEFORE["gh-missing"]}`,
    command: GH_SIGN_IN,
    after: "and check again.",
  },
  "signed-out": {
    before: `To create it on an organisation, ${GH_FIX_BEFORE["gh-signed-out"]}`,
    command: GH_SIGN_IN,
    after: "and check again.",
  },
};

const UNANSWERED: Record<GhWhy, string | WithCommand> = {
  offline: `gh couldn't reach GitHub to list your organisations. ${AGAIN}`,
  timeout: `gh didn't answer in time. ${AGAIN}`,
  failed: `gh couldn't list your organisations. ${AGAIN}`,
  sso: "An organisation's single sign-on refused gh. Authorise gh's token for it on GitHub, then check again.",
  scope: {
    before: "gh needs the read:org scope to list your organisations. Run",
    command: "gh auth refresh -s read:org",
    after: "to add it, then check again.",
  },
};

const noAnswer = (answer: GhNoAnswer): string | WithCommand =>
  answer.kind === "unanswered" ? UNANSWERED[answer.why] : NO_ANSWER[answer.kind];

const HELD: (string | WithCommand)[] = [
  LOOKING,
  NOT_AN_ADMIN,
  ...Object.values(NO_ANSWER),
  ...Object.values(UNANSWERED),
];

/**
 * Where the App is made, with `picked` the organisation the person picked (null: their own account): kept while it is
 * offered, else their own account.
 */
export function appPlace(connection: Connection, picked: string | null): AppPlaceView {
  const { gh, app } = connection;
  const listed =
    gh?.organisations.kind === "listed" ? gh.organisations.organisations.map((o) => o.login) : [];
  if (app !== null) {
    const made = app.account.type === "Organization" ? app.account.login : null;
    const logins = made === null || listed.includes(made) ? listed : [...listed, made];
    const where = `Your App is on ${made ?? "your GitHub account"}.`;
    const options = [OWN, ...logins.map(organisation)];
    return {
      options,
      spare: spareOf(options),
      chosen: made,
      enabled: false,
      line: where,
      held: [...HELD, where],
    };
  }
  const line =
    gh === null ? LOOKING : gh.organisations.kind === "listed" ? NOT_AN_ADMIN : noAnswer(gh.organisations);
  const options = [OWN, ...listed.map(organisation)];
  return {
    options,
    spare: spareOf(options),
    chosen: picked !== null && listed.includes(picked) ? picked : null,
    enabled: true,
    line,
    held: HELD,
  };
}
