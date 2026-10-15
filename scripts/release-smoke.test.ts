// The smoke's plan without npm or the network (ADR 0061): what its command line asks for, npm's install command for
// the tarballs and for the registry, the registry addresses it waits on, the wait itself on a fake registry, and the
// installed `lookover`'s steps. The installs themselves run in `release-assets.test.ts` (tarballs) and in the public
// release.yml's `verify` job (the registry).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { npmInstallArgs, plan, registryUrls, steps, waitForRegistry } from "./release-smoke.ts";

describe("plan", () => {
  test("with nothing asked: the tarballs in dist/npm", () => {
    expect(plan([])).toEqual({ from: "tarballs" });
  });

  test("--from-registry <version>: that version from the registry, not waiting", () => {
    expect(plan(["--from-registry", "0.1.0"])).toEqual({ from: "registry", version: "0.1.0", wait: false });
    expect(plan(["--from-registry=1.20.3"])).toEqual({ from: "registry", version: "1.20.3", wait: false });
  });

  test("--wait waits for the registry to answer first", () => {
    expect(plan(["--from-registry", "0.1.0", "--wait"])).toEqual({
      from: "registry",
      version: "0.1.0",
      wait: true,
    });
  });

  test("--wait needs --from-registry", () => {
    expect(plan(["--wait"])).toBe("--wait waits for the registry: pass --from-registry <version> too");
  });

  test("refuses a version that isn't one, a missing version, an unknown option or a word", () => {
    expect(plan(["--from-registry", "latest"])).toBe(
      "--from-registry takes a version such as 1.2.3, not latest",
    );
    expect(plan(["--from-registry", "v1.2.3"])).toBe(
      "--from-registry takes a version such as 1.2.3, not v1.2.3",
    );
    expect(plan(["--from-registry", "1.2.3&calc"])).toBe(
      "--from-registry takes a version such as 1.2.3, not 1.2.3&calc",
    );
    // A release is a plain X.Y.Z, as the guard, the sync and the changelog check read it: no pre-release.
    expect(plan(["--from-registry", "1.2.3-rc.1"])).toBe(
      "--from-registry takes a version such as 1.2.3, not 1.2.3-rc.1",
    );
    expect(typeof plan(["--from-registry"])).toBe("string");
    expect(typeof plan(["--tree", "x"])).toBe("string");
    expect(plan(["now"])).toBe(
      "no argument now: usage: bun scripts/release-smoke.ts [--from-registry <version> [--wait]]",
    );
  });
});

describe("npmInstallArgs", () => {
  const settings = join("scratch", "npm-settings");
  const shared = [
    "--global",
    "--prefix=prefix",
    `--cache=${join(settings, "cache")}`,
    `--userconfig=${join(settings, "userconfig")}`,
    `--globalconfig=${join(settings, "globalconfig")}`,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--loglevel=error",
  ];

  test("the tarballs: offline, the registry a closed local port", () => {
    expect(npmInstallArgs({ prefix: "prefix", settings, tarballs: ["a.tgz", "b.tgz"] })).toEqual([
      "install",
      ...shared,
      "--offline",
      "--registry=http://127.0.0.1:9/",
      "a.tgz",
      "b.tgz",
    ]);
  });

  test("the registry: lookover@<version> from npm's public registry", () => {
    expect(npmInstallArgs({ prefix: "prefix", settings, version: "0.1.0" })).toEqual([
      "install",
      ...shared,
      "--registry=https://registry.npmjs.org/",
      "lookover@0.1.0",
    ]);
  });
});

describe("registryUrls", () => {
  test("lookover's version, then each platform package's, the scope's slash escaped, then each one's tarball", () => {
    // The tarballs too: 0.1.0's and 0.2.0's win32-x64 had its version answering while its tarball still said 404, so
    // npm skipped the optional package and the launcher found no executable.
    expect(registryUrls("0.1.0", ["win32-x64", "linux-arm64"])).toEqual([
      "https://registry.npmjs.org/lookover/0.1.0",
      "https://registry.npmjs.org/@lookover%2fwin32-x64/0.1.0",
      "https://registry.npmjs.org/@lookover%2flinux-arm64/0.1.0",
      "https://registry.npmjs.org/lookover/-/lookover-0.1.0.tgz",
      "https://registry.npmjs.org/@lookover/win32-x64/-/win32-x64-0.1.0.tgz",
      "https://registry.npmjs.org/@lookover/linux-arm64/-/linux-arm64-0.1.0.tgz",
    ]);
  });
});

describe("waitForRegistry", () => {
  /** A registry whose answers for each address come in order, the last one repeated; and a clock sleep moves. */
  function fake(answers: Record<string, number[]>) {
    let now = 0;
    const asked: string[] = [];
    return {
      asked,
      o: {
        status: async (url: string) => {
          asked.push(url);
          const list = answers[url] ?? [404];
          return list.length > 1 ? (list.shift() ?? 404) : (list[0] ?? 404);
        },
        sleep: async (ms: number) => {
          now += ms;
        },
        now: () => now,
        timeoutMs: 60_000,
        everyMs: 15_000,
      },
      elapsed: () => now,
    };
  }

  test("returns at once when every address answers 200", async () => {
    const registry = fake({ a: [200], b: [200] });
    expect(await waitForRegistry(["a", "b"], registry.o)).toEqual([]);
    expect(registry.elapsed()).toBe(0);
  });

  test("asks again what didn't answer 200 until it does", async () => {
    const registry = fake({ a: [200], b: [404, 503, 200] });
    expect(await waitForRegistry(["a", "b"], registry.o)).toEqual([]);
    expect(registry.asked).toEqual(["a", "b", "b", "b"]);
    expect(registry.elapsed()).toBe(30_000);
  });

  test("a network error counts as not yet", async () => {
    const registry = fake({ a: [200] });
    let thrown = false;
    const o = {
      ...registry.o,
      status: async (url: string) => {
        if (!thrown) {
          thrown = true;
          throw new Error("ECONNRESET");
        }
        return registry.o.status(url);
      },
    };
    expect(await waitForRegistry(["a"], o)).toEqual([]);
  });

  test("gives up after the timeout, with the addresses still missing", async () => {
    const registry = fake({ a: [200], b: [404] });
    expect(await waitForRegistry(["a", "b"], registry.o)).toEqual(["b"]);
    expect(registry.elapsed()).toBe(60_000);
  });
});

describe("steps", () => {
  test("the installed lookover's: its version, help, then start, status, stop and status on the data folder", () => {
    expect(steps("home", "0.1.0").map((step) => step.args)).toEqual([
      ["--version"],
      ["help"],
      ["start", "--no-open", "--home=home"],
      ["status", "--home=home"],
      ["stop", "--home=home"],
      ["status", "--home=home"],
    ]);
  });

  const ran = (code: number | null, out = "") => ({
    code,
    signal: code === null ? "SIGKILL" : null,
    out,
    err: "",
  });

  test("--version passes only on the version asked", () => {
    const [version] = steps("home", "0.1.0");
    expect(version?.passes(ran(0, "0.1.0\n"))).toBeNull();
    expect(version?.passes(ran(0, "0.0.9\n"))).toBe("said 0.0.9, not 0.1.0");
    expect(version?.passes(ran(1, "0.1.0\n"))).toBe("exited 1");
  });

  test("status passes on 0 while it runs, and on 3 once it stopped", () => {
    const all = steps("home", "0.1.0");
    const running = all[3];
    const stopped = all[5];
    expect(running?.passes(ran(0))).toBeNull();
    expect(running?.passes(ran(3))).toBe("exited 3");
    expect(stopped?.passes(ran(3))).toBeNull();
    expect(stopped?.passes(ran(0))).toBe("exited 0, not 3 (stopped)");
    expect(stopped?.passes(ran(null))).toBe("ended by SIGKILL");
  });
});
