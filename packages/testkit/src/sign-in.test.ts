import type { SignIn } from "@lookover/contracts";
import { describeSignIn, FakeGitHost } from "./index.ts";

const repo = { owner: "sasensi", name: "lookover-sandbox" };
const bot = { id: 338297044, login: "lookover-dev[bot]" };
const person = { id: 11247504, login: "sasensi" };
/** 2026-10-28 14:24:56 UTC, when spike 20 signed in. */
const T0 = Date.UTC(2026, 9, 28, 14, 24, 56);

function host() {
  let now = T0;
  const clock = { now: () => now };
  const fake = new FakeGitHost({ repo, bot, person, changes: [], clock });
  return {
    fake,
    now: clock.now,
    later: (ms: number) => {
      now += ms;
    },
  };
}

/** A sign-in on the fake, through its device flow. */
async function signedIn(): Promise<{ fake: FakeGitHost; kept: SignIn; now: () => number }> {
  const { fake, now } = host();
  const grant = await fake.startSignIn();
  fake.enterCode(grant.userCode);
  const poll = await fake.pollSignIn(grant);
  if (poll.kind !== "issued") throw new Error(`The fake didn't sign in: ${poll.kind}`);
  return { fake, kept: { ...poll.tokens, person: await fake.person(poll.tokens.token) }, now };
}

describeSignIn("FakeGitHost", {
  deviceFlow: () => {
    const { fake, now, later } = host();
    return Promise.resolve({
      signIn: fake,
      person,
      enter: (code) => Promise.resolve(fake.enterCode(code.userCode)),
      deny: (code) => Promise.resolve(fake.denyCode(code.userCode)),
      later,
      now,
    });
  },
  signedIn: async () => {
    const { fake, kept, now } = await signedIn();
    // The fake's sign-in lives in memory alone: the renewed one has nowhere to be written back.
    return { signIn: fake, kept, now, renewed: () => Promise.resolve() };
  },
  spentTwice: async () => {
    const { fake, kept, now } = await signedIn();
    return { signIn: fake, kept, now };
  },
  revoked: async () => {
    const { fake, kept, now } = await signedIn();
    fake.revokeSignIn();
    return { signIn: fake, kept, now };
  },
  unreachable: () => {
    const { fake } = host();
    fake.refuse("unavailable");
    return Promise.resolve({ signIn: fake });
  },
});
