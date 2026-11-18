// The tray helper's crate as the scripts reach it (scripts/cargo.ts): where Cargo is found, what the helper's first
// line must say, and the check the build and the release smoke run on a built helper (`trayFault`), here on
// stand-ins run by Bun. Nothing here runs Cargo or the real helper.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cargoCheck,
  FETCHED_PROBE,
  findCargo,
  NO_CARGO,
  notFetched,
  trayAnswerFault,
  trayFault,
} from "./cargo.ts";

test("Cargo is the one on the PATH, else rustup's in CARGO_HOME, else in ~/.cargo", () => {
  const on = (found: string[]) => ({
    which: (name: string) => (found.includes("path") ? `/usr/bin/${name}` : null),
    exists: (path: string) => found.includes(path),
  });
  const env = { home: "/home/ada", platform: "linux" as const };
  expect(findCargo({ ...env, cargoHome: undefined, ...on(["path", "/home/ada/.cargo/bin/cargo"]) })).toBe(
    "/usr/bin/cargo",
  );
  expect(findCargo({ ...env, cargoHome: "/opt/cargo", ...on(["/opt/cargo/bin/cargo"]) })).toBe(
    "/opt/cargo/bin/cargo",
  );
  expect(findCargo({ ...env, cargoHome: undefined, ...on(["/home/ada/.cargo/bin/cargo"]) })).toBe(
    "/home/ada/.cargo/bin/cargo",
  );
  expect(findCargo({ ...env, cargoHome: undefined, ...on([]) })).toBeUndefined();
  expect(
    findCargo({
      // The placeholder user folder: the public export refuses any other (`USER_FOLDER_PLACEHOLDER`).
      home: "C:/Users/Your Name",
      platform: "win32",
      cargoHome: undefined,
      ...on(["C:/Users/Your Name/.cargo/bin/cargo.exe"]),
    }),
  ).toBe("C:/Users/Your Name/.cargo/bin/cargo.exe");
});

test("with no Cargo, the build says how to install Rust", () => {
  expect(NO_CARGO).toContain("rustup");
  expect(NO_CARGO).toContain("https://rustup.rs");
});

describe("the crate's checks", () => {
  test("cargo:check fetches the locked crates, then checks offline", () => {
    expect(cargoCheck("fetch").map((s) => s.args.join(" "))).toEqual([
      "fetch --locked",
      "fmt --check",
      "clippy --all-targets --locked --offline -- -D warnings",
      "test --locked --offline",
    ]);
    expect(cargoCheck("fetch").every((s) => Object.keys(s.env).length === 0)).toBe(true);
  });

  test("--frozen (bun run check's) fetches nothing: no crate, no lock change, no toolchain from rustup", () => {
    expect(cargoCheck("frozen").map((s) => s.args.join(" "))).toEqual([
      "fmt --check",
      "clippy --all-targets --frozen -- -D warnings",
      "test --frozen",
    ]);
    expect(cargoCheck("frozen").every((s) => s.env.RUSTUP_AUTO_INSTALL === "0")).toBe(true);
  });

  test("before it, --frozen asks Cargo, offline, whether every locked crate is already there", () => {
    expect(FETCHED_PROBE).toEqual({
      args: ["metadata", "--frozen", "--format-version", "1"],
      env: { RUSTUP_AUTO_INSTALL: "0" },
    });
  });

  test("crates not fetched: it says to run bun run cargo:check, which fetches them, with Cargo's words", () => {
    expect(notFetched("error: no matching package named `png` found\n")).toBe(
      "The tray helper's crates (apps/tray) or its Rust toolchain aren't on this machine yet, and the check " +
        "never fetches: run `bun run cargo:check`, which fetches them once, then check again.\n" +
        "error: no matching package named `png` found",
    );
    expect(notFetched("  \n")).not.toContain("\n");
  });
});

test("the helper's first line must be ready with the program's version and protocol 1, or unavailable", () => {
  expect(trayAnswerFault('{"type":"ready","version":"0.17.0","protocol":1}', "0.17.0")).toBeUndefined();
  expect(trayAnswerFault('{"type":"unavailable","reason":"No desktop to show an icon on"}', "0.17.0")).toBe(
    undefined,
  );
  expect(trayAnswerFault('{"type":"ready","version":"0.16.0","protocol":1}', "0.17.0")).toBe(
    "lookover-tray is version 0.16.0, not 0.17.0",
  );
  expect(trayAnswerFault('{"type":"ready","version":"0.17.0","protocol":2}', "0.17.0")).toBe(
    "lookover-tray speaks protocol 2, not 1",
  );
  expect(trayAnswerFault("hello", "0.17.0")).toBe("lookover-tray said something else than ready: hello");
  expect(trayAnswerFault('{"type":"click","item":"open"}', "0.17.0")).toBe(
    'lookover-tray said something else than ready: {"type":"click","item":"open"}',
  );
});

describe("trayFault", () => {
  // Stand-ins for the built helper, run by Bun: each says a version, then its first line, then does what its name
  // says once its standard input closes.
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "lookover-tray-fault-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const helper = (name: string, o: { version: string; first?: string; onEnd: string }) => {
    const file = join(scratch, `${name}.js`);
    writeFileSync(
      file,
      `if (process.argv[2] === "--version") { console.log(${JSON.stringify(o.version)}); process.exit(0); }\n` +
        (o.first === undefined ? "" : `console.log(${JSON.stringify(o.first)});\n`) +
        `process.stdin.resume();\nprocess.stdin.on("end", () => { ${o.onEnd} });\n`,
    );
    return [process.execPath, file];
  };
  const READY = '{"type":"ready","version":"1.2.3","protocol":1}';
  const limits = { limitMs: 3_000 };

  test("passes a helper of the release's version that says ready, and exits 0 once its input closes", async () => {
    const ok = helper("ok", { version: "1.2.3", first: READY, onEnd: "process.exit(0);" });
    expect(await trayFault(ok, "1.2.3", limits)).toBeNull();
  });

  test("passes one that says its tray is unavailable: a runner with no desktop", async () => {
    const first = '{"type":"unavailable","reason":"No tray on this system"}';
    const none = helper("none", { version: "1.2.3", first, onEnd: "process.exit(0);" });
    expect(await trayFault(none, "1.2.3", limits)).toBeNull();
  });

  test("fails one of another version, by --version or by its first line", async () => {
    const old = helper("old", { version: "1.2.2", first: READY, onEnd: "process.exit(0);" });
    expect(await trayFault(old, "1.2.3", limits)).toBe('--version said "1.2.2", not 1.2.3');
    const mixed = helper("mixed", {
      version: "1.2.3",
      first: '{"type":"ready","version":"1.2.2","protocol":1}',
      onEnd: "process.exit(0);",
    });
    expect(await trayFault(mixed, "1.2.3", limits)).toBe("lookover-tray is version 1.2.2, not 1.2.3");
  });

  test("fails one whose first line it refuses and that runs on, with its standard error, and stops it", async () => {
    const file = join(scratch, "protocol-2.js");
    // It says its version, then its standard error and a ready line of protocol 2, and waits on its standard input.
    // The error comes first: what it wrote before the refused line is in its pipe when it is stopped.
    writeFileSync(
      file,
      [
        'if (process.argv.includes("--version")) { console.log("1.2.3"); process.exit(0); }',
        'console.error("speaking protocol 2");',
        'console.log(JSON.stringify({ type: "ready", version: "1.2.3", protocol: 2 }));',
        "for await (const _ of process.stdin) {}",
      ].join("\n"),
    );
    const started = Date.now();
    expect(await trayFault([process.execPath, file], "1.2.3", { limitMs: 10_000 })).toBe(
      "lookover-tray speaks protocol 2, not 1\nspeaking protocol 2",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("fails one that runs on once its input closes, and stops it", async () => {
    const stays = helper("stays", { version: "1.2.3", first: READY, onEnd: "setInterval(() => {}, 1000);" });
    expect(await trayFault(stays, "1.2.3", limits)).toBe("its standard input closed, and it ran on");
  });

  test("fails one that exits with another code once its input closes", async () => {
    const fails = helper("fails", { version: "1.2.3", first: READY, onEnd: "process.exit(4);" });
    expect(await trayFault(fails, "1.2.3", limits)).toStartWith("its standard input closed, it exited 4");
  });

  test("fails one that says nothing", async () => {
    const mute = helper("mute", { version: "1.2.3", onEnd: "process.exit(0);" });
    expect(await trayFault(mute, "1.2.3", limits)).toBe("it said nothing in 3 s");
  });

  test("fails one whose --version never answers, and stops it", async () => {
    const file = join(scratch, "hangs.js");
    writeFileSync(file, "setInterval(() => {}, 1000);\n");
    expect(await trayFault([process.execPath, file], "1.2.3", { limitMs: 1_000 })).toBe(
      "--version gave no answer in 1 s",
    );
  });
});
