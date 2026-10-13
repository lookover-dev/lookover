// The data folder's instance lock (`takeInstance`, an OS-held lock, ADR 0054) under what a running service meets:
// its handle dropped and the garbage collector run, a kill that releases nothing, and a journal some writer left
// beside the lock file.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeInstance, takeInstance } from "./index.ts";

const homes: string[] = [];
const newHome = () => {
  const made = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-instance-"));
  homes.push(made);
  return made;
};
const userOnly = async () => {};

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      // A lock this process still holds keeps its file busy on Windows: the folder goes with the system's temp files.
      if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
    }
  }
});

test("an instance whose handle is dropped stays held through a garbage collection", () => {
  const home = newHome();
  // Taken in a frame of its own, so nothing this test keeps references the handle.
  (() => {
    takeInstance(home, userOnly);
  })();
  Bun.gc(true);
  Bun.gc(true);
  expect(probeInstance(home)).toBe("held");
});

test("a held instance lock leaves no journal beside it, and a hot one some writer left reads as free", () => {
  const home = newHome();
  const lock = join(home, "instance.lock");
  takeInstance(home, userOnly).release();
  expect(readdirSync(home)).toEqual(["instance.lock"]);
  // A journal whose first byte isn't zero is hot: a read-only opener can't roll it back.
  writeFileSync(`${lock}-journal`, Buffer.alloc(4096, 0xab));
  expect(probeInstance(home)).toBe("free");
  const again = takeInstance(home, userOnly);
  expect(probeInstance(home)).toBe("held");
  again.release();
  expect(probeInstance(home)).toBe("free");
});

test("a service killed without releasing leaves its data folder free: the system releases the instance lock", async () => {
  const home = newHome();
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { takeInstance } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
       takeInstance(${JSON.stringify(home)}, async () => {});
       console.log("taken");
       setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const { value } = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("taken");
  expect(probeInstance(home)).toBe("held");
  expect(() => takeInstance(home, userOnly)).toThrow("Another Lookover runs on this data folder");

  holder.kill(9);
  await holder.exited;
  expect(existsSync(join(home, "instance.lock-journal"))).toBe(false);
  expect(probeInstance(home)).toBe("free");
  takeInstance(home, userOnly).release();
});
