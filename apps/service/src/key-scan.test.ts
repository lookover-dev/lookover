// The key scanner (ADR 0053, spec #187 story 33): private-key text in a folder or in given text, for the checks that
// no key leaks outside where the App store keeps it.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStore, memoryKeychain } from "./index.ts";
import { filesWithKeyText, hasKeyText } from "./key-scan.test-support.ts";

/** The App store's files are made user-only by its own tests; here, nothing (`icacls` is slow). */
const userOnly = async () => {};

const homes: string[] = [];
afterAll(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "lookover-scan-"));
  homes.push(dir);
  return dir;
}

const BODY = [
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
];
const KEY = `-----BEGIN RSA PRIVATE KEY-----\n${BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
const APP = {
  id: 4242,
  slug: "lookover-x7k2qa",
  account: { id: 77, login: "sasensi", type: "User" as const },
  person: { id: 77, login: "sasensi" },
};

test("a private key's armour is key text, whatever its kind, even escaped in JSON", () => {
  expect(hasKeyText(KEY)).toBe(true);
  expect(hasKeyText("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
  expect(hasKeyText("-----BEGIN EC PRIVATE KEY-----")).toBe(true);
  expect(hasKeyText(JSON.stringify({ key: KEY }))).toBe(true);
  expect(hasKeyText("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe(false);
  expect(hasKeyText("the App's key was refused")).toBe(false);
});

test("a known key's body is found without its armour, one line of it is enough", () => {
  expect(hasKeyText(`log: ${BODY[1]}`, [KEY])).toBe(true);
  expect(hasKeyText(JSON.stringify({ body: BODY.join("\n") }), [KEY])).toBe(true);
  expect(hasKeyText(`log: ${BODY[1]}`)).toBe(false);
  expect(hasKeyText("log: nothing secret", [KEY])).toBe(false);
});

test("after a write, no file of the data folder holds key text but the declared ones", async () => {
  const home = folder();
  await appStore({ home, keychain: memoryKeychain(), userOnly }).write(APP, KEY);
  writeFileSync(join(home, "settings.yaml"), "depth: deep\n");
  expect(await filesWithKeyText(home, { known: [KEY] })).toEqual([]);

  const fallback = folder();
  const store = appStore({ home: fallback, keychain: memoryKeychain({ refuse: true }), userOnly });
  await store.write(APP, KEY);
  const read = await store.read();
  const declared = read.state === "kept" && read.protection === "user-file" ? read.fallback : "";
  expect(declared).toMatch(/^github\/app\.[0-9a-f]{24}\.pem$/);
  expect(await filesWithKeyText(fallback, { known: [KEY] })).toEqual([declared]);
  expect(await filesWithKeyText(fallback, { known: [KEY], except: [declared] })).toEqual([]);
  // Only the declared file is skipped: another one like it is found.
  writeFileSync(join(fallback, "github", "app.000000000000000000000000.pem"), KEY);
  expect(await filesWithKeyText(fallback, { known: [KEY], except: [declared] })).toEqual([
    "github/app.000000000000000000000000.pem",
  ]);
});

test("a key anywhere in the folder is found, by its path from the root", async () => {
  const home = folder();
  mkdirSync(join(home, "runs", "r1"), { recursive: true });
  writeFileSync(join(home, "runs", "r1", "log.txt"), `GitHub said: ${BODY[0]}\n`);
  writeFileSync(join(home, "export.json"), JSON.stringify({ key: KEY }));
  writeFileSync(
    join(home, "lookover.sqlite"),
    Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(KEY)]),
  );
  expect(await filesWithKeyText(home, { known: [KEY] })).toEqual([
    "export.json",
    "lookover.sqlite",
    "runs/r1/log.txt",
  ]);
  expect(await filesWithKeyText(home)).toEqual(["export.json", "lookover.sqlite"]);
});
