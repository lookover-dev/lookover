// GitHub's side of signing in to the shared App, in memory (ADR 0066), as `FakeGitHost` plays it: device codes that
// wait for the person to enter them on GitHub's page (`enter`) or refuse (`deny`), that run out after 15 minutes, and
// that ask to slow down when polled before their interval has passed, 5 s more each time, as GitHub's docs say; a
// token for 8 hours and a refresh token for 15724800 s, as spike 20 saw them; a refresh that rotates the refresh
// token, the old one spent, and refuses a spent, expired or revoked one (`revoke`: the person took the App's
// authorisation back) as `bad_refresh_token` does: signed out. A code entered gives the tokens alone, the code spent;
// whose a token is (`GET /user`) is asked apart, and can be refused once (`refusePerson`). A test can make GitHub ask
// to slow down at the next poll (`slowDown`) and read when each code was polled (`polls`).
import {
  type Clock,
  type DeviceGrant,
  type DevicePoll,
  HostError,
  type HostFailure,
  type HostLogin,
  type SignIn,
} from "@lookover/contracts";

const CODE_LIFETIME_MS = 900_000;
const INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const TOKEN_LIFETIME_MS = 28_800_000;
const REFRESH_LIFETIME_MS = 15_724_800_000;
const VERIFICATION_URI = "https://github.com/login/device";

interface Code {
  userCode: string;
  expiresAt: number;
  /** The interval GitHub holds the poller to, 5 s more after each `slow_down`. */
  interval: number;
  /** When it was last polled; null before the first poll. */
  polled: number | null;
  /** Every time it was polled. */
  polls: number[];
  /** GitHub asks to slow down at the next poll, whenever it comes. */
  slowDown: boolean;
  state: "waiting" | "entered" | "denied" | "used";
}

export class FakeSignIn {
  private readonly clock: Clock;
  private readonly person: () => HostLogin;
  private readonly codes = new Map<string, Code>();
  /** Each refresh token GitHub would take, until when. */
  private readonly refreshes = new Map<string, number>();
  /** Whose each token issued is. */
  private readonly owners = new Map<string, HostLogin>();
  /** The next `person` refused once so, when set. */
  private personRefusal: HostFailure | null = null;
  private next = 1;
  /** The page each code names to be entered on: GitHub's, unless the fake's own pages stand for it (demo mode). */
  private readonly page: string;

  constructor(clock: Clock, person: () => HostLogin, page: string = VERIFICATION_URI) {
    this.clock = clock;
    this.person = person;
    this.page = page;
  }

  start(): DeviceGrant {
    const n = this.next++;
    const userCode = `FAKE-${String(n).padStart(4, "0")}`;
    const deviceCode = `fake-device-code-${n}`;
    const expiresAt = this.clock.now() + CODE_LIFETIME_MS;
    this.codes.set(deviceCode, {
      userCode,
      expiresAt,
      interval: INTERVAL_MS,
      polled: null,
      polls: [],
      slowDown: false,
      state: "waiting",
    });
    return { deviceCode, userCode, verificationUri: this.page, expiresAt, interval: INTERVAL_MS };
  }

  poll(grant: DeviceGrant): DevicePoll {
    const code = this.codes.get(grant.deviceCode);
    if (code === undefined || code.state === "used")
      throw new HostError("invalid", "GitHub refused the sign-in: incorrect_device_code");
    const now = this.clock.now();
    if (now >= code.expiresAt) return { kind: "expired" };
    if (code.state === "denied") return { kind: "denied" };
    const early = code.slowDown || (code.polled !== null && now - code.polled < code.interval);
    code.polled = now;
    code.polls.push(now);
    code.slowDown = false;
    if (early) {
      code.interval += SLOW_DOWN_MS;
      return { kind: "slow-down", grant: { ...grant, interval: code.interval } };
    }
    if (code.state === "waiting") return { kind: "pending", grant };
    code.state = "used";
    const { person: _, ...tokens } = this.issue(this.person());
    return { kind: "issued", tokens };
  }

  /** Whose `token` is, as `GET /user` answers: unauthorized for a token never issued. */
  personOf(token: string): HostLogin {
    const refusal = this.personRefusal;
    if (refusal !== null) {
      this.personRefusal = null;
      throw new HostError(refusal, `GitHub refused GET /user (${refusal})`);
    }
    const owner = this.owners.get(token);
    if (owner === undefined) throw new HostError("unauthorized", "Bad credentials (401)");
    return { ...owner };
  }

  /** The next `GET /user` refused once as `failure`. */
  refusePerson(failure: HostFailure): void {
    this.personRefusal = failure;
  }

  /** GitHub asks to slow down at the code's next poll: 5 s more on its interval. */
  slowDown(userCode: string): void {
    this.waiting(userCode).slowDown = true;
  }

  /** When the code was polled, each time. */
  polls(userCode: string): number[] {
    const code = [...this.codes.values()].find((c) => c.userCode === userCode);
    return code === undefined ? [] : [...code.polls];
  }

  refresh(signIn: SignIn): SignIn {
    const until = this.refreshes.get(signIn.refreshToken);
    this.refreshes.delete(signIn.refreshToken);
    if (until === undefined || this.clock.now() >= until)
      throw new HostError("unauthorized", "GitHub no longer renews the sign-in (bad_refresh_token)", {
        connectionCause: { kind: "signed-out" },
      });
    return this.issue(signIn.person);
  }

  /** The person enters the code on GitHub's page and authorises the App: the next poll signs in. */
  enter(userCode: string): void {
    this.waiting(userCode).state = "entered";
  }

  /** The person refuses on GitHub's page: the next poll is denied. */
  deny(userCode: string): void {
    this.waiting(userCode).state = "denied";
  }

  /** The person takes the App's authorisation back on GitHub: no refresh token given so far renews. */
  revoke(): void {
    this.refreshes.clear();
  }

  private waiting(userCode: string): Code {
    const code = [...this.codes.values()].find((c) => c.userCode === userCode && c.state === "waiting");
    if (code === undefined) throw new Error(`No device code ${userCode} waits to be entered`);
    return code;
  }

  private issue(person: HostLogin): SignIn {
    const n = this.next++;
    const now = this.clock.now();
    const refreshToken = `ghr_fake_${n}`;
    this.refreshes.set(refreshToken, now + REFRESH_LIFETIME_MS);
    const token = `ghu_fake_${n}`;
    this.owners.set(token, { ...person });
    return {
      token,
      expiresAt: now + TOKEN_LIFETIME_MS,
      refreshToken,
      refreshExpiresAt: now + REFRESH_LIFETIME_MS,
      person: { ...person },
    };
  }
}
