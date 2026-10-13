import { expect, test } from "bun:test";
import type { HostLogin } from "@lookover/contracts";
import { describeGh, memoryGh } from "./index.ts";

const sam: HostLogin = { id: 11247504, login: "sasensi" };
const teammate: HostLogin = { id: 990001, login: "rhea-k" };
const lookoverDev: HostLogin = { id: 338456971, login: "lookover-dev" };
const orbit: HostLogin = { id: 339000101, login: "orbit" };
const harbor: HostLogin = { id: 846000, login: "harbor" };
const invitedTo: HostLogin = { id: 412000, login: "acme-labs" };

/** Sam's gh, signed in: an admin of two organisations, a member of one, invited to another. */
function samsGh() {
  const gh = memoryGh({ as: sam });
  gh.join(lookoverDev, sam, { state: "active", admin: true });
  gh.join(orbit, sam, { state: "active", admin: true });
  gh.join(harbor, sam, { state: "active", admin: false });
  gh.join(invitedTo, sam, { state: "pending", admin: true });
  gh.join(lookoverDev, teammate, { state: "active", admin: false });
  return gh;
}

describeGh("memoryGh", {
  signedIn: async () => ({
    gh: samsGh(),
    person: sam,
    admin: [lookoverDev, orbit],
    member: [harbor],
    pending: invitedTo,
    absent: "github",
  }),
  signedOut: async () => memoryGh({ as: null }),
  missing: async () => memoryGh({ as: "missing" }),
  offline: async () => {
    const gh = samsGh();
    gh.fail("offline");
    return gh;
  },
  noReadOrg: async () => {
    const gh = samsGh();
    gh.fail("scope");
    return gh;
  },
  sso: async () => {
    const gh = samsGh();
    gh.fail("sso", "orbit");
    return { gh, organisation: "orbit" };
  },
});

test("the fake: another sign-in reads that account's memberships, and a failure lifted answers again", async () => {
  const gh = samsGh();
  gh.signIn(teammate);
  expect(await gh.person()).toEqual({ kind: "signed-in", account: teammate });
  expect(await gh.membership("lookover-dev")).toEqual({ kind: "active", person: teammate, admin: false });
  expect(await gh.adminOrganisations()).toEqual({ kind: "listed", organisations: [] });

  gh.signIn(sam);
  gh.leave("lookover-dev", sam);
  expect(await gh.membership("lookover-dev")).toEqual({ kind: "absent" });

  gh.fail("timeout");
  expect(await gh.person()).toMatchObject({ kind: "unanswered", why: "timeout" });
  gh.fail(null);
  expect(await gh.person()).toEqual({ kind: "signed-in", account: sam });
});

test("the fake emptied: signed out, every organisation and failure forgotten", async () => {
  const gh = samsGh();
  gh.fail("sso", "orbit");
  gh.fail("timeout");
  gh.empty();
  expect(await gh.person()).toEqual({ kind: "signed-out" });
  gh.signIn(sam);
  expect(await gh.adminOrganisations()).toEqual({ kind: "listed", organisations: [] });
  expect(await gh.membership("orbit")).toEqual({ kind: "absent" });
});
