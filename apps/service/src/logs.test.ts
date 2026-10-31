// The service's lines through the log sink (ADR 0054, "Logs"; exploration 09 J1): the room's `log` writes to it in
// both wirings, and a secret planted in a line the room logs is in the file nowhere: the session's (registered as the
// server starts) and anything shaped like GitHub's (an installation token, a JWT, the App's key).
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HostError } from "@lookover/contracts";
import { DemoClock, FakeGitHost } from "@lookover/testkit";
import { buildDemoRoom, openLogSink, type RunningService, scenarioOf, startDemoService } from "./index.ts";
import {
  api,
  BOT,
  fakeEngines,
  home,
  linkOf,
  messages,
  next,
  onFakeGitHub,
  openApp,
  PLANTED,
  pr1,
  review,
  SANDBOX,
  snapshot,
  start,
  stopAll,
  T0,
  until,
} from "./service.test-support.ts";

const started: RunningService[] = [];
afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
  await stopAll();
});

/** Where the day's log file is in `dir`, on a clock standing at T0. */
function dayFileOf(dir: string): string {
  const at = new Date(T0);
  const two = (n: number) => String(n).padStart(2, "0");
  return join(dir, "logs", `lookover-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}.log`);
}

/** The day's log file in `dir`. */
const logOf = (dir: string): string => readFileSync(dayFileOf(dir), "utf8");

/** What `act` printed to the standard error, caught: nothing reaches the real one. */
async function stderrOf(act: () => Promise<void>): Promise<string> {
  const printed: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => {
    printed.push(String(text));
    return true;
  });
  try {
    await act();
  } finally {
    stderr.mockRestore();
  }
  return printed.join("");
}

const sinkIn = (dir: string) =>
  openLogSink({ home: dir, clock: { now: () => T0 }, userOnly: async () => {} });

const INSTALLATION_TOKEN = `ghs_${"T".repeat(36)}`;
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI1MjAyMDkzIn0.c2lnbmVkLWJ5LXRoZS1hcHA";
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAplanted\n-----END RSA PRIVATE KEY-----";

test("in demo mode the room logs to the sink, and the session's secret and its link's token never reach the file", async () => {
  const dir = home();
  const sink = await sinkIn(dir);
  let log: ((line: string) => void) | undefined;
  const service = await startDemoService({
    home: dir,
    scenario: scenarioOf("S1"),
    frozen: T0,
    version: "0.1.0",
    logSink: sink,
    driver: async (o) => {
      log = o.log;
      return buildDemoRoom(o);
    },
  });
  started.push(service);
  const token = new URL(linkOf(service)).searchParams.get("token") ?? "";
  const session = readFileSync(join(dir, "session"), "utf8");
  log?.(`a request carried ${token} and the cookie ${session}`);
  const file = logOf(dir);
  expect(file).toContain("a request carried [redacted] and the cookie [redacted]");
  expect(file).not.toContain(token);
  expect(file).not.toContain(session);
});

test("in live mode's wiring the room logs to the sink: GitHub's refusal echoing a token, a JWT and a key loses them", async () => {
  const dir = home();
  const sink = await sinkIn(dir);
  const time = new DemoClock({ at: T0 });
  const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [pr1], clock: time });
  const side = onFakeGitHub(host);
  const github = {
    ...side,
    installations: {
      ...side.installations,
      app: () =>
        Promise.reject(
          new HostError("unavailable", `GitHub answered ${INSTALLATION_TOKEN} for ${JWT} signed with ${KEY}`),
        ),
    },
  };
  await start({ home: dir, host, time, github, logSink: sink, live: true });
  const file = logOf(dir);
  expect(file).toContain(
    "the GitHub App could not be read: GitHub answered [redacted] for [redacted] signed with [redacted]",
  );
  for (const secret of [INSTALLATION_TOKEN, JWT, "MIIEowIBAAKCAQEAplanted"])
    expect(file).not.toContain(secret);
});

/** A personal access token pasted into a pull request's title, as a slip would. */
const PAT = `github_pat_${"P".repeat(22)}_${"q".repeat(59)}`;

/** GitHub refusing every post of a round for good, its answer echoing the installation token it was sent with. */
class RefusingPosts extends FakeGitHost {
  override publishReview(): Promise<string> {
    return Promise.reject(new HostError("unauthorized", `Bad credentials for ${INSTALLATION_TOKEN}`));
  }
  override upsertSummary(): Promise<string> {
    return Promise.reject(new HostError("unauthorized", `Bad credentials for ${INSTALLATION_TOKEN}`));
  }
}

test("a review's lines reach the file (ADR 0055), a token in a pull request's title and in GitHub's refusal not", async () => {
  const dir = home();
  const sink = await sinkIn(dir);
  const time = new DemoClock({ at: T0 });
  const titled = { ...pr1, title: `Rotate the deploy key ${PAT}` };
  const host = new RefusingPosts({ repo: SANDBOX, bot: BOT, changes: [titled], clock: time });
  const engines = fakeEngines({ reviews: 1 });
  const { service } = await start({ home: dir, host, time, engines, logSink: sink, live: true });
  const cookie = await openApp(service);
  expect((await review(service, cookie)).status).toBe(200);
  await time.advance(0);
  await time.advance(5 * 60_000);
  const lines = logOf(dir)
    .split("\n")
    .map((line) => line.slice(line.indexOf(" ") + 1))
    .filter((line) => line.startsWith("sasensi/lookover-sandbox#1 "));
  expect(lines).toEqual([
    "sasensi/lookover-sandbox#1 opened by sasensi: Rotate the deploy key [redacted]",
    "sasensi/lookover-sandbox#1 review queued (asked in the app) for a1b2c3d",
    "sasensi/lookover-sandbox#1 round 1 started on a1b2c3d, standard: Claude finds, Claude double-checks",
    "sasensi/lookover-sandbox#1 round 1 kept, its posts given up: GitHub refused the review (unauthorized: Bad credentials for [redacted])",
  ]);
  expect(logOf(dir)).not.toContain(PAT);
  expect(logOf(dir)).not.toContain(INSTALLATION_TOKEN);
});

test("a review's line that can't be written is printed filtered: a token in a pull request's title reaches no output", async () => {
  const dir = home();
  const sink = await sinkIn(dir);
  mkdirSync(dayFileOf(dir));
  const shown = await stderrOf(async () => {
    const time = new DemoClock({ at: T0 });
    const titled = { ...pr1, title: `Rotate the deploy key ${PAT}` };
    const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [titled], clock: time });
    const engines = fakeEngines({ reviews: 1 });
    const { service } = await start({ home: dir, host, time, engines, logSink: sink });
    const cookie = await openApp(service);
    expect((await review(service, cookie)).status).toBe(200);
    await time.advance(0);
  });
  expect(shown).toContain(
    "sasensi/lookover-sandbox#1 opened by sasensi: Rotate the deploy key [redacted] (not logged: ",
  );
  expect(shown).not.toContain(PAT);
});

test("a line the room's own log refuses is printed as a fixed message, never the line", async () => {
  const shown = await stderrOf(async () => {
    const time = new DemoClock({ at: T0 });
    const titled = { ...pr1, title: `Rotate the deploy key ${PAT}` };
    const host = new FakeGitHost({ repo: SANDBOX, bot: BOT, changes: [titled], clock: time });
    const refusing = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { service } = await start({ host, time, log: refusing });
    const cookie = await openApp(service);
    expect((await review(service, cookie)).status).toBe(200);
  });
  expect(shown).toContain("A line was not logged: ENOSPC: no space left on device");
  expect(shown).not.toContain(PAT);
});

test("a line that can't be written stops no event: the change is stored and the UI hears of it", async () => {
  const { service } = await start({
    log: () => {
      throw new Error("ENOSPC: no space left on device");
    },
  });
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  expect((await review(service, cookie)).status).toBe(200);
  expect((await until(stream, "job.changed")).at(-1)).toMatchObject({ job: { state: "queued" } });
  expect((await snapshot(service, cookie)).reviews[PLANTED]?.job).toMatchObject({ trigger: "manual" });
});

test("a request that fails on an error nothing expected answers 500, and the error goes to the log, its secrets removed", async () => {
  const dir = home();
  const printed: string[] = [];
  const sink = await openLogSink({
    home: dir,
    clock: { now: () => T0 },
    userOnly: async () => {},
    print: (line) => printed.push(line),
  });
  const service = await startDemoService({
    home: dir,
    scenario: scenarioOf("S1"),
    frozen: T0,
    version: "0.1.0",
    logSink: sink,
    driver: async (o) => {
      const demo = await buildDemoRoom(o);
      // The room's snapshot breaks with a message that carries a token, as a library's error might.
      const room = new Proxy(demo.room, {
        get: (target, key) => {
          if (key === "snapshot")
            return () => {
              throw new Error(`the read broke on ${INSTALLATION_TOKEN}`);
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return new Proxy(demo, { get: (target, key) => (key === "room" ? room : Reflect.get(target, key)) });
    },
  });
  started.push(service);
  const cookie = await openApp(service);
  // What Bun or the console would print beside the sink: nothing of the token.
  const stderr: string[] = [];
  const { error } = console;
  const write = process.stderr.write.bind(process.stderr);
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  };
  let status: number;
  try {
    status = (await fetch(api(service, "/snapshot"), { headers: { cookie } })).status;
  } finally {
    console.error = error;
    process.stderr.write = write;
  }
  expect(status).toBe(500);
  const file = logOf(dir);
  expect(file).toContain("the read broke on [redacted]");
  for (const shown of [file, printed.join("\n"), stderr.join("\n")])
    expect(shown).not.toContain(INSTALLATION_TOKEN);
  expect(printed.join("\n")).toContain("the read broke on [redacted]");
});

/** A demo service on S1 writing to a sink in `dir`, its clock standing at T0. */
async function demoOn(dir: string) {
  const sink = await sinkIn(dir);
  const service = await startDemoService({
    home: dir,
    scenario: scenarioOf("S1"),
    frozen: T0,
    version: "0.1.0",
    logSink: sink,
  });
  started.push(service);
  return { sink, service };
}

test("the log's tail needs the session, and answers the file's last lines as it keeps them (ADR 0055)", async () => {
  const dir = home();
  const { sink, service } = await demoOn(dir);
  sink.write("a line of the service's");
  expect((await fetch(api(service, "/logs"))).status).toBe(401);
  const cookie = await openApp(service);
  const tail = await fetch(api(service, "/logs"), { headers: { cookie } });
  expect(tail.status).toBe(200);
  const lines: unknown = await tail.json();
  expect(lines).toEqual(logOf(dir).split("\n").slice(0, -1));
  expect(lines).toContainEqual(expect.stringMatching(/ a line of the service's$/));
});

test("each line the file gains reaches the open streams as an unnumbered log message, never as an event (ADR 0055)", async () => {
  const dir = home();
  const { sink, service } = await demoOn(dir);
  const cookie = await openApp(service);
  const stream = messages(await fetch(api(service, "/events"), { headers: { cookie } }));
  const token = new URL(linkOf(service)).searchParams.get("token") ?? "";
  sink.write(`a request carried ${token}`);
  const message = await next(stream);
  expect(message.event).toBe("log");
  expect(message.id).toBeNull();
  expect(JSON.parse(message.data)).toEqual({ line: logOf(dir).split("\n").at(-2) });
  expect(message.data).toContain("a request carried [redacted]");
});

test("with no log sink, the tail is empty", async () => {
  const { service } = await start();
  const cookie = await openApp(service);
  const tail = await fetch(api(service, "/logs"), { headers: { cookie } });
  expect(tail.status).toBe(200);
  expect(await tail.json()).toEqual([]);
});
