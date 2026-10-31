// Signing a person in to the shared App (ADR 0066): the device flow and the refresh against GitHub's OAuth endpoints,
// then the person's session under the ports. Each answer is in GitHub's shape, marked where it comes from: "spike 20"
// (`spikes/20-shared-app/results.json`, the device flow run for real on 2026-10-28: the client ID alone, a `bearer`
// token for 28800 s and a refresh token for 15724800 s, the person `sasensi` from `GET /user`), or "GitHub's docs"
// (the device flow's errors, answered with status 200 and an `error` field, and the refresh, not spiked).
import { describe, expect, test } from "bun:test";
import {
  connectionCauseOf,
  type DeviceGrant,
  HostError,
  SHARED_APP,
  type SignIn,
  type SignInKeeper,
} from "@lookover/contracts";
import { AT, type Call, type Route, stubGitHub } from "./github.test-support.ts";
import { createGitHub, createHostSignIn } from "./index.ts";

const WEB = "https://github.com";
const DEVICE_CODE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
/** The person, as spike 20's `GET /user` gave them. */
const PERSON = { id: 11247504, login: "sasensi" };
const SANDBOX = { owner: "lookover-dev", name: "lookover-sandbox" };
const PRIVATE = { owner: "lookover-dev", name: "lookover-private" };
/**
 * GitHub's refusal of a resource an organisation protects with SAML SSO (GitHub's docs, "Authenticating to the REST
 * API": a 403, its `X-GitHub-SSO` header `required; url=…`; the words as GitHub's docs and its community quote them).
 */
const SAML_REFUSAL =
  "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A clock the test moves. */
function held(start = AT) {
  let now = start;
  return {
    now: () => now,
    set: (at: number) => {
      now = at;
    },
  };
}

const isOAuth = (call: Call, path: string) =>
  call.origin === WEB && call.method === "POST" && call.path === path;
const bodyOf = (call: Call): Record<string, unknown> =>
  typeof call.body === "object" && call.body !== null ? { ...call.body } : {};

/** GitHub's answer to a device code request (GitHub's docs; spike 20 had one with the client ID alone). */
const deviceCodeRoute: Route = (call) =>
  isOAuth(call, "/login/device/code")
    ? {
        status: 200,
        body: {
          device_code: DEVICE_CODE,
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
      }
    : undefined;

/** A token answer, as spike 20 saw it: a `bearer` token for 8 hours, its refresh token for about 6 months. */
const tokenAnswer = (token: string, refresh: string) => ({
  status: 200,
  body: {
    access_token: token,
    expires_in: 28800,
    refresh_token: refresh,
    refresh_token_expires_in: 15724800,
    token_type: "bearer",
    scope: "",
  },
});

/** One of the OAuth endpoint's errors, as GitHub's docs give them: status 200, an `error` field. */
const oauthError = (error: string) => ({
  status: 200,
  body: { error, error_description: `${error} said`, error_uri: "https://docs.github.com" },
});

/** `GET /user` for a token (spike 20). */
const userRoute =
  (token: string): Route =>
  (call) =>
    call.path === "/user" && call.authorization === `Bearer ${token}`
      ? { status: 200, body: PERSON }
      : undefined;

/** The device flow's poll, answered by `answer`. */
const pollRoute =
  (answer: () => { status: number; body: unknown }): Route =>
  (call) =>
    isOAuth(call, "/login/oauth/access_token") &&
    bodyOf(call).grant_type === "urn:ietf:params:oauth:grant-type:device_code"
      ? answer()
      : undefined;

const GRANT: DeviceGrant = {
  deviceCode: DEVICE_CODE,
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: AT + 900_000,
  interval: 5_000,
};

function signInOver(...routes: Route[]) {
  const api = stubGitHub(...routes);
  const secrets: string[] = [];
  const signIn = createHostSignIn({
    fetch: api.fetch,
    clock: { now: () => AT },
    secret: (s) => secrets.push(s),
  });
  return { signIn, calls: api.calls, secrets };
}

async function refusal(call: Promise<unknown>): Promise<HostError> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof HostError)) throw new Error(`Expected a HostError, got ${String(error)}`);
  return error;
}

describe("the device flow", () => {
  test("a device code is asked with the shared App's client ID alone, and says what the person is shown (GitHub's docs)", async () => {
    const { signIn, calls } = signInOver(deviceCodeRoute);
    expect(await signIn.startSignIn()).toEqual(GRANT);
    expect(calls.map((c) => [c.origin, c.method, c.path, c.body, c.authorization])).toEqual([
      [WEB, "POST", "/login/device/code", { client_id: SHARED_APP.clientId }, ""],
    ]);
  });

  test("a poll before the code is entered is pending, and a slow_down adds 5 s to the interval (GitHub's docs)", async () => {
    const answers = [oauthError("authorization_pending"), oauthError("slow_down")];
    const { signIn, calls } = signInOver(pollRoute(() => answers.shift() ?? oauthError("slow_down")));
    expect(await signIn.pollSignIn(GRANT)).toEqual({ kind: "pending", grant: GRANT });
    const slowed = await signIn.pollSignIn(GRANT);
    expect(slowed).toEqual({ kind: "slow-down", grant: { ...GRANT, interval: 10_000 } });
    if (slowed.kind !== "slow-down") return;
    expect(await signIn.pollSignIn(slowed.grant)).toEqual({
      kind: "slow-down",
      grant: { ...GRANT, interval: 15_000 },
    });
    expect(calls[0]?.body).toEqual({
      client_id: SHARED_APP.clientId,
      device_code: DEVICE_CODE,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  test("a code that ran out is expired, one the person refused is denied (GitHub's docs)", async () => {
    const answers = [oauthError("expired_token"), oauthError("access_denied")];
    const { signIn } = signInOver(pollRoute(() => answers.shift() ?? oauthError("expired_token")));
    expect(await signIn.pollSignIn(GRANT)).toEqual({ kind: "expired" });
    expect(await signIn.pollSignIn(GRANT)).toEqual({ kind: "denied" });
  });

  test("the code entered gives both tokens and their expiries at once; who the person is, asked apart (spike 20)", async () => {
    const { signIn, calls, secrets } = signInOver(
      pollRoute(() => tokenAnswer("ghu_first", "ghr_first")),
      userRoute("ghu_first"),
    );
    expect(await signIn.pollSignIn(GRANT)).toEqual({
      kind: "issued",
      tokens: {
        token: "ghu_first",
        expiresAt: AT + 28_800_000,
        refreshToken: "ghr_first",
        refreshExpiresAt: AT + 15_724_800_000,
      },
    });
    expect(calls.map((c) => [c.origin, c.path])).toEqual([[WEB, "/login/oauth/access_token"]]);
    expect(secrets).toEqual(expect.arrayContaining([DEVICE_CODE, "ghu_first", "ghr_first"]));
    expect(await signIn.person("ghu_first")).toEqual(PERSON);
    expect(calls.map((c) => [c.origin, c.path]).at(-1)).toEqual(["https://api.github.com", "/user"]);
  });

  test("whose a token is, GitHub failing, is unavailable; a token it refuses is unauthorized", async () => {
    const failing = signInOver((call) => (call.path === "/user" ? { status: 502, body: {} } : undefined));
    expect((await refusal(failing.signIn.person("ghu_first"))).failure).toBe("unavailable");
    const refused = signInOver((call) =>
      call.path === "/user" ? { status: 401, body: { message: "Bad credentials" } } : undefined,
    );
    expect((await refusal(refused.signIn.person("ghu_first"))).failure).toBe("unauthorized");
  });

  test("an error the flow doesn't name is invalid; GitHub out of reach or failing is unavailable", async () => {
    const odd = signInOver(pollRoute(() => oauthError("incorrect_device_code")));
    expect((await refusal(odd.signIn.pollSignIn(GRANT))).failure).toBe("invalid");
    const failing = signInOver(pollRoute(() => ({ status: 502, body: "Bad gateway" })));
    const down = await refusal(failing.signIn.pollSignIn(GRANT));
    expect([down.failure, connectionCauseOf(down)]).toEqual(["unavailable", { kind: "unreachable" }]);
    const unreachable = createHostSignIn({
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com")),
      clock: { now: () => AT },
    });
    expect((await refusal(unreachable.startSignIn())).failure).toBe("unavailable");
  });

  test("a 429 asks to wait, as the API's does: rate limited until its retry-after, the sign-in kept", async () => {
    const limited = signInOver(
      pollRoute(() => ({ status: 429, body: "Too many requests", headers: { "retry-after": "60" } })),
    );
    const error = await refusal(limited.signIn.pollSignIn(GRANT));
    expect([error.failure, error.retryAt, connectionCauseOf(error)]).toEqual([
      "rate_limited",
      AT + 60_000,
      null,
    ]);
  });
});

/** The refresh grant, answered by `answer` (GitHub's docs: the refresh is not spiked). */
const refreshRoute =
  (answer: (refreshToken: unknown) => { status: number; body: unknown }): Route =>
  (call) =>
    isOAuth(call, "/login/oauth/access_token") && bodyOf(call).grant_type === "refresh_token"
      ? answer(bodyOf(call).refresh_token)
      : undefined;

const KEPT: SignIn = {
  token: "ghu_first",
  expiresAt: AT + 8 * HOUR,
  refreshToken: "ghr_first",
  refreshExpiresAt: AT + 4000 * HOUR,
  person: PERSON,
};

describe("the refresh", () => {
  test("renews both tokens with the refresh token, the person kept (GitHub's docs)", async () => {
    const { signIn, calls } = signInOver(refreshRoute(() => tokenAnswer("ghu_second", "ghr_second")));
    expect(await signIn.refreshSignIn(KEPT)).toEqual({
      token: "ghu_second",
      expiresAt: AT + 28_800_000,
      refreshToken: "ghr_second",
      refreshExpiresAt: AT + 15_724_800_000,
      person: PERSON,
    });
    expect(calls.map((c) => c.body)).toEqual([
      { client_id: SHARED_APP.clientId, grant_type: "refresh_token", refresh_token: "ghr_first" },
    ]);
  });

  test("a refresh token GitHub refuses signs the person out (GitHub's docs: bad_refresh_token)", async () => {
    const { signIn } = signInOver(refreshRoute(() => oauthError("bad_refresh_token")));
    const error = await refusal(signIn.refreshSignIn(KEPT));
    expect([error.failure, connectionCauseOf(error)]).toEqual(["unauthorized", { kind: "signed-out" }]);
  });

  test("a refresh token GitHub doesn't know signs the person out (as GitHub answers it: incorrect_client_credentials)", async () => {
    const { signIn } = signInOver(refreshRoute(() => oauthError("incorrect_client_credentials")));
    const error = await refusal(signIn.refreshSignIn(KEPT));
    expect([error.failure, connectionCauseOf(error)]).toEqual(["unauthorized", { kind: "signed-out" }]);
  });

  test("any other refusal of a refresh is invalid, never signed out", async () => {
    const { signIn } = signInOver(refreshRoute(() => oauthError("unsupported_grant_type")));
    const error = await refusal(signIn.refreshSignIn(KEPT));
    expect([error.failure, connectionCauseOf(error)]).toEqual(["invalid", null]);
  });
});

/** A keeper in memory: what the data folder holds, which another process may change. */
function memoryKeeper(first: SignIn | null, onWrite: (s: SignIn) => void = () => {}) {
  let kept = first;
  let reads = 0;
  let failing = 0;
  const keeper: SignInKeeper = {
    read: () => {
      reads++;
      return Promise.resolve(kept);
    },
    write: (signIn, from) => {
      if (failing > 0) {
        failing--;
        return Promise.reject(new Error("EBUSY: the data folder is locked"));
      }
      if (kept?.token !== from.token || kept.refreshToken !== from.refreshToken)
        return Promise.resolve(false);
      kept = signIn;
      onWrite(signIn);
      return Promise.resolve(true);
    },
  };
  return {
    keeper,
    kept: () => kept,
    reads: () => reads,
    /** The next `times` writes fail, as a locked or full disk would. */
    failWrites: (times: number) => {
      failing = times;
    },
    /** Another process renewed it. */
    replace: (s: SignIn) => {
      kept = s;
    },
    /** The person signed in again (the service's new sign-in): it replaces whatever is kept. */
    signInAgain: (s: SignIn) => {
      kept = s;
    },
  };
}

/** `GET /repos/{o}/{n}`, answered to any token in `tokens`; any other is GitHub's 401. */
const repoRoute =
  (tokens: () => string[]): Route =>
  (call) => {
    const found = /^\/repos\/([^/]+)\/([^/]+)$/.exec(call.path);
    if (!found) return undefined;
    if (!tokens().some((t) => call.authorization === `Bearer ${t}`))
      return { status: 401, body: { message: "Bad credentials" } };
    return { status: 200, body: { owner: { id: 900, login: found[1] } } };
  };

function session(first: SignIn | null, ...routes: Route[]) {
  const clock = held();
  const api = stubGitHub(...routes);
  const writes: { token: string; atCall: number }[] = [];
  const memory = memoryKeeper(first, (s) => writes.push({ token: s.token, atCall: api.calls.length }));
  const github = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
  const refreshes = () =>
    api.calls.filter((c) => c.origin === WEB && bodyOf(c).grant_type === "refresh_token").length;
  const bearers = () => api.calls.filter((c) => c.path.startsWith("/repos/")).map((c) => c.authorization);
  return { github, clock, calls: api.calls, memory, writes, refreshes, bearers };
}

describe("the person's session", () => {
  test("one token for every repository, who posts the person, the checks the shared App's", async () => {
    const s = session(
      KEPT,
      repoRoute(() => ["ghu_first"]),
    );
    const sandbox = await s.github.identity(SANDBOX);
    await s.github.identity(PRIVATE);
    expect(sandbox.poster).toEqual(PERSON);
    expect(s.bearers()).toEqual(["Bearer ghu_first", "Bearer ghu_first"]);
    expect(s.calls.every((c) => !c.path.includes("access_tokens"))).toBe(true);
  });

  test("who posts is the person, asked of the repository: one the token can't see is not found", async () => {
    const onlySandbox: Route = (call) =>
      call.path.startsWith("/repos/lookover-dev/lookover-sandbox")
        ? repoRoute(() => ["ghu_first"])(call)
        : undefined;
    const s = session(KEPT, onlySandbox);
    expect(await s.github.intake.poster(SANDBOX)).toEqual(PERSON);
    await expect(s.github.intake.poster({ owner: "lookover-dev", name: "nope" })).rejects.toMatchObject({
      failure: "not_found",
    });
  });

  test("renewed 5 min before it expires, the rotated refresh token kept before the new token is used", async () => {
    const s = session(
      KEPT,
      refreshRoute(() => tokenAnswer("ghu_second", "ghr_second")),
      repoRoute(() => ["ghu_first", "ghu_second"]),
    );
    s.clock.set(KEPT.expiresAt - 5 * MIN - 1);
    await s.github.identity(SANDBOX);
    expect(s.refreshes()).toBe(0);
    s.clock.set(KEPT.expiresAt - 5 * MIN);
    await s.github.identity(SANDBOX);
    expect(s.refreshes()).toBe(1);
    expect(s.memory.kept()).toMatchObject({ token: "ghu_second", refreshToken: "ghr_second" });
    const used = s.calls.findIndex((c) => c.authorization === "Bearer ghu_second");
    expect(s.writes).toEqual([{ token: "ghu_second", atCall: used }]);
  });

  test("one refresh at a time: calls at once share it", async () => {
    let answer = 0;
    const s = session(
      KEPT,
      refreshRoute(() => {
        answer++;
        return tokenAnswer(`ghu_${answer + 1}`, `ghr_${answer + 1}`);
      }),
      repoRoute(() => ["ghu_2"]),
    );
    s.clock.set(KEPT.expiresAt);
    await Promise.all([s.github.identity(SANDBOX), s.github.identity(PRIVATE), s.github.identity(SANDBOX)]);
    expect(s.refreshes()).toBe(1);
    expect(s.bearers()).toEqual(["Bearer ghu_2", "Bearer ghu_2", "Bearer ghu_2"]);
  });

  test("two sessions on one keeper (the service's discovery and its ports) renew once at the margin: nobody signed out", async () => {
    const clock = held();
    // GitHub rotates the refresh token: each one renews once, a spent one is bad_refresh_token.
    let live = "ghr_first";
    let issued = 1;
    const api = stubGitHub(
      refreshRoute((refreshToken) => {
        if (refreshToken !== live) return oauthError("bad_refresh_token");
        issued++;
        live = `ghr_${issued}`;
        return tokenAnswer(`ghu_${issued}`, live);
      }),
      repoRoute(() => ["ghu_2"]),
    );
    const memory = memoryKeeper(KEPT);
    const discovery = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    const ports = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    clock.set(KEPT.expiresAt - 5 * MIN);
    const both = await Promise.allSettled([discovery.identity(SANDBOX), ports.identity(PRIVATE)]);
    expect(both.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const refreshes = api.calls.filter((c) => c.origin === WEB && bodyOf(c).grant_type === "refresh_token");
    expect(refreshes.length).toBe(1);
    expect(memory.kept()).toMatchObject({ token: "ghu_2", refreshToken: "ghr_2" });
  });

  test("a renewal one session failed to keep is kept by the next session on the keeper, never refreshed again with the spent token", async () => {
    const clock = held();
    let live = "ghr_first";
    let issued = 1;
    const api = stubGitHub(
      refreshRoute((refreshToken) => {
        if (refreshToken !== live) return oauthError("bad_refresh_token");
        issued++;
        live = `ghr_${issued}`;
        return tokenAnswer(`ghu_${issued}`, live);
      }),
      repoRoute(() => ["ghu_2"]),
    );
    const memory = memoryKeeper(KEPT);
    const discovery = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    const ports = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    clock.set(KEPT.expiresAt - 5 * MIN);
    memory.failWrites(1);
    const unkept = await refusal(discovery.identity(SANDBOX));
    expect(unkept.failure).toBe("unavailable");
    expect((await ports.identity(PRIVATE)).poster).toEqual(PERSON);
    expect((await discovery.identity(SANDBOX)).poster).toEqual(PERSON);
    const refreshes = api.calls.filter((c) => c.origin === WEB && bodyOf(c).grant_type === "refresh_token");
    expect(refreshes.length).toBe(1);
    expect(memory.kept()).toMatchObject({ token: "ghu_2", refreshToken: "ghr_2" });
  });

  test("a renewal kept by no session while the keeper fails is used by none: each is unavailable, nothing refreshed again", async () => {
    const clock = held();
    const api = stubGitHub(
      refreshRoute(() => tokenAnswer("ghu_2", "ghr_2")),
      repoRoute(() => ["ghu_first", "ghu_2"]),
    );
    const memory = memoryKeeper(KEPT);
    const discovery = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    const ports = createGitHub({ keeper: memory.keeper, fetch: api.fetch, clock });
    await ports.identity(PRIVATE);
    clock.set(KEPT.expiresAt - 5 * MIN);
    memory.failWrites(2);
    expect((await refusal(discovery.identity(SANDBOX))).failure).toBe("unavailable");
    expect((await refusal(ports.identity(PRIVATE))).failure).toBe("unavailable");
    const refreshes = api.calls.filter((c) => c.origin === WEB && bodyOf(c).grant_type === "refresh_token");
    expect(refreshes.length).toBe(1);
    expect(api.calls.filter((c) => c.path.startsWith("/repos/")).length).toBe(1);
  });

  test("the kept sign-in is read again before a refresh: one another process renewed is used as it is", async () => {
    const s = session(
      KEPT,
      repoRoute(() => ["ghu_first", "ghu_theirs"]),
    );
    await s.github.identity(SANDBOX);
    s.memory.replace({ ...KEPT, token: "ghu_theirs", refreshToken: "ghr_theirs", expiresAt: AT + 16 * HOUR });
    s.clock.set(KEPT.expiresAt);
    await s.github.identity(SANDBOX);
    expect(s.refreshes()).toBe(0);
    expect(s.bearers().at(-1)).toBe("Bearer ghu_theirs");
  });

  test("a new sign-in kept while a renewal waits on GitHub stands: the renewal is dropped, the new one used", async () => {
    const clock = held();
    const api = stubGitHub(
      refreshRoute(() => tokenAnswer("ghu_alice_2", "ghr_alice_2")),
      repoRoute(() => ["ghu_bob"]),
    );
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = () => {};
    const refreshAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const fetch = async (input: string, init: RequestInit) => {
      if (input.endsWith("/login/oauth/access_token")) {
        asked();
        await answered;
      }
      return api.fetch(input, init);
    };
    const memory = memoryKeeper(KEPT);
    const github = createGitHub({ keeper: memory.keeper, fetch, clock });
    clock.set(KEPT.expiresAt);
    const call = github.identity(SANDBOX);
    await refreshAsked;
    const bob: SignIn = {
      token: "ghu_bob",
      expiresAt: AT + 16 * HOUR,
      refreshToken: "ghr_bob",
      refreshExpiresAt: AT + 4000 * HOUR,
      person: { id: 42, login: "bob" },
    };
    memory.signInAgain(bob);
    release();
    expect((await call).poster).toEqual({ id: 42, login: "bob" });
    expect(memory.kept()).toEqual(bob);
  });

  test("a 401 on a token not yet expired refreshes once and asks again", async () => {
    const s = session(
      KEPT,
      refreshRoute(() => tokenAnswer("ghu_second", "ghr_second")),
      repoRoute(() => ["ghu_second"]),
    );
    expect((await s.github.identity(SANDBOX)).owner.login).toBe("lookover-dev");
    expect(s.bearers()).toEqual(["Bearer ghu_first", "Bearer ghu_second"]);
    expect(s.refreshes()).toBe(1);
  });

  test("a 401 on a token just renewed signs the person out, and stays so until another sign-in is kept", async () => {
    const taken: string[] = [];
    const s = session(
      KEPT,
      refreshRoute(() => tokenAnswer("ghu_second", "ghr_second")),
      repoRoute(() => taken),
    );
    const once = await refusal(s.github.identity(SANDBOX));
    expect([once.failure, connectionCauseOf(once)]).toEqual(["unauthorized", { kind: "signed-out" }]);
    expect(s.refreshes()).toBe(1);
    s.clock.set(AT + 8 * HOUR);
    const again = await refusal(s.github.identity(SANDBOX));
    expect([again.failure, connectionCauseOf(again)]).toEqual(["unauthorized", { kind: "signed-out" }]);
    expect(s.refreshes()).toBe(1);
    expect(s.bearers()).toEqual(["Bearer ghu_first", "Bearer ghu_second"]);
    taken.push("ghu_new");
    s.memory.replace({ ...KEPT, token: "ghu_new", refreshToken: "ghr_new", expiresAt: AT + 16 * HOUR });
    expect((await s.github.identity(SANDBOX)).poster).toEqual(PERSON);
    expect(s.refreshes()).toBe(1);
  });

  test("a renewed sign-in the keeper fails to write is held, and written before its first use", async () => {
    const s = session(
      KEPT,
      refreshRoute(() => tokenAnswer("ghu_second", "ghr_second")),
      repoRoute(() => ["ghu_second"]),
    );
    s.memory.failWrites(1);
    s.clock.set(KEPT.expiresAt);
    const unkept = await refusal(s.github.identity(SANDBOX));
    expect([unkept.failure, connectionCauseOf(unkept)]).toEqual(["unavailable", { kind: "unreachable" }]);
    expect(s.memory.kept()).toEqual(KEPT);
    expect(s.bearers()).toEqual([]);
    expect((await s.github.identity(SANDBOX)).owner.login).toBe("lookover-dev");
    expect(s.refreshes()).toBe(1);
    expect(s.writes).toEqual([{ token: "ghu_second", atCall: s.calls.length - 1 }]);
    expect(s.bearers()).toEqual(["Bearer ghu_second"]);
  });

  test("a refresh GitHub refuses signs the person out; GitHub out of reach or failing is unreachable", async () => {
    const out = session(
      KEPT,
      refreshRoute(() => oauthError("bad_refresh_token")),
    );
    out.clock.set(KEPT.expiresAt);
    expect(connectionCauseOf(await refusal(out.github.identity(SANDBOX)))).toEqual({ kind: "signed-out" });
    const failing = session(
      KEPT,
      refreshRoute(() => ({ status: 503, body: "Unavailable" })),
    );
    failing.clock.set(KEPT.expiresAt);
    expect(connectionCauseOf(await refusal(failing.github.identity(SANDBOX)))).toEqual({
      kind: "unreachable",
    });
    const serverError = session(KEPT, (c) => (c.path.startsWith("/repos/") ? { status: 500 } : undefined));
    expect(connectionCauseOf(await refusal(serverError.github.identity(SANDBOX)))).toEqual({
      kind: "unreachable",
    });
  });

  test("an act refused (403) is the person's own permission: the act fails, the connection stands, nothing is renewed", async () => {
    const s = session(KEPT, (c) =>
      c.path.startsWith("/repos/")
        ? { status: 403, body: { message: "Resource not accessible by integration" } }
        : undefined,
    );
    const error = await refusal(s.github.identity(SANDBOX));
    expect([error.failure, connectionCauseOf(error)]).toEqual(["invalid", null]);
    expect(s.refreshes()).toBe(0);
  });

  test("a 403 asking for SAML SSO is the repository's organisation's sso, with GitHub's page for it (GitHub's docs)", async () => {
    const url = "https://github.com/orgs/lookover-dev/sso?authorization_request=A1B2C3";
    const s = session(KEPT, (c) =>
      c.path.startsWith("/repos/")
        ? {
            status: 403,
            body: { message: SAML_REFUSAL },
            headers: { "x-github-sso": `required; url=${url}` },
          }
        : undefined,
    );
    const error = await refusal(s.github.identity(SANDBOX));
    expect([error.failure, connectionCauseOf(error)]).toEqual([
      "unauthorized",
      { kind: "sso", organisation: "lookover-dev", url },
    ]);
    expect(s.refreshes()).toBe(0);
  });

  test("GitHub's SAML words without its header are sso too, with no page", async () => {
    const s = session(KEPT, (c) =>
      c.path.startsWith("/repos/") ? { status: 403, body: { message: SAML_REFUSAL } } : undefined,
    );
    expect(connectionCauseOf(await refusal(s.github.identity(SANDBOX)))).toEqual({
      kind: "sso",
      organisation: "lookover-dev",
      url: null,
    });
  });

  test("a GraphQL act refused as FORBIDDEN in GitHub's SAML words is the repository's organisation's sso, with no page", async () => {
    const s = session(KEPT, (c) =>
      c.method === "POST" && c.path === "/graphql"
        ? {
            status: 200,
            body: { data: { minimizeComment: null }, errors: [{ type: "FORBIDDEN", message: SAML_REFUSAL }] },
          }
        : undefined,
    );
    const error = await refusal(s.github.writer.minimize(SANDBOX, "PRRC_10", "resolved"));
    expect([error.failure, connectionCauseOf(error)]).toEqual([
      "unauthorized",
      { kind: "sso", organisation: "lookover-dev", url: null },
    ]);
    expect(s.refreshes()).toBe(0);
  });

  test("nobody signed in is signed out, and a sign-in kept later is read with no restart", async () => {
    const s = session(
      null,
      repoRoute(() => ["ghu_first"]),
    );
    expect(connectionCauseOf(await refusal(s.github.identity(SANDBOX)))).toEqual({ kind: "signed-out" });
    s.memory.signInAgain(KEPT);
    expect((await s.github.identity(SANDBOX)).poster).toEqual(PERSON);
  });
});
